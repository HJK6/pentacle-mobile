// Synthetic public fixtures preserve identity, prefix, timing, and provenance relationships.
import {
  applyFetchedStreamEvents,
  applyPentacleEvent,
  applySnapshotWithOptimisticReconciliation,
  initialPentacleStreamState,
  invalidateSessionDetailCache,
  selectSessionDetail,
  sendOptimisticMessage,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';

const STREAM_ID = 'hosta:v2-parent';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const NOTICE = '[pentacle-notice:d2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]\nChild session hostc:v2-child reached an inactivity threshold at 2026-01-01T01:40:51.416681Z.';
const NOTICE_SUMMARY = 'Child session hostc:v2-child reached an inactivity threshold at 2026-01-01T01:40:51.416681Z.';
const FIRST_REPLY = 'I will check the current task and review status.';
const SECOND_REPLY = 'The worker is temporarily unreachable. Existing work is retained while its connection recovers.';
const STATUS = 'Please update your status card: agent-orch status --update "<one-line progress note>" [--step-done <N>]. Set --goal/--plan if unset; revise them if they have changed.';
const OPERATOR_QUOTE = `${NOTICE}

Please collapse this notice with a Daemon label.

${STATUS}
Keep my quoted instructions visible.`;
const OPTIMISTIC_ID = 'optimistic_hosta_v2-parent_launch-example_1';

function event(overrides: Partial<PentacleEvent>): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hosta',
    provider: 'codex',
    session_id: SESSION_ID,
    session_name: 'v2-parent',
    stream_id: STREAM_ID,
    timestamp: '2026-01-01T01:41:57.811Z',
    kind: 'USER',
    text: '',
    ...overrides,
  };
}

const events: PentacleEvent[] = [
  event({ daemon_seq: 101, text: NOTICE, raw: { source: 'structured', transport: 'codex-rollout', ordinal: 21, jsonl_record_uuid: 'notice-record' } }),
  event({ daemon_seq: 102, timestamp: '2026-01-01T01:42:03.170Z', kind: 'ASSIST_TEXT', text: FIRST_REPLY, raw: { source: 'structured', transport: 'codex-rollout', ordinal: 22, jsonl_record_uuid: 'reply-one-uuid' } }),
  event({ daemon_seq: 103, timestamp: '2026-01-01T01:42:27.788Z', kind: 'ASSIST_TEXT', text: SECOND_REPLY, raw: { source: 'structured', transport: 'codex-rollout', ordinal: 23, jsonl_record_uuid: 'reply-two-uuid' } }),
  event({ daemon_seq: 104, timestamp: '2026-01-01T01:44:55.647Z', text: OPERATOR_QUOTE, optimistic_id: OPTIMISTIC_ID, raw: { source: 'structured', transport: 'codex-rollout', ordinal: 24, jsonl_record_uuid: 'user-record' } }),
];

const session: PentacleSessionSummary = {
  stream_id: STREAM_ID,
  host: 'hosta',
  provider: 'codex',
  session_name: 'v2-parent',
  last_event_at: events.at(-1)!.timestamp,
  last_text: OPERATOR_QUOTE,
  last_kind: 'USER',
  draft: '',
  pending: false,
  working: false,
  online: true,
};

function seed(): PentacleStreamState {
  return { ...initialPentacleStreamState, connected: true, sessions: [session] };
}

function assertIncident(state: PentacleStreamState) {
  invalidateSessionDetailCache(STREAM_ID);
  const rows = selectSessionDetail(state, STREAM_ID, { visibleCount: 'all' })?.transcriptItems ?? [];
  expect(rows.map((row) => row.id)).toEqual(['101', '102', '103', OPTIMISTIC_ID]);
  expect(rows.map((row) => row.text)).toEqual([NOTICE_SUMMARY, FIRST_REPLY, SECOND_REPLY, OPERATOR_QUOTE]);
  expect(rows[0]).toMatchObject({ eventCase: 'daemon-notice', label: 'Daemon', displayRule: 'bubble:agent' });
  expect(rows[0]?.disclosure).toMatchObject({ previewText: NOTICE_SUMMARY, previewTail: '', expandable: true, expandedText: NOTICE_SUMMARY });
  expect(rows[3]).toMatchObject({ eventCase: 'user-message', displayRule: 'bubble:user' });
  expect(state.events.find((item) => Number(item.daemon_seq) === 101)?.text).toBe(NOTICE);
}

const live = () => events.reduce((state, item) => applyPentacleEvent(state, item), seed());
const fetched = () => applyFetchedStreamEvents(seed(), events, { requestedStreamId: STREAM_ID });
const reconnect = () => applySnapshotWithOptimisticReconciliation(seed(), { sessions: [session], events });
const reverseBackfill = () => applyFetchedStreamEvents(
  applyFetchedStreamEvents(seed(), events.slice(2), { requestedStreamId: STREAM_ID }),
  events.slice(0, 2),
  { requestedStreamId: STREAM_ID },
);
const optimisticBefore = () => sendOptimisticMessage(
  events.slice(0, -1).reduce((state, item) => applyPentacleEvent(state, item), seed()),
  { streamId: STREAM_ID, text: OPERATOR_QUOTE, optimisticId: OPTIMISTIC_ID, requestId: 'send-example-1', createdAt: Date.parse(events[3]!.timestamp) },
);
const optimisticAfter = () => applyPentacleEvent(optimisticBefore(), events[3]!);
const replay = () => applyFetchedStreamEvents(optimisticAfter(), events, { requestedStreamId: STREAM_ID });

test.each([
  ['live', live],
  ['fetch', fetched],
  ['reconnect', reconnect],
  ['reverse-page backfill', reverseBackfill],
  ['optimistic before confirmation', optimisticBefore],
  ['optimistic after confirmation', optimisticAfter],
  ['confirmed replay', replay],
] as const)('production reducer/selector preserves synthetic incident-shaped order and attribution: %s', (_name, journey) => {
  assertIncident(journey());
});

test('synthetic report projects only the summary while bare status remains visible and unverified', () => {
  const summary = 'The implementation has passed its focused checks and is ready for independent review.';
  const report = event({
    daemon_seq: 91,
    text: `[pentacle-notice:child-report-ready-v2-11e594f481958c10e3015d0bf0447a22f068a8a647f475df15ce2c7ab4b8f3f1]\n[child_report_ready]\nreport_id=00000000-0000-4000-8000-000000000001\nledger_row_id=12\nchild_stream_id=hostb:v2-reporter\nmsg_id=20260101000101\nstatus=done\nsummary=${summary}\neffective_model=gpt-5.6-sol\neffective_effort=high`,
    raw: { source: 'structured', transport: 'codex-rollout', jsonl_record_uuid: 'report-record' },
  });
  const status = event({ daemon_seq: 92, text: STATUS, raw: { source: 'structured', transport: 'codex-rollout', jsonl_record_uuid: 'status-record' } });
  const state = applyFetchedStreamEvents({
    ...seed(),
    sessions: [{ ...session, last_text: STATUS, last_kind: 'USER', last_event_at: status.timestamp }],
  }, [report, status], { requestedStreamId: STREAM_ID });
  invalidateSessionDetailCache(STREAM_ID);
  const rows = selectSessionDetail(state, STREAM_ID, { visibleCount: 'all' })?.transcriptItems ?? [];

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ id: '91', eventCase: 'subagent-report', label: 'Subagent activity', text: summary });
  expect(rows[0]?.disclosure).toMatchObject({ previewText: summary, previewTail: '', expandedText: summary, expandable: true });
  expect(rows[1]).toMatchObject({ id: '92', eventCase: 'user-message', displayRule: 'bubble:user', text: STATUS });
  expect(state.events[0]?.text).toContain('ledger_row_id=12');
});
