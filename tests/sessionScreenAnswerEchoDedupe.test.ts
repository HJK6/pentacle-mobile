import {
  formatNotificationAnswerTellItem,
  fullyCoveredAnswerNotificationIds,
  suppressLocalQuestionAnswerEchoes,
} from '../app/pentacle/session/[streamId]';
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

function userRow(id: string, text: string): PentacleTranscriptItem {
  return {
    id,
    timestampLabel: '',
    label: 'You',
    tone: 'user',
    provider: 'codex',
    source: 'chat',
    text,
    kind: 'USER',
    isUser: true,
    eventCase: 'user-message',
    displayRule: 'bubble:user',
  };
}

// The daemon echoes each answered question back into the producer's stream as a tell, which the
// transcript renders as its own `agent-question-answer` row. That row duplicates the authoritative
// resolved-notification projection, so it is dropped — but ONLY when the notification is fully
// covered. answer_notification_rendering_contract.

test('a single-question notification with its one answer projected is fully covered', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-single', childCount: 1 },
  ]);
  expect(covered.has('q-single')).toBe(true);
});

test('a PARTIALLY answered multi-question notification is not covered — the echo survives', () => {
  // Two children, one projected. The echo carries no child identity, so suppressing it here
  // could erase the only representation of the other child's answer.
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-multi', childCount: 2 },
  ]);
  expect(covered.has('q-multi')).toBe(false);
});

test('a fully answered multi-question notification is covered', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-multi', childCount: 2 },
    { notificationId: 'q-multi', childCount: 2 },
  ]);
  expect(covered.has('q-multi')).toBe(true);
});

test('no projections cover nothing, so every echo is preserved', () => {
  expect(fullyCoveredAnswerNotificationIds([]).size).toBe(0);
});

test('a projection without a notification id never suppresses anything', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: '', childCount: 1 },
    { childCount: 1 },
  ]);
  expect(covered.size).toBe(0);
});

test('a projection reporting no children never suppresses — coverage cannot be proven', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-unknown-shape', childCount: 0 },
  ]);
  expect(covered.has('q-unknown-shape')).toBe(false);
});

test('coverage is tracked per notification, never pooled across them', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-a', childCount: 2 },
    { notificationId: 'q-b', childCount: 1 },
  ]);
  // q-a is half covered even though the total projection count equals its child count.
  expect(covered.has('q-a')).toBe(false);
  expect(covered.has('q-b')).toBe(true);
});

test('a fully covered local durable projection suppresses its queued echo after it is no longer pending', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-local', childCount: 1 },
  ]);
  const rows = suppressLocalQuestionAnswerEchoes([
    { eventCase: 'agent-question-answer', notificationId: 'q-local' },
    { eventCase: 'agent-question-answer', notificationId: 'q-other' },
    { eventCase: 'plain-user', notificationId: 'q-local' },
  ], covered);

  expect(rows).toEqual([
    { eventCase: 'agent-question-answer', notificationId: 'q-other' },
    { eventCase: 'plain-user', notificationId: 'q-local' },
  ]);
});

test('a partial local projection preserves another answer echo from the same notification', () => {
  const covered = fullyCoveredAnswerNotificationIds([
    { notificationId: 'q-multi', childCount: 2 },
  ]);
  const rows = suppressLocalQuestionAnswerEchoes([
    { eventCase: 'agent-question-answer', notificationId: 'q-multi' },
  ], covered);

  expect(rows).toEqual([
    { eventCase: 'agent-question-answer', notificationId: 'q-multi' },
  ]);
});

test.each([
  ['1199232', 'eb1cd5d5-5f29-4848-85dd-d3ea061666de', 'Do we need the historical keys?'],
  ['1199254', '5809a83c-0418-46ed-9e28-3eee446cf2ee', 'Example User is already configured.'],
])('line-protocol answer-back event %s is formatted and joined by notification_id', (id, notificationId, answer) => {
  const formatted = formatNotificationAnswerTellItem(userRow(
    id,
    `[notification.answer]\nnotification_id=${notificationId}\ncustom_text=${answer}\nby=client:pentacle-mobile`,
  ));

  expect(formatted).toMatchObject({
    id,
    eventCase: 'agent-question-answer',
    displayRule: 'activity:question',
    notificationId,
    text: `Operator answered: ${answer}`,
    isUser: false,
  });
  expect(suppressLocalQuestionAnswerEchoes([formatted], new Set([notificationId]))).toEqual([]);
});

test('ordinary USER text and malformed answer-back text stay untouched', () => {
  const ordinary = userRow('ordinary', 'notification_id=not-a-protocol-row');
  const missingIdentity = userRow('missing', '[notification.answer]\ncustom_text=hello');
  expect(formatNotificationAnswerTellItem(ordinary)).toBe(ordinary);
  expect(formatNotificationAnswerTellItem(missingIdentity)).toBe(missingIdentity);
});

