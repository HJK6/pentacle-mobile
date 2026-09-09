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

test('asset command uses request_id and settles with the canonical ok frame', async () => {
  const { stream, socket, unsubscribe } = connect();
  const promise = stream.sendPentacleAssetCommand({ type: 'asset.list', stream_id: 'hostc:chat' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(payload).toEqual(expect.objectContaining({ type: 'asset.list', stream_id: 'hostc:chat' }));
  expect(typeof payload.request_id).toBe('string');
  socket.message({ type: 'asset.list.ok', request_id: payload.request_id, assets: [{ asset_id: 'r1' }] });
  await expect(promise).resolves.toEqual(expect.objectContaining({ assets: [{ asset_id: 'r1' }] }));
  unsubscribe();
});

test('asset.error rejects only the matching pending request', async () => {
  const { stream, socket, unsubscribe } = connect();
  const promise = stream.sendPentacleAssetCommand({ type: 'asset.get', stream_id: 'hostc:chat', asset_id: 'missing' });
  const payload = JSON.parse(socket.sent.at(-1) || '{}');
  socket.message({ type: 'asset.error', request_id: payload.request_id, error_code: 'asset_not_found' });
  await expect(promise).rejects.toThrow('asset_not_found');
  unsubscribe();
});

test('live asset frames fan out without touching the transcript state', () => {
  const { stream, socket, unsubscribe } = connect();
  const listener = jest.fn();
  const unsubscribeAssets = stream.subscribePentacleAssetFrames(listener);
  const before = stream.getPentacleStreamState();
  socket.message({ type: 'asset.update', stream_id: 'hostc:chat', asset: { asset_id: 'r1', content_type: 'report' } });
  socket.message({ type: 'asset.removed', stream_id: 'hostc:chat', asset_id: 'r1' });
  socket.message({ type: 'asset.session_closed', stream_id: 'hostc:chat' });
  expect(listener).toHaveBeenCalledTimes(3);
  expect(stream.getPentacleStreamState()).toBe(before);
  unsubscribeAssets();
  unsubscribe();
});

