import { readFileSync } from 'fs';
import { join } from 'path';

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8',
));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined), clear: jest.fn(async () => undefined),
  },
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('../../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://default.example/ws' }));

class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

function loadStream() {
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return {
    stream: require('../../src/services/pentacleStream') as typeof import('../../src/services/pentacleStream'),
    core: require('pentacle-chat-core') as typeof import('pentacle-chat-core'),
  };
}

function connect(stream: ReturnType<typeof loadStream>['stream']) {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances.at(-1) as MockWebSocket;
  socket.open();
  return { unsubscribe, socket };
}

const frames = (socket: MockWebSocket, type: string) =>
  socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>).filter((frame) => frame.type === type);

beforeEach(() => { jest.useFakeTimers(); delete process.env.EXPO_PUBLIC_HARNESS; });
afterEach(() => { jest.useRealTimers(); });

test('hello advertises work_lanes_v1', () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  expect((frames(socket, 'hello')[0].capabilities as Record<string, unknown>).work_lanes_v1).toBe(true);
  unsubscribe();
});

test('hello snapshot work_lanes and live work_lanes.inventory replace the lane list', () => {
  const { stream, core } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [], work_lanes: fixture.hello_field.work_lanes });
  let state = stream.getPentacleStreamState();
  expect(core.selectOpenLaneCount(state)).toBe(fixture.expected.header_count);
  expect(core.selectWorkLanes(state).map((lane) => lane.lane_id)).toEqual(fixture.expected.order);

  const trimmed = {
    ...fixture.inventory_frame,
    lanes: fixture.inventory_frame.lanes.slice(0, 1),
    counts: { open: 1, active: 0, paused: 0, blocked: 1 },
  };
  socket.message(trimmed);
  state = stream.getPentacleStreamState();
  expect(core.selectOpenLaneCount(state)).toBe(1);
  expect(core.selectWorkLanes(state).map((lane) => lane.lane_id)).toEqual(['wl-blocked-0001']);

  socket.message({ type: 'work_lanes.inventory', lanes: 'garbage' });
  expect(core.selectOpenLaneCount(stream.getPentacleStreamState())).toBe(1);
  unsubscribe();
});

test('session inventory changes never change the lane count', () => {
  const { stream, core } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [], work_lanes: fixture.hello_field.work_lanes });
  const sessions = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({
    stream_id: `hostc:codex:${name}`, host: 'hostc', provider: 'codex', session_name: name,
    last_event_at: '2026-05-08T00:00:00Z', last_text: '', last_kind: 'ASSIST', draft: '', pending: false,
    working: true, online: true,
  }));
  socket.message({ type: 'session.inventory', sessions });
  const state = stream.getPentacleStreamState();
  expect(state.sessions).toHaveLength(6);
  expect(core.selectOpenLaneCount(state)).toBe(fixture.expected.header_count);
  unsubscribe();
});

test('lane_update chat.event is deduplicated by message_id across live and history', () => {
  const { stream, core } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const event = fixture.lane_update_events[1].event;
  socket.message({ type: 'chat.event', event });
  socket.message({ type: 'chat.event', event });
  const matches = () => core.peekEventsForStream(stream.getPentacleStreamState(), 'bart:assistant')
    .filter((item) => item.message_id === event.message_id);
  expect(matches()).toHaveLength(1);
  expect(core.parseLaneUpdateEvent(matches()[0])?.kind).toBe('lane_blocked');
  unsubscribe();
});

test('requestLaneHistory sends the lane generation and resolves without touching the store', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const closed = { stream_id: 'amaterasu:v2-lead0003', daemon_seq: 7, kind: 'ASSIST', text: 'closed history',
    host: 'amaterasu', provider: 'claude', session_id: 's', session_name: 'v2-lead0003', timestamp: '2026-10-07T12:00:00Z' };
  const promise = stream.requestLaneHistory('amaterasu:v2-lead0003', 'gen-lead-0003', { beforeDaemonSeq: 50 });
  const request = frames(socket, 'request_stream_events').at(-1)!;
  expect(request).toMatchObject({
    stream_id: 'amaterasu:v2-lead0003', generation: 'gen-lead-0003', before_daemon_seq: 50, order: 'newest_first',
  });
  socket.message({ type: 'request_stream_events.chunk', request_id: request.request_id,
    stream_id: 'amaterasu:v2-lead0003', events: [closed] });
  socket.message({ type: 'request_stream_events.ok', request_id: request.request_id,
    stream_id: 'amaterasu:v2-lead0003', events: [] });
  await expect(promise).resolves.toEqual([closed]);
  const state = stream.getPentacleStreamState();
  expect(state.events.some((event) => event.stream_id === 'amaterasu:v2-lead0003')).toBe(false);
  expect(state.eventBucketsByStream?.['amaterasu:v2-lead0003']).toBeUndefined();
  unsubscribe();
});

test('requestLaneHistory rejects on daemon error and without a generation', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  await expect(stream.requestLaneHistory('amaterasu:v2-lead0003', '')).rejects.toThrow('generation');
  const promise = stream.requestLaneHistory('amaterasu:v2-lead0003', 'gen-lead-0003');
  const request = frames(socket, 'request_stream_events').at(-1)!;
  socket.message({ type: 'request_stream_events.error', request_id: request.request_id, error: 'unknown_session' });
  await expect(promise).rejects.toThrow('unknown_session');
  unsubscribe();
});
