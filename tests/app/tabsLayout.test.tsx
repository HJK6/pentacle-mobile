import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => require('../helpers/mocks/expoRouter').makeMock());
jest.mock('../../src/hooks/useUnreadNotifications', () => ({
  markRead: jest.fn(),
  useHasUnreadNotification: jest.fn(() => false),
}));
jest.mock('../../src/services/mobileTabsTelemetry', () => ({
  logTabPressed: jest.fn(),
}));

function routerMock() {
  return require('expo-router').__mock;
}

test('bottom tabs show Agents and hide Unified', () => {
  const TabLayout = require('../../app/(tabs)/_layout').default;
  render(<TabLayout />);

  expect(routerMock().tabScreens).toHaveBeenCalledWith(expect.objectContaining({
    name: 'chats',
    options: expect.objectContaining({ title: 'Agents', tabBarLabel: 'AGENTS' }),
  }));
  expect(routerMock().tabScreens).toHaveBeenCalledWith(expect.objectContaining({
    name: 'unified',
    options: expect.objectContaining({ href: null }),
  }));
  expect(routerMock().tabScreens).not.toHaveBeenCalledWith(expect.objectContaining({
    name: 'unified',
    options: expect.objectContaining({ tabBarLabel: 'UNIFIED' }),
  }));
});
