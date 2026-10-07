import React from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { FlatList } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  initialPentacleStreamState,
  mutatePentacleEventBuckets,
  type PentacleEvent,
  type PentacleNotification,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';
import UpdatesScreen from '../../../app/(tabs)/updates';
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

test('the status surface header follows the assistant session name', async () => {
  mockState.sessions = [session(BART, { display_name: 'Lews' })];
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByTestId('status-assistant-name').props.children).toBe('Lews');
});

test('the status surface lamp takes the assistant host machine and follows a host change', async () => {
  const { getHostMachineName } = require('../../../src/config/local');
  // The header lamp is the identity ring (ArcaneRingFrame is memo-wrapped, so match its props).
  const ring = (view: ReturnType<typeof render>) =>
    view.UNSAFE_root.findAll((node) => node.props.identity === true && node.props.kind === 'djinni')[0];
  mockState.sessions = [session(BART, { host: 'hostc' })];
  const view = render(<UpdatesScreen />);
  await act(async () => {});
  expect(ring(view).props).toMatchObject({ identity: true, kind: 'djinni', machine: getHostMachineName('hostc') });
  mockState = { ...mockState, sessions: [session(BART, { host: 'hostb' })] };
  view.rerender(<UpdatesScreen />);
  expect(ring(view).props.machine).toBe(getHostMachineName('hostb'));
});

test('selects only assistant-stream status publications and renders the latest loaded count', async () => {
  mockState.events = [
    event(30, 'Latest synthetic status'), event(10, 'First synthetic status'),
    event(20, 'Middle synthetic status'), event(40, 'Prose excluded', { publish_kind: 'prose' }),
    event(41, 'Question excluded', { publish_kind: 'question' }), event(42, 'Result excluded', { publish_kind: 'result' }),
    event(43, 'Untagged excluded', { publish_kind: undefined }),
    event(44, 'Other stream excluded', { stream_id: 'hostc:codex:other' }),
  ];
  expect(selectStatusUpdates(mockState).map((row) => row.daemon_seq)).toEqual([30, 20, 10]);
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByTestId('status-assistant-name').props.children).toBe('Assistant');
  expect(screen.getByText('All updates · 3 ›')).toBeTruthy();
  expect(within(screen.getByTestId('latest-update')).getByText('Latest synthetic status')).toBeTruthy();
  expect(screen.queryByText('Middle synthetic status')).toBeNull();
  for (const excluded of ['Prose excluded', 'Question excluded', 'Result excluded', 'Untagged excluded', 'Other stream excluded']) {
    expect(screen.queryByText(excluded)).toBeNull();
  }
});

test('the link and latest card repeatedly open a newest-first log and back restores status', async () => {
  mockState.events = [event(1, 'Older status'), event(3, 'Newest status'), event(2, 'Middle status')];
  render(<UpdatesScreen />);
  await act(async () => {});
  for (const entry of ['link', 'card', 'link']) {
    fireEvent.press(entry === 'link' ? screen.getByText('All updates · 3 ›') : screen.getByTestId('latest-update'));
    expect(screen.getByText('UPDATE LOG')).toBeTruthy();
    expect(screen.getAllByTestId(/^status-update-/).map((row) => row.props.testID)).toEqual([
      'status-update-3', 'status-update-2', 'status-update-1',
    ]);
    expect(screen.getByText('Newest status')).toHaveStyle({ color: Tokens.palette.green });
    expect(screen.getByText('Older status')).toHaveStyle({ color: Tokens.palette.dim });
    fireEvent.press(screen.getByLabelText('Back to status'));
    expect(screen.queryByText('UPDATE LOG')).toBeNull();
    expect(screen.getByTestId('latest-update')).toBeTruthy();
  }
});

test.each([false, true])('header derives its status from the assistant session working=%s', async (working) => {
  mockState.sessions = [session(BART, { working }), session('hostc:codex:worker', { working: !working })];
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(within(screen.getByTestId('bart-status-tag')).getByTestId(`status-tag-${working ? 'working' : 'idle'}`)).toBeTruthy();
});

test('empty history and lanes retain a plain, navigable status surface', async () => {
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByText('All updates · 0 ›')).toBeTruthy();
  expect(screen.getByText('Open lanes · 0')).toBeTruthy();
  expect(screen.getByText('0 LANES')).toBeTruthy();
  expect(screen.queryAllByTestId(/^lane-/)).toHaveLength(0);
});

test('open lanes share working/needs-you and visibility rules with the genuine chat selectors', async () => {
  mockState.sessions = [
    session(BART, { working: true }), session('hostc:codex:working', { working: true }),
    session('hostc:codex:needs-you'), session('hostc:codex:idle'), session('hostc:codex:resolved'),
    session('hostc:codex:hidden', { working: true, visibility: 'hidden' }),
    session('hostc:codex:hidden-question', { visibility: 'hidden' }),
  ];
  mockState.notifications = [question('hostc:codex:needs-you'), question('hostc:codex:resolved', true), question('hostc:codex:hidden-question')];
  const expected = selectSmartChatList(mockState).filter((chat) => chat.streamId !== BART && (chat.status === 'working' || smartChatAttention(chat)));
  expect(selectOpenLanes(mockState).map((lane) => lane.chat.streamId)).toEqual(expected.map((chat) => chat.streamId));
  expect(expected.map((chat) => chat.streamId)).toEqual(expect.arrayContaining(['hostc:codex:working', 'hostc:codex:needs-you', 'hostc:codex:hidden-question']));
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByText('Open lanes · 3')).toBeTruthy();
  expect(screen.getByText('3 LANES')).toBeTruthy();
  for (const chat of expected) expect(screen.getByTestId(`lane-${chat.streamId}`)).toBeTruthy();
  for (const id of [BART, 'hostc:codex:idle', 'hostc:codex:resolved', 'hostc:codex:hidden']) expect(screen.queryByTestId(`lane-${id}`)).toBeNull();
  expect(screen.getByTestId('lane-eta-hostc:codex:needs-you')).toHaveTextContent('Blocked');
});

test('lane step precedence is active plan, card update, then working label', async () => {
  const card = { updated_at: new Date(NOW).toISOString(), update: 'Card fallback', plan: [{ text: 'Active plan step', status: 'active' as const }] };
  mockState.sessions = [
    session('hostc:codex:plan', { working: true, working_label: 'Working fallback', status_card: card }),
    session('hostc:codex:update', { working: true, working_label: 'Working fallback', status_card: { ...card, plan: [] } }),
    session('hostc:codex:label', { working: true, working_label: 'Working fallback' }),
  ];
  const lanes = selectOpenLanes(mockState);
  expect(lanes.find((lane) => lane.chat.streamId.endsWith(':plan'))?.step).toBe('Active plan step');
  expect(lanes.find((lane) => lane.chat.streamId.endsWith(':update'))?.step).toBe('Card fallback');
  expect(lanes.find((lane) => lane.chat.streamId.endsWith(':label'))?.step).toBe('Working fallback');
  render(<UpdatesScreen />);
  await act(async () => {});
  for (const [id, step] of [['plan', 'Active plan step'], ['update', 'Card fallback'], ['label', 'Working fallback']]) {
    expect(within(screen.getByTestId(`lane-hostc:codex:${id}`)).getByText(new RegExp(` · ${step}$`))).toBeTruthy();
  }
});

test.each([
  [40, '~40m'], [60, '~1h'], [80, '~1h 20m'], [-35, 'late 35m'],
  [-60, 'late 1h'], [-125, 'late 2h 5m'], [null, '—'],
] as const)('renders a single lane ETA for a %s-minute offset: %s', async (minutes, label) => {
  mockState.sessions = [session('hostc:codex:eta', {
    working: true, eta_set_at: new Date(NOW - 240 * 60_000).toISOString(),
    eta_at: minutes === null ? null : new Date(NOW + minutes * 60_000).toISOString(),
  })];
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByTestId('lane-eta-hostc:codex:eta')).toHaveTextContent(label);
  expect(screen.getAllByText('ETA')).toHaveLength(1);
});

test('needs-you overrides a future ETA and uses the amber tone', async () => {
  const streamId = 'hostc:codex:blocked';
  mockState.sessions = [session(streamId, { working: true, eta_set_at: new Date(NOW - 60_000).toISOString(), eta_at: new Date(NOW + 60_000).toISOString() })];
  mockState.notifications = [question(streamId)];
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByTestId(`lane-eta-${streamId}`)).toHaveTextContent('Blocked');
  expect(screen.getByText('Blocked')).toHaveStyle({ color: Tokens.palette.amber });
});

test('caret expands the existing status card without navigating, and row taps use duplicate-safe navigation', async () => {
  const streamId = 'hostc:codex:expand';
  mockState.sessions = [session(streamId, { working: true, status_card: { updated_at: new Date(NOW).toISOString(), goal: 'Synthetic expanded goal', update: 'Sample progress' } })];
  render(<UpdatesScreen />);
  await act(async () => {});
  const router = require('expo-router').router;
  for (let cycle = 0; cycle < 2; cycle += 1) {
    fireEvent.press(screen.getByTestId(`lane-toggle-${streamId}`));
    expect(screen.getByTestId(`card-status-mini-${streamId}`)).toBeTruthy();
    expect(screen.getByText('Synthetic expanded goal')).toBeTruthy();
    fireEvent.press(screen.getByTestId(`lane-toggle-${streamId}`));
    expect(screen.queryByTestId(`card-status-mini-${streamId}`)).toBeNull();
  }
  expect(router.push).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId(`lane-${streamId}`));
  fireEvent.press(screen.getByTestId(`lane-${streamId}`));
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Aexpand');
});

test('focus and reconnect fetch the assistant history without per-lane polling', async () => {
  mockState = { ...mockState, connected: false };
  const rendered = render(<UpdatesScreen />);
  expect(registerFocusedPentacleStream).toHaveBeenCalledWith(BART);
  expect(requestStreamEvents).not.toHaveBeenCalled();
  mockState = { ...mockState, connected: true };
  await act(async () => rendered.rerender(<UpdatesScreen />));
  expect(requestStreamEvents).toHaveBeenLastCalledWith(BART, 300, { purpose: 'mount-fetch' });
  const count = (requestStreamEvents as jest.Mock).mock.calls.length;
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(requestStreamEvents).toHaveBeenCalledTimes(count);
  mockState = { ...mockState, connected: false };
  await act(async () => rendered.rerender(<UpdatesScreen />));
  mockState = { ...mockState, connected: true };
  await act(async () => rendered.rerender(<UpdatesScreen />));
  expect(requestStreamEvents).toHaveBeenCalledTimes(count + 1);
  mockIsFocused = false;
  rendered.rerender(<UpdatesScreen />);
  expect(mockReleaseFocus).toHaveBeenCalled();
  rendered.unmount();
});

test('retained and live status events stay ordered and the log uses existing older-page history', async () => {
  mockState.sessions = [session(BART)];
  mockState = mutatePentacleEventBuckets(mockState, { type: 'append', events: [event(2, 'Retained status')] });
  mockHasOlderHistory = true;
  const rendered = render(<UpdatesScreen />);
  await act(async () => {});
  (requestStreamEvents as jest.Mock).mockClear();
  fireEvent.press(screen.getByText('All updates · 1 ›'));
  await act(async () => rendered.UNSAFE_getByType(FlatList).props.onEndReached());
  expect(requestStreamEvents).toHaveBeenCalledWith(BART, 300, { purpose: 'older-page' });
  mockState = mutatePentacleEventBuckets(mockState, { type: 'append', events: [event(1, 'Older loaded status'), event(3, 'Live status')] });
  rendered.rerender(<UpdatesScreen />);
  expect(screen.getAllByTestId(/^status-update-/).map((row) => row.props.testID)).toEqual(['status-update-3', 'status-update-2', 'status-update-1']);
  fireEvent.press(screen.getByLabelText('Back to status'));
  expect(screen.getByText('All updates · 3 ›')).toBeTruthy();
  expect(within(screen.getByTestId('latest-update')).getByText('Live status')).toBeTruthy();
});

test('elapsed time refreshes ETA locally without another transport request', async () => {
  const streamId = 'hostc:codex:clock';
  mockState.sessions = [session(streamId, { working: true, eta_set_at: new Date(NOW - 60_000).toISOString(), eta_at: new Date(NOW + 120_000).toISOString() })];
  render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByTestId(`lane-eta-${streamId}`)).toHaveTextContent('~2m');
  await act(async () => {});
  const count = (requestStreamEvents as jest.Mock).mock.calls.length;
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(screen.getByTestId(`lane-eta-${streamId}`)).toHaveTextContent('~1m');
  expect(requestStreamEvents).toHaveBeenCalledTimes(count);
});

test('the tab removes notification-card dependencies while Unified retains its question drawer', () => {
  const root = path.resolve(__dirname, '../../..');
  const updates = readFileSync(path.join(root, 'app/(tabs)/updates.tsx'), 'utf8');
  expect(updates).not.toMatch(/\b(?:NotificationCard|useNotifications)\b/);
  const unified = readFileSync(path.join(root, 'app/(tabs)/unified.tsx'), 'utf8');
  expect(unified).toContain('unified-question-badge');
  expect(unified).toContain('QuestionCardSurface');
});

test('a request that settles during blur must not strand loading on a fresh refocus', async () => {
  let settle!: (events: PentacleEvent[]) => void;
  (requestStreamEvents as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
  mockHasOlderHistory = true;
  const rendered = render(<UpdatesScreen />);
  expect(screen.getByText('Loading updates…')).toBeTruthy();
  mockIsFocused = false;
  rendered.rerender(<UpdatesScreen />);
  await act(async () => settle([]));
  mockFresh = true;
  mockIsFocused = true;
  rendered.rerender(<UpdatesScreen />);
  expect(screen.queryByText('Loading updates…')).toBeNull();
  fireEvent.press(screen.getByText('All updates · 0 ›'));
  await act(async () => rendered.UNSAFE_getByType(FlatList).props.onEndReached());
  expect(requestStreamEvents).toHaveBeenCalledWith(BART, 300, { purpose: 'older-page' });
});


test('one end-of-list demand crosses prose-only pages until an earlier status arrives', async () => {
  mockState = mutatePentacleEventBuckets(mockState, { type: 'append', events: [event(1000, 'Retained status')] });
  mockHasOlderHistory = true;
  const rendered = render(<UpdatesScreen />);
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
  rendered.rerender(<UpdatesScreen />);
  expect(screen.getByText('Earlier status')).toBeTruthy();
});

test('an empty log uses older history without requiring an impossible scroll', async () => {
  mockState.events = [event(1000, 'Prose only', { publish_kind: 'prose' })];
  mockHasOlderHistory = true;
  const rendered = render(<UpdatesScreen />);
  await act(async () => {});
  (requestStreamEvents as jest.Mock).mockReset().mockImplementation(async () => {
    mockState = { ...mockState, events: [...mockState.events, event(600, 'Recovered status')] };
    return [event(600, 'Recovered status')];
  });
  await act(async () => fireEvent.press(screen.getByText('All updates · 0 ›')));
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  rendered.rerender(<UpdatesScreen />);
  expect(screen.getByText('Recovered status')).toBeTruthy();
});

test('repeated full prose pages stop when history makes no progress', async () => {
  const prosePage = Array.from({ length: 300 }, (_, i) => event(700 + i, `Sample ${i}`, { publish_kind: 'prose' }));
  mockState.events = [event(1000, 'Retained status'), ...prosePage];
  mockHasOlderHistory = true;
  const rendered = render(<UpdatesScreen />);
  await act(async () => {});
  (requestStreamEvents as jest.Mock).mockReset().mockResolvedValue(prosePage);
  fireEvent.press(screen.getByText('All updates · 1 ›'));
  await act(async () => rendered.UNSAFE_getByType(FlatList).props.onEndReached());
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
});

test.each(['back', 'blur'] as const)('a pending sparse scan stops after %s', async (leave) => {
  mockState.events = [event(1000, 'Retained status')];
  mockHasOlderHistory = true;
  const rendered = render(<UpdatesScreen />);
  await act(async () => {});
  let settle!: (events: PentacleEvent[]) => void;
  (requestStreamEvents as jest.Mock).mockReset().mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  fireEvent.press(screen.getByText('All updates · 1 ›'));
  act(() => { rendered.UNSAFE_getByType(FlatList).props.onEndReached(); });
  if (leave === 'back') fireEvent.press(screen.getByLabelText('Back to status'));
  else { mockIsFocused = false; rendered.rerender(<UpdatesScreen />); }
  await act(async () => settle(Array.from({ length: 300 }, (_, i) => event(700 + i, 'Prose', { publish_kind: 'prose' }))));
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
});

test('history failures are bounded and recover when focus returns', async () => {
  (requestStreamEvents as jest.Mock).mockRejectedValueOnce(new Error('Synthetic offline error'));
  const rendered = render(<UpdatesScreen />);
  await act(async () => {});
  expect(screen.getByText('Updates unavailable')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  mockIsFocused = false;
  rendered.rerender(<UpdatesScreen />);
  mockIsFocused = true;
  rendered.rerender(<UpdatesScreen />);
  await act(async () => {});
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Updates unavailable')).toBeNull();
});

test('end reached during mount loading is replayed once history settles', async () => {
  mockState = mutatePentacleEventBuckets(mockState, { type: 'append', events: [event(1000, 'Retained status')] });
  mockHasOlderHistory = true;
  let settle!: (events: PentacleEvent[]) => void;
  (requestStreamEvents as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
  const rendered = render(<UpdatesScreen />);
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
  expect(requestStreamEvents).toHaveBeenCalledTimes(1);
  await act(async () => settle([event(1000, 'Retained status')]));
  await act(async () => list._maybeCallOnEdgeReached());
  expect(requestStreamEvents).toHaveBeenCalledTimes(2);
  expect(requestStreamEvents).toHaveBeenLastCalledWith(BART, 300, { purpose: 'older-page' });
});
