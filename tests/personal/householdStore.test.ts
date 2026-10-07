import './mocks';
import {
  FakeHousehold, TODAY, calls, callsOf, installServer, mutationCalls, registerOutboundGuard, rpcError, rpcTimeout,
  sendMock, snapshotCalls, unknownOutcomeFor,
} from './support';
import { NOT_SAVED_NOTICE, UNRESOLVED_NOTICE } from '../../src/services/household/householdStore';

registerOutboundGuard();

type Store = ReturnType<
  typeof import('../../src/services/household/householdStore')['useHouseholdStore']['getState']
>;

/** Fresh module registry per test so no pending-check timers or snapshot state leak between tests. */
function boot(): { server: FakeHousehold; store: () => Store } {
  jest.resetModules();
  sendMock().mockReset();
  const server = installServer(new FakeHousehold());
  const { useHouseholdStore } = require('../../src/services/household/householdStore');
  return { server, store: () => useHouseholdStore.getState() as Store };
}

const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);
/** Start an action without awaiting it (it may legitimately wait for a delayed readback). */
async function kick(run: () => unknown): Promise<void> {
  void Promise.resolve()
    .then(run)
    .catch(() => undefined);
  await advance(0);
}

beforeEach(() => {
  jest.useFakeTimers();
});

describe('refresh', () => {
  it('fetches one snapshot with no month and does not report unavailable', async () => {
    const { store } = boot();
    await store().refresh();
    expect(snapshotCalls()).toEqual([{ verb: 'household.snapshot', fields: {} }]);
    expect(store().status).not.toBe('unavailable');
  });

  it("status becomes 'unavailable' when the snapshot fails with errorCode unavailable, and recovers", async () => {
    const { store, server } = boot();
    server.override('household.snapshot', () => Promise.reject(rpcError('unavailable')));
    await Promise.resolve(store().refresh()).catch(() => undefined);
    expect(store().status).toBe('unavailable');

    server.clearOverride('household.snapshot');
    await store().refresh();
    expect(store().status).not.toBe('unavailable');
  });
});

describe('checkItem: 5 s pending then exactly one household.item.done', () => {
  it('sends nothing before 5000 ms and exactly one doneItem at 5000 ms', async () => {
    const { store } = boot();
    await store().refresh();
    store().checkItem(11);
    await advance(4999);
    expect(mutationCalls()).toEqual([]);
    await advance(1);
    expect(mutationCalls()).toEqual([{ verb: 'household.item.done', fields: { item_id: 11 } }]);
    await advance(30000);
    expect(mutationCalls().length).toBe(1);
  });

  it('a second checkItem within 5 s is an undo and sends nothing, ever', async () => {
    const { store } = boot();
    await store().refresh();
    store().checkItem(11);
    await advance(2000);
    store().checkItem(11);
    await advance(60000);
    expect(mutationCalls()).toEqual([]);
  });

  it('check → undo → check restarts the 5 s window and still sends exactly one doneItem', async () => {
    const { store } = boot();
    await store().refresh();
    store().checkItem(11);
    await advance(2000);
    store().checkItem(11); // undo
    await advance(1000);
    store().checkItem(11); // pending again, window restarts here
    await advance(4999);
    expect(mutationCalls()).toEqual([]);
    await advance(1);
    expect(mutationCalls().map((c) => c.verb)).toEqual(['household.item.done']);
  });

  it('pending checks on different items run independently', async () => {
    const { store } = boot();
    await store().refresh();
    store().checkItem(11);
    await advance(1000);
    store().checkItem(12);
    await advance(4000);
    expect(mutationCalls().map((c) => c.fields.item_id)).toEqual([11]);
    await advance(1000);
    expect(mutationCalls().map((c) => c.fields.item_id)).toEqual([11, 12]);
  });

  it('refetches the snapshot after the done mutation settles', async () => {
    const { store } = boot();
    await store().refresh();
    store().checkItem(11);
    await advance(5000);
    const all = calls();
    const at = all.findIndex((c) => c.verb === 'household.item.done');
    expect(all.slice(at + 1).some((c) => c.verb === 'household.snapshot')).toBe(true);
  });
});

describe('removeItem / addItem / addEvent / removeEvent', () => {
  it('removeItem sends one household.item.remove immediately, then refetches', async () => {
    const { store } = boot();
    await store().refresh();
    await kick(() => store().removeItem(11));
    expect(mutationCalls()).toEqual([{ verb: 'household.item.remove', fields: { item_id: 11 } }]);
    const all = calls();
    const at = all.findIndex((c) => c.verb === 'household.item.remove');
    expect(all.slice(at + 1).some((c) => c.verb === 'household.snapshot')).toBe(true);
  });

  it('addItem trims the label and sends {list, label}', async () => {
    const { store } = boot();
    await store().refresh();
    await kick(() => store().addItem('grocery', '   Mint leaves  '));
    expect(mutationCalls()).toEqual([
      { verb: 'household.item.add', fields: { list: 'grocery', label: 'Mint leaves' } },
    ]);
  });

  it.each(['', '   ', '\t\n'])('addItem ignores empty text %j', async (text) => {
    const { store } = boot();
    await store().refresh();
    await kick(() => store().addItem('grocery', text));
    expect(mutationCalls()).toEqual([]);
  });

  it('addItem ignores an exact duplicate of an open label in the same list but not in another list', async () => {
    const { store } = boot();
    await store().refresh();
    await kick(() => store().addItem('grocery', 'Oat milk'));
    expect(mutationCalls()).toEqual([]);
    await kick(() => store().addItem('tasks', 'Oat milk'));
    expect(mutationCalls()).toEqual([
      { verb: 'household.item.add', fields: { list: 'tasks', label: 'Oat milk' } },
    ]);
  });

  it('addEvent sends exactly {date, time, title, who} and removeEvent sends {event_id}', async () => {
    const { store } = boot();
    await store().refresh();
    await kick(() => store().addEvent({ date: '2026-10-08', time: '16:30', title: 'Dentist 2', who: 'both' }));
    await kick(() => store().removeEvent(102));
    expect(mutationCalls()).toEqual([
      {
        verb: 'household.event.add',
        fields: { date: '2026-10-08', time: '16:30', title: 'Dentist 2', who: 'both' },
      },
      { verb: 'household.event.remove', fields: { event_id: 102 } },
    ]);
  });
});

type Mutation = { name: string; verb: string; run: (s: Store) => void; settleMs: number };
const MUTATIONS: Mutation[] = [
  { name: 'addItem', verb: 'household.item.add', run: (s) => void s.addItem('grocery', 'Mint'), settleMs: 0 },
  { name: 'removeItem', verb: 'household.item.remove', run: (s) => void s.removeItem(11), settleMs: 0 },
  {
    name: 'addEvent',
    verb: 'household.event.add',
    run: (s) => void s.addEvent({ date: TODAY, time: null, title: 'Probe', who: 'self' }),
    settleMs: 0,
  },
  { name: 'removeEvent', verb: 'household.event.remove', run: (s) => void s.removeEvent(102), settleMs: 0 },
  {
    name: 'checkItem (after the 5 s window)',
    verb: 'household.item.done',
    run: (s) => s.checkItem(11),
    settleMs: 5000, // the done call is sent when the window ends
  },
];
const UNKNOWN_FAILURES: Array<[string, () => Error]> = [
  ['errorCode unknown_outcome', () => rpcError('unknown_outcome')],
  ['RPC timeout without errorCode', rpcTimeout],
  ['stream disconnect without errorCode', () => rpcError(undefined, 'Pentacle stream disconnected')],
];

describe('unknown outcomes: never resubmitted, immediate readback + one readback 6 s later', () => {
  describe.each(MUTATIONS)('$name', ({ verb, run, settleMs }) => {
    it.each(UNKNOWN_FAILURES)('%s → one mutation, readback now, one more at +6 s, nothing else', async (_n, makeError) => {
      const { store, server } = boot();
      await store().refresh();
      server.override(verb, unknownOutcomeFor(verb, 'never', makeError));
      const snapshotsBefore = snapshotCalls().length;

      await kick(() => run(store()));
      await advance(settleMs);
      expect(mutationCalls().map((c) => c.verb)).toEqual([verb]);
      expect(snapshotCalls().length - snapshotsBefore).toBe(1); // immediate readback

      await advance(5999);
      expect(snapshotCalls().length - snapshotsBefore).toBe(1);
      await advance(1);
      expect(snapshotCalls().length - snapshotsBefore).toBe(2); // the single delayed readback

      await advance(120000);
      expect(snapshotCalls().length - snapshotsBefore).toBe(2);
      expect(mutationCalls().map((c) => c.verb)).toEqual([verb]); // never a second mutation
    });

    it('a late commit (after the first readback) is still not resubmitted', async () => {
      const { store, server } = boot();
      await store().refresh();
      server.override(verb, unknownOutcomeFor(verb, 3000));
      await kick(() => run(store()));
      await advance(settleMs + 120000);
      expect(mutationCalls().map((c) => c.verb)).toEqual([verb]);
    });

    it('a write that committed before the response was lost is not resubmitted either', async () => {
      const { store, server } = boot();
      await store().refresh();
      server.override(verb, unknownOutcomeFor(verb, 'now'));
      await kick(() => run(store()));
      await advance(settleMs + 120000);
      expect(mutationCalls().map((c) => c.verb)).toEqual([verb]);
    });

    it('a definite failure (errorCode unavailable) is not treated as unknown: no delayed readback loop', async () => {
      const { store, server } = boot();
      await store().refresh();
      server.override(verb, () => Promise.reject(rpcError('unavailable')));
      const snapshotsBefore = snapshotCalls().length;
      await kick(() => run(store()));
      await advance(settleMs + 120000);
      expect(mutationCalls().map((c) => c.verb)).toEqual([verb]);
      expect(snapshotCalls().length - snapshotsBefore).toBeLessThanOrEqual(1);
    });
  });
});

describe('unknown outcomes: readbacks must be fresh (client QA e1f9084e)', () => {
  /** Snapshot override: the first `failures` reads reject; later reads answer normally. */
  function failingReads(server: FakeHousehold, failures: number): void {
    let left = failures;
    server.override('household.snapshot', (fields, fake) => {
      if (left > 0) {
        left -= 1;
        return Promise.reject(rpcError('unavailable'));
      }
      return fake.apply('household.snapshot', fields);
    });
  }

  it('waits the 6 s from the end of a slow immediate readback, not from its start', async () => {
    const { store, server } = boot();
    await store().refresh();
    server.override('household.item.add', unknownOutcomeFor('household.item.add', 'never'));
    let slow = true;
    server.override('household.snapshot', (fields, fake) => {
      if (!slow) return fake.apply('household.snapshot', fields);
      slow = false;
      return new Promise((resolve) => setTimeout(() => resolve(fake.apply('household.snapshot', fields)), 4000));
    });
    const before = snapshotCalls().length;
    await kick(() => store().addItem('grocery', 'Mint'));
    expect(snapshotCalls().length - before).toBe(1);
    await advance(4000 + 5999);
    expect(snapshotCalls().length - before).toBe(1);
    await advance(1);
    expect(snapshotCalls().length - before).toBe(2);
  });

  it('a committed add whose readbacks both fail is never reported Not saved from the stale snapshot', async () => {
    const { store, server } = boot();
    await store().refresh();
    server.override('household.item.add', unknownOutcomeFor('household.item.add', 'now'));
    failingReads(server, 2);
    let outcome: string | undefined;
    await kick(() => store().addItem('grocery', 'Mint').then((o) => (outcome = o)));
    await advance(6000);
    expect(outcome).toBeUndefined(); // still unresolved: the add stays busy/disabled
    expect(store().unresolved).toBe(1);
    expect(store().notice?.text).toBe(UNRESOLVED_NOTICE);
    await advance(6000); // the next successful read resolves it
    expect(outcome).toBe('saved');
    expect(store().unresolved).toBe(0);
    expect(store().notice).toBeNull();
    expect(mutationCalls().map((c) => c.verb)).toEqual(['household.item.add']);
  });

  it('an uncommitted add with failing readbacks resolves Not saved only from a successful read', async () => {
    const { store, server } = boot();
    await store().refresh();
    server.override('household.item.add', unknownOutcomeFor('household.item.add', 'never'));
    failingReads(server, 3);
    let outcome: string | undefined;
    await kick(() => store().addItem('grocery', 'Mint').then((o) => (outcome = o)));
    await advance(12000);
    expect(outcome).toBeUndefined();
    await advance(6000);
    expect(outcome).toBe('not_saved');
    expect(store().notice?.text).toBe(NOT_SAVED_NOTICE);
    expect(mutationCalls().map((c) => c.verb)).toEqual(['household.item.add']);
  });

  it('a removed row stays hidden while readbacks fail', async () => {
    const { store, server } = boot();
    await store().refresh();
    server.override('household.item.remove', unknownOutcomeFor('household.item.remove', 'never'));
    failingReads(server, 2);
    await kick(() => store().removeItem(11));
    await advance(6000);
    expect(store().hiddenItems[11]).toBe(true);
    await advance(6000);
    expect(store().hiddenItems[11]).toBeUndefined();
    expect(store().notice?.text).toBe(NOT_SAVED_NOTICE);
  });
});

describe('outbound payloads', () => {
  it('no mutation the store sends ever carries scope, priority, due_date or created_by', async () => {
    const { store } = boot();
    await store().refresh();
    await kick(() => store().addItem('tasks', 'Plain'));
    await kick(() => store().addEvent({ date: TODAY, time: '09:00', title: 'E', who: 'partner' }));
    await kick(() => store().removeItem(11));
    await kick(() => store().removeEvent(102));
    store().checkItem(12);
    await advance(5000);
    expect(mutationCalls().length).toBe(5);
    for (const c of mutationCalls()) {
      expect(Object.keys(c.fields).filter((k) => ['scope', 'priority', 'due_date', 'created_by'].includes(k))).toEqual([]);
    }
  });
});

describe('event writes are read back in their own month', () => {
  const NOVEMBER = { date: '2026-11-20', time: '10:00', title: 'Synthetic November event', who: 'self' as const };

  it('an add dated in another month is reconciled against that month (late-lost response → saved)', async () => {
    const { store, server } = boot();
    await store().refresh('2026-10');
    server.override('household.event.add', unknownOutcomeFor('household.event.add', 'now'));
    const before = snapshotCalls().length;
    let outcome: unknown;
    await kick(async () => { outcome = await store().addEvent(NOVEMBER); });
    await advance(6000);
    await advance(0);
    const readbacks = snapshotCalls().slice(before).map((c) => c.fields.month);
    expect(readbacks.length).toBeGreaterThanOrEqual(2);
    expect(readbacks.every((m) => m === '2026-11')).toBe(true);
    expect(outcome).toBe('saved');
    expect(store().month).toBe('2026-11');
    expect(store().notice?.text).not.toBe(NOT_SAVED_NOTICE);
  });

  it('a confirmed add dated in another month is read back in that month', async () => {
    const { store } = boot();
    await store().refresh('2026-10');
    const before = snapshotCalls().length;
    await expect(store().addEvent(NOVEMBER)).resolves.toBe('ok');
    expect(snapshotCalls().slice(before).map((c) => c.fields.month)).toEqual(['2026-11']);
    expect(store().snapshot?.events.some((e) => e.title === NOVEMBER.title)).toBe(true);
  });

  it('a remove keeps reading its event month even if the shown month changes while unresolved', async () => {
    const { store, server } = boot();
    await store().refresh('2026-11');
    await store().addEvent(NOVEMBER);
    const target = store().snapshot!.events.find((e) => e.title === NOVEMBER.title)!;
    server.override('household.event.remove', unknownOutcomeFor('household.event.remove', 'never'));
    let outcome: unknown;
    await kick(async () => { outcome = await store().removeEvent(target.id); });
    await store().refresh('2026-10');
    const before = snapshotCalls().length;
    await advance(6000);
    await advance(0);
    expect(snapshotCalls().slice(before).map((c) => c.fields.month)).toEqual(['2026-11']);
    expect(outcome).toBe('not_saved');
    expect(callsOf('household.event.remove')).toHaveLength(1);
  });
});

describe('a superseded snapshot never overwrites a newer one (QA a0dd198b)', () => {
  const NOVEMBER = { date: '2026-11-20', time: '10:00', title: 'Synthetic November event', who: 'self' as const };

  it('an October refresh that resolves after a November save leaves the November snapshot in place', async () => {
    const { store, server } = boot();
    await store().refresh('2026-10');
    let release: () => void = () => undefined;
    server.override('household.snapshot', (fields, srv) => {
      if (fields.month !== '2026-10') return srv.apply('household.snapshot', fields);
      srv.clearOverride('household.snapshot');
      return new Promise((resolve) => { release = () => resolve(srv.apply('household.snapshot', fields)); });
    });
    await kick(() => store().refresh('2026-10')); // held in flight
    await expect(store().addEvent(NOVEMBER)).resolves.toBe('ok');
    expect(store().snapshot?.month).toBe('2026-11');
    release();
    await advance(0);
    expect(store().month).toBe('2026-11');
    expect(store().snapshot?.month).toBe('2026-11');
    expect(store().snapshot?.events.some((e) => e.title === NOVEMBER.title)).toBe(true);
  });

  it('of two reads of the same month, a late older response does not replace the newer one', async () => {
    const { store, server } = boot();
    await store().refresh('2026-10');
    let release: () => void = () => undefined;
    server.override('household.snapshot', (fields, srv) => {
      srv.clearOverride('household.snapshot');
      const stale = srv.apply('household.snapshot', fields);
      return new Promise((resolve) => { release = () => resolve(stale); });
    });
    await kick(() => store().refresh('2026-10')); // older read, held with the pre-add rows
    await store().addEvent({ ...NOVEMBER, date: '2026-10-20', title: 'Synthetic October add' });
    expect(store().snapshot?.events.some((e) => e.title === 'Synthetic October add')).toBe(true);
    release();
    await advance(0);
    expect(store().snapshot?.events.some((e) => e.title === 'Synthetic October add')).toBe(true);
  });

  it('a superseded read that fails does not mark the store unavailable', async () => {
    const { store, server } = boot();
    await store().refresh('2026-10');
    let fail: () => void = () => undefined;
    server.override('household.snapshot', (_fields, srv) => {
      srv.clearOverride('household.snapshot');
      return new Promise((_resolve, reject) => { fail = () => reject(rpcError('unavailable')); });
    });
    await kick(() => store().refresh('2026-10'));
    await store().refresh('2026-11');
    fail();
    await advance(0);
    expect(store().status).toBe('ready');
    expect(store().snapshot?.month).toBe('2026-11');
  });
});
