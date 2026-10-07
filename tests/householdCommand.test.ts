// P5 household RPC wrapper (docs/bart_home_contracts.md § Household RPC): ordinary
// request/response over the stream socket, rejected on disconnect, never replayed.
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  constructor(public url: string) { MockWebSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close(code?: number, reason?: string) { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ code, reason, wasClean: false }); }
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

function lastFrame(socket: MockWebSocket, type: string) {
  return socket.sent.map((item) => JSON.parse(item)).filter((item) => item.type === type).at(-1);
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('sends the verb with its fields and resolves with the .ok reply', async () => {
  const { stream, socket, unsubscribe } = connect();
  const pending = stream.sendHouseholdCommand('household.item.add', { list_id: 'grocery', text: 'Milk' });
  const frame = lastFrame(socket, 'household.item.add');
  expect(frame).toMatchObject({ list_id: 'grocery', text: 'Milk' });
  expect(frame.request_id).toMatch(/^household/);
  socket.message({ type: 'household.item.add.ok', request_id: frame.request_id, item: { id: 'i1' } });
  await expect(pending).resolves.toMatchObject({ item: { id: 'i1' } });
  unsubscribe();
});

test('rejects with the error code on an .error reply', async () => {
  const { stream, socket, unsubscribe } = connect();
  const pending = stream.sendHouseholdCommand('household.snapshot', {});
  const frame = lastFrame(socket, 'household.snapshot');
  socket.message({ type: 'household.snapshot.error', request_id: frame.request_id, error_code: 'forbidden' });
  await expect(pending).rejects.toMatchObject({ errorCode: 'forbidden' });
  unsubscribe();
});

test('rejects non-household verbs and is not replayed after a disconnect', async () => {
  const { stream, socket, unsubscribe } = connect();
  expect(() => stream.sendHouseholdCommand('consent.approve', {})).toThrow('Invalid household verb');
  const pending = stream.sendHouseholdCommand('household.item.done', { item_id: 'i1' }).then(() => 'resolved', () => 'rejected');
  socket.close(1006, 'network_drop');
  await expect(pending).resolves.toBe('rejected');
  jest.advanceTimersByTime(1_000);
  const recovered = MockWebSocket.instances.at(-1) as MockWebSocket;
  recovered.open();
  expect(recovered.sent.map((item) => JSON.parse(item)).filter((item) => item.type === 'household.item.done')).toHaveLength(0);
  unsubscribe();
});

test('a caller field cannot override the household verb', () => {
  const { stream, socket, unsubscribe } = connect();
  void stream.sendHouseholdCommand('household.item.add', { type: 'consent.approve', text: 'x' }).catch(() => undefined);
  const types = socket.sent.map((item) => JSON.parse(item).type);
  expect(types).toContain('household.item.add');
  expect(types).not.toContain('consent.approve');
  unsubscribe();
});
