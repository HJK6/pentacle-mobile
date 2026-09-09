import {
  applyPentacleEvent,
  initialPentacleStreamState,
  sendOptimisticMessage,
} from 'pentacle-chat-core';
import type {
  PentacleEvent,
  PentacleSessionSummary,
  PentacleStreamState,
} from 'pentacle-chat-core';

// idempotent_mobile_send Track B — mobile-layer contract for the captured
// build-876 multiline echo. hosta primary evidence: one 996-character provider
// USER record produced daemon event 176312 (correlated claude-jsonl) and, 1.136s
// later, event 176314 (uncorrelated 20-character tmux-pane first-line fragment).
// The authoritative fix is the server-side pane-fragment guard (spec §C, in the
// chat_streamd slice); these tests pin the mobile reducer's half of the contract:
// it preserves the two events' DISTINCT identities (it must not merge them by
// content), so without the server guard the raw sequence renders two rows — and a
// genuinely distinct later send equal to the short prefix likewise stays its own
// row (acceptance: "a distinct later mobile send equal to the short prefix
// remains a second row").

const STREAM_ID = 'hostc:claude:one';
const OPTIMISTIC_ID = 'optimistic_hostc_claude_one_1';
const REQUEST_ID = 'send-req-1';
const CREATED_AT = Date.parse('2026-07-23T12:00:00.000Z');

const FULL_TEXT = 'Please review the plan and then\nproceed with the migration\nin order.';
const FIRST_LINE = 'Please review the plan and then';

const CORRELATED_SEQ = 176312;
const FRAGMENT_SEQ = 176314;

function session(): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    last_event_at: '2026-07-23T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

function buildState(): PentacleStreamState {
  return { ...initialPentacleStreamState, connected: true, sessions: [session()] };
}

function seedOptimistic(): PentacleStreamState {
  return sendOptimisticMessage(buildState(), {
    streamId: STREAM_ID,
    text: FULL_TEXT,
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
  });
}

// Event 176312: the correlated claude-jsonl USER echo carrying THIS row's
// optimistic_id and daemon-sequence correlation — reconciles the optimistic row.
function correlatedFullEcho(): PentacleEvent {
  return {
    daemon_seq: CORRELATED_SEQ,
    correlatedDaemonSeq: CORRELATED_SEQ,
    optimistic_id: OPTIMISTIC_ID,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'one',
    stream_id: STREAM_ID,
    timestamp: '2026-07-23T12:00:00.500Z',
    kind: 'USER',
    text: FULL_TEXT,
    raw: { source: 'claude-jsonl' },
  };
}

// Event 176314: the uncorrelated tmux-pane first-line fragment — no optimistic_id,
// no correlatedDaemonSeq, only the first line, ~1.136s later.
function paneFragmentEcho(): PentacleEvent {
  return {
    daemon_seq: FRAGMENT_SEQ,
    host: 'hostc',
    provider: 'claude',
    session_id: STREAM_ID,
    session_name: 'one',
    stream_id: STREAM_ID,
    timestamp: '2026-07-23T12:00:01.636Z',
    kind: 'USER',
    text: FIRST_LINE,
    raw: { source: 'tmux-pane' },
  };
}

function userRows(state: PentacleStreamState): PentacleEvent[] {
  return state.events.filter((event) => String(event.kind || '').toUpperCase() === 'USER');
}

test('the correlated 176312 echo reconciles the optimistic row into one full USER row', () => {
  const next = applyPentacleEvent(seedOptimistic(), correlatedFullEcho());

  const rows = userRows(next);
  expect(rows).toHaveLength(1);
  expect(rows[0].optimistic_id).toBe(OPTIMISTIC_ID);
  expect((rows[0] as PentacleEvent).correlatedDaemonSeq).toBe(CORRELATED_SEQ);
  expect(rows[0].text).toBe(FULL_TEXT);
  expect(next.optimisticSends?.[OPTIMISTIC_ID]).toBeUndefined();
});

test('without the server guard, the raw 176312→176314 sequence renders TWO rows (documents the mobile-layer defect)', () => {
  const afterFull = applyPentacleEvent(seedOptimistic(), correlatedFullEcho());
  const afterFragment = applyPentacleEvent(afterFull, paneFragmentEcho());

  // The mobile reducer preserves distinct identities: the uncorrelated pane
  // fragment (no optimistic_id, new daemon_seq) is NOT merged into the full
  // correlated row, so it appears as a separate row. The server-side pane-guard
  // is what suppresses 176314 upstream so this second row never reaches mobile.
  const rows = userRows(afterFragment);
  expect(rows).toHaveLength(2);
  expect(rows[0].text).toBe(FULL_TEXT);
  expect(rows[1].text).toBe(FIRST_LINE);
  expect(rows[1].optimistic_id).toBeUndefined();
});

test('a distinct later mobile send equal to the short prefix stays its own row (no content over-dedup)', () => {
  const afterFull = applyPentacleEvent(seedOptimistic(), correlatedFullEcho());

  // The user then legitimately sends a new message that happens to equal the
  // fragment's short prefix. It must remain a separate row — mobile never
  // collapses by content.
  const withSecondSend = sendOptimisticMessage(afterFull, {
    streamId: STREAM_ID,
    text: FIRST_LINE,
    optimisticId: 'optimistic_hostc_claude_one_2',
    requestId: 'send-req-2',
    createdAt: CREATED_AT + 5_000,
    windowStartedAt: CREATED_AT + 5_000,
  });

  const rows = userRows(withSecondSend);
  expect(rows).toHaveLength(2);
  expect(rows[0].text).toBe(FULL_TEXT);
  expect(rows[1].text).toBe(FIRST_LINE);
  expect(rows[1].optimistic_id).toBe('optimistic_hostc_claude_one_2');
});
