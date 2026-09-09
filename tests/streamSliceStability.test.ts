jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

import {
  applyPentacleEvent,
  applyFetchedStreamEvents,
  applyPentacleSnapshotMessage,
  applyNotificationFrame,
  applyPentacleSessionSummary,
  initialPentacleStreamState,
  reconcileOptimisticSendWithServerEvent,
  selectChatList,
  sendOptimisticMessage,
  selectSessionDetail,
} from 'pentacle-chat-core';
import { selectStreamSlice } from '../src/services/pentacleStream';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState, WorkingStateData } from 'pentacle-chat-core';

const STREAM_A = 'hostc:codex:a';
const STREAM_B = 'hostc:codex:b';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_a_1';
const REQUEST_ID = 'send-req-1';
const CREATED_AT = Date.parse('2026-05-27T12:00:00.000Z');

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: sessionName,
    last_event_at: '2026-05-27T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function event(streamId: string, daemonSeq: number, overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  const sessionName = streamId.split(':').pop() || streamId;
  return {
    daemon_seq: daemonSeq,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp: `2026-05-27T12:00:${String(daemonSeq).padStart(2, '0')}.000Z`,
    kind: 'ASSIST',
    text: `event ${daemonSeq}`,
    ...overrides,
  };
}

function workingState(streamId: string, overrides: Partial<WorkingStateData> = {}): WorkingStateData {
  return {
    stream_id: streamId,
    timestamp: '2026-05-27T12:00:00.000Z',
    tokens_input: 10,
    tokens_output: 20,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'down',
    shell_count_started: 1,
    tasks: [],
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 1000,
    ...overrides,
  };
}

function buildState(): PentacleStreamState {
  const base: PentacleStreamState = { ...initialPentacleStreamState, connected: true, hasHydrated: true };
  return [session(STREAM_A), session(STREAM_B)].reduce<PentacleStreamState>(
    (state, item) => applyPentacleSessionSummary(state, item),
    base,
  );
}

test('selectStreamSlice returns the same reference for unrelated-stream events and a new reference for its own stream', () => {
  const stateOne = applyPentacleEvent(buildState(), event(STREAM_A, 1, { text: 'alpha' }));
  const sliceOne = selectStreamSlice(stateOne, STREAM_A, { visibleCount: 'all', includeDraft: false });

  const stateAfterB = applyPentacleEvent(stateOne, event(STREAM_B, 2, { text: 'beta' }));
  const sliceAfterB = selectStreamSlice(stateAfterB, STREAM_A, { visibleCount: 'all', includeDraft: false });
  expect(sliceAfterB).toBe(sliceOne);

  const stateAfterA = applyPentacleEvent(stateAfterB, event(STREAM_A, 3, { text: 'alpha follow-up' }));
  const sliceAfterA = selectStreamSlice(stateAfterA, STREAM_A, { visibleCount: 'all', includeDraft: false });
  expect(sliceAfterA).not.toBe(sliceOne);
});

test('selectStreamSlice refreshes when session status-card fields change', () => {
  const stateOne = buildState();
  const sliceOne = selectStreamSlice(stateOne, STREAM_A, { visibleCount: 'all', includeDraft: false });

  const stateAfterStatus = applyPentacleSessionSummary(stateOne, session(STREAM_A, {
    status_card: {
      goal: 'Keep detail header current',
      updated_at: '2026-05-27T12:05:00.000Z',
    },
    context_tokens: 97000,
    model_context_window: 200000,
    context_level: 'advisory',
    spec_issues: [{ obligation_id: 'ob-1', detail: 'selector missed status card' }],
  }));
  const sliceAfterStatus = selectStreamSlice(stateAfterStatus, STREAM_A, { visibleCount: 'all', includeDraft: false });

  expect(sliceAfterStatus).not.toBe(sliceOne);
  expect(sliceAfterStatus.session?.status_card?.goal).toBe('Keep detail header current');
  expect(sliceAfterStatus.session?.context_tokens).toBe(97000);
  expect(sliceAfterStatus.session?.spec_issues?.[0]?.detail).toBe('selector missed status card');
});

test('selectStreamSlice keeps its reference for unrelated-stream tail refetches', () => {
  const stateOne = applyPentacleEvent(buildState(), event(STREAM_A, 1, { text: 'alpha' }));
  const sliceOne = selectStreamSlice(stateOne, STREAM_A, { visibleCount: 'all', includeDraft: false });

  const stateAfterBRefetch = applyFetchedStreamEvents(stateOne, [
    event(STREAM_B, 101, { text: 'beta tail one' }),
    event(STREAM_B, 102, { text: 'beta tail two' }),
  ]);
  const sliceAfterBRefetch = selectStreamSlice(
    stateAfterBRefetch,
    STREAM_A,
    { visibleCount: 'all', includeDraft: false },
  );

  expect(sliceAfterBRefetch).toBe(sliceOne);
});

test('selectStreamSlice advances immediately for later committed events while an optimistic send is pending', () => {
  const optimistic = sendOptimisticMessage(buildState(), {
    streamId: STREAM_A,
    text: 'pending user send',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
  });
  const sliceWithPending = selectStreamSlice(optimistic, STREAM_A, { visibleCount: 'all', includeDraft: false });
  expect(sliceWithPending.detail?.transcriptItems.map((item) => item.text)).toContain('pending user send');

  const withLaterCommitted = applyPentacleEvent(
    optimistic,
    event(STREAM_A, 33, { kind: 'ASSIST', text: 'committed assistant update' }),
  );
  const sliceAfterCommitted = selectStreamSlice(withLaterCommitted, STREAM_A, { visibleCount: 'all', includeDraft: false });

  expect(sliceAfterCommitted).not.toBe(sliceWithPending);
  expect(sliceAfterCommitted.detail).not.toBe(sliceWithPending.detail);
  expect(sliceAfterCommitted.detail?.transcriptItems.map((item) => item.text)).toEqual([
    'pending user send',
    'committed assistant update',
  ]);
});

test('selectStreamSlice keeps its reference for value-equal snapshot working state on unrelated streams', () => {
  const stateOne = applyPentacleSnapshotMessage(buildState(), {
    sessions: [session(STREAM_A), session(STREAM_B)],
    events: [event(STREAM_A, 1, { text: 'alpha' })],
    working_states: {
      [STREAM_A]: workingState(STREAM_A),
      [STREAM_B]: workingState(STREAM_B),
    },
  });
  const sliceOne = selectStreamSlice(stateOne, STREAM_A, { visibleCount: 'all', includeDraft: false });

  const stateAfterBWorkingChange = applyPentacleSnapshotMessage(stateOne, {
    sessions: [session(STREAM_A), session(STREAM_B)],
    events: stateOne.events,
    working_states: {
      [STREAM_A]: workingState(STREAM_A),
      [STREAM_B]: workingState(STREAM_B, { tokens_output: 21 }),
    },
  });
  const sliceAfterBWorkingChange = selectStreamSlice(
    stateAfterBWorkingChange,
    STREAM_A,
    { visibleCount: 'all', includeDraft: false },
  );
  expect(sliceAfterBWorkingChange).toBe(sliceOne);

  const stateAfterAWorkingChange = applyPentacleSnapshotMessage(stateAfterBWorkingChange, {
    sessions: [session(STREAM_A), session(STREAM_B)],
    events: stateAfterBWorkingChange.events,
    working_states: {
      [STREAM_A]: workingState(STREAM_A, { tokens_output: 22 }),
      [STREAM_B]: workingState(STREAM_B, { tokens_output: 21 }),
    },
  });
  const sliceAfterAWorkingChange = selectStreamSlice(
    stateAfterAWorkingChange,
    STREAM_A,
    { visibleCount: 'all', includeDraft: false },
  );
  expect(sliceAfterAWorkingChange).not.toBe(sliceOne);
});

test('optimistic reconcile keeps the optimistic row id stable and does not leave an orphan', () => {
  const optimistic = sendOptimisticMessage(buildState(), {
    streamId: STREAM_A,
    text: 'match me',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
  });
  const before = selectSessionDetail(optimistic, STREAM_A, { visibleCount: 'all' });
  expect(before?.transcriptItems.map((item) => item.id)).toEqual([OPTIMISTIC_ID]);

  const reconciled = reconcileOptimisticSendWithServerEvent(
    optimistic,
    OPTIMISTIC_ID,
    event(STREAM_A, 42, { kind: 'USER', text: 'match me' }),
  );
  const after = selectSessionDetail(reconciled, STREAM_A, { visibleCount: 'all' });
  const rowsForSend = after?.transcriptItems.filter((item) => item.text === 'match me') || [];

  expect(rowsForSend).toHaveLength(1);
  expect(rowsForSend[0]).toMatchObject({
    id: OPTIMISTIC_ID,
    optimisticId: OPTIMISTIC_ID,
    correlatedDaemonSeq: 42,
  });
});

test('selectStreamSlice exposes a returned draft after late returned-to-prompt reclassification', () => {
  const optimistic = sendOptimisticMessage(buildState(), {
    streamId: STREAM_A,
    text: 'match me',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
  });
  const reconciled = reconcileOptimisticSendWithServerEvent(
    optimistic,
    OPTIMISTIC_ID,
    event(STREAM_A, 42, {
      kind: 'USER',
      text: 'match me',
      raw: { jsonl_record_uuid: 'jsonl-user-u' },
    }),
  );

  const reclassified = applyPentacleEvent(
    reconciled,
    event(STREAM_A, 43, {
      kind: 'USER',
      text: 'match me',
      raw: {
        jsonl_record_uuid: 'jsonl-user-u',
        returned_to_prompt: true,
        user_delivery_state: 'returned_to_prompt',
      },
    }),
  );
  const slice = selectStreamSlice(reclassified, STREAM_A, { visibleCount: 'all', includeDraft: false });

  expect(slice.detail?.transcriptItems).toHaveLength(0);
  expect(slice.returnedToPromptDraft).toEqual({
    optimisticId: OPTIMISTIC_ID,
    text: 'match me',
  });
});

test('wide chat-list and notification slices still update from firehose reducers', () => {
  const stateOne = buildState();
  const chatsOne = selectChatList(stateOne, 'all');

  const stateAfterEvent = applyPentacleEvent(stateOne, event(STREAM_B, 11, { kind: 'ASSIST', text: 'wide update' }));
  const chatsAfterEvent = selectChatList(stateAfterEvent, 'all');
  expect(chatsAfterEvent).not.toBe(chatsOne);
  expect(chatsAfterEvent.find((item) => item.streamId === STREAM_B)?.previewText).toBe('wide update');

  const stateAfterNotification = applyNotificationFrame(stateAfterEvent, {
    notification_id: 'n-1',
    created_at: '2026-05-27T12:00:00.000Z',
    updated_at: '2026-05-27T12:00:00.000Z',
    producer: 'lead',
    severity: 'info',
    title: 'Decision needed',
    body: 'Pick one',
    dedup_key: 'decision',
    state: 'open',
    actions: [],
    resolution: null,
    ttl_seconds: 60,
    expires_at: '2026-05-27T12:01:00.000Z',
    resolved_at: null,
  });
  expect(stateAfterNotification.notifications).toHaveLength(1);
  expect(stateAfterNotification.notifications[0].title).toBe('Decision needed');
});

