// A WORKING seed frame that arrives before the chat is focused is batched
// (shouldApplyLiveEventImmediately defers WORKING/DRAFT while the focused stream
// differs). The focused-stream registration must replay that batch through the
// per-event reducer so the working state is available to the composer.

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import type { PentacleSessionSummary } from 'pentacle-chat-core';

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

const STREAM_ID = 'hostc:codex:working-open';

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-07-11T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function workingSeedFrame(seq: number) {
  return {
    type: 'chat.event',
    event: {
      daemon_seq: seq,
      host: 'hostc',
      provider: 'codex',
      session_id: STREAM_ID,
      session_name: 'working-open',
      stream_id: STREAM_ID,
      timestamp: '2026-07-11T12:00:01.000Z',
      kind: 'WORKING',
      text: '',
      raw: { working: true, working_label: 'Working' },
    },
  };
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

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-07-11T12:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

test('a WORKING seed batched before focus derives working in the reducer on focus registration', () => {
  const { stream, socket, unsubscribe } = bootStream();

  // The WORKING seed arrives on the wire while the chat is NOT yet focused, so
  // shouldApplyLiveEventImmediately defers it into the live batch (transport
  // reached). No timer is advanced, so the batch is still pending at focus.
  socket.message(workingSeedFrame(1));
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).not.toBe('working');

  // Focus registration (send-handler register / chat open) must land the batched
  // WORKING seed in the reducer so working is derived before the composer window.
  const unregister = stream.registerFocusedPentacleStream(STREAM_ID);
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('working');
  expect(stream.getPentacleStreamState().sessions.find((s) => s.stream_id === STREAM_ID)?.working).toBe(true);

  unregister();
  unsubscribe();
});
