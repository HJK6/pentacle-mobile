import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import ScheduledRoute from '../app/pentacle/scheduled';
import { replaceScheduledFromSnapshot, resetScheduled } from '../src/services/recurringSchedules';
import {
  pauseRecurringSchedule, resumeRecurringSchedule, updateRecurringSchedule,
} from '../src/services/pentacleStream';

jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/services/pentacleStream', () => ({
  pauseRecurringSchedule: jest.fn(),
  resumeRecurringSchedule: jest.fn(),
  updateRecurringSchedule: jest.fn(),
}));

const RULE_ID = '11111111-1111-4111-8111-111111111111';
function rule(overrides: Record<string, unknown> = {}) {
  return {
    recurring_id: RULE_ID, name: 'Nightly retro', state: 'active', tz: 'America/Chicago',
    recurrence: { every: 'daily', at_time: '02:00', days: [], tz: 'America/Chicago' },
    recurrence_text: 'daily at 02:00 America/Chicago',
    next_fire_at_utc: new Date(Date.now() + 11 * 3600_000).toISOString(),
    last_result: 'missed', last_result_reason: 'late', missed_count: 1, ...overrides,
  };
}
const oneShot = {
  schedule_id: 'sched-1', state: 'pending', prompt_preview: 'Check the dishwasher',
  fires_at_utc: new Date(Date.now() + 2 * 3600_000).toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
  resetScheduled();
  (pauseRecurringSchedule as jest.Mock).mockResolvedValue({});
  (resumeRecurringSchedule as jest.Mock).mockResolvedValue({});
  (updateRecurringSchedule as jest.Mock).mockResolvedValue({});
});

test('renders the rules first with zone text, state and last run, then the pending one-shots', () => {
  replaceScheduledFromSnapshot({ recurring: [rule()], schedules: [oneShot] });
  const view = render(<ScheduledRoute />);
  expect(view.getByText('Nightly retro')).toBeTruthy();
  expect(view.getByText('daily at 02:00 America/Chicago')).toBeTruthy();
  expect(view.getByText(/Next: .*(CDT|CST).*\(in /)).toBeTruthy();
  expect(view.getByText('Last: missed: late')).toBeTruthy();
  expect(view.getByTestId(`scheduled-state-${RULE_ID}`).props.children).toBe('ACTIVE');
  expect(view.getByText('Check the dishwasher')).toBeTruthy();
  // One-shot rows are read-only: no Pause/Edit controls beyond the rule's own two.
  expect(view.getAllByRole('button').filter((button) => /^(Pause|Resume|Edit)$/.test(String(button.props.accessibilityLabel ?? '')))).toHaveLength(0);
  expect(view.getByTestId(`scheduled-toggle-${RULE_ID}`)).toBeTruthy();
  expect(view.getByTestId(`scheduled-edit-${RULE_ID}`)).toBeTruthy();
  expect(view.queryByTestId('scheduled-oneshot-sched-1-toggle')).toBeNull();
});

test('shows the empty state when nothing is scheduled', () => {
  expect(render(<ScheduledRoute />).getByTestId('scheduled-empty')).toBeTruthy();
});

test('Pause and Resume call the recurring verbs for the tapped rule', async () => {
  replaceScheduledFromSnapshot({ recurring: [rule()] });
  const view = render(<ScheduledRoute />);
  fireEvent.press(view.getByTestId(`scheduled-toggle-${RULE_ID}`));
  await waitFor(() => expect(pauseRecurringSchedule).toHaveBeenCalledWith(RULE_ID));
  act(() => replaceScheduledFromSnapshot({ recurring: [rule({ state: 'paused' })] }));
  expect(view.getByText('Resume')).toBeTruthy();
  expect(view.getByText('Next: paused')).toBeTruthy();
  fireEvent.press(view.getByTestId(`scheduled-toggle-${RULE_ID}`));
  await waitFor(() => expect(resumeRecurringSchedule).toHaveBeenCalledWith(RULE_ID));
});

test('a failed Pause is shown, not swallowed', async () => {
  (pauseRecurringSchedule as jest.Mock).mockRejectedValue(new Error('not_found'));
  replaceScheduledFromSnapshot({ recurring: [rule()] });
  const view = render(<ScheduledRoute />);
  fireEvent.press(view.getByTestId(`scheduled-toggle-${RULE_ID}`));
  expect((await view.findByTestId('scheduled-failure')).props.children).toBe('not_found');
});

test('Edit opens a sheet with the five editable fields and saves them', async () => {
  replaceScheduledFromSnapshot({ recurring: [rule()] });
  const view = render(<ScheduledRoute />);
  fireEvent.press(view.getByTestId(`scheduled-edit-${RULE_ID}`));
  expect(view.getByTestId('scheduled-edit-sheet')).toBeTruthy();
  expect(view.getByTestId('scheduled-edit-name').props.value).toBe('Nightly retro');
  expect(view.getByTestId('scheduled-edit-time').props.value).toBe('02:00');
  expect(view.getByTestId('scheduled-edit-tz').props.value).toBe('America/Chicago');
  fireEvent.changeText(view.getByTestId('scheduled-edit-time'), '03:30');
  fireEvent.press(view.getByTestId('scheduled-edit-every-weekly'));
  fireEvent.press(view.getByTestId('scheduled-edit-day-mon'));
  fireEvent.press(view.getByTestId('scheduled-edit-day-wed'));
  fireEvent.press(view.getByTestId('scheduled-edit-save'));
  await waitFor(() => expect(updateRecurringSchedule).toHaveBeenCalledWith(RULE_ID, {
    name: 'Nightly retro', every: 'weekly', at_time: '03:30', days: ['mon', 'wed'], tz: 'America/Chicago',
  }));
  await waitFor(() => expect(view.queryByTestId('scheduled-edit-sheet')).toBeNull());
});

test('a refused edit keeps the sheet open with the daemon reason; non-weekly rules send no days', async () => {
  (updateRecurringSchedule as jest.Mock).mockRejectedValueOnce(new Error('unknown time zone'));
  replaceScheduledFromSnapshot({ recurring: [rule()] });
  const view = render(<ScheduledRoute />);
  fireEvent.press(view.getByTestId(`scheduled-edit-${RULE_ID}`));
  fireEvent.changeText(view.getByTestId('scheduled-edit-tz'), 'Mars/Olympus');
  fireEvent.press(view.getByTestId('scheduled-edit-save'));
  expect((await view.findByTestId('scheduled-edit-error')).props.children).toBe('unknown time zone');
  expect(updateRecurringSchedule).toHaveBeenCalledWith(RULE_ID, expect.objectContaining({ days: [], tz: 'Mars/Olympus' }));
  expect(view.getByTestId('scheduled-edit-sheet')).toBeTruthy();
});
