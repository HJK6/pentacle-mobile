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

const OPERATOR_V2_ENVELOPE = 'pentacle-auth-v2:eyJjbGllbnRfa2luZCI6InBlbnRhY2xlLW1vYmlsZSIsImNyZWRlbnRpYWxfaWQiOiIxMjNlNDU2Ny1lODliLTEyZDMtYTQ1Ni00MjY2MTQxNzQwMDAiLCJwcm9vZl9rZXkiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4IiwidmVyc2lvbiI6Mn0';
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

function mockMonotonicNow(start = 0) {
  let now = start;
  const spy = jest.spyOn(globalThis.performance, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

function latestTimerCallback(spy: jest.SpyInstance, delay: number): () => void {
  const call = [...spy.mock.calls].reverse().find(([, timerDelay]) => timerDelay === delay);
  expect(call).toBeDefined();
  return call?.[0] as () => void;
}

function assistantEvent(text: string, seq: number = 1) {
  return {
    daemon_seq: seq,
    stream_id: 'hostc:codex:one',
    host: 'Hostc',
    provider: 'codex',
    session_name: 'one',
    timestamp: `2026-05-08T00:00:0${seq}Z`,
    kind: 'ASSIST',
    text,
  };
}

test('v2 waits for the operator challenge and never exposes the bearer envelope', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);

  socket.open();
  expect(socket.sent).toEqual([]);
  expect(stream.getPentacleStreamState().connected).toBe(false);

  socket.message(operatorV2Welcome());
  const hello = sentFrames(socket, 'hello')[0];
  expect(hello).toEqual({
    type: 'hello',
    client: 'pentacle-mobile',
    capabilities: { assistant_composite_v1: true },
    auth_v2: {
      scheme: 'hmac-sha256-v2',
      credential_id: '123e4567-e89b-12d3-a456-426614174000',
      proof: 'QWJj1o4FTDWE1plG9nBVmVCzVzmSci7Q1fZkWUoR97w',
    },
    subscribe: { events_mode: 'summary', include_subagents: false },
  });
  expect(JSON.stringify(socket.sent)).not.toContain(OPERATOR_V2_ENVELOPE);
  expect(hello).not.toHaveProperty('token');
  expect(stream.getPentacleStreamState().connected).toBe(true);
  unsubscribe();
});

test('v2 fails closed for missing, downgraded, and forged challenges', () => {
  const cases = [
    { type: 'welcome' },
    operatorV2Welcome({ protocol_version: 1 }),
    operatorV2Welcome({ scheme: 'shared-bearer-v1' }),
    operatorV2Welcome({ nonce: 'forged' }),
  ];
  for (const welcome of cases) {
    const stream = loadStream();
    stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
    const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
    socket.open();
    socket.message(welcome);
    expect(sentFrames(socket, 'hello')).toEqual([]);
    expect(stream.getPentacleStreamState().lastError).toBe('operator_auth_v2_required');
    unsubscribe();
  }
});

test('v2 welcome timeout fails closed without sending hello', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  jest.advanceTimersByTime(5_000);
  expect(sentFrames(socket, 'hello')).toEqual([]);
  expect(stream.getPentacleStreamState().lastError).toBe('operator_auth_v2_required');
  unsubscribe();
});

test('malformed v2 storage fails locally without opening a socket', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken('pentacle-auth-v2:forged');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  expect(MockWebSocket.instances).toEqual([]);
  expect(stream.getPentacleStreamState().lastError).toBe('operator_auth_v2_invalid');
  unsubscribe();
});

test('production clients without a credential require enrollment without opening a socket', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  Reflect.set(process.env, 'NODE_ENV', 'production');
  try {
    const stream = loadStream();
    const unsubscribe = stream.subscribePentacleStream(jest.fn());
    jest.advanceTimersByTime(0);
    expect(MockWebSocket.instances).toEqual([]);
    expect(stream.getPentacleStreamState().lastError).toBe('operator_enrollment_required');
    unsubscribe();
  } finally {
    if (previousNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, 'NODE_ENV');
    } else {
      Reflect.set(process.env, 'NODE_ENV', previousNodeEnv);
    }
  }
});

test('armed auth-disabled harness waits for token reload and connects after a generation change', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.EXPO_PUBLIC_HARNESS = '1';
  try {
    const stream = loadStream();
    const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
    harnessRuntime.applyURL('pentacle://harness?actions=disable_pentacle_auth&ws_url=ws%3A%2F%2F127.0.0.1%3A65015');
    harnessRuntime.beginHarnessTokenReload();
    stream.setPentacleAuthToken('bootstrap-token');
    stream.setPentacleWsUrl('ws://127.0.0.1:65015');
    const unsubscribe = stream.subscribePentacleStream(jest.fn());
    stream.setPentacleAuthToken(null);

    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    expect(MockWebSocket.instances).toEqual([]);

    harnessRuntime.markHarnessTokenReady();
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://127.0.0.1:65015');

    harnessRuntime.reset();
    unsubscribe();
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

test('v2 reconnect repeats challenge proof and never downgrades to bearer hello', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.closeFromServer();
  jest.advanceTimersByTime(1_000);
  const nextSocket = MockWebSocket.instances.at(-1) as MockWebSocket;
  nextSocket.open();
  expect(nextSocket.sent).toEqual([]);
  nextSocket.message(operatorV2Welcome());
  const hello = sentFrames(nextSocket, 'hello')[0];
  expect(hello).toHaveProperty('auth_v2');
  expect(hello).not.toHaveProperty('token');
  unsubscribe();
});

test('raw bearer clients preserve eager legacy hello behavior', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken('legacy-bearer');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  expect(sentFrames(socket, 'hello')[0]).toMatchObject({
    client: 'pentacle-mobile',
    token: 'legacy-bearer',
  });
  unsubscribe();
});

function sessionSummary(streamId = 'hostc:codex:one', overrides: Record<string, unknown> = {}) {
  return {
    stream_id: streamId,
    host: 'hostc',
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
    stream_id: 'hostc:codex:one',
    host: 'hostc',
    provider: 'codex',
    session_id: 'hostc:codex:one',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}

test('wire-level trusted status correction never renders an internal notice while stale replay cannot downgrade it', () => {
  const fixture = require('../fixtures/trusted_status_wire_v1.json') as {
    stream_id: string;
    frames: Record<string, { type: string; event: Record<string, unknown> }>;
  };
  const streamId = fixture.stream_id;
  const beforeFrame = fixture.frames.before_proof;
  const correctionFrame = fixture.frames.corrected_same_id;
  const explicitUserFrame = fixture.frames.negative_explicit_user_identical_body;
  const copiedMarkerFrame = fixture.frames.negative_receiptless_copied_marker;
  const body = String(beforeFrame.event.text);
  const eventId = Number(beforeFrame.event.daemon_seq);
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary(streamId, {
      host: 'hosta',
      session_name: 'status-wire-fixture',
      working: false,
    })],
    events: [],
  });
  const visibleRows = () => {
    core.invalidateSessionDetailCache(streamId);
    return core.selectSessionDetail(
      stream.getPentacleStreamState(),
      streamId,
      { visibleCount: 'all' },
    )?.transcriptItems ?? [];
  };

  socket.message(beforeFrame);
  // The pinned core's envelope registry now recognizes this trusted internal
  // notice at first arrival. It must not briefly expose raw orchestration text
  // while a later same-ID status correction is still in flight.
  expect(visibleRows().map((item) => item.text)).not.toContain(body);

  socket.message(correctionFrame);
  expect(stream.getPentacleStreamState().events.filter((event) => event.daemon_seq === eventId)).toHaveLength(1);
  expect(visibleRows().map((item) => item.text)).not.toContain(body);

  socket.message(beforeFrame);
  expect(stream.getPentacleStreamState().events.filter((event) => event.daemon_seq === eventId)).toHaveLength(1);
  expect(visibleRows().map((item) => item.text)).not.toContain(body);

  socket.message(explicitUserFrame);
  socket.message(copiedMarkerFrame);
  // An explicit client-originated USER row remains a real transcript item; an
  // unbound, receiptless marker is registry-classified as internal. This keeps
  // client intent distinct from daemon/control-plane presentation noise without
  // re-exposing the raw marker row.
  const matchingRows = visibleRows().filter((item) => item.text === body);
  expect(matchingRows).toHaveLength(1);
  expect(matchingRows[0]?.optimisticId).toBe('optimistic-fixture-user-copy');
  unsubscribe();
});

test('connects, opens, and dispatches snapshot messages to subscribers', () => {
  const stream = loadStream();
  const listener = jest.fn();

  const unsubscribe = stream.subscribePentacleStream(listener);
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  expect(socket.url).toBe('ws://default.example/ws');
  expect(stream.getPentacleStreamState().connecting).toBe(true);

  socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({
    type: 'hello',
    client: 'pentacle-mobile',
    capabilities: { assistant_composite_v1: true },
    subscribe: { events_mode: 'summary', include_subagents: false },
  });
  expect(sentFrames(socket, 'specs.capabilities')).toHaveLength(1);
  expect(sentFrames(socket, 'specs.capabilities')[0]?.request_id).toEqual(expect.any(String));

  socket.message({
    type: 'specs.capabilities.ok',
    statuses: [{ name: 'in_progress', display_label: 'In Progress', color: '#3dff66' }],
  });
  expect(stream.getPentacleStreamState().specStatuses).toEqual([
    { name: 'in_progress', display_label: 'In Progress', color: '#3dff66' },
  ]);
  socket.message({ type: 'specs.capabilities.ok', statuses: 'malformed' });
  expect(stream.getPentacleStreamState().specStatuses).toHaveLength(1);
  socket.message({ type: 'specs.capabilities.error', error: 'temporarily unavailable' });
  expect(stream.getPentacleStreamState().specStatuses).toHaveLength(1);
  socket.message({ type: 'specs.capabilities.ok', statuses: [{ name: ' mystery ', color: 'not-a-native-color' }] });
  expect(stream.getPentacleStreamState().specStatuses).toEqual([{ name: 'mystery', color: undefined }]);

  socket.message({
    type: 'snapshot',
    sessions: [
      {
        stream_id: 'alpha:codex:one',
        host: 'Hostc',
        provider: 'codex',
        session_name: 'one',
        last_event_at: '2026-05-08T00:00:00Z',
        last_text: 'hello',
        last_kind: 'ASSIST',
        online: true,
      },
    ],
    events: [
      {
        daemon_seq: 1,
        stream_id: 'alpha:codex:one',
        host: 'Hostc',
        provider: 'codex',
        session_name: 'one',
        timestamp: '2026-05-08T00:00:00Z',
        kind: 'ASSIST',
        text: 'hello',
      },
    ],
  });

  expect(stream.getPentacleStreamState().connected).toBe(true);
  expect(stream.getPentacleStreamState().sessions).toHaveLength(1);
  expect(stream.getPentacleStreamState().events).toHaveLength(1);
  expect(listener).toHaveBeenCalled();
  unsubscribe();
});

test('request_stream_events preserves an explicit null correlation for current-tail ordering', async () => {
  const stream = loadStream();
  const { socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      daemon_seq: 356586,
      correlatedDaemonSeq: 356586,
      timestamp: '2026-08-02T23:40:13.570Z',
    }),
  });
  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 5, { purpose: 'mount-fetch' });
  const request = sentFrames(socket, 'request_stream_events').at(-1) as Record<string, unknown>;

  socket.message({
    type: 'request_stream_events.ok',
    request_id: request.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({
      daemon_seq: 356645,
      correlatedDaemonSeq: null,
      timestamp: '2026-08-02T23:45:07.880Z',
    })],
  });
  await fetchPromise;

  expect(stream.getPentacleStreamState().events).toEqual(expect.arrayContaining([
    expect.objectContaining({ daemon_seq: 356645, correlatedDaemonSeq: null }),
  ]));
});

test('request_stream_events.ok applies fetched history as one store emission', async () => {
  const stream = loadStream();
  const listener = jest.fn();
  const unsubscribe = stream.subscribePentacleStream(listener);
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  listener.mockClear();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'hostc:codex:one',
    events: [
      pentacleEvent({ daemon_seq: 1, text: 'first' }),
      pentacleEvent({ daemon_seq: 2, text: 'second' }),
      pentacleEvent({ daemon_seq: 3, text: 'third' }),
    ],
  });

  await expect(fetchPromise).resolves.toHaveLength(3);
  expect(stream.getPentacleStreamState().events.map((event) => event.text)).toEqual(['first', 'second', 'third']);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test('older-page chunks commit atomically before the cursor request resolves', async () => {
  const stream = loadStream();
  const listener = jest.fn();
  const unsubscribe = stream.subscribePentacleStream(listener);
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  listener.mockClear();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 48, { purpose: 'older-page' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  const events = Array.from({ length: 48 }, (_, index) => pentacleEvent({
    daemon_seq: index + 1,
    text: `history ${index + 1}`,
  }));
  socket.message({
    type: 'request_stream_events.chunk',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: events.slice(0, 8),
    complete: false,
  });
  expect(stream.getPentacleStreamState().events).toHaveLength(0);
  expect(stream.__buildStreamEventsRequestPayloadForTests('hostc:codex:one', 48, 'older-page')).not.toHaveProperty(
    'before_daemon_seq',
  );
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: events.slice(8),
    complete: true,
  });

  await expect(fetchPromise).resolves.toHaveLength(48);
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toHaveLength(48);
  expect(stream.__buildStreamEventsRequestPayloadForTests('hostc:codex:one', 48, 'older-page')).toMatchObject({
    before_daemon_seq: 1,
  });
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test('current-tail chunks decide freshness atomically and retain valid older rows', async () => {
  const stream = loadStream();
  const listener = jest.fn();
  const unsubscribe = stream.subscribePentacleStream(listener);
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  listener.mockClear();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 2, { purpose: 'freshness-guard' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.chunk',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 101, text: 'newest chunk row' })],
  });
  socket.message({
    type: 'request_stream_events.chunk',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 100, text: 'valid older chunk row' })],
  });
  expect(stream.getPentacleStreamState().events).toHaveLength(0);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
    complete: true,
  });

  await expect(fetchPromise).resolves.toHaveLength(2);
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([101, 100]);
  expect(stream.__buildStreamEventsRequestPayloadForTests('hostc:codex:one', 48, 'older-page')).toMatchObject({
    before_daemon_seq: 100,
  });
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test('empty older-page completion flips the affordance with one cursor-only notification', async () => {
  const stream = loadStream();
  const listener = jest.fn();
  const unsubscribe = stream.subscribePentacleStream(listener);
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const initialPromise = stream.requestStreamEvents('hostc:codex:one', 3);
  const initial = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: initial.request_id,
    stream_id: 'hostc:codex:one',
    events: [1, 2, 3].map((daemon_seq) => pentacleEvent({ daemon_seq, text: `history ${daemon_seq}` })),
    complete: true,
  });
  await initialPromise;
  expect(stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage).toBe(true);
  listener.mockClear();

  const emptyPromise = stream.requestStreamEvents('hostc:codex:one', 48, { purpose: 'older-page' });
  const empty = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: empty.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
    complete: true,
  });

  await expect(emptyPromise).resolves.toEqual([]);
  expect(stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

test('request_stream_events.chunk refreshes the pending RPC timeout', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 50);
  const fetchPayload = sentFrames(socket, 'request_stream_events').at(-1);
  jest.advanceTimersByTime(29_999);
  socket.message({
    type: 'request_stream_events.chunk',
    request_id: fetchPayload?.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 40, text: 'progress chunk' })],
  });
  jest.advanceTimersByTime(29_999);

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().events.map((event) => event.text)).toEqual(['progress chunk']);

  jest.advanceTimersByTime(1);
  await expect(fetchPromise).rejects.toThrow('timed out');
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  unsubscribe();
});

test('background history RPC timeout does not close a socket with a send in flight', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const fetchPromise = stream.requestStreamEvents('hostc:codex:background', 50);
  const fetchPayload = sentFrames(socket, 'request_stream_events').at(-1);
  expect(fetchPayload?.stream_id).toBe('hostc:codex:background');
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:background']?.requestsByWindow?.history?.token)
    .toBe(fetchPayload?.request_id);
  const fetchExpectation = expect(fetchPromise).rejects.toThrow('timed out');

  jest.advanceTimersByTime(10_000);
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'send while history waits');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'send while history waits' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:background']?.requestsByWindow?.history?.token)
    .toBe(fetchPayload?.request_id);

  jest.advanceTimersByTime(20_000);
  await fetchExpectation;
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().connected).toBe(true);
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:background']).toMatchObject({
    coverageByWindow: { history: { complete: false } },
    requestsByWindow: { history: { status: 'error' } },
  });
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload?.request_id,
    stream_id: 'hostc:codex:background',
    events: [pentacleEvent({ stream_id: 'hostc:codex:background', daemon_seq: 1 })],
  });
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:background']?.events).toEqual([]);

  socket.message({ type: 'send.result', request_id: sendPayload?.request_id, delivery: 'landed' });
  await expect(sendPromise).resolves.toBe(true);
  unsubscribe();
});

// L3 reconnect-hardening regression (chat_reconnect order-dependent flake):
// a connect-time RPC's own 30s timeout is anchored to when it was SENT, not
// to the last real inbound frame. If later frames land after the request
// but before the transport truly goes silent, the request's clock reaches
// zero before a full WATCHDOG_NO_FRAME_MS has elapsed since the last frame —
// misreporting a genuinely-dead transport as a one-off 'rpc_timeout'. This
// races with ambient timing (daemon/simulator load), which is exactly why
// chat_reconnect passed alone but failed in the full sweep.
test('command timeout ambiguous at fire time resolves against the true last-frame reference, not the request clock', async () => {
  const stream = loadStream();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  // Connect-time fetch, issued in the same tick as lastFrameReceivedAt's
  // initial stamp (mirrors refetchFocusedStreamTail firing from onopen).
  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 50);
  const fetchExpectation = expect(fetchPromise).rejects.toThrow('timed out');

  // Real frames keep arriving for a couple seconds after the request was
  // sent (hello snapshot settling), advancing the true last-frame time
  // past the request's issue time. Then the transport goes silent.
  jest.advanceTimersByTime(2_000);
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  // The request's own 30s-from-issue timer fires here — only 28s have
  // actually elapsed since the last real frame, so this must NOT yet
  // conclude 'rpc_timeout' outright.
  jest.advanceTimersByTime(28_000);
  await fetchExpectation;
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(seen.find((p) => p.message === TELEMETRY_EVENTS.CHAT_WS_CLOSE)).toBeUndefined();

  // Once the remaining 2s to the true watchdog boundary elapse with no
  // further frames, the close must land as the real diagnosis.
  jest.advanceTimersByTime(2_000);
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: TELEMETRY_EVENTS.CHAT_WS_CLOSE,
      data: expect.objectContaining({ reason: 'watchdog_no_inbound_frame' }),
    }),
  ]));

  telemetry.setTelemetrySink(null);
  unsubscribe();
});

test('command timeout ambiguous at fire time stays rpc_timeout when a later frame proves the transport alive', async () => {
  const stream = loadStream();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 50);
  const fetchExpectation = expect(fetchPromise).rejects.toThrow('timed out');

  jest.advanceTimersByTime(2_000);
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  jest.advanceTimersByTime(28_000);
  await fetchExpectation;
  expect(socket.readyState).toBe(MockWebSocket.OPEN);

  // A genuinely-unrelated frame lands during the ambiguity window — proof
  // the transport is alive; only this one command was lost.
  jest.advanceTimersByTime(1_000);
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: true })] });

  jest.advanceTimersByTime(1_000);
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: TELEMETRY_EVENTS.CHAT_WS_CLOSE,
      data: expect.objectContaining({ reason: 'rpc_timeout' }),
    }),
  ]));
  jest.advanceTimersByTime(1_500);
  expect(stream.getPentacleStreamState().lastError).toBe('Pentacle command timed out');
  expect(stream.getPentacleStreamState().lastError).not.toMatch(/tailnet|Tailscale/i);

  telemetry.setTelemetrySink(null);
  unsubscribe();
});

test('progressive history chunks retain their safe older-page cursor across reconnect', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const partialPromise = stream.requestStreamEvents('hostc:codex:one', 300, { purpose: 'mount-fetch' });
  const firstPayload = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({
    type: 'request_stream_events.chunk',
    request_id: firstPayload?.request_id,
    stream_id: 'hostc:codex:one',
    events: [
      pentacleEvent({ daemon_seq: 9, text: 'history 9' }),
      pentacleEvent({ daemon_seq: 10, text: 'history 10' }),
    ],
  });
  socket.closeFromServer();
  await expect(partialPromise).rejects.toThrow('disconnected');

  jest.advanceTimersByTime(1_000);
  const reconnect = MockWebSocket.instances[1];
  reconnect.open();

  const resumePromise = stream.requestStreamEvents('hostc:codex:one', 300, { purpose: 'older-page' });
  const resumePayload = sentFrames(reconnect, 'request_stream_events').at(-1);
  expect(resumePayload).toMatchObject({ before_daemon_seq: 9 });
  reconnect.message({
    type: 'request_stream_events.ok',
    request_id: resumePayload?.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 1, text: 'history 1' })],
    complete: true,
  });
  await expect(resumePromise).resolves.toHaveLength(1);

  jest.advanceTimersByTime(0);
  await flushMicrotasks();
  const requests = sentFrames(reconnect, 'request_stream_events');
  expect(requests).toHaveLength(1);
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([9, 10, 1]);
  unsubscribe();
});

test('intent prefetch + equal mount fallback share one production first-paint request', async () => {
  const { INITIAL_CHAT_FETCH_LIMIT } = require('../../src/services/chatLoadTuning');
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');
  const mountPromise = stream.requestStreamEvents('hostc:codex:one', INITIAL_CHAT_FETCH_LIMIT, {
    purpose: 'mount-fetch',
    entrySource: 'press-in',
  });

  const requests = sentFrames(socket, 'request_stream_events');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ stream_id: 'hostc:codex:one', limit: INITIAL_CHAT_FETCH_LIMIT });

  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(1);

  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[0].request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 1, text: 'fast paint' })],
  });

  await expect(mountPromise).resolves.toHaveLength(1);
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(1);
  unsubscribe();
});

test('completed prefetch exposes fresh bucket load state and reconnect makes it revalidateable', async () => {
  const { INITIAL_CHAT_FETCH_LIMIT } = require('../../src/services/chatLoadTuning');
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');
  const request = sentFrames(socket, 'request_stream_events')[0];
  socket.message({
    type: 'request_stream_events.ok',
    request_id: request.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
    complete: true,
  });
  await flushMicrotasks();

  expect(stream.selectStreamEventsLoadState(
    stream.getPentacleStreamState(),
    'hostc:codex:one',
  )).toMatchObject({ currentGenerationComplete: true, fresh: true, requestStatus: 'ready' });
  expect(request.limit).toBe(INITIAL_CHAT_FETCH_LIMIT);

  socket.closeFromServer();
  jest.advanceTimersByTime(1_000);
  MockWebSocket.instances[1].open();

  expect(stream.selectStreamEventsLoadState(
    stream.getPentacleStreamState(),
    'hostc:codex:one',
  )).toMatchObject({ currentGenerationComplete: false, fresh: false });
  unsubscribe();
});

test('intent prefetch + unequal mount fallback keep distinct request windows', async () => {
  const { INITIAL_CHAT_FETCH_LIMIT } = require('../../src/services/chatLoadTuning');
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');
  const mountPromise = stream.requestStreamEvents('hostc:codex:one', INITIAL_CHAT_FETCH_LIMIT + 1, {
    purpose: 'mount-fetch',
    entrySource: 'press-in',
  });

  const requests = sentFrames(socket, 'request_stream_events');
  expect((requests.map((request) => request.limit) as number[]).sort((a, b) => a - b)).toEqual([
    INITIAL_CHAT_FETCH_LIMIT,
    INITIAL_CHAT_FETCH_LIMIT + 1,
  ]);
  for (const request of requests) {
    socket.message({
      type: 'request_stream_events.ok',
      request_id: request.request_id,
      stream_id: 'hostc:codex:one',
      events: [pentacleEvent({ daemon_seq: request.limit, text: 'window' })],
    });
  }

  await expect(mountPromise).resolves.toHaveLength(1);
  unsubscribe();
});

test('undersized in-flight history defers but cannot consume a larger prefetch intent', async () => {
  const { INITIAL_CHAT_FETCH_LIMIT } = require('../../src/services/chatLoadTuning');
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const shortPromise = stream.requestStreamEvents('hostc:codex:one', INITIAL_CHAT_FETCH_LIMIT - 1, {
    purpose: 'mount-fetch',
  });
  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');
  let requests = sentFrames(socket, 'request_stream_events');
  expect(requests).toHaveLength(1);

  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[0].request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 1, text: 'short window' })],
  });
  await shortPromise;
  await flushMicrotasks(8);
  requests = sentFrames(socket, 'request_stream_events');
  expect(requests).toHaveLength(2);
  expect(requests[1].limit).toBe(INITIAL_CHAT_FETCH_LIMIT);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[1].request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks(8);
  unsubscribe();
});

test.each(['freshness-guard', 'focused-refetch'] as const)(
  '%s current-tail request cannot consume a compatible-limit history prefetch',
  async (purpose) => {
    const { INITIAL_CHAT_FETCH_LIMIT } = require('../../src/services/chatLoadTuning');
    const stream = loadStream();
    const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
    socket.open();

    const currentTailPromise = stream.requestStreamEvents('hostc:codex:one', INITIAL_CHAT_FETCH_LIMIT, {
      purpose,
    });
    stream.prefetchStreamEvents('hostc:codex:one', 'press-in');

    const requests = sentFrames(socket, 'request_stream_events');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      socket.message({
        type: 'request_stream_events.ok',
        request_id: request.request_id,
        stream_id: 'hostc:codex:one',
        events: [],
      });
    }

    await expect(currentTailPromise).resolves.toEqual([]);
    await flushMicrotasks(8);
    unsubscribe();
  },
);

test('older-page in-flight request cannot consume a compatible-limit history prefetch', async () => {
  const { INITIAL_CHAT_FETCH_LIMIT } = require('../../src/services/chatLoadTuning');
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const olderPagePromise = stream.requestStreamEvents('hostc:codex:one', INITIAL_CHAT_FETCH_LIMIT, {
    purpose: 'older-page',
  });
  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');

  const requests = sentFrames(socket, 'request_stream_events');
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    socket.message({
      type: 'request_stream_events.ok',
      request_id: request.request_id,
      stream_id: 'hostc:codex:one',
      events: [],
    });
  }

  await expect(olderPagePromise).resolves.toEqual([]);
  await flushMicrotasks(8);
  unsubscribe();
});

test('freshness refetch retains its newer tail when an in-flight mount response arrives late', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const mountPromise = stream.requestStreamEvents('hostc:codex:one', 300, {
    purpose: 'mount-fetch',
    entrySource: 'press-in',
  });
  const freshnessPromise = stream.requestStreamEvents('hostc:codex:one', 300, {
    purpose: 'freshness-guard',
    entrySource: 'press-in',
  });

  const requests = sentFrames(socket, 'request_stream_events');
  expect(requests).toHaveLength(2);

  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[1].request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 10, text: 'fresh tail while history drains' })],
  });
  await expect(freshnessPromise).resolves.toHaveLength(1);

  socket.message({
    type: 'request_stream_events.chunk',
    request_id: requests[0].request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 1, text: 'older mount history' })],
  });
  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[0].request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await expect(mountPromise).resolves.toHaveLength(1);

  expect(stream.getPentacleStreamState().events.map((event) => event.text)).toEqual([
    'fresh tail while history drains',
    'older mount history',
  ]);
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:one']?.coverageByWindow).toMatchObject({
    history: { complete: true, requestLimit: 300 },
    'current-tail': { complete: true, requestLimit: 300 },
  });
  unsubscribe();
});

test('intent prefetch queue is LIFO, concurrency-capped, supersedes flung-past rows, and session-dedups', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  stream.prefetchSettledStreams([
    'hostc:codex:oldest',
    'hostc:codex:middle',
    'hostc:codex:newest',
  ], 'list-settle');

  let requests = sentFrames(socket, 'request_stream_events');
  expect(requests.map((request) => request.stream_id)).toEqual([
    'hostc:codex:newest',
    'hostc:codex:middle',
  ]);

  stream.prefetchSettledStreams(['hostc:codex:replacement'], 'list-settle');
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(2);

  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[0].request_id,
    stream_id: 'hostc:codex:newest',
    events: [pentacleEvent({ stream_id: 'hostc:codex:newest', daemon_seq: 1, text: 'newest' })],
  });
  await flushMicrotasks(8);

  requests = sentFrames(socket, 'request_stream_events');
  expect(requests.map((request) => request.stream_id)).toEqual([
    'hostc:codex:newest',
    'hostc:codex:middle',
    'hostc:codex:replacement',
  ]);

  socket.message({
    type: 'request_stream_events.ok',
    request_id: requests[2].request_id,
    stream_id: 'hostc:codex:replacement',
    events: [pentacleEvent({ stream_id: 'hostc:codex:replacement', daemon_seq: 2, text: 'replacement' })],
  });
  await flushMicrotasks();

  stream.prefetchStreamEvents('hostc:codex:replacement', 'press-in');
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(3);
  await flushMicrotasks(8);
  const completedAt = Date.now();
  const now = jest.spyOn(Date, 'now').mockReturnValue(completedAt + 5 * 60 * 1000 + 1);
  stream.prefetchStreamEvents('hostc:codex:replacement', 'press-in');
  await flushMicrotasks(8);
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(4);
  now.mockRestore();
  unsubscribe();
});

test('intent prefetch merge keeps focused slice stable for unrelated streams and emits no render telemetry', async () => {
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const telemetrySink = jest.fn();
  core.setTelemetrySink(telemetrySink);
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [
      sessionSummary('hostc:codex:focused'),
      sessionSummary('hostc:codex:background'),
    ],
  });
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ stream_id: 'hostc:codex:focused', daemon_seq: 1, text: 'focused' }),
  });
  const before = stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:focused');
  telemetrySink.mockClear();

  stream.prefetchStreamEvents('hostc:codex:background', 'list-settle');
  const request = sentFrames(socket, 'request_stream_events').at(-1) as Record<string, unknown>;
  socket.message({
    type: 'request_stream_events.ok',
    request_id: request.request_id,
    stream_id: 'hostc:codex:background',
    events: [
      pentacleEvent({ stream_id: 'hostc:codex:background', daemon_seq: 2, text: 'background' }),
    ],
  });
  await flushMicrotasks();

  const after = stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:focused');
  expect(after).toBe(before);
  expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
    message: core.TELEMETRY_EVENTS.CHAT_EVENT_RENDERED,
  }));
  core.setTelemetrySink(null);
  unsubscribe();
});

test('request_stream_events.ok recovers missed slow-consumer history without duplicating live rows', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 7, text: 'live before slow consumer' }) });
  socket.closeFromServer();
  jest.advanceTimersByTime(1000);
  const reconnect = MockWebSocket.instances[1];
  reconnect.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 10);
  const fetchPayload = JSON.parse(reconnect.sent.at(-1) || '{}');
  reconnect.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'hostc:codex:one',
    events: [
      pentacleEvent({ daemon_seq: 7, text: 'live before slow consumer' }),
      pentacleEvent({ daemon_seq: 8, kind: 'USER', text: 'operator after slow consumer', timestamp: '2026-05-08T00:00:08Z' }),
    ],
  });

  await expect(fetchPromise).resolves.toHaveLength(2);
  expect(stream.getPentacleStreamState().events.map((event) => event.text)).toEqual([
    'live before slow consumer',
    'operator after slow consumer',
  ]);
  expect(stream.getPentacleStreamState().events.filter((event) => event.daemon_seq === 7)).toHaveLength(1);
  unsubscribe();
});

test('consecutive live bulk frames stay batched after an empty timer expiry', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, text: 'leading assist' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);

  jest.advanceTimersByTime(1000);
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 2, text: 'batched assist 2' }) });
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 3, text: 'batched assist 3' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 4, kind: 'USER', text: 'operator interrupt' }),
  });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 2, 3, 4]);
  unregisterFocus();
  unsubscribe();
});

test('gapped cross-stream bulk frames stay batched after an empty timer expiry', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, stream_id: 'hostc:codex:one' }) });
  jest.advanceTimersByTime(1000);
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 200, stream_id: 'hostc:codex:two' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 201, stream_id: 'hostc:codex:two', kind: 'USER' }),
  });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 200, 201]);
  unsubscribe();
});

test('a monotonic per-stream continuation stays batched when newer cross-stream traffic advanced the global cursor', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, stream_id: 'hostc:codex:visible' }) });
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 19120, stream_id: 'hostc:codex:filtered' }) });
  jest.advanceTimersByTime(240);
  jest.advanceTimersByTime(240);

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 3000, stream_id: 'hostc:codex:visible' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 19120]);

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 3001, stream_id: 'hostc:codex:visible', kind: 'USER' }),
  });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 19120, 3000, 3001]);
  unsubscribe();
});

test('the 1200-row cap resets the quiet window for a sustained gapped cross-stream flood', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, stream_id: 'hostc:codex:00' }) });
  jest.advanceTimersByTime(239);
  for (let seq = 2; seq <= 1201; seq += 1) {
    socket.message({
      type: 'chat.event',
      event: pentacleEvent({ daemon_seq: seq, stream_id: `hostc:codex:${String(seq % 64).padStart(2, '0')}` }),
    });
  }
  expect(stream.getPentacleStreamState().events).toHaveLength(1201);

  jest.advanceTimersByTime(1);
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 3000, stream_id: 'hostc:codex:47' }) });
  expect(stream.getPentacleStreamState().events).toHaveLength(1201);

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 3001, stream_id: 'hostc:codex:47', kind: 'USER' }),
  });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq).slice(-2)).toEqual([3000, 3001]);
  unsubscribe();
});

test('a genuinely quiet transition starts a new background leading edge', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, stream_id: 'hostc:codex:one' }) });
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 2, stream_id: 'hostc:codex:two' }) });
  jest.advanceTimersByTime(240);
  jest.advanceTimersByTime(240);

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 3000, stream_id: 'hostc:codex:three' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 2, 3000]);
  unsubscribe();
});

test('a genuinely quiet existing stream starts a new leading edge when the global cursor is behind', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, stream_id: 'hostc:codex:existing' }) });
  jest.advanceTimersByTime(1000);
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 3000, stream_id: 'hostc:codex:existing' }) });

  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 3000]);
  unsubscribe();
});

test('an equal global cursor replay stays deduped after a genuine quiet transition', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const replay = pentacleEvent({ daemon_seq: 1, stream_id: 'hostc:codex:replay' });
  socket.message({ type: 'chat.event', event: replay });
  jest.advanceTimersByTime(1000);
  socket.message({ type: 'chat.event', event: replay });

  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);
  unsubscribe();
});

test('armed harness reports bounded per-listener elapsed metadata for store emits', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  harnessRuntime.applyURL('pentacle://harness?actions=all_chats_regression&scenario=listener-timing');

  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const timing = seen.find((payload) => (
    String(payload.message) === 'harness:ui_trace' && payload.data?.kind === 'store_listener_timing'
  ));

  expect(timing?.data).toMatchObject({
    path: 'direct',
    listener_count: 1,
    events_count: 0,
  });
  expect(timing?.data?.listener_ms).toEqual([expect.any(Number)]);
  expect(timing?.data).not.toHaveProperty('state');
  core.setTelemetrySink(null);
  unsubscribe();
});

test('a current live terminal flushes lower batched rows and settles a pending optimistic turn', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const optimisticId = stream.sendTurn('hostc:codex:one', 'current turn');
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 10, kind: 'USER', text: 'current turn', optimistic_id: optimisticId, client_origin: false }),
  });
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 11, kind: 'ASSIST', text: 'lower queued row' }) });
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 12, kind: 'SYSTEM', text: 'Worked for 1s', raw: { subtype: 'turn-summary' } }),
  });

  expect(stream.getPentacleStreamState().events
    .map((event) => Number(event.correlatedDaemonSeq ?? event.daemon_seq))
    .filter(Number.isFinite)).toEqual([10, 11, 12]);
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('idle');
  unregisterFocus();
  unsubscribe();
});

test('stale and replayed terminals cannot settle a newer pending optimistic turn', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });
  const priorOptimisticId = stream.enqueueTurn('hostc:codex:one', 'known prior row');
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      daemon_seq: 10,
      kind: 'USER',
      text: 'known prior row',
      optimistic_id: priorOptimisticId,
      client_origin: false,
    }),
  });
  socket.closeFromServer();
  jest.advanceTimersByTime(1_000);
  const reconnect = MockWebSocket.instances[1];
  reconnect.open();
  const staleTerminal = pentacleEvent({
    daemon_seq: 9,
    kind: 'SYSTEM',
    text: 'Worked for prior turn',
    raw: { subtype: 'turn-summary' },
  });
  const newerOptimisticId = stream.sendTurn('hostc:codex:one', 'newer turn');
  expect(newerOptimisticId).not.toBe('');
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');
  reconnect.message({ type: 'chat.event', event: staleTerminal });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');

  const delayedPriorTerminal = pentacleEvent({
    daemon_seq: 11,
    kind: 'SYSTEM',
    text: 'Worked for prior turn',
    raw: { subtype: 'turn-summary' },
  });
  reconnect.message({ type: 'chat.event', event: delayedPriorTerminal });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');
  reconnect.message({
    type: 'chat.event',
    event: pentacleEvent({
      daemon_seq: 12,
      kind: 'USER',
      text: 'newer turn',
      optimistic_id: newerOptimisticId,
      client_origin: false,
    }),
  });
  reconnect.closeFromServer();
  jest.advanceTimersByTime(1_000);
  const secondReconnect = MockWebSocket.instances[2];
  secondReconnect.open();
  secondReconnect.message({ type: 'chat.event', event: delayedPriorTerminal });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');
  const currentTerminal = pentacleEvent({
    daemon_seq: 13,
    kind: 'SYSTEM',
    text: 'Worked for current turn',
    raw: { subtype: 'turn-summary' },
  });
  secondReconnect.message({ type: 'chat.event', event: currentTerminal });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('idle');
  const appliedSeqs = stream.getPentacleStreamState().events
    .map((event) => Number(event.correlatedDaemonSeq ?? event.daemon_seq))
    .filter(Number.isFinite);
  for (const seq of [11, 12, 13]) {
    expect(appliedSeqs.filter((candidate) => candidate === seq)).toHaveLength(1);
  }
  stream.sendTurn('hostc:codex:one', 'newest turn');
  secondReconnect.message({ type: 'chat.event', event: currentTerminal });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');
  unregisterFocus();
  unsubscribe();
});

test('failed and cancelled optimistic rows do not block a current terminal', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const failedId = stream.sendTurn('hostc:codex:one', 'failed turn');
  stream.markOptimisticFailed(failedId, 'send_error');
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 20, kind: 'SYSTEM', text: 'Worked for failed turn', raw: { subtype: 'turn-summary' } }),
  });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('idle');

  const cancelledId = stream.sendTurn('hostc:codex:one', 'cancelled turn');
  stream.markOptimisticFailed(cancelledId, 'cancelled');
  const cancelled = stream.getPentacleStreamState().optimisticSends?.[cancelledId];
  if (!cancelled) throw new Error('missing cancelled optimistic row');
  cancelled.status = 'cancelled';
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 21, kind: 'SYSTEM', text: 'Worked for cancelled turn', raw: { subtype: 'turn-summary' } }),
  });
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('idle');
  unregisterFocus();
  unsubscribe();
});

test('natural reconnect flushes a queued newest live row before clearing its batch timer', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, text: 'visible first' }) });
  jest.advanceTimersByTime(1000);
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 2, text: 'newest before disconnect' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);

  socket.closeFromServer();
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 2]);
  unregisterFocus();
  unsubscribe();
});

test('a new background session event does not surface a row pre-inventory, nor drain an unrelated focused flood', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));
  harnessRuntime.applyURL('pentacle://harness?actions=composite_chat_load_probe&scenario=create_under_load');

  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:focused');

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      stream_id: 'hostc:codex:focused',
      session_id: 'hostc:codex:focused',
      daemon_seq: 640,
      raw: {
        _harness_replay_timing: {
          harness_run_id: 'removal-run',
          frame_id: 'stream-0640',
          fixture_at_ms: 5112,
          injector_send_wall_ms: Date.now() - 14,
          daemon_accept_wall_ms: Date.now() - 13,
          daemon_socket_write_start_wall_ms: Date.now() - 12,
        },
      },
    }),
  });
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ stream_id: 'hostc:codex:focused', session_id: 'hostc:codex:focused', daemon_seq: 641 }),
  });
  expect(stream.getPentacleStreamState().events.some((event) => event.daemon_seq === 641)).toBe(false);

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      stream_id: 'hostc:codex:created-chat',
      session_id: 'hostc:codex:created-chat',
      session_name: 'created-chat',
      daemon_seq: 642,
      kind: 'USER',
      text: 'created under load',
      raw: {
        _harness_replay_timing: {
          fixture_at_ms: 1400,
          fixture_due_wall_ms: Date.now() - 20,
          injector_send_wall_ms: Date.now() - 18,
          daemon_accept_wall_ms: Date.now() - 16,
          daemon_socket_write_start_wall_ms: Date.now() - 12,
        },
      },
    }),
  });

  // Mirror-freshness fail-closed: a new session's first live event carries no
  // visibility, so it does NOT surface a list row until its inventory row lands
  // (a hidden session must never flash in). The event is still recorded.
  expect(stream.getPentacleStreamState().sessions.some((session) => session.stream_id === 'hostc:codex:created-chat')).toBe(false);
  expect(stream.getPentacleStreamState().events.some((event) => event.stream_id === 'hostc:codex:created-chat' && event.daemon_seq === 642)).toBe(true);
  expect(stream.getPentacleStreamState().events.some((event) => event.daemon_seq === 641)).toBe(false);
  const received = seen.find((payload) => payload.data.kind === 'live_new_session_event_received');
  const applied = seen.find((payload) => payload.data.kind === 'live_new_session_event_applied');
  const wsCallback = seen.find((payload) => payload.data.kind === 'live_new_session_ws_callback');
  expect(wsCallback?.data).toMatchObject({
    stream_id: 'hostc:codex:created-chat',
    seq: 642,
    fixture_at_ms: 1400,
    socket_write_start_to_ws_callback_ms: 12,
  });
  expect(received?.data).toMatchObject({
    stream_id: 'hostc:codex:created-chat',
    seq: 642,
    queued_same_stream_count: 0,
    queued_other_stream_count: 1,
  });
  expect(applied?.data).toMatchObject({
    stream_id: 'hostc:codex:created-chat',
    seq: 642,
    // Applied (event recorded) but the row is deferred to the inventory row.
    surfaced: false,
  });
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ stream_id: 'hostc:codex:focused', session_id: 'hostc:codex:focused', daemon_seq: 704 }),
  });

  socket.message({ type: 'session.inventory', sessions: [] });
  socket.message({
    type: 'close.ok',
    request_id: 'close-probe',
    deferred: false,
    confirmed_process_dead: true,
    reap_status: 'reaped',
  });
  const removalCallbacks = seen
    .filter((payload) => payload.data.kind === 'session_removal_ws_callback')
    .map((payload) => payload.data.frame_type);
  expect(removalCallbacks).toEqual(['session.inventory', 'close.ok']);
  expect(seen.find((payload) => (
    payload.data.kind === 'session_removal_ws_callback' && payload.data.frame_type === 'close.ok'
  ))?.data).toMatchObject({ deferred: false, confirmed_process_dead: true, reap_status: 'reaped' });
  expect(seen.find((payload) => (
    payload.data.kind === 'session_removal_backlog_ws_sample' && payload.data.seq === 640
  ))?.data).toMatchObject({
    harness_run_id: 'removal-run',
    frame_id: 'stream-0640',
    injector_send_wall_ms: expect.any(Number),
    daemon_accept_wall_ms: expect.any(Number),
    socket_write_start_to_ws_callback_ms: 12,
  });
  expect(seen.some((payload) => (
    payload.data.kind === 'session_removal_backlog_ws_sample' && payload.data.seq === 704
  ))).toBe(false);

  jest.advanceTimersByTime(1000);
  expect(stream.getPentacleStreamState().events.some((event) => event.daemon_seq === 641)).toBe(true);
  unregisterFocus();
  unsubscribe();
  telemetry.setTelemetrySink(null);
  harnessRuntime.reset();
});

test('the first background row after clean focus cleanup applies without waiting for refocus', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, kind: 'USER', text: 'focused lead' }) });
  jest.advanceTimersByTime(1000);
  unregisterFocus();

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 2, text: 'first background tail' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 2]);
  unsubscribe();
});

test('real in-flight rows for an unfocused former chat wait until it is focused again', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, text: 'focused lead' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 2, text: 'in-flight tail 2' }) });

  unregisterFocus();
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 3, text: 'hidden tail 3' }) });
  jest.advanceTimersByTime(1000);
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1]);

  const unregisterAgain = stream.registerFocusedPentacleStream('hostc:codex:one');
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toEqual([1, 2, 3]);
  unregisterAgain();
  unsubscribe();
});

test('live tail drains in small chunks after a fetch reconciles an optimistic send', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: true })] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'queued while busy');
  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 10, kind: 'USER', text: 'queued while busy', optimistic_id: optimisticId })],
  });
  await expect(fetchPromise).resolves.toHaveLength(1);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();

  for (let seq = 11; seq <= 19; seq += 1) {
    socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: seq, text: `tail ${seq}` }) });
  }
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toContain(19);

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 20, text: 'tail 20' }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).not.toContain(20);

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 21, kind: 'WORKING', text: '', raw: { working: false } }) });
  expect(stream.getPentacleStreamState().events.map((event) => event.daemon_seq)).toContain(20);
  unregisterFocus();
  unsubscribe();
});

test('harness fail_next_history_fetch rejects exactly one request_stream_events call', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?actions=fail_next_history_fetch&scenario=empty_chat_open');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  // `fail_next_history_fetch` forces the MOUNT history fetch to fail. It is
  // scoped to `purpose: 'mount-fetch'` (the purpose the session screen's mount
  // fetch uses — app/pentacle/session/[streamId].tsx) so the intent-prefetch
  // RPC (limit 12, purpose 'prefetch') that now fires ahead of the mount fetch
  // cannot swallow the forced failure. Exercise it through that same purpose.
  await expect(stream.requestStreamEvents('hostc:codex:one', 5, { purpose: 'mount-fetch' }))
    .rejects.toThrow('harness forced request_stream_events failure');
  expect(socket.sent.some((raw) => JSON.parse(raw).type === 'request_stream_events')).toBe(false);

  const retryPromise = stream.requestStreamEvents('hostc:codex:one', 5, { purpose: 'mount-fetch' });
  const retryPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(retryPayload).toEqual(expect.objectContaining({
    type: 'request_stream_events',
    stream_id: 'hostc:codex:one',
    limit: 5,
  }));
  socket.message({
    type: 'request_stream_events.ok',
    request_id: retryPayload.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 1, text: 'retried' })],
  });
  await expect(retryPromise).resolves.toHaveLength(1);

  harnessRuntime.reset();
  unsubscribe();
});

test('fetched historical divider does not rewrite session summary or settle a live turn', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [sessionSummary()] });
  stream.sendTurn('hostc:codex:one', 'live question');
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');
  const beforeBackfillSession = stream.getPentacleStreamState().sessions.find((item) => item.stream_id === 'hostc:codex:one');

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'hostc:codex:one',
    events: [
      pentacleEvent({
        daemon_seq: 9,
        kind: 'SYSTEM',
        text: '─ Worked for 9m 01s ─────────────────────────────────────────────────────────────────────────',
      }),
    ],
  });

  await expect(fetchPromise).resolves.toHaveLength(1);
  const session = stream.getPentacleStreamState().sessions.find((item) => item.stream_id === 'hostc:codex:one');
  expect(session?.last_text).toBe(beforeBackfillSession?.last_text);
  expect(session?.working).toBe(beforeBackfillSession?.working);
  expect(stream.getPentacleStreamState().workingByStream?.['hostc:codex:one']?.phase).toBe('pending');
  unsubscribe();
});

test('fetched USER echo reconciles an optimistic user row without per-event apply', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const optimisticId = stream.enqueueTurn('hostc:codex:one', 'hello backfill');
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeDefined();
  const queuedAt = stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.queued_at;
  expect(queuedAt).toBeDefined();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'hostc:codex:one',
    events: [
      pentacleEvent({
        daemon_seq: 12,
        kind: 'USER',
        text: 'hello backfill',
        optimistic_id: optimisticId,
      }),
    ],
  });

  await expect(fetchPromise).resolves.toHaveLength(1);
  const state = stream.getPentacleStreamState();
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
  const reconciledEvents = state.events.filter((event) => event.optimistic_id === optimisticId);
  expect(reconciledEvents).toHaveLength(1);
  expect(reconciledEvents[0]).toMatchObject({
    kind: 'USER',
    text: 'hello backfill',
    client_origin: true,
    correlatedDaemonSeq: 12,
    pending: false,
    queued_at: queuedAt,
  });
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  expect(
    core.selectSessionDetail(state, 'hostc:codex:one', { visibleCount: 'all' })
      ?.transcriptItems.find((item) => item.optimisticId === optimisticId)?.queuedWhileWorking,
  ).toBe(true);
  unsubscribe();
});

test('server user echo reconciles optimistic send by optimistic id before text fallback', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const optimisticId = stream.appendOptimisticUserMessage(
    'hostc:codex:one',
    'first line\nsecond line\nthird line',
  );
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeDefined();

  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 81,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_id: 'hostc:codex:one',
      session_name: 'one',
      timestamp: '2026-05-30T00:00:01.000Z',
      kind: 'USER',
      text: 'first line second line third line',
      optimistic_id: optimisticId,
      correlatedDaemonSeq: 81,
    },
  });

  const state = stream.getPentacleStreamState();
  const event = state.events.find((item) => item.optimistic_id === optimisticId);
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
  expect(event).toMatchObject({
    optimistic_id: optimisticId,
    correlatedDaemonSeq: 81,
    pending: false,
    text: 'first line second line third line',
  });
  unsubscribe();
});

test('a daemon-stamped echo reconciles a FAILED optimistic row (self-heals a false failure)', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'message that actually landed');
  // Simulate a FALSE failure: the 30s RPC timeout fired while the daemon was
  // holding the send (send-while-working) or doing slow readback, even though
  // the message ultimately lands. Previously this badge was stuck until restart
  // because failed rows were excluded from echo reconciliation.
  stream.markOptimisticFailed(optimisticId, 'Pentacle command timed out');
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('failed');

  // The message DID land; the daemon emits the canonical USER echo stamped with
  // the same optimistic_id.
  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 91,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_id: 'hostc:codex:one',
      session_name: 'one',
      timestamp: '2026-05-30T00:00:05.000Z',
      kind: 'USER',
      text: 'message that actually landed',
      optimistic_id: optimisticId,
      correlatedDaemonSeq: 91,
    },
  });

  const state = stream.getPentacleStreamState();
  // The stuck "failed" badge clears and the row renders as the sent message.
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
  expect(state.events.find((item) => item.optimistic_id === optimisticId)).toMatchObject({
    optimistic_id: optimisticId,
    pending: false,
    text: 'message that actually landed',
  });
  unsubscribe();
});

test('a text-only echo (no optimistic_id) does NOT clear a failed row (no false self-heal)', () => {
  jest.setSystemTime(new Date('2026-05-30T00:00:00.000Z'));
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'genuinely failed text');
  stream.markOptimisticFailed(optimisticId, 'send_error');

  // An unrelated server USER row with the same text but NO optimistic_id stamp
  // must not resurrect a genuinely-failed row as sent.
  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 92,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_id: 'hostc:codex:one',
      session_name: 'one',
      timestamp: '2026-05-30T00:00:02.000Z',
      kind: 'USER',
      text: 'genuinely failed text',
      correlatedDaemonSeq: 92,
    },
  });

  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('failed');
  unsubscribe();
});

test('stale stamped server user echo does not reconcile a different active same-text send', () => {
  jest.setSystemTime(new Date('2026-05-30T00:00:00.000Z'));
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'hello');
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeDefined();

  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 82,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_id: 'hostc:codex:one',
      session_name: 'one',
      timestamp: '2026-05-30T00:00:01.000Z',
      kind: 'USER',
      text: 'hello',
      optimistic_id: 'optimistic_stale_send_a',
      correlatedDaemonSeq: 82,
    },
  });

  const state = stream.getPentacleStreamState();
  expect(state.optimisticSends?.[optimisticId]).toBeDefined();
  expect(state.events.find((item) => item.optimistic_id === optimisticId && item.pending === false)).toBeUndefined();
  expect(state.events).toContainEqual(expect.objectContaining({
    optimistic_id: 'optimistic_stale_send_a',
    text: 'hello',
  }));
  unsubscribe();
});

test('send wire frame carries optimistic_id so the daemon can stamp the echo (real send path)', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  // A real session must exist for sendPentacleMessage's stream lookup.
  socket.message({
    type: 'snapshot',
    sessions: [
      {
        stream_id: 'hostc:codex:one',
        host: 'hostc',
        provider: 'codex',
        session_name: 'one',
        last_event_at: '2026-05-30T00:00:00Z',
        last_text: '',
        last_kind: '',
        online: true,
      },
    ],
    events: [],
  });

  const text = 'first line\nsecond line\nthird line';
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', text);
  expect(optimisticId).toBeTruthy();

  // The send RPC promise stays pending (no send.result in this test) and
  // rejects on teardown; swallow it like dispatchQueuedOptimisticSends does.
  stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text }).catch(() => {});

  const sendFrame = socket.sent
    .map((raw) => JSON.parse(raw))
    .find((frame) => frame.type === 'send');
  expect(sendFrame).toBeDefined();
  // The whole fix hinges on this: without optimistic_id on the wire the daemon
  // has nothing to stamp onto the USER echo and reconcile falls back to fragile
  // exact-text matching. Assert the REAL frame, not a synthesized one.
  expect(sendFrame.optimistic_id).toBe(optimisticId);
  unsubscribe();
});

test('stale onopen after await cannot mutate state, while current onopen still connects', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const { unsubscribe, socket: first } = subscribeAndCreateSocket(stream);

  first.open();
  expect(first.sent).toHaveLength(0);

  stream.reconnectPentacleStream();
  expect(MockWebSocket.instances).toHaveLength(2);

  harnessRuntime.markBootResolved();
  await flushMicrotasks();

  expect(first.sent).toHaveLength(0);
  expect(stream.getPentacleStreamState().connected).toBe(false);

  const second = MockWebSocket.instances[1];
  second.open();
  await flushMicrotasks();

  expect(JSON.parse(second.sent[0])).toEqual({
    type: 'hello',
    client: 'pentacle-mobile',
    capabilities: { assistant_composite_v1: true },
    subscribe: { events_mode: 'summary', include_subagents: false },
  });
  expect(stream.getPentacleStreamState().connected).toBe(true);

  harnessRuntime.reset();
  unsubscribe();
});

test('stale forced-close timer cannot close the current socket, while current timer still closes', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  let stream = loadStream();
  let harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?actions=force_ws_reconnect&scenario=chat_reconnect');
  let { unsubscribe, socket: first } = subscribeAndCreateSocket(stream);

  first.open();
  await flushMicrotasks();
  stream.reconnectPentacleStream();
  const second = MockWebSocket.instances[1];

  jest.advanceTimersByTime(250);
  expect(second.readyState).toBe(MockWebSocket.CONNECTING);
  expect(MockWebSocket.instances).toHaveLength(2);
  unsubscribe();
  harnessRuntime.reset();

  process.env.EXPO_PUBLIC_HARNESS = '1';
  stream = loadStream();
  harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?actions=force_ws_reconnect&scenario=chat_reconnect');
  ({ unsubscribe, socket: first } = subscribeAndCreateSocket(stream));

  first.open();
  await flushMicrotasks();
  jest.advanceTimersByTime(250);

  expect(first.readyState).toBe(MockWebSocket.CLOSED);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  unsubscribe();
  harnessRuntime.reset();
});

test('stale ping timer cannot ping a newer socket, while current ping timer still sends', () => {
  const intervalSpy = jest.spyOn(global, 'setInterval');
  let stream = loadStream();
  let { unsubscribe, socket: first } = subscribeAndCreateSocket(stream);
  first.open();
  const stalePing = latestTimerCallback(intervalSpy, 15000);

  first.readyState = MockWebSocket.CLOSED;
  const unsubscribeSecondListener = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const second = MockWebSocket.instances[1];
  first.readyState = MockWebSocket.OPEN;
  stalePing();

  expect(first.sent.filter((message) => JSON.parse(message).type === 'ping')).toHaveLength(0);
  expect(second.sent).toHaveLength(0);
  unsubscribeSecondListener();
  unsubscribe();
  intervalSpy.mockRestore();

  stream = loadStream();
  ({ unsubscribe, socket: first } = subscribeAndCreateSocket(stream));
  first.open();
  jest.advanceTimersByTime(15000);

  expect(JSON.parse(first.sent.at(-1) || '{}')).toEqual({ type: 'ping' });
  unsubscribe();
});

test('focused stream is refetched when the socket opens', () => {
  const stream = loadStream();
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);

  socket.open();

  expect(sentFrames(socket, 'request_stream_events')).toEqual([
    expect.objectContaining({
      stream_id: 'hostc:codex:one',
      limit: 300,
    }),
  ]);
  expect(stream.__getFocusedPentacleStreamForTests()).toBe('hostc:codex:one');
  unregister();
  unsubscribe();
});

test('foreground resync refetches a live focused stream without blind teardown', async () => {
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const initialRequest = sentFrames(socket, 'request_stream_events')[0];
  socket.message({
    type: 'request_stream_events.ok',
    request_id: initialRequest.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];

  stream.__handlePentacleAppStateChangeForTests('background');
  clock.advance(1_000);
  stream.__handlePentacleAppStateChangeForTests('active');
  jest.advanceTimersByTime(250);

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(1);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);

  unregister();
  unsubscribe();
  clock.restore();
});

test('foreground re-arm probes a stale open socket and preserves it when pong returns', async () => {
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const initialRequest = sentFrames(socket, 'request_stream_events')[0];
  socket.message({
    type: 'request_stream_events.ok',
    request_id: initialRequest.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];

  stream.__handlePentacleAppStateChangeForTests('background');
  clock.advance(31_000);
  stream.__handlePentacleAppStateChangeForTests('active');
  jest.advanceTimersByTime(250);

  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(1);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  socket.message({ type: 'pong' });
  jest.advanceTimersByTime(1_000);

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().connected).toBe(true);
  expect(MockWebSocket.instances).toHaveLength(1);

  unregister();
  unsubscribe();
  clock.restore();
});

test('foreground re-arm force-closes a stale open socket when the probe is silent', async () => {
  const clock = mockMonotonicNow();
  const stream = loadStream();
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const initialRequest = sentFrames(socket, 'request_stream_events')[0];
  socket.message({
    type: 'request_stream_events.ok',
    request_id: initialRequest.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];

  stream.__handlePentacleAppStateChangeForTests('background');
  clock.advance(31_000);
  stream.__handlePentacleAppStateChangeForTests('active');
  jest.advanceTimersByTime(250);
  const refetch = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: refetch?.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  clock.advance(500);
  expect(stream.requestFocusedPentacleLivenessProbe('tap')).toBe(true);
  jest.advanceTimersByTime(1_000);

  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);

  unregister();
  unsubscribe();
  clock.restore();
});

test('foreground probe reconnects when close returns but native onclose is silent', async () => {
  const clock = mockMonotonicNow();
  const stream = loadStream();
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const initialRequest = sentFrames(socket, 'request_stream_events')[0];
  socket.message({
    type: 'request_stream_events.ok',
    request_id: initialRequest.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];
  socket.close = jest.fn();

  stream.__handlePentacleAppStateChangeForTests('background');
  clock.advance(31_000);
  stream.__handlePentacleAppStateChangeForTests('active');
  jest.advanceTimersByTime(250);
  const refetch = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: refetch?.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  clock.advance(500);
  expect(stream.requestFocusedPentacleLivenessProbe('tap')).toBe(true);
  jest.advanceTimersByTime(1_000);

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);

  unregister();
  unsubscribe();
  clock.restore();
});

test('production-mode focused heartbeat closes a silent half-open socket after one second', async () => {
  expect(process.env.EXPO_PUBLIC_HARNESS).toBeUndefined();
  expect(process.env.EXPO_PUBLIC_HARNESS_FORCE_WS_RECONNECT).toBeUndefined();
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'pong' });
  socket.close = jest.fn();
  socket.sent = [];

  jest.advanceTimersByTime(250);
  const historyRequest = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: historyRequest?.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];

  jest.advanceTimersByTime(1_250);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);

  jest.advanceTimersByTime(999);
  expect(stream.getPentacleStreamState().connected).toBe(true);
  jest.advanceTimersByTime(1);

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);

  unregister();
  unsubscribe();
});

test('focused interaction probe closes a silent half-open socket after one second', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'pong' });
  socket.close = jest.fn();
  socket.sent = [];
  jest.advanceTimersByTime(500);
  const historyRequest = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: historyRequest?.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];

  expect(stream.requestFocusedPentacleLivenessProbe('tap')).toBe(true);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  jest.advanceTimersByTime(1_000);

  expect(stream.getPentacleStreamState().connected).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);

  unregister();
  unsubscribe();
});

test('focused send probe keeps a pending send connected when pong proves the transport live', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });
  const initialRequest = sentFrames(socket, 'request_stream_events')[0];
  if (initialRequest) {
    socket.message({
      type: 'request_stream_events.ok',
      request_id: initialRequest.request_id,
      stream_id: 'hostc:codex:one',
      events: [],
    });
    await flushMicrotasks();
  }
  socket.message({ type: 'pong' });
  socket.close = jest.fn();
  socket.sent = [];
  jest.advanceTimersByTime(500);

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'pending focused send');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'pending focused send' });
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');

  expect(stream.requestFocusedPentacleLivenessProbe('send')).toBe(true);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  jest.advanceTimersByTime(500);
  socket.message({ type: 'pong' });
  jest.advanceTimersByTime(500);

  expect(stream.getPentacleStreamState().connected).toBe(true);
  expect(socket.close).not.toHaveBeenCalled();
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({ type: 'send.ok', request_id: sendPayload?.request_id });
  await expect(sendPromise).resolves.toBe(true);

  unregister();
  unsubscribe();
});

test('focused fast heartbeat falls back to the slow window while backgrounded', () => {
  const stream = loadStream();
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.sent = [];

  stream.__handlePentacleAppStateChangeForTests('background');
  jest.advanceTimersByTime(3_500);

  expect(sentFrames(socket, 'ping')).toHaveLength(0);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().connected).toBe(true);

  jest.advanceTimersByTime(11_500);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);

  unregister();
  unsubscribe();
});

test('rapid foreground toggles debounce to one probe/refetch', async () => {
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const initialRequest = sentFrames(socket, 'request_stream_events')[0];
  socket.message({
    type: 'request_stream_events.ok',
    request_id: initialRequest.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
  });
  await flushMicrotasks();
  socket.sent = [];

  for (let index = 0; index < 3; index += 1) {
    stream.__handlePentacleAppStateChangeForTests('background');
    clock.advance(31_000);
    stream.__handlePentacleAppStateChangeForTests('active');
  }
  jest.advanceTimersByTime(249);
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(0);
  jest.advanceTimersByTime(1);

  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(1);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  expect(MockWebSocket.instances).toHaveLength(1);

  unregister();
  unsubscribe();
  clock.restore();
});

test('watchdog keeps a ponging socket and reconnects after the no-frame window once pongs stop', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  jest.advanceTimersByTime(15_000);
  expect(sentFrames(socket, 'ping')).toHaveLength(1);
  socket.message({ type: 'pong' });

  jest.advanceTimersByTime(15_000);
  expect(sentFrames(socket, 'ping')).toHaveLength(2);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);

  jest.advanceTimersByTime(14_999);
  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  jest.advanceTimersByTime(1);

  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);

  unsubscribe();
});

test('watchdog reconnects without native onclose and ignores a later stale onclose', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.close = jest.fn();

  jest.advanceTimersByTime(30_000);

  expect(socket.readyState).toBe(MockWebSocket.OPEN);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);
  const reconnect = MockWebSocket.instances[1];
  reconnect.open();
  expect(stream.getPentacleStreamState().connected).toBe(true);

  socket.onclose?.({ code: 4000, reason: 'watchdog_no_inbound_frame', wasClean: false });
  jest.advanceTimersByTime(10_000);

  expect(MockWebSocket.instances).toHaveLength(2);
  expect(stream.getPentacleStreamState().connected).toBe(true);

  unsubscribe();
});

test('unacked send timeout reconnects with a receipt lookup, not a duplicate send', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  stream.__handlePentacleAppStateChangeForTests('active');
  const unregister = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });
  socket.sent = [];

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'hello after stall');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'hello after stall' });
  const sendExpectation = expect(sendPromise).rejects.toThrow(/timed out|disconnected/);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('dispatched');
  const originalSend = socket.sent.map((item) => JSON.parse(item)).find((frame) => frame.type === 'send');
  const originalRequestId = originalSend?.request_id as string;

  jest.advanceTimersByTime(500);
  expect(stream.requestFocusedPentacleLivenessProbe('send')).toBe(true);
  jest.advanceTimersByTime(1_000);
  await sendExpectation;
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(stream.getPentacleStreamState().connected).toBe(false);
  // A transport-cut preserves the unconfirmed row; receipt absence never makes
  // it failed or auto-sends it again.
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'dispatched',
  });

  jest.advanceTimersByTime(1_000);
  const reconnect = MockWebSocket.instances[1];
  reconnect.open();
  const receiptQuery = sentFrames(reconnect, 'send.receipt.get').at(-1);
  expect(receiptQuery).toEqual(expect.objectContaining({
    to_stream_id: 'hostc:codex:one',
    request_id: originalRequestId,
  }));
  const fetchPayload = sentFrames(reconnect, 'request_stream_events').at(-1);
  expect(fetchPayload).toEqual(expect.objectContaining({
    stream_id: 'hostc:codex:one',
    limit: 300,
  }));
  reconnect.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload?.request_id,
    stream_id: 'hostc:codex:one',
    events: [
      pentacleEvent({
        daemon_seq: 42,
        kind: 'USER',
        text: 'hello after stall',
        optimistic_id: optimisticId,
        correlatedDaemonSeq: 42,
      }),
    ],
  });

  const state = stream.getPentacleStreamState();
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
  expect(state.events.filter((event) => event.optimistic_id === optimisticId)).toHaveLength(1);
  const replaySends = reconnect.sent.map((item) => JSON.parse(item)).filter((frame) => frame.type === 'send');
  expect(replaySends).toHaveLength(0);

  unregister();
  unsubscribe();
});

test('a permanently CONNECTING socket is torn down at the pre-open deadline and retried', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);

  jest.advanceTimersByTime(10_000);
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  jest.advanceTimersByTime(1_000);

  expect(MockWebSocket.instances).toHaveLength(2);
  unsubscribe();
});

test('an error without native close tears down the pre-open socket and retries', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.close = jest.fn();

  socket.onerror?.();

  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(stream.getPentacleStreamState().connecting).toBe(true);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);
  unsubscribe();
});

test('a late onclose after pre-open teardown does not schedule a duplicate retry', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.close = jest.fn();

  socket.onerror?.();
  socket.onclose?.();
  jest.advanceTimersByTime(1_000);

  expect(MockWebSocket.instances).toHaveLength(2);
  expect(socket.close).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test('foreground recovery cannot leave a CONNECTING socket stranded past its deadline', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);

  stream.__handlePentacleAppStateChangeForTests('background');
  stream.__handlePentacleAppStateChangeForTests('active');
  jest.advanceTimersByTime(250);
  expect(MockWebSocket.instances).toHaveLength(1);

  jest.advanceTimersByTime(9_750);
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  jest.advanceTimersByTime(1_000);
  expect(MockWebSocket.instances).toHaveLength(2);
  unsubscribe();
});

test('stale reconnect timer cannot create another socket, while current reconnect timer reconnects', () => {
  const timeoutSpy = jest.spyOn(global, 'setTimeout');
  let stream = loadStream();
  let { unsubscribe, socket: first } = subscribeAndCreateSocket(stream);
  first.open();
  first.closeFromServer();
  const staleReconnect = latestTimerCallback(timeoutSpy, 1000);
  expect(MockWebSocket.instances).toHaveLength(1);

  const unsubscribeSecondListener = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  expect(MockWebSocket.instances).toHaveLength(2);
  const second = MockWebSocket.instances[1];
  second.readyState = MockWebSocket.CLOSED;
  staleReconnect();

  expect(MockWebSocket.instances).toHaveLength(2);
  unsubscribeSecondListener();
  unsubscribe();
  timeoutSpy.mockRestore();

  stream = loadStream();
  ({ unsubscribe, socket: first } = subscribeAndCreateSocket(stream));
  first.open();
  first.closeFromServer();
  jest.advanceTimersByTime(1000);

  expect(MockWebSocket.instances).toHaveLength(2);
  unsubscribe();
});

test('stale onmessage cannot mutate state, while current onmessage still applies events', () => {
  const stream = loadStream();
  const { unsubscribe, socket: first } = subscribeAndCreateSocket(stream);
  first.open();

  stream.reconnectPentacleStream();
  const second = MockWebSocket.instances[1];
  second.open();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');

  first.message({ type: 'chat.event', event: assistantEvent('stale event', 1) });
  expect(stream.getPentacleStreamState().events.some((event) => event.text === 'stale event')).toBe(false);

  second.message({ type: 'chat.event', event: assistantEvent('current event', 2) });
  expect(stream.getPentacleStreamState().events.some((event) => event.text === 'current event')).toBe(true);

  unregisterFocus();
  unsubscribe();
});

test('stale RPC timeout cannot reject across generations, while current RPC timeout rejects', async () => {
  const timeoutSpy = jest.spyOn(global, 'setTimeout');
  let stream = loadStream();
  let { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const stalePromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'stale timeout' });
  let staleRejection: Error | undefined;
  stalePromise.catch((error) => {
    staleRejection = error;
  });
  const staleTimeout = latestTimerCallback(timeoutSpy, 30000);
  socket.readyState = MockWebSocket.CLOSED;
  const unsubscribeSecondListener = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  staleTimeout();
  await flushMicrotasks();
  expect(staleRejection).toBeUndefined();
  const staleExpectation = expect(stalePromise).rejects.toThrow('disconnected');
  stream.reconnectPentacleStream();
  await staleExpectation;
  expect(stream.getPentacleStreamState().connecting).toBe(true);
  unsubscribeSecondListener();
  unsubscribe();
  timeoutSpy.mockRestore();

  stream = loadStream();
  ({ unsubscribe, socket } = subscribeAndCreateSocket(stream));
  socket.open();

  const timeoutPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'current timeout' });
  jest.advanceTimersByTime(30000);
  await expect(timeoutPromise).rejects.toThrow('timed out');
  unsubscribe();
});

test('emits harness reconnect telemetry when EXPO_PUBLIC_HARNESS=1 + force_ws_reconnect action is armed via URL', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  // Arm the runtime BEFORE subscribing — simulates the cold-launch URL
  // resolving before pentacleStream.onopen fires.
  harnessRuntime.applyURL('pentacle://harness?actions=force_ws_reconnect&scenario=chat_reconnect');

  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  const socket = MockWebSocket.instances[0];
  socket.open();
  // onopen is async (uses await waitArmed); flush microtasks.
  await Promise.resolve();
  await Promise.resolve();

  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: TELEMETRY_EVENTS.HARNESS_FORCE_WS_RECONNECT_SCHEDULED,
      data: expect.objectContaining({
        trigger: 'force_ws_reconnect',
        url_host: 'default.example',
        attempt: 0,
        delay_ms: 250,
      }),
    }),
  ]));
  expect(stream.getPentacleStreamState().connected).toBe(true);
  jest.advanceTimersByTime(250);
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: TELEMETRY_EVENTS.CHAT_WS_CLOSE,
      data: expect.objectContaining({
        reason: 'harness_forced',
        code: 4000,
      }),
    }),
  ]));
  telemetry.setTelemetrySink(null);
  harnessRuntime.reset();
  unsubscribe();
});

test('does NOT emit harness reconnect telemetry when EXPO_PUBLIC_HARNESS=1 but action is not armed', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  // Arm with empty actions — markBootResolved-equivalent state.
  harnessRuntime.markBootResolved();

  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await Promise.resolve();
  await Promise.resolve();

  expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_FORCE_WS_RECONNECT_SCHEDULED)).toBeUndefined();
  // ws_open still fires (base-app event, not harness-gated).
  expect(seen.find((p) => p.message === TELEMETRY_EVENTS.CHAT_WS_OPEN)).toBeDefined();
  // No harness_forced close.
  jest.advanceTimersByTime(500);
  expect(seen.find(
    (p) => p.message === TELEMETRY_EVENTS.CHAT_WS_CLOSE && (p.data as any).reason === 'harness_forced',
  )).toBeUndefined();

  telemetry.setTelemetrySink(null);
  harnessRuntime.reset();
  unsubscribe();
});

test('reconnects on close with exponential backoff and cancels pending reconnect on unsubscribe', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  const first = MockWebSocket.instances[0];
  first.open();
  first.message({
    type: 'snapshot',
    events: [{
      daemon_seq: 1,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:00Z',
      kind: 'ASSIST',
      text: 'before close',
    }],
  });
  first.closeFromServer();

  expect(stream.getPentacleStreamState().connected).toBe(false);
  expect(MockWebSocket.instances).toHaveLength(1);

  jest.advanceTimersByTime(999);
  expect(MockWebSocket.instances).toHaveLength(1);

  jest.advanceTimersByTime(1);
  expect(MockWebSocket.instances).toHaveLength(2);

  const second = MockWebSocket.instances[1];
  second.open();
  second.message({
    type: 'snapshot',
    sessions: [{
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      last_event_at: '2026-05-08T00:00:03Z',
      last_text: 'after reconnect',
      last_kind: 'ASSIST',
      online: true,
    }],
    events: [{
      daemon_seq: 3,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:03Z',
      kind: 'ASSIST',
      text: 'after reconnect',
    }],
  });
  expect(stream.getPentacleStreamState().events.some((event) => event.daemon_seq === 3)).toBe(true);

  second.closeFromServer();
  jest.advanceTimersByTime(999);
  expect(MockWebSocket.instances).toHaveLength(2);

  unsubscribe();
  jest.advanceTimersByTime(1);
  expect(MockWebSocket.instances).toHaveLength(2);
});

test('slow-consumer close enters reconnect grace before showing disconnected error', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  const first = MockWebSocket.instances[0];
  first.open();
  first.close(1011, 'slow_consumer');

  expect(stream.getPentacleStreamState().connected).toBe(false);
  expect(stream.getPentacleStreamState().connecting).toBe(true);
  expect(stream.getPentacleStreamState().lastError).toBeUndefined();

  jest.advanceTimersByTime(1499);
  expect(stream.getPentacleStreamState().lastError).toBeUndefined();

  jest.advanceTimersByTime(1);
  expect(stream.getPentacleStreamState().lastError).toBe('Pentacle stream disconnected');

  unsubscribe();
});

test('reconnect success clears pending disconnected banner grace', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  const first = MockWebSocket.instances[0];
  first.open();
  first.close(1011, 'slow_consumer');

  jest.advanceTimersByTime(1000);
  const second = MockWebSocket.instances[1];
  second.open();
  jest.advanceTimersByTime(500);

  expect(stream.getPentacleStreamState().connected).toBe(true);
  expect(stream.getPentacleStreamState().connecting).toBe(false);
  expect(stream.getPentacleStreamState().lastError).toBeUndefined();

  unsubscribe();
});

test('dispatches supported server message types into stream state', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const limits = [
    { id: 'claude', label: 'Claude', pct: 21, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'fable', label: 'Fable', pct: null, resets_at_iso: null, resets_text: null },
    { id: 'codex', label: 'Codex', pct: 34, resets_at_iso: '2026-08-30T00:00:00Z', resets_text: 'Saturday' },
  ];
  socket.message({ type: 'limits.update', limits });
  expect(stream.getPentacleStreamState().limits).toEqual(limits);

  socket.message({ type: 'limits.update', limits: limits.slice(0, 2) });
  expect(stream.getPentacleStreamState().limits).toEqual(limits);

  socket.message({ type: 'host.status', host: { host: 'Hostc', online: true, checked_at: '', session_count: 2 } });
  expect(stream.getPentacleStreamState().hosts.hostc.online).toBe(true);

  socket.message({
    type: 'hosts.stats',
    hosts: {
      Hostc: { host: 'Hostc', cpu_load_1m: 1.25, memory_used_bytes: 8, memory_total_bytes: 16, disk_used_bytes: 4, disk_total_bytes: 8, uptime_seconds: 3600, sampled_at: '2026-09-04T23:00:00Z' },
      Hostb: { host: 'Hostb', cpu_load_1m: 0.5, memory_used_bytes: 2, memory_total_bytes: 4, disk_used_bytes: 1, disk_total_bytes: 2, uptime_seconds: 60, sampled_at: '2026-09-04T23:00:00Z' },
    },
  });
  expect(stream.getPentacleStreamState().machineStats.hostc.cpu_load_1m).toBe(1.25);
  expect(stream.getPentacleStreamState().machineStats.hostb.host).toBe('hostb');

  // A later replacement frame drops hosts absent from it.
  socket.message({ type: 'hosts.stats', hosts: { Hostc: { host: 'Hostc', cpu_load_1m: 2, memory_used_bytes: 8, memory_total_bytes: 16, disk_used_bytes: 4, disk_total_bytes: 8, uptime_seconds: 3600, sampled_at: '2026-09-04T23:00:00Z' } } });
  expect(stream.getPentacleStreamState().machineStats.hostb).toBeUndefined();

  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      last_event_at: '2026-05-08T00:00:00Z',
      last_text: '',
      last_kind: '',
      online: true,
    }],
  });
  expect(stream.getPentacleStreamState().sessions[0].host).toBe('hostc');

  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 9,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:01Z',
      kind: 'USER',
      text: 'hello',
    },
  });
  expect(stream.getPentacleStreamState().events.some((event) => event.text === 'hello')).toBe(true);

  socket.message({
    type: 'working.state',
    stream_id: 'hostc:codex:one',
    timestamp: '2026-05-08T00:00:02Z',
    tokens_input: 1,
    tokens_output: 2,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'up',
    shell_count_started: 0,
    tasks: [],
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 10,
  });
  expect(stream.getPentacleStreamState().workingStates?.['hostc:codex:one']?.tokens_output).toBe(2);

  socket.message({ type: 'updates', updates: [{ agent_id: 'system', timestamp: 1, direction: 'inbound', message: 'done', sender: 'system' }] });
  expect(stream.getPentacleStreamState().updates[0]?.message).toBe('done');

  socket.message({ type: 'auth.error', error: 'bad token' });
  expect(stream.getPentacleStreamState().lastError).toBe('bad token');

  socket.onmessage?.({ data: '{not-json' });
  expect(stream.getPentacleStreamState().lastError).toBe('bad token');
  unsubscribe();
});

test('snapshot, reconnect, and all-null replacement preserve the atomic limits contract', () => {
  const stream = loadStream();
  const limits = [
    { id: 'claude', label: 'Claude', pct: 21, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'fable', label: 'Fable', pct: 31, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'codex', label: 'Codex', pct: 34, resets_at_iso: '2026-08-30T00:00:00Z', resets_text: 'Saturday' },
  ];
  stream.__handlePentacleStreamMessageForTests({ type: 'snapshot', sessions: [], limits });
  expect(stream.getPentacleStreamState().limits).toEqual(limits);

  stream.reconnectPentacleStream();
  expect(stream.getPentacleStreamState().limits).toEqual(limits);
  stream.__handlePentacleStreamMessageForTests({ type: 'snapshot', sessions: [] });
  expect(stream.getPentacleStreamState().limits).toEqual(limits);

  const allNull = limits.map((entry) => ({
    ...entry,
    pct: null,
    resets_at_iso: null,
    resets_text: null,
  }));
  stream.__handlePentacleStreamMessageForTests({ type: 'snapshot', sessions: [], limits: allNull });
  expect(stream.getPentacleStreamState().limits).toEqual(allNull);
});

test('does not count DRAFT summary strips from chat.event text', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const summaryFlow = require('../../src/services/pentacleSummaryFlowDiagnostics') as typeof import('../../src/services/pentacleSummaryFlowDiagnostics');
  summaryFlow.reset();

  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  socket.message({
    type: 'snapshot',
    sessions: [{
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      last_event_at: '2026-05-08T00:00:00Z',
      last_text: 'Stable preview',
      last_kind: 'ASSIST',
      online: true,
    }],
    events: [],
  });

  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 10,
      stream_id: 'hostc:codex:one',
      host: 'Hostc',
      provider: 'codex',
      session_name: 'one',
      timestamp: '2026-05-08T00:00:01Z',
      kind: 'DRAFT',
      text: 'Booting MCP server: codex_apps (7s • esc to interrupt)',
    },
  });

  expect(stream.getPentacleStreamState().sessions[0]?.last_text).toBe('Stable preview');
  expect(summaryFlow.snapshotCounts().get('hostc:codex:one')).toEqual({
    summary_inbound_count: 1,
    summary_strip_count: 0,
    summary_strip_last_text_observed: '',
  });

  unsubscribe();
});

test.each(['session', 'legacy', 'missing'] as const)('preserves spawn v2 resolution evidence from %s response', async (shape) => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  const tuple = { provider: 'claude', model: 'catalog-model', effort: 'high' };
  const promise = stream.spawnPentacleSessionV2({
    host: 'hostc', provider: 'claude', model: tuple.model, effort: tuple.effort,
    spawnProfile: 'desktop_manual', catalogVersion: 'catalog-test', resolutionSource: 'profile_default',
    objective: 'Resolve the spawn tuple',
  });
  const request = JSON.parse(socket.sent.at(-1) || '{}');
  expect(request.objective).toBe('Resolve the spawn tuple');
  const metadata = { resolution_source: 'profile_default', catalog_version: 'catalog-test' };
  const session = {
    stream_id: 'hostc:v2-resolution', host: 'hostc', provider: 'claude', session_name: 'v2-resolution', online: true,
    ...(shape === 'session' ? { requested_launch_tuple: tuple, resolved_launch_tuple: tuple, actual_launch_tuple: tuple, ...metadata } : {}),
  };
  socket.message({ type: 'spawn.ok', request_id: request.request_id, session,
    ...(shape === 'legacy' ? { requested: tuple, resolved: tuple, actual_launch: tuple, ...metadata } : {}),
  });
  const result = await promise;
  expect(result.session).toEqual(session);
  expect(result.resolved).toEqual(shape === 'missing' ? undefined : tuple);
  expect(result.requested).toEqual(shape === 'missing' ? undefined : tuple);
  expect(result.actual_launch).toEqual(shape === 'missing' ? undefined : tuple);
  expect(result.catalog_version).toBe(shape === 'missing' ? undefined : 'catalog-test');
  expect(result.resolution_source).toBe(shape === 'missing' ? undefined : 'profile_default');
  unsubscribe();
});

test('thread.read preserves the parent/child identity and resolves validated exchange rows', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const request = stream.readPentacleThread({ parentStreamId: 'hosta:parent', childStreamId: 'hostc:child' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'thread.read',
    parent_stream_id: 'hosta:parent',
    child_stream_id: 'hostc:child',
  }));
  socket.message({
    type: 'thread.read.ok',
    request_id: payload.request_id,
    ok: true,
    parent_stream_id: 'hosta:parent',
    child_stream_id: 'hostc:child',
    parent_generation: 'parent-generation',
    child_generation: 'child-generation',
    next_cursor: null,
    rows: [{
      row_id: 'tell:row-1',
      ref_id: 'row-1',
      ts: '2026-09-08T12:01:00.000Z',
      direction: 'parent_to_child',
      kind: 'tell',
      text: 'Render the history modal.',
      truncated: false,
    }],
  });
  await expect(request).resolves.toEqual(expect.objectContaining({ child_stream_id: 'hostc:child' }));
  unsubscribe();
});

test('prompt.answer uses the canonical durable answer wire and settles its matching acknowledgement', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  const request = stream.answerDaemonPrompt({ questionId: 'q-free', text: 'Exact free text' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({
    type: 'prompt.answer', question_id: 'q-free', text: 'Exact free text', request_id: expect.any(String),
  }));
  socket.message({ type: 'prompt.answer.ok', request_id: payload.request_id });
  await expect(request).resolves.toBe(true);
  unsubscribe();
});

test('sends commands and resolves or rejects pending request responses', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'hello' });
  const sendPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(sendPayload).toEqual(expect.objectContaining({
    type: 'send',
    host: 'hostc',
    session_name: 'one',
    text: 'hello',
  }));
  socket.message({ type: 'send.ok', request_id: sendPayload.request_id });
  await expect(sendPromise).resolves.toBe(true);

  const spawnPromise = stream.spawnPentacleSession({ host: 'hostc', provider: 'codex' });
  const spawnPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'spawn.ok',
    request_id: spawnPayload.request_id,
    session: { stream_id: 'new', host: 'hostc', provider: 'codex', session_name: 'new', online: true },
  });
  await expect(spawnPromise).resolves.toEqual(expect.objectContaining({ stream_id: 'new' }));

  const renamePromise = stream.renamePentacleSession({ host: 'hostc', sessionName: 'new', displayName: 'Renamed' });
  const renamePayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'rename.ok',
    request_id: renamePayload.request_id,
    session: { stream_id: 'new', host: 'hostc', provider: 'codex', session_name: 'new', title: 'Renamed', online: true },
  });
  await expect(renamePromise).resolves.toEqual(expect.objectContaining({ title: 'Renamed' }));
  expect(stream.getPentacleStreamState().sessions.some((session) => session.title === 'Renamed')).toBe(true);

  const registerPromise = stream.registerPentaclePushToken({ pushToken: 'push-token', platform: 'ios', deviceName: 'Hostc' });
  const registerPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(registerPayload).toEqual(expect.objectContaining({
    type: 'register_push',
    push_token: 'push-token',
    platform: 'ios',
    device_name: 'Hostc',
  }));
  socket.message({ type: 'register_push.error', request_id: registerPayload.request_id, error: 'denied' });
  await expect(registerPromise).rejects.toThrow('denied');

  const defaultNamePromise = stream.registerPentaclePushToken({ pushToken: 'push-token-2', platform: 'ios' });
  const defaultNamePayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(defaultNamePayload.device_name).toBe('');
  socket.message({ type: 'register_push.ok', request_id: defaultNamePayload.request_id });
  await expect(defaultNamePromise).resolves.toBe(true);

  // requestStreamEvents: shape + resolve on .ok + reject on .error
  // (spec_pentacle__chat_streamd_snapshot_summary_mode_2026_05_17).
  const fetchPromise = stream.requestStreamEvents('alpha:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(fetchPayload).toEqual(expect.objectContaining({
    type: 'request_stream_events',
    stream_id: 'alpha:codex:one',
    limit: 5,
  }));
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'alpha:codex:one',
    events: [{ stream_id: 'alpha:codex:one', daemon_seq: 1, kind: 'USER' }],
  });
  await expect(fetchPromise).resolves.toHaveLength(1);

  const failFetchPromise = stream.requestStreamEvents('does-not-exist');
  const failFetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(failFetchPayload.type).toBe('request_stream_events');
  expect(failFetchPayload.stream_id).toBe('does-not-exist');
  socket.message({
    type: 'request_stream_events.error',
    request_id: failFetchPayload.request_id,
    error: 'stream not visible',
  });
  await expect(failFetchPromise).rejects.toThrow('stream not visible');
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['does-not-exist']).toMatchObject({
    coverageByWindow: { history: { complete: false } },
    requestsByWindow: { history: { status: 'error' } },
  });

  // send.result {delivery: 'landed' | 'not_landed'} is the daemon's canonical
  // send-completion frame after
  // spec_pentacle__chat_streamd_send_delivery_classification_2026_05_16.
  // Resolve path (landed):
  const resultLandedPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'landed-text' });
  const resultLandedPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'send.result',
    request_id: resultLandedPayload.request_id,
    host: 'hostc',
    session_name: 'one',
    msg_id: 7,
    delivery: 'landed',
    attempt: 1,
  });
  await expect(resultLandedPromise).resolves.toBe(true);

  // Reject path (not_landed) — error message uses `reason` when present and
  // falls back to `delivery` so unexpected delivery values still surface.
  const resultNotLandedPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'not-landed-text' });
  const resultNotLandedPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'send.result',
    request_id: resultNotLandedPayload.request_id,
    host: 'hostc',
    session_name: 'one',
    msg_id: 8,
    delivery: 'not_landed',
    reason: 'tmux_paste_not_landed',
    attempts: 3,
  });
  await expect(resultNotLandedPromise).rejects.toThrow('tmux_paste_not_landed');

  // Unknown delivery values fall through to the failure branch so
  // protocol drift surfaces as a rejection rather than a silent hang.
  const resultUnknownPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'unknown-text' });
  const resultUnknownPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'send.result',
    request_id: resultUnknownPayload.request_id,
    host: 'hostc',
    session_name: 'one',
    msg_id: 9,
    delivery: 'queued_future_status',
  });
  await expect(resultUnknownPromise).rejects.toThrow('queued_future_status');

  unsubscribe();
});

test('retry rekeys an optimistic identity conflict once and preserves one visible row', async () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'retry with attachment', [{
    key: 'c'.repeat(64),
    mime: 'image/jpeg',
    width: 10,
    height: 20,
    bytes: 30,
  }]);
  const prior = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  stream.markOptimisticFailed(optimisticId, 'send_error');

  const retry = stream.retryOptimisticSend(optimisticId);
  const first = sentFrames(socket, 'send').at(-1);
  expect(first).toMatchObject({
    optimistic_id: optimisticId,
    text: 'retry with attachment',
  });
  expect(first?.request_id).not.toBe(prior?.request_id);

  socket.message({
    type: 'send.result',
    request_id: first?.request_id,
    delivery: 'not_landed',
    reason: 'optimistic_id_conflict',
  });

  const sends = sentFrames(socket, 'send');
  expect(sends).toHaveLength(2);
  const replacement = sends[1];
  expect(replacement.optimistic_id).not.toBe(optimisticId);
  expect(replacement.request_id).not.toBe(first?.request_id);
  expect(replacement.text).toBe('retry with attachment');
  expect(replacement.attachments).toEqual(first?.attachments);

  const rekeyedState = stream.getPentacleStreamState();
  const replacementId = replacement.optimistic_id as string;
  expect(rekeyedState.optimisticSends?.[optimisticId]).toBeUndefined();
  expect(rekeyedState.optimisticSends?.[replacementId]).toMatchObject({
    optimistic_id: replacementId,
    request_id: replacement.request_id,
    status: 'dispatched',
    attachments: first?.attachments,
  });
  expect(rekeyedState.optimisticByRequestId?.[replacement.request_id as string]).toBe(replacementId);
  expect(rekeyedState.events.filter((event) => event.optimistic_id === replacementId)).toHaveLength(1);
  expect(rekeyedState.events.filter((event) => event.optimistic_id === optimisticId)).toHaveLength(0);

  socket.message({ type: 'send.result', request_id: replacement.request_id, delivery: 'landed' });
  await expect(retry).resolves.toBe(true);

  const retryTelemetry = seen.filter((payload) => payload.message === core.TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RETRY);
  expect(retryTelemetry).toEqual(expect.arrayContaining([
    expect.objectContaining({
      data: expect.objectContaining({
        prior_optimistic_id: optimisticId,
        new_optimistic_id: replacementId,
        prior_request_id: prior?.request_id,
        new_request_id: replacement.request_id,
        response_class: 'optimistic_id_conflict',
        ui_outcome: 'rekeyed',
      }),
    }),
    expect.objectContaining({
      data: expect.objectContaining({
        response_class: 'send.result',
        ui_outcome: 'sent',
      }),
    }),
  ]));
  for (const payload of retryTelemetry) {
    expect(payload.data).not.toHaveProperty('text');
    expect(payload.data).not.toHaveProperty('message');
    expect(payload.data).not.toHaveProperty('credentials');
  }

  core.setTelemetrySink(null);
  unsubscribe();
});

test('retry send.error leaves the row failed and rejects with an explicit error', async () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'permission denied');
  stream.markOptimisticFailed(optimisticId, 'previous_failure');
  const retry = stream.retryOptimisticSend(optimisticId);
  const request = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.error',
    request_id: request?.request_id,
    error_code: 'permission_denied',
    error: 'The session rejected this send',
  });

  await expect(retry).rejects.toMatchObject({
    name: 'ExplicitSendRejectionError',
    errorCode: 'permission_denied',
    responseClass: 'send.error',
  });
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'failed',
    failure_reason: 'permission_denied',
  });
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: core.TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RETRY,
      data: expect.objectContaining({
        response_class: 'send.error',
        ui_outcome: 'error_surface',
        error_code: 'permission_denied',
      }),
    }),
  ]));

  core.setTelemetrySink(null);
  unsubscribe();
});

test('retry transport loss stays recoverable without a second immediate dispatch', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'ambiguous retry');
  stream.markOptimisticFailed(optimisticId, 'previous_failure');
  const retry = stream.retryOptimisticSend(optimisticId);
  expect(sentFrames(socket, 'send')).toHaveLength(1);
  socket.closeFromServer();

  await expect(retry).resolves.toBe(false);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'dispatched',
  });
  unsubscribe();
});

test('rejects sends while disconnected but durably queues close intent', async () => {
  const stream = loadStream();

  await expect(stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'hello' })).rejects.toThrow('not connected');
  await expect(stream.closePentacleSession({ host: 'hostc', sessionName: 'one', streamId: 'stream' }))
    .resolves.toMatchObject({ queued: true });
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream');
});

// Regression: on device, send.result occasionally fails to land while the
// chat.event USER echo still arrives reliably. dispatchSend was hanging for
// 30s on the pending send promise, which blocked F1's spawn_chat_then_send_sent
// telemetry. Resolving the pending send when its optimistic gets reconciled
// via the chat.event echo unblocks the flow without breaking the canonical
// send.result path.
test('chat.event USER echo resolves a pending sendPentacleMessage if send.result is missing', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  // Seed a session so sendPentacleMessage can resolve the stream_id.
  socket.message({
    type: 'snapshot',
    sessions: [{
      stream_id: 'hostc:claude:one',
      host: 'hostc',
      provider: 'claude',
      session_name: 'one',
      last_event_at: '2026-05-18T00:00:00Z',
      last_text: '',
      last_kind: '',
      online: true,
    }],
    events: [],
  });

  // appendOptimisticUserMessage seeds an optimistic with a request_id;
  // sendPentacleMessage reuses that request_id when calling sendCommand.
  stream.appendOptimisticUserMessage('hostc:claude:one', 'echo-text');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'echo-text' });
  const sendPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(sendPayload.type).toBe('send');
  expect(typeof sendPayload.request_id).toBe('string');

  // Daemon never sends send.result; only the chat.event USER echo arrives.
  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 1,
      stream_id: 'hostc:claude:one',
      host: 'hostc',
      provider: 'claude',
      session_name: 'one',
      timestamp: new Date().toISOString(),
      kind: 'USER',
      text: 'echo-text',
    },
  });

  await expect(sendPromise).resolves.toBe(true);
  unsubscribe();
});

test('landed send ack schedules a stream-events catch-up to reconcile the optimistic echo', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', {
      host: 'hostc',
      provider: 'codex',
      session_name: 'one',
    })],
    events: [],
  });
  const initialFetch = sentFrames(socket, 'request_stream_events').at(-1);
  if (initialFetch?.stream_id === 'hostc:codex:one') {
    socket.message({
      type: 'request_stream_events.ok',
      request_id: initialFetch.request_id,
      stream_id: 'hostc:codex:one',
      events: [],
    });
    await flushMicrotasks();
    socket.sent = [];
  }

  stream.appendOptimisticUserMessage('hostc:codex:one', 'ack-refresh');
  const sendPromise = stream.sendPentacleMessage({
    host: 'hostc',
    sessionName: 'one',
    text: 'ack-refresh',
  });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  expect(sendPayload?.optimistic_id).toBeTruthy();

  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    delivery: 'landed',
  });
  await expect(sendPromise).resolves.toBe(true);

  jest.advanceTimersByTime(0);
  const catchUp = sentFrames(socket, 'request_stream_events').at(-1);
  expect(catchUp).toEqual(expect.objectContaining({
    stream_id: 'hostc:codex:one',
    limit: 300,
    order: 'newest_first',
  }));
  unsubscribe();
});

test('proof_unavailable receipt and found:false keep an optimistic row pending instead of failed', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'receipt pending');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'receipt pending' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    state: 'accepted',
    delivery: 'proof_unavailable',
  });
  await expect(sendPromise).resolves.toBe(true);

  const receiptQuery = sentFrames(socket, 'send.receipt.get').at(-1);
  expect(receiptQuery).toEqual(expect.objectContaining({
    to_stream_id: 'hostc:codex:one',
    request_id: expect.any(String),
  }));
  socket.message({
    type: 'send.receipt.get.ok',
    request_id: receiptQuery?.request_id,
    found: false,
    receipts: [],
  });

  const send = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  expect(send).toMatchObject({ status: 'indeterminate' });
  expect(send?.failure_reason).toBeUndefined();
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimisticId)?.pending).toBe(true);
  unsubscribe();
});

test('receipt-landed emits one reconciliation trace with a finite fallback match time', async () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'receipt trace');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'receipt trace' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    state: 'accepted',
    delivery: 'proof_unavailable',
  });
  await expect(sendPromise).resolves.toBe(true);

  const receiptQuery = sentFrames(socket, 'send.receipt.get').at(-1);
  socket.message({
    type: 'send.receipt.get.ok',
    request_id: receiptQuery?.request_id,
    found: true,
    receipts: [{
      to_stream_id: 'hostc:codex:one',
      request_id: sendPayload?.request_id,
      state: 'landed',
    }],
  });

  const reconciled = seen.filter((payload) => (
    payload.message === core.TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED
    && payload.data.optimistic_id === optimisticId
  ));
  expect(reconciled).toHaveLength(1);
  expect(reconciled[0]?.data).toMatchObject({ stream_id: 'hostc:codex:one' });
  expect(Number.isFinite(reconciled[0]?.data.matched_ms)).toBe(true);
  core.setTelemetrySink(null);
  unsubscribe();
});

test('an echo followed by its landed receipt emits one reconciliation trace total', async () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'echo before receipt');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'echo before receipt' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    state: 'accepted',
    delivery: 'proof_unavailable',
  });
  await expect(sendPromise).resolves.toBe(true);

  const receiptQuery = sentFrames(socket, 'send.receipt.get').at(-1);
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      kind: 'USER',
      text: 'echo before receipt',
      optimistic_id: optimisticId,
      raw: { request_id: sendPayload?.request_id },
    }),
  });
  socket.message({
    type: 'send.receipt.get.ok',
    request_id: receiptQuery?.request_id,
    found: true,
    receipts: [{
      to_stream_id: 'hostc:codex:one',
      request_id: sendPayload?.request_id,
      state: 'landed',
    }],
  });

  expect(seen.filter((payload) => (
    payload.message === core.TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED
    && payload.data.optimistic_id === optimisticId
  ))).toHaveLength(1);
  core.setTelemetrySink(null);
  unsubscribe();
});

test('a landed receipt followed by its later echo emits one reconciliation trace total', async () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'receipt before echo');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'receipt before echo' });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    state: 'accepted',
    delivery: 'proof_unavailable',
  });
  await expect(sendPromise).resolves.toBe(true);

  const receiptQuery = sentFrames(socket, 'send.receipt.get').at(-1);
  socket.message({
    type: 'send.receipt.get.ok',
    request_id: receiptQuery?.request_id,
    found: true,
    receipts: [{
      to_stream_id: 'hostc:codex:one',
      request_id: sendPayload?.request_id,
      state: 'landed',
    }],
  });
  // The transcript echo arrives after the receipt already reconciled the row; it is a
  // restatement of the same transition, not a second one.
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      kind: 'USER',
      text: 'receipt before echo',
      optimistic_id: optimisticId,
      raw: { request_id: sendPayload?.request_id },
    }),
  });

  expect(seen.filter((payload) => (
    payload.message === core.TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED
    && payload.data.optimistic_id === optimisticId
  ))).toHaveLength(1);
  core.setTelemetrySink(null);
  unsubscribe();
});

test('direct-ID landed USER echo reconciles an attachment-only row and projects Sent', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const attachments = [{ key: 'a'.repeat(64), mime: 'image/jpeg', width: 10, height: 20, bytes: 30 }];
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', '', attachments);
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: '', attachments });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    state: 'accepted',
    delivery: 'proof_unavailable',
  });
  await expect(sendPromise).resolves.toBe(true);

  const receiptQuery = sentFrames(socket, 'send.receipt.get').at(-1);
  socket.message({
    type: 'send.receipt.get.ok',
    request_id: receiptQuery?.request_id,
    found: true,
    receipts: [{
      to_stream_id: 'hostc:codex:one',
      request_id: sendPayload?.request_id,
      state: 'accepted',
      delivery: 'proof_unavailable',
    }],
  });
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({ status: 'indeterminate' });

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      kind: 'USER',
      text: 'attachment receipt',
      optimistic_id: optimisticId,
      raw: {
        request_id: sendPayload?.request_id,
        receipt_state: 'landed',
        receipt_delivery: 'landed',
      },
    }),
  });

  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
  expect(stream.getPentacleStreamState().events.find((event) => event.optimistic_id === optimisticId)).toMatchObject({
    attachments,
    pending: false,
  });
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  expect(
    core.selectSessionDetail(stream.getPentacleStreamState(), 'hostc:codex:one', { visibleCount: 'all' })
      ?.transcriptItems.find((item) => item.optimisticId === optimisticId)?.receiptCaption,
  ).toBe('sent');
  unsubscribe();
});

test('a later direct-ID landed USER echo supersedes proof_unavailable on the same row', () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'late receipt state');
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      kind: 'USER',
      text: 'late receipt state',
      optimistic_id: optimisticId,
      raw: { receipt_state: 'accepted', receipt_delivery: 'proof_unavailable' },
    }),
  });
  // accepted-into-queue with proof_unavailable captions as Sent, not Failed
  // (pentacle-chat-core d794628). Only not_landed delivery captions failed.
  expect(
    core.selectSessionDetail(stream.getPentacleStreamState(), 'hostc:codex:one', { visibleCount: 'all' })
      ?.transcriptItems.find((item) => item.optimisticId === optimisticId)?.receiptCaption,
  ).toBe('sent');

  socket.message({
    type: 'chat.event',
    event: pentacleEvent({
      daemon_seq: 43,
      kind: 'USER',
      text: 'late receipt state',
      optimistic_id: optimisticId,
      raw: { receipt_state: 'landed', receipt_delivery: 'proof_unavailable' },
    }),
  });

  const detail = core.selectSessionDetail(stream.getPentacleStreamState(), 'hostc:codex:one', { visibleCount: 'all' });
  expect(detail?.transcriptItems.filter((item) => item.optimisticId === optimisticId)).toHaveLength(1);
  expect(detail?.transcriptItems.find((item) => item.optimisticId === optimisticId)?.receiptCaption).toBe('sent');
  unsubscribe();
});

test('accepted receipt query transitions an image-and-text optimistic row to failed only for not_landed', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const attachments = [{ key: 'b'.repeat(64), mime: 'image/jpeg', width: 10, height: 20, bytes: 30 }];
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'image and text', attachments);
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'image and text', attachments });
  const sendPayload = sentFrames(socket, 'send').at(-1);
  socket.message({
    type: 'send.result',
    request_id: sendPayload?.request_id,
    state: 'accepted',
    delivery: 'proof_unavailable',
  });
  await expect(sendPromise).resolves.toBe(true);

  const receiptQuery = sentFrames(socket, 'send.receipt.get').at(-1);
  socket.message({
    type: 'send.receipt.get.ok',
    request_id: receiptQuery?.request_id,
    found: true,
    receipts: [{
      to_stream_id: 'hostc:codex:one',
      request_id: sendPayload?.request_id,
      state: 'not_landed',
      delivery: 'not_landed',
      reason: 'provider_rejected',
    }],
  });

  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    status: 'failed',
    failure_reason: 'provider_rejected',
    attachments,
  });
  unsubscribe();
});

test('connect and reconnect reconcile retained pending rows without re-sending them', () => {
  const stream = loadStream();
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'reconnect receipt');
  const { unsubscribe, socket: first } = subscribeAndCreateSocket(stream);
  first.open();

  expect(sentFrames(first, 'send')).toHaveLength(0);
  expect(sentFrames(first, 'send.receipt.get')).toHaveLength(1);
  first.message({ type: 'send.receipt.get.ok', found: false, receipts: [] });
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({ status: 'queued' });

  first.closeFromServer();
  jest.advanceTimersByTime(1_000);
  const second = MockWebSocket.instances.at(-1) as MockWebSocket;
  second.open();

  expect(sentFrames(second, 'send')).toHaveLength(0);
  expect(sentFrames(second, 'send.receipt.get')).toHaveLength(1);
  unsubscribe();
});

test('uploadBlobBase64 sends init, chunk frames, and resolves the daemon blob sha', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const dataBase64 = `${'a'.repeat(1024 * 1024)}bbbb`;
  const uploadPromise = stream.uploadBlobBase64(dataBase64, 786_435);
  const initPayload = sentFrames(socket, 'upload_blob_init')[0];
  expect(initPayload).toMatchObject({
    type: 'upload_blob_init',
    size_hint_bytes: 786_435,
  });
  expect(typeof initPayload.request_id).toBe('string');

  socket.message({ type: 'upload_blob.init.ok', request_id: initPayload.request_id });
  await flushMicrotasks();

  const chunks = sentFrames(socket, 'upload_blob_chunk');
  const firstChunk = chunks[0];
  const finalChunk = chunks[1];
  expect(firstChunk).toMatchObject({
    type: 'upload_blob_chunk',
    request_id: initPayload.request_id,
    final: false,
  });
  expect(firstChunk.data_b64).toHaveLength(1024 * 1024);
  expect(finalChunk).toMatchObject({
    type: 'upload_blob_chunk',
    request_id: initPayload.request_id,
    data_b64: 'bbbb',
    final: true,
  });

  const blobSha = 'f'.repeat(64);
  socket.message({
    type: 'upload_blob.ok',
    request_id: initPayload.request_id,
    blob_sha: blobSha,
    size_bytes: 786_435,
  });
  await expect(uploadPromise).resolves.toEqual({ blob_sha: blobSha, size_bytes: 786_435 });
  unsubscribe();
});

test('uploadBlobBase64 rejects upload_blob.error responses', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const uploadPromise = stream.uploadBlobBase64('aaaa', 3);
  const initPayload = sentFrames(socket, 'upload_blob_init')[0];
  socket.message({
    type: 'upload_blob.error',
    request_id: initPayload.request_id,
    error_code: 'upload_blob_too_large',
  });

  await expect(uploadPromise).rejects.toThrow(/upload_blob_too_large/);
  unsubscribe();
});

test('fetchBlobBase64 sends fetch_blob and resolves small inline content', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const blobSha = 'f'.repeat(64);
  const fetchPromise = stream.fetchBlobBase64(blobSha);
  const fetchPayload = sentFrames(socket, 'fetch_blob')[0];
  expect(fetchPayload).toMatchObject({
    type: 'fetch_blob',
    blob_sha: blobSha,
  });

  socket.message({
    type: 'fetch_blob.ok',
    request_id: fetchPayload.request_id,
    blob_sha: blobSha,
    size_bytes: 5,
    content_b64: 'aGVsbG8=',
    final: true,
  });

  await expect(fetchPromise).resolves.toEqual({
    blob_sha: blobSha,
    size_bytes: 5,
    content_b64: 'aGVsbG8=',
  });
  unsubscribe();
});

test('fetchBlobBase64 combines streamed fetch_blob chunks before resolving', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const blobSha = 'e'.repeat(64);
  const fetchPromise = stream.fetchBlobBase64(blobSha);
  const fetchPayload = sentFrames(socket, 'fetch_blob')[0];

  socket.message({
    type: 'fetch_blob.chunk',
    request_id: fetchPayload.request_id,
    blob_sha: blobSha,
    size_bytes: 8,
    content_b64: 'YWJj',
    final: false,
  });
  socket.message({
    type: 'fetch_blob.ok',
    request_id: fetchPayload.request_id,
    blob_sha: blobSha,
    size_bytes: 8,
    content_b64: 'ZGVm',
    final: true,
  });

  await expect(fetchPromise).resolves.toEqual({
    blob_sha: blobSha,
    size_bytes: 8,
    content_b64: 'YWJjZGVm',
  });
  unsubscribe();
});

// Same regression, snapshot delivery path: if the chat.event echo arrives
// inside a snapshot (e.g. after a reconnect), the pending send should still
// resolve so the user-visible send completes.
test('snapshot-bundled chat.event USER echo resolves a pending sendPentacleMessage', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  socket.message({
    type: 'snapshot',
    sessions: [{
      stream_id: 'hostc:claude:two',
      host: 'hostc',
      provider: 'claude',
      session_name: 'two',
      last_event_at: '2026-05-18T00:00:00Z',
      last_text: '',
      last_kind: '',
      online: true,
    }],
    events: [],
  });

  stream.appendOptimisticUserMessage('hostc:claude:two', 'snapshot-text');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'two', text: 'snapshot-text' });
  const sendPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(sendPayload.type).toBe('send');

  socket.message({
    type: 'snapshot',
    sessions: [{
      stream_id: 'hostc:claude:two',
      host: 'hostc',
      provider: 'claude',
      session_name: 'two',
      last_event_at: '2026-05-18T00:00:01Z',
      last_text: 'snapshot-text',
      last_kind: 'USER',
      online: true,
    }],
    events: [{
      daemon_seq: 5,
      stream_id: 'hostc:claude:two',
      host: 'hostc',
      provider: 'claude',
      session_name: 'two',
      timestamp: new Date().toISOString(),
      kind: 'USER',
      text: 'snapshot-text',
    }],
  });

  await expect(sendPromise).resolves.toBe(true);
  unsubscribe();
});

test('records socket errors, constructor failures, and sends heartbeat pings', () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  jest.advanceTimersByTime(15000);
  expect(JSON.parse(socket.sent.at(-1) || '{}')).toEqual({ type: 'ping' });

  socket.onerror?.();
  expect(stream.getPentacleStreamState().lastError).toContain('tailnet endpoint');
  unsubscribe();

  class ThrowingWebSocket extends MockWebSocket {
    constructor(url: string) {
      super(url);
      throw new Error('constructor failed');
    }
  }
  global.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;
  const cleanup = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  expect(stream.getPentacleStreamState().lastError).toContain('constructor failed');
  cleanup();
});

test('persists deferred close before dispatch and removes the row only after inventory confirms closure', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-1', host: 'hostc', provider: 'codex', session_name: 'one', created_at: 'generation-1', online: true }],
  });
  expect(stream.getPentacleStreamState().sessions).toHaveLength(1);

  const closePromise = stream.closePentacleSession({ host: 'hostc', sessionName: 'one', streamId: 'stream-1' });
  await flushMicrotasks(12);
  const closePayload = sentFrames(socket, 'close').at(-1) || {};
  expect(closePayload).toMatchObject({ type: 'close', defer_if_working: true, host: 'hostc', session_name: 'one' });
  expect(stream.getPentacleStreamState().sessions).toHaveLength(1);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('queued');
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream-1');

  socket.message({
    type: 'close.ok',
    request_id: closePayload.request_id,
    deferred: true,
    intent_id: 'intent-1',
    session_generation: 'generation-1',
  });
  await expect(closePromise).resolves.toMatchObject({ deferred: true, queued: false, intentId: 'intent-1' });
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('deferred');

  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: 'stream-1', host: 'hostc', provider: 'codex', session_name: 'one', online: true,
      close_pending: true, close_intent_id: 'intent-1', session_generation: 'generation-1',
    }],
  });
  await flushMicrotasks();
  expect(stream.getPentacleStreamState().sessions).toHaveLength(1);

  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  expect(stream.getPentacleStreamState().sessions).toHaveLength(0);
  // Absence only becomes closure once the grace elapses; see the grace tests below.
  await advanceWithKeepalive(socket, PENDING_CLOSE_ABSENCE_GRACE_MS + 1);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).not.toContain('stream-1');
  unsubscribe();
});

// Pending-close inventory-absence grace
// (spec_pentacle_mobile__pending_close_inventory_grace_2026_07).
//
// Absence from a broadcast inventory is the daemon's ONLY close signal — no tombstone frame
// exists — but it is not a trustworthy one on its own: chat_streamd's _evict_inactive_summaries
// drops a live stream from session_summaries as soon as one LivePaneWatcher tick for its host
// omits it, so a partial cross-host list-panes tick makes a still-open session vanish and then
// reappear. Without a grace, that blip destroys the deferred-delete row along with its persisted
// retry/cancel state. These tests pin the grace, at parity with the reducer's
// OPTIMISTIC_INVENTORY_GRACE_MS.
const PENDING_CLOSE_ABSENCE_GRACE_MS = 60_000;

const OPEN_SESSION_ROW = {
  stream_id: 'stream-grace', host: 'hostc', provider: 'codex', session_name: 'grace',
  created_at: 'generation-grace', online: true,
} as const;
const CLOSE_PENDING_ROW = {
  ...OPEN_SESSION_ROW,
  close_pending: true, close_intent_id: 'intent-grace', session_generation: 'generation-grace',
} as const;

/**
 * Advances fake time without letting the liveness watchdog tear the socket down: the grace
 * outlives WATCHDOG_NO_FRAME_MS (30s), so the test answers the client's pings the way a live
 * daemon would. Deliberately never sends an inventory, so any removal that happens here is
 * driven by the grace timer alone and not by a later broadcast.
 */
async function advanceWithKeepalive(socket: MockWebSocket, ms: number) {
  for (let remaining = ms; remaining > 0; remaining -= 10_000) {
    jest.advanceTimersByTime(Math.min(remaining, 10_000));
    socket.message({ type: 'pong' });
    await flushMicrotasks(4);
  }
}

/** Drives a session to a persisted `deferred` pending-close, the state the grace protects. */
async function arrangeDeferredClose(
  stream: typeof import('../../src/services/pentacleStream'),
  socket: MockWebSocket,
) {
  socket.message({ type: 'session.inventory', sessions: [OPEN_SESSION_ROW] });
  const closePromise = stream.closePentacleSession({
    host: 'hostc', sessionName: 'grace', streamId: 'stream-grace',
  });
  await flushMicrotasks(12);
  const dispatched = sentFrames(socket, 'close').at(-1) || {};
  socket.message({
    type: 'close.ok', request_id: dispatched.request_id, deferred: true,
    intent_id: 'intent-grace', session_generation: 'generation-grace',
  });
  await closePromise;
  socket.message({ type: 'session.inventory', sessions: [CLOSE_PENDING_ROW] });
  await flushMicrotasks(6);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('deferred');
}

/**
 * The badge is a pure overlay over `state.sessions`, so while a session is absent the retained
 * row is invisible. Reappearance is what proves the pending close survived: the badge and its
 * intent come back attached.
 */
async function badgeAfterReappearance(
  stream: typeof import('../../src/services/pentacleStream'),
  socket: MockWebSocket,
) {
  socket.message({ type: 'session.inventory', sessions: [CLOSE_PENDING_ROW] });
  await flushMicrotasks(6);
  return (stream.getPentacleStreamState().sessions[0] as any).pending_close;
}

test('a single omitting inventory does not drop a pending-close row', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  expect(stream.getPentacleStreamState().sessions).toHaveLength(0);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream-grace');

  await advanceWithKeepalive(socket, PENDING_CLOSE_ABSENCE_GRACE_MS - 1000);
  expect(await badgeAfterReappearance(stream, socket)).toMatchObject({
    state: 'deferred', intentId: 'intent-grace',
  });
  unsubscribe();
});

test('sustained absence past the grace clears the row on the timer alone, with no further broadcast', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream-grace');

  await advanceWithKeepalive(socket, PENDING_CLOSE_ABSENCE_GRACE_MS + 1);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).not.toContain('stream-grace');
  // A session that comes back after the grace is a NEW row, not a resurrected delete-pending one.
  socket.message({ type: 'session.inventory', sessions: [OPEN_SESSION_ROW] });
  await flushMicrotasks(6);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  unsubscribe();
});

test('a session reappearing inside the grace resets the clock rather than resuming it', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  await advanceWithKeepalive(socket, PENDING_CLOSE_ABSENCE_GRACE_MS - 20_000);
  expect(await badgeAfterReappearance(stream, socket)).toMatchObject({ state: 'deferred' });

  // Second blip: a resumed clock would expire 20s in; a reset one must not.
  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  await advanceWithKeepalive(socket, PENDING_CLOSE_ABSENCE_GRACE_MS - 20_000);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream-grace');

  await advanceWithKeepalive(socket, 20_001);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).not.toContain('stream-grace');
  unsubscribe();
});

test('a reconnect discards accrued absence instead of crediting disconnected time', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  await advanceWithKeepalive(socket, PENDING_CLOSE_ABSENCE_GRACE_MS - 5000);

  socket.closeFromServer();
  jest.advanceTimersByTime(1000);
  const reconnected = MockWebSocket.instances.at(-1) as MockWebSocket;
  reconnected.open();
  await flushMicrotasks(12);

  // Absence observed before the reconnect says nothing about the new connection's inventory.
  reconnected.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  await advanceWithKeepalive(reconnected, PENDING_CLOSE_ABSENCE_GRACE_MS - 5000);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream-grace');

  await advanceWithKeepalive(reconnected, 5001);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).not.toContain('stream-grace');
  unsubscribe();
});

test('an unverifiable generation still fails a pending-close row immediately, without the grace', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  // Present but carrying neither session_generation nor created_at: the intent's target can no
  // longer be verified, which is authoritative and must not wait on an absence window.
  const { created_at: _createdAt, ...withoutGeneration } = OPEN_SESSION_ROW;
  socket.message({ type: 'session.inventory', sessions: [withoutGeneration] });
  await flushMicrotasks(6);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toMatchObject({
    state: 'failed', errorCode: 'close_generation_unavailable',
  });
  unsubscribe();
});

// Pins an invariant the grace newly depends on: before it, absence removed the row at once, so
// how a disconnect interacts with an in-flight window could not arise. It holds through
// clearTimers/connect() rather than a check inside the grace, so this passes against the parent
// commit too — it is an invariant pin, not a regression test.
test('a grace that expires while the socket is down does not remove the row', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  socket.closeFromServer();

  // Nothing here could have corrected the absence, so the armed timer must not act on it.
  jest.advanceTimersByTime(PENDING_CLOSE_ABSENCE_GRACE_MS * 2);
  await flushMicrotasks(8);
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).toContain('stream-grace');
  unsubscribe();
});

test('a replacement generation still clears a pending-close row immediately, without the grace', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await arrangeDeferredClose(stream, socket);

  // Present-but-replaced is authoritative: the intent targeted a session that no longer exists.
  socket.message({
    type: 'session.inventory',
    sessions: [{ ...OPEN_SESSION_ROW, created_at: 'generation-replacement' }],
  });
  await flushMicrotasks(6);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  expect(await AsyncStorage.getItem('pentacle-mobile:pending-session-closes:v1')).not.toContain('stream-grace');
  unsubscribe();
});

test('old-daemon session_working queues a capped retry with the stable request id', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-2', host: 'hostc', provider: 'codex', session_name: 'two', online: true }],
  });

  const closePromise = stream.closePentacleSession({ host: 'hostc', sessionName: 'two', streamId: 'stream-2' });
  await flushMicrotasks(12);
  const first = sentFrames(socket, 'close').at(-1) || {};
  socket.message({
    type: 'close.error', request_id: first.request_id, error: 'session_working',
    work_state: { working: true },
  });
  await expect(closePromise).resolves.toMatchObject({ queued: true });
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('retrying');

  jest.advanceTimersByTime(1000);
  await flushMicrotasks(6);
  const retry = sentFrames(socket, 'close').at(-1) || {};
  expect(retry).toMatchObject({ type: 'close', defer_if_working: true, request_id: first.request_id });
  socket.message({ type: 'close.degraded', request_id: retry.request_id });
  await flushMicrotasks(6);
  socket.message({ type: 'session.inventory', sessions: [] });
  await flushMicrotasks(6);
  expect(stream.getPentacleStreamState().sessions).toHaveLength(0);
  unsubscribe();
});

test('an immediate (non-deferred) close success waits for inventory and never re-dispatches a redundant close', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-idle', host: 'hostc', provider: 'codex', session_name: 'idle', created_at: 'generation-idle', online: true }],
  });

  const closePromise = stream.closePentacleSession({ host: 'hostc', sessionName: 'idle', streamId: 'stream-idle' });
  await flushMicrotasks(12);
  const first = sentFrames(socket, 'close').at(-1) || {};
  expect(sentFrames(socket, 'close')).toHaveLength(1);

  // Old/idle daemon closes immediately: close.ok with deferred!==true (closed now).
  socket.message({ type: 'close.ok', request_id: first.request_id, deferred: false });
  await expect(closePromise).resolves.toMatchObject({ closed: true, deferred: false });

  // A completed close must be a terminal waiting state, not an auto-retrying one.
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('accepted');

  // Even when authoritative inventory removal is delayed past the old 5s retry
  // window, no redundant close is re-dispatched for the already-closed session
  // (a redundant close could draw a not_found/unauthorized reply and flip the row to
  // a spurious "delete failed"). Inventory removal remains the sole clear signal —
  // covered by the deferred-close inventory-removal test above.
  jest.advanceTimersByTime(6000);
  await flushMicrotasks(12);
  expect(sentFrames(socket, 'close')).toHaveLength(1);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('accepted');
  unsubscribe();
});

test('an offline delete persists locally and dispatches after reconnect', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-offline', host: 'hostc', provider: 'codex', session_name: 'offline', created_at: 'generation-offline', online: true }],
  });
  socket.closeFromServer();

  await expect(stream.closePentacleSession({ host: 'hostc', sessionName: 'offline', streamId: 'stream-offline' }))
    .resolves.toMatchObject({ queued: true });
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close.state).toBe('queued');

  jest.advanceTimersByTime(1000);
  const reconnected = MockWebSocket.instances.at(-1) as MockWebSocket;
  reconnected.open();
  await flushMicrotasks(12);
  expect(sentFrames(reconnected, 'close')).toHaveLength(0);
  reconnected.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-offline', host: 'hostc', provider: 'codex', session_name: 'offline', created_at: 'generation-offline', online: true }],
  });
  jest.advanceTimersByTime(0);
  await flushMicrotasks(12);
  const dispatched = sentFrames(reconnected, 'close').at(-1) || {};
  expect(dispatched).toMatchObject({
    type: 'close', host: 'hostc', session_name: 'offline', defer_if_working: true,
  });
  reconnected.message({
    type: 'close.ok', request_id: dispatched.request_id, deferred: true,
    intent_id: 'intent-offline', session_generation: 'generation-offline',
  });
  await flushMicrotasks(8);
  unsubscribe();
});

test('reconnect inventory clears a stale generation before any close retry dispatches', async () => {
  await AsyncStorage.setItem('pentacle-mobile:pending-session-closes:v1', JSON.stringify({
    version: 1,
    records: [{
      streamId: 'stream-reused', host: 'hostc', sessionName: 'reused', requestId: 'close-old',
      sessionGeneration: 'generation-old', requestedAt: Date.now(), attempt: 1,
      nextAttemptAt: Date.now(), state: 'retrying',
    }],
  }));
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await flushMicrotasks(8);
  expect(sentFrames(socket, 'close')).toHaveLength(0);
  socket.message({
    type: 'snapshot',
    sessions: [{ stream_id: 'stream-reused', host: 'hostc', provider: 'codex', session_name: 'reused', created_at: 'generation-new', online: true }],
    events: [],
  });
  await flushMicrotasks(8);
  expect(sentFrames(socket, 'close')).toHaveLength(0);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  unsubscribe();
});

test('retry TTL is enforced after hydration and before the first inventory drain', async () => {
  await AsyncStorage.setItem('pentacle-mobile:pending-session-closes:v1', JSON.stringify({
    version: 1,
    records: [{
      streamId: 'stream-ttl', host: 'hostc', sessionName: 'ttl', requestId: 'close-ttl',
      sessionGeneration: 'generation-ttl', requestedAt: Date.now(), attempt: 2,
      nextAttemptAt: Date.now(), state: 'retrying',
    }],
  }));
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await flushMicrotasks(8);
  jest.setSystemTime(Date.now() + 10 * 60_000 + 1);
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-ttl', host: 'hostc', provider: 'codex', session_name: 'ttl', created_at: 'generation-ttl', online: true }],
  });
  await flushMicrotasks(8);
  expect(sentFrames(socket, 'close')).toHaveLength(0);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toMatchObject({
    state: 'exhausted', errorCode: 'retry_exhausted',
  });
  unsubscribe();
});

test('explicit Retry and Force wait for inventory and never target replacement generations', async () => {
  const now = Date.now();
  await AsyncStorage.setItem('pentacle-mobile:pending-session-closes:v1', JSON.stringify({
    version: 1,
    records: [
      {
        streamId: 'stream-retry-old', host: 'hostc', sessionName: 'retry-old', requestId: 'close-retry-old',
        sessionGeneration: 'generation-old', requestedAt: now - 10 * 60_000, attempt: 6,
        nextAttemptAt: 0, state: 'exhausted', errorCode: 'retry_exhausted', errorMessage: 'expired',
      },
      {
        streamId: 'stream-force-old', host: 'hostc', sessionName: 'force-old', requestId: 'close-force-old',
        sessionGeneration: 'generation-old', requestedAt: now, attempt: 1,
        nextAttemptAt: 0, state: 'failed', errorCode: 'close_failed', errorMessage: 'failed',
      },
      {
        streamId: 'stream-force-same', host: 'hostc', sessionName: 'force-same', requestId: 'close-force-same',
        sessionGeneration: 'generation-same', requestedAt: now, attempt: 1,
        nextAttemptAt: 0, state: 'failed', errorCode: 'close_failed', errorMessage: 'failed',
      },
    ],
  }));
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  await flushMicrotasks(8);

  await expect(stream.retryPendingSessionClose('stream-retry-old')).resolves.toBe(true);
  await expect(stream.forcePendingSessionClose('stream-force-old')).resolves.toBe(true);
  await expect(stream.forcePendingSessionClose('stream-force-same')).resolves.toBe(true);
  expect(sentFrames(socket, 'close')).toHaveLength(0);

  socket.message({
    type: 'session.inventory',
    sessions: [
      { stream_id: 'stream-retry-old', host: 'hostc', provider: 'codex', session_name: 'retry-old', created_at: 'generation-new', online: true },
      { stream_id: 'stream-force-old', host: 'hostc', provider: 'codex', session_name: 'force-old', created_at: 'generation-new', online: true },
      { stream_id: 'stream-force-same', host: 'hostc', provider: 'codex', session_name: 'force-same', created_at: 'generation-same', online: true },
    ],
  });
  await flushMicrotasks(12);
  const closes = sentFrames(socket, 'close');
  expect(closes).toHaveLength(1);
  expect(closes[0]).toMatchObject({ session_name: 'force-same', force: true });
  socket.message({ type: 'close.ok', request_id: closes[0].request_id });
  await flushMicrotasks(8);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  expect((stream.getPentacleStreamState().sessions[1] as any).pending_close).toBeUndefined();
  unsubscribe();
});

test('hydrated retry state resumes after restart and expires into actionable state', async () => {
  await AsyncStorage.setItem('pentacle-mobile:pending-session-closes:v1', JSON.stringify({
    version: 1,
    records: [{
      streamId: 'stream-restart', host: 'hostc', sessionName: 'restart', requestId: 'close-stable',
      requestedAt: Date.now() - 10 * 60_000, attempt: 6, nextAttemptAt: Date.now() - 1, state: 'retrying',
    }],
  }));
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [{ stream_id: 'stream-restart', host: 'hostc', provider: 'codex', session_name: 'restart', online: true }],
    events: [],
  });
  await flushMicrotasks(8);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toMatchObject({ state: 'exhausted', attempt: 6 });
  expect(socket.sent.filter((frame) => JSON.parse(frame).type === 'close')).toHaveLength(0);
  unsubscribe();
});

test('cancel is generation fenced and replacement inventory clears only the stale generation', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-cancel', host: 'hostc', provider: 'codex', session_name: 'cancel', created_at: 'generation-1', online: true }],
  });
  const closePromise = stream.closePentacleSession({ host: 'hostc', sessionName: 'cancel', streamId: 'stream-cancel' });
  await flushMicrotasks(12);
  const closePayload = sentFrames(socket, 'close').at(-1) || {};
  socket.message({
    type: 'close.ok', request_id: closePayload.request_id, deferred: true,
    intent_id: 'intent-cancel', session_generation: 'generation-1',
  });
  await closePromise;

  const cancelPromise = stream.cancelPendingSessionClose('stream-cancel');
  await flushMicrotasks(4);
  const cancelPayload = sentFrames(socket, 'close.cancel').at(-1) || {};
  expect(cancelPayload).toMatchObject({
    type: 'close.cancel', intent_id: 'intent-cancel', session_generation: 'generation-1',
  });
  socket.message({ type: 'close.cancel.ok', request_id: cancelPayload.request_id });
  await expect(cancelPromise).resolves.toBe(true);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();

  const replacementClose = stream.closePentacleSession({ host: 'hostc', sessionName: 'cancel', streamId: 'stream-cancel' });
  await flushMicrotasks(12);
  const replacementPayload = sentFrames(socket, 'close').at(-1) || {};
  socket.message({
    type: 'close.ok', request_id: replacementPayload.request_id, deferred: true,
    intent_id: 'intent-stale', session_generation: 'generation-1',
  });
  await replacementClose;
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-cancel', host: 'hostc', provider: 'codex', session_name: 'cancel', session_generation: 'generation-2', online: true }],
  });
  await flushMicrotasks(6);
  expect(stream.getPentacleStreamState().sessions).toHaveLength(1);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  unsubscribe();
});

test('cancel waits for an in-flight close acknowledgement and cancels the returned intent', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-race', host: 'hostc', provider: 'codex', session_name: 'race', created_at: 'generation-race', online: true }],
  });
  const closePromise = stream.closePentacleSession({ host: 'hostc', sessionName: 'race', streamId: 'stream-race' });
  await flushMicrotasks(12);
  const closePayload = sentFrames(socket, 'close').at(-1) || {};
  const cancelPromise = stream.cancelPendingSessionClose('stream-race');
  await flushMicrotasks(4);
  expect(sentFrames(socket, 'close.cancel')).toHaveLength(0);
  socket.message({
    type: 'close.ok', request_id: closePayload.request_id, deferred: true,
    intent_id: 'intent-race', session_generation: 'generation-race',
  });
  await expect(closePromise).resolves.toMatchObject({ deferred: true });
  await flushMicrotasks(8);
  const cancelPayload = sentFrames(socket, 'close.cancel').at(-1) || {};
  expect(cancelPayload).toMatchObject({ intent_id: 'intent-race', session_generation: 'generation-race' });
  socket.message({ type: 'close.cancel.ok', request_id: cancelPayload.request_id });
  await expect(cancelPromise).resolves.toBe(true);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  unsubscribe();
});

test('a claimed-intent cancel refusal remains persisted and actionable', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-claimed', host: 'hostc', provider: 'codex', session_name: 'claimed', created_at: 'generation-claimed', online: true }],
  });
  const closePromise = stream.closePentacleSession({ host: 'hostc', sessionName: 'claimed', streamId: 'stream-claimed' });
  await flushMicrotasks(12);
  const closePayload = sentFrames(socket, 'close').at(-1) || {};
  socket.message({
    type: 'close.ok', request_id: closePayload.request_id, deferred: true,
    intent_id: 'intent-claimed', session_generation: 'generation-claimed',
  });
  await closePromise;
  const cancelPromise = stream.cancelPendingSessionClose('stream-claimed');
  await flushMicrotasks(6);
  const cancelPayload = sentFrames(socket, 'close.cancel').at(-1) || {};
  socket.message({
    type: 'close.cancel.error', request_id: cancelPayload.request_id,
    error_code: 'intent_not_pending', error: 'Close intent is already claimed',
  });
  await expect(cancelPromise).rejects.toMatchObject({ errorCode: 'intent_not_pending' });
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toMatchObject({
    state: 'failed', errorCode: 'intent_not_pending', errorMessage: 'Close intent is already claimed',
  });
  unsubscribe();
});

test('restart clears a cancelling row when authoritative inventory has no pending intent', async () => {
  await AsyncStorage.setItem('pentacle-mobile:pending-session-closes:v1', JSON.stringify({
    version: 1,
    records: [{
      streamId: 'stream-cancel-restart', host: 'hostc', sessionName: 'cancel-restart', requestId: 'close-cancel-restart',
      sessionGeneration: 'generation-cancel-restart', requestedAt: Date.now(), attempt: 0,
      nextAttemptAt: 0, state: 'cancelling',
    }],
  }));
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-cancel-restart', host: 'hostc', provider: 'codex', session_name: 'cancel-restart', created_at: 'generation-cancel-restart', online: true }],
  });
  await flushMicrotasks(8);
  expect(sentFrames(socket, 'close.cancel')).toHaveLength(0);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toBeUndefined();
  unsubscribe();
});

test('restart resumes cancellation from pending inventory and persists a refusal', async () => {
  await AsyncStorage.setItem('pentacle-mobile:pending-session-closes:v1', JSON.stringify({
    version: 1,
    records: [{
      streamId: 'stream-cancel-resume', host: 'hostc', sessionName: 'cancel-resume', requestId: 'close-cancel-resume',
      sessionGeneration: 'generation-cancel-resume', requestedAt: Date.now(), attempt: 0,
      nextAttemptAt: 0, state: 'cancelling',
    }],
  }));
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: 'stream-cancel-resume', host: 'hostc', provider: 'codex', session_name: 'cancel-resume',
      created_at: 'generation-cancel-resume', close_pending: true, close_intent_id: 'intent-cancel-resume', online: true,
    }],
  });
  await flushMicrotasks(12);
  const cancelPayload = sentFrames(socket, 'close.cancel').at(-1) || {};
  expect(cancelPayload).toMatchObject({
    intent_id: 'intent-cancel-resume', session_generation: 'generation-cancel-resume',
  });
  socket.message({
    type: 'close.cancel.error', request_id: cancelPayload.request_id,
    error_code: 'intent_not_pending', error: 'Close intent is already claimed',
  });
  await flushMicrotasks(8);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toMatchObject({
    state: 'failed', errorCode: 'intent_not_pending', errorMessage: 'Close intent is already claimed',
  });
  unsubscribe();
});

test('typed nontransient close errors keep the row and expose a failed pending action', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  socket.message({
    type: 'session.inventory',
    sessions: [{ stream_id: 'stream-denied', host: 'hostc', provider: 'codex', session_name: 'denied', online: true }],
  });
  const failingClose = stream.closePentacleSession({ host: 'hostc', sessionName: 'denied', streamId: 'stream-denied' });
  await flushMicrotasks(12);
  const failingPayload = sentFrames(socket, 'close').at(-1) || {};
  socket.message({ type: 'close.error', request_id: failingPayload.request_id, error: 'not authorized', error_code: 'unauthorized' });
  await expect(failingClose).rejects.toMatchObject({ name: 'CloseSessionError', errorCode: 'unauthorized' });
  expect(stream.getPentacleStreamState().sessions).toHaveLength(1);
  expect((stream.getPentacleStreamState().sessions[0] as any).pending_close).toMatchObject({
    state: 'failed', errorCode: 'unauthorized', errorMessage: 'not authorized',
  });
  unsubscribe();
});

test('enrolls devices over a one-shot websocket and rejects enrollment errors', async () => {
  const stream = loadStream();

  const enrollPromise = stream.enrollPentacleDevice('abc123', 'ws://enroll.example/ws');
  const socket = MockWebSocket.instances[0];
  socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({
    type: 'enroll',
    client: 'pentacle-mobile',
    code: 'ABC123',
    protocol_version: 2,
    scheme: 'hmac-sha256-v2',
  });
  socket.message({
    type: 'enroll.ok',
    token: OPERATOR_V2_ENVELOPE,
    protocol_version: 2,
    scheme: 'hmac-sha256-v2',
    client_kind: 'pentacle-mobile',
  });
  await expect(enrollPromise).resolves.toEqual({ token: OPERATOR_V2_ENVELOPE });

  const errorPromise = stream.enrollPentacleDevice('bad', 'ws://enroll.example/ws');
  const errorSocket = MockWebSocket.instances[1];
  errorSocket.open();
  errorSocket.message({ type: 'enroll.error', error: 'bad code' });
  await expect(errorPromise).rejects.toThrow('bad code');
});

test.each([
  { token: 'legacy-bearer', protocol_version: 1, scheme: 'shared-bearer-v1', client_kind: 'pentacle-mobile' },
  { token: OPERATOR_V2_ENVELOPE, protocol_version: 1, scheme: 'hmac-sha256-v2', client_kind: 'pentacle-mobile' },
  { token: OPERATOR_V2_ENVELOPE, protocol_version: 2, scheme: 'shared-bearer-v1', client_kind: 'pentacle-mobile' },
  { token: OPERATOR_V2_ENVELOPE, protocol_version: 2, scheme: 'hmac-sha256-v2', client_kind: 'pentacle' },
  { token: OPERATOR_V2_ENVELOPE, scheme: 'hmac-sha256-v2', client_kind: 'pentacle-mobile' },
  { token: OPERATOR_V2_ENVELOPE, protocol_version: 2, client_kind: 'pentacle-mobile' },
  { token: OPERATOR_V2_ENVELOPE, protocol_version: 2, scheme: 'hmac-sha256-v2' },
  { token: 'pentacle-auth-v2:forged', protocol_version: 2, scheme: 'hmac-sha256-v2', client_kind: 'pentacle-mobile' },
])('rejects enrollment downgrade or malformed v2 response %#', async (response) => {
  const stream = loadStream();
  const enrollPromise = stream.enrollPentacleDevice('abc123', 'ws://enroll.example/ws');
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'enroll.ok', ...response });
  await expect(enrollPromise).rejects.toThrow('protocol mismatch');
});

test('legacy enrollment is explicit and rejects v2 credentials', async () => {
  const stream = loadStream();
  const enrollPromise = stream.enrollPentacleDeviceLegacy('abc123', 'ws://enroll.example/ws');
  const socket = MockWebSocket.instances[0];
  socket.open();
  expect(JSON.parse(socket.sent[0])).toEqual({
    type: 'enroll',
    client: 'pentacle-mobile',
    code: 'ABC123',
  });
  socket.message({
    type: 'enroll.ok',
    token: 'legacy-bearer',
    protocol_version: 1,
    scheme: 'shared-bearer-v1',
    client_kind: 'pentacle-mobile',
  });
  await expect(enrollPromise).resolves.toEqual({ token: 'legacy-bearer' });

  const rejected = stream.enrollPentacleDeviceLegacy('abc123', 'ws://enroll.example/ws');
  const nextSocket = MockWebSocket.instances[1];
  nextSocket.open();
  nextSocket.message({
    type: 'enroll.ok',
    token: OPERATOR_V2_ENVELOPE,
    protocol_version: 1,
    scheme: 'shared-bearer-v1',
    client_kind: 'pentacle-mobile',
  });
  await expect(rejected).rejects.toThrow('protocol mismatch');
});

test('rejects enrollment connection close and malformed messages', async () => {
  const stream = loadStream();
  const enrollPromise = stream.enrollPentacleDevice('abc', 'ws://enroll.example/ws');
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.onmessage?.({ data: '{bad-json' });

  await expect(enrollPromise).rejects.toThrow('malformed');
});

test('rejects enrollment constructor and socket errors', async () => {
  const stream = loadStream();

  class ThrowingWebSocket extends MockWebSocket {
    constructor(url: string) {
      super(url);
      throw new Error('open failed');
    }
  }
  global.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;
  await expect(stream.enrollPentacleDevice('abc', 'ws://enroll.example/ws')).rejects.toThrow('open failed');

  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const errorPromise = stream.enrollPentacleDevice('abc', 'ws://enroll.example/ws');
  MockWebSocket.instances.at(-1)?.onerror?.();
  await expect(errorPromise).rejects.toThrow('connection failed');
});

test('uses custom websocket URLs and generic connection error messages', () => {
  const stream = loadStream();
  stream.setPentacleWsUrl('ws://custom.example/ws');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];

  expect(socket.url).toBe('ws://custom.example/ws');
  socket.onerror?.();
  expect(stream.getPentacleStreamState().lastError).toBe('Pentacle stream connection failed (ws://custom.example/ws)');
  unsubscribe();
});

test('falls back from a custom websocket URL to the default endpoint on reconnect outside harness', () => {
  const stream = loadStream();
  stream.setPentacleWsUrl('ws://custom.example/ws');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  const first = MockWebSocket.instances[0];
  expect(first.url).toBe('ws://custom.example/ws');
  first.open();
  first.closeFromServer();
  jest.advanceTimersByTime(1000);

  expect(MockWebSocket.instances[1].url).toBe('ws://default.example/ws');
  unsubscribe();
});

test('pins harness ws_url across reconnects', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?scenario=mock&ws_url=ws%3A%2F%2F127.0.0.1%3A65015');
  stream.setPentacleWsUrl('ws://127.0.0.1:65015');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);

  const first = MockWebSocket.instances[0];
  expect(first.url).toBe('ws://127.0.0.1:65015');
  first.open();
  first.closeFromServer();
  jest.advanceTimersByTime(1000);

  expect(MockWebSocket.instances[1].url).toBe('ws://127.0.0.1:65015');
  harnessRuntime.reset();
  unsubscribe();
});

test('all-chats stress harness requests full events without changing the default summary subscription', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?actions=all_chats_regression');
  stream.setPentacleAuthToken('fixture-token');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);

  socket.open();
  await flushMicrotasks();

  expect(sentFrames(socket, 'hello')[0].subscribe).toEqual({
    events_mode: 'full',
    include_subagents: true,
  });
  harnessRuntime.reset();
  unsubscribe();
});

test('production reconnect clears prior events', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken('fixture-token');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, text: 'before reconnect' }) });
  expect(stream.getPentacleStreamState().events).toHaveLength(1);

  stream.reconnectPentacleStream();

  expect(stream.getPentacleStreamState().events).toHaveLength(0);
  unsubscribe();
});

test('armed all-chats harness reconnect preserves prior events', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  harnessRuntime.applyURL('pentacle://harness?actions=all_chats_regression');
  stream.setPentacleAuthToken('fixture-token');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 1, text: 'before harness reconnect' }) });
  expect(stream.getPentacleStreamState().events).toHaveLength(1);

  stream.reconnectPentacleStream();

  expect(stream.getPentacleStreamState().events).toHaveLength(1);
  harnessRuntime.reset();
  unsubscribe();
});

// ───────────────────────────────────────────────────────────────────────────
// REPRO: send lifecycle over a lossy link (characterization of CURRENT behavior).
// Captures the operator-reported "stuck waiting", "my message didn't show", and
// "says failed but actually sent" so we can confirm the root cause before fixing.
// ───────────────────────────────────────────────────────────────────────────

function userEcho(text: string, seq: number, optimisticId?: string) {
  return {
    daemon_seq: seq,
    stream_id: 'hostc:codex:one',
    host: 'Hostc',
    provider: 'codex',
    session_id: 'hostc:codex:one',
    session_name: 'one',
    timestamp: `2026-05-08T00:00:${String(seq).padStart(2, '0')}Z`,
    kind: 'USER',
    text,
    correlatedDaemonSeq: seq,
    ...(optimisticId ? { optimistic_id: optimisticId } : {}),
  };
}

test('REPRO sanity: a live USER echo stamped with optimistic_id clears the sending state', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary()] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'hello there');
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeDefined();

  socket.message({ type: 'chat.event', event: userEcho('hello there', 50, optimisticId) });

  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
  unsubscribe();
});

test('REPRO stuck: refetch WITHOUT the held message leaves the row stuck "sending"', async () => {
  // Send-while-working: the daemon holds the message until the turn goes idle, so
  // it is not yet a committed USER event. Navigating away + back refetches history
  // that does NOT include it -> the optimistic row stays pending with no progress.
  // Matches "stuck waiting" + "I see the working state but not my message".
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary()] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'queued while working');

  const refetch = stream.requestStreamEvents('hostc:codex:one', 48);
  const request = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({ type: 'request_stream_events.ok', request_id: request?.request_id, stream_id: 'hostc:codex:one', events: [assistantEvent('agent working', 7)] });
  await refetch;

  const s = stream.getPentacleStreamState();
  expect(s.optimisticSends?.[optimisticId]).toBeDefined(); // still "sending"
  expect(s.events.find((e) => e.optimistic_id === optimisticId)?.pending).toBe(true);
  unsubscribe();
});

test('REPRO recovery: once the daemon commits the held message, a refetch reconciles it', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary()] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'eventually committed');

  const refetch = stream.requestStreamEvents('hostc:codex:one', 48);
  const request = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({ type: 'request_stream_events.ok', request_id: request?.request_id, stream_id: 'hostc:codex:one', events: [userEcho('eventually committed', 9, optimisticId)] });
  await refetch;

  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
  unsubscribe();
});

test('FEAT-SEND-NO-FALSE-FAILED (sweep): a transmitted send with no echo stays "sending" and is NEVER auto-flipped to failed by the reconcile-window timer', () => {
  // Model: a transmitted send stays "sending" until the daemon echoes it; we
  // NEVER guess "failed" from confirmation lag. The daemon legitimately holds
  // send-while-working messages and the echo can be delayed/dropped on the lossy
  // link — flipping to "failed" on a timer was the "says failed but actually
  // sent" bug. failed is reachable ONLY from a hard transport/daemon-reject.
  jest.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary()] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'slow but lands');

  // Far past the old 60s reconcile window (lossy link / daemon holding).
  jest.setSystemTime(new Date('2026-05-08T00:05:00.000Z'));
  jest.advanceTimersByTime(300_000);

  const send = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  expect(send).toBeDefined();
  expect(send?.status).not.toBe('failed');
  unsubscribe();
});

test('FEAT-SEND-RETRY: Retry on a failed send re-arms it to "sending" and re-transmits by optimistic_id', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary()] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'retry me');
  stream.markOptimisticFailed(optimisticId, 'send_error');
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('failed');
  expect(stream.getPentacleStreamState().events.find((e) => e.optimistic_id === optimisticId)?.pending).toBe(false);
  const sendsBefore = sentFrames(socket, 'send').length;

  stream.retryOptimisticSend(optimisticId);

  const send = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
  expect(send?.status).not.toBe('failed'); // back to "sending"
  expect(send?.failure_reason).toBeUndefined();
  // the visual row is pending again, and the send was re-transmitted by id.
  expect(stream.getPentacleStreamState().events.find((e) => e.optimistic_id === optimisticId)?.pending).toBe(true);
  const sendsAfter = sentFrames(socket, 'send');
  expect(sendsAfter.length).toBe(sendsBefore + 1);
  expect(sendsAfter.at(-1)?.optimistic_id).toBe(optimisticId);
  unsubscribe();
});

test('FEAT-OVERLAY-ISOLATION: a "failed sending" overlay is NOT auto-deleted when new daemon messages arrive (removed only by retry / dismiss / matching echo)', () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary()] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'failed but kept');
  stream.markOptimisticFailed(optimisticId, 'send_error');

  // Unrelated daemon traffic for the same stream must NOT drop the failed row
  // (it carries the user's text + Retry; losing it would lose their message).
  socket.message({ type: 'chat.event', event: assistantEvent('agent says hi', 77) });
  socket.message({ type: 'chat.event', event: assistantEvent('still working', 78) });

  const state = stream.getPentacleStreamState();
  expect(state.optimisticSends?.[optimisticId]?.status).toBe('failed');
  expect(state.events.find((e) => e.optimistic_id === optimisticId)?.text).toBe('failed but kept');
  unsubscribe();
});

// ───────────────────────────────────────────────────────────────────────────
// REPRO (terminal-message-not-showing): the open bug picked up in this lane.
// A chat is open, its history fetch has NOT completed (the lossy-link
// request_stream_events stalls), and the agent is WORKING — so the session
// the working indicator updates live (the operator IS receiving daemon state)
// but the session-summary fallback row is suppressed (model line ~920). A
// message typed into the agent's terminal (tmux) then arrives as a live USER
// chat.event. Does the operator see it?  This test discriminates the two
// candidate mechanisms from the handoff:
//   (a) the CLIENT drops/hides a delivered live terminal USER event so the
//       transcript stays empty behind the loading state; or
//   (b) the client renders a delivered terminal event correctly, in which case
//       the real-world miss is daemon DELIVERY (summary-mode client gets only
//       working.state, not the live chat.event) and the fix is fetch-reliably.
// ───────────────────────────────────────────────────────────────────────────

function terminalUserEvent(text: string, seq: number) {
  return {
    daemon_seq: seq,
    stream_id: 'hostc:codex:one',
    host: 'Hostc',
    provider: 'codex',
    session_id: 'hostc:codex:one',
    session_name: 'one',
    timestamp: `2026-05-08T00:00:${String(seq).padStart(2, '0')}Z`,
    kind: 'USER',
    text,
    // Did NOT originate on this mobile client: no optimistic_id, no client_origin.
    raw: { source: 'terminal' },
  };
}

test('FEAT-LOAD-DELIVERED-TERMINAL / REPRO terminal-not-showing: a delivered live terminal USER event surfaces even when history has not loaded and the agent is working', () => {
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  // Summary-mode hello snapshot: the session is present and WORKING, with no
  // events bundle (events_mode='summary'). History fetch is deliberately NOT
  // satisfied here — the lossy link is mid-stall.
  socket.message({ type: 'snapshot', sessions: [sessionSummary('hostc:codex:one', { working: true })] });

  // The screen renders selectSessionDetail on every pass, so the loading render
  // populates the session-detail cache with an EMPTY transcript first. A stale
  // cache that survived the live event would keep the operator on the spinner.
  const loadingDetail = core.selectSessionDetail(stream.getPentacleStreamState(), 'hostc:codex:one', {});
  expect(loadingDetail?.transcriptItems.length ?? 0).toBe(0);

  // The terminal/tmux send arrives over the live broadcast.
  socket.message({ type: 'chat.event', event: terminalUserEvent('hello from the terminal', 50) });

  const state = stream.getPentacleStreamState();
  // Store-level: the handoff claims live chat.event is applied unconditionally.
  expect(state.events.some((e) => e.text === 'hello from the terminal')).toBe(true);

  // Render-level (cache-exercised): does the operator actually SEE it in the
  // default (tools-hidden) transcript while history is unloaded and working?
  const detail = core.selectSessionDetail(state, 'hostc:codex:one', {});
  const shown = Boolean(detail?.transcriptItems.some((item) => item.text.includes('hello from the terminal')));
  expect(shown).toBe(true);
  unsubscribe();
});

// --- Phantom load-earlier affordance (spec_pentacle_mobile__phantom_load_earlier_button_2026_07) ---
//
// `hasOlderHistoryPage` must mean "the server has older events", not "we happen to hold a
// cursor". The history frames carry no has_more/total field (parsed at pentacleStream.ts:2492
// and :2514 — that parse site is the compat surface for this contract), so availability is
// inferred from the short-page evidence already in the response: fewer events than requested
// means we reached the beginning of the stream.

test('short mount-fetch page proves exhaustion — no load-earlier affordance', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 48);
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [1, 2, 3].map((daemon_seq) => pentacleEvent({ daemon_seq, text: `history ${daemon_seq}` })),
    complete: true,
  });
  await fetchPromise;

  expect(
    stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage,
  ).toBe(false);
});

test('brand-new chat with an empty history response shows no load-earlier affordance', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 48);
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
    complete: true,
  });
  await fetchPromise;

  const slice = stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one');
  expect(slice.hasOlderHistoryPage).toBe(false);
  // The screen's gate is `loadedEarlierRemaining > 0 || hasOlderHistoryPage`
  // (app/pentacle/session/[streamId].tsx:1795); both sides must be falsy on an empty chat.
  expect(slice.detail?.remainingCount || 0).toBe(0);
});

test('a full mount-fetch page keeps the load-earlier affordance available', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 3);
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [1, 2, 3].map((daemon_seq) => pentacleEvent({ daemon_seq, text: `history ${daemon_seq}` })),
    complete: true,
  });
  await fetchPromise;

  expect(
    stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage,
  ).toBe(true);
});

test('a short page marked rehydrate_failed proves nothing — affordance stays available', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 48);
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [1, 2, 3].map((daemon_seq) => pentacleEvent({ daemon_seq, text: `history ${daemon_seq}` })),
    rehydrate_failed: true,
    complete: true,
  });
  await fetchPromise;

  // The daemon could not read history; older events may well exist.
  expect(
    stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage,
  ).toBe(true);
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:one']).toMatchObject({
    coverageByWindow: { history: { complete: false } },
    requestsByWindow: { history: { status: 'error' } },
  });
  stream.prefetchStreamEvents('hostc:codex:one', 'press-in');
  expect(sentFrames(socket, 'request_stream_events')).toHaveLength(2);
  unsubscribe();
});

test('exhaustion reopens when a later backfill reveals older history', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  // An empty response marks exhaustion WITHOUT ever setting a cursor.
  const emptyPromise = stream.requestStreamEvents('hostc:codex:one', 48);
  const empty = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: empty.request_id,
    stream_id: 'hostc:codex:one',
    events: [],
    complete: true,
  });
  await emptyPromise;
  expect(
    stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage,
  ).toBe(false);

  // A later full page proves history exists after all. That first-learned cursor must reopen
  // the affordance rather than leave the stream stranded behind a stale exhaustion flag.
  const fullPromise = stream.requestStreamEvents('hostc:codex:one', 3);
  const full = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: full.request_id,
    stream_id: 'hostc:codex:one',
    events: [1, 2, 3].map((daemon_seq) => pentacleEvent({ daemon_seq, text: `backfill ${daemon_seq}` })),
    complete: true,
  });
  await fullPromise;

  expect(
    stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage,
  ).toBe(true);
  unsubscribe();
});

test('a completion with no known requested limit never infers exhaustion', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 3);
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload.request_id,
    stream_id: 'hostc:codex:one',
    events: [1, 2, 3].map((daemon_seq) => pentacleEvent({ daemon_seq, text: `history ${daemon_seq}` })),
    complete: true,
  });
  await fetchPromise;

  // An unsolicited/duplicate completion carrying no events must not retroactively
  // mark the stream exhausted — there is no requested count to compare against.
  socket.message({
    type: 'request_stream_events.ok',
    request_id: 'unknown-request-id',
    stream_id: 'hostc:codex:one',
    events: [],
    complete: true,
  });

  expect(
    stream.selectStreamSlice(stream.getPentacleStreamState(), 'hostc:codex:one').hasOlderHistoryPage,
  ).toBe(true);
  unsubscribe();
});

test('mismatched-stream and duplicate completions cannot mutate a live request window', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();

  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 3);
  const payload = sentFrames(socket, 'request_stream_events').at(-1);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload?.request_id,
    events: [],
    complete: true,
  });
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:one']?.coverageByWindow?.history)
    .toBeUndefined();
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload?.request_id,
    stream_id: 'hostc:codex:other',
    events: [pentacleEvent({ stream_id: 'hostc:codex:other', daemon_seq: 1, text: 'wrong stream' })],
  });
  expect(stream.getPentacleStreamState().events).toEqual([]);
  expect(stream.getPentacleStreamState().eventBucketsByStream?.['hostc:codex:one']?.requestsByWindow?.history?.token)
    .toBe(payload?.request_id);

  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload?.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 2, text: 'accepted stream' })],
  });
  await expect(fetchPromise).resolves.toHaveLength(1);
  socket.message({
    type: 'request_stream_events.ok',
    request_id: payload?.request_id,
    stream_id: 'hostc:codex:one',
    events: [pentacleEvent({ daemon_seq: 3, text: 'duplicate late row' })],
  });
  expect(stream.getPentacleStreamState().events.map((event) => event.text)).toEqual(['accepted stream']);
  unsubscribe();
});

// spec_pentacle_mobile__chats_list_v2_load_fixes_2026_08 defect 1:
// `send.result` reason `batch_submitted` acknowledges native-queue acceptance
// but not the later USER echo. HEAD leaves the optimistic row in a sending
// status and relies solely on a one-shot reconcile catch-up; a missed echo
// pins the row 'sending' for the process lifetime, inflating getSessionSendingState
// per emit. A TTL fallback must settle the row after the reconcile window.
test('batch_submitted optimistic row settles after the reconcile window without a USER echo', async () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  expect(stream.getPentacleStreamState().connected).toBe(true);
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'batch me');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'batch me' });
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
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'batch me');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'batch me' });
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

// The fallback must not false-FAIL a message that actually landed. When the keyed
// USER echo arrives within the window (server truth), the row reconciles and the
// expiry fallback is a no-op — it never flips a delivered send to failed.
test('batch_submitted whose USER echo lands is reconciled, never false-failed by the fallback', async () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'batch me');
  const sendPromise = stream.sendPentacleMessage({ host: 'hostc', sessionName: 'one', text: 'batch me' });
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

// spec_pentacle_mobile__chats_list_v2_load_fixes_2026_08 defect 3 (structural) /
// AC "Emits-per-inbound-frame ceiling enforced by test": a single chat.event can
// drive several setState() calls (flush the deferred live batch AND apply the
// event). Without emit coalescing each notifies subscribers, so the chat-list
// selector re-derives multiple times per frame under load. The frame must notify
// subscribers at most once.
test('coalesces multiple setState calls in one inbound frame into a single emit', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  // Arm the live batch window with a leading USER event, then defer an ASSIST
  // into that window (do not advance timers so it stays batched).
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 5, kind: 'USER', text: 'first', client_origin: false }) });
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 6, kind: 'ASSIST', text: 'batched row' }) });

  const listener = jest.fn();
  const off = stream.subscribePentacleStream(listener);
  listener.mockClear();

  // This USER frame flushes the batched ASSIST (setState #1) AND applies itself
  // (setState #2) — one frame, two state transitions.
  socket.message({
    type: 'chat.event',
    event: pentacleEvent({ daemon_seq: 7, kind: 'USER', text: 'user line', client_origin: false }),
  });

  expect(listener).toHaveBeenCalledTimes(1);
  off();
  unsubscribe();
});

test('deferred batch live apply timing includes one synchronous listener cost', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  armAllChatsCohort('listener-inclusive-timing', 1, 2, 1);
  const setup = allChatsAssistantEvent(1, 1);
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);

  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'session.inventory', sessions: [sessionSummary(setup.stream_id, { working: false })] });

  socket.message({
    type: 'chat.event',
    event: setup,
  });

  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 5, kind: 'USER', text: 'leading', client_origin: false }) });
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 6, kind: 'ASSIST', text: 'deferred' }) });
  let batchListenerCalls = 0;
  const offBatch = stream.subscribePentacleStream(() => {
    batchListenerCalls += 1;
    clock.advance(25);
  });
  batchListenerCalls = 0;
  socket.message({ type: 'chat.event', event: pentacleEvent({ daemon_seq: 7, kind: 'USER', text: 'flush', client_origin: false }) });

  const timing = (source: string, seq?: number) => seen.find((payload) => (
    String(payload.message) === 'harness:ui_trace' &&
    payload.data?.kind === 'live_apply_timing' &&
    payload.data.source === source &&
    (seq === undefined || (
      payload.data.first_seq === seq &&
      payload.data.last_seq === seq
    ))
  ));
  expect(timing('chat.event.batch', 6)?.data?.set_state_ms).toBe(25);
  expect(batchListenerCalls).toBe(1);

  offBatch();
  unsubscribe();
  core.setTelemetrySink(null);
  clock.restore();
});

// spec_pentacle_mobile__chats_list_v2_load_fixes_2026_08 validation-plan budget
// "no-emit on value-equal working.state": a repeated identical working.state
// frame must not notify subscribers (it changes nothing), else the chat-list
// re-derives on every redundant frame under daemon-v2 working.state churn.
test('direct live apply timing includes one synchronous listener cost', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  armAllChatsCohort('direct-listener-timing', 1, 2, 1);

  const setup = allChatsAssistantEvent(1, 1);
  const current = {
    ...allChatsAssistantEvent(2, 1),
    kind: 'WORKING' as const,
    raw: { working: true },
  };
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({
    type: 'session.inventory',
    sessions: [sessionSummary(current.stream_id, { working: false })],
  });
  stream.registerFocusedPentacleStream(current.stream_id);
  socket.message({ type: 'chat.event', event: setup });
  let listenerCalls = 0;
  let listenerElapsedMs = 0;
  const off = stream.subscribePentacleStream(() => {
    listenerCalls += 1;
    const startedAt = globalThis.performance.now();
    clock.advance(25);
    listenerElapsedMs = globalThis.performance.now() - startedAt;
  });
  seen.length = 0;
  socket.message({ type: 'chat.event', event: current });

  expect(listenerCalls).toBe(1);
  expect(listenerElapsedMs).toBe(25);
  const timing = seen.find((payload) => (
    String(payload.message) === 'harness:ui_trace' &&
    payload.data?.kind === 'live_apply_timing' &&
    payload.data.source === 'chat.event.immediate'
  ));
  expect(timing).toBeDefined();
  expect(timing?.data?.set_state_ms).toBe(25);

  off();
  unsubscribe();
  core.setTelemetrySink(null);
  clock.restore();
});

test('a value-equal working.state frame does not notify subscribers', () => {
  const stream = loadStream();
  stream.setPentacleAuthToken(OPERATOR_V2_ENVELOPE);
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message(operatorV2Welcome());
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: false })] });

  const frame = {
    type: 'working.state',
    stream_id: 'hostc:codex:one',
    timestamp: '2026-05-08T00:00:01Z',
    tokens_input: 10,
    tokens_output: 5,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'output',
    shell_count_started: 0,
    tasks: [],
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 1000,
  };
  socket.message(frame); // first application changes state

  const listener = jest.fn();
  const off = stream.subscribePentacleStream(listener);
  listener.mockClear();

  socket.message({ ...frame }); // identical frame — no real change
  expect(listener).not.toHaveBeenCalled();
  off();
  unsubscribe();
});

// optimistic_send_stuck_after_daemon_restart_2026_09: Retry on a row whose
// upload leg never completed re-runs the WHOLE unit — a fresh upload_blob
// request_id, then the send with a fresh send request_id, same optimistic_id.
test('retryOptimisticSend re-uploads a retained staged asset before re-sending', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({
    type: 'snapshot',
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'photo after a drop', [{
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
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'photo gone', [{
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
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  socket.message({ type: 'session.inventory', sessions: [sessionSummary('hostc:codex:one', { working: true })] });
  const reupload = jest.fn(async () => [{ key: 'f'.repeat(64), mime: 'image/jpeg' }]);
  stream.retainUploadForRetry('optimistic_never_inserted', reupload);

  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'lands then retries', [{
    key: 'local:0:file:///tmp/p.jpg',
    mime: 'image/jpeg',
  }]);
  stream.retainUploadForRetry(optimisticId, reupload);
  // The unit lands through a fetch reconcile: the row leaves optimisticSends,
  // and with it the retained re-upload (nothing survives the row).
  const fetchPromise = stream.requestStreamEvents('hostc:codex:one', 5);
  const fetchPayload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchPayload.request_id,
    stream_id: 'hostc:codex:one',
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
    sessions: [sessionSummary('hostc:codex:one', { working: false })],
    events: [],
  });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'retry into a closed socket', [{
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

test('__drainLiveApplyThroughForHarness force-applies queued live rows and reports the drained tip', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  // Leading edge applies immediately; consecutive same-stream bulk rows batch
  // behind the live-apply window. Do NOT advance timers, so seq 2..5 stay queued.
  for (let seq = 1; seq <= 5; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('row', seq) });
  }
  const drained = stream.__drainLiveApplyThroughForHarness();
  // The barrier's applied-through-seq contract: nothing left queued, and the
  // store has actually reached the highest fed daemon_seq (the straggler that a
  // bare "store contains >= N" check would have skipped is now applied).
  expect(drained.pending).toBe(0);
  expect(drained.maxSeq).toBe(5);
  const events = stream.getPentacleStreamState().events;
  expect(events.some((event) => Number(event.daemon_seq) === 5)).toBe(true);
  // Idempotent: a second drain with nothing queued is a no-op that still reports N.
  const again = stream.__drainLiveApplyThroughForHarness();
  expect(again).toEqual({ maxSeq: 5, pending: 0 });
  delete process.env.EXPO_PUBLIC_HARNESS;
});

test('__drainLiveApplyThroughForHarness preserves batching until the expected row is received', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  for (let seq = 1; seq <= 3; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('pre-threshold', seq) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(5)).toEqual({ maxSeq: 1, pending: 2 });
  for (let seq = 4; seq <= 5; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('threshold', seq) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(5)).toEqual({ maxSeq: 5, pending: 0 });
});



test('publishes timer-expiry live timing after its own listener without a later emit', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  jest.useFakeTimers();
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  armAllChatsCohort('timer-expiry-timing', 1, 2, 1);
  let timerListenerCalls = 0;
  const offTimerTiming = stream.subscribePentacleStream(() => {
    if (!stream.getPentacleStreamState().events.some((event) => event.text === 'timer-tail')) return;
    timerListenerCalls += 1;
    clock.advance(25);
  });
  const connection = subscribeAndCreateSocket(stream);
  connection.socket.open();
  const observed: Array<{ maxSeq: number; pending: number }> = [];
  const unsubscribe = stream.subscribePentacleStream(() => {
    observed.push(stream.__drainLiveApplyThroughForHarness(2));
  });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('leading', 1) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('timer-tail', 2) });
  jest.advanceTimersByTime(240);
  expect(timerListenerCalls).toBe(1);
  const timerTiming = seen.find((entry) =>
    entry.data?.set_state_ms === 25,
  );
  expect(timerTiming?.data?.set_state_ms).toBe(25);
  expect(timerTiming?.data?.kind).toBe('live_apply_timing');
  expect(observed).toContainEqual(expect.objectContaining({ maxSeq: 2, pending: 0 }));
  offTimerTiming();
  core.setTelemetrySink(null);
  unsubscribe();
  connection.unsubscribe();
  clock.restore();
  jest.useRealTimers();
});

test('clears timer-expiry pending timing across reset before a later unrelated emit', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  jest.useFakeTimers();
  const clock = mockMonotonicNow();
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  armAllChatsCohort('timer-expiry-timing', 1, 2, 1);
  let resetOnce = false;
  const offTimerReset = stream.subscribePentacleStream(() => {
    if (resetOnce || !stream.getPentacleStreamState().events.some((event) => event.text === 'timer-tail')) return;
    resetOnce = true;
    clock.advance(25);
    stream.__resetPentacleStreamForTests();
  });
  const connection = subscribeAndCreateSocket(stream);
  connection.socket.open();
  const observed: Array<{ maxSeq: number; pending: number }> = [];
  const unsubscribe = stream.subscribePentacleStream(() => {
    observed.push(stream.__drainLiveApplyThroughForHarness(2));
  });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('leading', 1) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('timer-tail', 2) });
  jest.advanceTimersByTime(240);
  expect(resetOnce).toBe(true);
  armAllChatsCohort('timer-expiry-after-reset', 3, 3, 1);
  let postResetNotifications = 0;
  const offPostReset = stream.subscribePentacleStream(() => {
    postResetNotifications += 1;
  });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(3, 1) });
  jest.advanceTimersByTime(240);
  expect(postResetNotifications).toBe(1);
  const resetTimerTiming = seen.find((entry) =>
    entry.data?.kind === 'live_apply_timing'
    && entry.data?.set_state_ms === 25,
  );
  expect(resetTimerTiming).toBeUndefined();
  offPostReset();
  offTimerReset();
  core.setTelemetrySink(null);
  unsubscribe();
  connection.unsubscribe();
  clock.restore();
  jest.useRealTimers();
});

test('__drainLiveApplyThroughForHarness is current when a timer-driven batch notifies listeners', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const connection = subscribeAndCreateSocket(stream);
  connection.socket.open();
  const observed: Array<{ maxSeq: number; pending: number }> = [];
  const unsubscribe = stream.subscribePentacleStream(() => {
    observed.push(stream.__drainLiveApplyThroughForHarness(2));
  });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('leading', 1) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('timer-tail', 2) });

  jest.advanceTimersByTime(240);
  expect(observed).toContainEqual({ maxSeq: 2, pending: 0 });
  unsubscribe();
  connection.unsubscribe();
});

test('__drainLiveApplyThroughForHarness reports deferred rows as pending rather than applied', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('applied', 1) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('deferred-2', 2) });
  unregisterFocus();
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('deferred-3', 3) });

  expect(stream.__drainLiveApplyThroughForHarness()).toEqual({ maxSeq: 1, pending: 2 });
  expect(stream.getPentacleStreamState().events.map((event) => Number(event.daemon_seq))).toEqual([1]);
});

test('__drainLiveApplyThroughForHarness permits filtered sequence gaps once received rows are applied', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('visible-1', 1) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('visible-3', 3) });

  expect(stream.__drainLiveApplyThroughForHarness()).toEqual({ maxSeq: 3, pending: 0 });
});

test('__drainLiveApplyThroughForHarness survives legitimate retention only after full apply', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  for (let seq = 1; seq <= 1201; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent(`retained-${seq}`, seq) });
  }

  expect(stream.__drainLiveApplyThroughForHarness()).toEqual({ maxSeq: 1201, pending: 0 });
  expect(stream.getPentacleStreamState().events.some((event) => Number(event.daemon_seq) === 1)).toBe(false);
});

test('__drainLiveApplyThroughForHarness blocks a received high tip until queued work applies and resets by generation', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  for (let seq = 1; seq <= 2700; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent(`applied-${seq}`, seq) });
  }
  expect(stream.__drainLiveApplyThroughForHarness()).toEqual({ maxSeq: 2700, pending: 0 });

  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('leading', 2701) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('high-received-only', 19136) });
  unregisterFocus();
  expect(stream.__drainLiveApplyThroughForHarness()).toEqual({ maxSeq: 2700, pending: 2 });

  stream.__resetPentacleStreamForTests();
  expect(stream.__drainLiveApplyThroughForHarness()).toEqual({ maxSeq: 0, pending: 0 });
});

test('__drainLiveApplyThroughForHarness blocks an applied high row while lower deferred work remains', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const unregisterFocus = stream.registerFocusedPentacleStream('hostc:codex:one');
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('applied-low', 1) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: assistantEvent('deferred-low', 2) });
  unregisterFocus();
  stream.__handlePentacleStreamMessageForTests({
    type: 'chat.event',
    event: {
      ...assistantEvent('applied-high', 19136),
      stream_id: 'hostc:codex:two',
      session_id: 'two',
      session_name: 'two',
      kind: 'USER',
    },
  });

  expect(stream.__drainLiveApplyThroughForHarness(19136)).toEqual({ maxSeq: 19136, pending: 1 });
  expect(stream.getPentacleStreamState().events.some((event) => Number(event.daemon_seq) === 19136)).toBe(true);
  expect(stream.getPentacleStreamState().events.some((event) => Number(event.daemon_seq) === 2)).toBe(false);
});

function armAllChatsCohort(
  runId: string,
  setupEventCount: number,
  eventCount: number,
  sessionCount = 64,
) {
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const params = new URLSearchParams({
    actions: 'all_chats_regression',
    scenario: 'all_chats_freeze_sim_regression',
    scenario_run_id: runId,
    stream_id: 'mock-host:freeze-00',
    all_chats_session_count: String(sessionCount),
    all_chats_setup_event_count: String(setupEventCount),
    all_chats_event_count: String(eventCount),
    all_chats_burst_size: '16',
  });
  harnessRuntime.applyURL(`pentacle://harness?${params.toString()}`);
}

function allChatsAssistantEvent(seq: number, sessionCount = 64) {
  const streamIndex = (seq - 1) % sessionCount;
  const sessionName = `freeze-${String(streamIndex).padStart(2, '0')}`;
  return {
    ...assistantEvent(`row-${seq}`, seq),
    stream_id: `mock-host:${sessionName}`,
    session_id: `mock-host:${sessionName}`,
    session_name: sessionName,
  };
}

test('__drainLiveApplyThroughForHarness does not accept the retained terminal identity before the exact setup cohort', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  armAllChatsCohort('retained-high-run', 19_120, 19_200);

  for (let seq = 1; seq <= 1_042; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq) });
  }
  stream.__handlePentacleStreamMessageForTests({
    type: 'chat.event',
    event: allChatsAssistantEvent(19_120),
  });

  expect(stream.__drainLiveApplyThroughForHarness(19_120)).toMatchObject({
    maxSeq: 19_120,
    pending: 0,
    cohortAppliedCount: 1_043,
    cohortComplete: false,
  });
});

test('__drainLiveApplyThroughForHarness binds exact identities to each armed run on the same generation', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  armAllChatsCohort('run-a', 4, 20, 2);

  for (const seq of [1, 2]) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq, 2) });
  }
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(4, 2) });
  stream.__handlePentacleStreamMessageForTests({
    type: 'chat.event',
    event: { ...allChatsAssistantEvent(3, 2), stream_id: 'foreign:stream', session_id: 'foreign:stream' },
  });
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 3,
    cohortComplete: false,
  });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(5, 2) });
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 4,
    cohortComplete: false,
  });

  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(3, 2) });
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(4, 2) });
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 5,
    cohortComplete: true,
  });

  armAllChatsCohort('run-b', 4, 20, 2);
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 0,
    cohortComplete: false,
  });
  for (let seq = 1; seq <= 4; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq, 2) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 0,
    cohortComplete: false,
  });

  stream.__resetPentacleStreamForTests();
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 0,
    cohortComplete: false,
  });
  armAllChatsCohort('run-b', 4, 20, 2);
  for (let seq = 1; seq <= 4; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq, 2) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 4,
    cohortComplete: true,
  });
});

test('__drainLiveApplyThroughForHarness blocks a current burst after a same-run reset without setup replay', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  armAllChatsCohort('same-run-reset', 4, 20, 2);
  for (let seq = 1; seq <= 4; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq, 2) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 4,
    cohortComplete: true,
  });

  stream.__resetPentacleStreamForTests();
  armAllChatsCohort('same-run-reset', 4, 20, 2);
  const current = allChatsAssistantEvent(5, 2);
  stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: current });
  expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
    cohortAppliedCount: 1,
    cohortComplete: false,
  });
  expect(stream.getPentacleStreamState().events).toEqual([
    expect.objectContaining({ stream_id: current.stream_id, daemon_seq: current.daemon_seq }),
  ]);
});

test('__drainLiveApplyThroughForHarness keeps exact applied proof after legitimate store pruning', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  armAllChatsCohort('pruned-run', 1_201, 1_201, 1);
  for (let seq = 1; seq <= 1_201; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq, 1) });
  }

  expect(stream.__drainLiveApplyThroughForHarness(1_201)).toMatchObject({
    cohortAppliedCount: 1_201,
    cohortComplete: true,
  });
  expect(stream.getPentacleStreamState().events.some((event) => Number(event.daemon_seq) === 1)).toBe(false);
});

  test('emits the exact direct-path applied identity in live_apply_timing', () => {
    process.env.EXPO_PUBLIC_HARNESS = '1';
    const stream = loadStream();
    const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
    const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
    core.setTelemetrySink((payload) => seen.push(payload));
    armAllChatsCohort('direct-identity-run', 4, 20, 2);
    for (let seq = 1; seq <= 4; seq += 1) {
      stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq, 2) });
    }
    expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
      cohortAppliedCount: 4,
      cohortComplete: true,
    });

    stream.__resetPentacleStreamForTests();
    armAllChatsCohort('direct-identity-run', 4, 20, 2);
    const current = allChatsAssistantEvent(5, 2);
    seen.length = 0;
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: current });
    expect(stream.__drainLiveApplyThroughForHarness(4)).toMatchObject({
      cohortAppliedCount: 1,
      cohortComplete: false,
    });
    const directTiming = seen.find((payload) => (
    String(payload.message) === 'harness:ui_trace' &&
      payload.data?.kind === 'live_apply_timing' &&
      payload.data.source === 'chat.event.immediate'
    ));
    expect(directTiming?.data?.applied_burst_ids).toEqual([[current.stream_id, current.daemon_seq]]);
    core.setTelemetrySink(null);
  });

  test('__drainLiveApplyThroughForHarness proves the exact 19.2k setup and 16-row continuation', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const stream = loadStream();
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  core.setTelemetrySink((payload) => seen.push(payload));
  armAllChatsCohort('stress-run', 19_120, 19_200);

  for (let seq = 1; seq <= 19_120; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(19_120)).toMatchObject({
    cohortAppliedCount: 19_120,
    cohortComplete: true,
  });
  for (let seq = 19_121; seq <= 19_136; seq += 1) {
    stream.__handlePentacleStreamMessageForTests({ type: 'chat.event', event: allChatsAssistantEvent(seq) });
  }
  expect(stream.__drainLiveApplyThroughForHarness(19_136)).toMatchObject({
    cohortAppliedCount: 19_136,
    cohortComplete: true,
  });

  const appliedBurstIds = seen.flatMap((payload) => (
    String(payload.message) === 'harness:ui_trace' && payload.data?.kind === 'live_apply_timing'
      ? (payload.data.applied_burst_ids as Array<[string, number]> | undefined) || []
      : []
  ));
  expect(appliedBurstIds).toEqual(
    Array.from({ length: 16 }, (_, index) => {
      const seq = 19_121 + index;
      return [`mock-host:freeze-${String((seq - 1) % 64).padStart(2, '0')}`, seq];
    }),
  );
  expect(appliedBurstIds.length).toBeLessThanOrEqual(80);
  core.setTelemetrySink(null);
});

// Native RED: photo upload loss → offline Retry → healthy-link Retry during
// the 30s reconnect backoff did not open a socket for another 29.5s.
test('one photo Retry during backoff waits for the existing connection and sends the retained photo', async () => {
  const stream = loadStream();
  const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
  socket.open();
  socket.message({ type: 'snapshot', sessions: [sessionSummary('hostc:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'retained photo', [{ key: 'local:photo', mime: 'image/png' }]);
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
  socket.message({ type: 'snapshot', sessions: [sessionSummary('hostc:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'retained photo');
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
  socket.message({ type: 'snapshot', sessions: [sessionSummary('hostc:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'offline photo', [{ key: 'local:photo', mime: 'image/png' }]);
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
  socket.message({ type: 'snapshot', sessions: [sessionSummary('hostc:codex:one', { working: false })], events: [] });
  const optimisticId = stream.appendOptimisticUserMessage('hostc:codex:one', 'already delivered', [{ key: 'local:photo', mime: 'image/png' }]);
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
