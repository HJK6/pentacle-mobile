// Stage 4 regression tests — turn-two case (claude turn 2 dock) and terminal-divider case (codex dock dismiss).
// Spec: docs/behavior-contract.md
// Inbox: msg_17. The screen now reads `state.workingByStream[streamId]` from the
// reducer. The flag matrix is gone; turn.phase is the state machine. These tests
// drive the screen with synthetic reducer states to assert dock visibility under
// the failure modes the flag matrix used to mishandle.

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import { setTelemetrySink, TELEMETRY_EVENTS, type PentacleSessionSummary, type PentacleStreamState, type TelemetryPayload, type TurnState } from 'pentacle-chat-core';

const CLAUDE_STREAM_ID = 'hostc:claude:one';
const CODEX_STREAM_ID = 'hostc:codex:one';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(CLAUDE_STREAM_ID) };
let mockState: PentacleStreamState;
let mockShowToolActions = false;
let mockIsFocused = true;
let mockAppStateCurrent: string | null = 'active';
const mockAppStateListeners = new Set<(state: string) => void>();

const mockAppState = {
  get currentState() {
    return mockAppStateCurrent;
  },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    mockAppStateListeners.add(listener);
    return { remove: () => mockAppStateListeners.delete(listener) };
  },
};

function setMockAppState(state: string) {
  mockAppStateCurrent = state;
  for (const listener of mockAppStateListeners) listener(state);
}

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  appendOptimisticUserMessage: jest.fn(() => 'optimistic_test_1'),
  markOptimisticFailed: jest.fn(),
  clearDraft: jest.fn(),
  closeSession: jest.fn(),
  renameSession: jest.fn(),
};
const mockKeyboardDismiss = jest.fn();
const mockKeyboardAddListener = jest.fn(() => ({ remove: jest.fn() }));
const mockRunAfterInteractions = jest.fn((callback: () => void) => {
  callback();
  return { cancel: jest.fn() };
});

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Keyboard') return { dismiss: mockKeyboardDismiss, addListener: mockKeyboardAddListener };
      if (prop === 'InteractionManager') return { runAfterInteractions: mockRunAfterInteractions };
      if (prop === 'AppState') return mockAppState;
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
      sending: core.getSessionSendingState(state, streamId).sending,
      sendingImmediate: core.getSessionSendingState(state, streamId).immediate,
    };
  }),
  requestStreamEvents: jest.fn().mockResolvedValue([]),
  getPentacleStreamState: jest.fn(() => mockState),
  registerFocusedPentacleStream: jest.fn(() => jest.fn()),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  const [host, provider, name] = streamId.split(':');
  return {
    stream_id: streamId,
    host,
    provider,
    session_name: name,
    title: 'Test chat',
    last_event_at: '2026-05-13T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function setTurn(streamId: string, turn: TurnState | undefined) {
  const next = { ...(mockState.workingByStream ?? {}) };
  if (turn === undefined) {
    delete next[streamId];
  } else {
    next[streamId] = turn;
  }
  mockState = { ...mockState, workingByStream: next };
}

function setWorkingElapsed(streamId: string, elapsedMs: number) {
  mockState = {
    ...mockState,
    workingStates: {
      ...(mockState.workingStates ?? {}),
      [streamId]: {
        stream_id: streamId,
        timestamp: new Date(Date.now()).toISOString(),
        elapsed_ms: elapsedMs,
        label: '',
        tokens_output: 0,
        tokens_phase: 'idle',
        shell_count_started: 0,
        tasks: [],
      } as any,
    },
  };
}

function revealWorkingRow(ms: number = 275) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

function resetState(streamId: string = CLAUDE_STREAM_ID) {
  mockParams = { streamId: encodeURIComponent(streamId) };
  mockShowToolActions = false;
  mockIsFocused = true;
  mockAppStateCurrent = 'active';
  mockAppStateListeners.clear();
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    hosts: {},
    sessions: [session(streamId)],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
    optimisticSends: {},
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-13T12:00:00.000Z') });
  resetState();
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockImplementation(() => [mockShowToolActions, jest.fn()]);
  mockActions.sendMessage.mockResolvedValue(true);
  // sendTurn simulates Stage 3's reducer: synchronously sets phase=pending for
  // the stream and returns the optimistic id. Tests assert the screen reads
  // that phase change.
  mockActions.sendTurn.mockImplementation((streamId: string, text: string) => {
    const optimisticId = 'optimistic_test_1';
    setTurn(streamId, {
      phase: 'pending',
      optimisticId,
      sentAt: Date.now(),
    });
    mockState = {
      ...mockState,
      optimisticSends: {
        ...(mockState.optimisticSends ?? {}),
        [optimisticId]: {
          optimistic_id: optimisticId,
          request_id: 'req_optimistic_1',
          stream_id: streamId,
          text,
          status: 'dispatched',
          created_at: Date.now() - 1_000,
          dispatched_at: Date.now() - 500,
          window_started_at: Date.now() - 500,
          reconnect_count: 0,
        },
      },
    };
    return optimisticId;
  });
});

afterEach(() => {
  setTelemetrySink(null);
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
  jest.clearAllMocks();
});

test('composer working row suppresses instant sub-threshold working flashes', async () => {
  const rendered = render(<SessionScreen />);

  setTurn(CLAUDE_STREAM_ID, {
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
    firstServerEventAt: Date.now(),
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByTestId('working-dock')).toBeNull();

  revealWorkingRow(274);
  expect(screen.queryByTestId('working-dock')).toBeNull();

  setTurn(CLAUDE_STREAM_ID, {
    phase: 'idle',
    endedAt: Date.now(),
    endReason: 'turn_summary',
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow(1);
  expect(screen.queryByTestId('working-dock')).toBeNull();
});

test('composer timer falls back to client ticking when daemon elapsed is zero', async () => {
  mockState.sessions = [session(CLAUDE_STREAM_ID, { working: true })];
  setWorkingElapsed(CLAUDE_STREAM_ID, 0);
  setTurn(CLAUDE_STREAM_ID, {
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
    firstServerEventAt: Date.now(),
  });

  render(<SessionScreen />);
  expect(screen.queryByTestId('working-dock')).toBeNull();

  revealWorkingRow();
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:00');

  revealWorkingRow(1000);
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:01');
});

test('turn-two case regression (claude): turn 2 send re-opens the dock after a claude SYSTEM end-of-turn cleared turn 1', async () => {
  const rendered = render(<SessionScreen />);

  // Turn 1: press send -> reducer sets phase=pending. Indicator visible.
  fireEvent.changeText(screen.getByTestId('composer-input'), 'hello');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(mockActions.sendTurn).toHaveBeenCalledWith(CLAUDE_STREAM_ID, 'hello');
  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();

  // Reducer advances to phase=working on first server event; firstServerEventAt
  // is the client clock at observation.
  setTurn(CLAUDE_STREAM_ID, {
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
    firstServerEventAt: Date.now(),
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.queryByTestId('working-dock')).toBeNull();
  revealWorkingRow();
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:00');

  // Claude SYSTEM end-of-turn (turn-summary) reduces phase=idle. The indicator hides.
  setTurn(CLAUDE_STREAM_ID, {
    phase: 'idle',
    endedAt: Date.now(),
    endReason: 'turn_summary',
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();

  // Turn 2: press send AGAIN. This is the turn-two case failure mode — the flag matrix
  // used to ride a stale ':end' key into the new turn and kill the indicator. With
  // reducer-owned phase, sendTurn synchronously sets pending -> indicator visible.
  fireEvent.changeText(screen.getByTestId('composer-input'), 'again');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(mockActions.sendTurn).toHaveBeenLastCalledWith(CLAUDE_STREAM_ID, 'again');
  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();
});

test('focused session header emits post-commit status evidence for the current optimistic turn only', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=header-status&scenario_run_id=run-header');
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const rendered = render(<SessionScreen />);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'again');
  await act(async () => fireEvent.press(screen.getByTestId('composer-send-button')));
  await act(async () => rendered.rerender(<SessionScreen />));

  const evidence = () => seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_HEADER_STATUS_RENDER);
  expect(evidence()).toHaveLength(1);
  expect(evidence()[0].data).toMatchObject({
    scenario_run_id: 'run-header',
    stream_id: CLAUDE_STREAM_ID,
    optimistic_id: 'optimistic_test_1',
    status: 'sending',
  });

  mockIsFocused = false;
  setTurn(CLAUDE_STREAM_ID, { phase: 'working', optimisticId: 'stale-turn', sentAt: Date.now() });
  await act(async () => rendered.rerender(<SessionScreen />));
  expect(evidence()).toHaveLength(1);
});

test('focused but backgrounded session cannot emit visible header status evidence', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=header-status&scenario_run_id=run-background');
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  const rendered = render(<SessionScreen />);
  act(() => setMockAppState('background'));

  fireEvent.changeText(screen.getByTestId('composer-input'), 'again');
  await act(async () => fireEvent.press(screen.getByTestId('composer-send-button')));
  await act(async () => rendered.rerender(<SessionScreen />));

  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_HEADER_STATUS_RENDER)).toHaveLength(0);
});

test('unknown app state cannot emit before a later background observation', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  harnessRuntime.reset();
  harnessRuntime.applyURL('pentacle://harness?actions=&scenario=header-status&scenario_run_id=run-unknown');
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));
  mockAppStateCurrent = null;
  const rendered = render(<SessionScreen />);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'again');
  await act(async () => fireEvent.press(screen.getByTestId('composer-send-button')));
  await act(async () => rendered.rerender(<SessionScreen />));
  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_HEADER_STATUS_RENDER)).toHaveLength(0);

  act(() => setMockAppState('background'));
  await act(async () => rendered.rerender(<SessionScreen />));
  expect(seen.filter((event) => event.message === TELEMETRY_EVENTS.HARNESS_HEADER_STATUS_RENDER)).toHaveLength(0);
});

test('terminal-divider case regression (codex): codex SYSTEM terminal-divider end-of-turn dismisses the dock', async () => {
  resetState(CODEX_STREAM_ID);

  const rendered = render(<SessionScreen />);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'hello codex');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(mockActions.sendTurn).toHaveBeenCalledWith(CODEX_STREAM_ID, 'hello codex');
  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();

  // First codex server event lands → phase=working.
  setTurn(CODEX_STREAM_ID, {
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
    firstServerEventAt: Date.now(),
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow();
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:00');

  // Codex SYSTEM divider -> reducer's centralized predicate
  // matches via isTerminalDividerText → phase=idle. Dock must hide.
  setTurn(CODEX_STREAM_ID, {
    phase: 'idle',
    endedAt: Date.now(),
    endReason: 'terminal_divider',
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();
});

test('verbose WorkingDock keeps provider-neutral title for codex and claude labels', async () => {
  mockShowToolActions = true;
  resetState(CODEX_STREAM_ID);
  mockShowToolActions = true;
  mockState.sessions = [session(CODEX_STREAM_ID, {
    working: true,
    working_label: '',
    last_event_at: new Date(Date.now() - 9_000).toISOString(),
  })];
  setTurn(CODEX_STREAM_ID, {
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
  });

  const rendered = render(<SessionScreen />);
  revealWorkingRow();
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.getByTestId('working-dock')).toBeTruthy();
  expect(screen.queryByText(/Baked/)).toBeNull();
  expect(screen.queryByText(/Waiting for background terminal/)).toBeNull();

  mockState.sessions = [session(CODEX_STREAM_ID, {
    working: true,
    working_label: 'Working (9s • esc to interrupt)',
    last_event_at: new Date(Date.now() - 9_000).toISOString(),
  })];
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow();
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.getByTestId('working-dock')).toBeTruthy();
  expect(screen.queryByText(/esc to interrupt/)).toBeNull();

  resetState('hostc:claude:one');
  mockShowToolActions = true;
  mockState.sessions = [session('hostc:claude:one', {
    working: true,
    working_label: 'Waiting for background terminal...',
    last_event_at: new Date(Date.now() - 9_000).toISOString(),
  })];
  setTurn('hostc:claude:one', {
    phase: 'working',
    optimisticId: 'optimistic_test_2',
    sentAt: Date.now(),
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow();
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.getByTestId('working-dock')).toBeTruthy();
  expect(screen.queryByText(/Waiting for background terminal/)).toBeNull();

  act(() => {
    rendered.unmount();
  });
});

test('idle baseline: no workingByStream entry renders no dock', () => {
  render(<SessionScreen />);
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();
});

