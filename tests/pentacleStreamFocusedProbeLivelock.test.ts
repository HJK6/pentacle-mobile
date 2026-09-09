jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

type SocketEvent = { data?: string };

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: SocketEvent) => void) | null = null;
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
}

type StreamModule = typeof import('../src/services/pentacleStream');

const STREAM_ID = 'hostc:codex:slow-history';
const FOCUSED_HEARTBEAT_AT_MS = 1_500;
const FOCUSED_PROBE_WINDOW_MS = 1_000;
const FOCUSED_HISTORY_PROBE_WINDOW_MS = 6_000;
const FOCUSED_PROBE_BOUNDARY_MS = FOCUSED_HEARTBEAT_AT_MS + FOCUSED_HISTORY_PROBE_WINDOW_MS;

function loadStream(): StreamModule {
  jest.resetModules();
  MockWebSocket.instances = [];
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as StreamModule;
}

function sentFrames(socket: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

function openFocusedStream(stream: StreamModule) {
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream(STREAM_ID);
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances.at(-1) as MockWebSocket;
  socket.open();
  const request = sentFrames(socket, 'request_stream_events').at(-1);
  expect(request).toEqual(expect.objectContaining({ stream_id: STREAM_ID, limit: 300 }));
  return { unregister, unsubscribe, socket, request: request as Record<string, unknown> };
}

function historyEvent(text: string, daemonSeq = 1) {
  return {
    daemon_seq: daemonSeq,
    stream_id: STREAM_ID,
    session_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'slow-history',
    timestamp: '2026-07-20T00:00:00Z',
    kind: 'ASSIST',
    text,
  };
}

function deliverHistory(socket: MockWebSocket, request: Record<string, unknown>, text: string) {
  socket.message({
    type: 'request_stream_events.ok',
    request_id: request.request_id,
    stream_id: STREAM_ID,
    events: [historyEvent(text)],
  });
}

function expectRenderedHistory(stream: StreamModule, text: string) {
  const slice = stream.selectStreamSlice(stream.getPentacleStreamState(), STREAM_ID);
  expect(slice.detail?.transcriptItems.map((event) => event.text)).toContain(text);
}

async function flushMicrotasks(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('focused heartbeat closes a dead socket at one second when history is settled', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled history');
  await flushMicrotasks();

  jest.advanceTimersByTime(FOCUSED_HEARTBEAT_AT_MS);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  jest.advanceTimersByTime(FOCUSED_PROBE_WINDOW_MS - 1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  jest.advanceTimersByTime(1);

  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  unregister();
  unsubscribe();
});

test('focused heartbeat preserves an in-flight history refetch past the one-second dead-socket window', () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket } = openFocusedStream(stream);

  jest.advanceTimersByTime(FOCUSED_HEARTBEAT_AT_MS + FOCUSED_PROBE_WINDOW_MS);

  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(MockWebSocket.instances).toHaveLength(1);
  unregister();
  unsubscribe();
});

test('send intent re-arms a lenient history probe and fast-fails the pending send after one second', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket } = openFocusedStream(stream);
  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: STREAM_ID,
      host: 'hostc',
      provider: 'codex',
      session_name: 'slow-history',
      last_event_at: '2026-07-20T00:00:00Z',
      last_text: 'history pending',
      last_kind: 'ASSIST',
      online: true,
      working: false,
    }],
  });
  jest.advanceTimersByTime(FOCUSED_HEARTBEAT_AT_MS);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);

  expect(stream.requestFocusedPentacleLivenessProbe('send')).toBe(true);
  const sendPromise = stream.sendPentacleMessage({
    host: 'hostc',
    sessionName: 'slow-history',
    text: 'send while history is pending',
  });
  const sendError = sendPromise.catch((error: Error) => error);
  expect(sentFrames(socket, 'ping')).toHaveLength(2);
  expect(sentFrames(socket, 'send')).toHaveLength(1);

  jest.advanceTimersByTime(FOCUSED_PROBE_WINDOW_MS - 1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  jest.advanceTimersByTime(1);

  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  await expect(sendError).resolves.toEqual(expect.objectContaining({ message: 'Pentacle stream disconnected' }));
  unregister();
  unsubscribe();
});

test('background heartbeat preserves a slow focused history refetch until its first frame renders', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);

  jest.advanceTimersByTime(FOCUSED_PROBE_BOUNDARY_MS + 1_000);

  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(MockWebSocket.instances).toHaveLength(1);

  deliverHistory(socket, request, 'history after slow rehydrate');
  await flushMicrotasks();

  expectRenderedHistory(stream, 'history after slow rehydrate');
  expect(stream.getPentacleStreamState().connected).toBe(true);
  unregister();
  unsubscribe();
});

test('a history frame arriving exactly at the focused-probe boundary prevents teardown', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);

  setTimeout(() => deliverHistory(socket, request, 'history at timeout boundary'), FOCUSED_PROBE_BOUNDARY_MS);
  jest.advanceTimersByTime(FOCUSED_PROBE_BOUNDARY_MS);
  await flushMicrotasks();

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(MockWebSocket.instances).toHaveLength(1);
  expectRenderedHistory(stream, 'history at timeout boundary');
  unregister();
  unsubscribe();
});

test('repeated reconnect attempts with slow history do not become a probe-driven reconnect loop', async () => {
  const stream = loadStream();
  const first = openFocusedStream(stream);

  jest.advanceTimersByTime(FOCUSED_PROBE_BOUNDARY_MS + 1_000);
  expect(MockWebSocket.instances).toHaveLength(1);

  stream.reconnectPentacleStream();
  const secondSocket = MockWebSocket.instances.at(-1) as MockWebSocket;
  await flushMicrotasks();
  secondSocket.open();
  const secondRequest = sentFrames(secondSocket, 'request_stream_events').at(-1) as Record<string, unknown>;
  jest.advanceTimersByTime(FOCUSED_PROBE_BOUNDARY_MS + 1_000);
  expect(MockWebSocket.instances).toHaveLength(2);

  stream.reconnectPentacleStream();
  const thirdSocket = MockWebSocket.instances.at(-1) as MockWebSocket;
  await flushMicrotasks();
  thirdSocket.open();
  const thirdRequest = sentFrames(thirdSocket, 'request_stream_events').at(-1) as Record<string, unknown>;
  jest.advanceTimersByTime(FOCUSED_PROBE_BOUNDARY_MS + 1_000);

  expect(MockWebSocket.instances).toHaveLength(3);
  expect(secondRequest).toEqual(expect.objectContaining({ stream_id: STREAM_ID, limit: 300 }));
  deliverHistory(thirdSocket, thirdRequest, 'history after repeated reconnects');
  await flushMicrotasks();
  expectRenderedHistory(stream, 'history after repeated reconnects');
  first.unregister();
  first.unsubscribe();
});

test('user interaction probe still fast-fails a half-open send with a request pending', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'initial history');
  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: STREAM_ID,
      host: 'hostc',
      provider: 'codex',
      session_name: 'slow-history',
      last_event_at: '2026-07-20T00:00:00Z',
      last_text: 'initial history',
      last_kind: 'ASSIST',
      online: true,
      working: false,
    }],
  });
  jest.advanceTimersByTime(500);

  const sendPromise = stream.sendPentacleMessage({
    host: 'hostc',
    sessionName: 'slow-history',
    text: 'half-open send',
  });
  const sendError = sendPromise.catch((error: Error) => error);
  expect(sentFrames(socket, 'send')).toHaveLength(1);
  expect(stream.requestFocusedPentacleLivenessProbe('send')).toBe(true);

  jest.advanceTimersByTime(FOCUSED_PROBE_WINDOW_MS - 1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  jest.advanceTimersByTime(1);

  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  await expect(sendError).resolves.toEqual(expect.objectContaining({ message: 'Pentacle stream disconnected' }));
  unregister();
  unsubscribe();
});

