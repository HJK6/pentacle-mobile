import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __getUserPreferencesHydratedForTests,
  __resetUserPreferencesForTests,
  getUserPreference,
  setUserPreference,
  subscribeUserPreferences,
  useUserPreference,
  USER_PREFERENCES_STORAGE_KEY,
} from '../src/services/userPreferences';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  mockAsyncStorage.getItem.mockReset();
  mockAsyncStorage.setItem.mockReset();
  mockAsyncStorage.getItem.mockResolvedValue(null);
  mockAsyncStorage.setItem.mockResolvedValue(undefined);
  __resetUserPreferencesForTests();
});

test('returns the default before async hydration resolves', async () => {
  let resolveGetItem: (value: string | null) => void = () => undefined;
  mockAsyncStorage.getItem.mockReturnValueOnce(new Promise((resolve) => {
    resolveGetItem = resolve;
  }));

  expect(getUserPreference('showToolActions')).toBe(false);
  expect(getUserPreference('showTurnDuration')).toBe(false);
  expect(__getUserPreferencesHydratedForTests()).toBe(false);

  resolveGetItem(JSON.stringify({ showToolActions: true }));

  await waitFor(() => expect(getUserPreference('showToolActions')).toBe(true));
  expect(__getUserPreferencesHydratedForTests()).toBe(true);
});

test('sets and gets a preference key', async () => {
  await act(async () => {
    await setUserPreference('showToolActions', true);
    await setUserPreference('showTurnDuration', true);
  });

  expect(getUserPreference('showToolActions')).toBe(true);
  expect(getUserPreference('showTurnDuration')).toBe(true);
});

test('persists preference updates to AsyncStorage', async () => {
  await act(async () => {
    await setUserPreference('showToolActions', true);
  });

  expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
    USER_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ showToolActions: true, showTurnDuration: false }),
  );
});

test('notifies listeners when a preference changes', async () => {
  mockAsyncStorage.getItem.mockReturnValue(new Promise(() => undefined));
  const listener = jest.fn();
  const unsubscribe = subscribeUserPreferences(listener);
  listener.mockClear();

  await act(async () => {
    await setUserPreference('showToolActions', true);
  });

  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test('useUserPreference reads and updates the selected key', async () => {
  mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify({ showToolActions: true }));

  const { result } = renderHook(() => useUserPreference('showToolActions'));

  await waitFor(() => expect(result.current[0]).toBe(true));

  await act(async () => {
    await result.current[1](false);
  });

  expect(result.current[0]).toBe(false);
  expect(mockAsyncStorage.setItem).toHaveBeenLastCalledWith(
    USER_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ showToolActions: false, showTurnDuration: false }),
  );
});

test('hydrates showTurnDuration only from a boolean value', async () => {
  mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify({
    showToolActions: true,
    showTurnDuration: true,
  }));

  await waitFor(() => expect(getUserPreference('showTurnDuration')).toBe(true));

  __resetUserPreferencesForTests();
  mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify({
    showToolActions: true,
    showTurnDuration: 'yes',
  }));

  expect(getUserPreference('showTurnDuration')).toBe(false);
  await waitFor(() => expect(__getUserPreferencesHydratedForTests()).toBe(true));
  expect(getUserPreference('showTurnDuration')).toBe(false);
});
