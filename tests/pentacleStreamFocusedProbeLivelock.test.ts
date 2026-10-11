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


test('a slow blob upload keeps the focused socket alive until its bounded upload result', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled history');
  const upload = stream.uploadBlobBase64('YQ==', 1).catch(error => error);
  const init = sentFrames(socket, 'upload_blob_init').at(-1)!;
  socket.message({ type: 'upload_blob.init.ok', request_id: init.request_id });
  await flushMicrotasks();
  expect(sentFrames(socket, 'upload_blob_chunk')).toHaveLength(1);
  jest.advanceTimersByTime(15_000);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  socket.message({ type: 'upload_blob.ok', request_id: init.request_id, blob_sha: 'a'.repeat(64), size_bytes: 1 });
  expect(await upload).toMatchObject({ blob_sha: 'a'.repeat(64) });
  unregister(); unsubscribe();
});

test('transport-interrupted transcription retries once on authenticated reconnect with the same identity', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled history');
  const identity = { type: 'transcribe_blob', blob_sha: 'b'.repeat(64), mime: 'audio/wav', request_id: 'transcribe-reconnect-red' };
  const result = stream.transcribeBlob(identity.blob_sha, identity.mime, { requestId: identity.request_id }).catch(error => error);
  expect(sentFrames(socket, 'transcribe_blob')).toEqual([identity]);
  socket.close(1006, 'isolated transport interruption');
  await flushMicrotasks();
  jest.advanceTimersByTime(1_100);
  const next = MockWebSocket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  next.open();
  expect(sentFrames(next, 'transcribe_blob')).toHaveLength(0);
  next.message({ type: 'snapshot', sessions: [], events: [] });
  await flushMicrotasks();
  const retried = sentFrames(next, 'transcribe_blob');
  if (retried.length) next.message({ type: 'transcribe_blob.ok', request_id: identity.request_id, text: 'same transcription' });
  await flushMicrotasks();
  const value = await result;
  unregister(); unsubscribe();
  expect(retried).toEqual([identity]);
  expect(value).toMatchObject({ text: 'same transcription' });
  expect(sentFrames(next, 'upload_blob_init')).toHaveLength(0);
});

async function startUpload(stream: StreamModule, socket: MockWebSocket) {
  const result = stream.uploadBlobBase64('YQ==', 1).catch(error => error);
  const init = sentFrames(socket, 'upload_blob_init').at(-1)!;
  socket.message({ type: 'upload_blob.init.ok', request_id: init.request_id });
  await flushMicrotasks();
  return { result, id: init.request_id };
}

test('an armed focused probe yields to upload and ordinary focused liveness resumes afterward', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled');
  jest.advanceTimersByTime(1_500);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  const { result, id } = await startUpload(stream, socket);
  jest.advanceTimersByTime(5_000);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  socket.message({ type: 'upload_blob.ok', request_id: id, blob_sha: 'a'.repeat(64) });
  await result;
  jest.advanceTimersByTime(3_000);
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  unregister(); unsubscribe();
});

test('an unrelated RPC rejects on its own clock without closing an active upload', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled'); unregister();
  const unrelated = stream.transcribeBlob('other', 'audio/wav', { requestId: 'unrelated' }).catch(e => e);
  jest.advanceTimersByTime(29_000);
  const { result, id } = await startUpload(stream, socket);
  jest.advanceTimersByTime(1_100);
  expect(await unrelated).toMatchObject({ message: 'Pentacle command timed out' });
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  socket.message({ type: 'upload_blob.ok', request_id: id, blob_sha: 'a'.repeat(64) });
  expect(await result).toHaveProperty('blob_sha'); unsubscribe();
});

test('a deferred RPC close callback also yields to a subsequently started upload', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled'); unregister();
  const unrelated = stream.transcribeBlob('other', 'audio/wav').catch(e => e);
  jest.advanceTimersByTime(29_000); socket.message({ type: 'pong' });
  jest.advanceTimersByTime(1_000); await unrelated;
  jest.advanceTimersByTime(28_000);
  const { result, id } = await startUpload(stream, socket);
  jest.advanceTimersByTime(1_100);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  socket.message({ type: 'upload_blob.ok', request_id: id, blob_sha: 'a'.repeat(64) });
  await result; unsubscribe();
});

test.each(['init', 'final'])('a hung upload retains its thirty-second %s phase deadline', async phase => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled');
  const result = stream.uploadBlobBase64('YQ==', 1).catch(e => e);
  if (phase === 'final') {
    jest.advanceTimersByTime(20_000);
    socket.message({ type: 'upload_blob.init.ok', request_id: sentFrames(socket, 'upload_blob_init')[0].request_id });
    await flushMicrotasks();
  }
  jest.advanceTimersByTime(29_999);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  jest.advanceTimersByTime(1);
  expect(await result).toMatchObject({ message: 'Pentacle command timed out' });
  unregister(); unsubscribe();
});

test('old upload ownership and callbacks do not shield a replacement socket', async () => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket, request } = openFocusedStream(stream);
  deliverHistory(socket, request, 'settled');
  const { result } = await startUpload(stream, socket);
  socket.close(1006); expect(await result).toMatchObject({ message: 'Pentacle stream disconnected' });
  jest.advanceTimersByTime(1_100);
  const next = MockWebSocket.instances.at(-1)!; next.open();
  const tail = sentFrames(next, 'request_stream_events').at(-1)!; deliverHistory(next, tail, 'fresh');
  jest.advanceTimersByTime(2_501);
  expect(next.readyState).toBe(MockWebSocket.CLOSED);
  unregister(); unsubscribe();
});

test.each(['backend_unavailable', 'too_long'])('transcription domain error %s is never replayed', async code => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket } = openFocusedStream(stream);
  const result = stream.transcribeBlob('blob', 'audio/wav', { requestId: 'domain' }).catch(e => e);
  socket.message({ type: 'transcribe_blob.error', request_id: 'domain', error_code: code });
  expect(await result).toHaveProperty('code', code);
  expect(sentFrames(socket, 'transcribe_blob')).toHaveLength(1);
  unregister(); unsubscribe();
});

test.each(['cancel', 'exhaust', 'disconnect_again'])('transcription recovery is bounded for %s', async mode => {
  const stream = loadStream();
  const { unregister, unsubscribe, socket } = openFocusedStream(stream);
  let cancelled = false;
  const result = stream.transcribeBlob('blob', 'audio/wav', { requestId: 'bounded', isCancelled: () => cancelled }).catch(e => e);
  socket.close(1006); await flushMicrotasks();
  const next = MockWebSocket.instances.at(-1)!;
  if (mode === 'exhaust') {
    jest.advanceTimersByTime(15_000);
    expect(await result).toHaveProperty('message', 'Pentacle stream disconnected');
  } else {
    cancelled = mode === 'cancel';
    next.open(); next.message({ type: 'snapshot', sessions: [], events: [] });
    await flushMicrotasks();
    expect(sentFrames(next, 'transcribe_blob')).toHaveLength(cancelled ? 0 : 1);
    if (!cancelled) next.close(1006);
    expect(await result).toHaveProperty(cancelled ? 'code' : 'message', cancelled ? 'voice_cancelled' : 'Pentacle stream disconnected');
  }
  expect(MockWebSocket.instances.flatMap(s => sentFrames(s, 'transcribe_blob')).length).toBeLessThanOrEqual(2);
  unregister(); unsubscribe();
});

test('a voice transcription recovered after reconnect cannot deliver to a replaced origin', async () => {
  // Keep the durable store, upload, scheduler and transport real. Only the native
  // filesystem/UUID boundary and the external socket use disposable fixtures.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const { fileURLToPath, pathToFileURL } = require('url') as typeof import('url');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'voice-reconnect-'));
  const documentDirectory = `${pathToFileURL(path.join(root, 'documents')).href}/`;
  const cacheDirectory = `${pathToFileURL(path.join(root, 'cache')).href}/`;
  const localPath = (uri: string) => {
    const resolved = fileURLToPath(uri);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('unowned fixture path');
    return resolved;
  };
  fs.mkdirSync(localPath(cacheDirectory), { recursive: true });
  let nextUuid = 0;
  jest.doMock('expo-modules-core', () => ({
    ...jest.requireActual('expo-modules-core'),
    uuid: { v4: () => `123e4567-e89b-42d3-a456-${String(++nextUuid).padStart(12, '0')}` },
  }));
  jest.doMock('expo-file-system/legacy', () => ({
    documentDirectory, cacheDirectory, EncodingType: { Base64: 'base64' },
    getInfoAsync: async (uri: string) => {
      const filename = localPath(uri);
      if (!fs.existsSync(filename)) return { exists: false };
      const stat = fs.statSync(filename);
      return { exists: true, size: stat.size, isDirectory: stat.isDirectory() };
    },
    readDirectoryAsync: async (uri: string) => fs.readdirSync(localPath(uri)),
    makeDirectoryAsync: async (uri: string) => { fs.mkdirSync(localPath(uri), { recursive: true }); },
    readAsStringAsync: async (uri: string, options?: { encoding?: string; position?: number; length?: number }) => {
      const bytes = fs.readFileSync(localPath(uri));
      const start = options?.position ?? 0;
      return bytes.subarray(start, options?.length === undefined ? undefined : start + options.length)
        .toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
    },
    writeAsStringAsync: async (uri: string, text: string) => { fs.writeFileSync(localPath(uri), text); },
    moveAsync: async ({ from, to }: { from: string; to: string }) => { fs.renameSync(localPath(from), localPath(to)); },
    copyAsync: async ({ from, to }: { from: string; to: string }) => { fs.copyFileSync(localPath(from), localPath(to)); },
    deleteAsync: async (uri: string) => { fs.rmSync(localPath(uri), { recursive: true, force: true }); },
    getFreeDiskStorageAsync: async () => 1024 * 1024 * 1024,
  }));
  const stream = loadStream();
  const { voiceDelivery } = require('../src/services/voiceDelivery') as typeof import('../src/services/voiceDelivery');
  const { voiceTakeStore: store, VoiceTakeStore } = require('../src/services/voiceTakeStore') as typeof import('../src/services/voiceTakeStore');
  const until = async (predicate: () => boolean) => {
    for (let index = 0; index < 3000 && !predicate(); index++) await Promise.resolve();
    expect(predicate()).toBe(true);
  };
  const credentialId = '123e4567-e89b-12d3-a456-426614174000';
  const envelope = 'pentacle-auth-v2:' + Buffer.from(JSON.stringify({
    client_kind: 'pentacle-mobile', credential_id: credentialId,
    proof_key: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'), version: 2,
  })).toString('base64url');
  const authenticate = (socket: MockWebSocket) => {
    socket.open();
    socket.message({ type: 'welcome', auth: { operator: {
      protocol_version: 2, scheme: 'hmac-sha256-v2',
      nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8', expires_at: Date.now() / 1000 + 10,
    } } });
  };
  const session = { stream_id: STREAM_ID, host: 'hostc', provider: 'codex', session_name: 'slow-history', session_generation: 'original', working: false, online: true };
  stream.setPentacleAuthToken(envelope);
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream(STREAM_ID);
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  try {
    jest.advanceTimersByTime(0);
    const socket = MockWebSocket.instances.at(-1)!;
    authenticate(socket);
    socket.message({ type: 'snapshot', sessions: [session], events: [] });
    const request = sentFrames(socket, 'request_stream_events').at(-1)!;
    expect(request).toMatchObject({ stream_id: STREAM_ID, limit: 300 });
    deliverHistory(socket, request, 'settled');
    voiceDelivery.setLifecycle({ foreground: true, unlocked: true });
    await voiceDelivery.initialize();
    const authenticated = stream.voiceTransportSnapshot();
    expect(authenticated).toMatchObject({ ready: true, credentialId, inventoryFresh: true });
    const scope = { serverIdentity: authenticated.serverIdentity, credentialId: authenticated.credentialId! };
    const take = await store.create({
      scope, origin: { streamId: STREAM_ID, generation: 'original', label: 'Fixture' },
      draft: { textPrefix: '', images: [] }, operationKind: 'voice_chat',
    });
    // Four seconds of structurally valid synthetic PCM WAV, not native audio proof.
    const audio = Buffer.alloc(44 + 4 * 8000 * 2);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40); audio.fill(7, 44);
    const uri = `${cacheDirectory}${take.recordingId}.wav`;
    fs.writeFileSync(localPath(uri), audio);
    await voiceDelivery.accept({ streamId: STREAM_ID, recordingId: take.recordingId, uri, mime: 'audio/wav', durationS: 4, levels: [], interrupted: false });
    const finalized = store.get(take.recordingId)!;
    expect(finalized).toMatchObject({ storage: 'finalized', sendRequestedAt: null, origin: take.origin });
    expect(fs.readFileSync(localPath(store.audioUri(finalized)))).toEqual(audio);
    expect(fs.existsSync(localPath(uri))).toBe(false);
    expect(sentFrames(socket, 'upload_blob_init')).toHaveLength(0);
    expect(sentFrames(socket, 'send')).toHaveLength(0);

    const work = voiceDelivery.send(take.recordingId);
    await until(() => sentFrames(socket, 'upload_blob_init').length === 1);
    const upload = sentFrames(socket, 'upload_blob_init')[0];
    expect(upload).toMatchObject({ protocol: 2, upload_id: finalized.audio!.uploadId,
      total_bytes: audio.length, sha256: finalized.audio!.sha256, mime: 'audio/wav', voice_operation: take.operation });
    socket.message({ type: 'upload_blob.init.ok', request_id: upload.request_id, protocol: 2,
      upload_id: upload.upload_id, next_offset: 0, complete: false });
    await until(() => sentFrames(socket, 'upload_blob_chunk').length === 1);
    const chunk = sentFrames(socket, 'upload_blob_chunk')[0];
    expect(chunk).toMatchObject({ protocol: 2, upload_id: upload.upload_id, offset: 0,
      chunk_sha256: finalized.audio!.sha256, final: false });
    expect(Buffer.from(chunk.data_b64 as string, 'base64')).toEqual(audio);
    socket.message({ type: 'upload_blob.ok', request_id: chunk.request_id, protocol: 2,
      upload_id: upload.upload_id, next_offset: audio.length, complete: false });
    await until(() => sentFrames(socket, 'upload_blob_chunk').length === 2);
    const final = sentFrames(socket, 'upload_blob_chunk')[1];
    expect(final).toMatchObject({ protocol: 2, upload_id: upload.upload_id, offset: audio.length, data_b64: '', final: true });
    socket.message({ type: 'upload_blob.ok', request_id: final.request_id, protocol: 2,
      upload_id: upload.upload_id, next_offset: audio.length, complete: true, blob_sha: finalized.audio!.sha256 });
    await until(() => sentFrames(socket, 'transcribe_blob').length === 1);
    const transcription = sentFrames(socket, 'transcribe_blob')[0];
    expect(transcription).toMatchObject({ request_id: `transcribe-${take.recordingId}`,
      blob_sha: finalized.audio!.sha256, voice_operation: take.operation });
    expect(store.get(take.recordingId)).toMatchObject({ sendRequestedAt: expect.any(Number),
      upload: { nextOffset: audio.length, complete: true, blobSha: finalized.audio!.sha256 } });

    socket.close(1006);
    await work;
    jest.advanceTimersByTime(1_100);
    const next = MockWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    authenticate(next);
    await flushMicrotasks(100);
    expect(stream.voiceTransportSnapshot().ready).toBe(false);
    expect(sentFrames(next, 'transcribe_blob')).toHaveLength(0);
    // Reconnect cancels the old delivery epoch. The durable scheduler recovers
    // the same transcription only after authenticating the original inventory.
    next.message({ type: 'snapshot', sessions: [session], events: [] });
    await until(() => sentFrames(next, 'transcribe_blob').length === 1);
    expect(sentFrames(next, 'transcribe_blob')).toEqual([transcription]);
    expect(sentFrames(next, 'upload_blob_init')).toHaveLength(0);
    next.message({ type: 'snapshot', sessions: [{ ...session, session_generation: 'replacement' }], events: [] });
    next.message({ type: 'transcribe_blob.ok', request_id: transcription.request_id, text: 'recovered voice' });
    await until(() => store.get(take.recordingId)?.delivery.phase === 'origin_unavailable');
    expect(sentFrames(next, 'send')).toHaveLength(0);
    expect(MockWebSocket.instances.flatMap(item => sentFrames(item, 'send'))).toHaveLength(0);
    expect(voiceDelivery.snapshot().takes[0]).toMatchObject({ recordingId: take.recordingId,
      status: 'origin_unavailable', error: 'Original chat unavailable' });
    expect(store.get(take.recordingId)).toMatchObject({ storage: 'finalized', origin: take.origin,
      transcription: { requestId: transcription.request_id, result: { text: 'recovered voice' } },
      delivery: { phase: 'origin_unavailable', error: 'origin_unavailable' } });
    expect(store.get(take.recordingId)?.dispatchIntent).toBeUndefined();
    expect(Object.keys(stream.getPentacleStreamState().optimisticSends ?? {})).toEqual([]);
    expect(fs.readFileSync(localPath(store.audioUri(finalized)))).toEqual(audio);
    // A fresh real store must recover the retained audio, transcript and origin
    // from committed manifests, not from the delivery singleton's memory.
    const restored = new VoiceTakeStore();
    await restored.setScope(scope);
    expect(restored.snapshot().recoveryFailures).toEqual([]);
    expect(restored.get(take.recordingId)).toMatchObject({ storage: 'finalized', origin: take.origin,
      sendRequestedAt: expect.any(Number), transcription: { result: { text: 'recovered voice' } },
      delivery: { phase: 'origin_unavailable' } });
    await voiceDelivery.discard(take.recordingId);
    expect(store.get(take.recordingId)).toBeUndefined();
    expect(fs.existsSync(localPath(store.audioUri(finalized)))).toBe(false);
  } finally {
    voiceDelivery.dispose(); unregister(); unsubscribe();
    for (const socket of MockWebSocket.instances) socket.close();
    jest.dontMock('expo-modules-core'); jest.dontMock('expo-file-system/legacy');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
