import { orderSessionTranscriptRows, formatNotificationAnswerTellItem, suppressLocalQuestionAnswerEchoes } from '../app/pentacle/session/[streamId]';
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


test('a resolved plaintext answer keeps its received position after its echo is deduplicated', () => {
  const notificationId = 'received-question';
  const echo = formatNotificationAnswerTellItem(detailRow('509', 'user-message',
    '[notification.answer]\nnotification_id=received-question\ntext=Proceed with the documented checks\nby=operator',
    { isUser: true, timestampLabel: '07:44 PM' }));
  const later = detailRow('581', 'assistant-message', 'later deployment update');
  const source = [echo, detailRow('560', 'user-message', 'use the simulator'), later];
  const filtered = suppressLocalQuestionAnswerEchoes(source, new Set([notificationId]));
  const projections = [answerProjection('received', 'Operator answered: Proceed with the documented checks', notificationId)];
  const ordered = orderSessionTranscriptRows(filtered, projections, source);
  expect(idsBottomToTop(ordered)).toEqual(['581', '560', 'session-question-answer-received']);
  expect(ordered[2].timestampLabel).toBe('07:44 PM');
  const next = detailRow('600', 'assistant-message', 'more progress');
  expect(idsBottomToTop(orderSessionTranscriptRows([...filtered, next], projections, [...source, next])))
    .toEqual(['600', '581', '560', 'session-question-answer-received']);
  expect(ordered.filter((item) => item.eventCase === 'agent-question-answer')).toHaveLength(1);
});

test('the actual answer receipt takes precedence over an older ask anchor', () => {
  const source = [
    detailRow('1', 'agent-question-ask', 'question', { notificationId: 'q' }),
    detailRow('2', 'assistant-message', 'work before answer'),
    detailRow('3', 'agent-question-answer', 'answer echo', { notificationId: 'q' }),
    detailRow('4', 'assistant-message', 'work after answer'),
  ];
  const filtered = suppressLocalQuestionAnswerEchoes(source, new Set(['q']));
  expect(idsBottomToTop(orderSessionTranscriptRows(filtered, [answerProjection('a', 'answer', 'q')], source)))
    .toEqual(['4', 'session-question-answer-a', '2', '1']);
});

test('a restored resolved answer without a loaded echo uses its recorded time, not the newest end', () => {
  const source = [detailRow('1', 'assistant-message', 'before'), detailRow('2', 'assistant-message', 'after')];
  const projection = { ...answerProjection('a', 'answer', 'q'), answerTimestamp: '2026-09-10T00:44:02.971Z' };
  const times = new Map([['1', '2026-09-10T00:43:00Z'], ['2', '2026-09-10T00:48:16.961Z']]);
  expect(idsBottomToTop(orderSessionTranscriptRows(source, [projection], source, times)))
    .toEqual(['2', 'session-question-answer-a', '1']);
});
