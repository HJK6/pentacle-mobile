import { initialPentacleStreamState, type PentacleNotification, type PentacleSessionSummary, type PentacleStreamState } from 'pentacle-chat-core';

export const NOW = '2026-05-16T12:00:00.000Z';
export function bartSession(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return { stream_id: streamId, host: 'hostc', provider: 'claude', session_name: streamId.split(':').at(-1)!,
    title: `Synthetic ${streamId.split(':').at(-1)}`, last_event_at: NOW, last_text: 'Synthetic preview',
    last_kind: 'ASSIST', draft: '', pending: false, working: false, online: true, ...overrides };
}

export function bartQuestion(streamId: string, count = 1, answered = 0): PentacleNotification {
  return { notification_id: `question-${streamId}`, created_at: NOW, updated_at: NOW, producer: 'agent_question.v1',
    answer_to_stream_id: streamId, severity: 'info', title: 'Choose a sample', body: 'Which sample should run?',
    dedup_key: `question:${streamId}`, state: 'open', actions: [{ kind: 'yes_no', action_id: 'choose' }],
    question: { question_id: `q-${streamId}`, producer_stream_id: streamId, response_mode: 'single_choice',
      options: [{ label: 'Sample A', value: 'a' }], state: 'open', answer: null,
      questions: Array.from({ length: count }, (_, index) => ({ question_id: `q-${streamId}-${index}`,
        prompt: `Synthetic choice ${index}`, response_mode: 'single_choice', options: [{ label: 'Sample A', value: 'a' }],
        state: index < answered ? 'answered' : 'open', answer: index < answered ? { selections: ['a'] } : null })),
    }, resolution: null, ttl_seconds: 3600, expires_at: '2026-05-16T13:00:00.000Z', resolved_at: null,
  } as unknown as PentacleNotification;
}

export function bartState(): PentacleStreamState {
  return { ...initialPentacleStreamState, connected: true, hasHydrated: true, sessions: [], events: [], notifications: [] };
}
