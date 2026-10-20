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

function rule(overrides: Record<string, unknown> = {}) {
  return {
    recurring_id: '11111111-1111-4111-8111-111111111111', name: 'Nightly retro', state: 'active', tz: 'America/Chicago',
    recurrence: { every: 'daily', at_time: '02:00', days: [], tz: 'America/Chicago' },
    recurrence_text: 'daily at 02:00 America/Chicago', next_fire_at_utc: '2026-10-21T07:00:00.000000Z',
    last_result: 'missed', last_result_reason: 'late', missed_count: 1, ...overrides,
  };
}
const oneShot = { schedule_id: 'sched-1', state: 'pending', prompt_preview: 'Check the dishwasher', fires_at_utc: '2026-10-20T22:00:00Z' };
const NOW = Date.parse('2026-10-20T20:00:00Z');

function load() {
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return {
    stream: require('../../src/services/pentacleStream') as typeof import('../../src/services/pentacleStream'),
    store: require('../../src/services/recurringSchedules') as typeof import('../../src/services/recurringSchedules'),
  };
}

function connect(stream: ReturnType<typeof load>['stream']) {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances.at(-1) as MockWebSocket;
  socket.open();
  return { unsubscribe, socket };
}

beforeEach(() => { jest.useFakeTimers(); delete process.env.EXPO_PUBLIC_HARNESS; });
afterEach(() => { jest.useRealTimers(); });

test('hello snapshot replaces recurring rules and keeps only pending one-shots', () => {
  const { stream, store } = load();
  const { unsubscribe, socket } = connect(stream);
  socket.message({
    type: 'snapshot', sessions: [], events: [],
    recurring: [rule({ recurring_id: 'b', next_fire_at_utc: '2026-10-22T07:00:00Z' }), rule({ recurring_id: 'a' }), { recurring_id: 'bad', state: 'nope' }],
    schedules: [oneShot, { ...oneShot, schedule_id: 'sched-done', state: 'fired' }],
  });
  const snapshot = store.getScheduledSnapshot();
  expect(snapshot.recurring.map((row) => row.recurring_id)).toEqual(['a', 'b']);
  expect(snapshot.oneShots.map((row) => row.schedule_id)).toEqual(['sched-1']);
  socket.message({ type: 'snapshot', sessions: [], events: [] });
  expect(store.getScheduledSnapshot().recurring).toHaveLength(2); // a frame without the keys leaves the lists alone
  unsubscribe();
});

test('recurring lifecycle frames upsert and delete; one-shot lifecycle frames track pending rows', () => {
  const { stream, store } = load();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [], recurring: [rule()], schedules: [] });
  socket.message({ type: 'schedule.lifecycle', event: 'recurring_paused', recurring: rule({ state: 'paused' }) });
  expect(store.getScheduledSnapshot().recurring[0].state).toBe('paused');
  socket.message({ type: 'schedule.lifecycle', event: 'recurring_missed', recurring: rule({ missed_count: 2, initial_prompt_b64: 'c2VjcmV0' }) });
  expect(store.getScheduledSnapshot().recurring[0].missed_count).toBe(2);
  expect('initial_prompt_b64' in store.getScheduledSnapshot().recurring[0]).toBe(false);
  socket.message({ type: 'schedule.lifecycle', event: 'created', schedule: oneShot });
  expect(store.getScheduledSnapshot().oneShots.map((row) => row.schedule_id)).toEqual(['sched-1']);
  socket.message({ type: 'schedule.lifecycle', event: 'fired', schedule: { ...oneShot, state: 'fired' } });
  expect(store.getScheduledSnapshot().oneShots).toEqual([]);
  socket.message({ type: 'schedule.lifecycle', event: 'recurring_deleted', recurring: rule() });
  expect(store.getScheduledSnapshot().recurring).toEqual([]);
  unsubscribe();
});

test('pause, resume and update send the recurring verbs and settle on the daemon reply', async () => {
  const { stream } = load();
  const { unsubscribe, socket } = connect(stream);
  socket.message({ type: 'snapshot', sessions: [], events: [], recurring: [rule()] });
  const sentFrames = () => socket.sent.map((frame) => JSON.parse(frame) as Record<string, any>);
  const pause = stream.pauseRecurringSchedule('r1');
  let sent = sentFrames().at(-1)!;
  expect(sent).toMatchObject({ type: 'schedule.recurring.pause', recurring_id: 'r1' });
  socket.message({ type: 'schedule.recurring.pause.ok', request_id: sent.request_id, recurring: rule({ state: 'paused' }) });
  expect((await pause).recurring?.state).toBe('paused');

  const edit = { name: 'Early', every: 'weekly', at_time: '03:30', days: ['mon'], tz: 'UTC' };
  const update = stream.updateRecurringSchedule('r1', edit);
  sent = sentFrames().at(-1)!;
  expect(sent).toMatchObject({ type: 'schedule.recurring.update', recurring_id: 'r1', ...edit });
  socket.message({ type: 'schedule.recurring.update.error', request_id: sent.request_id, error_code: 'invalid_timezone', error: 'unknown time zone' });
  await expect(update).rejects.toMatchObject({ message: 'unknown time zone', errorCode: 'invalid_timezone' });

  const resume = stream.resumeRecurringSchedule('r1');
  sent = sentFrames().at(-1)!;
  expect(sent).toMatchObject({ type: 'schedule.recurring.resume', recurring_id: 'r1' });
  socket.message({ type: 'schedule.recurring.resume.ok', request_id: sent.request_id, recurring: rule() });
  await resume;
  unsubscribe();
});

test('row view models show the recurrence in the rule zone with relative time', () => {
  const { store } = load();
  const [active, paused] = store.selectRecurringRows([
    store.normalizeRecurring(rule())!, store.normalizeRecurring(rule({ state: 'paused', last_result: 'fired', last_result_reason: null }))!,
  ], NOW);
  expect(active).toMatchObject({ recurrence: 'daily at 02:00 America/Chicago', last: 'missed: late', actionLabel: 'Pause' });
  expect(active.next).toBe('Wed, Oct 21, 02:00 CDT (in 11h 0m)');
  expect(paused).toMatchObject({ next: 'paused', last: 'fired', actionLabel: 'Resume' });
  expect(store.formatRelative('2026-10-20T19:00:00Z', NOW)).toBe('1h 0m ago');
  expect(store.formatRelative('2026-10-23T20:00:00Z', NOW)).toBe('in 3d');
});
