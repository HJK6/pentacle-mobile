import './mocks';
import { FORBIDDEN_OUTBOUND_KEYS, fixtureSnapshot, rpcError, sendMock } from './support';

const client = (): typeof import('../../src/services/household/householdClient') =>
  require('../../src/services/household/householdClient');

const send = () => sendMock();

beforeEach(() => {
  send().mockReset();
});

function okFrame(verb: string, extra: Record<string, unknown> = {}) {
  return { type: `${verb}.ok`, request_id: 'household-1', server_now: '2026-10-06T23:40:00Z', ...extra };
}

describe('householdClient → sendHouseholdCommand', () => {
  it('snapshot() sends household.snapshot with no month field and resolves with the whole frame', async () => {
    const s = fixtureSnapshot();
    const frame = okFrame('household.snapshot', { today: s.today, month: '2026-10', lists: s.lists, events: s.events });
    send().mockResolvedValue(frame);

    const result = await client().snapshot();

    expect(send()).toHaveBeenCalledTimes(1);
    expect(send()).toHaveBeenCalledWith('household.snapshot', {});
    expect(result).toMatchObject({ today: s.today, lists: s.lists, events: s.events, server_now: frame.server_now });
  });

  it("snapshot('YYYY-MM') sends {month} only when given", async () => {
    send().mockResolvedValue(okFrame('household.snapshot', { today: '2026-10-06', lists: {}, events: [] }));
    await client().snapshot('2026-11');
    expect(send()).toHaveBeenCalledWith('household.snapshot', { month: '2026-11' });
  });

  it('addItem sends household.item.add {list, label}', async () => {
    send().mockResolvedValue(okFrame('household.item.add', { item: { id: 9 } }));
    const result = await client().addItem('grocery', 'Limes');
    expect(send()).toHaveBeenCalledTimes(1);
    expect(send()).toHaveBeenCalledWith('household.item.add', { list: 'grocery', label: 'Limes' });
    expect(result).toMatchObject({ item: { id: 9 } });
  });

  it('doneItem sends household.item.done {item_id}', async () => {
    send().mockResolvedValue(okFrame('household.item.done', { item: { id: 7 } }));
    await client().doneItem(7);
    expect(send()).toHaveBeenCalledWith('household.item.done', { item_id: 7 });
  });

  it('removeItem sends household.item.remove {item_id}', async () => {
    send().mockResolvedValue(okFrame('household.item.remove', { item_id: 7 }));
    const result = await client().removeItem(7);
    expect(send()).toHaveBeenCalledWith('household.item.remove', { item_id: 7 });
    expect(result).toMatchObject({ item_id: 7 });
  });

  it('addEvent sends household.event.add with exactly date/time/title/who (time null = all day)', async () => {
    send().mockResolvedValue(okFrame('household.event.add', { event: { id: 5 } }));
    await client().addEvent({ date: '2026-10-08', time: '16:30', title: 'Dentist', who: 'self' });
    await client().addEvent({ date: '2026-10-09', time: null, title: 'Trip', who: 'both' });
    expect(send().mock.calls).toEqual([
      ['household.event.add', { date: '2026-10-08', time: '16:30', title: 'Dentist', who: 'self' }],
      ['household.event.add', { date: '2026-10-09', time: null, title: 'Trip', who: 'both' }],
    ]);
  });

  it('removeEvent sends household.event.remove {event_id}', async () => {
    send().mockResolvedValue(okFrame('household.event.remove', { event_id: 3 }));
    await client().removeEvent(3);
    expect(send()).toHaveBeenCalledWith('household.event.remove', { event_id: 3 });
  });

  it('never forwards scope (or priority/due_date/created_by) even if a caller smuggles them in', async () => {
    send().mockResolvedValue(okFrame('household.event.add', { event: { id: 5 } }));
    await client().addEvent({
      date: '2026-10-08', time: null, title: 'x', who: 'partner',
      scope: 'shared', priority: 'hi', due_date: '2026-10-09', created_by: 'assistant',
    } as never);
    await (client().addItem as (...a: unknown[]) => Promise<unknown>)('tasks', 'y', { scope: 'shared', priority: 'hi' });
    for (const [, fields] of send().mock.calls) {
      for (const key of FORBIDDEN_OUTBOUND_KEYS) expect(Object.keys(fields)).not.toContain(key);
    }
  });

  it('uses only the six spec verbs, none of them todo.* or v2_todo', async () => {
    send().mockResolvedValue(okFrame('x'));
    const c = client();
    await c.snapshot();
    await c.addItem('tasks', 'a');
    await c.doneItem(1);
    await c.removeItem(1);
    await c.addEvent({ date: '2026-10-06', time: null, title: 'e', who: 'self' });
    await c.removeEvent(1);
    const verbs = send().mock.calls.map((call) => call[0]);
    expect(verbs).toEqual([
      'household.snapshot',
      'household.item.add',
      'household.item.done',
      'household.item.remove',
      'household.event.add',
      'household.event.remove',
    ]);
  });

  it.each(['unavailable', 'not_found', 'forbidden', 'invalid_request', 'unknown_outcome', 'unauthorized'])(
    'a <verb>.error frame rejects with an Error carrying errorCode %s',
    async (code) => {
      send().mockRejectedValue(rpcError(code));
      const verbCalls: Array<() => Promise<unknown>> = [
        () => client().snapshot(),
        () => client().addItem('tasks', 'a'),
        () => client().doneItem(1),
        () => client().removeItem(1),
        () => client().addEvent({ date: '2026-10-06', time: null, title: 'e', who: 'self' }),
        () => client().removeEvent(1),
      ];
      for (const call of verbCalls) {
        const caught = await call().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error & { errorCode?: string }).errorCode).toBe(code);
      }
    },
  );

  it('an RPC timeout / disconnect rejection (no errorCode) rejects without an errorCode and is not retried', async () => {
    send().mockRejectedValue(new Error('RPC timeout'));
    const caught = await client().doneItem(4).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { errorCode?: string }).errorCode).toBeUndefined();
    expect(send()).toHaveBeenCalledTimes(1);
  });
});
