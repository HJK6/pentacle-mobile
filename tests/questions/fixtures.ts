// Shared fixtures for the Questions overlay tests: a synthetic PentacleStreamState with
// Bart + sessions on different hosts, durable (single + two-item) and legacy questions.
export const BART = 'bart:assistant';
export const SESSION_C = 'hostc:codex:deploy';
export const SESSION_B = 'hostb:claude:review';
export const HIDDEN_SEAT = 'hostc:codex:hidden-seat';
export const LEGACY_SESSION = 'hostb:codex:legacy';

export const HOSTS_CONFIG = {
  extra: {
    wsUrl: 'ws://10.0.0.0:7791',
    hosts: {
      bart: { label: 'Bart', color: '#ff7ab8', sigil: 'djinni' },
      hostc: { label: 'Host C', color: '#4da3ff', sigil: 'mage' },
      hostb: { label: 'Host B', color: '#ff4d5e', sigil: 'sun' },
    },
    hostOrder: ['bart', 'hostc', 'hostb'],
  },
};

export function session(streamId: string, title: string, overrides: Record<string, unknown> = {}) {
  const [host, provider, name] = streamId.split(':');
  return {
    stream_id: streamId,
    host,
    provider: provider === 'assistant' ? 'claude' : provider,
    session_name: name ?? 'assistant',
    title,
    last_event_at: '2026-10-06T12:00:00.000Z',
    last_text: `${title} preview`,
    last_kind: 'ASSIST',
    online: true,
    ...overrides,
  };
}

const option = (label: string, value: string) => ({ label, value });

export function durableQuestion(streamId: string, notificationId: string, overrides: Record<string, unknown> = {}) {
  return {
    notification_id: notificationId,
    created_at: '2026-10-06T12:00:00.000Z',
    updated_at: '2026-10-06T12:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: streamId,
    severity: 'info',
    title: `Question ${notificationId}`,
    body: `Prompt for ${notificationId}?`,
    dedup_key: `question:${notificationId}`,
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    question: {
      question_id: `q-${notificationId}`,
      producer_stream_id: streamId,
      response_mode: 'single_choice',
      options: [option('Yes', 'yes'), option('No', 'no')],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-10-06T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

// A two-item durable notification: items q-<id>-a and q-<id>-b. `itemOverrides` patches a raw item.
export function twoItemQuestion(
  streamId: string,
  notificationId: string,
  itemOverrides: { a?: Record<string, unknown>; b?: Record<string, unknown> } = {},
) {
  return durableQuestion(streamId, notificationId, {
    question: {
      question_id: `q-${notificationId}`,
      producer_stream_id: streamId,
      response_mode: 'single_choice',
      options: [],
      state: 'open',
      answer: null,
      questions: [
        {
          question_id: `q-${notificationId}-a`, response_mode: 'single_choice', prompt: `${notificationId} first?`,
          options: [option('A1', 'a1'), option('A2', 'a2')], ...itemOverrides.a,
        },
        {
          question_id: `q-${notificationId}-b`, response_mode: 'single_choice', prompt: `${notificationId} second?`,
          options: [option('B1', 'b1'), option('B2', 'b2')], ...itemOverrides.b,
        },
      ],
    },
  });
}

export function optimisticAnswer(notificationId: string, questionId: string | undefined, status = 'queued') {
  return {
    optimistic_id: `opt-${notificationId}-${questionId ?? 'none'}`,
    request_id: `req-${notificationId}-${questionId ?? 'none'}`,
    stream_id: 'bart:assistant',
    text: JSON.stringify({
      type: 'notification.answer',
      notification_id: notificationId,
      ...(questionId ? { question_id: questionId } : {}),
      answer: { action_kind: 'yes_no' },
    }),
    status,
    created_at: 1,
    reconnect_count: 0,
  };
}

export function legacyQuestion(overrides: Record<string, unknown> = {}) {
  return {
    header: 'Legacy',
    prompt: 'Legacy prompt?',
    question_key: 'legacy-key-1',
    options: [{ index: 1, label: 'Go' }, { index: 2, label: 'Stop' }],
    ...overrides,
  };
}

export function baseState(overrides: Record<string, unknown> = {}) {
  return {
    sessions: [],
    notifications: [],
    events: [],
    drafts: {},
    workingByStream: {},
    turnsByStream: {},
    optimisticSends: {},
    ...overrides,
  } as any;
}

// Bart + two sessions on different hosts (+ a hidden seat) with one question each, a two-item
// durable on the Host C session, and a legacy keyed question on a third session.
export function fixtureState(overrides: Record<string, unknown> = {}) {
  return baseState({
    sessions: [
      session(BART, 'Bart'),
      session(SESSION_C, 'Deploy lane', { last_event_at: '2026-10-06T12:05:00.000Z' }),
      session(SESSION_B, 'Code review', { last_event_at: '2026-10-06T12:04:00.000Z' }),
      session(LEGACY_SESSION, 'Legacy chat', {
        last_event_at: '2026-10-06T12:03:00.000Z',
        question: legacyQuestion(),
      }),
      session(HIDDEN_SEAT, 'Hidden seat', { visibility: 'hidden' }),
    ],
    notifications: [
      durableQuestion(BART, 'n-bart'),
      twoItemQuestion(SESSION_C, 'n-deploy'),
      durableQuestion(SESSION_B, 'n-review'),
      durableQuestion(HIDDEN_SEAT, 'n-hidden'),
    ],
    ...overrides,
  });
}
