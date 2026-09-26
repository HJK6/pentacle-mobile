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


test('voice metadata reaches the wire, optimistic caption and retry without audio', async () => {
  const { stream, socket, unsubscribe } = connect();
  socket.message({ type: 'session.inventory', sessions: [{ stream_id: 'hosta:origin', host: 'hosta', session_name: 'origin', provider: 'codex', online: true }] });
  const optimisticId = stream.appendOptimisticUserMessage('hosta:origin', 'voice transcript');
  const first = stream.sendPentacleMessage({ host: 'hosta', sessionName: 'origin', text: 'voice transcript', optimisticId, meta: { voice: { duration_s: 7 } } });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload.meta).toEqual({ voice: { duration_s: 7 } });
  expect(payload.text).toBe('voice transcript');
  expect(payload.attachments).toBeUndefined();
  const core = require('pentacle-chat-core');
  expect(core.selectSessionDetail(stream.getPentacleStreamState(), 'hosta:origin').transcriptItems.find((item: any) => item.isUser).voice).toEqual({ duration_s: 7 });
  socket.message({ type: 'send.ok', request_id: payload.request_id });
  await first;
  stream.markOptimisticFailed(optimisticId, 'delivery_failed');
  const retry = stream.retryOptimisticSend(optimisticId);
  const retried = JSON.parse(socket.sent.at(-1) || '{}');
  expect(retried.meta).toEqual(payload.meta);
  expect(retried.optimistic_id).toBe(payload.optimistic_id);
  socket.message({ type: 'send.ok', request_id: retried.request_id });
  await retry;
  unsubscribe();
});
