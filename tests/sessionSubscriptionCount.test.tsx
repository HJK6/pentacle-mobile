import React from 'react';
import { act, render } from '@testing-library/react-native';

import usePentacleToken from '../src/hooks/usePentacleToken';

let mockParams: Record<string, unknown> = { streamId: 'hostc%3Acodex%3Aone' };
let mockIsFocused = true;

jest.mock('expo-notifications', () => ({}));
jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) };
      if (prop === 'InteractionManager') return { runAfterInteractions: jest.fn((callback: () => void) => {
        callback();
        return { cancel: jest.fn() };
      }) };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => {
  const mock = require('./helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: () => [false, jest.fn()],
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockParams = { streamId: 'hostc%3Acodex%3Aone' };
  mockIsFocused = true;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
});

afterEach(() => {
  jest.useRealTimers();
});

test('session screen stream subscriptions are focus-gated and do not leak across blur, navigation, and unmount', () => {
  const stream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const SessionScreen = require('../app/pentacle/session/[streamId]').default as React.ComponentType;
  const before = stream.__getPentacleStreamSubscriberCountForTests();

  const rendered = render(<SessionScreen />);
  const focusedDelta = stream.__getPentacleStreamSubscriberCountForTests() - before;
  expect(focusedDelta).toBeGreaterThan(0);

  mockIsFocused = false;
  act(() => {
    rendered.rerender(<SessionScreen />);
  });
  expect(stream.__getPentacleStreamSubscriberCountForTests()).toBe(before);

  mockIsFocused = true;
  mockParams = { streamId: 'hostc%3Acodex%3Atwo' };
  act(() => {
    rendered.rerender(<SessionScreen />);
  });
  expect(stream.__getPentacleStreamSubscriberCountForTests() - before).toBeLessThanOrEqual(focusedDelta);

  rendered.unmount();
  expect(stream.__getPentacleStreamSubscriberCountForTests()).toBe(before);
});

