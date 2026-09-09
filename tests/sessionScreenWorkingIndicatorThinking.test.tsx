// Regression suite for the pre-reply (thinking / tool-running / USER-only)
// working window.
// Spec: docs/behavior-contract.md
//
// The detail's visual working indicator (header status tag + WorkingDock) is
// driven by `showWorking = session.working || <turn-derived working>`, so the
// opened detail matches the all-chats LIST for every working state — including
// when the agent is thinking / running a tool with only a USER message recorded
// (turn idle). The composer lock stays turn.phase-based (event-derived) so the
// 007d127 "no lock when the working flag is stale" guard is preserved.
//
// Harness mirrors sessionScreenWorkingDock.test.tsx.

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleSessionSummary, PentacleStreamState, TurnState, WorkingStateData } from 'pentacle-chat-core';

const STREAM_ID = 'hostc:claude:one';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
let mockState: PentacleStreamState;
let mockShowToolActions = false;

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
      sending: core.getSessionSendingState(state, streamId).sending,
      sendingImmediate: core.getSessionSendingState(state, streamId).immediate,
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

function workingStateData(streamId: string, overrides: Partial<WorkingStateData> = {}): WorkingStateData {
  return {
    stream_id: streamId,
    timestamp: '2026-05-13T12:00:00.000Z',
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_phase: 'idle',
    shell_count_started: 0,
    tasks: [],
    task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
    elapsed_ms: 0,
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

function resetState(streamId: string = STREAM_ID) {
  mockParams = { streamId: encodeURIComponent(streamId) };
  mockShowToolActions = false;
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
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// Helper: type into the composer so the send button reflects the lock state
// (an empty composer disables the button regardless of phase).
function typeDraft(text: string = 'hello') {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
}

test('session.working=true + turn idle (thinking / USER-only): indicator Working, composer NOT locked', () => {
  // Authoritative daemon flag says working; the local turn has no activity yet
  // (pre-reply / thinking / tool-running with only a USER message recorded).
  mockState.sessions = [session(STREAM_ID, { working: true })];
  mockState.workingStates = { [STREAM_ID]: workingStateData(STREAM_ID, { elapsed_ms: 5_000 }) };

  render(<SessionScreen />);

  // Indicator matches the all-chats list: header tag + footer row show working.
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.getByTestId('status-tag-elapsed').props.children).toBe('00:05');
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByText('Idle')).toBeNull();
  expect(screen.getByTestId('working-dock')).toBeTruthy();
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:05');
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(screen.getByTestId('status-tag-elapsed').props.children).toBe('00:06');
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:06');

  // Composer lock is turn.phase-based — turn is idle, so a drafted message sends.
  typeDraft();
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(false);
});

test('turn working (mid-response): indicator Working, composer stays sendable (B1 send-while-working)', () => {
  mockState.sessions = [session(STREAM_ID, { working: true })];
  setTurn(STREAM_ID, {
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
    firstServerEventAt: Date.now(),
  });

  render(<SessionScreen />);

  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByText('Idle')).toBeNull();

  // B1: mid-response the composer is NO LONGER locked — a typed draft can be
  // sent (it queues behind the working turn). The empty-input guard still holds.
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(true);
  typeDraft();
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(false);
});

test('session.working=false + turn idle: indicator Idle, composer unlocked', () => {
  // Plain idle baseline — finished chat.
  render(<SessionScreen />);

  expect(screen.getByTestId('status-tag-idle')).toBeTruthy();
  expect(screen.queryByText('Idle')).toBeNull();
  expect(screen.queryByText('WORKING')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();

  typeDraft();
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(false);
});

test('dispatched optimistic send shows Sending in the session header', () => {
  mockState.optimisticSends = {
    optimistic_test_1: {
      optimistic_id: 'optimistic_test_1',
      request_id: 'req_test_1',
      stream_id: STREAM_ID,
      text: 'hello',
      status: 'dispatched',
      created_at: Date.now() - 1_000,
      dispatched_at: Date.now() - 500,
      window_started_at: Date.now() - 500,
      reconnect_count: 0,
    },
  };

  render(<SessionScreen />);

  expect(screen.getByTestId('status-tag-sending')).toBeTruthy();
  act(() => {
    jest.advanceTimersByTime(275);
  });
  expect(screen.getByTestId('status-tag-sending-arrow')).toBeTruthy();
  expect(screen.queryByTestId('status-tag-working')).toBeNull();
});

test('007d127 guard: stale session.working=true + turn idle does NOT lock the composer', () => {
  // The authoritative flag can lag (stale true after the agent finished). The
  // indicator may show Working, but the composer lock stays turn.phase-based so
  // the user is never locked out by a stale flag — this is the key 007d127 guard.
  mockState.sessions = [session(STREAM_ID, { working: true })];
  mockState.workingStates = { [STREAM_ID]: workingStateData(STREAM_ID, { elapsed_ms: 1_000 }) };
  setTurn(STREAM_ID, { phase: 'idle', endedAt: Date.now(), endReason: 'turn_summary' });

  render(<SessionScreen />);

  // Visual still trusts the flag (matches the list)...
  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByText('WORKING')).toBeNull();

  // ...but the composer is NOT locked: turn.phase is idle.
  typeDraft();
  expect(screen.getByTestId('composer-send-button').props.accessibilityState.disabled).toBe(false);
});

