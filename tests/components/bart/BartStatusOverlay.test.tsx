import React from 'react';
import { FlatList, Modal } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  initialPentacleStreamState,
  mutatePentacleEventBuckets,
  type PentacleEvent,
  type PentacleNotification,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';
import BartStatusOverlay from '../../../src/components/bart/BartStatusOverlay';
import { selectSmartChatList, smartChatAttention } from '../../../app/(tabs)/chats';
import { selectOpenLanes, selectStatusUpdates } from '../../../src/components/status/statusSelectors';
import { Tokens } from '../../../constants/Colors';
import { resetChatOpenNavigationIntents } from '../../../src/services/chatOpenNavigationIntent';
import { registerFocusedPentacleStream, requestStreamEvents } from '../../../src/services/pentacleStream';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const BART = 'bart:assistant';
let mockState: PentacleStreamState;
let mockIsFocused = true;
let mockHasOlderHistory = false;
let mockFresh = false;
const mockClose = jest.fn();
const mockReleaseFocus = jest.fn();

jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/services/pentacleStream', () => ({
  getPentacleStreamState: () => mockState,
  usePentacleStreamSelectorWhen: jest.fn((_enabled, selector) => selector(mockState)),
  usePentacleStreamSelector: jest.fn((selector) => selector(mockState)),
  selectOptimisticQuestionAnswerIdentities: () => [],
  selectStreamSlice: () => ({ hasOlderHistoryPage: mockHasOlderHistory }),
  selectStreamEventsLoadState: () => ({ fresh: mockFresh, requestStatus: "idle" }),
  registerFocusedPentacleStream: jest.fn(() => mockReleaseFocus),
  requestStreamEvents: jest.fn(),
  usePentacleStreamActions: jest.fn(() => ({})),
}));
jest.mock('pentacle-chat-core', () => ({
  ...jest.requireActual('pentacle-chat-core'),
  logTelemetry: jest.fn(),
}));

function session(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: streamId, host: 'hostc', provider: 'codex',
    session_name: streamId.split(':').at(-1)!, title: streamId.split(':').at(-1),
    last_event_at: new Date(NOW).toISOString(), last_text: '', last_kind: 'ASSIST',
    draft: '', pending: false, working: false, online: true,
    ...overrides,
  };
}

function event(seq: number, text: string, overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: seq, host: 'hostc', provider: 'codex', session_id: 'assistant',
    session_name: 'assistant', stream_id: BART, kind: 'ASSIST',
    timestamp: new Date(NOW - 600_000 + seq * 1000).toISOString(),
    text, publish_kind: 'status', ...overrides,
  };
}

function question(streamId: string, resolved = false): PentacleNotification {
  return {
    notification_id: `question-${streamId}`, created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(), producer: 'agent_question.v1',
    answer_to_stream_id: streamId, severity: 'info', title: 'Choose a sample',
    body: 'Which sample should run?', dedup_key: `question:${streamId}`,
    state: resolved ? 'resolved' : 'open', actions: [{ kind: 'yes_no', action_id: 'choose' }],
    question: {
      question_id: `q-${streamId}`, producer_stream_id: streamId,
      response_mode: 'single_choice', options: [{ label: 'Sample A', value: 'a' }],
      state: resolved ? 'answered' : 'open', answer: null,
    },
    resolution: null, ttl_seconds: 3600,
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    resolved_at: resolved ? new Date(NOW).toISOString() : null,
  } as PentacleNotification;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  resetChatOpenNavigationIntents();
  mockIsFocused = true;
  mockHasOlderHistory = false;
  mockFresh = false;
  mockState = { ...initialPentacleStreamState, connected: true, hasHydrated: true, sessions: [], events: [], notifications: [] };
  (requestStreamEvents as jest.Mock).mockReset().mockResolvedValue([]);
});

afterEach(() => resetChatOpenNavigationIntents());

test('focus and reconnect fetch the assistant history without per-lane polling', async () => {
  mockState = { ...mockState, connected: false };
  const rendered = render(<BartStatusOverlay onClose={mockClose} />);
  expect(registerFocusedPentacleStream).not.toHaveBeenCalled();
  expect(requestStreamEvents).not.toHaveBeenCalled();
  mockState = { ...mockState, connected: true };
  await act(async () => rendered.rerender(<BartStatusOverlay onClose={mockClose} />));
  expect(requestStreamEvents).toHaveBeenLastCalledWith(BART, 300, { purpose: 'mount-fetch' });
  const count = (requestStreamEvents as jest.Mock).mock.calls.length;
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(requestStreamEvents).toHaveBeenCalledTimes(count);
  mockState = { ...mockState, connected: false };
  await act(async () => rendered.rerender(<BartStatusOverlay onClose={mockClose} />));
  mockState = { ...mockState, connected: true };
  await act(async () => rendered.rerender(<BartStatusOverlay onClose={mockClose} />));
  expect(requestStreamEvents).toHaveBeenCalledTimes(count + 1);
  mockIsFocused = false;
  rendered.rerender(<BartStatusOverlay onClose={mockClose} />);
  expect(mockReleaseFocus).not.toHaveBeenCalled();
  rendered.unmount();
});

test('one end-of-list demand crosses prose-only pages until an earlier status arrives', async () => {
  mockState = mutatePentacleEventBuckets(mockState, { type: 'append', events: [event(1000, 'Retained status')] });
  mockHasOlderHistory = true;
  const rendered = render(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  const prosePage = Array.from({ length: 300 }, (_, i) => event(700 + i, `Synthetic prose ${i}`, { publish_kind: 'prose' }));
  const statusPage = [event(600, 'Earlier status')];
  (requestStreamEvents as jest.Mock).mockReset().mockImplementation(async () => {
    const page = (requestStreamEvents as jest.Mock).mock.calls.length === 1 ? prosePage : statusPage;
    mockState = mutatePentacleEventBuckets(mockState, { type: 'append', events: page });
    return page;
  });
  fireEvent.press(screen.getByText('All updates · 1 ›'));
  const VirtualizedList = require('react-native/Libraries/Lists/VirtualizedList').default;
  const list = rendered.UNSAFE_getByType(VirtualizedList).instance as any;
  list._listMetrics.hasContentLength = () => true;
  list._listMetrics.getContentLength = () => 160;
  list._scrollMetrics.visibleLength = 600;
  list._scrollMetrics.offset = 0;
  list.state.pendingScrollUpdateCount = 0;
  list.state.cellsAroundViewport = { first: 0, last: 0 };
  await act(async () => list._maybeCallOnEdgeReached());
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  rendered.rerender(<BartStatusOverlay onClose={mockClose} />);
  expect(screen.getByText('Earlier status')).toBeTruthy();
});

test.each(['back', 'blur'] as const)('a pending sparse scan stops after %s', async (leave) => {
  mockState.events = [event(1000, 'Retained status')];
  mockHasOlderHistory = true;
  const rendered = render(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  let settle!: (events: PentacleEvent[]) => void;
  (requestStreamEvents as jest.Mock).mockReset().mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  fireEvent.press(screen.getByText('All updates · 1 ›'));
  act(() => { rendered.UNSAFE_getByType(FlatList).props.onEndReached(); });
  if (leave === 'back') fireEvent.press(screen.getByLabelText('Back to status'));
  else { mockIsFocused = false; rendered.rerender(<BartStatusOverlay onClose={mockClose} />); }
  await act(async () => settle(Array.from({ length: 300 }, (_, i) => event(700 + i, 'Prose', { publish_kind: 'prose' }))));
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
});

test('history failures are bounded and recover when focus returns', async () => {
  (requestStreamEvents as jest.Mock).mockRejectedValueOnce(new Error('Synthetic offline error'));
  const rendered = render(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  expect(screen.getByText('Updates unavailable')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  mockIsFocused = false;
  rendered.rerender(<BartStatusOverlay onClose={mockClose} />);
  mockIsFocused = true;
  rendered.rerender(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Updates unavailable')).toBeNull();
});


test('full-screen overlay has a round dismiss control and handles system back', async () => {
  const view = render(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  expect(view.UNSAFE_getByType(Modal).props).toMatchObject({ visible: true, presentationStyle: 'fullScreen', animationType: 'none' });
  expect(screen.getByLabelText('Close status')).toHaveStyle({ width: 34, height: 34, borderRadius: 17 });
  fireEvent.press(screen.getByLabelText('Close status'));
  expect(mockClose).toHaveBeenCalledTimes(1);
  act(() => view.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(mockClose).toHaveBeenCalledTimes(2);
});

test('opening a status lane closes the overlay before duplicate-safe dispatch', async () => {
  const id = 'hostc:codex:sample';
  mockState.sessions = [session(id, { working: true })];
  render(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  const router = require('expo-router').router;
  const row = screen.getByTestId(`lane-${id}`);
  fireEvent.press(row);
  fireEvent.press(row);
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Asample');
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(mockClose.mock.invocationCallOrder[0]).toBeLessThan(router.push.mock.invocationCallOrder[0]);
});

test('closing status leaves the real parent-owned focused stream registration intact', async () => {
  const stream = jest.requireActual('../../../src/services/pentacleStream');
  stream.__resetPentacleStreamForTests();
  const releaseParent = stream.registerFocusedPentacleStream(BART);
  (registerFocusedPentacleStream as jest.Mock).mockImplementation(stream.registerFocusedPentacleStream);
  const view = render(<BartStatusOverlay onClose={mockClose} />);
  await act(async () => {});
  expect(stream.__getFocusedPentacleStreamForTests()).toBe(BART);
  view.unmount();
  expect(stream.__getFocusedPentacleStreamForTests()).toBe(BART);
  expect(registerFocusedPentacleStream).not.toHaveBeenCalled();
  releaseParent();
  expect(stream.__getFocusedPentacleStreamForTests()).toBeNull();
  stream.__resetPentacleStreamForTests();
});
