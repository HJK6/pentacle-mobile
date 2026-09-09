// Proves selectOptimisticQuestionAnswerIdentities memoizes on the optimisticSends
// reference:
// under load it is called per emit from two call sites and JSON.parses every
// send, so a stable reference must not re-parse.
import { selectOptimisticQuestionAnswerIdentities } from '../../src/services/pentacleStream';

function answerSend(id: string, notificationId: string) {
  return {
    optimistic_id: id,
    request_id: `req-${id}`,
    stream_id: 'hostc:codex:x',
    status: 'dispatched' as const,
    created_at: 1_700_000_000_000,
    text: JSON.stringify({ type: 'notification.answer', notification_id: notificationId, question_id: `q-${notificationId}` }),
  };
}

test('re-parses sends only when the optimisticSends reference changes', () => {
  const optimisticSends = { a: answerSend('a', 'n-1'), b: answerSend('b', 'n-2') };
  const source = { optimisticSends } as any;

  const parseSpy = jest.spyOn(JSON, 'parse');
  const first = selectOptimisticQuestionAnswerIdentities(source);
  const parsesAfterFirst = parseSpy.mock.calls.length;
  expect(parsesAfterFirst).toBeGreaterThanOrEqual(2); // one JSON.parse per send

  const second = selectOptimisticQuestionAnswerIdentities(source);
  expect(parseSpy.mock.calls.length).toBe(parsesAfterFirst); // cache hit: no re-parse
  expect(second).toBe(first); // stable reference returned

  // A new reference invalidates the memo.
  const third = selectOptimisticQuestionAnswerIdentities({ optimisticSends: { ...optimisticSends } } as any);
  expect(parseSpy.mock.calls.length).toBeGreaterThan(parsesAfterFirst);
  expect(third).toEqual(first);
  parseSpy.mockRestore();
});
