// public-test-spec — §A parity.
// A notification-answer resolve must survive a transport cut and auto-replay once
// per reconnect generation with the SAME request_id, exactly like a message send.
// A daemon restart (1012) must NOT replay and must leave the card recoverable.
import type { PentacleNotification } from 'pentacle-chat-core';

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

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
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function notification(overrides: Partial<PentacleNotification> = {}): PentacleNotification {
  return {
    notification_id: 'n1',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'example-producer',
    severity: 'warning',
    title: 'Lead needs a decision',
    body: 'Approve outreach?',
    dedup_key: 'dk-1',
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

function connect() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  return { stream, socket, unsubscribe };
}

function reconnectSocket() {
  jest.advanceTimersByTime(1_000);
  const socket = MockWebSocket.instances.at(-1) as MockWebSocket;
  socket.open();
  return socket;
}

function resolveFrames(socket: MockWebSocket) {
  return socket.sent
    .map((item) => JSON.parse(item))
    .filter((item) => item.type === 'notification.resolve');
}

function cardFor(stream: typeof import('../src/services/pentacleStream'), id: string) {
  return stream.getPentacleStreamState().notifications.find((n) => n.notification_id === id) as
    (PentacleNotification & { client_resolution_pending?: boolean; client_resolution_error?: string }) | undefined;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('a resolve issued while offline is not discarded and replays exactly once on reconnect with the same request_id', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'notification', notification: notification({ notification_id: 'n1', state: 'open' }) });

  // Transport cut BEFORE the answer — the socket is closed when the user answers.
  socket.closeFromServer(1006, 'network_drop');

  // §A: the resolve is queued for replay, not rejected; the card stays "sending".
  const settled = stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  }).then(() => 'resolved', () => 'rejected');
  await Promise.resolve();
  expect(cardFor(stream, 'n1')).toEqual(expect.objectContaining({ client_resolution_pending: true }));

  const recovered = reconnectSocket();
  const replayed = resolveFrames(recovered);
  expect(replayed).toHaveLength(1);
  expect(replayed[0]).toEqual(expect.objectContaining({
    type: 'notification.resolve',
    notification_id: 'n1',
    action_kind: 'yes_no',
    choice: true,
  }));
  const requestId = replayed[0].request_id as string;
  expect(typeof requestId).toBe('string');

  // Daemon settles the replay -> card answered, promise resolves, nothing lingers.
  recovered.message({
    type: 'notification.resolve.ok',
    request_id: requestId,
    notification: notification({ notification_id: 'n1', state: 'answered' }),
  });
  expect(await settled).toBe('resolved');
  expect(cardFor(stream, 'n1')?.state).toBe('answered');

  // Idempotency: once settled, a fresh cut + reconnect does not re-emit the resolve.
  recovered.closeFromServer(1006, 'network_drop');
  const again = reconnectSocket();
  expect(resolveFrames(again)).toHaveLength(0);
  unsubscribe();
});

test('a resolve cut mid-flight replays once on reconnect with the same request_id', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'notification', notification: notification({ notification_id: 'n1', state: 'open' }) });

  const settled = stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  }).then(() => 'resolved', () => 'rejected');
  const firstFrame = resolveFrames(socket)[0];
  expect(firstFrame).toBeTruthy();
  const originalRequestId = firstFrame.request_id as string;

  socket.closeFromServer(1001, 'network_transition');
  const recovered = reconnectSocket();

  const replayed = resolveFrames(recovered);
  expect(replayed).toHaveLength(1);
  expect(replayed[0].request_id).toBe(originalRequestId);

  recovered.message({
    type: 'notification.resolve.ok',
    request_id: originalRequestId,
    notification: notification({ notification_id: 'n1', state: 'answered' }),
  });
  expect(await settled).toBe('resolved');
  unsubscribe();
});

test('an offline resolve whose reconnect replay hits a daemon restart (1012) is left retryable, not stuck', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'notification', notification: notification({ notification_id: 'n1', state: 'open' }) });

  socket.closeFromServer(1006, 'network_drop');
  await stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  }).catch(() => undefined);
  expect(cardFor(stream, 'n1')?.client_resolution_pending).toBe(true);

  // Reconnect drives the queued resolve; the daemon then restarts under it.
  const recovered = reconnectSocket();
  expect(resolveFrames(recovered)).toHaveLength(1);
  recovered.closeFromServer(1012, 'service_restart');
  await Promise.resolve();

  const card = cardFor(stream, 'n1');
  expect(card?.client_resolution_pending).toBeFalsy();
  expect(typeof card?.client_resolution_error).toBe('string'); // visibly recoverable, not silently pending
  // Survivor dropped: a later reconnect does not re-drive it.
  const again = reconnectSocket();
  expect(resolveFrames(again)).toHaveLength(0);
  unsubscribe();
});

test('an offline resolve that outlives the 30-minute replay window is surfaced as recoverable, not silently dropped', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'notification', notification: notification({ notification_id: 'n1', state: 'open' }) });

  socket.closeFromServer(1006, 'network_drop');
  await stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  }).catch(() => undefined);
  expect(cardFor(stream, 'n1')?.client_resolution_pending).toBe(true);

  // Stay offline past the 30-minute replay window, then reconnect.
  jest.setSystemTime(Date.now() + 30 * 60 * 1000 + 5_000);
  const recovered = reconnectSocket();

  expect(resolveFrames(recovered)).toHaveLength(0); // expired -> not replayed
  const card = cardFor(stream, 'n1');
  expect(card?.client_resolution_pending).toBeFalsy();
  expect(typeof card?.client_resolution_error).toBe('string'); // answer not lost silently
  unsubscribe();
});

test('a daemon restart (1012) does not replay the resolve and leaves the card recoverable', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'notification', notification: notification({ notification_id: 'n1', state: 'open' }) });

  stream.resolveNotification({
    notification_id: 'n1',
    action_kind: 'yes_no',
    action_id: 'a0',
    choice: true,
  }).catch(() => undefined);
  expect(resolveFrames(socket)).toHaveLength(1);

  socket.closeFromServer(1012, 'service_restart');
  const recovered = reconnectSocket();

  expect(resolveFrames(recovered)).toHaveLength(0);
  const card = cardFor(stream, 'n1');
  expect(card?.client_resolution_pending).toBeFalsy();
  expect(typeof card?.client_resolution_error).toBe('string');
  unsubscribe();
});

