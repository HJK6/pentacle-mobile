// Actual backend-produced synthetic status frames exercise the production Mobile wire adapter.
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

function subscribeAndCreateSocket(stream: typeof import('../../src/services/pentacleStream')) {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  return { unsubscribe, socket: MockWebSocket.instances.at(-1) as MockWebSocket };
}

function sessionSummary(streamId = 'hosta:codex:one', overrides: Record<string, unknown> = {}) {
  return {
    stream_id: streamId,
    host: 'hosta',
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

test('wire-level trusted status correction hides one durable USER while stale replay cannot downgrade it', () => {
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
  expect(visibleRows().map((item) => item.text)).toContain(body);

  socket.message(correctionFrame);
  expect(stream.getPentacleStreamState().events.filter((event) => event.daemon_seq === eventId)).toHaveLength(1);
  expect(visibleRows().map((item) => item.text)).not.toContain(body);

  socket.message(beforeFrame);
  expect(stream.getPentacleStreamState().events.filter((event) => event.daemon_seq === eventId)).toHaveLength(1);
  expect(visibleRows().map((item) => item.text)).not.toContain(body);

  socket.message(explicitUserFrame);
  socket.message(copiedMarkerFrame);
  expect(visibleRows().filter((item) => item.text === body)).toHaveLength(2);
  unsubscribe();
});

afterEach(() => { jest.useRealTimers(); });
