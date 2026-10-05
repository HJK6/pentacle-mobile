jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => 'ws://queue.example/ws' }));

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = Socket.CLOSED; this.onclose?.(); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const streamId = 'hosta:v2-queue';

function connected() {
  jest.resetModules();
  Socket.instances = [];
  global.WebSocket = Socket as unknown as typeof WebSocket;
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({ type: 'snapshot', sessions: [{ stream_id: streamId, host: 'hosta', provider: 'claude',
    session_name: 'v2-queue', visibility: 'default', online: true, last_event_at: '', last_text: '', last_kind: '' }], events: [] });
  const firstRow = () => core.selectSessionDetail(stream.getPentacleStreamState(), streamId,
    { visibleCount: 'all', emitRenderTelemetry: false })?.transcriptItems[0];
  return { stream, socket, core, unsubscribe, firstRow };
}

beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-10-05T12:00:00Z') }));
afterEach(() => jest.clearAllTimers());

test.each([true, false])('landed provider_queued=%s reaches the shared caption before the echo', async (providerQueued) => {
  const { stream, socket, unsubscribe, firstRow } = connected();
  try {
    const optimisticId = stream.appendOptimisticUserMessage(streamId, 'Fixture send');
    const sent = stream.sendPentacleMessage({ host: 'hosta', sessionName: 'v2-queue', text: 'Fixture send', optimisticId });
    const request = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'send');
    socket.receive({ type: 'send.result', request_id: request.request_id, delivery: 'landed', provider_queued: providerQueued });
    await expect(sent).resolves.toBe(true);
    const optimistic = stream.getPentacleStreamState().optimisticSends?.[optimisticId];
    expect(optimistic?.status).toBe('acked');
    expect(optimistic?.turn_queued).not.toBe(true);
    expect(firstRow()?.receiptCaption).toBe(providerQueued ? 'queued' : 'sent');
    expect((firstRow() as any)?.providerQueued).toBe(providerQueued ? true : undefined);
    expect(firstRow()?.sendState).not.toBe('queued');
    stream.flushQueuedSends(streamId);
    await Promise.resolve();
    expect(socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === 'send')).toHaveLength(1);
    socket.receive({ type: 'chat.event', event: { daemon_seq: 42, stream_id: streamId, host: 'hosta', provider: 'claude',
      session_id: streamId, session_name: 'v2-queue', timestamp: '2026-10-05T12:00:01Z', kind: 'USER', text: 'Fixture send',
      optimistic_id: optimisticId, request_id: request.request_id, raw: { receipt_state: 'landed', receipt_delivery: 'landed' } } });
    expect(firstRow()?.receiptCaption).toBe('sent');
    expect((firstRow() as any)?.providerQueued).not.toBe(true);
  } finally { unsubscribe(); }
});

test('the send bridge cannot regress confirmed native queue ownership or lose it on a later plain ack', () => {
  const { stream, socket, core, unsubscribe, firstRow } = connected();
  try {
    const optimisticId = stream.appendOptimisticUserMessage(streamId, 'Fixture send');
    void stream.sendPentacleMessage({ host: 'hosta', sessionName: 'v2-queue', text: 'Fixture send', optimisticId });
    const request = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === 'send');
    socket.receive({ type: 'send.result', request_id: request.request_id, delivery: 'landed', provider_queued: true });
    const acked = stream.getPentacleStreamState();
    const afterBridge = core.markOptimisticDispatchedByRequestId(acked, request.request_id, Date.now() + 10);
    const repeatedAck = core.markOptimisticAckedByRequestId(afterBridge, request.request_id, Date.now() + 20);
    expect(repeatedAck.optimisticSends?.[optimisticId]).toMatchObject({ status: 'acked', provider_queued: true });
    expect(firstRow()?.receiptCaption).toBe('queued');
  } finally { unsubscribe(); }
});
