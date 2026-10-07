import { submitQuestionSubmission, type QuestionSubmitActions } from '../src/services/questionSubmit';

jest.mock('../src/services/agentQuestionNotifications', () => ({
  buildDurableQuestionResolution: jest.fn((_model, item, answer) => ({
    notification_id: 'n1', action_kind: 'answer', selections: answer.selections, text: undefined,
  })),
  buildDurableQuestionAnswerText: jest.fn(() => 'durable text'),
  durableQuestionDisplaySelections: jest.fn(() => ['Yes']),
}));

function makeActions(): jest.Mocked<QuestionSubmitActions> {
  return {
    beginOptimisticQuestionAnswer: jest.fn(() => 'opt1'),
    answerPrompt: jest.fn(() => Promise.resolve(true as const)),
    queueOptimisticQuestionAnswer: jest.fn(),
    discardOptimisticQuestionAnswer: jest.fn(),
    dismissQuestion: jest.fn(() => Promise.resolve(true)),
    sendMessage: jest.fn(() => Promise.resolve(true)),
  } as unknown as jest.Mocked<QuestionSubmitActions>;
}

const durable = (items: { questionId?: string }[]) => ({
  action: { kind: 'durable' as const, id: 'n1', model: { items } as any },
  answers: items.map(() => ({ selections: ['y'] }) as any),
});

test('each durable item is one prompt.answer behind a queued optimistic answer', async () => {
  const actions = makeActions();
  const onDurableAnswerQueued = jest.fn();
  await submitQuestionSubmission(actions, 's1', durable([{ questionId: 'q1' }, { questionId: 'q2' }]), { onDurableAnswerQueued });
  expect(actions.answerPrompt.mock.calls.map(([args]) => args.questionId)).toEqual(['q1', 'q2']);
  expect(actions.beginOptimisticQuestionAnswer).toHaveBeenCalledWith(expect.objectContaining({ streamId: 's1', notificationId: 'n1', questionId: 'q1' }));
  expect(actions.queueOptimisticQuestionAnswer).toHaveBeenCalledTimes(2);
  expect(onDurableAnswerQueued).toHaveBeenCalledTimes(2);
});

test('a coded durable rejection discards the optimistic answer, reports rejected, and throws', async () => {
  const actions = makeActions();
  actions.answerPrompt.mockRejectedValueOnce(Object.assign(new Error('stale'), { errorCode: 'stale' }));
  const onDurableAnswerRejected = jest.fn();
  await expect(submitQuestionSubmission(actions, 's1', durable([{ questionId: 'q1' }]), { onDurableAnswerRejected })).rejects.toThrow('stale');
  expect(actions.discardOptimisticQuestionAnswer).toHaveBeenCalledWith('opt1');
  expect(onDurableAnswerRejected).toHaveBeenCalledTimes(1);
});

test('a durable item without a prompt identity is discarded and throws', async () => {
  const actions = makeActions();
  await expect(submitQuestionSubmission(actions, 's1', durable([{}]))).rejects.toThrow('durable prompt identity');
  expect(actions.answerPrompt).not.toHaveBeenCalled();
  expect(actions.discardOptimisticQuestionAnswer).toHaveBeenCalledWith('opt1');
});

const legacy = {
  action: { kind: 'legacy' as const, id: 'legacy:s1', host: 'h', sessionName: 'one',
    question: { question_key: 'k1', prompt: 'Pick', options: [{ index: 1, label: 'A' }] } as any },
  answers: [{ selectedOptionIndex: 1 } as any],
};

test('a legacy question is dismissed by key then answered with one message', async () => {
  const actions = makeActions();
  await submitQuestionSubmission(actions, 's1', legacy);
  expect(actions.dismissQuestion).toHaveBeenCalledWith({ host: 'h', sessionName: 'one', questionKey: 'k1' });
  expect(actions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ host: 'h', sessionName: 'one', optimisticId: 'opt1' }));
});

test('a stale legacy dismiss still sends; a failed send reports instead of throwing', async () => {
  const actions = makeActions();
  actions.dismissQuestion.mockRejectedValueOnce(Object.assign(new Error('gone'), { errorCode: 'stale_question' }));
  actions.sendMessage.mockRejectedValueOnce(new Error('offline'));
  const onLegacySendFailed = jest.fn();
  await submitQuestionSubmission(actions, 's1', legacy, { onLegacySendFailed });
  expect(onLegacySendFailed).toHaveBeenCalledTimes(1);
  expect(actions.discardOptimisticQuestionAnswer).not.toHaveBeenCalled();
});

test('a non-stale legacy dismiss failure discards and throws without sending', async () => {
  const actions = makeActions();
  actions.dismissQuestion.mockRejectedValueOnce(new Error('denied'));
  await expect(submitQuestionSubmission(actions, 's1', legacy)).rejects.toThrow('denied');
  expect(actions.discardOptimisticQuestionAnswer).toHaveBeenCalledWith('opt1');
  expect(actions.sendMessage).not.toHaveBeenCalled();
});

test('a durable item runs begin -> queued hook -> answerPrompt -> queue in order, and discards after a failed answer', async () => {
  const log: string[] = [];
  const actions = makeActions();
  actions.beginOptimisticQuestionAnswer.mockImplementation(() => { log.push('begin'); return 'opt1'; });
  actions.answerPrompt.mockImplementation(async () => { log.push('answer'); return true as const; });
  actions.queueOptimisticQuestionAnswer.mockImplementation(() => { log.push('queue'); });
  actions.discardOptimisticQuestionAnswer.mockImplementation(() => { log.push('discard'); });
  const hooks = { onDurableAnswerQueued: () => log.push('queued-hook'), onDurableAnswerRejected: () => log.push('rejected-hook') };
  await submitQuestionSubmission(actions, 's1', durable([{ questionId: 'q1' }]), hooks);
  expect(log).toEqual(['begin', 'queued-hook', 'answer', 'queue']);
  log.length = 0;
  actions.answerPrompt.mockImplementation(async () => { log.push('answer'); throw Object.assign(new Error('x'), { errorCode: 'stale' }); });
  await expect(submitQuestionSubmission(actions, 's1', durable([{ questionId: 'q1' }]), hooks)).rejects.toThrow('x');
  expect(log).toEqual(['begin', 'queued-hook', 'answer', 'discard', 'rejected-hook']);
});
