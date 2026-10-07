import type { HouseholdEvent, HouseholdItem, HouseholdSnapshot, ListId } from '../../src/services/household/types';
import { TODAY, emptyLists, event, fixtureSnapshot, item, poisonDeviceZone } from './support';

// Lazy so a missing module fails each test (RED) rather than the whole suite at import.
const sel = (): typeof import('../../src/services/household/selectors') =>
  require('../../src/services/household/selectors');

const snap = (over: Partial<HouseholdSnapshot> = {}): HouseholdSnapshot => ({
  ...fixtureSnapshot(),
  ...over,
});
type Critical = { list: ListId; item: HouseholdItem };
const tasksItem = (over: Partial<HouseholdItem> & { id: number }): HouseholdItem =>
  item({ list: 'tasks', label: `item ${over.id}`, ...over });

describe('LIST_ORDER / LIST_META', () => {
  it('orders lists To-do, Grocery, Meals, Chores, Study plan', () => {
    expect(sel().LIST_ORDER).toEqual(['tasks', 'grocery', 'meals', 'chores', 'study']);
  });

  it('carries the design names and placeholders', () => {
    const m = sel().LIST_META;
    expect(m.tasks).toMatchObject({ name: 'To-do', placeholder: 'New task…' });
    expect(m.grocery).toMatchObject({ name: 'Grocery', placeholder: 'Add an item…' });
    expect(m.meals).toMatchObject({ name: 'Meals', placeholder: 'Add a meal…' });
    expect(m.chores).toMatchObject({ name: 'Chores', placeholder: 'Add a chore…' });
    expect(m.study).toMatchObject({ name: 'Study plan', placeholder: 'Add a study block…' });
  });
});

describe('sortItems (priority hi → med → lo, then position, then id)', () => {
  it('sorts by priority first and Cosmo order second', () => {
    const items = [
      tasksItem({ id: 1, priority: 'lo', position: 1 }),
      tasksItem({ id: 2, priority: 'med', position: 5 }),
      tasksItem({ id: 3, priority: 'hi', position: 9 }),
      tasksItem({ id: 4, priority: 'med', position: 2 }),
      tasksItem({ id: 5, priority: 'hi', position: 3 }),
    ];
    expect(sel().sortItems(items).map((i: HouseholdItem) => i.id)).toEqual([5, 3, 4, 2, 1]);
  });

  it('breaks position ties by id and does not mutate its input', () => {
    const items = [
      tasksItem({ id: 9, position: 1 }),
      tasksItem({ id: 7, position: 1 }),
      tasksItem({ id: 8, position: 1 }),
    ];
    const before = items.map((i: HouseholdItem) => i.id);
    expect(sel().sortItems(items).map((i: HouseholdItem) => i.id)).toEqual([7, 8, 9]);
    expect(items.map((i: HouseholdItem) => i.id)).toEqual(before);
  });
});

describe('itemTags (due tag first, then HIGH/LOW)', () => {
  const tags = (over: Partial<HouseholdItem>, today = TODAY) =>
    sel().itemTags(tasksItem({ id: 1, ...over }), today);

  it('flags a past due date as OVERDUE in red (routine occurrences stay overdue)', () => {
    expect(tags({ due_date: '2026-10-05' })).toEqual([{ text: 'OVERDUE', tone: 'red' }]);
    expect(tags({ due_date: '2026-09-01', routine_id: 7 })).toEqual([{ text: 'OVERDUE', tone: 'red' }]);
  });

  it('tags today red, tomorrow amber, later dates amber with the month and day', () => {
    expect(tags({ due_date: TODAY })).toEqual([{ text: 'DUE TODAY', tone: 'red' }]);
    expect(tags({ due_date: '2026-10-07' })).toEqual([{ text: 'DUE TOMORROW', tone: 'amber' }]);
    expect(tags({ due_date: '2026-10-20' })).toEqual([{ text: 'DUE OCT 20', tone: 'amber' }]);
    expect(tags({ due_date: '2026-11-03' })).toEqual([{ text: 'DUE NOV 3', tone: 'amber' }]);
  });

  it('computes tomorrow across month, year and leap-day boundaries', () => {
    expect(tags({ due_date: '2026-11-01' }, '2026-10-31')).toEqual([{ text: 'DUE TOMORROW', tone: 'amber' }]);
    expect(tags({ due_date: '2027-01-01' }, '2026-12-31')).toEqual([{ text: 'DUE TOMORROW', tone: 'amber' }]);
    expect(tags({ due_date: '2028-02-29' }, '2028-02-28')).toEqual([{ text: 'DUE TOMORROW', tone: 'amber' }]);
    expect(tags({ due_date: '2028-03-01' }, '2028-02-28')).toEqual([{ text: 'DUE MAR 1', tone: 'amber' }]);
  });

  it('adds HIGH amber / LOW muted from priority and nothing for undated med', () => {
    expect(tags({ priority: 'hi' })).toEqual([{ text: 'HIGH', tone: 'amber' }]);
    expect(tags({ priority: 'lo' })).toEqual([{ text: 'LOW', tone: 'muted' }]);
    expect(tags({ priority: 'med' })).toEqual([]);
  });

  it('puts the due tag before the priority tag', () => {
    expect(tags({ due_date: TODAY, priority: 'hi' })).toEqual([
      { text: 'DUE TODAY', tone: 'red' },
      { text: 'HIGH', tone: 'amber' },
    ]);
    expect(tags({ due_date: '2026-10-20', priority: 'lo' })).toEqual([
      { text: 'DUE OCT 20', tone: 'amber' },
      { text: 'LOW', tone: 'muted' },
    ]);
  });
});

describe('showItemLamp (actual attribution only)', () => {
  it('shows the lamp only for created_by bart', () => {
    expect(sel().showItemLamp(tasksItem({ id: 1, created_by: 'assistant' }))).toBe(true);
    expect(sel().showItemLamp(tasksItem({ id: 2, created_by: 'app' }))).toBe(false);
    expect(sel().showItemLamp(tasksItem({ id: 3, created_by: 'partner_assistant' }))).toBe(false);
  });

  it('does not infer Bart from due/priority metadata (partner-assistant-created shared item with due + hi)', () => {
    const partnerItem = tasksItem({ id: 4, created_by: 'partner_assistant', scope: 'shared', priority: 'hi', due_date: '2026-10-20' });
    expect(sel().showItemLamp(partnerItem)).toBe(false);
    expect(sel().itemTags(partnerItem, TODAY).length).toBe(2);
  });
});

describe('criticalItems', () => {
  it('returns hi-priority or due ≤ tomorrow (overdue included) across lists in list then detail order', () => {
    const got = sel().criticalItems(fixtureSnapshot());
    expect(got.map((c: Critical) => [c.list, c.item.id])).toEqual([
      ['tasks', 2], // hi
      ['tasks', 4], // hi, partner-assistant-created
      ['tasks', 1], // due today
      ['tasks', 6], // due tomorrow
      ['grocery', 10], // due today
      ['chores', 20], // overdue routine occurrence
    ]);
  });

  it('excludes undated med/lo items and items due after tomorrow', () => {
    const ids = sel().criticalItems(fixtureSnapshot()).map((c: Critical) => c.item.id);
    expect(ids).not.toContain(3); // undated med
    expect(ids).not.toContain(5); // lo, undated
    expect(ids).not.toContain(11);
  });

  it('keeps the list order To-do, Grocery, Meals, Chores, Study plan', () => {
    const lists = emptyLists();
    lists.study = [item({ id: 90, list: 'study', label: 's', priority: 'hi' })];
    lists.chores = [item({ id: 91, list: 'chores', label: 'c', priority: 'hi' })];
    lists.meals = [item({ id: 92, list: 'meals', label: 'm', priority: 'hi' })];
    lists.grocery = [item({ id: 93, list: 'grocery', label: 'g', priority: 'hi' })];
    lists.tasks = [item({ id: 94, list: 'tasks', label: 't', priority: 'hi' })];
    const got = sel().criticalItems(snap({ lists }));
    expect(got.map((c: Critical) => c.list)).toEqual(['tasks', 'grocery', 'meals', 'chores', 'study']);
  });

  it('uses snapshot.today (not the device clock) for the due ≤ tomorrow window', () => {
    const lists = emptyLists();
    lists.tasks = [
      item({ id: 1, list: 'tasks', label: 'a', due_date: '2026-11-01' }),
      item({ id: 2, list: 'tasks', label: 'b', due_date: '2026-11-02' }),
    ];
    const got = sel().criticalItems(snap({ today: '2026-10-31', lists }));
    expect(got.map((c: Critical) => c.item.id)).toEqual([1]);
  });
});

describe('whoDisplay (viewer-relative; scope only adds the PRIVATE suffix)', () => {
  const who = (over: Partial<HouseholdEvent>) =>
    sel().whoDisplay(event({ id: 1, date: TODAY, title: 'x', ...over }), 'Sam');

  it('labels self ME, partner SAM, both ME + SAM with matching bars', () => {
    expect(who({ who: 'self', scope: 'shared' })).toEqual({ label: 'ME', bars: ['me'] });
    expect(who({ who: 'partner', scope: 'shared' })).toEqual({ label: 'SAM', bars: ['partner'] });
    expect(who({ who: 'both', scope: 'shared' })).toEqual({ label: 'ME + SAM', bars: ['me', 'partner'] });
  });

  it("appends ' · PRIVATE' when scope is private and who is partner or both", () => {
    expect(who({ who: 'partner', scope: 'private' })).toEqual({ label: 'SAM · PRIVATE', bars: ['partner'] });
    expect(who({ who: 'both', scope: 'private' })).toEqual({
      label: 'ME + SAM · PRIVATE',
      bars: ['me', 'partner'],
    });
  });

  it('never marks Me-only events private, and never marks shared rows private', () => {
    expect(who({ who: 'self', scope: 'private' }).label).toBe('ME');
    expect(who({ who: 'partner', scope: 'shared' }).label).not.toMatch(/PRIVATE/);
    expect(who({ who: 'both', scope: 'shared' }).label).not.toMatch(/PRIVATE/);
  });
});

describe('partnerName', () => {
  it('uses the snapshot display name and falls back to Partner', () => {
    expect(sel().partnerName(fixtureSnapshot())).toBe('Sam');
    expect(sel().partnerName({ ...fixtureSnapshot(), people: undefined })).toBe('Partner');
    expect(sel().partnerName(null)).toBe('Partner');
    expect(sel().whoDisplay(event({ id: 1, date: TODAY, title: 'x', who: 'partner', scope: 'shared' })).label).toBe('PARTNER');
  });
});

describe('isBartEvent', () => {
  it('is true only for created_by bart', () => {
    expect(sel().isBartEvent(event({ id: 1, date: TODAY, title: 'a', created_by: 'assistant' }))).toBe(true);
    expect(sel().isBartEvent(event({ id: 2, date: TODAY, title: 'b', created_by: 'app' }))).toBe(false);
    expect(sel().isBartEvent(event({ id: 3, date: TODAY, title: 'c', created_by: 'partner_assistant' }))).toBe(false);
  });
});

describe('todayEvents / upcomingEvents', () => {
  it("returns only snapshot.today's events, all-day first then by time", () => {
    expect(sel().todayEvents(fixtureSnapshot()).map((e: HouseholdEvent) => e.id)).toEqual([101, 102, 103, 104]);
  });

  it('sorts times numerically as 24 h text, not by insertion order', () => {
    const events = [
      event({ id: 1, date: TODAY, time: '14:30', title: 'pm' }),
      event({ id: 2, date: TODAY, time: '09:05', title: 'am' }),
      event({ id: 3, date: TODAY, time: '00:00', title: 'midnight' }),
    ];
    expect(sel().todayEvents(snap({ events })).map((e: HouseholdEvent) => e.id)).toEqual([3, 2, 1]);
  });

  it('upcoming is today < date ≤ today+7, sorted date then time, capped at 4', () => {
    const got = sel().upcomingEvents(fixtureSnapshot());
    expect(got.map((e: HouseholdEvent) => e.id)).toEqual([106, 108, 107, 109]);
    expect(got.length).toBeLessThanOrEqual(4);
  });

  it('excludes today, yesterday and anything beyond today+7', () => {
    const ids = sel().upcomingEvents(fixtureSnapshot()).map((e: HouseholdEvent) => e.id);
    for (const excluded of [101, 102, 105, 110, 111, 112]) expect(ids).not.toContain(excluded);
  });

  it('sorts an all-day upcoming event before timed events on the same date', () => {
    const events = [
      event({ id: 1, date: '2026-10-07', time: '11:00', title: 'timed' }),
      event({ id: 2, date: '2026-10-07', time: null, title: 'all day' }),
    ];
    expect(sel().upcomingEvents(snap({ events })).map((e: HouseholdEvent) => e.id)).toEqual([2, 1]);
  });

  it('computes the +7 window across a month boundary from snapshot.today', () => {
    const events = [
      event({ id: 1, date: '2026-11-04', time: '10:00', title: 'in' }),
      event({ id: 2, date: '2026-11-05', time: '10:00', title: 'out' }),
    ];
    expect(sel().upcomingEvents(snap({ today: '2026-10-28', events })).map((e: HouseholdEvent) => e.id)).toEqual([1]);
  });
});

describe('formatTime', () => {
  it.each([
    ['14:30', '2:30p'],
    ['09:05', '9:05a'],
    ['00:00', '12:00a'],
    ['12:00', '12:00p'],
    ['12:30', '12:30p'],
    ['01:00', '1:00a'],
    ['23:59', '11:59p'],
    [null, 'ALL DAY'],
  ])('formats %s as %s', (input, expected) => {
    expect(sel().formatTime(input as string | null)).toBe(expected);
  });
});

describe('parseTimeInput', () => {
  it.each([
    ['', null],
    ['4:30', '04:30'],
    ['04:30', '04:30'],
    ['16:30', '16:30'],
    ['0:00', '00:00'],
    ['23:59', '23:59'],
    ['4:30p', '16:30'],
    ['4:30 pm', '16:30'],
    ['9:05a', '09:05'],
    ['12:15am', '00:15'],
    ['12:15pm', '12:15'],
  ])('accepts %j as %j', (text, value) => {
    expect(sel().parseTimeInput(text)).toEqual({ ok: true, value });
  });

  it.each(['25:00', '4:3', 'abc', '12:60', '4', '4:30x', '13:00pm'])('rejects %j', (text) => {
    expect(sel().parseTimeInput(text)).toEqual({ ok: false });
  });
});

describe('parseRouteDate', () => {
  it.each(['2026-10-06', '2026-11-15', '2028-02-29', '2000-01-01', '2100-12-31'])('accepts %s', (d) => {
    expect(sel().parseRouteDate(d)).toBe(d);
  });

  it.each([
    undefined,
    '',
    'garbage',
    '2026-13-01',
    '2026-02-30',
    '2027-02-29',
    '2026-10-6',
    '2026-10-06T00:00:00',
    '10/06/2026',
    '1999-12-31',
    '2101-01-01',
    '0000-01-01',
    '9999-12-31',
  ])('ignores %j (null → today is used, no request)', (d) => {
    expect(sel().parseRouteDate(d as string | undefined)).toBeNull();
  });
});

describe('monthOf / personalHeaderLabel / whoFromToggles', () => {
  it('monthOf returns YYYY-MM', () => {
    expect(sel().monthOf('2026-10-06')).toBe('2026-10');
    expect(sel().monthOf('2100-12-31')).toBe('2100-12');
  });

  it('personalHeaderLabel renders DOW · MONTH D from the given day', () => {
    expect(sel().personalHeaderLabel('2026-10-06')).toBe('TUE · OCTOBER 6');
    expect(sel().personalHeaderLabel('2026-10-31')).toBe('SAT · OCTOBER 31');
    expect(sel().personalHeaderLabel('2027-01-01')).toBe('FRI · JANUARY 1');
  });

  it('whoFromToggles maps Me → self, partner → partner, both → both', () => {
    expect(sel().whoFromToggles({ me: true, partner: false })).toBe('self');
    expect(sel().whoFromToggles({ me: false, partner: true })).toBe('partner');
    expect(sel().whoFromToggles({ me: true, partner: true })).toBe('both');
  });
});

describe('device timezone independence (Chicago days come from the snapshot, never the phone zone)', () => {
  // +14:00 (Pacific/Kiritimati) and −12:00: both flip the calendar day around a Chicago evening.
  it.each([840, -720])('gives identical results with the device zone skewed by %i minutes', (offset) => {
    const run = () => {
      const s = fixtureSnapshot();
      const m = sel();
      return {
        header: m.personalHeaderLabel(s.today),
        month: m.monthOf(s.today),
        tags: m.criticalItems(s).map((c: Critical) => [c.item.id, m.itemTags(c.item, s.today)]),
        today: m.todayEvents(s).map((e: HouseholdEvent) => e.id),
        upcoming: m.upcomingEvents(s).map((e: HouseholdEvent) => e.id),
        routes: ['2026-10-06', '2000-01-01', '2100-12-31', '1999-12-31', '2101-01-01', 'x'].map((d) =>
          m.parseRouteDate(d),
        ),
        time: m.formatTime('14:30'),
      };
    };
    const baseline = run();
    const restore = poisonDeviceZone(offset);
    let skewed: ReturnType<typeof run>;
    try {
      skewed = run();
    } finally {
      restore();
    }
    expect(skewed).toEqual(baseline);
    expect(baseline.header).toBe('TUE · OCTOBER 6');
  });
});

describe('month paging helpers', () => {
  it('shiftMonth crosses year boundaries and clamps to 2000-01 … 2100-12', () => {
    expect(sel().shiftMonth('2026-10', 1)).toBe('2026-11');
    expect(sel().shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(sel().shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(sel().shiftMonth('2000-01', -1)).toBe('2000-01');
    expect(sel().shiftMonth('2100-12', 1)).toBe('2100-12');
  });

  it('selectionForMonth picks today in today’s month and the 1st elsewhere', () => {
    expect(sel().selectionForMonth('2026-10', '2026-10-06')).toBe('2026-10-06');
    expect(sel().selectionForMonth('2026-11', '2026-10-06')).toBe('2026-11-01');
    expect(sel().selectionForMonth('2025-10', '2026-10-06')).toBe('2025-10-01');
  });

  it('dateFieldLabel reads DOW MON D and appends the year only when it differs from today’s', () => {
    expect(sel().dateFieldLabel('2026-10-06', '2026-10-06')).toBe('TUE OCT 6');
    expect(sel().dateFieldLabel('2026-11-20', '2026-10-06')).toBe('FRI NOV 20');
    expect(sel().dateFieldLabel('2027-01-05', '2026-10-06')).toBe('TUE JAN 5, 2027');
  });
});
