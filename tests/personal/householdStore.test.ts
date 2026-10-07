import './mocks';
import {
  FakeHousehold, TODAY, calls, installServer, mutationCalls, registerOutboundGuard, rpcError, rpcTimeout,
  sendMock, snapshotCalls, unknownOutcomeFor,
} from './support';

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
