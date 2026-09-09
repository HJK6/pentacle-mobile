import {
  applySnapshotWithOptimisticReconciliation,
  initialPentacleStreamState,
  markOptimisticAckedByRequestId,
  markOptimisticCancelledByRequestId,
  markOptimisticDispatchedByRequestId,
  markOptimisticFailedByOptimisticId,
  markOptimisticIndeterminateByRequestId,
  reconcileOptimisticSendWithServerEvent,
  selectSessionDetail,
  sendOptimisticMessage,
} from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const STREAM_ID = 'hostc:codex:one';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_one_1';
const REQUEST_ID = 'send-req-1';
const CREATED_AT = Date.parse('2026-05-16T12:00:00.000Z');

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    last_event_at: '2026-05-16T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return {
    ...initialPentacleStreamState,
    sessions: [session()],
    connected: true,
    ...overrides,
  };
}

function createOptimistic(state = buildState()) {
  return sendOptimisticMessage(state, {
    streamId: STREAM_ID,
    text: 'hello',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
  });
}

function serverUserEvent(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 42,
    host: 'hostc',
    provider: 'codex',
    session_id: STREAM_ID,
    session_name: 'one',
    stream_id: STREAM_ID,
    timestamp: '2026-05-16T12:00:01.000Z',
    kind: 'USER',
    text: 'hello',
    ...overrides,
  };
}

test('sendOptimisticMessage atomically creates row, secondary request index, client event, and pending turn', () => {
  const next = createOptimistic();

  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    optimistic_id: OPTIMISTIC_ID,
    request_id: REQUEST_ID,
    stream_id: STREAM_ID,
    text: 'hello',
    status: 'queued',
    created_at: CREATED_AT,
    reconnect_count: 0,
  });
  expect(next.optimisticByRequestId?.[REQUEST_ID]).toBe(OPTIMISTIC_ID);
  expect(next.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)).toMatchObject({
    kind: 'USER',
    text: 'hello',
    client_origin: true,
    pending: true,
  });
  expect(next.workingByStream?.[STREAM_ID]).toMatchObject({
    phase: 'pending',
    optimisticId: OPTIMISTIC_ID,
    sentAt: CREATED_AT,
  });
});

test('normal lifecycle transitions queued to dispatched to acked to echoed/reconciled', () => {
  const queued = createOptimistic();
  const dispatched = markOptimisticDispatchedByRequestId(queued, REQUEST_ID, CREATED_AT + 10);
  expect(dispatched.optimisticSends?.[OPTIMISTIC_ID]?.status).toBe('dispatched');

  const acked = markOptimisticAckedByRequestId(dispatched, REQUEST_ID, CREATED_AT + 20);
  expect(acked.optimisticSends?.[OPTIMISTIC_ID]?.status).toBe('acked');

  const reconciled = reconcileOptimisticSendWithServerEvent(acked, OPTIMISTIC_ID, serverUserEvent());
  expect(reconciled.optimisticSends?.[OPTIMISTIC_ID]).toBeUndefined();
  expect(reconciled.optimisticByRequestId?.[REQUEST_ID]).toBeUndefined();
  expect(reconciled.events).toHaveLength(1);
  expect(reconciled.events[0]).toMatchObject({
    daemon_seq: Number.NaN,
    correlatedDaemonSeq: 42,
    optimistic_id: OPTIMISTIC_ID,
    pending: false,
    text: 'hello',
  });
});

test('send.indeterminate does not fail the optimistic row and can still reconcile on echo', () => {
  const dispatched = markOptimisticDispatchedByRequestId(createOptimistic(), REQUEST_ID, CREATED_AT + 10);
  const indeterminate = markOptimisticIndeterminateByRequestId(dispatched, REQUEST_ID, CREATED_AT + 30);

  expect(indeterminate.optimisticSends?.[OPTIMISTIC_ID]?.status).toBe('indeterminate');
  expect(indeterminate.optimisticSends?.[OPTIMISTIC_ID]?.failure_reason).toBeUndefined();
  expect(indeterminate.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(true);

  const reconciled = reconcileOptimisticSendWithServerEvent(indeterminate, OPTIMISTIC_ID, serverUserEvent());
  expect(reconciled.optimisticSends?.[OPTIMISTIC_ID]).toBeUndefined();
  expect(reconciled.events).toHaveLength(1);
  expect(reconciled.events[0]).toMatchObject({
    correlatedDaemonSeq: 42,
    optimistic_id: OPTIMISTIC_ID,
    text: 'hello',
  });
});

test('cancel trigger marks the send cancelled and surfaces sendState=cancelled (not a sent bubble)', () => {
  // Mirrors the stream client wiring: the daemon's send.result
  // {delivery:'not_landed', reason:'caller_cancelled'} resolves the request id
  // to the optimistic id and marks it cancelled.
  const dispatched = markOptimisticDispatchedByRequestId(createOptimistic(), REQUEST_ID, CREATED_AT + 10);
  const canceled = markOptimisticCancelledByRequestId(dispatched, REQUEST_ID, CREATED_AT + 40);

  expect(canceled.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status: 'cancelled',
    failure_reason: 'cancelled',
    failed_at: CREATED_AT + 40,
    turn_queued: false,
  });
  expect(canceled.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(false);

  const detail = selectSessionDetail(canceled, STREAM_ID, { visibleCount: 'all', emitRenderTelemetry: false });
  const row = detail?.transcriptItems.find((item) => item.optimisticId === OPTIMISTIC_ID);
  // A cancelled send must report sendState 'cancelled' (NOT undefined, which the
  // view renders as an ordinary "sent" bubble).
  expect(row?.sendState).toBe('cancelled');
});

test('a cancelled optimistic send does NOT reconcile to a later same-text server user echo (no resurrection as sent)', () => {
  const dispatched = markOptimisticDispatchedByRequestId(createOptimistic(), REQUEST_ID, CREATED_AT + 10);
  const canceled = markOptimisticCancelledByRequestId(dispatched, REQUEST_ID, CREATED_AT + 40);

  // A snapshot later carries a same-text server USER row (e.g. the user retyped
  // and sent again). The cancelled send must not silently absorb it and flip to
  // a delivered ("sent") row.
  const next = applySnapshotWithOptimisticReconciliation(
    canceled,
    { sessions: [session()], events: [serverUserEvent({ daemon_seq: 99, timestamp: '2026-05-16T12:00:05.000Z' })] },
    CREATED_AT + 5_000,
  );

  // The cancelled send is preserved (terminal), not pruned by reconcile.
  expect(next.optimisticSends?.[OPTIMISTIC_ID]?.status).toBe('cancelled');

  const detail = selectSessionDetail(next, STREAM_ID, { visibleCount: 'all', emitRenderTelemetry: false });
  const canceledRow = detail?.transcriptItems.find((item) => item.optimisticId === OPTIMISTIC_ID);
  expect(canceledRow?.sendState).toBe('cancelled');

  // The server echo stays its own server-origin row — it never became the
  // cancelled send's "sent" reconciliation.
  const serverRow = next.events.find((event) => Number(event.daemon_seq) === 99);
  expect(serverRow?.optimistic_id).toBeUndefined();
});

test('failed transition marks the reducer row failed without clearing the pending turn phase', () => {
  const dispatched = markOptimisticDispatchedByRequestId(createOptimistic(), REQUEST_ID, CREATED_AT + 10);
  const failed = markOptimisticFailedByOptimisticId(dispatched, OPTIMISTIC_ID, 'reconcile_timeout', CREATED_AT + 60_000);

  expect(failed.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
    status: 'failed',
    failure_reason: 'reconcile_timeout',
    failed_at: CREATED_AT + 60_000,
  });
  expect(failed.events.find((event) => event.optimistic_id === OPTIMISTIC_ID)?.pending).toBe(false);
  expect(failed.workingByStream?.[STREAM_ID]?.phase).toBe('pending');
});
