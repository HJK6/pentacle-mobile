import { act, renderHook } from '@testing-library/react-native';

let mockAppStateListener: ((state: string) => void) | undefined;
const mockRemove = jest.fn();
const mockAddEventListener = jest.fn((_event: string, listener: (state: string) => void) => {
  mockAppStateListener = listener;
  return { remove: mockRemove };
});

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'AppState') return {
      currentState: 'background',
      addEventListener: mockAddEventListener,
      };
      return target[prop as keyof typeof target];
    },
  });
});

import useAutoRefresh from '../../src/hooks/useAutoRefresh';

beforeEach(() => {
  mockAppStateListener = undefined;
  mockRemove.mockClear();
  mockAddEventListener.mockClear();
});

test('fires the callback when AppState becomes active', () => {
  jest.useFakeTimers();
  const fetchFn = jest.fn();

  renderHook(() => useAutoRefresh(fetchFn, { intervalMs: 1000 }));

  act(() => {
    mockAppStateListener?.('active');
  });

  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test('stops the interval when disabled or backgrounded', () => {
  jest.useFakeTimers();
  const fetchFn = jest.fn();

  let enabled = true;
  const { rerender } = renderHook(() => useAutoRefresh(fetchFn, { enabled, intervalMs: 1000 }));

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);

  enabled = false;
  rerender(undefined);
  act(() => {
    jest.advanceTimersByTime(1000);
    mockAppStateListener?.('background');
  });

  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test('cleans up the AppState listener on unmount', () => {
  jest.useFakeTimers();
  const { unmount } = renderHook(() => useAutoRefresh(jest.fn(), { intervalMs: 1000 }));

  unmount();

  expect(mockRemove).toHaveBeenCalledTimes(1);
});
