import type { MobileQuestionAnswer } from '../../src/components/MobileQuestions';
import { selectQuestionDeck, sendableKeys, submitDeckAnswers } from '../../src/components/questions';
import * as questionSubmit from '../../src/services/questionSubmit';
import {
  HOSTS_CONFIG,
  LEGACY_SESSION,
  fixtureState,
  legacyQuestion,
} from './fixtures';

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));
jest.mock('../../src/services/questionSubmit', () => {
  const actual = jest.requireActual('../../src/services/questionSubmit');
  return { ...actual, submitQuestionSubmission: jest.fn(actual.submitQuestionSubmission) };
});

const submitSpy = questionSubmit.submitQuestionSubmission as jest.Mock;

function makeActions() {
  let n = 0;
  return {
    beginOptimisticQuestionAnswer: jest.fn(() => `opt-${++n}`),
    answerPrompt: jest.fn().mockResolvedValue(undefined),
    queueOptimisticQuestionAnswer: jest.fn(),
    discardOptimisticQuestionAnswer: jest.fn(),
    dismissQuestion: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
  };
}

const pick = (index: number): MobileQuestionAnswer => ({ selectedOptionIndex: index });
const answerMap = (entries: Array<[string, MobileQuestionAnswer]>) => new Map(entries);

beforeEach(() => {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = HOSTS_CONFIG;
  submitSpy.mockClear();
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

function legacyMultiState() {
  const state = fixtureState();
  state.sessions = state.sessions.map((s: any) => (s.stream_id === LEGACY_SESSION ? {
    ...s,
    question: legacyQuestion({
      multi: true,
      questions: [
        { index: 1, prompt: 'First legacy?', options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }] },
        { index: 2, prompt: 'Second legacy?', options: [{ index: 1, label: 'Red' }, { index: 2, label: 'Blue' }] },
      ],
    }),
  } : s));
  return state;
}

describe('submitDeckAnswers (C4)', () => {
  test('calls submitQuestionSubmission once per answered durable item with that single item, never for unanswered items', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    const answers = answerMap([['n-deploy:1', pick(2)], ['n-bart:0', pick(1)]]);

    const result = await submitDeckAnswers({ actions, deck, answers });

    expect(submitSpy).toHaveBeenCalledTimes(2);
    const hostc = deck.find((entry) => entry.key === 'n-deploy:1')!;
    const [, streamId, submission] = submitSpy.mock.calls[0];
    expect(streamId).toBe(hostc.streamId);
    expect(submission.action).toBe(hostc.action);
    expect(submission.answers).toEqual([pick(2)]);
    expect(submission.items).toHaveLength(1);
    expect(submission.items[0].questionId).toBe('q-n-deploy-b');
    expect(submitSpy.mock.calls[1][2].items[0].questionId).toBe('q-n-bart');
    // One prompt.answer per item, in deck order; unanswered items untouched.
    expect(actions.answerPrompt.mock.calls.map(([arg]) => arg.questionId)).toEqual(['q-n-deploy-b', 'q-n-bart']);
    expect(actions.answerPrompt.mock.calls[0][0]).toMatchObject({ selections: ['b2'] });
    expect(actions.dismissQuestion).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: ['n-deploy:1', 'n-bart:0'], failed: [], legacyFailed: [] });
  });

  test('both items of a two-item durable are two independent submissions', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    await submitDeckAnswers({ actions, deck, answers: answerMap([['n-deploy:0', pick(1)], ['n-deploy:1', pick(1)]]) });
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(submitSpy.mock.calls.map((call) => call[2].items[0].questionId)).toEqual(['q-n-deploy-a', 'q-n-deploy-b']);
    expect(submitSpy.mock.calls.every((call) => call[2].answers.length === 1)).toBe(true);
  });

  test('runs serially: the next item is not started until the previous call resolves', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    let release: () => void = () => undefined;
    actions.answerPrompt.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = submitDeckAnswers({ actions, deck, answers: answerMap([['n-deploy:0', pick(1)], ['n-review:0', pick(1)]]) });
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.answerPrompt).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(actions.answerPrompt).toHaveBeenCalledTimes(2);
  });

  test('a throw marks only that item failed and the remaining answered items are still attempted', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    actions.answerPrompt
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined);

    const result = await submitDeckAnswers({
      actions,
      deck,
      answers: answerMap([['n-deploy:0', pick(1)], ['n-review:0', pick(1)], ['n-bart:0', pick(2)]]),
    });

    expect(actions.answerPrompt).toHaveBeenCalledTimes(3);
    expect(result.sent).toEqual(['n-review:0', 'n-bart:0']);
    expect(result.failed).toEqual([{ key: 'n-deploy:0', message: 'network down' }]);
    expect(result.legacyFailed).toEqual([]);
    expect(actions.discardOptimisticQuestionAnswer).toHaveBeenCalledTimes(1);
  });

  test('a non-Error throw falls back to a generic message', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    actions.answerPrompt.mockRejectedValueOnce('nope');
    const result = await submitDeckAnswers({ actions, deck, answers: answerMap([['n-review:0', pick(1)]]) });
    expect(result.failed).toEqual([{ key: 'n-review:0', message: 'Question answer could not be submitted.' }]);
  });

  test('a legacy single-item action is one submission (dismiss by key, then one message)', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    const key = `legacy:${LEGACY_SESSION}:0`;
    const result = await submitDeckAnswers({ actions, deck, answers: answerMap([[key, pick(1)]]) });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(actions.dismissQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionKey: 'legacy-key-1' }));
    expect(actions.sendMessage).toHaveBeenCalledTimes(1);
    expect(actions.answerPrompt).not.toHaveBeenCalled();
    expect(result.sent).toEqual([key]);
  });

  test('a multi-item legacy action is submitted only when every item is answered, as one submission', async () => {
    const deck = selectQuestionDeck(legacyMultiState());
    const k0 = `legacy:${LEGACY_SESSION}:0`;
    const k1 = `legacy:${LEGACY_SESSION}:1`;
    expect(deck.map((entry) => entry.key)).toEqual(expect.arrayContaining([k0, k1]));

    const partialActions = makeActions();
    const partial = await submitDeckAnswers({ actions: partialActions, deck, answers: answerMap([[k0, pick(1)]]) });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(partial).toEqual({ sent: [], failed: [], legacyFailed: [] });
    expect(partialActions.dismissQuestion).not.toHaveBeenCalled();

    const fullActions = makeActions();
    const full = await submitDeckAnswers({ actions: fullActions, deck, answers: answerMap([[k0, pick(1)], [k1, pick(2)]]) });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0][2].answers).toEqual([pick(1), pick(2)]);
    expect(fullActions.sendMessage).toHaveBeenCalledTimes(1);
    expect(full.sent).toEqual([k0, k1]);
  });

  test('sendableKeys keeps answered durable items and only fully answered legacy actions', () => {
    const deck = selectQuestionDeck(legacyMultiState());
    const k0 = `legacy:${LEGACY_SESSION}:0`;
    const k1 = `legacy:${LEGACY_SESSION}:1`;
    expect([...sendableKeys(deck, new Set(['n-bart:0', k0]))]).toEqual(['n-bart:0']);
    expect([...sendableKeys(deck, new Set(['n-bart:0', k0, k1]))].sort()).toEqual(['n-bart:0', k0, k1].sort());
    expect(sendableKeys(deck, new Set()).size).toBe(0);
  });

  test('legacy send failure (onLegacySendFailed): not counted as sent, reported with its action and stream, later items still run', async () => {
    const deck = selectQuestionDeck(fixtureState());
    const actions = makeActions();
    actions.sendMessage.mockRejectedValueOnce(new Error('socket closed'));
    const key = `legacy:${LEGACY_SESSION}:0`;

    const result = await submitDeckAnswers({ actions, deck, answers: answerMap([[key, pick(1)], ['n-bart:0', pick(1)]]) });

    expect(result.sent).toEqual(['n-bart:0']);
    expect(result.failed).toEqual([]);
    expect(result.legacyFailed).toEqual([{ actionId: `legacy:${LEGACY_SESSION}`, streamId: LEGACY_SESSION, keys: [key] }]);
    expect(actions.answerPrompt).toHaveBeenCalledTimes(1);
  });

  test('legacy dismiss failure other than stale_question is a thrown failure for the whole action', async () => {
    const deck = selectQuestionDeck(legacyMultiState());
    const actions = makeActions();
    actions.dismissQuestion.mockRejectedValueOnce(Object.assign(new Error('dismiss failed'), { errorCode: 'internal' }));
    const k0 = `legacy:${LEGACY_SESSION}:0`;
    const k1 = `legacy:${LEGACY_SESSION}:1`;
    const result = await submitDeckAnswers({ actions, deck, answers: answerMap([[k0, pick(1)], [k1, pick(1)]]) });
    expect(result.sent).toEqual([]);
    expect(result.failed.map((failure) => failure.key).sort()).toEqual([k0, k1].sort());
    expect(result.failed[0].message).toBe('dismiss failed');
  });

  test('an unanswered deck sends nothing', async () => {
    const actions = makeActions();
    const result = await submitDeckAnswers({ actions, deck: selectQuestionDeck(fixtureState()), answers: new Map() });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: [], failed: [], legacyFailed: [] });
  });
});
