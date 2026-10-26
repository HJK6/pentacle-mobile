// Send-while-working queue + ESC: service-level mechanics against the real
// chat-core reducer + a mocked WebSocket. enqueueTurn appends a queued
// optimistic row without beginning/replacing the active turn; the mobile
// by-optimistic-id dispatcher sends queued rows FIFO to the daemon so its native
// working-session queue can batch them on idle. interruptSend issues a single
// `send.interrupt` frame.
// Queue regression coverage uses deterministic synthetic sessions and messages.

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

const STREAM_ID = 'hostc:codex:chat-1';

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-06-17T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

const END_OF_TURN = {
  type: 'chat.event',
  event: {
    daemon_seq: 0,
    host: 'hostc',
    provider: 'codex',
    session_id: STREAM_ID,
    session_name: 'chat-1',
    stream_id: STREAM_ID,
    timestamp: '2026-06-17T12:00:01.000Z',
    kind: 'SYSTEM',
    text: '─ Worked for 1s ─────────────────────────────────────────────────────────────────────────────────',
  },
};

function bootStream() {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID)] });
  return { stream, socket, unsubscribe };
}

function endOfTurn(socket: MockWebSocket, seq: number) {
  socket.message({ ...END_OF_TURN, event: { ...END_OF_TURN.event, daemon_seq: seq } });
}

function sentFrames(socket: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-06-17T12:00:00.000Z') });
});

afterEach(() => {
  jest.useRealTimers();
});

test('enqueueTurn preserves the active turn while creating native-queue rows — no new turn, no wire send', () => {
  const { stream, socket, unsubscribe } = bootStream();
  // An active turn is in flight (phase pending).
  const activeId = stream.sendTurn(STREAM_ID, 'active');
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('pending');

  const q1 = stream.enqueueTurn(STREAM_ID, 'queued one');
  const q2 = stream.enqueueTurn(STREAM_ID, 'queued two');
  expect(q1).toBeTruthy();
  expect(q2).toBeTruthy();

  const sends = stream.getPentacleStreamState().optimisticSends ?? {};
  // The active send is unchanged; queued sends no longer carry the retired
  // client-side turn_queued hold marker.
  expect(sends[activeId]?.turn_queued).toBeFalsy();
  expect(sends[q1]?.turn_queued).toBeFalsy();
  expect(sends[q1]?.status).toBe('queued');
  expect(sends[q1]?.queued_at).toBeDefined();
  expect(sends[q2]?.turn_queued).toBeFalsy();
  expect(sends[q2]?.status).toBe('queued');
  expect(sends[q2]?.queued_at).toBeDefined();

  // Enqueuing did NOT begin a new turn (the active turn's identity is untouched).
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.optimisticId).toBe(activeId);
  // Nothing was dispatched on the wire yet; the by-id dispatcher owns that step.
  expect(sentFrames(socket, 'send').length).toBe(0);

  unsubscribe();
});

test('dispatchQueuedSendsByOptimisticId dispatches all queued sends FIFO with optimistic_id/request_id', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const q1 = stream.enqueueTurn(STREAM_ID, 'queued one');
  const q2 = stream.enqueueTurn(STREAM_ID, 'queued two');
  const q3 = stream.enqueueTurn(STREAM_ID, 'queued three');

  // The daemon is now canonical for "hold while working"; the client sends the
  // whole FIFO set while the active turn is still in flight so the daemon can
  // flush them as one batch on the working→idle transition.
  const beforeDispatch = stream.getPentacleStreamState().optimisticSends ?? {};
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, [q1, q2, q3]);

  let sends = sentFrames(socket, 'send');
  expect(sends.length).toBe(3);
  expect(sends[0].text).toBe('queued one');
  expect(sends[0].optimistic_id).toBe(q1);
  expect(sends[0].request_id).toBe(beforeDispatch[q1]?.request_id);
  expect(stream.getPentacleStreamState().optimisticSends?.[q1]?.turn_queued).toBeFalsy();
  expect(stream.getPentacleStreamState().optimisticSends?.[q1]?.status).toBe('dispatched');
  expect(sends[1].text).toBe('queued two');
  expect(sends[1].optimistic_id).toBe(q2);
  expect(sends[1].request_id).toBe(beforeDispatch[q2]?.request_id);
  expect(stream.getPentacleStreamState().optimisticSends?.[q2]?.turn_queued).toBeFalsy();
  expect(stream.getPentacleStreamState().optimisticSends?.[q2]?.status).toBe('dispatched');
  expect(sends[2].text).toBe('queued three');
  expect(sends[2].optimistic_id).toBe(q3);
  expect(sends[2].request_id).toBe(beforeDispatch[q3]?.request_id);
  expect(stream.getPentacleStreamState().optimisticSends?.[q3]?.turn_queued).toBeFalsy();
  expect(stream.getPentacleStreamState().optimisticSends?.[q3]?.status).toBe('dispatched');

  socket.message({
    type: 'send.result',
    request_id: sends[0].request_id,
    delivery: 'landed',
    batch_id: 'db_1',
    batch_index: 0,
    batch_size: 3,
    daemon_send_id: 'ds_1',
  });
  socket.message({
    type: 'send.result',
    request_id: sends[1].request_id,
    delivery: 'landed',
    batch_id: 'db_1',
    batch_index: 1,
    batch_size: 3,
    daemon_send_id: 'ds_2',
  });
  socket.message({
    type: 'send.result',
    request_id: sends[2].request_id,
    delivery: 'landed',
    batch_id: 'db_1',
    batch_index: 2,
    batch_size: 3,
    daemon_send_id: 'ds_3',
  });
  expect(stream.getPentacleStreamState().optimisticSends?.[q1]?.status).toBe('acked');
  expect(stream.getPentacleStreamState().optimisticSends?.[q2]?.status).toBe('acked');
  expect(stream.getPentacleStreamState().optimisticSends?.[q3]?.status).toBe('acked');

  // No second idle window is needed to release tail items.
  endOfTurn(socket, 21);
  stream.flushQueuedSends(STREAM_ID);
  sends = sentFrames(socket, 'send');
  expect(sends.length).toBe(3);

  unsubscribe();
});

test('release gate: delayed one-LF composite echo reconciles two identical native-queue sends after screen remount', async () => {
  const { stream, socket, unsubscribe } = bootStream();
  socket.message({
    type: 'session.inventory',
    sessions: [session(STREAM_ID, { working: true })],
  });
  const screenUnsubscribe = stream.subscribePentacleStream(jest.fn());
  const firstId = stream.enqueueTurn(STREAM_ID, 'same queued text');
  const secondId = stream.enqueueTurn(STREAM_ID, 'same queued text');
  const beforeDispatch = stream.getPentacleStreamState().optimisticSends ?? {};

  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, [firstId, secondId]);
  const sends = sentFrames(socket, 'send');
  expect(sends.map((frame) => ({
    request_id: frame.request_id,
    optimistic_id: frame.optimistic_id,
  }))).toEqual([
    { request_id: beforeDispatch[firstId]?.request_id, optimistic_id: firstId },
    { request_id: beforeDispatch[secondId]?.request_id, optimistic_id: secondId },
  ]);
  const dispatchGeneration = stream.getPentacleStreamState().optimisticSends?.[firstId]?.socket_generation;
  expect(dispatchGeneration).toBeDefined();
  expect(stream.getPentacleStreamState().optimisticSends?.[secondId]?.socket_generation)
    .toBe(dispatchGeneration);

  for (const frame of sends) {
    socket.message({
      type: 'send.result',
      request_id: frame.request_id,
      delivery: 'landed',
      reason: 'batch_submitted',
    });
  }
  expect(stream.getPentacleStreamState().optimisticSends?.[firstId]?.status).toBe('acked');
  expect(stream.getPentacleStreamState().optimisticSends?.[secondId]?.status).toBe('acked');

  screenUnsubscribe();
  const remountUnsubscribe = stream.subscribePentacleStream(jest.fn());
  const staleFetch = stream.requestStreamEvents(STREAM_ID, 20, { purpose: 'mount-fetch' });
  const fetchFrame = sentFrames(socket, 'request_stream_events').at(-1);
  expect(fetchFrame?.request_id).toBeTruthy();
  socket.message({
    type: 'request_stream_events.ok',
    request_id: fetchFrame?.request_id,
    stream_id: STREAM_ID,
    events: [],
  });
  await expect(staleFetch).resolves.toEqual([]);
  expect(MockWebSocket.instances).toHaveLength(1);
  expect(stream.getPentacleStreamState().optimisticSends?.[firstId]?.socket_generation)
    .toBe(dispatchGeneration);
  const core = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const remountedRows = core.selectSessionDetail(
    stream.getPentacleStreamState(),
    STREAM_ID,
    { visibleCount: 'all' },
  )?.transcriptItems.filter((item) => item.text === 'same queued text');
  expect(remountedRows?.map((item) => ({
    queuedWhileWorking: item.queuedWhileWorking,
    sendState: item.sendState,
  }))).toEqual([
    { queuedWhileWorking: undefined, sendState: undefined },
    { queuedWhileWorking: undefined, sendState: undefined },
  ]);

  jest.setSystemTime(new Date('2026-06-17T12:03:34.700Z'));
  socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 91,
      host: 'hostc',
      provider: 'codex',
      session_id: STREAM_ID,
      session_name: 'chat-1',
      stream_id: STREAM_ID,
      timestamp: '2026-06-17T12:03:34.700Z',
      kind: 'USER',
      text: 'same queued text\nsame queued text',
    },
  });

  const finalState = stream.getPentacleStreamState();
  expect(finalState.optimisticSends?.[firstId]).toBeUndefined();
  expect(finalState.optimisticSends?.[secondId]).toBeUndefined();
  expect(finalState.optimisticByRequestId?.[String(sends[0].request_id)]).toBeUndefined();
  expect(finalState.optimisticByRequestId?.[String(sends[1].request_id)]).toBeUndefined();
  expect(sentFrames(socket, 'send')).toHaveLength(2);

  const rows = core.selectSessionDetail(finalState, STREAM_ID, { visibleCount: 'all' })
    ?.transcriptItems.filter((item) => item.text === 'same queued text');
  expect(rows).toHaveLength(2);
  expect(rows?.map((item) => ({
    optimisticId: item.optimisticId,
    queuedWhileWorking: item.queuedWhileWorking,
    sendState: item.sendState,
    correlatedDaemonSeq: item.correlatedDaemonSeq,
  }))).toEqual([
    { optimisticId: firstId, queuedWhileWorking: undefined, sendState: undefined, correlatedDaemonSeq: 91 },
    { optimisticId: secondId, queuedWhileWorking: undefined, sendState: undefined, correlatedDaemonSeq: 91 },
  ]);

  remountUnsubscribe();
  unsubscribe();
});

test('release gate: one-LF FIFO composite echo reconciles three distinct rows and rejects near misses', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const firstId = stream.enqueueTurn(STREAM_ID, 'one');
  const secondId = stream.enqueueTurn(STREAM_ID, 'two');
  const thirdId = stream.enqueueTurn(STREAM_ID, 'three');
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, [firstId, secondId, thirdId]);
  for (const frame of sentFrames(socket, 'send')) {
    if (frame.request_id) socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed' });
  }

  const emitEcho = (streamId: string, text: string, optimistic_id?: string) => socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 200 + text.length, host: 'merlin', provider: 'codex',
      session_id: streamId, session_name: 'chat-1', stream_id: streamId,
      timestamp: '2026-06-17T12:03:34.700Z', kind: 'USER', text,
      ...(optimistic_id ? { optimistic_id } : {}),
    },
  });

  emitEcho(STREAM_ID, 'one\ntwo\nthree');
  expect(stream.getPentacleStreamState().optimisticSends?.[firstId]).toBeUndefined();
  expect(stream.getPentacleStreamState().optimisticSends?.[secondId]).toBeUndefined();
  expect(stream.getPentacleStreamState().optimisticSends?.[thirdId]).toBeUndefined();
  const rows = require('pentacle-chat-core').selectSessionDetail(
    stream.getPentacleStreamState(), STREAM_ID, { visibleCount: 'all' },
  )?.transcriptItems.filter((item: { text: string }) => ['one', 'two', 'three'].includes(item.text));
  expect(rows).toHaveLength(3);
  unsubscribe();
});

test('release gate: reordered, partial, double-LF, unrelated, and same-ID echoes do not settle FIFO rows', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const firstId = stream.enqueueTurn(STREAM_ID, 'one');
  const secondId = stream.enqueueTurn(STREAM_ID, 'two');
  const thirdId = stream.enqueueTurn(STREAM_ID, 'three');
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, [firstId, secondId, thirdId]);
  for (const frame of sentFrames(socket, 'send')) {
    if (frame.request_id) socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed' });
  }
  const sendEvent = (streamId: string, text: string, optimistic_id?: string) => socket.message({
    type: 'chat.event',
    event: {
      daemon_seq: 300 + text.length, host: 'merlin', provider: 'codex',
      session_id: streamId, session_name: 'chat-1', stream_id: streamId,
      timestamp: '2026-06-17T12:03:34.700Z', kind: 'USER', text,
      ...(optimistic_id ? { optimistic_id } : {}),
    },
  });
  const queued = () => stream.getPentacleStreamState().optimisticSends ?? {};
  sendEvent(STREAM_ID, 'two\none\nthree');
  sendEvent(STREAM_ID, 'one\ntwo');
  sendEvent(STREAM_ID, 'one\n\ntwo\n\nthree');
  sendEvent('other:chat-1', 'one\ntwo\nthree');
  sendEvent(STREAM_ID, 'one\ntwo\nthree', 'server-retry-id');
  expect(queued()[firstId]).toBeDefined();
  expect(queued()[secondId]).toBeDefined();
  expect(queued()[thirdId]).toBeDefined();
  unsubscribe();
});

test('a dispatched native-queue send flips queued → acked when the daemon confirms delivery', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const q1 = stream.enqueueTurn(STREAM_ID, 'queued one');

  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, q1);
  const requestId = sentFrames(socket, 'send')[0].request_id as string;
  expect(requestId).toBeTruthy();

  socket.message({ type: 'send.result', request_id: requestId, delivery: 'landed' });
  expect(stream.getPentacleStreamState().optimisticSends?.[q1]?.status).toBe('acked');

  unsubscribe();
});

test('a disconnected queued attachment dispatch replays once with the original wire payload', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const attachments = [{
    key: 'a'.repeat(64),
    mime: 'image/jpeg',
    width: 320,
    height: 240,
    bytes: 12_345,
  }];
  const queuedId = stream.enqueueTurn(STREAM_ID, 'queued photo', attachments);
  const originalRequestId = stream.getPentacleStreamState().optimisticSends?.[queuedId]?.request_id;

  socket.close();
  // The first attempt happens while the socket is closed. The readiness gate
  // records that attempt, but there is no premature wire frame to replay.
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, queuedId);
  jest.advanceTimersByTime(1000);
  const recovered = MockWebSocket.instances[1];
  recovered.open();

  const replay = sentFrames(recovered, 'send');
  expect(replay).toHaveLength(1);
  expect(replay[0]).toMatchObject({
    text: 'queued photo',
    request_id: originalRequestId,
    optimistic_id: queuedId,
    attachments,
  });

  recovered.message({ type: 'send.result', request_id: replay[0].request_id, delivery: 'landed' });
  expect(stream.getPentacleStreamState().optimisticSends?.[queuedId]?.status).toBe('acked');

  recovered.close();
  jest.advanceTimersByTime(1000);
  const later = MockWebSocket.instances[2];
  later.open();
  expect(sentFrames(later, 'send')).toHaveLength(0);

  unsubscribe();
});

test('reconnect does not forward an attachment placeholder before replacement and dispatch', () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const queuedId = stream.enqueueTurn(STREAM_ID, 'uploading photo', [{
    key: 'local:pending-photo',
    mime: 'image/jpeg',
  }]);

  socket.close();
  jest.advanceTimersByTime(1000);
  const recovered = MockWebSocket.instances[1];
  recovered.open();
  expect(sentFrames(recovered, 'send')).toHaveLength(0);

  const readyAttachment = {
    key: 'b'.repeat(64),
    mime: 'image/jpeg',
    width: 640,
    height: 480,
    bytes: 54_321,
  };
  stream.replaceOptimisticAttachments(queuedId, [readyAttachment]);
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, queuedId);
  expect(sentFrames(recovered, 'send')).toEqual([
    expect.objectContaining({
      text: 'uploading photo',
      optimistic_id: queuedId,
      attachments: [readyAttachment],
    }),
  ]);

  unsubscribe();
});

test('interruptSend issues exactly one send.interrupt frame and resolves with daemon outcome fields', async () => {
  const { stream, socket, unsubscribe } = bootStream();

  const pending = stream.interruptSend(STREAM_ID);
  const frames = sentFrames(socket, 'send.interrupt');
  expect(frames.length).toBe(1);
  expect(frames[0].host).toBe('hostc');
  expect(frames[0].session_name).toBe('chat-1');
  const requestId = frames[0].request_id as string;
  expect(requestId).toBeTruthy();

  socket.message({
    type: 'send.interrupt.ok',
    request_id: requestId,
    interrupted: true,
    landed: false,
    confirm: 'interrupt_unconfirmed',
    coalesced: false,
  });
  await expect(pending).resolves.toEqual({
    interrupted: true,
    landed: false,
    confirm: 'interrupt_unconfirmed',
    coalesced: false,
  });

  unsubscribe();
});

test('FEAT-SEND-NO-FALSE-FAILED: a dispatched queued send stays dispatched (not falsely failed) when its RPC timeout closes the silent generation, awaiting §A reconnect replay', async () => {
  const { stream, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const q1 = stream.enqueueTurn(STREAM_ID, 'queued one');
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, q1);
  expect(stream.getPentacleStreamState().optimisticSends?.[q1]?.status).toBe('dispatched');

  jest.advanceTimersByTime(30_000);
  await Promise.resolve();
  await Promise.resolve();

  // §A: the RPC-timeout transport-cut (same daemon) leaves the ambiguous survivor 'dispatched',
  // NOT falsely 'failed'; it stays eligible for a single auto-replay on the next reconnect
  // generation (FEAT-SEND-NO-FALSE-FAILED intent re-anchored to §A).
  const send = stream.getPentacleStreamState().optimisticSends?.[q1];
  expect(send).toBeDefined();
  expect(send).toMatchObject({
    status: 'dispatched',
  });
  unsubscribe();
});

// Steer now: one guarded Escape before the message, first dispatch of an agent-chat send only.
test('Steer now sends urgent directly with a plain row; queued, retried and replayed sends never carry it', async () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');

  // A steer row is a plain optimistic row: not queued, no queued marker, active turn untouched.
  const steerId = stream.enqueueTurn(STREAM_ID, 'steer text', undefined, undefined, { steer: true });
  const steerRow = stream.getPentacleStreamState().optimisticSends?.[steerId];
  expect(steerRow?.queued_at).toBeUndefined();
  expect(steerRow?.turn_queued).toBeFalsy();
  expect(stream.getPentacleStreamState().workingByStream?.[STREAM_ID]?.phase).toBe('pending');

  const sent = stream.sendPentacleMessage({
    host: 'hostc', sessionName: 'chat-1', text: 'steer text', optimisticId: steerId, urgent: true,
  });
  const steerFrame = sentFrames(socket, 'send').at(-1)!;
  expect(steerFrame).toMatchObject({ text: 'steer text', optimistic_id: steerId, urgent: true });
  socket.message({ type: 'send.result', request_id: steerFrame.request_id, delivery: 'landed' });
  await expect(sent).resolves.toBe(true);
  expect(stream.takeSteerNotTaken(steerId)).toBe(false);

  // A queued send through the held dispatcher has no urgent.
  const queuedId = stream.enqueueTurn(STREAM_ID, 'queued text');
  stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, queuedId);
  expect('urgent' in sentFrames(socket, 'send').at(-1)!).toBe(false);

  // A failed steer retried through the held path is an ordinary send.
  stream.markOptimisticFailed(steerId, 'retryable');
  const retry = stream.retryOptimisticSend(steerId);
  const retryFrame = sentFrames(socket, 'send').at(-1)!;
  expect(retryFrame.optimistic_id).toBe(steerId);
  expect('urgent' in retryFrame).toBe(false);
  socket.message({ type: 'send.result', request_id: retryFrame.request_id, delivery: 'landed' });
  await retry;
  unsubscribe();
});

test('a steer whose receipt still says provider_queued is reported once as not taken', async () => {
  const { stream, socket, unsubscribe } = bootStream();
  stream.sendTurn(STREAM_ID, 'active');
  const steerId = stream.enqueueTurn(STREAM_ID, 'steer text', undefined, undefined, { steer: true });
  const sent = stream.sendPentacleMessage({
    host: 'hostc', sessionName: 'chat-1', text: 'steer text', optimisticId: steerId, urgent: true,
  });
  const frame = sentFrames(socket, 'send').at(-1)!;
  socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed', provider_queued: true });
  await sent;
  expect(stream.takeSteerNotTaken(steerId)).toBe(true);
  expect(stream.takeSteerNotTaken(steerId)).toBe(false);
  unsubscribe();
});

test('an ordinary send never reports a steer outcome and the composite payload never carries urgent', async () => {
  const stream = loadStream();
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'session.inventory', sessions: [
    session(STREAM_ID),
    { ...session('alpha:assistant', { provider: 'composite' }), session_kind: 'assistant_composite', visibility: 'visible' },
  ] });

  const ordinaryId = stream.enqueueTurn(STREAM_ID, 'plain');
  stream.sendPentacleMessage({ host: 'hostc', sessionName: 'chat-1', text: 'plain', optimisticId: ordinaryId }).catch(() => undefined);
  expect('urgent' in sentFrames(socket, 'send').at(-1)!).toBe(false);
  expect(stream.takeSteerNotTaken(ordinaryId)).toBe(false);

  const compositeId = stream.sendTurn('alpha:assistant', 'to the composite');
  stream.sendPentacleMessage({
    host: 'alpha', sessionName: 'assistant', text: 'to the composite', optimisticId: compositeId, urgent: true,
  }).catch(() => undefined);
  const compositeFrame = sentFrames(socket, 'send').at(-1)!;
  expect(compositeFrame.msg_id).toBe(compositeId);
  expect('urgent' in compositeFrame).toBe(false);
  unsubscribe();
});

// Exact new contract through real mobile service/reducer and counterpart WS.
function bootGeneration(generation: string | undefined = 'g1') {
  const env = bootStream();
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: generation })] });
  return env;
}
function queueReceipt(env: ReturnType<typeof bootGeneration>, text = 'same', queued = true) {
  const id = env.stream.enqueueTurn(STREAM_ID, text);
  env.stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, id);
  const frame = sentFrames(env.socket, 'send').at(-1)!;
  env.socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed', ...(queued ? { provider_queued: true } : {}) });
  return { id, frame };
}
function interruptReply(env: ReturnType<typeof bootGeneration>, confirm = 'interrupt_unconfirmed') {
  const frame = sentFrames(env.socket, 'send.interrupt').at(-1)!;
  env.socket.message({ type: 'send.interrupt.ok', request_id: frame.request_id, interrupted: confirm === 'interrupt_unconfirmed', landed: false, confirm, coalesced: false });
}
function caption(env: ReturnType<typeof bootGeneration>, id: string) {
  return require('pentacle-chat-core').selectSessionDetail(env.stream.getPentacleStreamState(), STREAM_ID, { visibleCount: 'all' }).transcriptItems.find((item: any) => item.optimisticId === id)?.receiptCaption;
}

test('Send now uses one generation-fenced Escape across two rows, double taps and Stop, without replay', async () => {
  const env = bootGeneration();
  const one = queueReceipt(env); const two = queueReceipt(env);
  const before = env.stream.getPentacleStreamState().optimisticSends;
  const originalSends = sentFrames(env.socket, 'send');
  expect(env.stream.canSendQueuedNow(STREAM_ID, one.id)).toBe(true);
  const first = env.stream.sendQueuedNow(STREAM_ID, one.id);
  const second = env.stream.sendQueuedNow(STREAM_ID, two.id);
  const stop = env.stream.interruptSend(STREAM_ID);
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(1);
  expect(sentFrames(env.socket, 'send.interrupt')[0].expected_session_generation).toBe('g1');
  interruptReply(env);
  await Promise.all([first, second, stop]);
  expect(env.stream.getPentacleStreamState().optimisticSends).toBe(before);
  expect(sentFrames(env.socket, 'send')).toEqual(originalSends);
  expect(caption(env, one.id)).toBe('queued');
  expect(env.stream.canSendQueuedNow(STREAM_ID, two.id)).toBe(false);
  env.unsubscribe();
});

test('Stop first shares the row budget across remount, pending→working→idle churn and reconnect inventory', async () => {
  const env = bootGeneration();
  const one = queueReceipt(env);
  const stopping = env.stream.interruptSend(STREAM_ID); interruptReply(env); await stopping;
  const remount = env.stream.subscribePentacleStream(jest.fn());
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g1', working: true })] });
  endOfTurn(env.socket, 91);
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g1', working: false })] });
  await env.stream.sendQueuedNow(STREAM_ID, one.id);
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(1);
  expect(env.stream.canSendQueuedNow(STREAM_ID, one.id)).toBe(false);
  remount(); env.unsubscribe();
});

test.each(['pane_unavailable', 'not_working'])('explicit %s re-arms only a deliberate retry', async confirm => {
  const env = bootGeneration(); const row = queueReceipt(env);
  const first = env.stream.sendQueuedNow(STREAM_ID, row.id); interruptReply(env, confirm); await first;
  expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(true);
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(1);
  const retry = env.stream.sendQueuedNow(STREAM_ID, row.id); interruptReply(env); await retry;
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(2);
  expect(caption(env, row.id)).toBe('queued'); env.unsubscribe();
});

test('missing/replaced generation and composite routes cannot release another lifetime queue', async () => {
  const env = bootGeneration(''); const unknown = queueReceipt(env);
  expect(env.stream.canSendQueuedNow(STREAM_ID, unknown.id)).toBe(false);
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g1' })] });
  expect(env.stream.canSendQueuedNow(STREAM_ID, unknown.id)).toBe(false);
  const old = queueReceipt(env);
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g2' })] });
  await env.stream.sendQueuedNow(STREAM_ID, old.id);
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(0);
  const current = queueReceipt(env);
  expect(env.stream.canSendQueuedNow(STREAM_ID, current.id)).toBe(true);
  env.socket.message({ type: 'session.inventory', sessions: [{ ...session(STREAM_ID, { session_generation: 'g2' }), session_kind: 'assistant_composite' }] });
  expect(env.stream.canSendQueuedNow(STREAM_ID, current.id)).toBe(false); env.unsubscribe();
});

test('late provider receipt after accepted settlement updates Queued, durable query reason also recovers it', async () => {
  const env = bootGeneration();
  const id = env.stream.enqueueTurn(STREAM_ID, 'late'); env.stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, id);
  const frame = sentFrames(env.socket, 'send').at(-1)!;
  env.socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'proof_unavailable', state: 'accepted' });
  await Promise.resolve();
  expect(caption(env, id)).toBe('sending');
  env.socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed', provider_queued: true });
  expect(caption(env, id)).toBe('queued');
  // A late authenticated lookup survives loss of the original RPC waiter.
  env.socket.message({ type: 'send.receipt.get.ok', found: true, receipts: [{ request_id: frame.request_id, to_stream_id: STREAM_ID, state: 'landed', reason: 'coalesced_replay:prior;provider_queued' }] });
  expect(caption(env, id)).toBe('queued');
  expect(env.stream.canSendQueuedNow(STREAM_ID, id)).toBe(true); env.unsubscribe();
});

test('nonqueue landed receipt is Sent; accepted proof alone never claims Sent or Queued', () => {
  const env = bootGeneration(); const row = queueReceipt(env, 'processed', false);
  expect(caption(env, row.id)).toBe('sent'); expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(false);
  const id = env.stream.enqueueTurn(STREAM_ID, 'unknown'); env.stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, id);
  const frame = sentFrames(env.socket, 'send').at(-1)!;
  env.socket.message({ type: 'send.result', request_id: frame.request_id, state: 'accepted', delivery: 'proof_unavailable' });
  expect(caption(env, id)).toBe('sending'); env.unsubscribe();
});

test('processing evidence drains budget; old queue receipts cannot resurrect it', async () => {
  const env = bootGeneration(); const row = queueReceipt(env);
  const first = env.stream.sendQueuedNow(STREAM_ID, row.id); interruptReply(env); await first;
  env.socket.message({ type: 'send.result', request_id: row.frame.request_id, delivery: 'landed' });
  expect(caption(env, row.id)).toBe('sent');
  env.socket.message({ type: 'send.result', request_id: row.frame.request_id, delivery: 'landed', provider_queued: true });
  expect(caption(env, row.id)).toBe('sent'); expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(false); env.unsubscribe();
});

test('uncertain delivery retains truthful queue caption but disables Send now', () => {
  const env = bootGeneration(); const row = queueReceipt(env);
  env.socket.message({ type: 'send.result', request_id: row.frame.request_id, state: 'accepted', delivery: 'proof_unavailable' });
  expect(caption(env, row.id)).toBe('queued'); expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(false); env.unsubscribe();
});

test('USER echo retires the row and late queue evidence cannot recreate the action', () => {
  const env = bootGeneration(); const row = queueReceipt(env, 'echoed text');
  env.socket.message({ type: 'chat.event', event: { daemon_seq: 155, host: 'hostc', provider: 'codex', session_id: STREAM_ID, session_name: 'chat-1', stream_id: STREAM_ID, timestamp: '2026-06-17T12:00:01.000Z', kind: 'USER', text: 'echoed text', optimistic_id: row.id } });
  expect(env.stream.getPentacleStreamState().optimisticSends?.[row.id]).toBeUndefined();
  env.socket.message({ type: 'send.result', request_id: row.frame.request_id, delivery: 'landed', provider_queued: true });
  expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(false); env.unsubscribe();
});

test('a failed row cannot be resurrected as queued by a late receipt', () => {
  const env = bootGeneration(); const row = queueReceipt(env);
  env.stream.markOptimisticFailed(row.id, 'terminal');
  env.socket.message({ type: 'send.result', request_id: row.frame.request_id, delivery: 'landed', provider_queued: true });
  expect(caption(env, row.id)).not.toBe('queued');
  expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(false); env.unsubscribe();
});

test('stale generation receipt cannot introduce new queue proof or an action', () => {
  const env = bootGeneration();
  const id = env.stream.enqueueTurn(STREAM_ID, 'old target'); env.stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, id);
  const frame = sentFrames(env.socket, 'send').at(-1)!;
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g2' })] });
  env.socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed', provider_queued: true });
  expect(caption(env, id)).not.toBe('queued'); expect(env.stream.canSendQueuedNow(STREAM_ID, id)).toBe(false); env.unsubscribe();
});

test('new generation cannot inherit old queue Escape consumption', async () => {
  const env = bootGeneration(); const old = queueReceipt(env);
  const first = env.stream.sendQueuedNow(STREAM_ID, old.id); interruptReply(env); await first;
  env.socket.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g2' })] });
  const current = queueReceipt(env);
  expect(env.stream.canSendQueuedNow(STREAM_ID, current.id)).toBe(true);
  const next = env.stream.sendQueuedNow(STREAM_ID, current.id); interruptReply(env); await next;
  expect(sentFrames(env.socket, 'send.interrupt').map(x => x.expected_session_generation)).toEqual(['g1', 'g2']); env.unsubscribe();
});

test('explicit retry retains logical identity and can acquire fresh queue proof for its new attempt', async () => {
  const env = bootGeneration(); const row = queueReceipt(env, 'retry queue', false);
  env.stream.markOptimisticFailed(row.id, 'terminal');
  const retry = env.stream.retryOptimisticSend(row.id);
  const next = sentFrames(env.socket, 'send').at(-1)!;
  expect(next.optimistic_id).toBe(row.id); expect(next.request_id).not.toBe(row.frame.request_id);
  env.socket.message({ type: 'send.result', request_id: next.request_id, delivery: 'landed', provider_queued: true });
  await retry;
  expect(caption(env, row.id)).toBe('queued'); expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(true); env.unsubscribe();
});

test('queued attachment payload and original request remain byte-equivalent across Send now', async () => {
  const env = bootGeneration();
  const attachments = [{ key: 'owned-test-image', mime: 'image/jpeg', width: 1, height: 1 }];
  const id = env.stream.enqueueTurn(STREAM_ID, 'caption', attachments);
  env.stream.dispatchQueuedSendsByOptimisticId(STREAM_ID, id);
  const frame = sentFrames(env.socket, 'send').at(-1)!;
  env.socket.message({ type: 'send.result', request_id: frame.request_id, delivery: 'landed', provider_queued: true });
  const before = env.stream.getPentacleStreamState().optimisticSends?.[id];
  const sends = sentFrames(env.socket, 'send');
  const release = env.stream.sendQueuedNow(STREAM_ID, id); interruptReply(env); await release;
  expect(env.stream.getPentacleStreamState().optimisticSends?.[id]).toBe(before);
  expect(before?.attachments).toEqual(attachments);
  expect(sentFrames(env.socket, 'send')).toEqual(sends);
  env.unsubscribe();
});

test('in-flight Escape plus disconnect retains one native-queue budget through reconnect', async () => {
  const env = bootGeneration(); const row = queueReceipt(env);
  const attempt = env.stream.sendQueuedNow(STREAM_ID, row.id).catch(error => error.message);
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(1);
  env.socket.close(); await attempt;
  jest.advanceTimersByTime(1000);
  const recovered = MockWebSocket.instances[1];
  expect(recovered).toBeDefined(); recovered.open();
  recovered.message({ type: 'session.inventory', sessions: [session(STREAM_ID, { session_generation: 'g1' })] });
  recovered.message({ type: 'send.result', request_id: row.frame.request_id, delivery: 'landed', provider_queued: true });
  expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(false);
  await env.stream.sendQueuedNow(STREAM_ID, row.id);
  await env.stream.interruptSend(STREAM_ID);
  expect(sentFrames(env.socket, 'send.interrupt').length + sentFrames(recovered, 'send.interrupt').length).toBe(1);
  expect(caption(env, row.id)).toBe('queued'); env.unsubscribe();
});

test('provable pre-dispatch offline rejection permits one deliberate retry without an extra Escape', async () => {
  const env = bootGeneration(); const row = queueReceipt(env);
  env.socket.readyState = MockWebSocket.CLOSED;
  await expect(env.stream.sendQueuedNow(STREAM_ID, row.id)).rejects.toThrow('Pentacle stream is not connected');
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(0);
  env.socket.readyState = MockWebSocket.OPEN;
  expect(env.stream.canSendQueuedNow(STREAM_ID, row.id)).toBe(true);
  const attempt = env.stream.sendQueuedNow(STREAM_ID, row.id); interruptReply(env); await attempt;
  expect(sentFrames(env.socket, 'send.interrupt')).toHaveLength(1); env.unsubscribe();
});
