// Selected accepted Retry and delivery controls; deterministic local WebSocket fixtures.
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockAsyncStorageValues = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockAsyncStorageValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockAsyncStorageValues.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { mockAsyncStorageValues.delete(key); }),
    clear: jest.fn(async () => { mockAsyncStorageValues.clear(); }),
  },
}));

jest.mock('expo-notifications', () => ({}));

jest.mock('../../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

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
  return require('../../src/services/pentacleStream') as typeof import('../../src/services/pentacleStream');
}

beforeEach(async () => {
  await AsyncStorage.clear();
  delete process.env.EXPO_PUBLIC_HARNESS;
  delete process.env.EXPO_PUBLIC_HARNESS_FORCE_WS_RECONNECT;
  jest.useFakeTimers();
});

async function flushMicrotasks(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function subscribeAndCreateSocket(stream: typeof import('../../src/services/pentacleStream')) {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  return { unsubscribe, socket: MockWebSocket.instances.at(-1) as MockWebSocket };
}

function sentFrames(socket: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

const OPERATOR_V2_ENVELOPE = 'pentacle-auth-v2:' + Buffer.from(JSON.stringify({ client_kind: 'pentacle-mobile', credential_id: '123e4567-e89b-12d3-a456-426614174000', proof_key: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'), version: 2 })).toString('base64url');

const OPERATOR_V2_NONCE = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

function operatorV2Welcome(overrides: Record<string, unknown> = {}) {
  return {
    type: 'welcome',
    auth: {
      operator: {
        protocol_version: 2,
        scheme: 'hmac-sha256-v2',
        nonce: OPERATOR_V2_NONCE,
        expires_at: Date.now() / 1000 + 10,
        ...overrides,
      },
    },
  };
}

function sessionSummary(streamId = 'merlin:codex:one', overrides: Record<string, unknown> = {}) {
  return {
    stream_id: streamId,
    host: 'merlin',
    provider: 'codex',
    session_name: streamId.split(':').pop() || 'one',
    last_event_at: '2026-05-08T00:00:00Z',
    last_text: 'live summary',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: true,
    online: true,
    ...overrides,
  };
}

function pentacleEvent(overrides: Record<string, unknown> = {}) {
  return {
    daemon_seq: 1,
    stream_id: 'merlin:codex:one',
    host: 'merlin',
    provider: 'codex',
    session_id: 'merlin:codex:one',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}

test('batch_submitted optimistic row settles after the reconcile window without a USER echo', async () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  expect(stream.getPentacleStreamState().connected).toBe(true);
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('merlin:codex:one', { working: false })] });

  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'batch me');
  const sendPromise = stream.sendPentacleMessage({ host: 'merlin', sessionName: 'one', text: 'batch me' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    delivery: 'landed',
    reason: 'batch_submitted',
  });
  await expect(sendPromise).resolves.toBe(true);

  // Reconcile window (OPTIMISTIC_RECONCILE_WINDOW_MS = 60s) elapses; no echo lands.
  jest.advanceTimersByTime(61_000);
  await flushMicrotasks();

  const send = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  expect(send).toBeTruthy();
  // Must not remain in a sending-class status once the fallback window is exceeded.
  expect(['queued', 'dispatched', 'indeterminate'].includes(String(send?.status))).toBe(false);
  unsubscribe();
});

test('landed result stays confirmed when its USER echo is absent', async () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('merlin:codex:one', { working: false })] });

  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'batch me');
  const sendPromise = stream.sendPentacleMessage({ host: 'merlin', sessionName: 'one', text: 'batch me' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    delivery: 'landed',
    reason: 'batch_submitted',
  });
  await expect(sendPromise).resolves.toBe(true);

  const send = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  expect(send).toBeTruthy();
  expect(send?.status).toBe('acked');
  unsubscribe();
});

test('batch_submitted whose USER echo lands is reconciled, never false-failed by the fallback', async () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('merlin:codex:one', { working: false })] });

  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'batch me');
  const sendPromise = stream.sendPentacleMessage({ host: 'merlin', sessionName: 'one', text: 'batch me' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    delivery: 'landed',
    reason: 'batch_submitted',
  });
  await expect(sendPromise).resolves.toBe(true);

  // The keyed USER echo lands (server truth) before the window expires.
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 42, kind: 'USER', text: 'batch me', optimistic_id: optimisticId, client_origin: false }),
  });

  jest.advanceTimersByTime(61_000);
  await flushMicrotasks();

  const send = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  // Reconciled by the echo — never flipped to failed by the fallback timer.
  expect(send?.status).not.toBe('failed');
  unsubscribe();
});

test('retryOptimisticSend re-uploads a retained staged asset before re-sending', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('merlin:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'photo after a drop', [{
    key: 'local:0:file:///tmp/photo.jpg',
    mime: 'image/jpeg',
    bytes: 4,
  }]);
  const prior = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  let reuploads = 0;
  stream.retainUploadForRetry(optimisticId, async () => {
    reuploads += 1;
    const uploaded = await stream.uploadBlobBase64('aaaa', 4);
    return [{ key: uploaded.blob_sha, mime: 'image/jpeg', bytes: 4 }];
  });
  // The upload leg dropped: the row is failed (visible Retry), no send was dispatched.
  stream.markOptimisticFailed(optimisticId, 'Pentacle stream disconnected');
  expect(sentFrames(socket, 'send')).toHaveLength(0);

  const retry = stream.retryOptimisticSend(optimisticId);
  await flushMicrotasks();
  expect(reuploads).toBe(1);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');
  const init = sentFrames(socket, 'upload_blob_init')[0];
  expect(typeof init.request_id).toBe('string');
  socket.message({ type: 'upload_blob.init.ok', request_id: init.request_id });
  await flushMicrotasks();
  const blobSha = 'e'.repeat(64);
  socket.message({ type: 'upload_blob.ok', request_id: init.request_id, blob_sha: blobSha, size_bytes: 4 });
  await flushMicrotasks();

  const send = sentFrames(socket, 'send').at(-1);
  expect(send).toMatchObject({
    optimistic_id: optimisticId,
    text: 'photo after a drop',
    attachments: [expect.objectContaining({ key: blobSha })],
  });
  expect(send?.request_id).not.toBe(prior?.request_id);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.attachments).toEqual([
    expect.objectContaining({ key: blobSha }),
  ]);

  socket.message({ type: 'send.result', request_id: send?.request_id, delivery: 'landed' });
  await expect(retry).resolves.toBe(true);
  unsubscribe();
});

test('retryOptimisticSend fails the row visibly when the re-upload rejects, and sends nothing', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('merlin:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'photo gone', [{
    key: 'local:0:file:///tmp/gone.jpg',
    mime: 'image/jpeg',
  }]);
  stream.retainUploadForRetry(optimisticId, async () => {
    throw new Error('File not found: file:///tmp/gone.jpg');
  });
  stream.markOptimisticFailed(optimisticId, 'Pentacle stream disconnected');

  await expect(stream.retryOptimisticSend(optimisticId)).resolves.toBe(false);
  expect(sentFrames(socket, 'upload_blob_init')).toHaveLength(0);
  expect(sentFrames(socket, 'send')).toHaveLength(0);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'failed',
    failure_reason: 'File not found: file:///tmp/gone.jpg',
  });
  unsubscribe();
});

test('retainUploadForRetry ignores unknown rows and drops its entry once the row leaves optimisticSends', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('merlin:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('merlin:codex:one', { working: true })] });
  const reupload = jest.fn(async () => [{ key: 'f'.repeat(64), mime: 'image/jpeg' }]);
  stream.retainUploadForRetry('optimistic_never_inserted', reupload);

  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'lands then retries', [{
    key: 'local:0:file:///tmp/p.jpg',
    mime: 'image/jpeg',
  }]);
  stream.retainUploadForRetry(optimisticId, reupload);
  // The unit lands through a fetch reconcile: the row leaves optimisticSends,
  // and with it the retained re-upload (nothing survives the row).
  const fetchPromise = stream.requestStreamEvents('merlin:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'merlin:codex:one',
    events: [pentacleEvent({ daemon_seq: 10, kind: 'USER', text: 'lands then retries', optimistic_id: optimisticId })],
  });
  await expect(fetchPromise).resolves.toHaveLength(1);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
  expect(stream.hasRetainedUploadForRetry(optimisticId)).toBe(false);
  expect(stream.hasRetainedUploadForRetry('optimistic_never_inserted')).toBe(false);
  expect(reupload).not.toHaveBeenCalled();
  unregisterFocus();
  unsubscribe();
});

test('retryOptimisticSend with the socket closed after a good re-upload fails the row (nothing was dispatched)', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('merlin:codex:one', { working: false })],
    events: [],
  });
  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'retry into a closed socket', [{
    key: 'local:0:file:///tmp/c.jpg',
    mime: 'image/jpeg',
  }]);
  stream.retainUploadForRetry(optimisticId, async () => {
    // Simulate the socket dropping right after the blob upload finished.
    socket.close();
    return [{ key: 'd'.repeat(64), mime: 'image/jpeg' }];
  });
  expect(stream.hasRetainedUploadForRetry(optimisticId)).toBe(true);
  stream.markOptimisticFailed(optimisticId, 'Pentacle stream disconnected');

  await expect(stream.retryOptimisticSend(optimisticId)).resolves.toBe(false);
  expect(sentFrames(socket, 'send')).toHaveLength(0);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'failed',
    failure_reason: 'Pentacle stream is not connected',
  });
  // Still retained: the user can Retry again once the socket is back.
  expect(stream.hasRetainedUploadForRetry(optimisticId)).toBe(true);
  unsubscribe();
});

test('one photo Retry during backoff waits for the existing connection and sends the retained photo', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary('merlin:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'retained photo', [{ key: 'local:photo', mime: 'image/png' }]);
  stream.retainUploadForRetry(optimisticId, async () => {
    const result = await stream.uploadBlobBase64('YWJj', 3);
    return [{ key: result.blob_sha, mime: 'image/png', bytes: 3 }];
  });
  stream.markOptimisticFailed(optimisticId, 'upload interrupted');
  socket.closeFromServer();
  for (const delay of [1000, 2000, 5000, 10000]) {
    jest.advanceTimersByTime(delay);
    MockWebSocket.instances.at(-1)!.closeFromServer();
  }
  const beforeRetry = MockWebSocket.instances.length;
  const retry = stream.retryOptimisticSend(optimisticId);
  let settled = false;
  void retry.then(() => { settled = true; });
  await flushMicrotasks();
  expect(settled).toBe(false);
  expect(stream.hasRetainedUploadForRetry(optimisticId)).toBe(true);
  expect(MockWebSocket.instances).toHaveLength(beforeRetry + 1);
  expect(MockWebSocket.instances.at(-1)?.readyState).toBe(MockWebSocket.CONNECTING);
  expect(MockWebSocket.instances.flatMap(s => sentFrames(s, 'send'))).toHaveLength(0);
  const recovered = MockWebSocket.instances.at(-1)!;
  recovered.open();
  expect(sentFrames(recovered, 'send')).toHaveLength(0);
  await flushMicrotasks();
  expect(MockWebSocket.instances).toHaveLength(beforeRetry + 1);
  const init = sentFrames(recovered, 'upload_blob_init')[0];
  recovered.message({ type: 'upload_blob.init.ok', request_id: init.request_id });
  await flushMicrotasks();
  recovered.message({ type: 'upload_blob.ok', request_id: init.request_id, blob_sha: 'a'.repeat(64), size_bytes: 3 });
  await flushMicrotasks();
  const sends = sentFrames(recovered, 'send');
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ optimistic_id: optimisticId, attachments: [{ key: 'a'.repeat(64), mime: 'image/png', bytes: 3 }] });
  recovered.message({ type: 'send.result', request_id: sends[0].request_id, delivery: 'landed' });
  await expect(retry).resolves.toBe(true);
  unsubscribe();
});

test('photo Retry joins an in-flight v2 connection and waits for its existing readiness owner', async () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'snapshot', sessions: [sessionSummary('merlin:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'retained photo');
  const reupload = jest.fn(async () => [{ key: 'a'.repeat(64), mime: 'image/png' }]);
  stream.retainUploadForRetry(optimisticId, reupload);
  stream.markOptimisticFailed(optimisticId, 'upload interrupted');
  socket.closeFromServer();
  jest.advanceTimersByTime(1000);
  const recovering = MockWebSocket.instances.at(-1)!;
  const retry = stream.retryOptimisticSend(optimisticId);
  expect(MockWebSocket.instances).toHaveLength(2);
  recovering.open();
  await flushMicrotasks();
  expect(reupload).not.toHaveBeenCalled();
  recovering.message(operatorV2Welcome());
  await flushMicrotasks();
  expect(reupload).toHaveBeenCalledTimes(1);
  expect(MockWebSocket.instances).toHaveLength(2);
  const sends = sentFrames(recovering, 'send');
  expect(sends).toHaveLength(1);
  recovering.message({ type: 'send.result', request_id: sends[0].request_id, delivery: 'landed' });
  await expect(retry).resolves.toBe(true);
  unsubscribe();
});

test('offline photo Retry expires truthfully and a late connection cannot dispatch its abandoned attempt', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary('merlin:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'offline photo', [{ key: 'local:photo', mime: 'image/png' }]);
  const reupload = jest.fn(async () => [{ key: 'a'.repeat(64), mime: 'image/png' }]);
  stream.retainUploadForRetry(optimisticId, reupload);
  stream.markOptimisticFailed(optimisticId, 'upload interrupted');
  socket.closeFromServer();
  const retry = stream.retryOptimisticSend(optimisticId);
  let settled = false;
  void retry.then(() => { settled = true; });
  await expect(stream.retryOptimisticSend(optimisticId)).resolves.toBe(false);
  jest.advanceTimersByTime(14_999);
  await flushMicrotasks();
  expect(settled).toBe(false);
  expect(reupload).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  await expect(retry).resolves.toBe(false);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({ status: 'failed', failure_reason: 'Pentacle stream is not connected' });
  expect(stream.hasRetainedUploadForRetry(optimisticId)).toBe(true);
  MockWebSocket.instances.at(-1)!.open();
  await flushMicrotasks();
  expect(reupload).not.toHaveBeenCalled();
  expect(MockWebSocket.instances.flatMap(s => sentFrames(s, 'send'))).toHaveLength(0);
  unsubscribe();
});

test('a late authoritative echo during Retry connection recovery cancels the upload instead of duplicating delivery', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary('merlin:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('merlin:codex:one', 'already delivered', [{ key: 'local:photo', mime: 'image/png' }]);
  const reupload = jest.fn(async () => [{ key: 'a'.repeat(64), mime: 'image/png' }]);
  stream.retainUploadForRetry(optimisticId, reupload);
  stream.markOptimisticFailed(optimisticId, 'unconfirmed');
  socket.closeFromServer();
  const retry = stream.retryOptimisticSend(optimisticId);
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 99, kind: 'USER', text: 'already delivered', optimistic_id: optimisticId }) });
  await expect(retry).resolves.toBe(false);
  MockWebSocket.instances.at(-1)!.open();
  await flushMicrotasks();
  expect(reupload).not.toHaveBeenCalled();
  expect(MockWebSocket.instances.flatMap(s => sentFrames(s, 'send'))).toHaveLength(0);
  unsubscribe();
});
