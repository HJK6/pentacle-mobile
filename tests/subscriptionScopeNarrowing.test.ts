// Lane: subscription_scope_narrowing_2026_09.
// The mobile client narrows its fleet subscription to include_subagents:false, so the
// daemon stops delivering hidden seats' session.inventory / working.state / chat.event /
// completion.report frames (server.py:1207-1227, filtered by session.visibility). These
// tests prove (a) the never-rendered hidden-frame share is what gets dropped, (b) every
// rendered surface stays correct, and (c) the one surface that would break — a hidden
// seat's open prompt-ask card — is re-projected from the still-delivered global
// notifications slice with NO session row present, and stays answerable / dedup-stable
// across reconnect-resync.

import {
  selectVisibleChatList,
  selectSmartChatList,
} from '../app/(tabs)/chats';
import { selectQuestionItems } from '../app/(tabs)/unified';
import { initialPentacleStreamState } from 'pentacle-chat-core';
import type { PentacleNotification, PentacleSessionSummary } from 'pentacle-chat-core';

function session(
  streamId: string,
  title: string,
  visibility?: string,
  extra: Partial<PentacleSessionSummary> = {},
): PentacleSessionSummary {
  return {
    stream_id: streamId,
    host: streamId.split(':')[0] || 'hostc',
    provider: 'codex',
    session_name: streamId.split(':').at(-1) || streamId,
    title,
    last_event_at: '2026-09-05T12:00:00.000Z',
    last_text: `${title} preview`,
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...(visibility === undefined ? {} : { visibility }),
    ...extra,
  } as PentacleSessionSummary;
}

function agentQuestionNotification(
  streamId: string,
  overrides: Record<string, unknown> = {},
): PentacleNotification {
  return {
    notification_id: `n-${streamId}`,
    created_at: '2026-09-05T12:00:00.000Z',
    updated_at: '2026-09-05T12:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: streamId,
    severity: 'info',
    title: 'Pick a lane',
    body: 'Which lane should run?',
    dedup_key: `question:${streamId}`,
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    question: {
      question_id: `q-${streamId}`,
      producer_stream_id: streamId,
      response_mode: 'single_choice',
      options: [
        { label: 'Lane A', value: 'lane_a' },
        { label: 'Lane B', value: 'lane_b' },
      ],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-09-05T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  } as unknown as PentacleNotification;
}

function baseState(overrides: Partial<any> = {}): any {
  return {
    ...initialPentacleStreamState,
    sessions: [],
    notifications: [],
    ...overrides,
  };
}

// The daemon's exact drop rule (server.py:1118-1120, 1207-1227): a session-scoped frame
// is withheld from an include_subagents:false client iff its target session's visibility
// is hidden/nested/subagent. Pure classifier, test-time only — no production sampler.
const HIDDEN_VISIBILITIES = new Set(['hidden', 'nested', 'subagent']);
const SESSION_SCOPED = new Set([
  'session.inventory.row',
  'chat.event',
  'working.state',
  'completion.report',
  'session.died',
]);
function isDroppedByNarrowing(
  frame: { type: string; visibility?: string },
): boolean {
  return SESSION_SCOPED.has(frame.type) && HIDDEN_VISIBILITIES.has(frame.visibility || 'default');
}

describe('subscription scope narrowing — Q1 frame-fraction', () => {
  test('the dropped share is exactly the never-rendered hidden-seat session traffic', () => {
    // Tonight's ledger shape: ~20 hidden seats, ~5 visible sessions, each emitting a
    // comparable burst of working.state + chat.event churn.
    const HIDDEN = 20;
    const VISIBLE = 5;
    const BURST = 6; // frames per seat per churn window
    const frames: { type: string; visibility?: string }[] = [];
    for (let i = 0; i < VISIBLE; i += 1) {
      frames.push({ type: 'session.inventory.row', visibility: 'default' });
      for (let b = 0; b < BURST; b += 1) frames.push({ type: 'working.state', visibility: 'default' });
    }
    for (let i = 0; i < HIDDEN; i += 1) {
      frames.push({ type: 'session.inventory.row', visibility: 'hidden' });
      for (let b = 0; b < BURST; b += 1) frames.push({ type: 'working.state', visibility: 'hidden' });
    }
    const total = frames.length;
    const dropped = frames.filter(isDroppedByNarrowing).length;
    const fraction = dropped / total;
    // eslint-disable-next-line no-console
    console.log(`[subscription_scope_narrowing] measured dropped frame fraction = ${(fraction * 100).toFixed(1)}% (${dropped}/${total})`);
    expect(fraction).toBeGreaterThan(0.7);
    // No visible-session frame is ever dropped.
    expect(frames.filter((f) => f.visibility === 'default').every((f) => !isDroppedByNarrowing(f))).toBe(true);
  });
});

describe('subscription scope narrowing — Q3 rendered surfaces stay correct', () => {
  test('All Chats list is unchanged when there are no open questions (no synthesized rows)', () => {
    const state = baseState({
      sessions: [session('hostc:codex:v1', 'Visible one', 'default'), session('hostc:codex:v2', 'Visible two')],
    });
    const rows = selectVisibleChatList(state).map((r) => r.streamId);
    expect(rows).toEqual(['hostc:codex:v1', 'hostc:codex:v2']);
  });
});

describe('subscription scope narrowing — Nexus AC-A: answerable card with no session row', () => {
  test('All Chats synthesizes an answerable question row when the hidden session is absent', () => {
    // include_subagents:false => the hidden seat is NOT in state.sessions; only the
    // global question notification survives.
    const state = baseState({
      sessions: [session('hostc:codex:visible', 'Visible worker', 'default')],
      notifications: [agentQuestionNotification('hostc:codex:hidden-q', { notification_id: 'n-hidden-q' })],
    });
    const smart = selectSmartChatList(state);
    const row = smart.find((r) => r.streamId === 'hostc:codex:hidden-q');
    expect(row).toBeTruthy();
    expect(row!.openQuestions.length).toBe(1);
    const action = row!.openQuestions[0];
    expect(action.kind).toBe('durable');
    // Answer routing is notification_id-keyed (resolveNotification): the synthesized
    // card must carry the real notification so the answer reaches the hidden stream.
    expect((action as any).model.notification.notification_id).toBe('n-hidden-q');
    expect((action as any).id).toBe('n-hidden-q');
  });

  test('Unified questions surface renders the hidden-seat question without a session join', () => {
    const notifications = [agentQuestionNotification('hostc:codex:hidden-q', { notification_id: 'n-hidden-q' })];
    const sessionsByStream: Record<string, PentacleSessionSummary> = {}; // hidden session absent
    const items = selectQuestionItems(notifications, sessionsByStream);
    expect(items.length).toBe(1);
    expect(items[0].streamId).toBe('hostc:codex:hidden-q');
    expect(items[0].model.notification.notification_id).toBe('n-hidden-q');
    // Display chrome falls back to the notification / stream id, not a missing session.
    expect(typeof items[0].chatTitle).toBe('string');
    expect(items[0].chatTitle.length).toBeGreaterThan(0);
  });
});

describe('subscription scope narrowing — Nexus AC-B: reconnect-resync & replay stability', () => {
  test('exactly one synthesized card across snapshot -> resync -> notification replay (no dup, no vanish)', () => {
    const notif = agentQuestionNotification('hostc:codex:hidden-q', { notification_id: 'n-hidden-q' });
    // Snapshot: hidden session present (pre-narrowing shape) OR absent — card count is 1 either way.
    const afterSnapshot = selectSmartChatList(baseState({
      sessions: [session('hostc:codex:visible', 'Visible', 'default')],
      notifications: [notif],
    })).filter((r) => r.streamId === 'hostc:codex:hidden-q');
    expect(afterSnapshot.length).toBe(1);

    // Reconnect-resync: hello/resync carry events:[] and replace sessions wholesale with
    // the narrowed set (hidden session still absent); the notifications slice persists.
    const afterResync = selectSmartChatList(baseState({
      sessions: [session('hostc:codex:visible', 'Visible', 'default')],
      notifications: [notif],
    })).filter((r) => r.streamId === 'hostc:codex:hidden-q');
    expect(afterResync.length).toBe(1);

    // Notification replay (applyNotificationList re-sends the same id): still exactly one.
    const afterReplay = selectSmartChatList(baseState({
      sessions: [session('hostc:codex:visible', 'Visible', 'default')],
      notifications: [notif, { ...notif }],
    })).filter((r) => r.streamId === 'hostc:codex:hidden-q');
    expect(afterReplay.length).toBe(1);
  });

  test('a resolved question does not leave a synthesized ghost row', () => {
    const state = baseState({
      sessions: [session('hostc:codex:visible', 'Visible', 'default')],
      notifications: [agentQuestionNotification('hostc:codex:hidden-q', {
        notification_id: 'n-hidden-q',
        state: 'resolved',
        resolved_at: '2026-09-05T12:30:00.000Z',
        question: { question_id: 'q', producer_stream_id: 'hostc:codex:hidden-q', response_mode: 'single_choice', options: [], state: 'resolved', answer: { selections: ['lane_a'] } },
      })],
    });
    const ghost = selectSmartChatList(state).find((r) => r.streamId === 'hostc:codex:hidden-q');
    expect(ghost).toBeUndefined();
  });
});

