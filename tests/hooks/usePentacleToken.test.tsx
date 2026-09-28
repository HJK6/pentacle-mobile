import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockPlatform = { OS: 'ios' };
const mockAppStateListeners = new Set<(state: string) => void>();
const mockAppState = {
  currentState:'active',
  addEventListener:jest.fn((_event,listener) => {
    mockAppStateListeners.add(listener);
    return {remove:() => mockAppStateListeners.delete(listener)};
  }),
};
function emitAppState(state: string) {
  mockAppState.currentState = state;
  mockAppStateListeners.forEach(listener => listener(state));
}

const mockSetPentacleAuthToken = jest.fn();
const mockSetPentacleWsUrl = jest.fn();
const mockGetPentacleWsUrl = jest.fn(() => 'ws://stored.example/ws');
let mockBackendWsUrl = 'ws://default.example/ws';
let mockHarnessArmed = false;
let mockHarnessActions = new Set<string>();
let mockHarnessParams = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Platform') return mockPlatform;
      if (prop === 'AppState') return mockAppState;
      return target[prop as keyof typeof target];
    },
  });
});

jest.mock('../../src/config/local', () => ({
  getBackendWsUrl: () => mockBackendWsUrl,
}));

jest.mock('../../src/services/pentacleStream', () => ({
  getPentacleWsUrl: mockGetPentacleWsUrl,
  setPentacleAuthToken: mockSetPentacleAuthToken,
  setPentacleWsUrl: mockSetPentacleWsUrl,
}));

function loadHook() {
  jest.resetModules();
  jest.doMock('react', () => React);
  jest.doMock('../../src/utils/harnessRuntime', () => ({
    isArmed: jest.fn(() => mockHarnessArmed),
    hasAction: jest.fn((action: string) => mockHarnessActions.has(action)),
    getParam: jest.fn((name: string) => mockHarnessParams.get(name)),
  }));
  const hook = require('../../src/hooks/usePentacleToken').default as typeof import('../../src/hooks/usePentacleToken').default;
  const secureStore = require('expo-secure-store');
  secureStore.getItemAsync.mockResolvedValue(null);
  secureStore.setItemAsync.mockResolvedValue(undefined);
  secureStore.deleteItemAsync.mockResolvedValue(undefined);
  return hook;
}

function secureStore() {
  return require('expo-secure-store');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.OS = 'ios';
  mockAppState.currentState = 'active';
  mockAppStateListeners.clear();
  mockGetPentacleWsUrl.mockReturnValue('ws://stored.example/ws');
  mockBackendWsUrl = 'ws://default.example/ws';
  mockHarnessArmed = false;
  mockHarnessActions = new Set();
  mockHarnessParams = new Map();
  delete process.env.EXPO_PUBLIC_HARNESS;
});

test('harness ws_url param overrides stored ws url while preserving auth flow', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockHarnessArmed = true;
  mockHarnessParams = new Map([['ws_url', 'ws://127.0.0.1:9123']]);
  mockGetPentacleWsUrl.mockReturnValue('ws://127.0.0.1:9123');
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('token-123')
    .mockResolvedValueOnce('ws://saved.example/ws');

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('token-123'));
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith('token-123');
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://127.0.0.1:9123');
  expect(result.current.wsUrl).toBe('ws://127.0.0.1:9123');
});

test('harness pentacle_token param overrides stored token for local daemon auth', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockHarnessArmed = true;
  mockHarnessParams = new Map([
    ['ws_url', 'ws://127.0.0.1:9123'],
    ['pentacle_token', 'scratch-token-123'],
  ]);
  mockGetPentacleWsUrl.mockReturnValue('ws://127.0.0.1:9123');
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('stored-token')
    .mockResolvedValueOnce('ws://saved.example/ws');

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('scratch-token-123'));
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith('scratch-token-123');
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://127.0.0.1:9123');
});

test('explicit harness token wins over the auth-disabled action for authenticated local daemons', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockHarnessArmed = true;
  mockHarnessActions = new Set(['disable_pentacle_auth']);
  mockHarnessParams = new Map([
    ['ws_url', 'ws://127.0.0.1:9123'],
    ['pentacle_token', 'scratch-token-123'],
  ]);
  mockGetPentacleWsUrl.mockReturnValue('ws://127.0.0.1:9123');
  const usePentacleToken = loadHook();

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('scratch-token-123'));
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith('scratch-token-123');
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://127.0.0.1:9123');
});

test('armed reload applies after an in-flight pre-arm SecureStore load', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  let resolveStoredToken: ((value: string | null) => void) | undefined;
  const storedToken = new Promise<string | null>((resolve) => {
    resolveStoredToken = resolve;
  });
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockImplementationOnce(() => storedToken)
    .mockResolvedValueOnce('ws://saved.example/ws');
  renderHook(() => usePentacleToken());
  await waitFor(() => expect(secureStore().getItemAsync).toHaveBeenCalledTimes(1));

  mockHarnessArmed = true;
  mockHarnessActions = new Set(['disable_pentacle_auth']);
  mockHarnessParams = new Map([['ws_url', 'ws://127.0.0.1:9123']]);
  const { reloadPentacleToken } = require('../../src/hooks/usePentacleToken') as typeof import('../../src/hooks/usePentacleToken');
  await act(async () => {
    const reload = reloadPentacleToken();
    resolveStoredToken?.('stored-token');
    await reload;
  });

  expect(mockSetPentacleAuthToken).toHaveBeenLastCalledWith(null);
  expect(mockSetPentacleWsUrl).toHaveBeenLastCalledWith('ws://127.0.0.1:9123');
});

test('treats an absent token as ready but unenrolled', async () => {
  const usePentacleToken = loadHook();

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.isReady).toBe(true));
  expect(result.current.token).toBeNull();
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith(null);
});

test('resolves a present token from SecureStore', async () => {
  mockGetPentacleWsUrl.mockReturnValueOnce('ws://saved.example/ws');
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('token-123')
    .mockResolvedValueOnce('ws://saved.example/ws');

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('token-123'));
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://saved.example/ws');
  // Production builds (no EXPO_PUBLIC_HARNESS) MUST keep the biometric gate
  // on the token keychain item — flipping it to false in production would
  // weaken token-at-rest protection. The harness exception is covered by
  // the two harness-mode tests below.
  expect(secureStore().getItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-token',
    expect.objectContaining({
      requireAuthentication: true,
      keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    }),
  );
});

test('saved endpoint survives a changed configured default with enrolled token intact', async () => {
  mockGetPentacleWsUrl.mockReturnValue('ws://127.0.0.3:7791');
  mockBackendWsUrl = 'ws://127.0.0.2:7791';
  const usePentacleToken = loadHook();
  secureStore().getItemAsync.mockResolvedValueOnce('enrolled-token').mockResolvedValueOnce('ws://127.0.0.3:7791');
  const { result } = renderHook(() => usePentacleToken());
  await waitFor(() => expect(result.current.token).toBe('enrolled-token'));
  expect(result.current.wsUrl).toBe('ws://127.0.0.3:7791');
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith('enrolled-token');
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://127.0.0.3:7791');
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalled();
});

test('sign-out clears the SecureStore token key', async () => {
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('token-123')
    .mockResolvedValueOnce(null);
  const { result } = renderHook(() => usePentacleToken());
  await waitFor(() => expect(result.current.isReady).toBe(true));

  await act(async () => {
    await result.current.clearToken();
  });

  expect(secureStore().deleteItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-token',
    expect.objectContaining({ keychainService: 'pentacle-stream-token' }),
  );
  expect(result.current.token).toBeNull();
});

test('setToken writes SecureStore and updates stream auth state', async () => {
  const usePentacleToken = loadHook();
  const { result } = renderHook(() => usePentacleToken());
  await waitFor(() => expect(result.current.isReady).toBe(true));

  await act(async () => {
    await result.current.setToken('next-token');
  });

  expect(secureStore().setItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-token',
    'next-token',
    expect.objectContaining({ keychainService: 'pentacle-stream-token' }),
  );
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith('next-token');
  expect(result.current.token).toBe('next-token');
});

test('setWsUrl stores non-empty values and clears blank values back to default', async () => {
  const usePentacleToken = loadHook();
  const { result } = renderHook(() => usePentacleToken());
  await waitFor(() => expect(result.current.isReady).toBe(true));

  await act(async () => {
    await result.current.setWsUrl('  ws://custom.example/ws  ');
  });

  expect(secureStore().setItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-ws-url',
    'ws://custom.example/ws',
    expect.objectContaining({ keychainService: 'pentacle-stream-ws-url' }),
  );
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://custom.example/ws');

  await act(async () => {
    await result.current.setWsUrl('   ');
  });

  expect(secureStore().deleteItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-ws-url',
    expect.objectContaining({ keychainService: 'pentacle-stream-ws-url' }),
  );
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://default.example/ws');
});

test('harness mode reads SecureStore without biometric gate when runtime is not armed', async () => {
  // Harness builds (EXPO_PUBLIC_HARNESS=1) MUST NOT trigger the iOS-level
  // "App wants to use Face ID" permission prompt — it blocks unattended e2e
  // device sweeps on first install. SecureStore.getItemAsync with
  // requireAuthentication=true on a protected keychain item is what fires
  // that prompt. The harness path uses the baked EXPO_PUBLIC_HARNESS_TOKEN
  // or auth-disabled sentinel and never needs biometric-protected reads, so
  // requireAuthentication is forced false in harness builds.
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('token-123')
    .mockResolvedValueOnce(null);

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('token-123'));
  expect(secureStore().getItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-token',
    expect.objectContaining({ requireAuthentication: false }),
  );
});

test('harness mode reads SecureStore without biometric gate when armed without disable auth action', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockHarnessArmed = true;
  mockHarnessActions = new Set(['force_ws_reconnect']);
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('token-123')
    .mockResolvedValueOnce(null);

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('token-123'));
  expect(secureStore().getItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-token',
    expect.objectContaining({ requireAuthentication: false }),
  );
});

test('harness mode exposes a sentinel token only when armed with disable auth action', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const usePentacleToken = loadHook();
  secureStore().getItemAsync
    .mockResolvedValueOnce('token-123')
    .mockResolvedValueOnce(null);
  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('token-123'));

  mockHarnessArmed = true;
  mockHarnessActions = new Set(['disable_pentacle_auth']);
  await act(async () => {
    await result.current.reload();
  });

  await waitFor(() => expect(result.current.token).toBe('__auth_disabled__'));
  await act(async () => {
    await result.current.setToken('ignored');
    await result.current.clearToken();
  });

  expect(secureStore().setItemAsync).not.toHaveBeenCalled();
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalledWith(
    'pentacle-stream-token',
    expect.anything(),
  );
});

test('harness install_device_token persists the credential and connects the real device path, outranking disable auth', async () => {
  // The simulator-enrollment path: a daemon-issued credential injected via the
  // -PentacleDeviceToken launch arg (surfaced as the install_device_token
  // harness param) is written to SecureStore and then used through the normal
  // device-credential connection path — so it authenticates against the live
  // daemon like a real phone, and it takes precedence over disable_pentacle_auth
  // even when the scenario also arms that action.
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockHarnessArmed = true;
  mockHarnessActions = new Set(['disable_pentacle_auth']);
  mockHarnessParams = new Map([
    ['ws_url', 'ws://127.0.0.2:7791'],
    ['install_device_token', 'pentacle-auth-v2:sim-envelope'],
  ]);
  mockGetPentacleWsUrl.mockReturnValue('ws://127.0.0.2:7791');
  const usePentacleToken = loadHook();

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.token).toBe('pentacle-auth-v2:sim-envelope'));
  // Persisted through the device-credential store (not the auth-disabled sentinel).
  expect(secureStore().setItemAsync).toHaveBeenCalledWith(
    'pentacle-stream-token',
    'pentacle-auth-v2:sim-envelope',
    expect.objectContaining({ keychainService: 'pentacle-stream-token' }),
  );
  expect(mockSetPentacleAuthToken).toHaveBeenCalledWith('pentacle-auth-v2:sim-envelope');
  expect(mockSetPentacleAuthToken).not.toHaveBeenCalledWith(null);
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://127.0.0.2:7791');
});

test('keeps a corrupt SecureStore read fail closed with a sanitized error', async () => {
  const usePentacleToken = loadHook();
  secureStore().getItemAsync.mockRejectedValueOnce(new Error('corrupt'));

  const { result } = renderHook(() => usePentacleToken());

  await waitFor(() => expect(result.current.isReady).toBe(true));
  expect(result.current.token).toBeNull();
  expect(mockSetPentacleWsUrl).toHaveBeenCalledWith('ws://default.example/ws');
});


test('saved URL read failure preserves the valid token and uses the default endpoint', async () => {
  const useToken = loadHook();
  secureStore().getItemAsync.mockResolvedValueOnce('synthetic-valid-token').mockRejectedValueOnce(new Error('synthetic URL failure'));
  const hook = renderHook(() => useToken());
  await waitFor(() => expect(hook.result.current.isReady).toBe(true));
  expect(hook.result.current.token).toBe('synthetic-valid-token');
  expect(mockSetPentacleAuthToken).toHaveBeenLastCalledWith('synthetic-valid-token');
  expect(mockSetPentacleWsUrl).toHaveBeenLastCalledWith('ws://default.example/ws');
  expect(hook.result.current.error).toBeNull();
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalled();
});

test('token read errors expose only a fixed class and explicit reload retries with biometric protection', async () => {
  const useToken = loadHook();
  secureStore().getItemAsync.mockRejectedValueOnce(Object.assign(new Error('synthetic-private-message'), {code:'synthetic-private-code'}));
  const hook = renderHook(() => useToken());
  await waitFor(() => expect(hook.result.current.isReady).toBe(true));
  expect(hook.result.current.token).toBeNull();
  expect(hook.result.current.error).toBe('token_read_failed');
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(1);
  secureStore().getItemAsync.mockResolvedValueOnce('synthetic-recovered-token').mockResolvedValueOnce(null);
  await act(async () => { await hook.result.current.reload(); });
  expect(hook.result.current.token).toBe('synthetic-recovered-token');
  expect(hook.result.current.error).toBeNull();
  expect(secureStore().getItemAsync).toHaveBeenNthCalledWith(2, 'pentacle-stream-token', expect.objectContaining({
    requireAuthentication:true, keychainService:'pentacle-stream-token', keychainAccessible:'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  }));
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalled();
});

test('foreground retries a failed token read once without a loop or remount retry', async () => {
  const useToken = loadHook();
  secureStore().getItemAsync.mockRejectedValueOnce(new Error('synthetic read failure'));
  const first = renderHook(() => useToken());
  await waitFor(() => expect(first.result.current.isReady).toBe(true));
  first.unmount();
  const hook = renderHook(() => useToken());
  await act(async () => { await Promise.resolve(); });
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(1);
  await act(async () => { emitAppState('inactive'); emitAppState('active'); });
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(1);
  secureStore().getItemAsync.mockRejectedValueOnce(new Error('synthetic retry failure'));
  await act(async () => {
    emitAppState('background'); emitAppState('active');
    for(let i=0;i<20;i++) await Promise.resolve();
  });
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(2);
  expect(hook.result.current.error).toBe('token_read_failed');
  await act(async () => { emitAppState('active'); for(let i=0;i<20;i++) await Promise.resolve(); });
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(2);
  secureStore().getItemAsync.mockResolvedValueOnce('synthetic-foreground-token').mockResolvedValueOnce(null);
  await act(async () => { emitAppState('background'); emitAppState('inactive'); emitAppState('active'); });
  expect(hook.result.current.token).toBe('synthetic-foreground-token');
  expect(hook.result.current.error).toBeNull();
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(4);
  await act(async () => { emitAppState('background'); emitAppState('active'); });
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(4);
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalled();
  hook.unmount();
  expect(mockAppStateListeners.size).toBe(0);
});

test('missing token remains distinct from a read error and foreground never deletes or retries it', async () => {
  const useToken = loadHook();
  const hook = renderHook(() => useToken());
  await waitFor(() => expect(hook.result.current.isReady).toBe(true));
  expect(hook.result.current.token).toBeNull();
  expect(hook.result.current.error).toBeNull();
  const reads = secureStore().getItemAsync.mock.calls.length;
  await act(async () => { emitAppState('background'); emitAppState('active'); });
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(reads);
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalled();
});


test('foreground retry survives the biometric screen unmount without retrying an ordinary remount', async () => {
  const useToken = loadHook();
  secureStore().getItemAsync.mockRejectedValueOnce(new Error('synthetic token read failure'));
  const first = renderHook(() => useToken());
  await waitFor(() => expect(first.result.current.isReady).toBe(true));
  act(() => emitAppState('background'));
  first.unmount();
  // RootLayout replaces the screens with its biometric lock while backgrounded.
  // The token hook is mounted again only after the normal local app unlock.
  act(() => { emitAppState('inactive'); emitAppState('active'); });
  secureStore().getItemAsync.mockResolvedValueOnce('synthetic-unlocked-token').mockResolvedValueOnce(null);
  const second = renderHook(() => useToken());
  await waitFor(() => expect(second.result.current.token).toBe('synthetic-unlocked-token'));
  expect(second.result.current.error).toBeNull();
  expect(secureStore().getItemAsync).toHaveBeenCalledTimes(3);
  expect(secureStore().deleteItemAsync).not.toHaveBeenCalled();
});
