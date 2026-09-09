// actions.sendTurn behavior.
// Spec: docs/public-test-spec.md
// sendTurn replaces the old append-and-flag sequence on the screen. The
// reducer owns the phase.

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import type { PentacleSessionSummary } from 'pentacle-chat-core';
import type { TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';

type Telemetry = typeof import('pentacle-chat-core');
let activeTelemetry: Telemetry | null = null;

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
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
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
  // After resetModules, pentacleStream binds to a fresh telemetry module
  // instance. Capture THAT instance so our sink replacement reaches the
  // same logTelemetry calls pentacleStream makes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  activeTelemetry = require('pentacle-chat-core') as Telemetry;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-05-16T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

const STREAM_ID = 'hostc:codex:chat-1';

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-16T12:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
  activeTelemetry?.setTelemetrySink(null);
  activeTelemetry = null;
});

function captureTelemetry(): TelemetryPayload[] {
  const events: TelemetryPayload[] = [];
  if (!activeTelemetry) throw new Error('captureTelemetry called before loadStream');
  activeTelemetry.setTelemetrySink((payload) => events.push(payload));
  return events;
}

function bootStream() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID)] });
  return { stream, socket, unsubscribe };
}

test('sendTurn while idle: appends optimistic USER, sets phase=pending with optimisticId+sentAt', () => {
  const { stream, unsubscribe } = bootStream();
  const captured = captureTelemetry();

  const optimisticId = stream.sendTurn(STREAM_ID, 'hello');

  expect(optimisticId).toMatch(/^optimistic_hostc_codex_chat-1_launch-[^_]+_1$/);
  const turn = stream.getPentacleStreamState().workingByStream?.[STREAM_ID];
  expect(turn?.phase).toBe('pending');
  expect(turn?.optimisticId).toBe(optimisticId);
  expect(typeof turn?.sentAt).toBe('number');

  const optimisticEvent = stream.getPentacleStreamState().events
    .find((event) => event.optimistic_id === optimisticId);
  expect(optimisticEvent?.kind).toBe('USER');
  expect(optimisticEvent?.text).toBe('hello');
  expect(optimisticEvent?.client_origin).toBe(true);
  expect(optimisticEvent?.pending).toBe(true);

  expect(captured.some((payload) => payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT)).toBe(true);
  expect(captured.some((payload) => payload.message === TELEMETRY_EVENTS.CHAT_SEND_WHILE_NOT_IDLE)).toBe(false);

  unsubscribe();
});

test('sendTurn while phase=pending is rejected, fires warn:send_while_not_idle, and does not duplicate the optimistic event', () => {
  const { stream, unsubscribe } = bootStream();
  const firstId = stream.sendTurn(STREAM_ID, 'hello');
  expect(firstId).toBeTruthy();
  expect(firstId).toMatch(/^optimistic_hostc_codex_chat-1_launch-[^_]+_1$/);

  const captured = captureTelemetry();
  const secondId = stream.sendTurn(STREAM_ID, 'again');

  expect(secondId).toBe('');
  const events = stream.getPentacleStreamState().events;
  expect(events.filter((event) => event.client_origin === true).length).toBe(1);

  const warn = captured.find((payload) => payload.message === TELEMETRY_EVENTS.CHAT_SEND_WHILE_NOT_IDLE);
  expect(warn).toBeDefined();
  expect(warn?.data.stream_id).toBe(STREAM_ID);
  expect(warn?.data.phase).toBe('pending');

  unsubscribe();
});

test('markOptimisticFailed leaves workingByStream untouched', () => {
  const { stream, unsubscribe } = bootStream();
  const optimisticId = stream.sendTurn(STREAM_ID, 'hello');
  expect(optimisticId).toBeTruthy();
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('pending');

  stream.markOptimisticFailed(optimisticId, 'reconcile_timeout');

  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('pending');

  unsubscribe();
});

test('sendTurn after end-of-turn returns to idle and accepts the next send', () => {
  const { stream, socket, unsubscribe } = bootStream();
  const firstId = stream.sendTurn(STREAM_ID, 'hello');
  expect(firstId).toBeTruthy();

  // Codex end-of-turn divider via real chat.event shape.
  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 10, host: 'hostc', provider: 'codex',
      session_id: STREAM_ID, session_name: 'chat-1', stream_id: STREAM_ID,
      timestamp: '2026-05-16T12:00:00.100Z', kind: 'USER', text: 'hello',
    },
  });
  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 11,
      host: 'hostc',
      provider: 'codex',
      session_id: STREAM_ID,
      session_name: 'chat-1',
      stream_id: STREAM_ID,
      timestamp: '2026-05-16T12:00:01.000Z',
      kind: 'SYSTEM',
      text: '─ Worked for 1s ─────────────────────────────────────────────────────────────────────────────────',
    },
  });

  jest.advanceTimersByTime(250);
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('idle');

  const secondId = stream.sendTurn(STREAM_ID, 'follow up');
  expect(secondId).toBe(`${firstId.replace(/_1$/, '')}_2`);
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('pending');

  unsubscribe();
});

test('first server event after pending fires CHAT_SESSION_FIRST_EVENT_AFTER_SEND with elapsed_from_send_press_ms', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'hello');

  // Advance the client clock to make elapsed observable.
  jest.advanceTimersByTime(250);
  const captured = captureTelemetry();

  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 11,
      host: 'hostc',
      provider: 'codex',
      session_id: STREAM_ID,
      session_name: 'chat-1',
      stream_id: STREAM_ID,
      timestamp: '2026-05-16T12:00:01.000Z',
      kind: 'ASSIST',
      text: 'on it',
    },
  });

  const firstEvent = captured.find((payload) => payload.message === TELEMETRY_EVENTS.CHAT_SESSION_FIRST_EVENT_AFTER_SEND);
  expect(firstEvent).toBeDefined();
  expect(firstEvent?.data.stream_id).toBe(STREAM_ID);
  expect(firstEvent?.data.elapsed_from_send_press_ms).toBe(250);
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('working');

  unsubscribe();
});

test('sendTurn rejects empty text without setting any state or firing telemetry', () => {
  const { stream, unsubscribe } = bootStream();
  const captured = captureTelemetry();

  expect(stream.sendTurn(STREAM_ID, '')).toBe('');
  expect(stream.sendTurn(STREAM_ID, '   ')).toBe('');

  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]).toBeUndefined();
  expect(captured.length).toBe(0);

  unsubscribe();
});
