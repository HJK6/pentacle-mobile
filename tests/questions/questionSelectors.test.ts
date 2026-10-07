import { selectSmartChatList } from '../../app/(tabs)/chats';
import { mobileQuestionItems } from '../../src/components/MobileQuestions';
import { BART_STREAM_ID } from '../../src/components/status/statusSelectors';
import { selectOptimisticQuestionAnswerIdentities } from '../../src/services/pentacleStream';
import { questionForAction } from '../../src/services/questionSubmit';
import {
  selectPendingQuestionCount,
  selectQuestionDeck,
} from '../../src/components/questions/questionSelectors';
import {
  SESSION_B,
  BART,
  HIDDEN_SEAT,
  HOSTS_CONFIG,
  LEGACY_SESSION,
  SESSION_C,
  baseState,
  durableQuestion,
  fixtureState,
  optimisticAnswer,
  session,
  twoItemQuestion,
} from './fixtures';

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));

beforeEach(() => {
  (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__ = HOSTS_CONFIG;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__PENTACLE_EXPO_CONFIG__;
});

// The count formula, implemented independently from docs/bart_home_contracts.md v1.4:
//   (the v1.2 reduce over selectSmartChatList)
//   - durable items covered by selectOptimisticQuestionAnswerIdentities({notificationId, questionId})
//   - durable items whose raw notification.question.questions[i] has a `state` present and not
//     'open', or a non-null `answer`.
function contractCount(state: any): number {
  const chats = selectSmartChatList(state);
  const reduce = chats.reduce((sum, chat) => sum + chat.openQuestions.reduce(
    (n, action) => n + mobileQuestionItems(questionForAction(action)).length, 0), 0);
  const identities = selectOptimisticQuestionAnswerIdentities(state);
  let subtract = 0;
  for (const chat of chats) {
    for (const action of chat.openQuestions) {
      if (action.kind !== 'durable') continue;
      const notification: any = action.model.notification;
      const rawItems: any[] = notification.question.questions ?? [];
      for (const item of mobileQuestionItems(questionForAction(action))) {
        const raw = rawItems[item.index];
        const questionId = raw?.question_id ?? notification.question.question_id;
        const covered = identities.some((identity) => (
          identity.notificationId === notification.notification_id && identity.questionId === questionId
        ));
        const marked = !!raw && ((raw.state !== undefined && raw.state !== 'open')
          || (raw.answer !== undefined && raw.answer !== null));
        if (covered || marked) subtract += 1;
      }
    }
  }
  return reduce - subtract;
}

const keys = (state: any) => selectQuestionDeck(state).map((entry) => entry.key);

describe('selectQuestionDeck (C1)', () => {
  test('lists every open item from Bart, sessions, a hidden seat, a two-item durable and a legacy question in Chats order', () => {
    const state = fixtureState();
    expect(keys(state)).toEqual([
      'n-deploy:0',
      'n-deploy:1',
      'n-review:0',
      `legacy:${LEGACY_SESSION}:0`,
      'n-bart:0',
      'n-hidden:0',
    ]);
    // Same order as selectSmartChatList -> openQuestions -> mobileQuestionItems.
    const expected = selectSmartChatList(state).flatMap((chat) => chat.openQuestions.flatMap(
      (action) => mobileQuestionItems(questionForAction(action)).map((_item, index) => `${action.id}:${index}`),
    ));
    expect(keys(state)).toEqual(expected);
  });

  test('entries carry source, display fields, action and item', () => {
    const deck = selectQuestionDeck(fixtureState());
    const hostc = deck[0];
    expect(hostc).toMatchObject({
      key: 'n-deploy:0',
      streamId: SESSION_C,
      isBart: false,
      machineLabel: 'Host C',
      sessionTitle: 'Deploy lane',
      itemIndex: 0,
      accent: '#1f5bff',
    });
    expect(hostc.action.kind).toBe('durable');
    expect(hostc.question.prompt).toBe('n-deploy first?');
    expect(deck[1]).toMatchObject({ key: 'n-deploy:1', itemIndex: 1 });
    expect(deck[1].question.prompt).toBe('n-deploy second?');
    expect(deck.find((entry) => entry.streamId === SESSION_B)?.accent).toBe('#ff2e3e');
    const legacy = deck.find((entry) => entry.action.kind === 'legacy');
    expect(legacy).toMatchObject({ streamId: LEGACY_SESSION, sessionTitle: 'Legacy chat' });
    expect(deck.find((entry) => entry.streamId === HIDDEN_SEAT)).toBeTruthy();
  });

  test('Bart is detected by BART_STREAM_ID, gets the lamp green accent and is the only isBart entry', () => {
    const deck = selectQuestionDeck(fixtureState());
    expect(BART_STREAM_ID).toBe(BART);
    const bart = deck.filter((entry) => entry.isBart);
    expect(bart.map((entry) => entry.key)).toEqual(['n-bart:0']);
    expect(bart[0].streamId).toBe(BART_STREAM_ID);
    expect(bart[0].accent).toBe('#3dff66');
    expect(deck.filter((entry) => !entry.isBart).every((entry) => entry.streamId !== BART_STREAM_ID)).toBe(true);
  });

  test('daemon-closed and fully covered notifications are excluded', () => {
    const closed = durableQuestion(SESSION_B, 'n-review', {
      state: 'resolved',
      question: { ...durableQuestion(SESSION_B, 'n-review').question, state: 'answered', answer: { value: 'yes' } },
    });
    const state = fixtureState();
    state.notifications = state.notifications.map((n: any) => (n.notification_id === 'n-review' ? closed : n));
    expect(keys(state)).not.toContain('n-review:0');
    expect(keys(state)).toHaveLength(5);

    const covered = fixtureState({ optimisticSends: { a: optimisticAnswer('n-bart', 'q-n-bart') } });
    expect(keys(covered)).not.toContain('n-bart:0');
  });

  test('a legacy question leaves the deck once the dismissed question leaves the session state', () => {
    const state = fixtureState();
    state.sessions = state.sessions.map((s: any) => (s.stream_id === LEGACY_SESSION ? { ...s, question: null } : s));
    expect(keys(state)).not.toContain(`legacy:${LEGACY_SESSION}:0`);
  });

  test('is a pure function of state: same state returns the same deck reference', () => {
    const state = fixtureState();
    expect(selectQuestionDeck(state)).toBe(selectQuestionDeck(state));
  });

  test('empty state yields an empty deck', () => {
    expect(selectQuestionDeck(baseState({ sessions: [session(BART, 'Bart')] }))).toEqual([]);
  });
});

describe('per-item removal on multi-item durable notifications', () => {
  test('one optimistic identity on the two-item notification leaves exactly one of its pages and decrements the count by 1', () => {
    const before = fixtureState();
    const after = fixtureState({ optimisticSends: { a: optimisticAnswer('n-deploy', 'q-n-deploy-a') } });
    expect(keys(before)).toHaveLength(6);
    expect(keys(after)).toEqual(['n-deploy:1', 'n-review:0', `legacy:${LEGACY_SESSION}:0`, 'n-bart:0', 'n-hidden:0']);
    expect(selectPendingQuestionCount(before) - selectPendingQuestionCount(after)).toBe(1);
    // The surviving page is the unanswered item, still keyed by its original item index.
    expect(selectQuestionDeck(after)[0].question.prompt).toBe('n-deploy second?');
  });

  test('covering the second item instead removes only that page', () => {
    const state = fixtureState({ optimisticSends: { b: optimisticAnswer('n-deploy', 'q-n-deploy-b') } });
    expect(keys(state).filter((key) => key.startsWith('n-deploy'))).toEqual(['n-deploy:0']);
  });

  test('covering both items hides the notification (existing Chats rule) and removes both pages', () => {
    const state = fixtureState({
      optimisticSends: {
        a: optimisticAnswer('n-deploy', 'q-n-deploy-a'),
        b: optimisticAnswer('n-deploy', 'q-n-deploy-b'),
      },
    });
    expect(keys(state).filter((key) => key.startsWith('n-deploy'))).toEqual([]);
    expect(selectPendingQuestionCount(state)).toBe(4);
  });

  test('an identity for a different notification or question id removes nothing', () => {
    const state = fixtureState({
      optimisticSends: {
        a: optimisticAnswer('n-other', 'q-n-deploy-a'),
        b: optimisticAnswer('n-deploy', 'q-unrelated'),
        c: optimisticAnswer('n-deploy', undefined),
      },
    });
    expect(keys(state)).toHaveLength(6);
  });

  test('settled optimistic sends no longer cover an item', () => {
    const state = fixtureState({ optimisticSends: { a: optimisticAnswer('n-deploy', 'q-n-deploy-a', 'failed') } });
    expect(keys(state)).toHaveLength(6);
  });

  test.each([
    ['item state is answered', { state: 'answered' }],
    ['item state is resolved', { state: 'resolved' }],
    ['item has a non-null answer', { answer: { value: 'a1' } }],
  ])('post-ack window: identity gone, notification still open, %s -> item does not reappear and the count stays decremented', (_label, patch) => {
    const state = fixtureState();
    state.notifications = state.notifications.map((n: any) => (
      n.notification_id === 'n-deploy' ? twoItemQuestion(SESSION_C, 'n-deploy', { a: patch }) : n
    ));
    expect(selectOptimisticQuestionAnswerIdentities(state)).toEqual([]);
    expect(keys(state)).toEqual(['n-deploy:1', 'n-review:0', `legacy:${LEGACY_SESSION}:0`, 'n-bart:0', 'n-hidden:0']);
    expect(selectPendingQuestionCount(state)).toBe(5);
    expect(selectPendingQuestionCount(state)).toBe(contractCount(state));
  });

  test('an item with state "open" and a null answer is still pending', () => {
    const state = fixtureState();
    state.notifications = state.notifications.map((n: any) => (
      n.notification_id === 'n-deploy'
        ? twoItemQuestion(SESSION_C, 'n-deploy', { a: { state: 'open', answer: null } })
        : n
    ));
    expect(keys(state)).toContain('n-deploy:0');
    expect(keys(state)).toHaveLength(6);
  });

  test('an item both covered by an identity and marked answered is subtracted once', () => {
    const state = fixtureState({ optimisticSends: { a: optimisticAnswer('n-deploy', 'q-n-deploy-a') } });
    state.notifications = state.notifications.map((n: any) => (
      n.notification_id === 'n-deploy' ? twoItemQuestion(SESSION_C, 'n-deploy', { a: { state: 'answered' } }) : n
    ));
    expect(selectPendingQuestionCount(state)).toBe(5);
    expect(selectPendingQuestionCount(state)).toBe(contractCount(state));
  });
});

describe('selectPendingQuestionCount (C2)', () => {
  const states: Array<[string, () => any]> = [
    ['empty', () => baseState()],
    ['bart only', () => baseState({
      sessions: [session(BART, 'Bart')],
      notifications: [durableQuestion(BART, 'n-bart')],
    })],
    ['full fixture', () => fixtureState()],
    ['two-item partial-optimistic', () => fixtureState({ optimisticSends: { a: optimisticAnswer('n-deploy', 'q-n-deploy-a') } })],
    ['two-item fully optimistic', () => fixtureState({
      optimisticSends: {
        a: optimisticAnswer('n-deploy', 'q-n-deploy-a'),
        b: optimisticAnswer('n-deploy', 'q-n-deploy-b'),
      },
    })],
    ['single optimistic on single-item', () => fixtureState({ optimisticSends: { a: optimisticAnswer('n-review', 'q-n-review') } })],
    ['two-item post-ack (state)', () => {
      const state = fixtureState();
      state.notifications = state.notifications.map((n: any) => (
        n.notification_id === 'n-deploy' ? twoItemQuestion(SESSION_C, 'n-deploy', { b: { state: 'answered' } }) : n
      ));
      return state;
    }],
    ['two-item post-ack (answer) plus optimistic on the other item', () => {
      const state = fixtureState({ optimisticSends: { b: optimisticAnswer('n-deploy', 'q-n-deploy-b') } });
      state.notifications = state.notifications.map((n: any) => (
        n.notification_id === 'n-deploy' ? twoItemQuestion(SESSION_C, 'n-deploy', { a: { answer: { value: 'a1' } } }) : n
      ));
      return state;
    }],
    ['legacy dismissed', () => {
      const state = fixtureState();
      state.sessions = state.sessions.map((s: any) => (s.stream_id === LEGACY_SESSION ? { ...s, question: null } : s));
      return state;
    }],
  ];

  test.each(states)('%s: count equals the deck length and the v1.4 formula', (_label, build) => {
    const state = build();
    const count = selectPendingQuestionCount(state);
    expect(count).toBe(selectQuestionDeck(state).length);
    expect(count).toBe(contractCount(state));
  });

  test('is unchanged by anything other than daemon closure or optimistic coverage (drafts, working, turns)', () => {
    const state = fixtureState();
    const noisy = { ...state, drafts: { [SESSION_C]: 'typing' }, workingByStream: { [SESSION_B]: { optimisticId: 'x' } } };
    expect(selectPendingQuestionCount(noisy)).toBe(selectPendingQuestionCount(state));
  });
});
