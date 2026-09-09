import { orderSessionTranscriptRows } from '../app/pentacle/session/[streamId]';
import type { PentacleTranscriptItem } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

function detailRow(id: string, eventCase: string, text: string, extra: Partial<PentacleTranscriptItem> = {}): PentacleTranscriptItem {
  return {
    id,
    timestampLabel: '',
    label: '',
    tone: 'agent',
    provider: 'claude',
    source: 'chat',
    text,
    kind: 'ASSISTANT',
    isUser: false,
    eventCase,
    displayRule: 'bubble:assistant',
    ...extra,
  };
}

function answerProjection(key: string, text: string, notificationId?: string): PentacleTranscriptItem {
  return {
    id: `session-question-answer-${key}`,
    timestampLabel: '',
    label: 'Question',
    tone: 'system',
    provider: '',
    source: 'question-answer',
    text,
    kind: 'USER',
    isUser: false,
    eventCase: 'agent-question-answer',
    displayRule: 'activity:question',
    ...(notificationId ? { notificationId } : {}),
  };
}

// The inverted FlatList renders data[0] at the BOTTOM; the function returns
// newest->oldest, so the LAST array element is the top of the chat and the
// FIRST is the bottom. A resolved answer must sit directly below its question
// (one index nearer the bottom), not pinned to the very bottom of the chat.
function idsBottomToTop(items: PentacleTranscriptItem[]): string[] {
  return items.map((item) => item.id);
}

test('an answered mid-chat question keeps its position — answer sits right after its ask row', () => {
  const detailItems = [
    detailRow('1', 'user-message', 'first'),
    detailRow('2', 'agent-question-ask', 'Asked: Pick a color', { notificationId: 'notif-abc' }),
    detailRow('3', 'assistant-message', 'later work'),
    detailRow('4', 'user-message', 'newest'),
  ];
  const projections = [answerProjection('a', 'Operator answered: blue', 'notif-abc')];

  const ordered = orderSessionTranscriptRows(detailItems, projections);
  const ids = idsBottomToTop(ordered);
  // newest->oldest: 4 (bottom), 3, answer, 2 (ask), 1 (top)
  expect(ids).toEqual(['4', '3', 'session-question-answer-a', '2', '1']);
  // The answer is NOT at index 0 (the bottom of the chat).
  expect(ids[0]).toBe('4');
});

test('a projection whose ask row is not loaded falls back to the newest end (bottom)', () => {
  const detailItems = [
    detailRow('1', 'user-message', 'first'),
    detailRow('2', 'assistant-message', 'newest'),
  ];
  const projections = [answerProjection('a', 'Operator answered: blue', 'notif-missing')];

  const ordered = orderSessionTranscriptRows(detailItems, projections);
  // The unanchored answer is the newest -> bottom -> index 0.
  expect(ordered[0].id).toBe('session-question-answer-a');
});

test('partial multi-question answers all anchor to the same ask row, in order', () => {
  const detailItems = [
    detailRow('1', 'agent-question-ask', 'Asked: Two things', { notificationId: 'notif-multi' }),
    detailRow('2', 'assistant-message', 'later'),
  ];
  const projections = [
    answerProjection('child-0', 'Operator answered: A', 'notif-multi'),
    answerProjection('child-1', 'Operator answered: B', 'notif-multi'),
  ];

  const ordered = orderSessionTranscriptRows(detailItems, projections);
  const ids = idsBottomToTop(ordered);
  // newest->oldest: 2 (bottom), child-1, child-0, 1 (ask, top)
  expect(ids).toEqual(['2', 'session-question-answer-child-1', 'session-question-answer-child-0', '1']);
});

test('an unanswered question with no projection leaves the transcript untouched (just reversed)', () => {
  const detailItems = [
    detailRow('1', 'user-message', 'first'),
    detailRow('2', 'agent-question-ask', 'Asked: Pick a color', { notificationId: 'notif-abc' }),
  ];
  const ordered = orderSessionTranscriptRows(detailItems, []);
  expect(idsBottomToTop(ordered)).toEqual(['2', '1']);
});

test('a duplicate notification anchor is consumed once — no double insertion', () => {
  const detailItems = [
    detailRow('1', 'agent-question-ask', 'Asked A', { notificationId: 'notif-dup' }),
    detailRow('2', 'agent-question-ask', 'Asked again same notif', { notificationId: 'notif-dup' }),
  ];
  const projections = [answerProjection('a', 'Operator answered: X', 'notif-dup')];
  const ordered = orderSessionTranscriptRows(detailItems, projections);
  const answers = ordered.filter((item) => item.id === 'session-question-answer-a');
  expect(answers).toHaveLength(1);
});
