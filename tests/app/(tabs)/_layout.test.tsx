import React from 'react';
import { act, render } from '@testing-library/react-native';
import TabLayout from '../../../app/(tabs)/_layout';

jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('../../../src/hooks/useUnreadNotifications', () => ({
  markRead: jest.fn(),
  useHasUnreadNotification: jest.fn(() => true),
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

let mockReceivedListener: ((notification: any) => void) | undefined;
const mockRemove = jest.fn();

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn((listener) => {
    mockReceivedListener = listener;
    return { remove: mockRemove };
  }),
}));

const routerMock = require('expo-router').__mock;

const { markRead } = require('../../../src/hooks/useUnreadNotifications');

beforeEach(() => {
  routerMock.tabScreens.mockClear();
  (markRead as jest.Mock).mockClear();
  mockReceivedListener = undefined;
});

test('cold renders tab labels', () => {
  render(<TabLayout />);

  expect(routerMock.tabScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'unified' }));
  expect(routerMock.tabScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'chats' }));
  expect(routerMock.tabScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'dashboards' }));
  expect(routerMock.tabScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'updates' }));
  expect(routerMock.tabScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'settings' }));
  expect(routerMock.tabScreens.mock.calls.map((call: any[]) => call[0].name)).toEqual([
    'unified',
    'chats',
    'dashboards',
    'updates',
    'settings',
  ]);
});

test('the updates slot is the Bart status tab: label, icon, no read action', () => {
  render(<TabLayout />);
  const updates = routerMock.tabScreens.mock.calls.map((call: any[]) => call[0]).find((screen: any) => screen.name === 'updates');

  expect(updates.options.title).toBe('Bart');
  expect(updates.options.tabBarLabel).toBe('BART');
  expect(updates.options.tabBarIcon({ color: 'red' })).toBeTruthy();
  updates.listeners.tabPress();
  expect(markRead).not.toHaveBeenCalled();
});

test('the Bart status tab carries no notifications unread dot, even with unread system notifications', () => {
  render(<TabLayout />);
  const updates = routerMock.tabScreens.mock.calls.map((call: any[]) => call[0]).find((screen: any) => screen.name === 'updates');
  const initialScreenConfigRenders = routerMock.tabScreens.mock.calls.length;
  const icon = render(updates.options.tabBarIcon({ color: 'red' }));

  expect(icon.queryByTestId('updates-unread-dot')).toBeNull();

  act(() => {
    mockReceivedListener?.({ request: { content: { data: { agent_id: 'system' } } } });
  });

  expect(icon.queryByTestId('updates-unread-dot')).toBeNull();
  expect(routerMock.tabScreens.mock.calls.length).toBe(initialScreenConfigRenders);
});
