import {
  applyNotificationFrame,
  applyNotificationList,
  initialPentacleStreamState,
} from 'pentacle-chat-core';
import type { PentacleNotification, PentacleStreamState } from 'pentacle-chat-core';

jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function notification(overrides: Partial<PentacleNotification> = {}): PentacleNotification {
  return {
    notification_id: 'n1',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'altum',
    severity: 'info',
    title: 'Title',
    body: 'Body',
    dedup_key: 'dk-1',
    state: 'open',
    actions: [{ kind: 'ack', action_id: 'a0' }],
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

function buildState(overrides: Partial<PentacleStreamState> = {}): PentacleStreamState {
  return { ...initialPentacleStreamState, ...overrides };
}

test('applyNotificationFrame prepends a new notification', () => {
  const state = buildState();
  const next = applyNotificationFrame(state, notification({ notification_id: 'n1' }));
  expect(next.notifications.map((n) => n.notification_id)).toEqual(['n1']);
  expect(next).not.toBe(state);
});

test('applyNotificationFrame upserts (replaces existing by id, keeps newest-first)', () => {
  const older = notification({ notification_id: 'n1', created_at: '2026-05-25T11:00:00.000Z', state: 'open' });
  const newer = notification({ notification_id: 'n2', created_at: '2026-05-25T12:30:00.000Z' });
  const state = buildState({ notifications: [newer, older] });

  // A new record with a later created_at prepends.
  const newest = notification({ notification_id: 'n3', created_at: '2026-05-25T13:00:00.000Z' });
  const afterNew = applyNotificationFrame(state, newest);
  expect(afterNew.notifications.map((n) => n.notification_id)).toEqual(['n3', 'n2', 'n1']);

  // Replacing n1 in place updates the record without duplicating.
  const resolvedN1 = notification({ notification_id: 'n1', created_at: '2026-05-25T11:00:00.000Z', state: 'acked' });
  const afterReplace = applyNotificationFrame(afterNew, resolvedN1);
  expect(afterReplace.notifications.map((n) => n.notification_id)).toEqual(['n3', 'n2', 'n1']);
  expect(afterReplace.notifications.find((n) => n.notification_id === 'n1')?.state).toBe('acked');
});

test('applyNotificationFrame ignores records with no id', () => {
  const state = buildState({ notifications: [notification()] });
  expect(applyNotificationFrame(state, undefined)).toBe(state);
  expect(applyNotificationFrame(state, { ...notification(), notification_id: '' })).toBe(state);
});

test('applyNotificationList replaces the slice newest-first', () => {
  const state = buildState({ notifications: [notification({ notification_id: 'old' })] });
  const next = applyNotificationList(state, [
    notification({ notification_id: 'a', created_at: '2026-05-25T10:00:00.000Z' }),
    notification({ notification_id: 'b', created_at: '2026-05-25T14:00:00.000Z' }),
    notification({ notification_id: 'c', created_at: '2026-05-25T12:00:00.000Z' }),
  ]);
  expect(next.notifications.map((n) => n.notification_id)).toEqual(['b', 'c', 'a']);
});

test('applyNotificationList with non-array clears the slice', () => {
  const state = buildState({ notifications: [notification()] });
  expect(applyNotificationList(state, undefined).notifications).toEqual([]);
});
