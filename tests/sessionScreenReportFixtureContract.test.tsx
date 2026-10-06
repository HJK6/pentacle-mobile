import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

let mockParams: Record<string, unknown> = {};
let mockInitialUrl: string | null = null;
let mockState: any;
const mockActions = {
  sendMessage: jest.fn(), appendOptimisticUserMessage: jest.fn(),
  markOptimisticFailed: jest.fn(), retryOptimisticSend: jest.fn(),
  clearDraft: jest.fn(), closeSession: jest.fn(), renameSession: jest.fn(),
  prefetchStreamEvents: jest.fn(), prefetchSettledStreams: jest.fn(), markStreamOpenIntent: jest.fn(),
};
const mockRouter = {
  push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true),
};

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Linking') return {
        getInitialURL: jest.fn(() => Promise.resolve(mockInitialUrl)),
        addEventListener: jest.fn(() => ({ remove: jest.fn() })),
      };
      if (prop === 'Keyboard') return {
        dismiss: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })),
      };
      if (prop === 'InteractionManager') return {
        runAfterInteractions: jest.fn(() => ({ cancel: jest.fn() })),
      };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock({
  getParams: () => mockParams, router: mockRouter,
}));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true, DarkTheme: { colors: {} },
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/hooks/useBiometricLock', () => () => ({ locked: false, authenticate: jest.fn() }));
jest.mock('../src/hooks/usePushNotifications', () => () => ({ expoPushToken: null, error: null }));
jest.mock('expo-notifications', () => ({ setBadgeCountAsync: jest.fn(), dismissAllNotificationsAsync: jest.fn() }));
jest.mock('expo-updates', () => ({ checkForUpdateAsync: jest.fn().mockResolvedValue({ isAvailable: false }) }));
jest.mock('../src/hooks/usePentacleToken', () => ({
  __esModule: true,
  default: jest.fn(() => ({ token: null, isReady: true })),
  reloadPentacleToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: () => mockActions,
  usePentacleStreamSelector: (selector: (state: any) => any) => selector(mockState),
  usePentacleStreamSelectorWhen: (_enabled: boolean, selector: (state: any) => any) => selector(mockState),
  selectPentacleConnectionSlice: (state: any) => ({ connected: state.connected, connecting: state.connecting }),
  samePentacleConnectionSlice: (a: any, b: any) => a.connected === b.connected && a.connecting === b.connecting,
  selectStreamEventsLoadState: () => ({ currentGenerationComplete: false, fresh: false, requestStatus: 'idle' }),
  sameStreamEventsLoadState: () => true,
  selectStreamSlice: (state: any) => ({
    connecting: state.connecting, hasHydrated: state.hasHydrated,
    session: null, detail: null, turn: require('pentacle-chat-core').IDLE_TURN,
  }),
  selectOptimisticQuestionAnswerIdentities: () => [],
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: () => mockState,
  subscribePentacleStream: jest.fn(() => jest.fn()),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: () => 'press-in',
  setPentacleWsUrl: jest.fn(), consentConnection: jest.fn(),
  sendPentacleAssetCommand: jest.fn(() => { throw new Error('local report fixture must not use the wire'); }),
}));

const runId = 'mounted-report-producer-contract';
let SessionScreen: React.ComponentType;
let runtime: typeof import('../src/utils/harnessRuntime');

beforeEach(async () => {
  jest.resetModules();
  jest.doMock('react', () => React);
  process.env.EXPO_PUBLIC_HARNESS = '1';
  delete process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS;
  mockInitialUrl = `pentacle://harness?scenario=report_viewer_comments_keyboard&scenario_run_id=${runId}&actions=autoaccept_biometric,open_report_viewer`;
  mockState = {
    connected: false, connecting: false, hasHydrated: false,
    sessions: [], events: [], notifications: [], optimisticSends: {},
    drafts: {}, hosts: {}, machineStats: {}, updates: [], workingStates: {}, workingByStream: {},
    limits: require('pentacle-chat-core').INITIAL_PENTACLE_LIMITS,
  };
  mockRouter.push.mockClear();
  mockParams = {};
  runtime = require('../src/utils/harnessRuntime');
  runtime.reset();
  const RootLayout = require('../app/_layout').default;
  const root = render(<RootLayout />);
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
  // Consume the actual layout producer's push and actual seeded asset store.
  const route = mockRouter.push.mock.calls.find(([value]) => value.pathname === '/pentacle/session/[streamId]')?.[0];
  expect(route).toBeDefined();
  mockParams = { ...route.params };
  expect(mockParams).toEqual({ streamId: `fixture:report-viewer:${runId}`, reportHarness: '1' });
  expect(runtime.isArmed()).toBe(true);
  expect(runtime.hasAction('open_report_viewer')).toBe(true);
  expect(require('../src/services/pentacleAssets').getSessionReports(mockParams.streamId)).toHaveLength(1);
  root.unmount();
  SessionScreen = require('../app/pentacle/session/[streamId]').default;
});

afterEach(() => {
  runtime.reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
});

test('actual report producer mounts the real report and comment target without a device token', async () => {
  render(<SessionScreen />);
  const target = await screen.findByTestId(`report-block-interaction-comment-target--${runId}`);
  expect(screen.getByText('Comment round-trip target')).toBeTruthy();
  expect(screen.queryByText('Pentacle access is unavailable on this device.')).toBeNull();
  fireEvent.press(target);
  await waitFor(() => expect(screen.getByTestId('report-comment-input')).toBeTruthy());
  expect(screen.getByTestId('report-comment-send')).toBeTruthy();
});

test('actual fixture comment enables Send, persists the body and confirms the same run', async () => {
  const core = require('pentacle-chat-core');
  const telemetry: Array<{ message: string; data: Record<string, unknown> }> = [];
  const stop = core.teeTelemetrySink((payload: typeof telemetry[number]) => telemetry.push(payload));
  try {
    render(<SessionScreen />);
    const marker = await screen.findByTestId(`report-block-comment-target--${runId}`);
    expect(marker.props.pointerEvents).toBe('none');
    expect(marker.props.accessible).toBe(true);
    const interaction = screen.getByTestId(`report-block-interaction-comment-target--${runId}`);
    expect(interaction.props.accessible).toBe(false);
    fireEvent.press(interaction);
    const input = await screen.findByTestId('report-comment-input');
    expect(screen.getByTestId('report-comment-send').props.accessibilityState.disabled).toBe(true);
    // The native scenario sends an ASCII decimal string; this mounted check
    // verifies real state/persistence and never synthesizes a keyboard event.
    const body = '197835260411993';
    fireEvent.changeText(input, body);
    await waitFor(() => expect(screen.getByTestId('report-comment-send').props.accessibilityState.disabled).toBe(false));
    await act(async () => fireEvent.press(screen.getByTestId('report-comment-send')));
    const assets = require('../src/services/pentacleAssets');
    const report = assets.getSessionReports(mockParams.streamId)[0];
    const comments = await assets.listReportComments(mockParams.streamId, report);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      comment_id: 'harness-comment-1', asset_id: report.asset_id,
      section_id: 'matrix-section', block_id: `comment-target--${runId}`, body,
    });
    expect(telemetry.filter(event => event.message === 'report:comment_confirmed')).toEqual([
      expect.objectContaining({ data: { block_id: `comment-target--${runId}`,
        comment_id: 'harness-comment-1', body, scenario_run_id: runId } }),
    ]);
    expect(telemetry.some(event => event.message === 'report:comment_keyboard')).toBe(false);
    expect(mockActions.sendMessage).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

test.each(['unarmed', 'wrong-run', 'missing-action'] as const)('report fixture refuses %s and retains normal auth', async (condition) => {
  if (condition === 'unarmed') runtime.reset();
  if (condition === 'wrong-run') mockParams.streamId = `fixture:report-viewer:another-run`;
  if (condition === 'missing-action') {
    runtime.reset();
    runtime.applyURL(`pentacle://harness?scenario=report_viewer_comments_keyboard&scenario_run_id=${runId}&actions=autoaccept_biometric`);
  }
  render(<SessionScreen />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Pentacle access is unavailable on this device.')).toBeTruthy();
  expect(screen.queryByTestId(`report-block-interaction-comment-target--${runId}`)).toBeNull();
  expect(screen.queryByTestId('report-comment-input')).toBeNull();
});
