import { act, renderHook } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import useUnreadNotifications, { markRead } from '../../src/hooks/useUnreadNotifications';

let mockReceivedListener: ((notification: any) => void) | undefined;
const mockRemove = jest.fn();

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn((listener) => {
    mockReceivedListener = listener;
    return { remove: mockRemove };
  }),
}));

beforeEach(() => {
  markRead('system');
  markRead('alpha');
  mockRemove.mockClear();
  (Notifications.addNotificationReceivedListener as jest.Mock).mockClear();
});

test('increments unread state on inbound notification', () => {
  const { result } = renderHook(() => useUnreadNotifications());

  act(() => {
    mockReceivedListener?.({ request: { content: { data: { agent_id: 'system' } } } });
  });

  expect(result.current.hasUnread('system')).toBe(true);
  expect(result.current.hasUnreadUpdates).toBe(true);
});

test('clears unread state when an agent is marked read', () => {
  const { result } = renderHook(() => useUnreadNotifications());

  act(() => {
    mockReceivedListener?.({ request: { content: { data: { agent_id: 'alpha' } } } });
  });
  expect(result.current.hasUnread('alpha')).toBe(true);

  act(() => {
    markRead('alpha');
  });

  expect(result.current.hasUnread('alpha')).toBe(false);
});

test('ignores notifications without an agent id', () => {
  const { result } = renderHook(() => useUnreadNotifications());

  act(() => {
    mockReceivedListener?.({ request: { content: { data: {} } } });
  });

  expect(result.current.unreadAgentIds.size).toBe(0);
});

test('ignores notifications with missing data payload', () => {
  const { result } = renderHook(() => useUnreadNotifications());

  act(() => {
    mockReceivedListener?.({ request: { content: {} } });
  });

  expect(result.current.unreadAgentIds.size).toBe(0);
});

test('ignores agent question notifications for the updates unread dot', () => {
  const { result } = renderHook(() => useUnreadNotifications());

  act(() => {
    mockReceivedListener?.({
      request: {
        content: {
          data: {
            agent_id: 'system',
            producer: 'agent_question.v1',
          },
        },
      },
    });
  });

  expect(result.current.hasUnread('system')).toBe(false);
  expect(result.current.hasUnreadUpdates).toBe(false);
});

test('ignores legacy sender-marked agent question pushes for the updates unread dot', () => {
  const { result } = renderHook(() => useUnreadNotifications());

  act(() => {
    mockReceivedListener?.({
      request: {
        content: {
          data: {
            agent_id: 'system',
            sender: 'agent_question.v1',
          },
        },
      },
    });
  });

  expect(result.current.hasUnread('system')).toBe(false);
  expect(result.current.hasUnreadUpdates).toBe(false);
});

test('removes notification listener on unmount', () => {
  const { unmount } = renderHook(() => useUnreadNotifications());

  unmount();

  expect(Notifications.addNotificationReceivedListener).toHaveBeenCalled();
  expect(mockRemove).toHaveBeenCalled();
});

test('shares native listener until the final subscriber unmounts', () => {
  const first = renderHook(() => useUnreadNotifications());
  const second = renderHook(() => useUnreadNotifications());

  expect(Notifications.addNotificationReceivedListener).toHaveBeenCalledTimes(1);
  first.unmount();
  expect(mockRemove).not.toHaveBeenCalled();
  second.unmount();
  expect(mockRemove).toHaveBeenCalledTimes(1);
});
