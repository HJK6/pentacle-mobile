jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';

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
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  setTelemetrySink(null);
  jest.useRealTimers();
});

test('spawn.ok applies the returned session before spawnSession resolves', async () => {
  const stream = loadStream();
  const telemetryEvents: TelemetryPayload[] = [];
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  telemetry.setTelemetrySink((payload) => telemetryEvents.push(payload));

  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();

  const newSession = {
    stream_id: 'hostc:codex:fresh-spawn',
    host: 'hostc',
    provider: 'codex',
    session_name: 'fresh-spawn',
    title: 'Fresh spawn',
    last_event_at: '2026-05-13T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };

  const spawnPromise = stream.spawnPentacleSession({ host: 'hostc', provider: 'codex' });
  const spawnPayload = JSON.parse(socket.sent.at(-1) || '{}');

  socket.message({
    type: 'spawn.ok',
    request_id: spawnPayload.request_id,
    session: newSession,
  });

  await expect(spawnPromise).resolves.toEqual(expect.objectContaining({
    stream_id: 'hostc:codex:fresh-spawn',
  }));

  expect(stream.getPentacleStreamState().sessions.find(
    (item) => item.stream_id === 'hostc:codex:fresh-spawn',
  )).toEqual(expect.objectContaining(newSession));
  expect(telemetryEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      subsystem: 'chat_surface',
      message: TELEMETRY_EVENTS.CHAT_SESSION_SPAWN_SUMMARY_APPLIED,
      bug_ref: expect.any(String),
      data: expect.objectContaining({
        stream_id: 'hostc:codex:fresh-spawn',
        provider: 'codex',
        host: 'hostc',
      }),
    }),
  ]));

  unsubscribe();
});
