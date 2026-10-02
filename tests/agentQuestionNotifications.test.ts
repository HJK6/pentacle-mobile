import {
  fullyCoveredOptimisticQuestionNotificationIds,
  terminalAgentQuestionMatchesSessionQuestion,
} from '../src/services/agentQuestionNotifications';

const notification = (nonce: string) => ({
  producer: 'agent_question.v1',
  state: 'answered',
  question: { state: 'answered', envelope: { question_id: 'durable-only', question_nonce: nonce } },
}) as any;

test('matches the real production nonce bridge when question ids are not shared', () => {
  expect(terminalAgentQuestionMatchesSessionQuestion(notification('nonce-live'), {
    prompt: 'Pick', options: [], question_nonce: 'nonce-live',
  })).toBe(true);
});

test('keeps a later selector when the nonce conflicts', () => {
  expect(terminalAgentQuestionMatchesSessionQuestion(notification('nonce-first'), {
    prompt: 'Pick', options: [], question_nonce: 'nonce-later',
  })).toBe(false);
});

test('multi-question optimistic suppression requires every distinct child and restores after one is discarded', () => {
  const open = {
    notification_id: 'n-multi',
    producer: 'agent_question.v1',
    state: 'open',
    actions: [{ kind: 'yes_no' }],
    question: {
      state: 'open',
      response_mode: 'single_choice',
      options: [],
      questions: [
        { question_id: 'q-first', response_mode: 'single_choice', options: [] },
        { question_id: 'q-second', response_mode: 'single_choice', options: [] },
      ],
    },
  } as any;
  const first = { notificationId: 'n-multi', questionId: 'q-first' };
  const second = { notificationId: 'n-multi', questionId: 'q-second' };

  expect(fullyCoveredOptimisticQuestionNotificationIds([{ ...open, client_resolution_pending: true }], []).has('n-multi')).toBe(false);
  expect(fullyCoveredOptimisticQuestionNotificationIds([open], [first]).has('n-multi')).toBe(false);
  expect(fullyCoveredOptimisticQuestionNotificationIds([open], [first, second]).has('n-multi')).toBe(true);
  expect(fullyCoveredOptimisticQuestionNotificationIds([open], [first]).has('n-multi')).toBe(false);
});

describe('question surface stream', () => {
  const {
    agentQuestionStreamId,
    agentQuestionSurfaceStreamId,
    selectOpenAgentQuestionNotificationsForStream,
    selectOpenAgentQuestionStreamIds,
  } = require('../src/services/agentQuestionNotifications');

  const card = (overrides: Record<string, unknown> = {}) => ({
    notification_id: 'n-card',
    producer: 'agent_question.v1',
    state: 'open',
    answer_to_stream_id: 'hosta:v2-bound',
    question: { question_id: 'q-card', producer_stream_id: 'hosta:v2-bound', state: 'open', options: [] },
    ...overrides,
  }) as any;

  test('a card surfaced to a composite chat is listed there, not under its hidden producer', () => {
    const surfaced = card({ surfaced_to_stream_id: 'composite:assistant' });
    expect([...selectOpenAgentQuestionStreamIds([surfaced])]).toEqual(['composite:assistant']);
    expect(selectOpenAgentQuestionNotificationsForStream([surfaced], 'composite:assistant')).toEqual([surfaced]);
    expect(selectOpenAgentQuestionNotificationsForStream([surfaced], 'hosta:v2-bound')).toEqual([]);
  });

  test('the surface never changes the producer or answer identity', () => {
    const surfaced = card({ surfaced_to_stream_id: 'composite:assistant' });
    expect(agentQuestionSurfaceStreamId(surfaced)).toBe('composite:assistant');
    expect(agentQuestionStreamId(surfaced)).toBe('hosta:v2-bound');
    expect(surfaced.answer_to_stream_id).toBe('hosta:v2-bound');
    expect(surfaced.question.producer_stream_id).toBe('hosta:v2-bound');
  });

  test('without a usable surface the card stays in its producer chat', () => {
    for (const value of [undefined, null, '', '   ', 42]) {
      const plain = card({ surfaced_to_stream_id: value });
      expect(agentQuestionSurfaceStreamId(plain)).toBe('hosta:v2-bound');
      expect(selectOpenAgentQuestionNotificationsForStream([plain], 'hosta:v2-bound')).toEqual([plain]);
      expect([...selectOpenAgentQuestionStreamIds([plain])]).toEqual(['hosta:v2-bound']);
    }
  });

  test('a resolved surfaced card is not listed as open', () => {
    const answered = card({ surfaced_to_stream_id: 'composite:assistant', state: 'answered' });
    expect(selectOpenAgentQuestionNotificationsForStream([answered], 'composite:assistant')).toEqual([]);
    expect([...selectOpenAgentQuestionStreamIds([answered])]).toEqual([]);
  });
});
