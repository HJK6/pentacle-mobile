// Projected from the certified private composite transport contract.
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

type DismissQuestionSocketEvent = { data?: string };

class DismissQuestionMockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: DismissQuestionMockWebSocket[] = [];

  readyState = DismissQuestionMockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: DismissQuestionSocketEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    DismissQuestionMockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = DismissQuestionMockWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = DismissQuestionMockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function loadPentacleStreamForDismissQuestion() {
  jest.resetModules();
  jest.doMock('../src/config/pentacle', () => ({
    getDefaultPentacleWsUrl: () => 'ws://dismiss-question.example/ws',
  }));
  DismissQuestionMockWebSocket.instances = [];
  Object.assign(DismissQuestionMockWebSocket, {
    CONNECTING: DismissQuestionMockWebSocket.CONNECTING,
    OPEN: DismissQuestionMockWebSocket.OPEN,
    CLOSED: DismissQuestionMockWebSocket.CLOSED,
  });
  global.WebSocket = DismissQuestionMockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

test('composite hello/send keeps wire identity, reply metadata, acceptance, and retry identity', async () => {
  jest.useFakeTimers();
  const stream = loadPentacleStreamForDismissQuestion();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = DismissQuestionMockWebSocket.instances[0];
  socket.open();
  socket.message({
    type: 'session.inventory',
    sessions: [{
      stream_id: 'alpha:assistant',
      host: 'alpha',
      provider: 'composite',
      session_name: 'assistant',
      session_kind: 'assistant_composite',
      visibility: 'visible',
      capabilities: {
        pane: false,
        terminal: false,
        assistant_composite_v1: true,
        reply_metadata_v1: true,
      },
      last_event_at: '2026-09-19T12:00:00.000Z',
      last_text: '',
      last_kind: '',
      online: true,
    }],
  });

  const hello = socket.sent
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.type === 'hello');
  expect(hello?.capabilities).toEqual({ assistant_composite_v1: true });

  const optimisticId = stream.sendTurn('alpha:assistant', 'follow up');
  const firstSend = stream.sendPentacleMessage({
    host: 'alpha',
    sessionName: 'assistant',
    text: 'follow up',
    optimisticId,
    replyToMessageId: 'message-1',
    replyToQuestionId: 'question-1',
  });
  const firstPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(firstPayload).toMatchObject({
    type: 'send',
    msg_id: optimisticId,
    stream_id: 'alpha:assistant',
    message: 'follow up',
    reply_to_message_id: 'message-1',
    reply_to_question_id: 'question-1',
  });
  expect(firstPayload.text).toBeUndefined();
  expect(firstPayload.host).toBeUndefined();
  socket.message({
    type: 'send.ok',
    request_id: firstPayload.request_id,
    message_id: 'message-2',
    routing_state: 'queued',
    accepted_sequence: 4,
    queue_sequence: 4,
    action_committed: true,
  });
  await expect(firstSend).resolves.toBe(true);
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]).toMatchObject({
    optimistic_id: optimisticId,
    message_id: 'message-2',
    routing_state: 'queued',
    accepted_sequence: 4,
    queue_sequence: 4,
    action_committed: true,
    reply_to_message_id: 'message-1',
    reply_to_question_id: 'question-1',
  });

  stream.markOptimisticFailed(optimisticId, 'retryable');
  const retry = stream.retryOptimisticSend(optimisticId);
  const retryPayload = JSON.parse(socket.sent.at(-1) || '{}');
  expect(retryPayload.msg_id).toBe(optimisticId);
  expect(retryPayload.request_id).not.toBe(firstPayload.request_id);
  expect(retryPayload.reply_to_message_id).toBe('message-1');
  expect(retryPayload.reply_to_question_id).toBe('question-1');
  socket.message({ type: 'send.ok', request_id: retryPayload.request_id });
  await expect(retry).resolves.toBe(true);
  unsubscribe();
  jest.useRealTimers();
});

