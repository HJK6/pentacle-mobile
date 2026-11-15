// X on a failed text message deletes its local copy at once: the optimistic row and its
// durable outbox entry go away. Only a failed, non-voice send can be discarded this way.
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://default.example/ws' }));

class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;
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
  socket.message({ type: 'session.inventory', sessions: [{ stream_id: 'hosta:origin', host: 'hosta', session_name: 'origin', provider: 'codex', online: true }] });
  return { stream, socket, unsubscribe };
}
const userRows = (stream: typeof import('../src/services/pentacleStream')) =>
  require('pentacle-chat-core').selectSessionDetail(stream.getPentacleStreamState(), 'hosta:origin').transcriptItems.filter((item: any) => item.isUser);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('a failed text send is removed locally at once', async () => {
  const { stream, unsubscribe } = connect();
  const optimisticId = stream.appendOptimisticUserMessage('hosta:origin', 'move it to Thursday');
  stream.sendPentacleMessage({ host: 'hosta', sessionName: 'origin', text: 'move it to Thursday', optimisticId }).catch(() => undefined);
  stream.markOptimisticFailed(optimisticId, 'delivery_failed');
  expect(userRows(stream)).toHaveLength(1);
  await expect(stream.discardFailedOptimisticSend(optimisticId)).resolves.toBe(true);
  expect(userRows(stream)).toHaveLength(0);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toBeUndefined();
  unsubscribe();
});

test('a send that has not failed is never discarded by the failed-row X', async () => {
  const { stream, unsubscribe } = connect();
  const optimisticId = stream.appendOptimisticUserMessage('hosta:origin', 'still sending');
  stream.sendPentacleMessage({ host: 'hosta', sessionName: 'origin', text: 'still sending', optimisticId }).catch(() => undefined);
  await expect(stream.discardFailedOptimisticSend(optimisticId)).resolves.toBe(false);
  expect(userRows(stream)).toHaveLength(1);
  await expect(stream.discardFailedOptimisticSend('missing')).resolves.toBe(false);
  unsubscribe();
});
