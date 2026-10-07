import {
  AMBER, FakeHousehold, RED, advance, callsOf, colorOf, flush, mutationCalls, poisonDeviceZone,
  registerOutboundGuard, rpcError, sameColor, textOf,
} from './support';
import { fireEvent, mount, navTargets, resetWorld, screen, store, within } from './screens';

registerOutboundGuard();

let server: FakeHousehold;
beforeEach(() => {
  server = resetWorld();
});

const todos = () => screen.queryAllByTestId('personal-todo-row');
const todayRows = () => screen.queryAllByTestId('personal-today-row');
const upcoming = () => screen.queryAllByTestId('personal-upcoming-row');
const lamps = (row: ReturnType<typeof todos>[number]) => within(row).queryAllByTestId('sigil-djinni');
const todoRow = (label: string) => {
  const hit = todos().find((r) => textOf(r).includes(label));
  if (!hit) throw new Error(`no personal-todo-row containing "${label}"`);
  return hit;
};

describe('PersonalHome header', () => {
  it('shows the Chicago day from the snapshot over the Personal title', async () => {
    await mount('PersonalHome');
    expect(screen.getByText('TUE · OCTOBER 6')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
  });
});

describe('PersonalHome TO-DO (critical items)', () => {
  it('counts and orders critical items: To-do, Grocery, Meals, Chores, Study plan, each in list-detail order', async () => {
    await mount('PersonalHome');
    expect(screen.getByText('TO-DO · 6')).toBeTruthy();
    expect(todos()).toHaveLength(6);
    [
      'Reply to Kalshi support',
      'Book flights for Nov',
      'Renew domain for altum.ai',
      'Pay invoice',
      'Oat milk',
      'Change HVAC filter',
    ].forEach((label, i) => expect(textOf(todos()[i])).toContain(label));
  });

  it('shows the list name and the due/priority tags under each title, with tone colours', async () => {
    await mount('PersonalHome');
    const check = (label: string, list: RegExp, tags: Array<[string, string]>) => {
      const row = todoRow(label);
      expect(within(row).getByText(list)).toBeTruthy();
      for (const [text, color] of tags) {
        expect(sameColor(colorOf(within(row).getByText(text)), color)).toBe(true);
      }
    };
    check('Reply to Kalshi support', /^to-do$/i, [['HIGH', AMBER]]);
    check('Book flights for Nov', /^to-do$/i, [['DUE OCT 20', AMBER], ['HIGH', AMBER]]);
    check('Renew domain for altum.ai', /^to-do$/i, [['DUE TODAY', RED]]);
    check('Pay invoice', /^to-do$/i, [['DUE TOMORROW', AMBER]]);
    check('Oat milk', /^grocery$/i, [['DUE TODAY', RED]]);
    check('Change HVAC filter', /^chores$/i, [['OVERDUE', RED]]);
  });

  it('shows the Bart lamp only on Bart-created items (partner-assistant-created shared item with due + hi has tags but no lamp)', async () => {
    await mount('PersonalHome');
    expect(lamps(todoRow('Reply to Kalshi support')).length).toBeGreaterThan(0);
    expect(lamps(todoRow('Renew domain for altum.ai')).length).toBeGreaterThan(0);
    const partnerItem = todoRow('Book flights for Nov');
    expect(within(partnerItem).getByText('HIGH')).toBeTruthy();
    expect(lamps(partnerItem)).toHaveLength(0);
    expect(lamps(todoRow('Pay invoice'))).toHaveLength(0);
    expect(lamps(todoRow('Oat milk'))).toHaveLength(0);
    expect(lamps(todoRow('Change HVAC filter'))).toHaveLength(0);
  });

  it('checking a row goes pending for 5 s, then sends exactly one household.item.done', async () => {
    await mount('PersonalHome');
    fireEvent.press(within(todoRow('Pay invoice')).getByTestId('list-item-check'));
    await flush();
    await advance(4999);
    expect(mutationCalls()).toEqual([]);
    await advance(1);
    expect(mutationCalls()).toEqual([{ verb: 'household.item.done', fields: { item_id: 6 } }]);
    await flush();
    expect(todos().some((r) => textOf(r).includes('Pay invoice'))).toBe(false);
    expect(screen.getByText('TO-DO · 5')).toBeTruthy();
  });

  it('undoing a pending check sends nothing', async () => {
    await mount('PersonalHome');
    fireEvent.press(within(todoRow('Oat milk')).getByTestId('list-item-check'));
    await flush();
    await advance(2000);
    fireEvent.press(within(todoRow('Oat milk')).getByTestId('list-item-check'));
    await flush();
    await advance(60000);
    expect(mutationCalls()).toEqual([]);
    expect(todos()).toHaveLength(6);
  });

  it('the Lists › link opens the Lists page', async () => {
    await mount('PersonalHome');
    fireEvent.press(screen.getByText(/^Lists/));
    await flush();
    expect(navTargets().join(' ')).toContain('/pentacle/personal/lists');
  });
});

describe('PersonalHome TODAY', () => {
  it("lists today's events, all-day first, with 12 h times, who labels, PRIVATE suffix and Bart lamps", async () => {
    await mount('PersonalHome');
    expect(screen.getByText('TODAY · 4')).toBeTruthy();
    expect(todayRows()).toHaveLength(4);
    const expectRow = (i: number, title: string, time: string, who: string, lamp: boolean) => {
      const row = todayRows()[i];
      expect(within(row).getByText(title)).toBeTruthy();
      expect(within(row).getByText(time)).toBeTruthy();
      expect(within(row).getByText(who)).toBeTruthy();
      expect(within(row).queryAllByTestId('sigil-djinni').length > 0).toBe(lamp);
    };
    expectRow(0, 'Trash day', 'ALL DAY', 'ME + SAM', false);
    expectRow(1, 'Standup with design review', '9:30a', 'ME', false);
    expectRow(2, 'Vet — Pine St clinic', '2:30p', 'ME + SAM · PRIVATE', true);
    expectRow(3, 'TestFlight cutoff', '6:00p', 'ME', true);
  });

  it('shows Nothing scheduled today when there are no events today', async () => {
    server.events = server.events.filter((e) => e.date !== '2026-10-06');
    await mount('PersonalHome');
    expect(screen.getByText('TODAY · 0')).toBeTruthy();
    expect(screen.getByText('Nothing scheduled today')).toBeTruthy();
    expect(todayRows()).toHaveLength(0);
  });

  it('the Calendar › link opens the calendar page', async () => {
    await mount('PersonalHome');
    fireEvent.press(screen.getByText(/^Calendar/));
    await flush();
    expect(navTargets().join(' ')).toContain('/pentacle/personal/calendar');
  });
});

describe('PersonalHome UPCOMING · NEXT 7 DAYS', () => {
  it('shows at most four events after today, within seven days, by date then time, with day labels', async () => {
    await mount('PersonalHome');
    expect(screen.getByText('UPCOMING · NEXT 7 DAYS')).toBeTruthy();
    expect(upcoming()).toHaveLength(4);
    const expectRow = (i: number, day: string, title: string, who: string) => {
      const row = upcoming()[i];
      expect(within(row).getByText(day)).toBeTruthy();
      expect(within(row).getByText(title)).toBeTruthy();
      expect(within(row).getByText(who)).toBeTruthy();
    };
    expectRow(0, 'WED 7', 'Job A site visit', 'SAM');
    expectRow(1, 'THU 8', 'Early run', 'ME');
    expectRow(2, 'THU 8', 'Dentist', 'ME');
    expectRow(3, 'FRI 9', 'Dinner at Amma’s', 'ME + SAM · PRIVATE');
    expect(screen.queryByText('Arb desk weekly review')).toBeNull(); // fifth candidate is capped out
    expect(screen.queryByText('Out of window')).toBeNull();
    expect(screen.queryByText('Yesterday lunch')).toBeNull();
  });

  it("does not label scope='shared' rows PRIVATE, and labels scope='private' partner/both rows PRIVATE", async () => {
    await mount('PersonalHome');
    expect(within(upcoming()[0]).getByText('SAM')).toBeTruthy(); // Job A site visit: shared
    expect(within(upcoming()[0]).queryByText(/PRIVATE/)).toBeNull();
    expect(within(todayRows()[0]).queryByText(/PRIVATE/)).toBeNull();
    expect(within(todayRows()[2]).getByText(/PRIVATE/)).toBeTruthy();
  });
});

describe('PersonalHome Chicago-day handling', () => {
  it('labels today from the snapshot when the device clock and zone are on another day', async () => {
    const restore = poisonDeviceZone(840); // device is on Oct 7 (UTC+14) while Chicago is still Oct 6
    try {
      jest.setSystemTime(new Date('2026-10-07T03:00:00Z'));
      await mount('PersonalHome');
      expect(screen.getByText('TUE · OCTOBER 6')).toBeTruthy();
      expect(screen.getByText('TO-DO · 6')).toBeTruthy();
      expect(screen.getByText('TODAY · 4')).toBeTruthy();
      expect(within(todoRow('Renew domain for altum.ai')).getByText('DUE TODAY')).toBeTruthy();
      expect(within(todoRow('Pay invoice')).getByText('DUE TOMORROW')).toBeTruthy();
      expect(within(upcoming()[0]).getByText('WED 7')).toBeTruthy();
    } finally {
      restore();
    }
  });
});

describe('PersonalHome states', () => {
  it('shows the unavailable line when the snapshot fails', async () => {
    server.override('household.snapshot', () => Promise.reject(rpcError('unavailable')));
    await mount('PersonalHome', {}, false);
    expect(screen.getByText('Household store unavailable')).toBeTruthy();
  });

  it('keeps the last snapshot visible when a later refresh is unavailable', async () => {
    await mount('PersonalHome');
    server.override('household.snapshot', () => Promise.reject(rpcError('unavailable')));
    await Promise.resolve(store().getState().refresh()).catch(() => undefined);
    await flush();
    expect(screen.getByText('Household store unavailable')).toBeTruthy();
    expect(todos()).toHaveLength(6);
    expect(todayRows()).toHaveLength(4);
  });

  it('never sends a mutation just by rendering', async () => {
    await mount('PersonalHome');
    await advance(10000);
    expect(mutationCalls()).toEqual([]);
    expect(callsOf('household.snapshot').length).toBeGreaterThan(0);
  });
});
