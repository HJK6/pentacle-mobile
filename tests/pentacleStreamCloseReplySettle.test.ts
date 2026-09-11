jest.mock('expo-notifications', () => ({}));

// The v2 daemon answers a close with close.ok / close.degraded / close.already_closed /
// close.deferred / close.failed. Before this lane the client recognised only ok/degraded/error,
// so close.failed (ssh_unreachable) hung 30s, was misclassified transient and retried for ten
// minutes. These tests feed each frame to the real stream service and assert the promise settles
// in one round trip, an offline host is labeled honestly, and force delete is operator-confirmed.

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
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(message: string) { this.sent.push(message); }
  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

function loadStream() {
  jest.resetModules();
  jest.doMock('../src/config/pentacle', () => ({
    getDefaultPentacleWsUrl: () => 'ws://close-settle.example/ws',
  }));
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function connect() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  return { stream, socket, unsubscribe };
}

async function flush() {
  // The pending-close path threads through AsyncStorage hydration/persist and a queued
  // dispatch, so settle both the microtask queue and short timers before reading the wire.
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
    jest.advanceTimersByTime(1);
  }
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

const OFFLINE = { host: 'amaterasu', sessionName: 'v2-9fe540c0', streamId: 'amaterasu:v2-9fe540c0' };

async function startClose(stream: ReturnType<typeof loadStream>, socket: MockWebSocket, args = OFFLINE) {
  const pending = stream.closePentacleSession(args);
  await flush();
  const sent = JSON.parse(socket.sent.at(-1) || '{}');
  return { pending, sent };
}

test('close.failed (ssh_unreachable) settles in the same round trip and does not enter the retry loop', async () => {
  const { stream, socket, unsubscribe } = connect();
  const { pending, sent } = await startClose(stream, socket);
  expect(sent.type).toBe('close');
  expect(sent.defer_if_working).toBe(true);
  const sentBefore = socket.sent.length;

  socket.message({ type: 'close.failed', request_id: sent.request_id, reason: 'ssh_unreachable' });
  await expect(pending).rejects.toMatchObject({ errorCode: 'ssh_unreachable' });
  await flush();
  // No retry frame was sent: the failure is settled, not queued for backoff.
  expect(socket.sent.length).toBe(sentBefore);
  unsubscribe();
});

test('a failed close on an offline host labels the row host_offline with an honest message', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: OFFLINE.streamId, host: 'amaterasu', provider: 'codex', session_name: OFFLINE.sessionName, title: 'A', online: false }],
  });
  const { pending, sent } = await startClose(stream, socket);
  socket.message({ type: 'close.failed', request_id: sent.request_id, reason: 'ssh_unreachable' });
  await expect(pending).rejects.toMatchObject({ errorCode: 'ssh_unreachable' });
  await flush();

  const row = stream.getPentacleStreamState().sessions.find((s) => s.stream_id === OFFLINE.streamId) as
    (Record<string, any> | undefined);
  expect(row?.pending_close?.errorCode).toBe('host_offline');
  expect(row?.pending_close?.errorMessage).toBe('Amaterasu is offline');
  unsubscribe();
});

test('close.already_closed resolves as success', async () => {
  const { stream, socket, unsubscribe } = connect();
  const { pending, sent } = await startClose(stream, socket);
  socket.message({ type: 'close.already_closed', request_id: sent.request_id });
  await expect(pending).resolves.toMatchObject({ closed: true, deferred: false });
  unsubscribe();
});

test('close.deferred resolves as deferred', async () => {
  const { stream, socket, unsubscribe } = connect();
  const { pending, sent } = await startClose(stream, socket);
  socket.message({ type: 'close.deferred', request_id: sent.request_id });
  await expect(pending).resolves.toMatchObject({ deferred: true, closed: false });
  unsubscribe();
});

test('a transient close error (session_working) stays in the retry loop and re-dispatches', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: OFFLINE.streamId, host: 'amaterasu', provider: 'codex', session_name: OFFLINE.sessionName, title: 'A', online: true }],
  });
  const { pending, sent } = await startClose(stream, socket);
  const sentAfterFirst = socket.sent.length;

  // A working session is a genuine transient close error: it resolves as queued and re-dispatches
  // on the backoff, unlike the non-transient ssh_unreachable path.
  socket.message({ type: 'close.error', request_id: sent.request_id, error_code: 'session_working' });
  await expect(pending).resolves.toMatchObject({ queued: true, closed: false });
  await flush();

  const row = stream.getPentacleStreamState().sessions.find((s) => s.stream_id === OFFLINE.streamId) as
    (Record<string, any> | undefined);
  expect(row?.pending_close?.state).toBe('retrying');
  expect(row?.pending_close?.errorCode).toBe('session_working');

  // The scheduled backoff re-dispatches a fresh close frame.
  jest.advanceTimersByTime(2000);
  await flush();
  expect(socket.sent.length).toBeGreaterThan(sentAfterFirst);
  unsubscribe();
});

test('force delete sends force + operator_confirm so the daemon offline close applies', async () => {
  const { stream, socket, unsubscribe } = connect();
  // Seed inventory so the pending-close drain (gated on the inventory generation) will run.
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: OFFLINE.streamId, host: 'amaterasu', provider: 'codex', session_name: OFFLINE.sessionName, title: 'A', online: false }],
  });
  const { pending, sent } = await startClose(stream, socket);
  socket.message({ type: 'close.failed', request_id: sent.request_id, reason: 'ssh_unreachable' });
  await expect(pending).rejects.toMatchObject({ errorCode: 'ssh_unreachable' });
  await flush();

  const forcePending = stream.forcePendingSessionClose(OFFLINE.streamId);
  await flush();
  const forceSent = JSON.parse(socket.sent.at(-1) || '{}');
  expect(forceSent.type).toBe('close');
  expect(forceSent.force).toBe(true);
  expect(forceSent.operator_confirm).toBe(true);

  socket.message({ type: 'close.ok', request_id: forceSent.request_id, session_generation: 'g1' });
  await expect(forcePending).resolves.toBe(true);
  unsubscribe();
});
