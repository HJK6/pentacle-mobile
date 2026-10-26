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
jest.mock('../src/config/pentacle', () => ({
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
}

function loadStream() {
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function openSocket(stream: typeof import('../src/services/pentacleStream')) {
  stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances.at(-1) as MockWebSocket;
  socket.open();
  return socket;
}

function lastRequestFrame(socket: MockWebSocket): Record<string, unknown> {
  return JSON.parse(
    [...socket.sent].reverse().find((frame) => JSON.parse(frame).type === 'request_stream_events') || '{}',
  );
}

function event(seq: number) {
  return {
    stream_id: 'mock-host:mock-session',
    daemon_seq: seq,
    kind: seq % 2 ? 'USER' : 'ASSIST',
    text: `history row ${seq}`,
    timestamp: `2026-07-09T05:14:${String(seq).padStart(2, '0')}.000Z`,
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('pentacleStream resumable history backfill', () => {
  it('keeps history intact when readiness and pong arrive between chunks', async () => {
    const stream = loadStream();
    const socket = openSocket(stream);
    const history = stream.requestStreamEvents('mock-host:mock-session', 300, { purpose: 'mount-fetch' });
    let settled = 0;
    const resolved = history.then((rows) => {
      settled += 1;
      return rows;
    });
    const request = lastRequestFrame(socket);
    const chunk = (seq: number) => socket.message({
      type: 'request_stream_events.chunk', request_id: request.request_id,
      stream_id: 'mock-host:mock-session', events: [event(seq)], complete: false,
    });
    chunk(1);
    socket.message({ type: 'session.inventory', sessions: [{
      stream_id: 'mock-host:mock-session', host: 'mock-host', session_name: 'mock-session',
      bootstrap_state: 'ready',
    }] });
    socket.message({ type: 'pong', request_id: 'independent-control' });
    expect(stream.getPentacleStreamState().sessions[0].bootstrap_state).toBe('ready');
    await flushMicrotasks();
    expect(settled).toBe(0);
    socket.message({
      type: 'request_stream_events.ok', request_id: 'unrelated-request',
      stream_id: 'mock-host:mock-session', events: [event(99)], complete: true,
    });
    await flushMicrotasks();
    expect(settled).toBe(0);
    expect(stream.getPentacleStreamState().events.map((item) => item.daemon_seq)).not.toContain(99);
    chunk(2);
    socket.message({
      type: 'request_stream_events.ok', request_id: request.request_id,
      stream_id: 'mock-host:mock-session', events: [], complete: true,
    });
    const rows = await resolved;
    expect(rows.map((item) => item.daemon_seq)).toEqual([1, 2]);
    expect(rows.every((item) => item.stream_id === 'mock-host:mock-session')).toBe(true);
    expect(settled).toBe(1);
    socket.message({
      type: 'request_stream_events.ok', request_id: request.request_id,
      stream_id: 'mock-host:mock-session', events: [], complete: true,
    });
    await flushMicrotasks();
    expect(settled).toBe(1);
    expect(stream.getPentacleStreamState().events.map((item) => item.daemon_seq)).toEqual([1, 2]);
    expect(stream.getPentacleStreamState().sessions[0].bootstrap_state).toBe('ready');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('merges chunk frames immediately and resumes older history by cursor', () => {
    const stream = loadStream();
    const socket = openSocket(stream);

    // Mount-fetch: a real dispatch registers the pending request (the chunk
    // handler only merges frames for a registered request_id) and sends the
    // canonical request frame.
    const mountFetch = stream.requestStreamEvents('mock-host:mock-session', 300, { purpose: 'mount-fetch' });
    mountFetch.catch(() => undefined); // completed by a later request; never resolves here
    const mountFrame = lastRequestFrame(socket);
    expect(mountFrame).toMatchObject({
      type: 'request_stream_events',
      stream_id: 'mock-host:mock-session',
      limit: 300,
      chunk_limit: 8,
      order: 'newest_first',
    });
    expect(mountFrame).not.toHaveProperty('before_daemon_seq');

    // Mount-fetch chunks commit progressively (immediately renderable).
    socket.message({
      type: 'request_stream_events.chunk',
      request_id: mountFrame.request_id,
      stream_id: 'mock-host:mock-session',
      events: [event(9), event(10), event(11), event(12)],
      complete: false,
    });
    expect(stream.getPentacleStreamState().events.map((item) => item.daemon_seq)).toEqual([9, 10, 11, 12]);

    // The resume cursor tracks the lowest committed seq, so the next older page
    // requests history before daemon_seq 9.
    expect(stream.__buildStreamEventsRequestPayloadForTests('mock-host:mock-session', 300, 'older-page')).toMatchObject({
      before_daemon_seq: 9,
    });

    // Older-page: dispatch the resume; its frame carries the cursor.
    const olderPage = stream.requestStreamEvents('mock-host:mock-session', 300, { purpose: 'older-page' });
    olderPage.catch(() => undefined);
    const olderFrame = lastRequestFrame(socket);
    expect(olderFrame).toMatchObject({ before_daemon_seq: 9 });

    socket.message({
      type: 'request_stream_events.ok',
      request_id: olderFrame.request_id,
      stream_id: 'mock-host:mock-session',
      events: [event(1), event(2), event(3), event(4)],
      complete: true,
    });

    expect([...stream.getPentacleStreamState().events.map((item) => item.daemon_seq)].sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 9, 10, 11, 12,
    ]);
    expect(stream.__buildStreamEventsRequestPayloadForTests('mock-host:mock-session', 300, 'focused-refetch')).not.toHaveProperty(
      'before_daemon_seq',
    );
  });
});

describe('pentacleStream terminal history replies for an absent target', () => {
  const ABSENT = 'mock-host:absent-assistant';
  const snapshotWithout = {
    type: 'snapshot', events_mode: 'summary',
    sessions: [{ stream_id: 'mock-host:present-assistant', host: 'mock-host', session_name: 'present-assistant', bootstrap_state: 'started' }],
    hosts: { 'mock-host': { host: 'mock-host', online: true } },
  };

  function historyFrames(socket: MockWebSocket) {
    return socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === 'request_stream_events');
  }

  async function idleWithPongs(socket: MockWebSocket, seconds: number) {
    for (let i = 0; i < seconds; i += 1) {
      socket.message({ type: 'pong' });
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
    }
  }

  it('settles unmatched terminal replies so no orphaned timeout closes the healthy socket', async () => {
    const stream = loadStream();
    stream.__handlePentacleAppStateChangeForTests('active');
    const unregister = stream.registerFocusedPentacleStream(ABSENT);
    const socket = openSocket(stream);
    const second = stream.requestStreamEvents(ABSENT, 25, { purpose: 'mount-fetch' });
    const requests = historyFrames(socket).filter((frame) => frame.stream_id === ABSENT);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    socket.message(snapshotWithout);
    for (const request of requests) {
      socket.message({ type: 'request_stream_events.ok', request_id: request.request_id, stream_id: ABSENT, events: [], complete: true });
    }
    const outcome: { rows?: unknown[]; error?: string } = {};
    second.then((rows) => { outcome.rows = rows; }, (error: Error) => { outcome.error = error.message; });
    await idleWithPongs(socket, 70);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(outcome).toEqual({ rows: [] });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(stream.getPentacleStreamState().events.filter((item) => item.stream_id === ABSENT)).toEqual([]);
    unregister();
  });

  it('settles an unmatched terminal error without applying it or closing the socket', async () => {
    const stream = loadStream();
    const socket = openSocket(stream);
    const history = stream.requestStreamEvents(ABSENT, 25, { purpose: 'mount-fetch' });
    const request = historyFrames(socket).at(-1);
    socket.message(snapshotWithout);
    socket.message({ type: 'request_stream_events.error', request_id: request.request_id, stream_id: 'mock-host:other', error: 'not found' });
    const outcome: { error?: string } = {};
    history.catch((error: Error) => { outcome.error = error.message; });
    await idleWithPongs(socket, 70);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(outcome.error).toBe('not found');
  });

  it('control: a present target still applies its history and keeps the socket open', async () => {
    const stream = loadStream();
    const socket = openSocket(stream);
    const history = stream.requestStreamEvents('mock-host:mock-session', 300, { purpose: 'mount-fetch' });
    const request = historyFrames(socket).at(-1);
    socket.message({ type: 'request_stream_events.ok', request_id: request.request_id, stream_id: 'mock-host:mock-session', events: [event(1), event(2)], complete: true });
    expect((await history).map((item) => item.daemon_seq)).toEqual([1, 2]);
    expect(stream.getPentacleStreamState().events.map((item) => item.daemon_seq)).toEqual([1, 2]);
    await idleWithPongs(socket, 70);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
  });

  it('control: an unanswered history request still hits its genuine command deadline', async () => {
    const stream = loadStream();
    const socket = openSocket(stream);
    const history = stream.requestStreamEvents('mock-host:mock-session', 300, { purpose: 'mount-fetch' });
    history.catch(() => undefined);
    await idleWithPongs(socket, 70);
    await expect(history).rejects.toThrow('Pentacle command timed out');
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });
});
