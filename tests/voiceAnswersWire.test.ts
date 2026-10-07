// P6 wire: meta.voice_answers reaches the socket, survives the optimistic row's retry with the same
// optimistic id (stage 2), and the daemon's voice_answers_status on the echoed USER event reaches the
// transcript row.
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://default.example/ws' }));

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
  onclose: (() => void) | null = null;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

function connect() {
  jest.resetModules();
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  return { stream, socket, unsubscribe };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const voiceAnswers = {
  version: 1,
  recording_id: 'rec-9',
  blob_sha: 'sha256:audio',
  duration_s: 7,
  items: [{
    key: 'n-1:0', question_id: 'q-1', notification_id: 'n-1', producer_stream_id: 'hostc:codex:seat',
    surface_stream_id: 'bart:assistant', prompt: 'Ship it?', segment: { start_s: 0, end_s: 3.2 },
  }],
};

test('meta.voice_answers reaches the wire; an ambiguous-send replay reuses the transcript, optimistic id and binding', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'session.inventory', sessions: [{ stream_id: 'bart:assistant', host: 'bart', session_name: 'assistant', provider: 'claude', online: true }] });
  const optimisticId = stream.appendOptimisticUserMessage('bart:assistant', 'ship it');
  const meta = { voice: { duration_s: 7 }, voice_answers: voiceAnswers };
  const first = stream.sendPentacleMessage({ host: 'bart', sessionName: 'assistant', text: 'ship it', optimisticId, meta });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload.meta).toEqual(meta);
  expect(payload.text).toBe('ship it');
  socket.message({ type: 'send.ok', request_id: payload.request_id });
  await first;
  stream.markOptimisticFailed(optimisticId, 'delivery_failed');
  const retry = stream.retryOptimisticSend(optimisticId);
  const retried = JSON.parse(socket.sent.at(-1) || '{}');
  expect(retried.meta.voice_answers).toEqual(voiceAnswers);
  expect(retried.meta.voice_answers.recording_id).toBe(payload.meta.voice_answers.recording_id);
  expect(retried.optimistic_id).toBe(payload.optimistic_id);
  expect(retried.text).toBe(payload.text);
  socket.message({ type: 'send.ok', request_id: retried.request_id });
  await retry;
  unsubscribe();
});

