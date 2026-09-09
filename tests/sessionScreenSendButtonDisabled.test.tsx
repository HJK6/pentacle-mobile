// B1 (send-while-working queue): the working-state send-disable was REMOVED — the
// user may send while the agent is working (the message queues behind the turn).
// This file pins the new contract: send stays enabled mid-turn, the empty-input
// guard still holds, and a mid-turn send routes through `enqueueTurn` (held) rather
// than `sendTurn` (which begins/dispatches a turn). The historical Stage-4
// disabled-while-working assertions are intentionally superseded here.
// Spec: docs/behavior-contract.md (B rows).

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import usePentacleToken from '../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../src/services/pentacleStream';
import { useUserPreference } from '../src/services/userPreferences';
import type { PentacleSessionSummary, PentacleStreamState, TurnState } from 'pentacle-chat-core';

const STREAM_ID = 'hostc:claude:one';

let mockParams: Record<string, unknown> = { streamId: encodeURIComponent(STREAM_ID) };
let mockState: PentacleStreamState;

const mockActions = {
  sendMessage: jest.fn(),
  sendTurn: jest.fn(),
  enqueueTurn: jest.fn(() => 'optimistic_queued_1'),
  flushQueuedSends: jest.fn(),
  interruptSend: jest.fn(() => Promise.resolve(true)),
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

function session(): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    title: 'Chat',
    last_event_at: '2026-05-16T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

function setTurn(turn: TurnState | undefined) {
  const next = { ...(mockState.workingByStream ?? {}) };
  if (turn === undefined) {
    delete next[STREAM_ID];
  } else {
    next[STREAM_ID] = turn;
  }
  mockState = { ...mockState, workingByStream: next };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-16T12:00:00.000Z') });
  mockParams = { streamId: encodeURIComponent(STREAM_ID) };
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    hosts: {},
    sessions: [session()],
    drafts: {},
    events: [],
    machineStats: {},
    updates: [],
    notifications: [],
    workingStates: {},
    workingByStream: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  (useUserPreference as jest.Mock).mockImplementation(() => [false, jest.fn()]);
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.sendTurn.mockReturnValue('optimistic_test_1');
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

test('B1: send stays enabled while working; empty-input guard holds; idle send dispatches, working send enqueues', async () => {
  const rendered = render(<SessionScreen />);
  const input = screen.getByTestId('composer-input');
  const sendButton = screen.getByTestId('composer-send-button');

  // Empty composer: send button is disabled regardless of phase (empty guard).
  expect(sendButton.props.accessibilityState.disabled).toBe(true);

  // Idle + non-empty text: enabled. Pressing dispatches via sendTurn.
  fireEvent.changeText(input, 'hello');
  expect(sendButton.props.accessibilityState.disabled).toBe(false);
  expect(input.props.editable).toBe(true);
  await act(async () => {
    fireEvent.press(sendButton);
  });
  expect(mockActions.sendTurn).toHaveBeenCalledWith(STREAM_ID, 'hello');
  expect(mockActions.enqueueTurn).not.toHaveBeenCalled();

  // Phase = pending: send STAYS enabled with text (B1 send-while-working).
  fireEvent.changeText(input, 'mid-pending');
  setTurn({ phase: 'pending', optimisticId: 'optimistic_test_1', sentAt: Date.now() });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(sendButton.props.accessibilityState.disabled).toBe(false);

  // Phase = working: still enabled. Pressing now QUEUES via enqueueTurn (not
  // sendTurn) — the message must not begin/dispatch a turn while one is in flight.
  fireEvent.changeText(input, 'queued while working');
  setTurn({
    phase: 'working',
    optimisticId: 'optimistic_test_1',
    sentAt: Date.now(),
    firstServerEventAt: Date.now(),
  });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(sendButton.props.accessibilityState.disabled).toBe(false);
  mockActions.sendTurn.mockClear();
  await act(async () => {
    fireEvent.press(sendButton);
  });
  expect(mockActions.enqueueTurn).toHaveBeenCalledWith(STREAM_ID, 'queued while working', undefined);
  expect(mockActions.sendTurn).not.toHaveBeenCalled();

  // Empty composer while working: still disabled (empty-input guard preserved).
  fireEvent.changeText(input, '');
  expect(sendButton.props.accessibilityState.disabled).toBe(true);
});

test('opening an already-idle session self-heals a stuck working turn (resync reconciles to idle); composer sendable throughout (B1)', async () => {
  const core = require('pentacle-chat-core');
  // Reproduce the stuck state: the detail turn is 'working' but the daemon (and
  // the all-chats list) report the session idle — working:false.
  mockState = {
    ...mockState,
    sessions: [{ ...session(), working: false }],
    workingByStream: { [STREAM_ID]: { phase: 'working', optimisticId: 'opt-1', sentAt: Date.now() } },
  };

  const rendered = render(<SessionScreen />);
  const input = screen.getByTestId('composer-input');
  const sendButton = screen.getByTestId('composer-send-button');
  fireEvent.changeText(input, 'hello');

  // B1: even with a stuck "working" turn, send is NOT locked (send-while-working).
  expect(sendButton.props.accessibilityState.disabled).toBe(false);

  // An authoritative resync (the daemon session inventory the all-chats list
  // receives continuously) reports the session working:false and reconciles the
  // detail's stuck turn to idle — the underlying self-heal still holds.
  mockState = core.applyPentacleSessionInventory(mockState, [{ ...session(), working: false }]);
  expect(mockState.workingByStream?.[STREAM_ID]?.phase).toBe('idle');

  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(sendButton.props.accessibilityState.disabled).toBe(false);
  expect(input.props.editable).toBe(true);
});

