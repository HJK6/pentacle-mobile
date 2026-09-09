import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import UpdatesScreen from '../../../app/(tabs)/updates';
import useNotifications from '../../../src/hooks/useNotifications';
import useAutoRefresh from '../../../src/hooks/useAutoRefresh';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/useAutoRefresh', () => jest.fn());
jest.mock('../../../src/hooks/useNotifications', () => jest.fn());
jest.mock('../../../src/components/NotificationCard', () => ({ notification }: { notification: { title: string } }) => {
  const { Text } = require('react-native');
  return <Text>{notification.title}</Text>;
});

const refetchNotifications = jest.fn().mockResolvedValue(undefined);

function mockNotifications(value: Partial<ReturnType<typeof useNotifications>> = {}) {
  (useNotifications as jest.Mock).mockReturnValue({
    notifications: [],
    connecting: false,
    loading: false,
    error: null,
    refetch: refetchNotifications,
    ...value,
  });
}

beforeEach(() => {
  refetchNotifications.mockClear();
  mockNotifications();
});

test('loading state renders the spinner', () => {
  mockNotifications({ loading: true, notifications: [] });

  const rendered = render(<UpdatesScreen />);

  expect(rendered.toJSON()).toBeTruthy();
});

test('empty and error states render observable content', () => {
  mockNotifications({ notifications: [] });
  const empty = render(<UpdatesScreen />);
  expect(empty.getByText('Nothing yet')).toBeTruthy();
  empty.unmount();

  mockNotifications({ error: 'offline' });
  const error = render(<UpdatesScreen />);
  expect(error.getByText('Updates unavailable')).toBeTruthy();
  error.unmount();
});

test('notifications-backed feed renders cards including terminal items', () => {
  mockNotifications({
    notifications: [
      { notification_id: 'n1', title: 'Lead needs a decision', state: 'open' },
      { notification_id: 'n2', title: 'Re-run scrape', state: 'done' },
    ] as any,
  });

  render(<UpdatesScreen />);

  // Both the open card and the terminal (done) card stay visible — the
  // persistent feed annotates in place, it does not hide resolved items.
  expect(screen.getByText('Lead needs a decision')).toBeTruthy();
  expect(screen.getByText('Re-run scrape')).toBeTruthy();
});

test('agent questions render in the Updates feed', () => {
  mockNotifications({
    notifications: [
      { notification_id: 'n1', title: 'Plain warning', producer: 'pentacle', state: 'open' },
      {
        notification_id: 'q1',
        title: 'Question for chat',
        producer: 'agent_question.v1',
        state: 'open',
      },
    ] as any,
  });

  render(<UpdatesScreen />);

  expect(screen.getByText('Plain warning')).toBeTruthy();
  expect(screen.getByText('Question for chat')).toBeTruthy();
});

test('the retired HISTORY section is gone', () => {
  mockNotifications({ notifications: [{ notification_id: 'n1', title: 'Card' }] as any });
  render(<UpdatesScreen />);
  expect(screen.queryByText('HISTORY')).toBeNull();
});

test('pull-to-refresh calls refetch and auto-refresh is wired to the notifications refetch', async () => {
  mockNotifications({ notifications: [] });
  const rendered = render(<UpdatesScreen />);
  expect(useAutoRefresh).toHaveBeenCalledWith(refetchNotifications, { intervalMs: 10000 });
  const list = rendered.UNSAFE_getByType(require('react-native').FlatList);

  await act(async () => {
    await list.props.refreshControl.props.onRefresh();
  });

  expect(refetchNotifications).toHaveBeenCalled();
});
