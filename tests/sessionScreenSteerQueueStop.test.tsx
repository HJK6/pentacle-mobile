// Steer now / Queue / Stop on agent chats: the mode control shows only while an
// agent chat works (never on the composite), Steer now sends one urgent message
// directly, and Stop and Steer now share one Escape per working turn.

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
  takeSteerNotTaken: jest.fn(() => false),
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


const WORKING = { phase: 'working', optimisticId: 'opt-1', sentAt: 1000, firstServerEventAt: 1000 } as TurnState;

function renderWorking(overrides: Partial<PentacleSessionSummary> = {}, turn: TurnState = WORKING) {
  mockState = { ...mockState, sessions: [session(overrides)] };
  setTurn(turn);
  const rendered = render(<SessionScreen />);
  revealWorkingRow();
  return rendered;
}

async function send(text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
}

const selected = (option: 'queue' | 'steer') => screen.getByTestId(`send-mode-${option}`).props.accessibilityState.selected;

test('the mode control is hidden while idle, shown while an agent chat works, and defaults to Queue', async () => {
  const rendered = render(<SessionScreen />);
  expect(screen.queryByTestId('send-mode-row')).toBeNull();

  setTurn(WORKING);
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow();
  expect(screen.getByTestId('send-mode-row')).toBeTruthy();
  expect(selected('queue')).toBe(true);
  expect(selected('steer')).toBe(false);
});

test('the assistant composite chat shows no mode control even while working, and never sends urgent', async () => {
  renderWorking({ session_kind: 'assistant_composite', provider: 'composite' } as Partial<PentacleSessionSummary>);
  expect(screen.queryByTestId('send-mode-row')).toBeNull();

  await send('to the composite');
  expect(mockActions.enqueueTurn).toHaveBeenCalledWith(STREAM_ID, 'to the composite', undefined);
  for (const [args] of mockActions.sendMessage.mock.calls as Array<[Record<string, unknown>]>) {
    expect('urgent' in args).toBe(false);
  }
});

test('Queue sends through the native queue exactly as before', async () => {
  renderWorking();
  await send('run after this turn');
  expect(mockActions.enqueueTurn).toHaveBeenCalledWith(STREAM_ID, 'run after this turn', undefined);
  expect(mockActions.dispatchQueuedSendsByOptimisticId).toHaveBeenCalledWith(STREAM_ID, 'optimistic_queued_1');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
});

test('Steer now sends urgent directly (no held queue), then the mode returns to Queue', async () => {
  renderWorking();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  expect(selected('steer')).toBe(true);

  await send('interrupt and do this');
  expect(mockActions.enqueueTurn).toHaveBeenCalledWith(STREAM_ID, 'interrupt and do this', undefined, undefined, { steer: true });
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc', sessionName: 'one', text: 'interrupt and do this', optimisticId: 'optimistic_queued_1', urgent: true,
  });
  expect(mockActions.dispatchQueuedSendsByOptimisticId).not.toHaveBeenCalled();
  expect(selected('queue')).toBe(true);
  expect(screen.queryByTestId('composer-notice')).toBeNull();
});

test('Steer now on a daemon-only working seat (no local turn) still sends urgent', async () => {
  // The seat works because the daemon says so (started elsewhere, or before this
  // screen opened); the app has no local turn. The control is offered, so it must work.
  renderWorking({ working: true }, { phase: 'idle' } as TurnState);
  expect(screen.getByTestId('send-mode-row')).toBeTruthy();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  expect(selected('steer')).toBe(true);

  await send('interrupt and do this');
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc', sessionName: 'one', text: 'interrupt and do this', optimisticId: 'optimistic_queued_1', urgent: true,
  });
  expect(mockActions.dispatchQueuedSendsByOptimisticId).not.toHaveBeenCalled();
});

test('a second Steer now in the same turn is queued with the did-not-take notice', async () => {
  renderWorking();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('first steer');
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('second steer');

  expect(mockActions.sendMessage).toHaveBeenCalledTimes(1);
  expect(mockActions.enqueueTurn).toHaveBeenLastCalledWith(STREAM_ID, 'second steer', undefined);
  expect(mockActions.dispatchQueuedSendsByOptimisticId).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('composer-notice').props.children).toBe('Steer did not take; queued instead');
});

test('Stop and Steer now share one Escape per working turn, and a new turn re-arms it', async () => {
  const rendered = renderWorking();
  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);

  // Steer now after Stop: demoted to a queued send.
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('steer after stop');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
  expect(screen.getByTestId('composer-notice').props.children).toBe('Steer did not take; queued instead');

  // A new working turn re-arms the Escape.
  setTurn({ ...WORKING, optimisticId: 'opt-2', sentAt: 2000, firstServerEventAt: 2000 });
  await act(async () => {
    rendered.rerender(<SessionScreen />);
  });
  revealWorkingRow();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('steer in the new turn');
  expect(mockActions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'steer in the new turn', urgent: true }));
});

test('Stop after Steer now spent the turn Escape is a no-op', async () => {
  renderWorking();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('steer first');
  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  expect(mockActions.interruptSend).not.toHaveBeenCalled();
});

test('a failed interrupt request re-arms the Escape for Steer now', async () => {
  mockActions.interruptSend.mockResolvedValueOnce({ interrupted: true, landed: false, confirm: 'interrupt_unconfirmed', coalesced: false });
  renderWorking();
  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('steer after a failed stop');
  expect(mockActions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ urgent: true }));
});

test('a steer whose receipt still says provider_queued shows the did-not-take notice', async () => {
  mockActions.takeSteerNotTaken.mockReturnValueOnce(true);
  renderWorking();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('steer that stays queued');
  expect(screen.getByTestId('composer-notice').props.children).toBe('Steer did not take; queued instead');
});

test('a failed Steer now send marks its row failed and re-arms the Escape', async () => {
  mockActions.sendMessage.mockRejectedValueOnce(new Error('boom'));
  renderWorking();
  fireEvent.press(screen.getByTestId('send-mode-steer'));
  fireEvent.changeText(screen.getByTestId('composer-input'), 'will fail');
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send-button'));
  });
  expect(mockActions.markOptimisticFailed).toHaveBeenCalledWith('optimistic_queued_1', 'boom');

  fireEvent.press(screen.getByTestId('send-mode-steer'));
  await send('try again');
  expect(mockActions.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'try again', urgent: true }));
});

test('Stop says queued messages run next while queued rows remain, and does not clear them', async () => {
  const core = require('pentacle-chat-core');
  mockState = core.enqueueOptimisticMessage(mockState, {
    streamId: STREAM_ID, text: 'queued behind the turn', optimisticId: 'optimistic_q', requestId: 'request-q',
    createdAt: Date.now(), queuedAt: Date.now(),
  });
  renderWorking();
  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  expect(screen.getByTestId('composer-notice').props.children).toBe('Stopped. Queued messages run next');
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);
  expect(mockState.optimisticSends!.optimistic_q.status).toBe('queued');
});

test('Stop with no queued rows shows no notice', async () => {
  renderWorking();
  await act(async () => {
    fireEvent.press(screen.getByTestId('esc-interrupt-button'));
  });
  expect(screen.queryByTestId('composer-notice')).toBeNull();
});
