// Bart home mount contract (docs/bart_home_contracts.md): the session screen embeds with a caller header.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import RouteSessionScreen, { SessionScreen } from '../app/pentacle/session/[streamId]';
import { Text } from 'react-native';
const expoRouter = require('expo-router');
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

test('embedded SessionScreen renders the caller header instead of the combined header', () => {
  render(<SessionScreen streamId={STREAM_ID} header={<Text testID="bart-header">Bart</Text>} />);
  expect(screen.getByTestId('bart-header')).toBeTruthy();
  expect(screen.queryByTestId('combined-session-header')).toBeNull();
  expect(screen.queryByLabelText('Back to chats')).toBeNull();
  expect(screen.getByTestId('composer-input')).toBeTruthy();
});

test('the session route keeps its combined header', () => {
  render(<RouteSessionScreen />);
  expect(screen.getByTestId('combined-session-header')).toBeTruthy();
  expect(screen.getByLabelText('Back to chats')).toBeTruthy();
});

test('an embedded screen never redirects away on a missing session; the route still does', () => {
  mockState = { ...mockState, sessions: [] };
  const { replace } = expoRouter.useRouter();
  const embedded = render(<SessionScreen streamId={STREAM_ID} header={<Text>Bart</Text>} />);
  act(() => { jest.advanceTimersByTime(5_000); });
  expect(replace).not.toHaveBeenCalled();
  embedded.unmount();
  render(<RouteSessionScreen />);
  act(() => { jest.advanceTimersByTime(5_000); });
  expect(replace).toHaveBeenCalledWith('/chats');
});
