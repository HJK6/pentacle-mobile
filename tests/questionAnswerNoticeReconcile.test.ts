// Public synthetic fixtures preserve the reviewed notification-answer wire shapes.
import { buildDurableQuestionAnswerText } from '../src/services/agentQuestionNotifications';
import { isSessionSending, interpretPentacleEvent } from 'pentacle-chat-core';
import type { PentacleSessionSummary } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('expo-notifications', () => ({}));

const STREAM_ID = 'alpha:v2-scratch-producer';

// Synthetic notification-answer fixture.
const NOTICE_YES_NO = [
  '[pentacle-notice:notification-answer-00000000-0000-4000-8000-000000000002]',
  '[notification.answer]',
  'notification_id=00000000-0000-4000-8000-000000000002',
  'answer=continue_2000',
  'choice=False',
  'by=operator',
].join('\n');

// Synthetic notification-answer fixture.
const NOTICE_CUSTOM_TEXT = [
  '[pentacle-notice:notification-answer-00000000-0000-4000-8000-000000000001]',
  '[notification.answer]',
  'notification_id=00000000-0000-4000-8000-000000000001',
  'custom_text=Please explain option one and use the updated example version.',
  'by=operator',
].join('\n');

const CREATED_AT = Date.parse('2026-09-17T09:07:52.000Z');

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

  closeFromServer(code = 1006, reason = 'network_drop') {
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
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

function producerSession(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'alpha',
    provider: 'claude',
    session_name: 'scratch-producer',
    last_event_at: '2026-09-17T09:07:50.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false, // idle: the lane is not "working", so a queued answer row reads as "sending"
    online: true,
    ...overrides,
  };
}

function connectedStream() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [producerSession()] });
  return { stream, unsubscribe, socket };
}

// Model the durable-answer optimistic flow exactly as submitDurableQuestionAnswer
// does: append the optimistic USER row (JSON text), then mark it queued after the
// daemon's notification.resolve returns OK.
function queueOptimisticAnswer(
  stream: typeof import('../src/services/pentacleStream'),
  args: { notificationId: string; questionId?: string; selections?: string[]; customText?: string },
) {
  const optimisticText = buildDurableQuestionAnswerText({
    notificationId: args.notificationId,
    actionKind: 'answered',
    ...(args.questionId ? { questionId: args.questionId } : {}),
    ...(args.selections ? { selections: args.selections } : {}),
    ...(args.customText ? { customText: args.customText } : {}),
  });
  const optimisticId = stream.beginOptimisticQuestionAnswer({
    streamId: STREAM_ID,
    text: optimisticText,
    notificationId: args.notificationId,
    ...(args.questionId ? { questionId: args.questionId } : {}),
  });
  stream.queueOptimisticQuestionAnswer(optimisticId);
  return optimisticId;
}

function noticeEvent(text: string, daemonSeq: number) {
  return {
    daemon_seq: daemonSeq,
    host: 'alpha',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'scratch-producer',
    stream_id: STREAM_ID,
    timestamp: '2026-09-17T09:07:56.000Z',
    kind: 'USER',
    text,
    // The daemon's answer notice carries NO client optimistic_id — it is a
    // server-authored notice, not a stamped echo of the client's send.
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: CREATED_AT + 1_000 });
});

afterEach(() => {
  jest.clearAllTimers();
});

test('H1 yes_no: the real key=value answer notice reconciles the queued optimistic row and clears "sending"', () => {
  const { stream, unsubscribe, socket } = connectedStream();

  const optimisticId = queueOptimisticAnswer(stream, {
    notificationId: '00000000-0000-4000-8000-000000000002',
    questionId: 'q-afebc4b8',
    selections: ['continue_2000'],
  });

  // Precondition: the lane reads "sending" while the queued answer row is pending.
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('queued');
  expect(isSessionSending(stream.getPentacleStreamState(), STREAM_ID)).toBe(true);

  // The daemon delivers its answer notice (the synthetic wire fixture).
  socket.message({ type: 'chat.event', event: noticeEvent(NOTICE_YES_NO, 101) });

  const state = stream.getPentacleStreamState();
  // AC1: the lane must leave "sending" once the notice lands.
  expect(isSessionSending(state, STREAM_ID)).toBe(false);
  // The optimistic answer row must be reconciled (removed), not left queued.
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();
  // AC2: the answer appears exactly once in the transcript.
  const userEvents = state.events.filter((e) => e.stream_id === STREAM_ID && String(e.kind).toUpperCase() === 'USER');
  expect(userEvents).toHaveLength(1);
  // AC2 (QA cycle-2): the reconciled row must NOT leak the raw daemon notice. Its text
  // stays the optimistic JSON, which the interpreter renders as an "Operator answered"
  // card — not the raw [pentacle-notice]/[notification.answer] transport text.
  const rendered = interpretPentacleEvent({ ...userEvents[0], stream_id: '' });
  expect(rendered.text).not.toMatch(/\[pentacle-notice|\[notification\.answer\]|notification_id=/);
  expect(rendered.displayRule).toBe('activity:question');

  unsubscribe();
});

test('H1 custom_text: the real key=value answer notice reconciles the queued optimistic row and clears "sending"', () => {
  const { stream, unsubscribe, socket } = connectedStream();

  const optimisticId = queueOptimisticAnswer(stream, {
    notificationId: '00000000-0000-4000-8000-000000000001',
    questionId: 'q-91d86d80',
    customText: 'Please explain option one and use the updated example version.',
  });

  expect(isSessionSending(stream.getPentacleStreamState(), STREAM_ID)).toBe(true);

  socket.message({ type: 'chat.event', event: noticeEvent(NOTICE_CUSTOM_TEXT, 102) });

  const state = stream.getPentacleStreamState();
  expect(isSessionSending(state, STREAM_ID)).toBe(false);
  expect(state.optimisticSends?.[optimisticId]).toBeUndefined();

  unsubscribe();
});

// H2 refutation (AC3): a queued durable-answer optimistic row must never be
// re-driven as a chat `send` on reconnect. The durable-answer flow
// (beginOptimisticQuestionAnswer -> resolveNotification -> queueOptimisticQuestionAnswer)
// never adds the row to `queuedOptimisticDispatchRequests`, and the live reconnect
// path re-dispatches only rows in that set (dispatchOfflineQueuedSends); the
// separate `eligibleReconnectReplayOptimisticIds` helper is not wired into the
// live path. This test proves that today: reconnect emits ZERO send frames for a
// queued answer row.
test('H2: a queued durable-answer row is not replayed as a chat send across a reconnect', () => {
  const { stream, unsubscribe, socket } = connectedStream();

  const optimisticId = queueOptimisticAnswer(stream, {
    notificationId: '00000000-0000-4000-8000-000000000002',
    questionId: 'q-afebc4b8',
    selections: ['continue_2000'],
  });
  expect(stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.status).toBe('queued');

  // Transport cut, then a fresh socket comes up.
  socket.closeFromServer();
  jest.advanceTimersByTime(1_000);
  const reconnected = MockWebSocket.instances.at(-1) as MockWebSocket;
  reconnected.open();
  reconnected.message({ type: 'session.inventory', sessions: [producerSession()] });

  // No `send` frame may carry the JSON answer text onto the wire.
  const sendFrames = reconnected.sent
    .map((raw) => JSON.parse(raw))
    .filter((frame) => frame.type === 'send');
  expect(sendFrames).toHaveLength(0);

  unsubscribe();
});

// AC3 (QA-F1): exact same-text composer reuse must NOT select a queued answer row.
// The answer row's text is the JSON protocol string; if the operator later sends a
// chat message with that identical text, sendMessage's same-text reuse must skip the
// answer row (never re-drive it as a chat `send` / paste raw JSON into the pane).
test('AC3: exact same-text send does not reuse or dispatch a queued durable-answer row', async () => {
  const { stream, unsubscribe, socket } = connectedStream();

  const optimisticId = queueOptimisticAnswer(stream, {
    notificationId: '00000000-0000-4000-8000-000000000002',
    questionId: 'q-afebc4b8',
    selections: ['continue_2000'],
  });
  const answerText = stream.getPentacleStreamState().optimisticSends?.[optimisticId]?.text as string;
  expect(answerText).toContain('"type":"notification.answer"');

  // Operator sends a chat message whose text is byte-identical to the answer row.
  // The `send` frame is emitted synchronously; we settle the promise afterwards via
  // a transport close so there is no open handle.
  const settled = stream
    .sendPentacleMessage({ host: 'alpha', sessionName: 'scratch-producer', text: answerText })
    .then(() => 'resolved', () => 'rejected');

  // The answer row is untouched (still queued) and was NOT put on the wire as this send.
  const state = stream.getPentacleStreamState();
  expect(state.optimisticSends?.[optimisticId]?.status).toBe('queued');
  const sendFrames = socket.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === 'send');
  expect(sendFrames.every((f) => f.optimistic_id !== optimisticId)).toBe(true);

  socket.closeFromServer();
  await settled;
  unsubscribe();
});
