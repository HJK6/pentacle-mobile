import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Switch } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SettingsScreen from '../app/(tabs)/settings';
import usePentacleToken from '../src/hooks/usePentacleToken';
import useLimits from '../src/hooks/useLimits';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import {
  __resetUserPreferencesForTests,
  USER_PREFERENCES_STORAGE_KEY,
} from '../src/services/userPreferences';

const mockStorage: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage[key] ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockStorage[key] = value;
  }),
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/hooks/useLimits', () => ({
  __esModule: true,
  default: jest.fn(),
  useLimitsHealth: jest.fn(),
}));
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  mockAsyncStorage.getItem.mockClear();
  mockAsyncStorage.setItem.mockClear();
  mockAsyncStorage.getItem.mockImplementation(async (key: string) => mockStorage[key] ?? null);
  mockAsyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
    mockStorage[key] = value;
  });
  __resetUserPreferencesForTests();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test', clearToken: jest.fn() });
  (useLimits as jest.Mock).mockReturnValue([
    { id: 'claude', label: 'Claude', pct: 21, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'fable', label: 'Fable', pct: 31, resets_at_iso: null, resets_text: 'Sunday' },
    { id: 'codex', label: 'Codex', pct: 34, resets_at_iso: null, resets_text: 'Saturday' },
  ]);
  (usePentacleStreamActions as jest.Mock).mockReturnValue({ reconnect: jest.fn() });
  (usePentacleStreamSelectorWhen as jest.Mock).mockReturnValue([{
    host: 'hostc',
    title: 'hostc',
    online: true,
    sessionCount: 1,
    statusLabel: 'Online',
    stats: { ok: true, cpuPct: 10, memPct: 20, diskPct: 30, diskFreeGb: 40, load: '1.0', uptime: 'up 1 day, 1 user' },
  }]);
});

test('renders the Show tool actions settings row', () => {
  mockAsyncStorage.getItem.mockReturnValueOnce(new Promise(() => undefined));
  render(<SettingsScreen />);

  expect(screen.getByText('Show tool actions')).toBeTruthy();
  expect(screen.getByText('Show "Explored", "Read file", and other tool events in chats.')).toBeTruthy();
  expect(screen.getByText('Show turn duration')).toBeTruthy();
  expect(screen.getByText('Show "Worked for" divider rows after completed agent turns.')).toBeTruthy();
});

test('show tool actions toggle persists and hydrates across remount', async () => {
  mockAsyncStorage.getItem.mockReturnValueOnce(new Promise(() => undefined));
  const rendered = render(<SettingsScreen />);

  const showToolActionsSwitch = () => rendered.UNSAFE_getAllByType(Switch)[0];
  expect(showToolActionsSwitch().props.value).toBe(false);

  await act(async () => {
    await showToolActionsSwitch().props.onValueChange(true);
  });

  await waitFor(() => expect(showToolActionsSwitch().props.value).toBe(true));
  expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
    USER_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ showToolActions: true, showTurnDuration: false }),
  );

  rendered.unmount();
  __resetUserPreferencesForTests();
  const remounted = render(<SettingsScreen />);

  await waitFor(() => expect(remounted.UNSAFE_getAllByType(Switch)[0].props.value).toBe(true));
});

test('show turn duration toggle persists through AsyncStorage', async () => {
  mockAsyncStorage.getItem.mockReturnValueOnce(new Promise(() => undefined));
  const rendered = render(<SettingsScreen />);

  const showTurnDurationSwitch = () => rendered.UNSAFE_getAllByType(Switch)[1];
  expect(showTurnDurationSwitch().props.value).toBe(false);

  await act(async () => {
    await showTurnDurationSwitch().props.onValueChange(true);
  });

  await waitFor(() => expect(showTurnDurationSwitch().props.value).toBe(true));
  expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
    USER_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ showToolActions: false, showTurnDuration: true }),
  );
});

