import React from 'react';
import { act, render } from '@testing-library/react-native';
import TabLayout from '../../../app/(tabs)/_layout';
import { markRead } from '../../../src/hooks/useUnreadNotifications';

jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
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

beforeEach(() => {
  routerMock.tabScreens.mockClear();
  mockReceivedListener = undefined;
  markRead('system');
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

test('tab options render icons and read action', () => {
  render(<TabLayout />);
  const updates = routerMock.tabScreens.mock.calls.map((call: any[]) => call[0]).find((screen: any) => screen.name === 'updates');

  expect(updates.options.tabBarIcon({ color: 'red' })).toBeTruthy();
  updates.listeners.tabPress();
});

test('foreground unread changes do not re-render the Tabs navigator', () => {
  render(<TabLayout />);
  const updates = routerMock.tabScreens.mock.calls.map((call: any[]) => call[0]).find((screen: any) => screen.name === 'updates');
  const initialScreenConfigRenders = routerMock.tabScreens.mock.calls.length;
  const icon = render(updates.options.tabBarIcon({ color: 'red' }));

  expect(icon.queryByTestId('updates-unread-dot')).toBeNull();

  act(() => {
    mockReceivedListener?.({ request: { content: { data: { agent_id: 'system' } } } });
  });

  expect(icon.getByTestId('updates-unread-dot')).toBeTruthy();
  expect(routerMock.tabScreens.mock.calls.length).toBe(initialScreenConfigRenders);

  act(() => {
    updates.listeners.tabPress();
  });

  expect(icon.queryByTestId('updates-unread-dot')).toBeNull();
  expect(routerMock.tabScreens.mock.calls.length).toBe(initialScreenConfigRenders);
});
