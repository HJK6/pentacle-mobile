// B1 (ESC cancel + multi-ESC debounce, D4): an ESC/interrupt affordance is visible
// only while the agent is working and issues exactly ONE effective `send.interrupt`
// per working turn (spamming is dangerous — ESC#2 cancels auto-flushed queued
// work). A new working turn re-arms the interrupt. Also folds in the A1 QA nit: a
// fast double-tap of Send dispatches exactly once (sendInFlightRef latch).
// queue case rows: docs/behavior-contract.md.

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SessionScreen from '../app/pentacle/session/[streamId]';
import { Spinner } from '../src/components/ArcaneAtoms';
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
  dispatchQueuedSendsByOptimisticId: jest.fn(),
  flushQueuedSends: jest.fn(),
  interruptSend: jest.fn((): Promise<unknown> => Promise.resolve(true)),
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
// Host sigils resolve from configured hosts; the stub's default hostOrder
// (['hosta','hostb','hostc']) skins host 'hostc' as its positional machine (mage).
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
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
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => ({ currentGenerationComplete: true, fresh: true, requestStatus: 'ready' })),
  sameStreamEventsLoadState: jest.fn((a, b) => a.currentGenerationComplete === b.currentGenerationComplete && a.fresh === b.fresh && a.requestStatus === b.requestStatus),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => []),
	  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
	    const core = require('pentacle-chat-core');
	    const returned = (Object.values(state.optimisticSends ?? {}) as any[]).find((send) => (
	      send.stream_id === streamId && send.status === 'returned_to_prompt'
	    ));
	    return {
	      connecting: state.connecting,
	      hasHydrated: state.hasHydrated,
	      session: state.sessions.find((item: any) => item.stream_id === streamId) || null,
	      detail: streamId ? core.selectSessionDetail(state, streamId, options) : null,
	      workingState: state.workingStates?.[streamId],
	      turn: state.workingByStream?.[streamId] ?? core.IDLE_TURN,
	      returnedToPromptDraft: returned
	        ? { optimisticId: returned.optimistic_id, text: returned.text }
	        : undefined,
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

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    title: 'Chat',
    last_event_at: '2026-06-17T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
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

function revealWorkingRow(ms: number = 275) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-06-17T12:00:00.000Z') });
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
  } as unknown as PentacleStreamState;
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled: boolean, selector: any) => selector(mockState));
  (useUserPreference as jest.Mock).mockImplementation(() => [false, jest.fn()]);
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.sendTurn.mockReturnValue('optimistic_test_1');
  mockActions.interruptSend.mockReturnValue(Promise.resolve(true));
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

test('the ESC interrupt affordance is hidden while idle and visible while working', async () => {
  const rendered = render(<SessionScreen />);
  expect(screen.queryByTestId('esc-interrupt-button')).toBeNull();
  expect(screen.queryByTestId('working-dock')).toBeNull();

  setTurn({ phase: 'working', optimisticId: 'opt-1', sentAt: Date.now(), firstServerEventAt: Date.now() });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.queryByTestId('esc-interrupt-button')).toBeNull();
  revealWorkingRow();
  expect(screen.queryByTestId('esc-interrupt-button')).not.toBeNull();
  expect(screen.queryByTestId('working-dock')).not.toBeNull();
});

test('C: working row renders spinner, timer, and icon-only cancel using machine accent', async () => {
  setTurn({ phase: 'working', optimisticId: 'opt-1', sentAt: Date.now(), firstServerEventAt: Date.now() });
  const rendered = render(<SessionScreen />);
  revealWorkingRow();

  expect(screen.getByTestId('working-indicator-spinner')).toBeTruthy();
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:00');
  expect(screen.getByTestId('working-indicator-cancel-glyph')).toBeTruthy();
  expect(screen.queryByText('ESC · interrupt')).toBeNull();
  expect(screen.queryByText('Cancel')).toBeNull();

  const accent = '#29d4ff';
  const timerStyle = StyleSheet.flatten(screen.getByTestId('working-indicator-timer').props.style);
  expect(timerStyle.color).toBe(accent);
  expect(timerStyle.fontSize).toBe(12);
  expect(timerStyle.letterSpacing).toBe(1);
  const glyphStyle = StyleSheet.flatten(screen.getByTestId('working-indicator-cancel-glyph').props.style);
  expect(glyphStyle.backgroundColor).toBe(accent);
  const cancelStyle = StyleSheet.flatten(screen.getByTestId('esc-interrupt-button').props.style);
  expect(cancelStyle.borderColor).toBe(`${accent}54`);

  const rowSpinners = rendered.UNSAFE_getAllByType(Spinner).filter((node) => node.props.strokeWidth === 3);
  expect(rowSpinners).toHaveLength(1);
  expect(rowSpinners[0].props).toMatchObject({
    color: accent,
    size: 13,
    durationMs: 800,
    trackOpacity: 0.15,
    segmentFraction: 0.25,
  });
});

test('C: working timer starts at zero, ticks from captured start time, and clears on exit', async () => {
  const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
  const rendered = render(<SessionScreen />);

  setTurn({ phase: 'working', optimisticId: 'opt-1', sentAt: Date.now(), firstServerEventAt: Date.now() });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.queryByTestId('working-indicator-timer')).toBeNull();
  revealWorkingRow();
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:00');

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(screen.getByTestId('working-indicator-timer').props.children).toBe('00:01');

  setTurn({ phase: 'idle', endedAt: Date.now(), endReason: 'turn_summary' });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  expect(screen.queryByTestId('working-dock')).toBeNull();
  expect(clearIntervalSpy).toHaveBeenCalled();
  clearIntervalSpy.mockRestore();
});

test('FIX#2: ESC affordance renders for a daemon-only working session (no local turn) and one press fires exactly one send.interrupt', async () => {
  // The daemon reports the session working but there is NO local optimistic turn
  // (app reopened / turn started elsewhere): showWorking is true via session.working.
  mockState = { ...mockState, sessions: [session({ working: true })] };
  render(<SessionScreen />);
  revealWorkingRow();

  const button = screen.getByTestId('esc-interrupt-button');
  // The latch identity is empty (":") with no local turn — spamming still
  // coalesces to exactly one effective interrupt, with no crash.
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);
  expect(mockActions.interruptSend).toHaveBeenCalledWith(STREAM_ID);
});

test('FIX#1: the idle flush effect does NOT fire when no legacy held sends are pending', () => {
  // Fresh idle session, empty transcript → no legacy turn_queued rows → no flush.
  render(<SessionScreen />);
  expect(mockActions.flushQueuedSends).not.toHaveBeenCalled();
});

test('FIX#1: a send while working dispatches the queued optimistic id through the native queue', async () => {
  setTurn({ phase: 'working', optimisticId: 'opt-active', sentAt: Date.now(), firstServerEventAt: Date.now() });
  render(<SessionScreen />);
  fireEvent.changeText(screen.getByTestId('composer-input'), 'queued behind active turn');

  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });

  expect(mockActions.enqueueTurn).toHaveBeenCalledWith(STREAM_ID, 'queued behind active turn', undefined);
  expect(mockActions.dispatchQueuedSendsByOptimisticId).toHaveBeenCalledTimes(1);
  expect(mockActions.dispatchQueuedSendsByOptimisticId).toHaveBeenCalledWith(STREAM_ID, 'optimistic_queued_1');
  expect(mockActions.flushQueuedSends).not.toHaveBeenCalled();
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
});

test('pressing ESC while working issues a single send.interrupt for the stream', async () => {
  setTurn({ phase: 'working', optimisticId: 'opt-1', sentAt: Date.now(), firstServerEventAt: Date.now() });
  render(<SessionScreen />);
  revealWorkingRow();

  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);
  expect(mockActions.interruptSend).toHaveBeenCalledWith(STREAM_ID);
});

test('multi-ESC debounce: N rapid presses in one working turn → exactly ONE interrupt; a new working turn re-arms', async () => {
  setTurn({ phase: 'working', optimisticId: 'opt-1', sentAt: 1000, firstServerEventAt: 1000 });
  const rendered = render(<SessionScreen />);
  revealWorkingRow();
  const button = screen.getByTestId('esc-interrupt-button');

  // Spam ESC within the SAME working turn — coalesced to one effective interrupt.
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
    fireEvent.press(button);
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);

  // A NEW working turn (the queue auto-flushed into a fresh turn) re-arms the
  // latch — one more interrupt is allowed.
  setTurn({ phase: 'working', optimisticId: 'opt-2', sentAt: 2000, firstServerEventAt: 2000 });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow();
  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(2);
});

test('Case C: unconfirmed interrupt re-arms same-turn stop and shows retry affordance', async () => {
  mockActions.interruptSend.mockResolvedValue({
    interrupted: true,
    landed: false,
    confirm: 'interrupt_unconfirmed',
    coalesced: false,
  });
  setTurn({ phase: 'working', optimisticId: 'opt-1', sentAt: 1000, firstServerEventAt: 1000 });
  render(<SessionScreen />);
  revealWorkingRow();

  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });

  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/interrupted/i)).toBeNull();
  expect(screen.getByTestId('interrupt-retry-affordance').props.children).toBe('Stop did not take. Tap again to retry.');

  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });

  expect(mockActions.interruptSend).toHaveBeenCalledTimes(2);
});

test('Case B: returned-to-prompt retraction restores an empty composer and leaves no sent bubble', async () => {
  const core = require('pentacle-chat-core');
  mockState = core.sendOptimisticMessage(mockState, {
    streamId: STREAM_ID,
    text: 'edit before resending',
    optimisticId: 'optimistic_case_b',
    requestId: 'request-case-b',
    createdAt: Date.now(),
    windowStartedAt: Date.now(),
  });
  const rendered = render(<SessionScreen />);

  mockState = core.reconcileOptimisticSendWithServerEvent(
    mockState,
    'optimistic_case_b',
    {
      daemon_seq: 99,
      host: 'hostc',
      provider: 'claude',
      session_id: STREAM_ID,
      session_name: 'one',
      stream_id: STREAM_ID,
      timestamp: '2026-06-17T12:00:01.000Z',
      kind: 'USER',
      text: 'edit before resending',
      raw: { returned_to_prompt: true, user_delivery_state: 'returned_to_prompt' },
    },
  );

  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });

  expect(screen.getByTestId('composer-input').props.value).toBe('edit before resending');
  expect(core.selectSessionDetail(mockState, STREAM_ID, { visibleCount: 'all' })?.transcriptItems).toHaveLength(0);

  fireEvent.changeText(screen.getByTestId('composer-input'), 'do not overwrite me');
  const returnedSend = mockState.optimisticSends!.optimistic_case_b;
  mockState = {
    ...mockState,
    optimisticSends: {
      ...mockState.optimisticSends,
      optimistic_case_b_late: {
        ...returnedSend,
        optimistic_id: 'optimistic_case_b_late',
        text: 'late returned draft',
      },
    },
  };
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });

  expect(screen.getByTestId('composer-input').props.value).toBe('do not overwrite me');
});

test('rapid-send case: a fast double-tap of Send dispatches sendTurn + sendMessage exactly once (sendInFlightRef latch)', async () => {
  render(<SessionScreen />);
  const input = screen.getByTestId('composer-input');
  const sendButton = screen.getByTestId('composer-send-button');
  fireEvent.changeText(input, 'only once');

  // Two synchronous presses before the first send settles → the latch swallows
  // the second.
  await act(async () => {
    fireEvent.press(sendButton);
    fireEvent.press(sendButton);
  });

  expect(mockActions.sendTurn).toHaveBeenCalledTimes(1);
  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
});

