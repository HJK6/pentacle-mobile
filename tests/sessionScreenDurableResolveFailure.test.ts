import { failedDurableAnswerProjectionKeys } from '../app/pentacle/session/[streamId]';
import type { PentacleNotification } from 'pentacle-chat-core';

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

type Projection = {
  key: string;
  source: 'pane' | 'durable';
  pending: boolean;
  notificationId?: string;
};

function projections(list: Projection[]): Record<string, Projection> {
  return Object.fromEntries(list.map((p) => [p.key, p]));
}

function notif(notification_id: string, error?: string): PentacleNotification & { client_resolution_error?: string } {
  return { notification_id, ...(error ? { client_resolution_error: error } : {}) } as PentacleNotification & { client_resolution_error?: string };
}

// spec_pentacle_mobile__durable_question_optimistic_row_on_resolve_failure:
// an offline durable resolve settles an optimistic in-chat answer bubble that
// auto-replays. When the replay fails terminally (daemon 1012 / replay-window
// expiry) the notification surfaces `client_resolution_error`, but nothing
// discarded the settled bubble — it stayed stale and the card never re-showed.

test('a settled durable projection whose notification failed terminally is flagged for discard', () => {
  const keys = failedDurableAnswerProjectionKeys(
    projections([{ key: 'durable:n1:q', source: 'durable', pending: false, notificationId: 'n1' }]),
    [notif('n1', 'client_resolution_error: replay window expired')],
  );
  expect(keys).toEqual(['durable:n1:q']);
});

test('a still-pending durable projection is NOT discarded (an in-flight re-answer must survive)', () => {
  const keys = failedDurableAnswerProjectionKeys(
    projections([{ key: 'durable:n1:q', source: 'durable', pending: true, notificationId: 'n1' }]),
    [notif('n1', 'boom')],
  );
  expect(keys).toEqual([]);
});

test('a durable projection whose notification has no error is left alone', () => {
  const keys = failedDurableAnswerProjectionKeys(
    projections([{ key: 'durable:n1:q', source: 'durable', pending: false, notificationId: 'n1' }]),
    [notif('n1')],
  );
  expect(keys).toEqual([]);
});

test('a pane-source projection is never discarded by this path (pane handles its own failure)', () => {
  const keys = failedDurableAnswerProjectionKeys(
    projections([{ key: 'pane:s', source: 'pane', pending: false, notificationId: 'n1' }]),
    [notif('n1', 'boom')],
  );
  expect(keys).toEqual([]);
});

test('only the failed notification\'s durable rows are flagged', () => {
  const keys = failedDurableAnswerProjectionKeys(
    projections([
      { key: 'durable:n1:q', source: 'durable', pending: false, notificationId: 'n1' },
      { key: 'durable:n2:q', source: 'durable', pending: false, notificationId: 'n2' },
    ]),
    [notif('n1', 'boom'), notif('n2')],
  );
  expect(keys).toEqual(['durable:n1:q']);
});

test('no notifications and no projections yields nothing', () => {
  expect(failedDurableAnswerProjectionKeys({}, [])).toEqual([]);
});
