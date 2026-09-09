// Harness-armed question overlay auto-open. The redesigned question surface
// renders inside the FAB-opened full-screen overlay, so telemetry-await e2e
// scenarios (agent_question, mock_agent_question_free_text_notification) arm
// `auto_open_question_overlay` to get the user-equivalent FAB press. This
// suite proves the armed path opens the overlay (and emits
// question:card_rendered) without a FAB press, and that the unarmed harness
// path is unchanged (FAB press still required).

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import { setTelemetrySink, TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleQuestion, PentacleStreamState, TelemetryPayload } from 'pentacle-chat-core';

const CLAUDE_STREAM_ID = 'hostc:claude:one';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(CLAUDE_STREAM_ID) };
let mockState: PentacleStreamState;

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_test_1'),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
  dismissQuestion: jest.fn(),
  resolveNotification: jest.fn(),
  answerPrompt: jest.fn(),
};
const mockKeyboardListeners = new Map<string, (event: { endCoordinates: { height: number } }) => void>();

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') {
        return {
          dismiss: jest.fn(),
          addListener: (eventName: string, callback: (event: { endCoordinates: { height: number } }) => void) => {
            mockKeyboardListeners.set(eventName, callback);
            return { remove: () => mockKeyboardListeners.delete(eventName) };
          },
        };
      }
      if (prop === 'InteractionManager') {
        return { runAfterInteractions: (callback: () => void) => { callback(); return { cancel: jest.fn() }; } };
      }
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
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => ({ currentGenerationComplete: true, fresh: true, requestStatus: 'ready' })),
  sameStreamEventsLoadState: jest.fn((a, b) => a.currentGenerationComplete === b.currentGenerationComplete && a.fresh === b.fresh && a.requestStatus === b.requestStatus),
  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
    const core = require('pentacle-chat-core');
    return {
      connecting: state.connecting,
      hasHydrated: state.hasHydrated,
      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
      workingState: state.workingStates?.[streamId],
      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => ({ optimisticSends: {} })),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

const QUESTION: PentacleQuestion = {
  header: 'Pick',
  prompt: 'Pick a number.',
  options: [
    { index: 1, label: '1', description: 'The number one.', meta: false },
    { index: 2, label: '2', description: 'The number two.', meta: false },
  ],
};

function resetState(question: PentacleQuestion | null = QUESTION) {
  mockParams = { streamId: encodeURIComponent(CLAUDE_STREAM_ID) };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [{
      stream_id: CLAUDE_STREAM_ID,
      host: 'hostc',
      provider: 'claude',
      session_name: 'one',
      title: 'Question host',
      last_event_at: '2026-05-13T12:00:00.000Z',
      last_text: 'hello',
      last_kind: 'ASSIST',
      draft: '',
      pending: false,
      working: false,
      online: true,
      ...(question ? { question } : {}),
    }],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
  } as unknown as PentacleStreamState;
}

function harnessRuntimeModule() {
  return require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
}

// The session screen must load with EXPO_PUBLIC_HARNESS set (its module-level
// harnessRuntime require binds at first load), so it cannot be a hoisted
// static import. Requiring it inside a test body makes the FIRST test pay the
// whole [streamId].tsx dependency-graph transform on a cold Jest cache, which
// exceeds the 5s default test timeout. Pay that one-time cost here instead,
// with an explicit hook timeout, so every test runs at the default timeout
// even after `jest --clearCache`.
let SessionScreen: (typeof import('../app/pentacle/session/[streamId]'))['default'];
beforeAll(() => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  SessionScreen = (require('../app/pentacle/session/[streamId]') as typeof import('../app/pentacle/session/[streamId]')).default;
}, 120_000);

function armHarness(actions: string[]) {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const harnessRuntime = harnessRuntimeModule();
  harnessRuntime.reset();
  harnessRuntime.applyURL(`pentacle://harness?actions=${actions.join(',')}&scenario=question_auto_open&scenario_run_id=run-qao`);
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
  resetState();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockImplementation(() => [false, jest.fn()]);
  mockKeyboardListeners.clear();
});

afterEach(() => {
  setTelemetrySink(null);
  harnessRuntimeModule().reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
  jest.clearAllMocks();
});

test('armed auto_open_question_overlay opens the overlay without a FAB press and emits question:card_rendered', async () => {
  armHarness(['auto_open_question_overlay']);
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  render(<SessionScreen />);
  await act(async () => {});

  expect(screen.getByTestId('question-card')).toBeTruthy();
  const cardEvents = seen.filter((event) => event.message === TELEMETRY_EVENTS.QUESTION_CARD_RENDERED);
  expect(cardEvents.length).toBeGreaterThanOrEqual(1);
  expect(cardEvents[0].data).toMatchObject({ stream_id: CLAUDE_STREAM_ID });
});

test('without the armed action the overlay stays closed until the FAB is pressed', async () => {
  armHarness(['autoaccept_biometric']);

  render(<SessionScreen />);
  await act(async () => {});

  expect(screen.queryByTestId('question-card')).toBeNull();
  fireEvent.press(screen.getByTestId('question-fab'));
  expect(screen.getByTestId('question-card')).toBeTruthy();
});

test('armed action with no pending question never opens the overlay', async () => {
  armHarness(['auto_open_question_overlay']);
  resetState(null);

  render(<SessionScreen />);
  await act(async () => {});

  expect(screen.queryByTestId('question-card')).toBeNull();
});

