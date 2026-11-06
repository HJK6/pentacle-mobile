import { FakeHousehold, emptyLists, event, fixtureSnapshot, item, flush } from './support';
import { mount, resetWorld, screen, fireEvent, store, navTargets, within } from './screens';
import { act } from '@testing-library/react-native';
import type { HouseholdRoutine } from '../../src/services/household/types';
import { calendarRows } from '../../src/services/household/selectors';

const routine = (over: Partial<HouseholdRoutine> = {}): HouseholdRoutine => ({
  id: 902, list: 'chores', label: 'Replace fountain filter', scope: 'private', created_by: 'app',
  next_due: '2026-11-12', item_id: null, paused: false, ...over,
});
let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld(new FakeHousehold({ ...fixtureSnapshot(), lists: emptyLists(), events: [] }));
});
const refresh = async () => { await act(async () => { await store().getState().refresh(); }); };

it('shows a dated item and known routine in dots and agenda, opening its list without event controls', async () => {
  server.lists.chores.push(item({ id: 901, list: 'chores', label: 'Clean bowl', due_date: '2026-11-12' }));
  server.routines = [routine()];
  await mount('CalendarView', { date: '2026-11-12' });
  expect(screen.getByText('Clean bowl')).toBeTruthy();
  expect(screen.getByText('Replace fountain filter')).toBeTruthy();
  expect(screen.getByText('2 ITEMS')).toBeTruthy();
  expect(screen.getAllByText('DUE')).toHaveLength(2);
  expect(within(screen.getByTestId('calendar-cell-2026-11-12')).getAllByTestId('calendar-due-dot')).toHaveLength(2);
  fireEvent.press(screen.getAllByTestId('agenda-due-row')[0]);
  expect(navTargets().join(' ')).toContain('chores');
  expect(within(screen.getAllByTestId('agenda-due-row')[0]).queryByTestId('agenda-remove')).toBeNull();
});

it('shows the next two known dates across months without predicting another weekly occurrence', async () => {
  server.routines = [routine(), routine({ id: 903, label: 'Replace air filter', next_due: '2026-12-05', scope: 'shared' })];
  await mount('CalendarView', { date: '2026-11-12' });
  expect(screen.getByText('Replace fountain filter')).toBeTruthy();
  expect(screen.queryByText('Replace air filter')).toBeNull();
  fireEvent.press(screen.getByTestId('calendar-cell-2026-11-19'));
  await flush();
  expect(screen.queryByTestId('agenda-due-row')).toBeNull();
  fireEvent.press(screen.getByTestId('calendar-next-month'));
  await flush();
  fireEvent.press(screen.getByTestId('calendar-cell-2026-12-05'));
  await flush();
  expect(screen.getByText('Replace air filter')).toBeTruthy();
  expect(screen.queryByText('Replace fountain filter')).toBeNull();
});

it('suppresses routine duplicates, including done/undo items, while pause preserves an existing open item', async () => {
  server.lists.chores.push(item({ id: 1, list: 'chores', label: 'Open occurrence', due_date: '2026-11-12', routine_id: 902 }));
  server.routines = [routine({ item_id: 1, paused: true })];
  await mount('CalendarView', { date: '2026-11-12' });
  expect(screen.getByText('Open occurrence')).toBeTruthy();
  expect(screen.queryByText('Replace fountain filter')).toBeNull();
  server.lists.chores[0].done_at = '2026-11-12T14:00:00Z';
  await refresh();
  expect(screen.queryByTestId('agenda-due-row')).toBeNull();
  server.lists.chores = [];
  server.routines = [routine({ paused: true })];
  await refresh();
  expect(screen.queryByTestId('agenda-due-row')).toBeNull();
});

it('uses routine identity defensively when item_id is missing a cross-read update', async () => {
  server.lists.chores.push(item({ id: 1, list: 'chores', label: 'Existing occurrence', due_date: '2026-11-12', routine_id: 902 }));
  server.routines = [routine()];
  await mount('CalendarView', { date: '2026-11-12' });
  expect(screen.getAllByTestId('agenda-due-row')).toHaveLength(1);
});

it('moves only the known next occurrence after a normal completion refresh', async () => {
  server.routines = [routine()];
  await mount('CalendarView', { date: '2026-11-12' });
  expect(screen.getByText('Replace fountain filter')).toBeTruthy();
  server.routines = [routine({ next_due: '2026-11-19' })];
  await refresh();
  expect(screen.queryByText('Replace fountain filter')).toBeNull();
  fireEvent.press(screen.getByTestId('calendar-cell-2026-11-19'));
  await flush();
  expect(screen.getByText('Replace fountain filter')).toBeTruthy();
  expect(store().getState().snapshot?.routines?.[0].next_due).toBe('2026-11-19');
});

it('supports older snapshots with no routines and leaves overdue rows on their original date', async () => {
  server.lists.tasks.push(item({ id: 1, list: 'tasks', label: 'Original date', due_date: '2026-10-01' }));
  await mount('CalendarView');
  expect(screen.queryByText('Original date')).toBeNull();
  fireEvent.press(screen.getByTestId('calendar-cell-2026-10-01'));
  await flush();
  expect(screen.getByText('Original date')).toBeTruthy();
});

it('keeps event/item/routine keys distinct and rejects private-scope leaks', async () => {
  server.events = [event({ id: 1, date: '2026-11-12', title: 'Real event' })];
  server.lists.chores = [item({ id: 1, list: 'chores', label: 'List item', due_date: '2026-11-12' }),
    item({ id: 2, list: 'chores', label: 'Hidden item', due_date: '2026-11-12', scope: 'other' as any })];
  server.routines = [routine({ id: 1 }), routine({ id: 2, label: 'Hidden routine', scope: 'other' as any })];
  await mount('CalendarView', { date: '2026-11-12' });
  expect(screen.getByText('3 ITEMS')).toBeTruthy();
  expect(screen.queryByText('Hidden item')).toBeNull();
  expect(screen.queryByText('Hidden routine')).toBeNull();
  expect(calendarRows(store().getState().snapshot!).map((r) => r.key)).toEqual(['event:1', 'item:1', 'routine:1']);
  expect(screen.getAllByTestId('agenda-remove')).toHaveLength(1);
});
