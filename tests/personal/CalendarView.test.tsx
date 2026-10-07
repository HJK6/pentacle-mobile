import {
  DIM, FakeHousehold, GREEN, MUTED, advance, callsOf, colorOf, event, flush, hasStyleColor, mutationCalls,
  poisonDeviceZone, registerOutboundGuard, rpcError, rpcTimeout, sameColor, snapshotCalls, textOf,
  unknownOutcomeFor, withBackground,
} from './support';
import { fireEvent, isDisabled, mount, resetWorld, screen, within } from './screens';

registerOutboundGuard();

let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld();
});

const TEXT = '#e6fff2';
const cell = (date: string) => screen.getByTestId(`calendar-cell-${date}`);
const agenda = () => screen.queryAllByTestId('agenda-row');
const agendaRow = (title: string) => {
  const hit = agenda().find((r) => textOf(r).includes(title));
  if (!hit) throw new Error(`no agenda-row containing "${title}"; rows: ${JSON.stringify(agenda().map((r) => textOf(r)))}`);
  return hit;
};
const hasAgendaRow = (title: string) => agenda().some((r) => textOf(r).includes(title));
const requestedMonths = () => snapshotCalls().map((c) => c.fields.month as string | undefined);
const UNRESOLVED = "Couldn't confirm — checking again";

describe('CalendarView month grid', () => {
  it('shows the year over the month name, the weekday row and a + Event button', async () => {
    await mount('CalendarView');
    expect(screen.getByText('October')).toBeTruthy();
    expect(screen.getByText('2026')).toBeTruthy();
    expect(textOf(screen.getByTestId('calendar-new-event'))).toMatch(/Event/);
    expect(screen.getAllByText('S')).toHaveLength(2);
    expect(screen.getAllByText('T')).toHaveLength(2);
    for (const letter of ['M', 'W', 'F']) expect(screen.getAllByText(letter)).toHaveLength(1);
  });

  it('has one cell per day of the shown month and none for neighbouring months', async () => {
    await mount('CalendarView');
    for (let d = 1; d <= 31; d += 1) {
      expect(screen.queryByTestId(`calendar-cell-2026-10-${String(d).padStart(2, '0')}`)).not.toBeNull();
    }
    expect(screen.queryByTestId('calendar-cell-2026-09-30')).toBeNull();
    expect(screen.queryByTestId('calendar-cell-2026-11-01')).toBeNull();
  });

  it('colours today green, past days muted, the selected day with a green border and fill', async () => {
    await mount('CalendarView', { date: '2026-10-20' });
    expect(hasStyleColor(cell('2026-10-20'), 'borderColor', GREEN)).toBe(true);
    expect(hasStyleColor(cell('2026-10-06'), 'borderColor', GREEN)).toBe(false);
    expect(hasStyleColor(cell('2026-10-20'), 'backgroundColor', `${GREEN}18`)).toBe(true);
    expect(sameColor(colorOf(within(cell('2026-10-06')).getByText('6')), GREEN)).toBe(true);
    expect(sameColor(colorOf(within(cell('2026-10-01')).getByText('1')), MUTED)).toBe(true);
    expect(sameColor(colorOf(within(cell('2026-10-21')).getByText('21')), TEXT)).toBe(true);
  });

  it('shows up to three dots per day: green for Bart-added events, dim otherwise', async () => {
    await mount('CalendarView');
    const dots = (date: string) => ({
      green: withBackground(cell(date), GREEN).length,
      dim: withBackground(cell(date), DIM).length,
    });
    expect(dots('2026-10-21')).toEqual({ green: 1, dim: 1 }); // Bart + app
    expect(dots('2026-10-13')).toEqual({ green: 1, dim: 0 }); // Bart only
    expect(dots('2026-10-08')).toEqual({ green: 0, dim: 2 }); // two app events
    expect(dots('2026-10-07')).toEqual({ green: 0, dim: 1 }); // partner's assistant
    const today = dots('2026-10-06'); // four events → capped at three dots
    expect(today.green + today.dim).toBe(3);
    expect(dots('2026-10-10')).toEqual({ green: 0, dim: 0 });
  });
});

describe('CalendarView agenda', () => {
  it("defaults to today: header 'TUE 6 · TODAY', event count and rows in time order with who labels and Bart markers", async () => {
    await mount('CalendarView');
    expect(screen.getByText('TUE 6 · TODAY')).toBeTruthy();
    expect(screen.getByText('4 EVENTS')).toBeTruthy();
    expect(agenda()).toHaveLength(4);
    const expectRow = (i: number, title: string, time: string, who: string) => {
      const row = agenda()[i];
      expect(within(row).getByText(title)).toBeTruthy();
      expect(within(row).getByText(time)).toBeTruthy();
      expect(within(row).getByText(who)).toBeTruthy();
    };
    expectRow(0, 'Trash day', 'ALL DAY', 'ME + SAM');
    expectRow(1, 'Standup with design review', '9:30a', 'ME');
    expectRow(2, 'Vet — Pine St clinic', '2:30p', 'ME + SAM · PRIVATE');
    expectRow(3, 'TestFlight cutoff', '6:00p', 'ME');
    // 'ADDED BY <assistant name>' only where created_by === 'bart'
    expect(screen.getAllByText(/ADDED BY ASSISTANT/)).toHaveLength(2);
    expect(within(agendaRow('Vet')).getByText(/ADDED BY ASSISTANT/)).toBeTruthy();
    expect(within(agendaRow('TestFlight')).getByText(/ADDED BY ASSISTANT/)).toBeTruthy();
    expect(within(agendaRow('Trash day')).queryByText(/ADDED BY ASSISTANT/)).toBeNull();
    expect(within(agendaRow('Standup')).queryByText(/ADDED BY ASSISTANT/)).toBeNull();
  });

  it("tapping another day shows that day without ' · TODAY' and a singular/plural event count", async () => {
    await mount('CalendarView');
    fireEvent.press(cell('2026-10-08'));
    await flush();
    expect(screen.getByText('THU 8')).toBeTruthy();
    expect(screen.queryByText(/TODAY/)).toBeNull();
    expect(screen.getByText('2 EVENTS')).toBeTruthy();
    expect(agenda().map((r) => textOf(r).includes('Early run'))).toEqual([true, false]); // 8:00a before 4:00p
    expect(textOf(agenda()[1])).toContain('Dentist');

    fireEvent.press(cell('2026-10-07'));
    await flush();
    expect(screen.getByText('WED 7')).toBeTruthy();
    expect(screen.getByText('1 EVENT')).toBeTruthy();
    expect(within(agendaRow('Job A site visit')).getByText('SAM')).toBeTruthy();
  });

  it('shows the dashed empty state for a day with no events and + ADD AN EVENT opens the sheet', async () => {
    await mount('CalendarView');
    fireEvent.press(cell('2026-10-10'));
    await flush();
    expect(screen.getByText('SAT 10')).toBeTruthy();
    expect(screen.getByText('0 EVENTS')).toBeTruthy();
    expect(screen.getByText('Nothing scheduled')).toBeTruthy();
    expect(agenda()).toHaveLength(0);
    expect(screen.queryByTestId('event-sheet-title')).toBeNull();
    fireEvent.press(screen.getByText('+ ADD AN EVENT'));
    await flush();
    expect(screen.getByTestId('event-sheet-title')).toBeTruthy();
  });

  it('does not show the empty state on a day that has events', async () => {
    await mount('CalendarView');
    expect(screen.queryByText('Nothing scheduled')).toBeNull();
    expect(screen.queryByText('+ ADD AN EVENT')).toBeNull();
  });

  it('opens the new-event sheet from + Event and closes it with Cancel without sending anything', async () => {
    await mount('CalendarView');
    expect(screen.queryByTestId('event-sheet-save')).toBeNull();
    fireEvent.press(screen.getByTestId('calendar-new-event'));
    await flush();
    expect(screen.getByTestId('event-sheet-save')).toBeTruthy();
    fireEvent.press(screen.getByText('Cancel'));
    await flush();
    expect(screen.queryByTestId('event-sheet-save')).toBeNull();
    expect(mutationCalls()).toEqual([]);
  });
});

describe('CalendarView ✕ remove', () => {
  it('sends one household.event.remove and the row leaves', async () => {
    await mount('CalendarView');
    fireEvent.press(within(agendaRow('TestFlight cutoff')).getByTestId('agenda-remove'));
    await flush();
    expect(mutationCalls()).toEqual([{ verb: 'household.event.remove', fields: { event_id: 104 } }]);
    expect(hasAgendaRow('TestFlight cutoff')).toBe(false);
    expect(screen.getByText('3 EVENTS')).toBeTruthy();
  });

  it('a failed remove restores the row and is not retried', async () => {
    server.override('household.event.remove', () => Promise.reject(rpcError('unavailable')));
    await mount('CalendarView');
    fireEvent.press(within(agendaRow('TestFlight cutoff')).getByTestId('agenda-remove'));
    await flush();
    await advance(60000);
    expect(hasAgendaRow('TestFlight cutoff')).toBe(true);
    expect(callsOf('household.event.remove')).toHaveLength(1);
  });

  describe.each([
    ['errorCode unknown_outcome', () => rpcError('unknown_outcome')],
    ['RPC timeout (no errorCode)', rpcTimeout],
  ])('unknown outcome (%s)', (_name, makeError) => {
    it('keeps the row hidden while unresolved and restores it with Not saved when still present', async () => {
      server.override('household.event.remove', unknownOutcomeFor('household.event.remove', 'never', makeError));
      await mount('CalendarView');
      fireEvent.press(within(agendaRow('TestFlight cutoff')).getByTestId('agenda-remove'));
      await flush();
      expect(hasAgendaRow('TestFlight cutoff')).toBe(false);
      expect(screen.getByText(UNRESOLVED)).toBeTruthy();
      await advance(6000);
      await flush();
      expect(hasAgendaRow('TestFlight cutoff')).toBe(true);
      expect(screen.getByText('Not saved')).toBeTruthy();
      expect(callsOf('household.event.remove')).toHaveLength(1);
    });

    it('stays gone, with no notice, when the remove committed late', async () => {
      server.override('household.event.remove', unknownOutcomeFor('household.event.remove', 3000, makeError));
      await mount('CalendarView');
      fireEvent.press(within(agendaRow('TestFlight cutoff')).getByTestId('agenda-remove'));
      await flush();
      await advance(6000);
      await flush();
      expect(hasAgendaRow('TestFlight cutoff')).toBe(false);
      expect(screen.queryByText('Not saved')).toBeNull();
      expect(callsOf('household.event.remove')).toHaveLength(1);
    });
  });
});

describe('CalendarView month paging', () => {
  const next = () => fireEvent.press(screen.getByTestId('calendar-next-month'));
  const prev = () => fireEvent.press(screen.getByTestId('calendar-prev-month'));

  it('has labelled previous/next month buttons beside + Event, and no back-to-today on the current month', async () => {
    await mount('CalendarView');
    expect(screen.getByTestId('calendar-prev-month').props.accessibilityLabel).toBe('Previous month');
    expect(screen.getByTestId('calendar-next-month').props.accessibilityLabel).toBe('Next month');
    expect(screen.queryByTestId('calendar-back-to-today')).toBeNull();
    expect(screen.getByText('2026')).toBeTruthy();
  });

  it('next selects the 1st of the next month, requests that month and offers back to today', async () => {
    server.events.push(event({ id: 301, date: '2026-11-01', time: '09:00', title: 'Synthetic first-of-month' }));
    await mount('CalendarView');
    next();
    await flush();
    expect(screen.getByText('November')).toBeTruthy();
    expect(screen.getByText('SUN 1')).toBeTruthy();
    expect(requestedMonths()).toContain('2026-11');
    expect(hasAgendaRow('Synthetic first-of-month')).toBe(true);
    expect(screen.getByText('2026 · BACK TO TODAY')).toBeTruthy();
    expect(screen.queryByTestId('calendar-cell-2026-10-06')).toBeNull();
  });

  it('previous selects the 1st of the previous month, and paging back into this month selects today', async () => {
    await mount('CalendarView');
    prev();
    await flush();
    expect(screen.getByText('September')).toBeTruthy();
    expect(screen.getByText('TUE 1')).toBeTruthy();
    expect(requestedMonths()).toContain('2026-09');
    next();
    await flush();
    expect(screen.getByText('October')).toBeTruthy();
    expect(screen.getByText('TUE 6 · TODAY')).toBeTruthy();
    expect(screen.queryByTestId('calendar-back-to-today')).toBeNull();
  });

  it('back to today returns to this month with today selected', async () => {
    await mount('CalendarView');
    next();
    next();
    await flush();
    expect(screen.getByText('December')).toBeTruthy();
    fireEvent.press(screen.getByTestId('calendar-back-to-today'));
    await flush();
    expect(screen.getByText('October')).toBeTruthy();
    expect(screen.getByText('TUE 6 · TODAY')).toBeTruthy();
    expect(screen.queryByTestId('calendar-back-to-today')).toBeNull();
  });

  it.each([
    ['2000-01-15', 'calendar-prev-month', 'calendar-next-month'],
    ['2100-12-15', 'calendar-next-month', 'calendar-prev-month'],
  ])('at %s the outward button is disabled and the inward one is not', async (date, outward, inward) => {
    await mount('CalendarView', { date });
    expect(isDisabled(screen.getByTestId(outward))).toBe(true);
    expect(isDisabled(screen.getByTestId(inward))).toBe(false);
  });

  it('holds paging and back to today while a change is unresolved, then releases them', async () => {
    server.events.push(event({ id: 302, date: '2026-11-03', time: '09:00', title: 'Synthetic removable' }));
    server.override('household.event.remove', unknownOutcomeFor('household.event.remove', 'never'));
    await mount('CalendarView', { date: '2026-11-03' });
    fireEvent.press(within(agendaRow('Synthetic removable')).getByTestId('agenda-remove'));
    await flush();
    expect(screen.getByText(UNRESOLVED)).toBeTruthy();
    expect(isDisabled(screen.getByTestId('calendar-next-month'))).toBe(true);
    expect(isDisabled(screen.getByTestId('calendar-prev-month'))).toBe(true);
    expect(screen.queryByTestId('calendar-back-to-today')).toBeNull();
    await advance(6000);
    await flush();
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(isDisabled(screen.getByTestId('calendar-next-month'))).toBe(false);
    expect(screen.getByTestId('calendar-back-to-today')).toBeTruthy();
  });

  it('a new event saved in another month moves the calendar to that month with its day selected', async () => {
    await mount('CalendarView');
    fireEvent.press(screen.getByTestId('calendar-new-event'));
    await flush();
    fireEvent.press(screen.getByTestId('event-sheet-date'));
    fireEvent.press(screen.getByTestId('mini-calendar-next'));
    fireEvent.press(screen.getByTestId('mini-calendar-day-2026-11-20'));
    fireEvent.changeText(screen.getByTestId('event-sheet-title'), 'Synthetic November save');
    fireEvent.press(screen.getByTestId('event-sheet-save'));
    await flush();
    expect(screen.queryByTestId('event-sheet-save')).toBeNull();
    expect(screen.getByText('November')).toBeTruthy();
    expect(screen.getByText('FRI 20')).toBeTruthy();
    expect(hasAgendaRow('Synthetic November save')).toBe(true);
    expect(requestedMonths().slice(-1)).toEqual(['2026-11']);
  });
});

describe('CalendarView route date', () => {
  it('without a date, selects today and requests no out-of-range month', async () => {
    await mount('CalendarView', {}, false);
    expect(screen.getByText('TUE 6 · TODAY')).toBeTruthy();
    expect(requestedMonths().every((m) => m === undefined || m === '2026-10')).toBe(true);
  });

  it('a valid date in the shown month selects that day', async () => {
    await mount('CalendarView', { date: '2026-10-20' }, false);
    expect(screen.getByText('TUE 20')).toBeTruthy();
    expect(screen.queryByText(/TODAY/)).toBeNull();
    expect(screen.getByText('Nothing scheduled')).toBeTruthy();
  });

  it('a valid date in another month selects that day, requests that month and shows its grid and events', async () => {
    server.events.push(event({ id: 201, date: '2026-11-15', time: '10:00', title: 'Nov thing' }));
    await mount('CalendarView', { date: '2026-11-15' }, false);
    expect(requestedMonths()).toContain('2026-11');
    expect(screen.getByText('November')).toBeTruthy();
    expect(screen.getByText('SUN 15')).toBeTruthy();
    expect(screen.queryByText(/· TODAY$/)).toBeNull();
    expect(screen.queryByTestId('calendar-cell-2026-11-30')).not.toBeNull();
    expect(screen.queryByTestId('calendar-cell-2026-10-06')).toBeNull();
    expect(within(agendaRow('Nov thing')).getByText('10:00a')).toBeTruthy();
  });

  it.each([
    ['2000-01-01', '2000-01', 'SAT 1', 'January', '2000'],
    ['2100-12-31', '2100-12', 'FRI 31', 'December', '2100'],
  ])('accepts the boundary date %s and requests %s', async (date, month, header, monthName, year) => {
    await mount('CalendarView', { date }, false);
    expect(requestedMonths()).toContain(month);
    expect(screen.getByText(header)).toBeTruthy();
    expect(screen.getByText(monthName)).toBeTruthy();
    expect(screen.getByText(`${year} · BACK TO TODAY`)).toBeTruthy();
    expect(screen.queryByTestId(`calendar-cell-${date}`)).not.toBeNull();
    expect(screen.queryByText('Household store unavailable')).toBeNull();
  });

  it.each([
    '1999-12-31',
    '2101-01-01',
    '0000-01-01',
    '9999-12-31',
    '2026-13-45',
    '2026-02-30',
    '2026-10-6',
    'garbage',
    '',
  ])('ignores %j: today is used, no error, and no request for another month', async (date) => {
    await mount('CalendarView', { date }, false);
    expect(screen.getByText('TUE 6 · TODAY')).toBeTruthy();
    expect(screen.queryByText('Household store unavailable')).toBeNull();
    expect(requestedMonths().every((m) => m === undefined || m === '2026-10')).toBe(true);
  });

  it('keeps Chicago days when the device clock and zone are on the next day', async () => {
    const restore = poisonDeviceZone(840);
    try {
      jest.setSystemTime(new Date('2026-10-07T03:00:00Z'));
      await mount('CalendarView');
      expect(screen.getByText('TUE 6 · TODAY')).toBeTruthy();
      expect(screen.getByText('4 EVENTS')).toBeTruthy();
      expect(sameColor(colorOf(within(cell('2026-10-06')).getByText('6')), GREEN)).toBe(true);
      expect(sameColor(colorOf(within(cell('2026-10-07')).getByText('7')), TEXT)).toBe(true);
    } finally {
      restore();
    }
  });
});
