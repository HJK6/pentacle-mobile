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
