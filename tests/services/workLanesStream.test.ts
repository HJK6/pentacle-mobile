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
  const closed = { stream_id: 'fixture-host:v2-lead0003', daemon_seq: 7, kind: 'ASSIST', text: 'closed history',
    host: 'fixture-host', provider: 'claude', session_id: 's', session_name: 'v2-lead0003', timestamp: '2026-10-07T12:00:00Z' };
  const promise = stream.requestLaneHistory('fixture-host:v2-lead0003', 'gen-lead-0003', { beforeDaemonSeq: 50 });
  const request = frames(socket, 'request_stream_events').at(-1)!;
  expect(request).toMatchObject({
    stream_id: 'fixture-host:v2-lead0003', generation: 'gen-lead-0003', before_daemon_seq: 50, order: 'newest_first',
  });
  socket.message({ type: 'request_stream_events.chunk', request_id: request.request_id,
    stream_id: 'fixture-host:v2-lead0003', events: [closed] });
  socket.message({ type: 'request_stream_events.ok', request_id: request.request_id,
    stream_id: 'fixture-host:v2-lead0003', events: [] });
  await expect(promise).resolves.toEqual([closed]);
  const state = stream.getPentacleStreamState();
  expect(state.events.some((event) => event.stream_id === 'fixture-host:v2-lead0003')).toBe(false);
  expect(state.eventBucketsByStream?.['fixture-host:v2-lead0003']).toBeUndefined();
  unsubscribe();
});

test('requestLaneHistory rejects on daemon error and without a generation', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  await expect(stream.requestLaneHistory('fixture-host:v2-lead0003', '')).rejects.toThrow('generation');
  const promise = stream.requestLaneHistory('fixture-host:v2-lead0003', 'gen-lead-0003');
  const request = frames(socket, 'request_stream_events').at(-1)!;
  socket.message({ type: 'request_stream_events.error', request_id: request.request_id, error: 'unknown_session' });
  await expect(promise).rejects.toThrow('unknown_session');
  unsubscribe();
});

function showReply(lane = fixture.progress_v2[0].frame.lanes[0]) {
  return {
    type: 'work_lanes.show.ok', lane: { lane_id: lane.lane_id }, projection: lane,
    members: lane.members ?? [], events: [], updates: [],
    work_index: fixture.progress_v2[0].work_index,
  };
}

test('requestWorkLaneShow sends the existing verb and settles only its typed matching reply', async () => {
  const { stream, core } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [], work_lanes: fixture.hello_field.work_lanes });
  const before = stream.getPentacleStreamState();
  const reply = showReply();
  const promise = stream.requestWorkLaneShow(reply.lane.lane_id);
  const request = frames(socket, 'work_lanes.show').at(-1)!;
  expect(request).toEqual({ type: 'work_lanes.show', lane_id: reply.lane.lane_id, request_id: expect.stringMatching(/^work_lanes_show/) });
  let settled = false;
  void promise.then(() => { settled = true; });
  socket.message({ ...reply, request_id: 'unrelated-request' });
  await Promise.resolve();
  expect(settled).toBe(false);
  socket.message({ ...reply, request_id: request.request_id });
  await expect(promise).resolves.toEqual(core.parseWorkLaneShow(reply));
  const after = stream.getPentacleStreamState();
  expect(after.workLanes).toBe(before.workLanes);
  expect(after.sessions).toBe(before.sessions);
  expect(after.events).toBe(before.events);
  socket.message({ type: 'work_lanes.show.error', request_id: request.request_id, error_code: 'late', error: 'Late error' });
  await expect(promise).resolves.toMatchObject({ lane_id: reply.lane.lane_id });
  unsubscribe();
});

test('requestWorkLaneShow returns all members in membership order, beyond the inline preview', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const reply = showReply();
  reply.members = Array.from({ length: 32 }, (_, index) => ({ ...reply.members[0], spec_id: `spec-${index}` }));
  reply.projection = { ...reply.projection, members: reply.members.slice(0, 8), members_total: 32 };
  const promise = stream.requestWorkLaneShow(reply.lane.lane_id);
  const request = frames(socket, 'work_lanes.show').at(-1)!;
  socket.message({ ...reply, request_id: request.request_id });
  const result = await promise;
  expect(result.members.map((member) => member.spec_id)).toEqual(reply.members.map((member: { spec_id: string }) => member.spec_id));
  expect(result.projection?.members).toHaveLength(8);
  unsubscribe();
});

test('requestWorkLaneShow preserves daemon error codes and a retry can succeed', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const reply = showReply();
  const rejected = stream.requestWorkLaneShow(reply.lane.lane_id);
  const firstRequest = frames(socket, 'work_lanes.show').at(-1)!;
  const assertion = expect(rejected).rejects.toMatchObject({ message: 'Lane cannot be read.', errorCode: 'lane_unavailable' });
  socket.message({ type: 'work_lanes.show.error', request_id: firstRequest.request_id, error_code: 'lane_unavailable', error: 'Lane cannot be read.' });
  await assertion;
  const retried = stream.requestWorkLaneShow(reply.lane.lane_id);
  const secondRequest = frames(socket, 'work_lanes.show').at(-1)!;
  expect(secondRequest.request_id).not.toBe(firstRequest.request_id);
  socket.message({ ...reply, request_id: firstRequest.request_id });
  socket.message({ ...reply, request_id: secondRequest.request_id });
  await expect(retried).resolves.toMatchObject({ lane_id: reply.lane.lane_id });
  unsubscribe();
});

test('requestWorkLaneShow rejects at the standard 30-second deadline with a typed timeout', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const promise = stream.requestWorkLaneShow(showReply().lane.lane_id);
  const assertion = expect(promise).rejects.toMatchObject({ message: 'Pentacle command timed out', errorCode: 'request_timeout' });
  let settled = false;
  void promise.catch(() => { settled = true; });
  for (let index = 0; index < 2; index += 1) {
    jest.advanceTimersByTime(10_000);
    socket.message({ type: 'pong' });
  }
  jest.advanceTimersByTime(9_999);
  socket.message({ type: 'pong' });
  await Promise.resolve();
  expect(settled).toBe(false);
  jest.advanceTimersByTime(1);
  await assertion;
  unsubscribe();
});

test('requestWorkLaneShow rejects malformed and wrong-lane success frames', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  for (const reply of [{ type: 'work_lanes.show.ok' }, showReply({ ...showReply().projection, lane_id: 'wrong-lane' })]) {
    const promise = stream.requestWorkLaneShow('requested-lane');
    const request = frames(socket, 'work_lanes.show').at(-1)!;
    const assertion = expect(promise).rejects.toMatchObject({ errorCode: 'invalid_response' });
    socket.message({ ...reply, request_id: request.request_id });
    await assertion;
  }
  unsubscribe();
});

test('requestWorkLaneShow requires an id and a live connection and fails on disconnect without replay', async () => {
  const { stream } = loadStream();
  await expect(stream.requestWorkLaneShow('')).rejects.toMatchObject({ errorCode: 'invalid_lane_id' });
  await expect(stream.requestWorkLaneShow('lane-1')).rejects.toThrow('not connected');
  expect(MockWebSocket.instances).toHaveLength(0);
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const promise = stream.requestWorkLaneShow('lane-1');
  const assertion = expect(promise).rejects.toThrow('disconnected');
  unsubscribe();
  await assertion;
  const second = connect(stream);
  expect(frames(second.socket, 'work_lanes.show')).toHaveLength(0);
  second.unsubscribe();
});

test('show replies cannot settle a different RPC, even with a matching request id', async () => {
  const { stream } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const history = stream.requestLaneHistory('fixture-host:lead', 'generation-1');
  const request = frames(socket, 'request_stream_events').at(-1)!;
  let settled = false;
  void history.then(() => { settled = true; });
  socket.message({ ...showReply(), request_id: request.request_id });
  socket.message({ type: 'work_lanes.show.error', request_id: request.request_id, error: 'Unrelated error' });
  await Promise.resolve();
  expect(settled).toBe(false);
  socket.message({ type: 'request_stream_events.ok', request_id: request.request_id, stream_id: 'fixture-host:lead', events: [] });
  await expect(history).resolves.toEqual([]);
  unsubscribe();
});

test('v1 snapshot upgrades to increment-one inventory on reconnect without changing the header contract', () => {
  const { stream, core } = loadStream();
  const first = connect(stream);
  first.socket.message({ type: 'snapshot', sessions: [], events: [], work_lanes: fixture.hello_field.work_lanes });
  expect(core.selectOpenLaneCount(stream.getPentacleStreamState())).toBe(fixture.expected.header_count);
  expect(core.selectWorkLanes(stream.getPentacleStreamState())[0].members).toBeUndefined();
  first.unsubscribe();
  const second = connect(stream);
  const frame = fixture.progress_v2[0].frame;
  second.socket.message({ type: 'snapshot', sessions: [], events: [], work_lanes: frame });
  expect(core.selectOpenLaneCount(stream.getPentacleStreamState())).toBe(frame.counts.open);
  expect(core.selectWorkLanes(stream.getPentacleStreamState())[0].members).toHaveLength(2);
  second.unsubscribe();
});

test('show telemetry is harness-only and reports ids, counts and settlement status without content', async () => {
  const { stream, core } = loadStream();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  const telemetry = jest.fn();
  core.setTelemetrySink(telemetry);
  const runtime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const armed = jest.spyOn(runtime, 'isArmed').mockReturnValue(true);
  const reply = showReply();
  const traces = () => telemetry.mock.calls.map(([payload]) => payload.data).filter((data) => data.kind === 'work_lanes_show');
  const resolveShow = async () => {
    const promise = stream.requestWorkLaneShow(reply.lane.lane_id);
    const request = frames(socket, 'work_lanes.show').at(-1)!;
    socket.message({ ...reply, request_id: request.request_id });
    await promise;
  };
  await resolveShow();
  expect(traces()).toEqual([]);
  process.env.EXPO_PUBLIC_HARNESS = '1';
  armed.mockReturnValue(false);
  await resolveShow();
  expect(traces()).toEqual([]);
  armed.mockReturnValue(true);
  await resolveShow();
  expect(traces()).toEqual([{
    kind: 'work_lanes_show', timestamp_emitter_wall: expect.any(Number), lane_id: reply.lane.lane_id,
    status: 'ok', members: 2, events: 0, updates: 0,
  }]);
  const failed = stream.requestWorkLaneShow(reply.lane.lane_id);
  const request = frames(socket, 'work_lanes.show').at(-1)!;
  const failedAssertion = expect(failed).rejects.toMatchObject({ errorCode: 'lane_unavailable' });
  socket.message({ type: 'work_lanes.show.error', request_id: request.request_id, error_code: 'lane_unavailable', error: 'Do not copy this error text into telemetry.' });
  await failedAssertion;
  const timedOut = stream.requestWorkLaneShow(reply.lane.lane_id);
  const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ errorCode: 'request_timeout' });
  for (let index = 0; index < 3; index += 1) {
    jest.advanceTimersByTime(10_000);
    socket.message({ type: 'pong' });
  }
  await timeoutAssertion;
  expect(traces().map((entry) => entry.status)).toEqual(['ok', 'error', 'timeout']);
  expect(traces()[1]).toMatchObject({ error_code: 'lane_unavailable', members: 0, events: 0, updates: 0 });
  expect(traces()[2]).toMatchObject({ error_code: 'request_timeout', members: 0, events: 0, updates: 0 });
  expect(JSON.stringify(traces())).not.toContain(reply.projection.title);
  expect(JSON.stringify(traces())).not.toContain('Do not copy');
  armed.mockRestore();
  core.setTelemetrySink(null);
  unsubscribe();
  delete process.env.EXPO_PUBLIC_HARNESS;
});
