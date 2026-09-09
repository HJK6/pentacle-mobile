import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

let mockAppStateListener: ((state: string) => void) | undefined;
const mockRemove = jest.fn();
let mockInitialUrl: string | null = null;
let mockLinkingListener: ((event: { url: string }) => void) | undefined;
let mockStreamListener: (() => void) | undefined;
const mockStreamUnsubscribe = jest.fn();
const mockHarnessRuntime = {
  applyURL: jest.fn(),
  markBootResolved: jest.fn(),
  markNavigationReady: jest.fn(),
  whenNavigationReady: jest.fn(() => Promise.resolve()),
  beginHarnessTokenReload: jest.fn(),
  markHarnessTokenReady: jest.fn(),
  hasAction: jest.fn(),
  getParam: jest.fn(),
  markStreamHarnessActive: jest.fn(),
};
const mockPentacleStream = {
  getPentacleStreamState: jest.fn(),
  subscribePentacleStream: jest.fn(),
  setPentacleWsUrl: jest.fn(),
};
const mockPentacleToken = {
  reloadPentacleToken: jest.fn(() => Promise.resolve()),
};
const mockHarnessDiagnostics = {
  dumpSessionState: jest.fn(),
};
const mockHarnessOpenExistingChat = {
  attemptOpenExistingChat: jest.fn(),
};
const mockHarnessAwaitNewStream = {
  subscribeAndOpenNewStream: jest.fn(),
};

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'AppState') return {
        addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
          mockAppStateListener = listener;
          return { remove: mockRemove };
        }),
      };
      if (prop === 'Linking') return {
        getInitialURL: jest.fn(() => Promise.resolve(mockInitialUrl)),
        addEventListener: jest.fn((_event: string, listener: (event: { url: string }) => void) => {
          mockLinkingListener = listener;
          return { remove: jest.fn() };
        }),
      };
      if (prop === 'LogBox') return { ignoreLogs: jest.fn() };
      return target[prop as keyof typeof target];
    },
  });
});

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-router', () => require('../helpers/mocks/expoRouter').makeMock());
jest.mock('@react-navigation/native', () => ({
  DarkTheme: { colors: {} },
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-notifications', () => ({
  setBadgeCountAsync: jest.fn(),
  dismissAllNotificationsAsync: jest.fn(),
}));
jest.mock('expo-updates', () => ({
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
}));
jest.mock('../../src/utils/harnessRuntime', () => mockHarnessRuntime);
jest.mock('../../src/services/pentacleStream', () => mockPentacleStream);
jest.mock('../../src/hooks/usePentacleToken', () => mockPentacleToken);
jest.mock('../../src/services/harnessDiagnostics', () => mockHarnessDiagnostics);
jest.mock('../../src/services/harnessOpenExistingChat', () => mockHarnessOpenExistingChat);
jest.mock('../../src/services/harnessAwaitNewStream', () => mockHarnessAwaitNewStream);
jest.mock('../../src/hooks/useBiometricLock', () => jest.fn());
jest.mock('../../src/hooks/usePushNotifications', () => jest.fn());

function loadRootLayout() {
  jest.resetModules();
  jest.doMock('react', () => React);
  return require('../../app/_layout').default as typeof import('../../app/_layout').default;
}

function routerMock() {
  return require('expo-router').__mock;
}

function biometricMock() {
  return require('../../src/hooks/useBiometricLock') as jest.Mock;
}

function pushMock() {
  return require('../../src/hooks/usePushNotifications') as jest.Mock;
}

function updatesMock() {
  return require('expo-updates');
}

function notificationsMock() {
  return require('expo-notifications');
}

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
  delete process.env.EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK;
  mockInitialUrl = null;
  mockLinkingListener = undefined;
  mockStreamListener = undefined;
  mockStreamUnsubscribe.mockClear();
  mockHarnessRuntime.applyURL.mockClear();
  mockHarnessRuntime.markBootResolved.mockClear();
  mockHarnessRuntime.markNavigationReady.mockClear();
  mockHarnessRuntime.beginHarnessTokenReload.mockClear();
  mockHarnessRuntime.markHarnessTokenReady.mockClear();
  mockHarnessRuntime.whenNavigationReady.mockReset();
  mockHarnessRuntime.whenNavigationReady.mockImplementation(() => Promise.resolve());
  mockHarnessRuntime.hasAction.mockReset();
  mockHarnessRuntime.getParam.mockReset();
  mockHarnessRuntime.markStreamHarnessActive.mockClear();
  mockPentacleStream.getPentacleStreamState.mockReset();
  mockPentacleStream.subscribePentacleStream.mockReset();
  mockPentacleStream.setPentacleWsUrl.mockReset();
  mockPentacleToken.reloadPentacleToken.mockReset();
  mockPentacleToken.reloadPentacleToken.mockResolvedValue(undefined);
  mockHarnessDiagnostics.dumpSessionState.mockClear();
  mockHarnessOpenExistingChat.attemptOpenExistingChat.mockReset();
  mockHarnessAwaitNewStream.subscribeAndOpenNewStream.mockReset();
});

test('a websocket URL parameter is applied immediately after URL setup', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockInitialUrl = 'pentacle://harness?actions=dump_session_state&stream_id=hostc%3Amock-session&ws_url=ws%3A%2F%2Fexample.local%3A9123';
  mockHarnessRuntime.applyURL.mockReturnValue(true);
  mockHarnessRuntime.hasAction.mockImplementation((action: string) => action === 'dump_session_state');
  mockHarnessRuntime.getParam.mockImplementation((name: string) => (
    name === 'ws_url' ? 'ws://example.local:9123' : name === 'stream_id' ? 'hostc:mock-session' : undefined
  ));

  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });
  render(<RootLayout />);

  await waitFor(() => expect(mockHarnessRuntime.applyURL).toHaveBeenCalledWith(mockInitialUrl));
  expect(mockHarnessRuntime.markStreamHarnessActive).toHaveBeenCalledWith('hostc:mock-session');
  expect(mockPentacleStream.setPentacleWsUrl).toHaveBeenCalledWith('ws://example.local:9123');
  const wsOrder = mockPentacleStream.setPentacleWsUrl.mock.invocationCallOrder[0];
  const reloadBeginOrder = mockHarnessRuntime.beginHarnessTokenReload.mock.invocationCallOrder[0];
  const reloadOrder = mockPentacleToken.reloadPentacleToken.mock.invocationCallOrder[0];
  const subscribeOrder = mockPentacleStream.subscribePentacleStream.mock.invocationCallOrder[0];
  expect(wsOrder).toBeLessThan(subscribeOrder);
  expect(reloadBeginOrder).toBeGreaterThan(wsOrder);
  expect(reloadBeginOrder).toBeLessThan(reloadOrder);
  await waitFor(() => expect(mockHarnessRuntime.markHarnessTokenReady).toHaveBeenCalled());
}, 15_000);

test('locked state renders the Face ID overlay and unlock action', () => {
  const authenticate = jest.fn();
  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: true, authenticate });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });

  render(<RootLayout />);

  fireEvent.press(screen.getByText('Unlock with Face ID'));
  expect(screen.getByText('Pentacle')).toBeTruthy();
  expect(authenticate).toHaveBeenCalled();
  expect(pushMock()).toHaveBeenCalledWith({ locked: true });
});

test('unlocked state renders the expected stack screens and mounts push notifications', () => {
  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });

  render(<RootLayout />);

  expect(routerMock().stackScreens).toHaveBeenCalledWith(expect.objectContaining({ name: '(tabs)' }));
  expect(routerMock().stackScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'enroll' }));
  expect(routerMock().stackScreens).toHaveBeenCalledWith(expect.objectContaining({ name: 'pentacle/session/[streamId]' }));
  expect(pushMock()).toHaveBeenCalledWith({ locked: false });
});

test('root Stack defaults headerShown:false so the native-stack does not swallow nested tab-bar taps', () => {
  // Configuration guard for the public navigation stack.
  // With the native-stack default (headerShown:true), react-native-screens lays out header
  // machinery that renders a transparent native view over the nested bottom-tab bar's footprint,
  // making UPDATES/SETTINGS/CHATS taps unresponsive. The behavior is native-only (no
  // hit-testing in jsdom), so this asserts the configuration invariant that removes the layer.
  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });

  render(<RootLayout />);

  expect(routerMock().stackRoot).toHaveBeenCalledWith(
    expect.objectContaining({ screenOptions: expect.objectContaining({ headerShown: false }) }),
  );
  // (tabs) and the session screen stay headerless (session renders its own header); only enroll
  // re-enables a native header — and the tab bar stays clickable with it enabled.
  expect(routerMock().stackScreens).toHaveBeenCalledWith(
    expect.objectContaining({ name: '(tabs)', options: expect.objectContaining({ headerShown: false }) }),
  );
  expect(routerMock().stackScreens).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'pentacle/session/[streamId]', options: expect.objectContaining({ headerShown: false }) }),
  );
  expect(routerMock().stackScreens).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'enroll', options: expect.objectContaining({ headerShown: true }) }),
  );
});

test('foreground AppState checks OTA updates and clears notification badges', async () => {
  const previousDev = (global as any).__DEV__;
  (global as any).__DEV__ = false;
  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });
  updatesMock().checkForUpdateAsync.mockResolvedValue({ isAvailable: false });
  render(<RootLayout />);

  await act(async () => {
    mockAppStateListener?.('active');
  });

  await waitFor(() => expect(updatesMock().checkForUpdateAsync).toHaveBeenCalled());
  expect(notificationsMock().setBadgeCountAsync).toHaveBeenCalledWith(0);
  expect(notificationsMock().dismissAllNotificationsAsync).toHaveBeenCalled();
  (global as any).__DEV__ = previousDev;
});

test('disabled biometric env skips lock branch and OTA update effect', async () => {
  process.env.EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK = '1';
  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: true, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });

  render(<RootLayout />);

  expect(screen.queryByText('Unlock with Face ID')).toBeNull();
  expect(routerMock().stackScreens).toHaveBeenCalledWith(expect.objectContaining({ name: '(tabs)' }));
  expect(updatesMock().checkForUpdateAsync).not.toHaveBeenCalled();
});

test('harness dump_session_state action dumps once after stream hydration', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockInitialUrl = 'pentacle://harness?actions=dump_session_state';
  mockHarnessRuntime.hasAction.mockImplementation((action: string) => action === 'dump_session_state');
  const hydratedState = { hasHydrated: true, sessions: [] };
  mockPentacleStream.getPentacleStreamState
    .mockReturnValueOnce({ hasHydrated: false })
    .mockReturnValue(hydratedState);
  mockPentacleStream.subscribePentacleStream.mockImplementation((listener: () => void) => {
    mockStreamListener = listener;
    return mockStreamUnsubscribe;
  });

  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });
  render(<RootLayout />);

  await waitFor(() => expect(mockHarnessRuntime.applyURL).toHaveBeenCalledWith(mockInitialUrl));
  expect(mockPentacleStream.subscribePentacleStream).toHaveBeenCalledTimes(1);
  expect(mockHarnessDiagnostics.dumpSessionState).not.toHaveBeenCalled();

  act(() => {
    mockStreamListener?.();
  });

  expect(mockStreamUnsubscribe).toHaveBeenCalled();
  expect(mockHarnessDiagnostics.dumpSessionState).toHaveBeenCalledWith(hydratedState);
  mockLinkingListener?.({ url: 'pentacle://harness?actions=dump_session_state' });
  expect(mockHarnessDiagnostics.dumpSessionState).toHaveBeenCalledTimes(1);
});

test('harness open_existing_chat action attempts once after stream hydration', async () => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockInitialUrl = 'pentacle://harness?actions=open_existing_chat&host=hostc';
  mockHarnessRuntime.hasAction.mockImplementation((action: string) => action === 'open_existing_chat');
  mockHarnessRuntime.getParam.mockImplementation((name: string) => (name === 'host' ? 'hostc' : undefined));
  const hydratedState = { hasHydrated: true, sessions: [] };
  mockPentacleStream.getPentacleStreamState
    .mockReturnValueOnce({ hasHydrated: false })
    .mockReturnValue(hydratedState);
  mockPentacleStream.subscribePentacleStream.mockImplementation((listener: () => void) => {
    mockStreamListener = listener;
    return mockStreamUnsubscribe;
  });
  mockHarnessOpenExistingChat.attemptOpenExistingChat.mockReturnValue('hostc:session-1');

  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });
  render(<RootLayout />);

  await waitFor(() => expect(mockHarnessRuntime.applyURL).toHaveBeenCalledWith(mockInitialUrl));
  expect(mockPentacleStream.subscribePentacleStream).toHaveBeenCalledTimes(1);
  expect(mockHarnessOpenExistingChat.attemptOpenExistingChat).not.toHaveBeenCalled();

  act(() => {
    mockStreamListener?.();
  });
  expect(mockHarnessOpenExistingChat.attemptOpenExistingChat).not.toHaveBeenCalled();

  act(() => {
    jest.advanceTimersByTime(250);
  });

  expect(mockStreamUnsubscribe).toHaveBeenCalled();
  expect(mockHarnessOpenExistingChat.attemptOpenExistingChat).toHaveBeenCalledWith(
    hydratedState,
    'hostc',
    routerMock().router,
    undefined,
  );
  mockLinkingListener?.({ url: 'pentacle://harness?actions=open_existing_chat&host=hostc' });
  expect(mockHarnessOpenExistingChat.attemptOpenExistingChat).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test('harness explicit stream override opens before inventory hydration', async () => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockInitialUrl = 'pentacle://harness?actions=open_existing_chat&host=hostc&stream_id_override=hostc%3Afixture';
  mockHarnessRuntime.hasAction.mockImplementation((action: string) => action === 'open_existing_chat');
  mockHarnessRuntime.getParam.mockImplementation((name: string) => {
    if (name === 'host') return 'hostc';
    if (name === 'stream_id_override') return 'hostc:fixture';
    return undefined;
  });
  const unhydratedState = { hasHydrated: false, sessions: [] };
  mockPentacleStream.getPentacleStreamState.mockReturnValue(unhydratedState);
  mockPentacleStream.subscribePentacleStream.mockImplementation((listener: () => void) => {
    mockStreamListener = listener;
    return mockStreamUnsubscribe;
  });
  mockHarnessOpenExistingChat.attemptOpenExistingChat.mockReturnValue('hostc:fixture');

  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });
  render(<RootLayout />);
  await waitFor(() => expect(mockHarnessRuntime.applyURL).toHaveBeenCalledWith(mockInitialUrl));

  act(() => {
    jest.advanceTimersByTime(250);
  });

  expect(mockHarnessOpenExistingChat.attemptOpenExistingChat).toHaveBeenCalledWith(
    unhydratedState,
    'hostc',
    routerMock().router,
    undefined,
    'hostc:fixture',
  );
  expect(mockStreamUnsubscribe).toHaveBeenCalled();
  jest.useRealTimers();
});

test('harness await_and_open_new_stream action subscribes immediately after arming', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  mockInitialUrl = 'pentacle://harness?actions=await_and_open_new_stream&marker=run-1&host_filter=hostc';
  mockHarnessRuntime.hasAction.mockImplementation((action: string) => action === 'await_and_open_new_stream');
  mockHarnessRuntime.getParam.mockImplementation((name: string) => {
    if (name === 'marker') return 'run-1';
    if (name === 'host_filter') return 'hostc';
    return undefined;
  });

  const RootLayout = loadRootLayout();
  biometricMock().mockReturnValue({ locked: false, authenticate: jest.fn() });
  pushMock().mockReturnValue({ expoPushToken: null, error: null });
  render(<RootLayout />);

  await waitFor(() => expect(mockHarnessRuntime.applyURL).toHaveBeenCalledWith(mockInitialUrl));
  expect(mockHarnessAwaitNewStream.subscribeAndOpenNewStream).toHaveBeenCalledWith(
    mockPentacleStream,
    'run-1',
    'hostc',
    routerMock().router,
  );
  mockLinkingListener?.({ url: mockInitialUrl });
  expect(mockHarnessAwaitNewStream.subscribeAndOpenNewStream).toHaveBeenCalledTimes(1);
});
