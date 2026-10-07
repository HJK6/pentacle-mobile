import {
  FakeHousehold, advance, callsOf, flatStyle, flush, mutationCalls, registerOutboundGuard, rpcError, rpcTimeout,
  textOf, unknownOutcomeFor,
} from './support';
import { fireEvent, isInert, mount, resetWorld, screen, within } from './screens';

registerOutboundGuard();

// The sheet is opened exactly as users open it: from the calendar (it takes no required props).
let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld();
});

const PRIVATE_NOTE = "PRIVATE TO YOU · SAM WON'T SEE THIS";
const UNRESOLVED = "Couldn't confirm — checking again";

async function openSheet(props: Record<string, unknown> = {}) {
  const view = await mount('CalendarView', props);
  fireEvent.press(screen.getByTestId('calendar-new-event'));
  await flush();
  return view;
}
const title = () => screen.getByTestId('event-sheet-title');
const time = () => screen.getByTestId('event-sheet-time');
const save = () => screen.getByTestId('event-sheet-save');
const type = (el: ReturnType<typeof title>, text: string) => fireEvent.changeText(el, text);
const togglePartner = () => fireEvent.press(screen.getByTestId('event-sheet-who-partner'));
const toggleMe = () => fireEvent.press(screen.getByTestId('event-sheet-who-me'));

describe('AddEventSheet layout and defaults', () => {
  it('has Cancel / New event / Save, a full-width title with the spec placeholder, blank time and Me selected', async () => {
    await openSheet();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.getByText('New event')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
    expect(title().props.placeholder).toBe('What’s happening?');
    expect(time().props.value ?? '').toBe('');
    expect(screen.getByText('TITLE')).toBeTruthy();
    expect(screen.getByText('DATE')).toBeTruthy();
    expect(screen.getByText('TIME')).toBeTruthy();
    expect(textOf(screen.getByTestId('event-sheet-date'))).toContain('TUE OCT 6'); // defaults to the selected day
    expect(screen.queryByTestId('event-sheet-private-note')).toBeNull();
  });

  it('puts DATE and TIME in one two-equal-column row with a 10 px gap, apart from the title and WHO rows', async () => {
    await openSheet();
    // Walk up from the TIME field to the first row-direction container.
    let row = time().parent;
    while (row && flatStyle(row).flexDirection !== 'row') row = row.parent;
    expect(row).not.toBeNull();
    const rowStyle = flatStyle(row);
    expect(rowStyle.gap ?? rowStyle.columnGap).toBe(10);
    const contains = (testID?: string, text?: string) => {
      const hits = testID ? within(row as never).queryAllByTestId(testID) : within(row as never).queryAllByText(text as string);
      return hits.length > 0;
    };
    expect(contains(undefined, 'DATE')).toBe(true);
    expect(contains('event-sheet-time')).toBe(true);
    expect(contains('event-sheet-title')).toBe(false);
    expect(contains('event-sheet-who-me')).toBe(false);
    expect(contains('event-sheet-who-partner')).toBe(false);
    const columns = (row as { children: Array<{ props: Record<string, unknown> } | string> }).children.filter(
      (c) => typeof c !== 'string',
    ) as Array<{ props: { style?: unknown } }>;
    expect(columns).toHaveLength(2);
    const flexes = columns.map((c) => flatStyle(c as never).flex);
    expect(flexes[0]).toBe(flexes[1]);
    expect(flexes[0]).toBeGreaterThan(0);
  });
});

describe('AddEventSheet Save gating', () => {
  it('is disabled until the trimmed title is non-empty', async () => {
    await openSheet();
    expect(isInert(save())).toBe(true);
    type(title(), '   ');
    expect(isInert(save())).toBe(true);
    type(title(), ' Dentist ');
    expect(isInert(save())).toBe(false);
    fireEvent.press(screen.getByText('Cancel'));
  });

  it.each([
    ['', true],
    ['4:30', true],
    ['16:30', true],
    ['4:30p', true],
    ['4:30 pm', true],
    ['12:15am', true],
    ['25:00', false],
    ['4:3', false],
    ['abc', false],
  ])('with a title, time %j is %s', async (text, valid) => {
    await openSheet();
    type(title(), 'Dentist');
    type(time(), text);
    expect(isInert(save())).toBe(!valid);
    fireEvent.press(screen.getByText('Cancel'));
  });

  it('pressing a disabled Save sends nothing', async () => {
    await openSheet();
    fireEvent.press(save());
    type(title(), 'x');
    type(time(), 'abc');
    fireEvent.press(save());
    await flush();
    expect(mutationCalls()).toEqual([]);
  });
});

describe('AddEventSheet WHO toggles and the private note', () => {
  it('shows the private note exactly while the partner toggle is on', async () => {
    await openSheet();
    expect(screen.queryByTestId('event-sheet-private-note')).toBeNull();
    togglePartner(); // Me + partner
    expect(textOf(screen.getByTestId('event-sheet-private-note'))).toBe(PRIVATE_NOTE);
    toggleMe(); // partner only
    expect(textOf(screen.getByTestId('event-sheet-private-note'))).toBe(PRIVATE_NOTE);
    toggleMe(); // Me + partner again
    togglePartner(); // Me only
    expect(screen.queryByTestId('event-sheet-private-note')).toBeNull();
  });

  it.each([
    ['Me only (default)', () => undefined, 'self'],
    ['Partner only', () => { togglePartner(); toggleMe(); }, 'partner'],
    ['Me + partner', () => togglePartner(), 'both'],
  ])('maps %s to who=%s in the save payload', async (_name, setup, who) => {
    await openSheet();
    setup();
    type(title(), 'Probe');
    fireEvent.press(save());
    await flush();
    expect(callsOf('household.event.add')).toEqual([
      { verb: 'household.event.add', fields: { date: '2026-10-06', time: null, title: 'Probe', who } },
    ]);
  });

  it('keeps at least one toggle on: turning off the last one is ignored', async () => {
    await openSheet();
    toggleMe(); // Me is the only one on → stays on
    type(title(), 'Probe');
    fireEvent.press(save());
    await flush();
    expect(callsOf('household.event.add')[0].fields.who).toBe('self');
  });

  it('keeps the partner on when it is the last toggle', async () => {
    await openSheet();
    togglePartner();
    toggleMe(); // partner only
    togglePartner(); // would leave none → ignored
    expect(screen.getByTestId('event-sheet-private-note')).toBeTruthy();
    type(title(), 'Probe');
    fireEvent.press(save());
    await flush();
    expect(callsOf('household.event.add')[0].fields.who).toBe('partner');
  });
});

describe('AddEventSheet date picker (mini month calendar)', () => {
  const dateField = () => screen.getByTestId('event-sheet-date');
  const openPicker = () => fireEvent.press(dateField());
  const day = (date: string) => screen.getByTestId(`mini-calendar-day-${date}`);

  it('shows DOW MON D and opens an inline month calendar on the selected day, with today and the pick marked', async () => {
    await openSheet();
    expect(textOf(dateField())).toContain('TUE OCT 6');
    expect(screen.queryByTestId('mini-calendar')).toBeNull();
    openPicker();
    expect(screen.getByTestId('mini-calendar-title').props.children).toBe('October 2026');
    expect(day('2026-10-06').props.accessibilityState).toEqual({ selected: true });
    expect(screen.queryByTestId('mini-calendar-day-2026-11-01')).toBeNull();
  });

  it('tapping a day sets the date and closes the picker; the saved date follows', async () => {
    await openSheet();
    openPicker();
    fireEvent.press(day('2026-10-09'));
    expect(screen.queryByTestId('mini-calendar')).toBeNull();
    expect(textOf(dateField())).toContain('FRI OCT 9');
    type(title(), 'Probe');
    fireEvent.press(save());
    await flush();
    expect(callsOf('household.event.add')[0].fields.date).toBe('2026-10-09');
  });

  it('pages to another month without fetching, and a pick there is saved in that month', async () => {
    await openSheet();
    openPicker();
    const fetched = callsOf('household.snapshot').length;
    fireEvent.press(screen.getByTestId('mini-calendar-next'));
    fireEvent.press(screen.getByTestId('mini-calendar-next'));
    expect(screen.getByTestId('mini-calendar-title').props.children).toBe('December 2026');
    fireEvent.press(screen.getByTestId('mini-calendar-prev'));
    expect(screen.getByTestId('mini-calendar-title').props.children).toBe('November 2026');
    expect(callsOf('household.snapshot')).toHaveLength(fetched);
    fireEvent.press(day('2026-11-20'));
    expect(textOf(dateField())).toContain('FRI NOV 20');
    type(title(), 'Probe');
    fireEvent.press(save());
    await flush();
    expect(callsOf('household.event.add')[0].fields.date).toBe('2026-11-20');
  });

  it('appends the year when it is not the current year', async () => {
    await openSheet();
    openPicker();
    for (let i = 0; i < 3; i += 1) fireEvent.press(screen.getByTestId('mini-calendar-next'));
    fireEvent.press(day('2027-01-05'));
    expect(textOf(dateField())).toContain('TUE JAN 5, 2027');
  });

  it('pressing the field again closes the picker without changing the date', async () => {
    await openSheet();
    openPicker();
    openPicker();
    expect(screen.queryByTestId('mini-calendar')).toBeNull();
    expect(textOf(dateField())).toContain('TUE OCT 6');
  });

  it('opens on the day selected in the calendar', async () => {
    await mount('CalendarView');
    fireEvent.press(screen.getByTestId('calendar-cell-2026-10-08'));
    await flush();
    fireEvent.press(screen.getByTestId('calendar-new-event'));
    await flush();
    expect(textOf(dateField())).toContain('THU OCT 8');
  });
});

describe('AddEventSheet Save', () => {
  it('sends exactly {date, time, title, who} with a trimmed title and a 24 h time, never a scope', async () => {
    await openSheet();
    type(title(), '  Dentist  ');
    type(time(), '4:30p');
    fireEvent.press(save());
    await flush();
    const sent = mutationCalls();
    expect(sent).toEqual([
      {
        verb: 'household.event.add',
        fields: { date: '2026-10-06', time: '16:30', title: 'Dentist', who: 'self' },
      },
    ]);
    expect(Object.keys(sent[0].fields).sort()).toEqual(['date', 'time', 'title', 'who']);
  });

  it('closes on success and shows the new event; a partner/both event the server keeps private says so', async () => {
    await openSheet();
    togglePartner();
    type(title(), 'Dinner with Sam');
    type(time(), '7:30p');
    fireEvent.press(save());
    await flush();
    expect(screen.queryByTestId('event-sheet-save')).toBeNull();
    const row = screen.queryAllByTestId('agenda-row').find((r) => textOf(r).includes('Dinner with Sam'));
    expect(row).toBeTruthy();
    expect(within(row as never).getByText('7:30p')).toBeTruthy();
    expect(within(row as never).getByText('ME + SAM · PRIVATE')).toBeTruthy(); // scope came back as private
  });

  it('a Me-only event is added without a PRIVATE suffix', async () => {
    await openSheet();
    type(title(), 'Solo run');
    fireEvent.press(save());
    await flush();
    const row = screen.queryAllByTestId('agenda-row').find((r) => textOf(r).includes('Solo run'));
    expect(row).toBeTruthy();
    expect(within(row as never).getByText('ALL DAY')).toBeTruthy();
    expect(within(row as never).getByText('ME')).toBeTruthy();
    expect(within(row as never).queryByText(/PRIVATE/)).toBeNull();
  });

  it('keeps the sheet open with the draft after a definite failure and does not resend on its own', async () => {
    server.override('household.event.add', () => Promise.reject(rpcError('unavailable')));
    await openSheet();
    type(title(), 'Probe');
    fireEvent.press(save());
    await flush();
    await advance(60000);
    expect(screen.getByTestId('event-sheet-save')).toBeTruthy();
    expect(title().props.value).toBe('Probe');
    expect(isInert(save())).toBe(false);
    expect(callsOf('household.event.add')).toHaveLength(1);
    expect(screen.queryAllByTestId('agenda-row').some((r) => textOf(r).includes('Probe'))).toBe(false);
  });
});

describe('AddEventSheet unknown outcomes (spec Target 6)', () => {
  describe.each([
    ['errorCode unknown_outcome', () => rpcError('unknown_outcome')],
    ['RPC timeout (no errorCode)', rpcTimeout],
  ])('%s', (_name, makeError) => {
    it('keeps the sheet and draft, disables Save, then shows the event when it commits late', async () => {
      server.override('household.event.add', unknownOutcomeFor('household.event.add', 3000, makeError));
      await openSheet();
      type(title(), 'Probe');
      fireEvent.press(save());
      await flush();
      expect(callsOf('household.event.add')).toHaveLength(1);
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();
      expect(title().props.value).toBe('Probe');
      expect(isInert(save())).toBe(true);
      fireEvent.press(save());
      await flush();
      expect(callsOf('household.event.add')).toHaveLength(1);

      await advance(6000);
      await flush();
      expect(screen.queryByText(UNRESOLVED)).toBeNull();
      expect(screen.queryByText('Not saved')).toBeNull();
      expect(screen.queryAllByTestId('agenda-row').filter((r) => textOf(r).includes('Probe'))).toHaveLength(1);
      expect(callsOf('household.event.add')).toHaveLength(1);
    });

    it('shows Not saved and re-enables Save when the event is still absent after the second readback', async () => {
      server.override('household.event.add', unknownOutcomeFor('household.event.add', 'never', makeError));
      await openSheet();
      type(title(), 'Probe');
      fireEvent.press(save());
      await flush();
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();

      await advance(6000);
      await flush();
      expect(screen.getByText('Not saved')).toBeTruthy();
      expect(screen.queryByText(UNRESOLVED)).toBeNull();
      expect(screen.getByTestId('event-sheet-save')).toBeTruthy();
      expect(title().props.value).toBe('Probe');
      expect(isInert(save())).toBe(false);
      expect(callsOf('household.event.add')).toHaveLength(1);
      expect(screen.queryAllByTestId('agenda-row').some((r) => textOf(r).includes('Probe'))).toBe(false);
    });
  });
});
