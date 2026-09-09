import {
  applySnapshotWithOptimisticReconciliation,
  initialPentacleStreamState,
  markOptimisticDispatchedByRequestId,
  markOptimisticFailedByOptimisticId,
  markOptimisticIndeterminateByRequestId,
  onReconnect,
  sendOptimisticMessage,
} from 'pentacle-chat-core';
import type {
  OptimisticSendStatus,
  PentacleEvent,
  PentacleSessionSummary,
  PentacleStreamState,
} from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('expo-notifications', () => ({}));

const STREAM_ID = 'hostc:codex:one';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_one_1';
const REQUEST_ID = 'send-req-1';
const CREATED_AT = Date.parse('2026-05-16T12:00:00.000Z');
const GEN = 7;
const NEXT_GEN = 8;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeFromServer(code = 1006, reason = 'network_drop') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
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

function connectedTransport() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [session()] });
  return { stream, unsubscribe, socket };
}

function beginPendingSend(
  stream: typeof import('../src/services/pentacleStream'),
  text: string,
) {
  const optimisticId = stream.appendOptimisticUserMessage(STREAM_ID, text);
  const settled = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text })
    .then(() => 'resolved', () => 'rejected');
  return { optimisticId, settled };
}

function reconnectSocket() {
  jest.advanceTimersByTime(1_000);
  const socket = MockWebSocket.instances.at(-1) as MockWebSocket;
  socket.open();
  return socket;
}

function sendFrames(socket: MockWebSocket) {
  return socket.sent.map((item) => JSON.parse(item)).filter((item) => item.type === 'send');
}

function receiptFrames(socket: MockWebSocket) {
  return socket.sent.map((item) => JSON.parse(item)).filter((item) => item.type === 'send.receipt.get');
}

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    last_event_at: '2026-05-16T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return {
    ...initialPentacleStreamState,
    connected: true,
    sessions: [session()],
    ...overrides,
  };
}

function optimisticState(status: OptimisticSendStatus, gen = GEN, queuedAt?: number): PentacleStreamState {
  const queued = sendOptimisticMessage(buildState(), {
    streamId: STREAM_ID,
    text: 'hello',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    queuedAt,
    windowStartedAt: CREATED_AT,
    socketGeneration: gen,
  });
  if (status === 'queued') return queued;
  if (status === 'dispatched') {
    return markOptimisticDispatchedByRequestId(queued, REQUEST_ID, CREATED_AT + 10, gen);
  }
  if (status === 'failed') {
    return markOptimisticFailedByOptimisticId(queued, OPTIMISTIC_ID, 'send_error', CREATED_AT + 20);
  }
  return {
    ...queued,
    optimisticSends: {
      [OPTIMISTIC_ID]: {
        ...queued.optimisticSends![OPTIMISTIC_ID],
        status,
      },
    },
  };
}

function serverUserEvent(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 42,
    host: 'hostc',
    provider: 'codex',
    session_id: STREAM_ID,
    session_name: 'one',
    stream_id: STREAM_ID,
    timestamp: '2026-05-16T12:00:01.000Z',
    kind: 'USER',
    text: 'hello',
    ...overrides,
  };
}

function snapshot(events: PentacleEvent[] = []) {
  return {
    sessions: [session()],
    events,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: CREATED_AT + 1_000 });
});

afterEach(() => {
  jest.clearAllTimers();
});

test.each<OptimisticSendStatus>([
  'queued',
  'dispatched',
  'acked',
  'indeterminate',
])('onReconnect preserves %s survivor status and retargets it to the new socket generation', (status) => {
  const state = optimisticState(status);
  const next = onReconnect(state, GEN, CREATED_AT + 5_000, NEXT_GEN);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status,
    reconnect_count: 1,
    window_started_at: CREATED_AT + 5_000,
    socket_generation: NEXT_GEN,
  });
});

test.each<OptimisticSendStatus>([
  'echoed',
  'reconciled',
  'failed',
])('onReconnect leaves terminal %s entries unchanged', (status) => {
  const state = optimisticState(status);
  const next = onReconnect(state, GEN, CREATED_AT + 5_000, NEXT_GEN);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toBe(state.optimisticSends?.[OPTIMISTIC_ID]);
});

test('onReconnect does not touch optimistic entries from a stale socket generation', () => {
  const state = optimisticState('queued', GEN - 1);
  const next = onReconnect(state, GEN, CREATED_AT + 5_000, NEXT_GEN);

  expect(next).toBe(state);
  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status: 'queued',
    reconnect_count: 0,
    socket_generation: GEN - 1,
  });
});

test('onReconnect preserves queued origin while retargeting a survivor', () => {
  const state = optimisticState('dispatched', GEN, CREATED_AT);
  const next = onReconnect(state, GEN, CREATED_AT + 5_000, NEXT_GEN);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    queued_at: CREATED_AT,
    socket_generation: NEXT_GEN,
    reconnect_count: 1,
  });
});

test('reconnect boundary dispatches a never-on-wire send once', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const first = MockWebSocket.instances[0];
  first.open();
  first.message({ type: 'session.inventory', sessions: [session()] });

  const optimisticId = stream.sendTurn(STREAM_ID, 'hello');
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('queued');

  first.closeFromServer();
  await expect(stream.sendPentacleMessage({
    host: 'hostc',
    sessionName: 'one',
    text: 'hello',
    optimisticId,
  })).rejects.toThrow('not connected');
  jest.advanceTimersByTime(1000);
  const second = MockWebSocket.instances[1];
  second.open();

  const neverOnWire = sendFrames(second);
  expect(neverOnWire).toEqual([expect.objectContaining({
    optimistic_id: optimisticId,
    request_id: stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.request_id,
  })]);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'dispatched',
    socket_generation: 3,
  });

  unsubscribe();
});

test('reconnect boundary receipt-reconciles an on-wire unconfirmed send without a duplicate', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const first = MockWebSocket.instances[0];
  first.open();
  first.message({ type: 'session.inventory', sessions: [session()] });

  const optimisticId = stream.sendTurn(STREAM_ID, 'hello');
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, optimisticId);
  const firstSend = first.sent.map((item) => JSON.parse(item)).find((frame) => frame.type === 'send');
  expect(firstSend).toBeTruthy();
  const originalRequestId = firstSend.request_id as string;
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');

  first.closeFromServer();
  jest.advanceTimersByTime(1000);
  const second = MockWebSocket.instances[1];
  second.open();

  expect(sendFrames(second)).toHaveLength(0);
  expect(receiptFrames(second)).toEqual([expect.objectContaining({
    to_stream_id: STREAM_ID,
    request_id: originalRequestId,
  })]);

  unsubscribe();
});

describe('send recovery failure-injection matrix', () => {
  test('half-open socket at send time keeps the dispatched survivor pending for receipt reconciliation', async () => {
    const { stream, unsubscribe, socket } = connectedTransport();
    stream.__handlePentacleAppStateChangeForTests('active');
    const unregister = stream.registerFocusedPentacleStream(STREAM_ID);
    socket.message({ type: 'pong' });
    jest.advanceTimersByTime(500);
    const { optimisticId, settled } = beginPendingSend(stream, 'half-open send');
    const originalRequestId = sendFrames(socket)[0]?.request_id as string;

    expect(stream.requestFocusedPentacleLivenessProbe('send')).toBe(true);
    jest.advanceTimersByTime(1_000);
    expect(await settled).toBe('rejected');
    const recovered = reconnectSocket();

    expect(sendFrames(recovered)).toHaveLength(0);
    expect(receiptFrames(recovered)).toEqual([expect.objectContaining({ request_id: originalRequestId })]);
    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');
    unregister();
    unsubscribe();
  });

  test.each([
    ['drop-after-send with no ack', 1006, 'result_lost'],
    ['disconnect/reconnect mid-send', 1001, 'network_transition'],
  ])('%s queries the dispatched survivor receipt without re-sending it', async (_label, code, reason) => {
    const { stream, unsubscribe, socket } = connectedTransport();
    const { optimisticId, settled } = beginPendingSend(stream, String(_label));
    const originalRequestId = sendFrames(socket)[0]?.request_id as string;

    socket.closeFromServer(code, reason);
    expect(await settled).toBe('rejected');
    const recovered = reconnectSocket();

    expect(sendFrames(recovered)).toHaveLength(0);
    expect(receiptFrames(recovered)).toEqual([expect.objectContaining({ request_id: originalRequestId })]);
    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');
    unsubscribe();
  });

  test('daemon restart with a pending send stays visibly recoverable without retransmission', async () => {
    const { stream, unsubscribe, socket } = connectedTransport();
    const { optimisticId, settled } = beginPendingSend(stream, 'daemon restart with a pending send');

    socket.closeFromServer(1012, 'service_restart');
    expect(await settled).toBe('rejected');
    const recovered = reconnectSocket();

    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
      status: 'indeterminate',
    });
    expect(sendFrames(recovered)).toHaveLength(0);
    unsubscribe();
  });

  test('background-to-foreground recovery queries the pending send receipt without re-sending it', async () => {
    const { stream, unsubscribe, socket } = connectedTransport();
    const unregister = stream.registerFocusedPentacleStream(STREAM_ID);
    socket.message({ type: 'pong' });
    stream.__handlePentacleAppStateChangeForTests('background');
    const { optimisticId, settled } = beginPendingSend(stream, 'background pending send');
    const originalRequestId = sendFrames(socket)[0]?.request_id as string;

    stream.__handlePentacleAppStateChangeForTests('active');
    jest.advanceTimersByTime(250);
    socket.closeFromServer(1006, 'foreground_probe_silent');
    expect(await settled).toBe('rejected');
    const recovered = reconnectSocket();

    expect(sendFrames(recovered)).toHaveLength(0);
    expect(receiptFrames(recovered)).toEqual([expect.objectContaining({ request_id: originalRequestId })]);
    expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');
    unregister();
    unsubscribe();
  });

  test('late stamped delivery after recovery reconciles once and never retransmits', async () => {
    const { stream, unsubscribe, socket } = connectedTransport();
    const { optimisticId, settled } = beginPendingSend(stream, 'late landed once');

    socket.closeFromServer(1012, 'result_lost');
    expect(await settled).toBe('rejected');
    const recovered = reconnectSocket();
    const echo = {
      daemon_seq: 77,
      stream_id: STREAM_ID,
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-07-18T12:00:00.000Z',
      kind: 'USER',
      text: 'late landed once',
      optimistic_id: optimisticId,
    };
    recovered.message({ type: 'chat.event', event: echo });
    recovered.message({ type: 'chat.event', event: echo });

    const state = stream.getPentacleStreamState();
    expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
    expect(state.events.filter((event) => event.optimistic_id === optimisticId)).toHaveLength(1);
    expect(sendFrames(recovered)).toHaveLength(0);
    unsubscribe();
  });
});

test('snapshot reconciliation removes optimistic indexes when a matching server USER echo is present', () => {
  const state = optimisticState('dispatched', GEN, CREATED_AT);
  const next = applySnapshotWithOptimisticReconciliation(state, snapshot([serverUserEvent()]), CREATED_AT + 2_000);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toBeUndefined();
  expect(next.optimisticByRequestId?.[REQUEST_ID]).toBeUndefined();
  expect(next.events).toHaveLength(1);
  expect(next.events[0]).toMatchObject({
    optimistic_id: OPTIMISTIC_ID,
    correlatedDaemonSeq: 42,
    pending: false,
    text: 'hello',
    queued_at: CREATED_AT,
  });
});

test('snapshot reconciliation keeps a missing echo within the reconcile window as-is', () => {
  const state = optimisticState('acked');
  const next = applySnapshotWithOptimisticReconciliation(state, snapshot(), CREATED_AT + 10_000);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({ status: 'acked' });
  expect(next.optimisticByRequestId?.[REQUEST_ID]).toBe(OPTIMISTIC_ID);
  expect(next.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(true);
});

test('FEAT-SEND-NO-FALSE-FAILED: snapshot reconciliation does NOT timeout-fail a missing-echo send — it stays "sending"', () => {
  const state = optimisticState('dispatched');
  const next = applySnapshotWithOptimisticReconciliation(state, snapshot(), CREATED_AT + 61_000);

  // A transmitted send with no echo stays "sending" across a snapshot resync,
  // however long it has been waiting — we never guess "failed" from confirmation
  // lag. failed is reachable ONLY from a hard transport/daemon-reject signal.
  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({ status: 'dispatched' });
  expect(next.optimisticSends?.[OPTIMISTIC_ID]?.failure_reason).toBeUndefined();
  expect(next.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(true);
});

test('snapshot reconciliation uses the post-reconnect window instead of the original created_at', () => {
  const reconnectedAt = CREATED_AT + 120_000;
  const reconnected = onReconnect(optimisticState('dispatched'), GEN, reconnectedAt, NEXT_GEN);
  const next = applySnapshotWithOptimisticReconciliation(reconnected, snapshot(), reconnectedAt + 1_000);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status: 'dispatched',
    window_started_at: reconnectedAt,
    socket_generation: NEXT_GEN,
  });
  expect(next.optimisticByRequestId?.[REQUEST_ID]).toBe(OPTIMISTIC_ID);
  expect(next.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(true);
});

test('indeterminate survivor honors fresh window_started_at after reconnect', () => {
  const dispatched = markOptimisticDispatchedByRequestId(
    optimisticState('queued'),
    REQUEST_ID,
    CREATED_AT,
    GEN,
  );
  const indeterminate = markOptimisticIndeterminateByRequestId(dispatched, REQUEST_ID, CREATED_AT);
  const reconnectedAt = CREATED_AT + 120_000;
  const reconnected = onReconnect(indeterminate, GEN, reconnectedAt, NEXT_GEN);
  const next = applySnapshotWithOptimisticReconciliation(reconnected, snapshot(), reconnectedAt + 10_000);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status: 'indeterminate',
    indeterminate_at: CREATED_AT,
    window_started_at: reconnectedAt,
    socket_generation: NEXT_GEN,
  });
  expect(next.optimisticByRequestId?.[REQUEST_ID]).toBe(OPTIMISTIC_ID);
  expect(next.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(true);
});

test('snapshot reconciliation keeps failed rows in state and visible for manual retry display', () => {
  const state = optimisticState('failed');
  const next = applySnapshotWithOptimisticReconciliation(state, snapshot(), CREATED_AT + 61_000);

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status: 'failed',
    failure_reason: 'send_error',
  });
  expect(next.optimisticByRequestId?.[REQUEST_ID]).toBe(OPTIMISTIC_ID);
  expect(next.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(false);
});
