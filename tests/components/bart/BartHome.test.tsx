// Bart home mount contract (docs/bart_home_contracts.md): the session screen embeds with a caller header.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import BartScreen from '../../../app/(tabs)/bart';
import { BART_STREAM_ID } from '../../../src/components/status/statusSelectors';
const expoRouter = require('expo-router');
import usePentacleToken from '../../../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../../src/services/pentacleStream';
import { useUserPreference } from '../../../src/services/userPreferences';
import type { PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { bartQuestion, bartSession } from './fixtures';

const STREAM_ID = BART_STREAM_ID;
let mockIsFocused = true;
let mockOptimistic: { notificationId: string; questionId: string }[] = [];

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
  const mock = require('../../helpers/mocks/expoRouter').makeMock();
  return {
    ...mock,
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../../src/services/pentacleStream', () => ({
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
  selectOptimisticQuestionAnswerIdentities: jest.fn(() => mockOptimistic),
  selectPentacleConnectionSlice: jest.fn((state) => ({ connected: state.connected, connecting: state.connecting })),
  samePentacleConnectionSlice: jest.fn((a, b) => a.connected === b.connected && a.connecting === b.connecting),
  selectStreamEventsLoadState: jest.fn(() => ({ currentGenerationComplete: true, fresh: true, requestStatus: 'ready' })),
  sameStreamEventsLoadState: jest.fn((a, b) => a.currentGenerationComplete === b.currentGenerationComplete && a.fresh === b.fresh && a.requestStatus === b.requestStatus),
  selectStreamSlice: jest.fn((state, streamId, options = {}) => {
    const core = require('pentacle-chat-core');
    return {
      hasOlderHistoryPage: false,
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
  registerFocusedPentacleStream: jest.fn((id) => jest.requireActual('../../../src/services/pentacleStream').registerFocusedPentacleStream(id)),
  requestFocusedPentacleLivenessProbe: jest.fn(),
  consumeStreamOpenEntrySource: jest.fn(() => 'cold-jump'),
}));
jest.mock('../../../src/services/userPreferences', () => ({
  useUserPreference: jest.fn(),
}));

function session(): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'claude',
    session_name: 'one',
    display_name: 'Lews', title: 'Older title',
    last_event_at: '2026-05-16T12:00:00Z',
    last_text: '',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

beforeEach(() => {
  mockIsFocused = true;
  mockOptimistic = [];
  jest.requireActual('../../../src/services/pentacleStream').__resetPentacleStreamForTests();
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
  jest.requireActual('../../../src/services/pentacleStream').__resetPentacleStreamForTests();
  jest.useRealTimers();
  jest.clearAllMocks();
});


test('Bart renders its synthetic transcript and composer through the real embedded SessionScreen', async () => {
  mockState.events = [{ daemon_seq: 1, stream_id: STREAM_ID, host: 'hostc', provider: 'claude',
    session_id: 'assistant', session_name: 'assistant', kind: 'ASSIST',
    timestamp: '2026-05-16T12:00:00Z', text: 'Synthetic assistant greeting', publish_kind: 'prose' }];
  render(<BartScreen />);
  await act(async () => {});
  expect(screen.getByTestId('bart-header')).toBeTruthy();
  expect(screen.queryByTestId('combined-session-header')).toBeNull();
  expect(screen.getByText('Synthetic assistant greeting')).toBeTruthy();
  expect(screen.getByTestId('composer-input')).toBeTruthy();
  fireEvent.changeText(screen.getByTestId('composer-input'), 'Synthetic request');
  fireEvent.press(screen.getByTestId('composer-send-button'));
  expect(mockActions.sendTurn).toHaveBeenCalledWith(STREAM_ID, 'Synthetic request');
});

test('status opens and closes repeatedly without losing the real Bart focused-stream pin', async () => {
  const stream = jest.requireActual('../../../src/services/pentacleStream');
  const registration = require('../../../src/services/pentacleStream').registerFocusedPentacleStream;
  const view = render(<BartScreen />);
  await act(async () => {});
  expect(stream.__getFocusedPentacleStreamForTests()).toBe(STREAM_ID);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    fireEvent.press(screen.getByLabelText('Lews status, 0 open lanes'));
    await act(async () => {});
    expect(screen.getByTestId('bart-status-overlay')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Close status'));
    expect(screen.queryByTestId('bart-status-overlay')).toBeNull();
    expect(stream.__getFocusedPentacleStreamForTests()).toBe(STREAM_ID);
  }
  expect(registration).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(stream.__getFocusedPentacleStreamForTests()).toBeNull();
});

test('Questions dispatches once per focus visit and is available again after returning', async () => {
  const view = render(<BartScreen />);
  await act(async () => {});
  const router = expoRouter.useRouter();
  const button = screen.getByLabelText('Questions, 0 pending');
  fireEvent.press(button);
  fireEvent.press(button);
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith('/pentacle/questions');
  mockIsFocused = false;
  view.rerender(<BartScreen />);
  mockIsFocused = true;
  view.rerender(<BartScreen />);
  fireEvent.press(screen.getByLabelText('Questions, 0 pending'));
  expect(router.push).toHaveBeenCalledTimes(2);
});


test('both badges derive from real fixture state, include Bart deck pages, and respect partial answers', async () => {
  const other = 'hostc:claude:needs-you';
  mockState = { ...mockState, sessions: [session(), bartSession(other), bartSession('hostc:claude:working', { working: true })],
    notifications: [bartQuestion(STREAM_ID, 2), bartQuestion(other, 2, 1)] };
  const view = render(<BartScreen />);
  await act(async () => {});
  expect(screen.getByLabelText('Sessions, 1 need you')).toBeTruthy();
  expect(screen.getByLabelText('Questions, 3 pending')).toBeTruthy();
  expect(screen.getByLabelText('Lews status, 2 open lanes')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Lews status, 2 open lanes'));
  await act(async () => {});
  fireEvent.press(screen.getByLabelText('Close status'));
  expect(screen.getByLabelText('Questions, 3 pending')).toBeTruthy();
  mockOptimistic = [{ notificationId: `question-${STREAM_ID}`, questionId: `q-${STREAM_ID}-0` }];
  mockState = { ...mockState };
  view.rerender(<BartScreen />);
  expect(screen.getByLabelText('Questions, 2 pending')).toBeTruthy();
  expect(screen.getByLabelText('Sessions, 1 need you')).toBeTruthy();
  mockState = { ...mockState, notifications: [] };
  view.rerender(<BartScreen />);
  expect(screen.queryByTestId('bart-sessions-badge')).toBeNull();
  expect(screen.queryByTestId('bart-questions-badge')).toBeNull();
});


test('live assistant name and host changes update the header through the single identity adapter', async () => {
  const view = render(<BartScreen />);
  await act(async () => {});
  expect(screen.getByLabelText('Lews status, 0 open lanes')).toBeTruthy();
  const Header = require('../../../src/components/bart/BartHeader').default;
  expect(view.UNSAFE_getByType(Header).props.identity.icon).toMatchObject({ host: 'hostc', kind: 'djinni', color: '#1f5bff' });
  mockState = { ...mockState, sessions: [{ ...session(), display_name: 'Example guide', host: 'hostb' }] };
  view.rerender(<BartScreen />);
  expect(screen.getByLabelText('Example guide status, 0 open lanes')).toBeTruthy();
  expect(view.UNSAFE_getByType(Header).props.identity.icon).toMatchObject({ host: 'hostb', kind: 'djinni', color: '#ff2e3e' });
  mockState = { ...mockState, sessions: [{ ...session(), display_name: '', title: '' }] };
  view.rerender(<BartScreen />);
  expect(screen.getByLabelText('Assistant status, 0 open lanes')).toBeTruthy();
});
