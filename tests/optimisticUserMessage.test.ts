jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import { applyPentacleEvent, initialPentacleStreamState } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary } from 'pentacle-chat-core';

type MockSocketEvent = { data?: string };

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MockSocketEvent) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeFromServer() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function loadStream() {
  jest.resetModules();
  MockWebSocket.instances = [];
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-05-13T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function serverEvent(streamId: string, overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    daemon_seq: 10,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp: new Date(Date.now()).toISOString(),
    kind: 'USER',
    text: 'hello',
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

test('optimistic user messages get unique same-millisecond ids within and across streams', () => {
  const stream = loadStream();

  const one = stream.appendOptimisticUserMessage('hostc:codex:same', 'first');
  const two = stream.appendOptimisticUserMessage('hostc:codex:same', 'second');
  const three = stream.appendOptimisticUserMessage('hostb:codex:same', 'third');

  const firstMatch = one.match(/^optimistic_hostc_codex_same_(launch-\d+-[a-z0-9]{6})_1$/);
  expect(firstMatch).not.toBeNull();
  const launchNamespace = firstMatch?.[1];
  expect(two).toBe(`optimistic_hostc_codex_same_${launchNamespace}_2`);
  expect(three).toBe(`optimistic_hostb_codex_same_${launchNamespace}_1`);
  expect(new Set([one, two, three]).size).toBe(3);
});

test('cold relaunch avoids an unresolved daemon optimistic-id reservation', () => {
  const random = jest.spyOn(Math, 'random')
    .mockReturnValueOnce(0.1)
    .mockReturnValueOnce(0.2)
    .mockReturnValueOnce(0.3)
    .mockReturnValueOnce(0.4);
  const unresolved = new Set<string>();
  const claim = (optimisticId: string) => {
    if (unresolved.has(optimisticId)) return 'optimistic_id_conflict';
    unresolved.add(optimisticId);
    return 'delivered';
  };

  try {
    const firstLaunch = loadStream();
    const reservedId = firstLaunch.appendOptimisticUserMessage('hostc:codex:relaunch', 'first');
    expect(claim(reservedId)).toBe('delivered');

    const secondLaunch = loadStream();
    const relaunchedId = secondLaunch.appendOptimisticUserMessage('hostc:codex:relaunch', 'second');
    expect(claim(relaunchedId)).toBe('delivered');
    expect(relaunchedId).not.toBe(reservedId);
  } finally {
    random.mockRestore();
  }
});

test('reducer preserves optimistic events through unrelated event applies', () => {
  const optimistic = serverEvent('hostc:codex:one', {
    daemon_seq: Number.NaN,
    text: 'queued',
    client_origin: true,
    optimistic_id: 'optimistic_hostc_codex_one_1',
    pending: true,
    created_at: Date.now(),
  });
  const state = applyPentacleEvent(initialPentacleStreamState, optimistic);
  const next = applyPentacleEvent(state, serverEvent('hostc:codex:one', {
    daemon_seq: 11,
    kind: 'ASSIST_TEXT',
    text: 'working',
  }));

  expect(next.events.map((event) => event.optimistic_id).filter(Boolean)).toEqual([
    'optimistic_hostc_codex_one_1',
  ]);
  expect(next.events.some((event) => event.kind === 'ASSIST_TEXT')).toBe(true);
});

test('matching server USER reconciles optimistic bubble and unmatched USER is preserved', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [session('hostc:codex:one')] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'hello');
  expect(stream.getPentacleStreamState().events.some((event) => event.optimistic_id === optimisticId)).toBe(true);

  socket.message({
    type: 'chat.event',
    event: serverEvent('hostc:codex:one', { daemon_seq: 20, text: 'hello' }),
  });

  expect(stream.getPentacleStreamState().events).toHaveLength(1);
  expect(stream.getPentacleStreamState().events[0]).toMatchObject({
    correlatedDaemonSeq: 20,
    optimistic_id: optimisticId,
    pending: false,
  });

  socket.message({
    type: 'chat.event',
    event: serverEvent('hostc:codex:one', { daemon_seq: 21, text: 'different echo' }),
  });
  expect(stream.getPentacleStreamState().events.map((event) => event.text)).toEqual(['hello', 'different echo']);

  unsubscribe();
});

test('FEAT-SEND-NO-FALSE-FAILED: §A transport-cut survivors stay dispatched (not falsely failed) and auto-replay; a matched stamped echo reconciles, an unechoed one stays dispatched within the replay window', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const first = MockWebSocket.instances[0];
  first.open();
  first.message({
    type: 'session.inventory',
    sessions: [session('hostc:codex:one'), session('hostc:codex:two')],
  });

  const matchedId = stream.appendOptimisticUserMessage('hostc:codex:one', 'match me');
  const strandedId = stream.appendOptimisticUserMessage('hostc:codex:two', 'strand me');
  const sendOne = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'match me' });
  const sendTwo = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'two', text: 'strand me' });

  first.closeFromServer();
  await expect(sendOne).rejects.toThrow('disconnected');
  await expect(sendTwo).rejects.toThrow('disconnected');
  // §A: the RPC promises reject on the transport-cut, but the optimistic rows stay PENDING
  // (dispatched, not falsely failed) — they auto-replay on reconnect rather than resolving to a
  // failed terminal here.
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === matchedId)?.pending).toBe(true);
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === strandedId)?.pending).toBe(true);

  jest.advanceTimersByTime(1000);
  const second = MockWebSocket.instances[1];
  second.open();
  second.message({
    type: 'snapshot',
    sessions: [session('hostc:codex:one'), session('hostc:codex:two')],
    events: [
      serverEvent('hostc:codex:one', {
        daemon_seq: 30,
        text: 'match me',
        optimistic_id: matchedId,
        timestamp: new Date(Date.now()).toISOString(),
      }),
    ],
  });

  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === matchedId)).toMatchObject({
    correlatedDaemonSeq: 30,
    pending: false,
  });
  // §A: the stranded survivor was replayed but not yet echoed, so it stays pending (in-flight),
  // not resolved — it is not falsely failed and will reconcile on its own echo or expire later.
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === strandedId)?.pending).toBe(true);

  jest.advanceTimersByTime(60_000);
  second.message({ type: 'session.inventory', sessions: [session('hostc:codex:one'), session('hostc:codex:two')] });
  // §A: the unechoed transport-cut survivor was auto-replayed on reconnect (same request_id) and
  // stays 'dispatched' within the 30-min replay window — NOT falsely 'failed'. It becomes visibly
  // recoverable only on window expiry / owner-lost, not at 60s.
  expect(stream.getPentacleStreamState().optimisticSends?.[strandedId]).toMatchObject({
    status: 'dispatched',
  });

  unsubscribe();
});
