// Bart home mount contract (docs/bart_home_contracts.md): the session screen embeds with a caller header.
import React from 'react';
import { assistantAccent } from '../../../src/components/bart/assistantIdentity';
import { Modal } from 'react-native';
import ChatsDrawer from '../../../src/components/bart/ChatsDrawer';
import SummonModal from '../../../src/components/SummonModal';
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
  getSpawnCatalog: jest.fn(), spawnSessionV2: jest.fn(),
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
  mockActions.getSpawnCatalog.mockResolvedValue({ schema_version: 'CatalogV1', catalog_version: 'synthetic-catalog',
    profiles: { desktop_manual: { claude: ['sample-claude', 'high'], codex: ['sample-codex', 'high'] } },
    models: { claude: { 'sample-claude': { aliases: [], efforts: ['high'] } }, codex: { 'sample-codex': { aliases: [], efforts: ['high'] } } } });
  mockActions.spawnSessionV2.mockResolvedValue({ session: { stream_id: 'hostc:claude:created' } });
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

test('the header lanes tap opens the lanes route once per focus visit without losing the Bart focus pin', async () => {
  const stream = jest.requireActual('../../../src/services/pentacleStream');
  const registration = require('../../../src/services/pentacleStream').registerFocusedPentacleStream;
  const view = render(<BartScreen />);
  await act(async () => {});
  const router = expoRouter.useRouter();
  expect(stream.__getFocusedPentacleStreamForTests()).toBe(STREAM_ID);
  const lanes = screen.getByLabelText('Lews status, 0 open lanes');
  fireEvent.press(lanes);
  fireEvent.press(lanes);
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith('/pentacle/lanes');
  expect(screen.queryByTestId('bart-status-overlay')).toBeNull();
  expect(registration).toHaveBeenCalledTimes(1);
  mockIsFocused = false;
  view.rerender(<BartScreen />);
  mockIsFocused = true;
  view.rerender(<BartScreen />);
  fireEvent.press(screen.getByLabelText('Lews status, 0 open lanes'));
  expect(router.push).toHaveBeenCalledTimes(2);
  expect(stream.__getFocusedPentacleStreamForTests()).toBe(STREAM_ID);
  view.unmount();
  expect(stream.__getFocusedPentacleStreamForTests()).toBeNull();
});

test('a failed lanes router dispatch can be retried', async () => {
  render(<BartScreen />);
  await act(async () => {});
  const router = expoRouter.useRouter();
  router.push.mockImplementationOnce(() => { throw new Error('Synthetic router unavailable'); });
  fireEvent.press(screen.getByLabelText('Lews status, 0 open lanes'));
  fireEvent.press(screen.getByLabelText('Lews status, 0 open lanes'));
  expect(router.push).toHaveBeenCalledTimes(2);
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
  // Busy sessions are not lanes: the header count is the daemon's open-lane count.
  expect(screen.getByLabelText('Lews status, 0 open lanes')).toBeTruthy();
  mockState = { ...mockState, workLanes: { lanes: [], truncated: false, generated_at: '',
    counts: { open: 3, active: 1, paused: 1, blocked: 1 } } };
  view.rerender(<BartScreen />);
  expect(screen.getByLabelText('Lews status, 3 open lanes, 1 blocked')).toBeTruthy();
  expect(screen.getByText('3 LANES')).toBeTruthy();
  expect(screen.getByTestId('bart-lanes-blocked').props.children).toEqual([1, ' BLOCKED']);
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


test('Bart home shows only the header Questions button for its own open question and still opens the overlay', async () => {
  mockState = { ...mockState, notifications: [bartQuestion(STREAM_ID, 2)] };
  render(<BartScreen />);
  await act(async () => {});
  expect(screen.getByLabelText('Questions, 2 pending')).toBeTruthy();
  expect(screen.queryByTestId('question-fab')).toBeNull();
  expect(screen.queryByTestId('question-fab-dock')).toBeNull();
  expect(screen.queryByLabelText('2 unanswered questions')).toBeNull();
  fireEvent.press(screen.getByLabelText('Questions, 2 pending'));
  expect(expoRouter.useRouter().push).toHaveBeenCalledWith('/pentacle/questions');
});


test('drawer rows open once and immediate return permits opening the same row again', async () => {
  const other = 'hostc:claude:sample';
  mockState = { ...mockState, sessions: [session(), bartSession(other)], notifications: [bartQuestion(other)] };
  const view = render(<BartScreen />);
  await act(async () => {});
  for (let cycle = 0; cycle < 2; cycle += 1) {
    fireEvent.press(screen.getByLabelText('Sessions, 1 need you'));
    const row = screen.getByTestId(`bart-drawer-row-${other}`);
    fireEvent.press(row);
    fireEvent.press(row);
    expect(expoRouter.useRouter().push).toHaveBeenCalledTimes(cycle + 1);
    mockIsFocused = false;
    view.rerender(<BartScreen />);
    mockIsFocused = true;
    view.rerender(<BartScreen />);
    expect(screen.getByLabelText('Sessions, 1 need you')).toBeTruthy();
  }
});

test('drawer + uses the real shared flow once after dismissal, filters identity hosts, and routes the spawn', async () => {
  mockState = { ...mockState, hosts: {
    hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 },
    hostb: { host: 'hostb', online: false, checked_at: '', session_count: 0 },
    bart: { host: 'bart', online: true, checked_at: '', session_count: 0 },
  } };
  const view = render(<BartScreen />);
  await act(async () => {});
  expect(view.UNSAFE_getAllByType(SummonModal)).toHaveLength(1);
  fireEvent.press(screen.getByLabelText('Sessions, 0 need you'));
  fireEvent.press(screen.getByLabelText('New session'));
  fireEvent.press(screen.getByLabelText('New session'));
  expect(mockActions.getSpawnCatalog).not.toHaveBeenCalled();
  expect(view.UNSAFE_getByType(ChatsDrawer).props.open).toBe(false);
  act(() => jest.advanceTimersByTime(400));
  const drawerModal = view.UNSAFE_getAllByType(Modal).find((modal) => modal.props.onDismiss)!;
  await act(async () => drawerModal.props.onDismiss());
  expect(mockActions.getSpawnCatalog).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('summon-machine-bart')).toBeNull();
  expect(screen.getByTestId('summon-machine-hostb')).toBeDisabled();
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await act(async () => {});
  expect(screen.getByTestId('summon-submit')).not.toBeDisabled();
  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-submit'));
    fireEvent.press(screen.getByTestId('summon-submit'));
  });
  expect(mockActions.spawnSessionV2).toHaveBeenCalledTimes(1);
  expect(expoRouter.useRouter().push).toHaveBeenCalledTimes(1);
  expect(expoRouter.useRouter().push).toHaveBeenCalledWith('/pentacle/session/hostc%3Aclaude%3Acreated');
});

test('failed Questions router dispatch can be retried', async () => {
  render(<BartScreen />);
  await act(async () => {});
  const router = expoRouter.useRouter();
  router.push.mockImplementationOnce(() => { throw new Error('Synthetic router unavailable'); });
  fireEvent.press(screen.getByLabelText('Questions, 0 pending'));
  fireEvent.press(screen.getByLabelText('Questions, 0 pending'));
  expect(router.push).toHaveBeenCalledTimes(2);
});

test('newer navigation cancels a queued drawer-to-summon transition', async () => {
  mockState = { ...mockState, hosts: { hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 } } };
  const view = render(<BartScreen />);
  await act(async () => {});
  fireEvent.press(screen.getByLabelText('Sessions, 0 need you'));
  fireEvent.press(screen.getByLabelText('New session'));
  const dismiss = view.UNSAFE_getAllByType(Modal).find((modal) => modal.props.onDismiss)!.props.onDismiss;
  mockIsFocused = false;
  view.rerender(<BartScreen />);
  await act(async () => { jest.advanceTimersByTime(400); dismiss(); });
  expect(mockActions.getSpawnCatalog).not.toHaveBeenCalled();
  expect(screen.queryByTestId('summon-machine-hostc')).toBeNull();
  mockIsFocused = true;
  view.rerender(<BartScreen />);
  expect(screen.queryByTestId('summon-machine-hostc')).toBeNull();
});

test('live assistant name and host changes update the header through the single identity adapter', async () => {
  const view = render(<BartScreen />);
  await act(async () => {});
  expect(screen.getByLabelText('Lews status, 0 open lanes')).toBeTruthy();
  const Header = require('../../../src/components/bart/BartHeader').default;
  expect(view.UNSAFE_getByType(Header).props.identity).toMatchObject({ hostId: 'hostc', sigilKind: 'djinni' });
  expect(assistantAccent(view.UNSAFE_getByType(Header).props.identity)).toBe('#1f5bff');
  mockState = { ...mockState, sessions: [{ ...session(), display_name: 'Example guide', host: 'hostb' }] };
  view.rerender(<BartScreen />);
  expect(screen.getByLabelText('Example guide status, 0 open lanes')).toBeTruthy();
  expect(view.UNSAFE_getByType(Header).props.identity).toMatchObject({ hostId: 'hostb', sigilKind: 'djinni' });
  expect(assistantAccent(view.UNSAFE_getByType(Header).props.identity)).toBe('#ff2e3e');
  mockState = { ...mockState, sessions: [{ ...session(), display_name: '', title: '' }] };
  view.rerender(<BartScreen />);
  expect(screen.getByLabelText('Assistant status, 0 open lanes')).toBeTruthy();
});
