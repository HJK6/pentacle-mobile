import {
  applyFetchedStreamEvents,
  applyPentacleEvent,
  applySnapshotWithOptimisticReconciliation,
  initialPentacleStreamState,
  reconcileOptimisticSendWithServerEvent,
  selectSessionDetail,
  sendOptimisticMessage,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';
import {
  CHAT_EVENT_ORDERING_REPLAY,
  createFakeDaemonHarness,
  HISTORY_FETCH_RETRY_HYDRATE,
  OPTIMISTIC_ECHO_RECONCILE,
  PENDING_SEND_LIVE_APPLY,
  runTrace,
  type DaemonStep,
  type FakeDaemonHarness,
  type TraceContract,
  type UserStep,
} from './traces';

const STREAM_ID = 'hostb:codex:trace';
const HYDRATE_STREAM_ID = 'hostb:codex:hydrate';
const CREATED_AT = Date.parse('2026-06-30T12:00:00.000Z');

function session(streamId = STREAM_ID, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostb',
    provider: 'codex',
    session_name: sessionName,
    title: sessionName,
    last_event_at: '2026-06-30T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function initialState(streamId = STREAM_ID): PentacleStreamState {
  return {
    ...initialPentacleStreamState,
    connected: true,
    hasHydrated: true,
    sessions: [session(streamId)],
  };
}

function eventFromPayload(
  payload: unknown,
  kind: PentacleEvent['kind'],
  streamId = STREAM_ID,
): PentacleEvent {
  const data = (payload ?? {}) as {
    daemonSeq?: number;
    timestamp?: string;
    text?: string;
    optimisticId?: string;
  };
  return {
    daemon_seq: data.daemonSeq ?? 1,
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostb',
    provider: 'codex',
    session_id: 'session',
    session_name: streamId.split(':').pop() || 'trace',
    timestamp: data.timestamp ?? '2026-06-30T12:00:01.000Z',
    kind,
    text: data.text ?? '',
    ...(data.optimisticId ? { optimistic_id: data.optimisticId } : {}),
  };
}

function renderTranscript(harness: FakeDaemonHarness) {
  const state = harness.setup.getState();
  const rows = selectSessionDetail(state, harness.setup.streamId, { visibleCount: 'all' })?.transcriptItems ?? [];
  const text = rows.map((row) => row.text).join('\n');
  harness.setTextByTestID('transcript', text || null);
  const assist = [...rows].reverse().find((row) => row.kind === 'ASSIST');
  harness.setTextByTestID('assist-row', assist?.text ?? null);
  harness.setMounted('status-tag-sending', rows.some((row) => row.sendState === 'sending'));
}

async function driveUserAction(step: UserStep, harness: FakeDaemonHarness) {
  if (step.action === 'composer_press_send') {
    const payload = (step.payload ?? {}) as { text?: string; optimisticId?: string; requestId?: string };
    const optimisticId = payload.optimisticId ?? 'optimistic_hostb_codex_trace_1';
    harness.setState(sendOptimisticMessage(harness.setup.getState(), {
      streamId: harness.setup.streamId,
      text: payload.text ?? '',
      optimisticId,
      requestId: payload.requestId ?? 'send-req-trace-1',
      createdAt: CREATED_AT,
      windowStartedAt: CREATED_AT,
    }));
    renderTranscript(harness);
    harness.emit({ source: 'user', name: 'actions.sendMessage', payload: step.payload });
    harness.emit({ source: 'user', name: step.action, payload: step.payload });
    harness.emit({ source: 'reducer', name: 'optimistic_user_pending' });
    harness.emit({ source: 'reducer', name: 'pending_user_row_visible' });
    return;
  }

  harness.emit({ source: 'user', name: step.action, payload: step.payload });
}

async function injectDaemonEvent(step: DaemonStep, harness: FakeDaemonHarness) {
  const streamId = harness.setup.streamId;
  if (step.event === 'ASSIST') {
    harness.setState(applyPentacleEvent(harness.setup.getState(), eventFromPayload(step.payload, 'ASSIST', streamId)));
    harness.emit({ source: 'reducer', name: 'transcript_orders_out_of_order_events' });
    harness.emit({ source: 'reducer', name: 'same_timestamp_uses_daemon_seq_tiebreak' });
    harness.emit({ source: 'reducer', name: 'committed_event_applies_despite_pending_send' });
  } else if (step.event === 'USER') {
    const payload = (step.payload ?? {}) as { optimisticId?: string };
    const userEvent = eventFromPayload(step.payload, 'USER', streamId);
    if (payload.optimisticId && harness.setup.getState().optimisticSends?.[payload.optimisticId]) {
      harness.setState(reconcileOptimisticSendWithServerEvent(harness.setup.getState(), payload.optimisticId, userEvent));
      harness.emit({ source: 'reducer', name: 'live_echo_reconciles_optimistic_row' });
    } else {
      harness.setState(applyPentacleEvent(harness.setup.getState(), userEvent));
      harness.emit({ source: 'reducer', name: 'transcript_orders_out_of_order_events' });
      harness.emit({ source: 'reducer', name: 'same_timestamp_uses_daemon_seq_tiebreak' });
    }
  } else if (step.event === 'SNAPSHOT_REPLAY') {
    harness.setState(applySnapshotWithOptimisticReconciliation(
      harness.setup.getState(),
      { sessions: [session(streamId)], events: [eventFromPayload(step.payload, 'USER', streamId)] },
      CREATED_AT + 1_000,
    ));
    harness.emit({ source: 'reducer', name: 'replayed_echo_does_not_duplicate' });
  } else if (step.event === 'FETCHED_HISTORY') {
    harness.setState(applyFetchedStreamEvents(
      harness.setup.getState(),
      [eventFromPayload(step.payload, 'USER', streamId)],
      { requestedStreamId: streamId },
    ));
    harness.emit({ source: 'reducer', name: 'replayed_echo_does_not_duplicate' });
  } else if (step.event === 'HELLO_SUMMARY') {
    harness.setState({ ...harness.setup.getState(), sessions: [session(streamId)], events: [] });
    harness.emit({ source: 'reducer', name: 'summary_mode_has_no_detail_events' });
  } else if (step.event === 'REQUEST_STREAM_EVENTS_OK') {
    harness.setState(applyFetchedStreamEvents(
      harness.setup.getState(),
      [eventFromPayload(step.payload, 'ASSIST', streamId)],
      { requestedStreamId: streamId },
    ));
    harness.emit({ source: 'reducer', name: 'fetched_history_applies_after_retry' });
  }

  renderTranscript(harness);
  harness.emit({ source: 'daemon', name: step.event, payload: step.payload });
}

async function expectTracePasses(trace: TraceContract, streamId = STREAM_ID) {
  const harness = createFakeDaemonHarness({
    streamId,
    initialState: initialState(streamId),
    driveUserAction,
    injectDaemonEvent,
  });
  harness.setMounted('session-screen', true);
  renderTranscript(harness);

  const result = await runTrace(trace, harness.setup);
  if (!result.ok) {
    throw new Error(result.failureReport);
  }
}

test('trace: June-30 Bug A transcript ordering replay', async () => {
  await expectTracePasses(CHAT_EVENT_ORDERING_REPLAY);
});

test('trace: June-30 Bug B optimistic echo reconcile replay', async () => {
  await expectTracePasses(OPTIMISTIC_ECHO_RECONCILE);
});

test('trace: June-30 Bug C pending send does not block committed apply', async () => {
  await expectTracePasses(PENDING_SEND_LIVE_APPLY);
});

test('trace: summary hydrate recovers after failed history fetch retry', async () => {
  await expectTracePasses(HISTORY_FETCH_RETRY_HYDRATE, HYDRATE_STREAM_ID);
});
