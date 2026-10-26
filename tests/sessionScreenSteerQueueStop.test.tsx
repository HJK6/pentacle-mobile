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
  canSendQueuedNow: jest.fn(() => true),
  sendQueuedNow: jest.fn().mockResolvedValue({ confirm: 'interrupt_unconfirmed', interrupted: true }),
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
jest.mock('../src/services/imageCapture', () => ({
  ...jest.requireActual('../src/services/imageCapture'),
  pickImagesFromLibrary: jest.fn().mockResolvedValue([{ uri: 'file:///owned-staged.jpg', fileName: 'owned-staged.jpg', mimeType: 'image/jpeg', width: 1, height: 1 }]),
  compressForUpload: jest.fn().mockResolvedValue({ uri: 'file:///owned-staged.jpg', fileName: 'owned-staged.jpg', mimeType: 'image/jpeg', width: 1, height: 1, bytes: 3 }),
}));
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
    session_generation: 'g1',
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
  mockActions.canSendQueuedNow.mockReturnValue(true);
  mockActions.sendQueuedNow.mockResolvedValue({ confirm: 'interrupt_unconfirmed', interrupted: true });
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

function addQueued(providerQueued: boolean = true) {
  const core = require('pentacle-chat-core');
  mockState = core.enqueueOptimisticMessage(mockState, {
    streamId: STREAM_ID, text: 'queued payload', optimisticId: 'optimistic_q', requestId: 'request-q',
    createdAt: Date.now(), queuedAt: Date.now(),
  });
  if (providerQueued) mockState = core.recordOptimisticSendAcceptanceByRequestId(mockState, 'request-q', { provider_queued: true });
}

test('default-send regression: working composer has no per-send chooser', async () => {
  renderWorking();
  expect(screen.queryByTestId('send-mode-row')).toBeNull();
  await send('ordinary busy send');
  expect(mockActions.dispatchQueuedSendsByOptimisticId).toHaveBeenCalledWith(STREAM_ID, 'optimistic_queued_1');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
});

test('ordinary idle Send keeps the existing direct dispatch path', async () => {
  render(<SessionScreen />);
  await send('ordinary idle');
  expect(mockActions.sendTurn).toHaveBeenCalledWith(STREAM_ID, 'ordinary idle');
  expect(mockActions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'ordinary idle' }));
  expect(mockActions.sendMessage.mock.calls[0][0]).not.toHaveProperty('urgent');
});

test('composite Send retains its normal wire route and no chooser', async () => {
  renderWorking({ session_kind: 'assistant_composite', provider: 'composite' } as Partial<PentacleSessionSummary>);
  expect(screen.queryByTestId('send-mode-row')).toBeNull();
  await send('to composite');
  expect(mockActions.enqueueTurn).toHaveBeenCalledWith(STREAM_ID, 'to composite', undefined);
  expect(mockActions.sendQueuedNow).not.toHaveBeenCalled();
});

test('only provider queue proof offers row Send now; it leaves the unsent draft and row intact', async () => {
  addQueued();
  renderWorking();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'unsent draft');
  await act(async () => { fireEvent.press(screen.getByTestId('queued-send-now')); });
  expect(mockActions.sendQueuedNow).toHaveBeenCalledWith(STREAM_ID, 'optimistic_q');
  expect(mockActions.enqueueTurn).not.toHaveBeenCalled();
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
  expect(screen.getByTestId('composer-input').props.value).toBe('unsent draft');
  expect(screen.getByTestId('composer-notice').props.children).toMatch(/Waiting for the queued message/);
  expect(mockState.optimisticSends!.optimistic_q.text).toBe('queued payload');
});

test('provider queue action survives stale local idle hints', async () => {
  addQueued();
  render(<SessionScreen />);
  await act(async () => { fireEvent.press(screen.getByTestId('queued-send-now')); });
  expect(mockActions.sendQueuedNow).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('composer-notice').props.children).toMatch(/Waiting/);
});

test('busy origin without receipt shows Sending and no Send now', () => {
  addQueued(false);
  renderWorking();
  expect(screen.queryByTestId('queued-send-now')).toBeNull();
  expect(screen.getByTestId('user-send-sending')).toBeTruthy();
});

test('current service eligibility disables a stale or spent row action', () => {
  addQueued();
  mockActions.canSendQueuedNow.mockReturnValue(false);
  renderWorking();
  expect(screen.getByTestId('queued-send-now').props.accessibilityState.disabled).toBe(true);
});

test('Stop preserves queued messages and announces native release', async () => {
  addQueued();
  renderWorking();
  await act(async () => { fireEvent.press(screen.getByTestId('esc-interrupt-button')); });
  expect(mockActions.interruptSend).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('composer-notice').props.children).toBe('Stopped. Queued messages run next');
  expect(mockState.optimisticSends!.optimistic_q.text).toBe('queued payload');
});

test('unconfirmed Stop retains Queued and says it is waiting for processing', async () => {
  addQueued();
  mockActions.interruptSend.mockResolvedValueOnce({ confirm: 'interrupt_unconfirmed', interrupted: true });
  renderWorking();
  await act(async () => { fireEvent.press(screen.getByTestId('esc-interrupt-button')); });
  expect(screen.getByTestId('queued-message-row')).toBeTruthy();
  expect(screen.getByTestId('composer-notice').props.children).toMatch(/Waiting for queued messages/);
});

test('Send now preserves the real composer staged attachment and draft without upload/resend', async () => {
  addQueued(); renderWorking();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'unsent with image');
  await act(async () => { fireEvent.press(screen.getByTestId('composer-plus-button')); });
  await act(async () => { fireEvent.press(screen.getByTestId('composer-photo-button')); });
  const before = screen.getByTestId('composer-attachment-thumb-0').props.source;
  expect(before).toEqual({ uri: 'file:///owned-staged.jpg' });
  await act(async () => { fireEvent.press(screen.getByTestId('queued-send-now')); });
  expect(screen.getByTestId('composer-attachment-thumb-0').props.source).toEqual(before);
  expect(screen.getByTestId('composer-input').props.value).toBe('unsent with image');
  expect(mockActions.sendMessage).not.toHaveBeenCalled(); expect(mockActions.enqueueTurn).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByTestId('composer-attachment-remove-0')); });
});

test('a coalesced or stale Send now press does not claim another interrupt was requested', async () => {
  addQueued(); renderWorking();
  mockActions.sendQueuedNow.mockResolvedValueOnce({ confirm: 'coalesced', interrupted: false });
  await act(async () => { fireEvent.press(screen.getByTestId('queued-send-now')); });
  expect(screen.getByTestId('composer-notice').props.children).toBe('No new Send now request was sent.');
  expect(mockActions.sendMessage).not.toHaveBeenCalled();
});
