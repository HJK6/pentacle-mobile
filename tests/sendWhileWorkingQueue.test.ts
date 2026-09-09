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

test('release gate: delayed composite echo reconciles two identical native-queue sends after screen remount', async () => {
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
    { queuedWhileWorking: true, sendState: undefined },
    { queuedWhileWorking: true, sendState: undefined },
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
      text: 'same queued text\n\nsame queued text',
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
    { optimisticId: firstId, queuedWhileWorking: true, sendState: undefined, correlatedDaemonSeq: 91 },
    { optimisticId: secondId, queuedWhileWorking: true, sendState: undefined, correlatedDaemonSeq: 91 },
  ]);

  remountUnsubscribe();
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
