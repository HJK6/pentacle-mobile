import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen, {
  isDefaultVisibleSession,
  sameChatRowProps,
  sameSmartChatItems,
  selectSmartChatList,
  selectVisibleChatList,
  smartChatAttention,
} from '../../../app/(tabs)/chats';
import { INITIAL_PENTACLE_LIMITS, buildPentacleQuestionAnswerText, logTelemetry } from 'pentacle-chat-core';
import type { PentacleNotification } from 'pentacle-chat-core';
import usePentacleToken from '../../../src/hooks/usePentacleToken';
import { usePentacleStreamActions, usePentacleStreamSelectorWhen } from '../../../src/services/pentacleStream';

let mockState: any;
const mockAlert = jest.fn();
let mockIsFocused = true;
const mockActions = {
  spawnSession: jest.fn(),
  reconnect: jest.fn(),
  closeSession: jest.fn(),
  retryPendingClose: jest.fn(),
  cancelPendingClose: jest.fn(),
  forcePendingClose: jest.fn(),
  renameSession: jest.fn(),
  resolveNotification: jest.fn(),
  answerPrompt: jest.fn(),
  dismissQuestion: jest.fn(),
  sendTurn: jest.fn(),
  sendMessage: jest.fn(),
  beginOptimisticQuestionAnswer: jest.fn(() => 'optimistic-question-1'),
  queueOptimisticQuestionAnswer: jest.fn(),
  discardOptimisticQuestionAnswer: jest.fn(),
  getSpawnCatalog: jest.fn(),
  spawnSessionV2: jest.fn(),
  prefetchStreamEvents: jest.fn(),
  prefetchSettledStreams: jest.fn(),
  markStreamOpenIntent: jest.fn(),
};

function session(streamId: string, title: string, visibility?: string) {
  return {
    stream_id: streamId,
    host: 'hostc',
    provider: 'codex',
    session_name: streamId.split(':').at(-1) || streamId,
    title,
    last_event_at: new Date().toISOString(),
    last_text: `${title} preview`,
    last_kind: 'ASSIST',
    online: true,
    ...(visibility === undefined ? {} : { visibility }),
  };
}

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'Alert') return { alert: mockAlert };
      return target[prop as keyof typeof target];
    },
  });
});
jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockIsFocused }));
jest.mock('../../../src/utils/harnessRuntime', () => ({
  useHarnessReady: () => false,
  hasAction: (action: string) => action === 'chat_list_fixture',
}));
jest.mock('pentacle-chat-core', () => ({
  ...jest.requireActual('pentacle-chat-core'),
  logTelemetry: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../../src/services/pentacleStream', () => ({
  selectOptimisticQuestionAnswerIdentities: jest.fn((state) => Object.values(state.optimisticSends ?? {}).flatMap((send: any) => {
    try {
      const payload = JSON.parse(send.text);
      return payload.type === 'notification.answer' && payload.notification_id
        ? [{ notificationId: payload.notification_id, ...(payload.question_id ? { questionId: payload.question_id } : {}) }]
        : [];
    } catch {
      return [];
    }
  })),
  usePentacleStreamActions: jest.fn(),
  usePentacleStreamSelectorWhen: jest.fn(),
}));
// Daemon-derived report adapter fixture (public_contract):
// the container consumes only these pentacleAssets exports for report actions.
const mockReportsByStream: Record<string, Array<{ read?: boolean; read_at?: string | null }>> = {};
jest.mock('../../../src/services/pentacleAssets', () => ({
  useSessionReports: (streamId: string) => mockReportsByStream[streamId] ?? [],
  reportUnreadCount: (streamId: string) =>
    (mockReportsByStream[streamId] ?? []).filter((report) => report.read !== true && !report.read_at).length,
  listReports: jest.fn().mockResolvedValue([]),
  isReportSessionClosed: () => false,
}));
jest.mock('../../../src/components/ReportViewerModal', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return ({ streamId }: { streamId: string }) => ReactActual.createElement(View, { testID: `reports-overlay-${streamId}` });
});
// Native-push unread must never reach the report badge; pin it to a noisy value.
jest.mock('../../../src/hooks/useUnreadNotifications', () => ({
  __esModule: true,
  default: () => 99,
  useHasUnreadNotification: () => true,
  markRead: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFocused = true;
  delete process.env.EXPO_PUBLIC_HARNESS;
  mockState = {
    connected: true,
    connecting: false,
    hasHydrated: true,
    lastError: undefined,
    hosts: {},
    sessions: [],
    drafts: {},
    events: [],
    machineStats: {},
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    notifications: [],
    workingStates: {},
  };
  (usePentacleToken as jest.Mock).mockReturnValue({ isReady: true, token: 'test' });
  (usePentacleStreamActions as jest.Mock).mockReturnValue(mockActions);
  (usePentacleStreamSelectorWhen as jest.Mock).mockImplementation((_enabled, selector) => selector(mockState));
  mockActions.spawnSession.mockResolvedValue({ stream_id: 'hostc:codex:new' });
  mockActions.getSpawnCatalog.mockResolvedValue({
    schema_version: 'CatalogV1',
    catalog_version: 'spawn-catalog-v1',
    profiles: { desktop_manual: { claude: ['claude-opus-4-6', 'high'], codex: ['gpt-5.6-sol', 'high'] } },
    models: {
      claude: { 'claude-opus-4-6': { efforts: ['high'] } },
      codex: { 'gpt-5.6-sol': { efforts: ['high'] } },
    },
  });
  mockActions.spawnSessionV2.mockResolvedValue({ session: { stream_id: 'hostc:codex:new' } });
  mockActions.resolveNotification.mockResolvedValue(true);
  mockActions.answerPrompt.mockResolvedValue(true);
  mockActions.dismissQuestion.mockResolvedValue({ textSubmitted: true });
  mockActions.sendTurn.mockReturnValue('optimistic-1');
  mockActions.sendMessage.mockResolvedValue(true);
  mockActions.retryPendingClose.mockResolvedValue(true);
  mockActions.cancelPendingClose.mockResolvedValue(true);
  mockActions.forcePendingClose.mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
  jest.useRealTimers();
});

test('exhausted delete stays visible and offers Retry, Cancel, and Force actions', async () => {
  mockState.sessions = [{
    ...session('hostc:codex:delete-me', 'Delete me'),
    pending_close: {
      streamId: 'hostc:codex:delete-me',
      host: 'hostc',
      sessionName: 'delete-me',
      requestId: 'close-1',
      requestedAt: Date.now() - 10 * 60_000,
      attempt: 6,
      nextAttemptAt: 0,
      state: 'exhausted',
      errorCode: 'session_working',
      errorMessage: 'session is busy',
    },
  }];
  render(<ChatsScreen />);

  expect(screen.getByText('Delete stalled — tap delete for options')).toBeTruthy();
  fireEvent.press(screen.getByTestId('chat-row-delete-hostc-codex-delete-me'));
  expect(mockAlert).toHaveBeenCalledWith(
    'Delete stalled',
    'session is busy',
    expect.arrayContaining([
      expect.objectContaining({ text: 'Retry' }),
      expect.objectContaining({ text: 'Cancel delete' }),
      expect.objectContaining({ text: 'Force delete' }),
    ]),
  );

  const buttons = mockAlert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
  await act(async () => buttons.find((button) => button.text === 'Retry')?.onPress?.());
  expect(mockActions.retryPendingClose).toHaveBeenCalledWith('hostc:codex:delete-me');
});

test('cold renders with empty data', () => {
  render(<ChatsScreen />);

  expect(screen.getByText('No sessions yet')).toBeTruthy();
});

test('renders loading and unenrolled states before chat data', () => {
  (usePentacleToken as jest.Mock).mockReturnValueOnce({ isReady: false, token: null });
  const loading = render(<ChatsScreen />);
  expect(loading.UNSAFE_getByType(require('react-native').ActivityIndicator)).toBeTruthy();
  loading.unmount();

  (usePentacleToken as jest.Mock).mockReturnValueOnce({ isReady: true, token: null });
  render(<ChatsScreen />);
  expect(screen.getByText('Pentacle access is unavailable on this device.')).toBeTruthy();
});

test('cold renders with seeded data and opens a chat row', () => {
  mockState.sessions = [session('hostc:codex:one', 'Migration plan')];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByText('Migration plan'));

  expect(require('expo-router').router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Aone');
});

test('row press-in prefetches before opening the chat', () => {
  mockState.sessions = [session('hostc:codex:one', 'Migration plan')];

  render(<ChatsScreen />);
  fireEvent(screen.getByTestId('chat-row-hostc-codex-one'), 'pressIn');
  fireEvent.press(screen.getByTestId('chat-row-hostc-codex-one'));

  expect(mockActions.prefetchStreamEvents).toHaveBeenCalledWith('hostc:codex:one', 'press-in');
  expect(require('expo-router').router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Aone');
});

test('viewability prefetch waits for settled visible rows and suppresses active scroll flings', () => {
  jest.useFakeTimers();
  mockState.sessions = [
    session('hostc:codex:one', 'Migration plan'),
    session('hostc:codex:two', 'Release notes'),
  ];

  render(<ChatsScreen />);
  const list = screen.getByTestId('chats-list');
  act(() => {
    list.props.onScrollBeginDrag();
    list.props.onViewableItemsChanged({
      viewableItems: [
        { item: { streamId: 'hostc:codex:one' }, isViewable: true },
      ],
    });
    jest.advanceTimersByTime(500);
  });
  expect(mockActions.prefetchSettledStreams).not.toHaveBeenCalled();

  act(() => {
    list.props.onMomentumScrollEnd();
    jest.advanceTimersByTime(399);
  });
  expect(mockActions.prefetchSettledStreams).not.toHaveBeenCalled();

  act(() => {
    jest.advanceTimersByTime(1);
  });
  expect(mockActions.prefetchSettledStreams).toHaveBeenCalledWith(['hostc:codex:one'], 'list-settle');
});

test('working chat row renders icon-only status with a live elapsed timer', () => {
  mockState.sessions = [{ ...session('hostc:codex:one', 'Migration plan'), working: true }];
  mockState.workingStates = {
    'hostc:codex:one': {
      stream_id: 'hostc:codex:one',
      timestamp: '2026-06-18T12:00:00Z',
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
      tokens_phase: 'idle',
      shell_count_started: 0,
      tasks: [],
      task_summary: { total: 0, done: 0, in_progress: 0, open: 0 },
      elapsed_ms: 61_000,
    },
  };

  render(<ChatsScreen />);

  expect(screen.getByTestId('status-tag-working')).toBeTruthy();
  expect(screen.queryByText(/working/i)).toBeNull();
  expect(screen.getByTestId('status-tag-elapsed').props.children).toBe('01:01');
});

test('chat list hides non-default visibility sessions but keeps default and missing visibility', () => {
  mockState.sessions = [
    session('hostc:codex:visible-default', 'Default visible', 'default'),
    session('hostc:codex:visible-absent', 'Absent visibility'),
    session('hostc:codex:hidden', 'Hidden worker', 'hidden'),
    session('hostc:codex:nested', 'Nested review', 'nested'),
  ];

  render(<ChatsScreen />);

  expect(screen.getByText('Default visible')).toBeTruthy();
  expect(screen.getByText('Absent visibility')).toBeTruthy();
  expect(screen.queryByText('Hidden worker')).toBeNull();
  expect(screen.queryByText('Nested review')).toBeNull();
});

test('default visibility guard mirrors desktop non-default visibility predicate', () => {
  expect(isDefaultVisibleSession({})).toBe(true);
  expect(isDefaultVisibleSession({ visibility: 'default' })).toBe(true);
  expect(isDefaultVisibleSession({ visibility: 'hidden' })).toBe(false);
  expect(isDefaultVisibleSession({ visibility: 'nested' })).toBe(false);
  expect(isDefaultVisibleSession({ visibility: { source: 'daemon' } })).toBe(false);
});

test('visible chat-list selector preserves references when only hidden sessions change', () => {
  const visible = session('hostc:codex:stable-visible', 'Stable visible', 'default');
  const hidden = session('hostc:codex:hidden-worker', 'Hidden worker', 'hidden');
  const first = selectVisibleChatList({ ...mockState, sessions: [visible, hidden] });

  const second = selectVisibleChatList({
    ...mockState,
    sessions: [
      { ...visible },
      { ...hidden, visibility: 'nested', last_text: 'hidden update should not affect list' },
    ],
  });

  expect(second).toBe(first);
});

test('visible chat-list selector preserves references for unchanged inputs', () => {
  const visible = session('hostc:codex:stable-visible', 'Stable visible', 'default');
  const state = { ...mockState, sessions: [visible] };
  const first = selectVisibleChatList(state);
  const second = selectVisibleChatList(state);

  expect(second).toBe(first);
});

test('visible chat-list selector preserves references across unrelated state changes', () => {
  const visible = session('hostc:codex:stable-visible', 'Stable visible', 'default');
  const first = selectVisibleChatList({ ...mockState, sessions: [visible] });
  const second = selectVisibleChatList({
    ...mockState,
    sessions: [visible],
    connected: !mockState.connected,
    updates: [{ id: 'unrelated-update', title: 'Unrelated', created_at: new Date().toISOString() }],
  });

  expect(second).toBe(first);
});

test('unrelated question projection state preserves memoized row props', () => {
  const chat = selectSmartChatList({
    ...mockState,
    sessions: [session('hostc:codex:one', 'One')],
  })[0];
  const callback = jest.fn();
  const props = {
    chat,
    index: 0,
    expanded: false,
    questionError: null,
    questionSubmitting: false,
    onOpen: callback,
    onOpenStatus: callback,
    onOpenReports: callback,
    onRename: callback,
    onDelete: callback,
    onPrefetchIntent: callback,
    onToggle: callback,
    onSubmitQuestions: callback,
  } as any;

  expect(sameChatRowProps(props, { ...props })).toBe(true);
});

test('memoized rows invalidate only for their targeted projection or callback changes', () => {
  const chat = selectSmartChatList({
    ...mockState,
    sessions: [session('hostc:codex:one', 'One')],
  })[0];
  const callback = jest.fn();
  const props = {
    chat,
    index: 0,
    expanded: false,
    questionError: null,
    questionSubmitting: false,
    onOpen: callback,
    onRename: callback,
    onDelete: callback,
  } as any;

  expect(sameChatRowProps(props, { ...props, questionSubmitting: true })).toBe(false);
  expect(sameChatRowProps(props, { ...props, questionError: 'retry' })).toBe(false);
  expect(sameChatRowProps(props, { ...props, onOpen: jest.fn() })).toBe(false);
});

test('a row that only shifts list position (index) does not re-render — every inbound event re-sorts the list, so comparing the unrendered index re-renders every shifted row (public layout timing fixture)', () => {
  const chat = selectSmartChatList({
    ...mockState,
    sessions: [session('hostc:codex:one', 'One')],
  })[0];
  const callback = jest.fn();
  const props = {
    chat,
    index: 0,
    expanded: false,
    questionError: null,
    questionSubmitting: false,
    onOpen: callback,
    onRename: callback,
    onDelete: callback,
  } as any;

  // ChatRow never renders `index`; a re-sort (an inbound event bumps a stream's
  // lastEventMs to the top) shifts the index of every row below it. Comparing
  // index in the memo re-renders all of them for zero visible change — the O(n)
  // reconcile that keeps chat_list set_state_ms over budget under burst load.
  expect(sameChatRowProps(props, { ...props, index: 7 })).toBe(true);
});

test('primary action opens summon modal and spawns a selected provider', async () => {
  mockState.hosts = {
    hostc: { host: 'hostc', online: true, checked_at: '', session_count: 0 },
  };

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('new-chat-button'));

  expect(screen.getByText('Summon')).toBeTruthy();
  fireEvent.press(screen.getByTestId('summon-machine-hostc'));
  await screen.findByTestId('summon-submit');
  await waitFor(() => expect(screen.getByTestId('summon-submit').props.accessibilityState?.disabled).toBe(false));
  await act(async () => {
    fireEvent.press(screen.getByTestId('summon-provider-codex'));
    fireEvent.press(screen.getByTestId('summon-submit'));
  });

  await waitFor(() => expect(mockActions.spawnSessionV2).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    spawnProfile: 'desktop_manual',
    catalogVersion: 'spawn-catalog-v1',
  })));
  // Top-level spawn: no objective flows from the sheet.
  expect(mockActions.spawnSessionV2.mock.calls[0][0].objective).toBeUndefined();
});

test('renders an error state when hydration has no chats', () => {
  mockState.lastError = 'Pentacle offline';

  render(<ChatsScreen />);

  expect(screen.getByText('Pentacle offline')).toBeTruthy();
});

test('renders loading card before stream hydration', () => {
  mockState.hasHydrated = false;
  mockState.connecting = true;

  render(<ChatsScreen />);

  expect(screen.getByText('SUMMONING CHATS…')).toBeTruthy();
});

test('refresh action reconnects the stream', async () => {
  jest.useFakeTimers();
  render(<ChatsScreen />);
  const list = screen.getByTestId('chats-list');

  await act(async () => {
    await list.props.refreshControl.props.onRefresh();
  });
  act(() => {
    jest.advanceTimersByTime(700);
  });

  expect(mockActions.reconnect).toHaveBeenCalled();
});

function agentQuestionNotification(streamId: string, overrides: Record<string, unknown> = {}) {
  return {
    notification_id: `n-${streamId}`,
    created_at: '2026-07-05T12:00:00.000Z',
    updated_at: '2026-07-05T12:00:00.000Z',
    producer: 'agent_question.v1',
    answer_to_stream_id: streamId,
    severity: 'info',
    title: 'Pick a lane',
    body: 'Which lane should run?',
    dedup_key: `question:${streamId}`,
    state: 'open',
    actions: [{ kind: 'yes_no', action_id: 'a0' }],
    question: {
      question_id: `q-${streamId}`,
      producer_stream_id: streamId,
      response_mode: 'single_choice',
      options: [
        { label: 'Lane A', value: 'lane_a' },
        { label: 'Lane B', value: 'lane_b' },
      ],
      state: 'open',
      answer: null,
    },
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-07-05T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

type SelectorReadCounts = { events: number; sessions: number; notifications: number };

function countedArray<T>(values: T[], counts: SelectorReadCounts, key: keyof SelectorReadCounts): T[] {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) counts[key] += 1;
      return Reflect.get(target, property, receiver);
    },
  });
}

function scaledSmartChatState(sessionCount: number, eventCount: number, counts: SelectorReadCounts) {
  const baseMs = Date.parse('2026-07-05T12:00:00.000Z');
  const sessions = Array.from({ length: sessionCount }, (_, index) => ({
    ...session(`hostc:codex:scale-${index}`, `Scale ${index}`, index === sessionCount - 1 ? 'hidden' : 'default'),
    last_event_at: new Date(baseMs + index * 1000).toISOString(),
    working: index >= 16 && index < 24,
  }));
  const events = Array.from({ length: eventCount }, (_, index) => {
    const streamIndex = index % sessionCount;
    return {
      stream_id: `hostc:codex:scale-${streamIndex}`,
      host: 'hostc',
      provider: 'codex',
      session_name: `scale-${streamIndex}`,
      daemon_seq: index + 1,
      timestamp: new Date(baseMs + index * 1000).toISOString(),
      kind: 'ASSIST',
      text: `message-${index}`,
      raw: {},
    };
  });
  const notifications = [
    ...Array.from({ length: 15 }, (_, index) => agentQuestionNotification(`hostc:codex:scale-${index}`)),
    agentQuestionNotification('hostc:codex:missing'),
  ];
  return {
    ...mockState,
    sessions: countedArray(sessions, counts, 'sessions'),
    events: countedArray(events, counts, 'events'),
    notifications: countedArray(notifications, counts, 'notifications'),
    drafts: {
      'hostc:codex:scale-2': {
        ...events[2], kind: 'DRAFT', text: 'draft in progress', raw: { working: true },
      },
    },
    workingStates: Object.fromEntries(Array.from({ length: 8 }, (_, offset) => [
      `hostc:codex:scale-${16 + offset}`,
      { stream_id: `hostc:codex:scale-${16 + offset}`, elapsed_ms: 1000 + offset },
    ])),
    workingByStream: Object.fromEntries(Array.from({ length: 8 }, (_, offset) => [
      `hostc:codex:scale-${16 + offset}`,
      { phase: 'working' },
    ])),
    optimisticSends: {
      'optimistic-scale-3': {
        optimistic_id: 'optimistic-scale-3',
        stream_id: 'hostc:codex:scale-3',
        status: 'queued',
        created_at: baseMs,
        text: 'queued message',
      },
    },
  };
}

function countSmartChatSortComparisons(run: () => unknown) {
  const nativeSort = Array.prototype.sort;
  const comparisons = { chatOrder: 0, latestCandidate: 0 };
  const spy = jest.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compareFn?: (a: unknown, b: unknown) => number) {
    const smartRows = this.length > 0 && typeof this[0] === 'object' && this[0] !== null && 'latestMessages' in this[0];
    const latestCandidates = this.length > 0 && this.length <= 3 && typeof this[0] === 'object' && this[0] !== null && 'daemon_seq' in this[0];
    if ((!smartRows && !latestCandidates) || !compareFn) return nativeSort.call(this, compareFn);
    return nativeSort.call(this, (left, right) => {
      if (smartRows) comparisons.chatOrder += 1;
      if (latestCandidates) comparisons.latestCandidate += 1;
      return compareFn(left, right);
    });
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return comparisons;
}

test('scaled smart chat selector matches the independent ordering and row-state oracle', () => {
  const counts = { events: 0, sessions: 0, notifications: 0 };
  const state = scaledSmartChatState(64, 1200, counts);
  const rows = selectSmartChatList(state);
  const expectedStreamIds = [
    ...Array.from({ length: 15 }, (_, index) => `hostc:codex:scale-${14 - index}`),
    // Narrowed subscription (include_subagents:false): the open question for the never-
    // delivered 'missing' session is re-projected as a synthesized answerable row. It
    // sorts last among action rows (lastEventMs=0, no session frame).
    'hostc:codex:missing',
    ...Array.from({ length: 8 }, (_, index) => `hostc:codex:scale-${23 - index}`),
    ...Array.from({ length: 39 }, (_, index) => `hostc:codex:scale-${62 - index}`),
    'hostc:codex:scale-15',
  ];

  expect(rows.map((row) => row.streamId)).toEqual(expectedStreamIds);
  expect(rows.find((row) => row.streamId === 'hostc:codex:scale-0')?.openQuestions).toHaveLength(1);
  expect(rows.find((row) => row.streamId === 'hostc:codex:scale-16')?.status).toBe('working');
  expect(rows.find((row) => row.streamId === 'hostc:codex:scale-2')?.status).toBe('working');
  expect(rows.find((row) => row.streamId === 'hostc:codex:scale-3')?.status).toBe('sending');
  expect(rows.find((row) => row.streamId === 'hostc:codex:scale-5')?.latestMessages).toEqual(['message-1157', 'message-1093']);
  expect(rows.some((row) => row.streamId === 'hostc:codex:scale-63')).toBe(false);
  // The synthesized 'missing' row is answerable: it carries the open durable question.
  expect(rows.find((row) => row.streamId === 'hostc:codex:missing')?.openQuestions).toHaveLength(1);
  expect(rows[0]).toMatchObject({ host: 'hostc', sessionName: 'scale-14', streamId: 'hostc:codex:scale-14' });
});

test('scaled smart chat selector stays within fixed deterministic bounds', () => {
  const counts = { events: 0, sessions: 0, notifications: 0 };
  const state = scaledSmartChatState(64, 1200, counts);
  const comparisons = countSmartChatSortComparisons(() => selectSmartChatList(state));

  expect(counts.events).toBeLessThanOrEqual(2656);
  expect(counts.sessions).toBeLessThanOrEqual(136);
  expect(counts.notifications).toBeLessThanOrEqual(40);
  expect(comparisons.chatOrder).toBeLessThanOrEqual(776);
  expect(comparisons.latestCandidate).toBe(0);
});

test('unrelated store emissions do not rescan the unchanged event inventory', () => {
  const counts = { events: 0, sessions: 0, notifications: 0 };
  const state = scaledSmartChatState(64, 1200, counts);
  selectSmartChatList(state);
  const firstPassReads = counts.events;
  for (let index = 0; index < 32; index += 1) {
    selectSmartChatList({ ...state, machineStats: { unrelated: { index } } });
  }
  expect(counts.events - firstPassReads).toBe(0);
});

test('smart delegates one visible derivation and reuses the shared core event index', () => {
  const counts = { events: 0, sessions: 0, notifications: 0 };
  const state = scaledSmartChatState(64, 1200, counts);
  const visible = selectVisibleChatList(state);
  const afterVisibleReads = counts.events;
  const delegate = jest.fn(selectVisibleChatList);

  const smart = selectSmartChatList(state, 'all', delegate);

  expect(delegate).toHaveBeenCalledTimes(1);
  expect(counts.events - afterVisibleReads).toBeLessThanOrEqual(1200);
  expect(smart.map((row) => row.streamId).sort()).toEqual(visible.map((row) => row.streamId).sort());
});

test('selector event work grows no faster than 2.25x per doubled corpus', () => {
  const reads = [[16, 300], [32, 600], [64, 1200]].map(([sessions, events]) => {
    const counts = { events: 0, sessions: 0, notifications: 0 };
    selectSmartChatList(scaledSmartChatState(sessions, events, counts));
    return counts.events;
  });
  expect(reads[1] / reads[0]).toBeLessThanOrEqual(2.25);
  expect(reads[2] / reads[1]).toBeLessThanOrEqual(2.25);
});

test('smart chat selector sorts action rows, then working rows, then recency', () => {
  const action = { ...session('hostc:codex:action', 'Needs answer'), last_event_at: '2026-07-05T10:00:00.000Z' };
  const working = { ...session('hostc:codex:working', 'Still working'), working: true, last_event_at: '2026-07-05T09:00:00.000Z' };
  const recent = { ...session('hostc:codex:recent', 'Recent idle'), last_event_at: '2026-07-05T12:00:00.000Z' };
  mockState.sessions = [recent, working, action];
  mockState.notifications = [agentQuestionNotification('hostc:codex:action')];

  expect(selectSmartChatList(mockState).map((item) => item.streamId)).toEqual([
    'hostc:codex:action',
    'hostc:codex:working',
    'hostc:codex:recent',
  ]);
});

test('smart chat attention is true only for unresolved open action rows', () => {
  mockState.sessions = [session('hostc:codex:open', 'Open'), session('hostc:codex:closed', 'Closed')];
  mockState.notifications = [
    agentQuestionNotification('hostc:codex:open'),
    agentQuestionNotification('hostc:codex:closed', { state: 'resolved', resolved_at: '2026-07-05T12:30:00.000Z' }),
  ];
  const rows = selectSmartChatList(mockState);

  expect(smartChatAttention(rows.find((row) => row.streamId === 'hostc:codex:open')!)).toBe(true);
  expect(smartChatAttention(rows.find((row) => row.streamId === 'hostc:codex:closed')!)).toBe(false);
});

test('hidden sessions with open durable questions are promoted into Agents while open', () => {
  mockState.sessions = [
    session('hostc:codex:visible', 'Visible worker', 'default'),
    session('hostc:codex:hidden-idle', 'Hidden idle', 'hidden'),
    session('hostc:codex:hidden-question', 'Hidden question', 'hidden'),
  ];
  mockState.notifications = [agentQuestionNotification('hostc:codex:hidden-question', { notification_id: 'n-hidden-question' })];

  render(<ChatsScreen />);

  expect(screen.getByText('Visible worker')).toBeTruthy();
  expect(screen.queryByText('Hidden idle')).toBeNull();
  expect(screen.getByText('Hidden question')).toBeTruthy();
  expect(screen.getByTestId('chat-row-toggle-hostc-codex-hidden-question')).toBeTruthy();
});

test('smart chat selector falls back to waiting text when no latest message exists', () => {
  mockState.sessions = [{ ...session('hostc:codex:empty', 'Empty'), last_text: '' }];

  expect(selectSmartChatList(mockState)[0].latestMessages[0]).toContain('Waiting for first message');
});

test('smart chat equality notices title and same-count question replacements', () => {
  const baseSession = session('hostc:codex:action', 'Old title');
  const first = selectSmartChatList({
    ...mockState,
    sessions: [baseSession],
    notifications: [agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question-1', body: 'First prompt?' })],
  });
  const renamed = selectSmartChatList({
    ...mockState,
    sessions: [{ ...baseSession, title: 'New title' }],
    notifications: [agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question-1', body: 'First prompt?' })],
  });
  const replacedQuestion = selectSmartChatList({
    ...mockState,
    sessions: [baseSession],
    notifications: [agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question-2', body: 'Second prompt?' })],
  });

  expect(sameSmartChatItems(first, renamed)).toBe(false);
  expect(sameSmartChatItems(first, replacedQuestion)).toBe(false);
});

test('inline durable question submit calls prompt.answer and collapses on success', async () => {
  mockState.sessions = [{
    ...session('hostc:codex:action', 'Needs answer'),
    question: {
      header: 'Pick a lane',
      prompt: 'Which lane should run?',
      question_id: 'q-hostc:codex:action',
      question_key: 'shared-question-key',
      options: [{ index: 1, label: 'Lane A' }, { index: 2, label: 'Lane B' }],
    },
  }];
  mockState.notifications = [agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question' })];

  const rendered = render(<ChatsScreen />);
  expect(screen.getByTestId('chat-row-toggle-hostc-codex-action')).toBeTruthy();
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-action'));
  expect(screen.getByTestId('smart-question-counter')).toHaveTextContent('01/01');
  expect(screen.queryByText(/QUESTIONS\s*[#·]/i)).toBeNull();
  fireEvent.press(screen.getByTestId('smart-question-option-2'));
  fireEvent.changeText(screen.getByTestId('smart-question-note'), 'prefer ready lane');
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-hostc:codex:action',
    selections: ['lane_b'],
    text: 'prefer ready lane',
  });
  expect(screen.queryByTestId('question-panel-hostc:codex:action')).toBeNull();
  mockState.notifications = [{
    ...mockState.notifications[0],
    state: 'answered',
    question: { ...mockState.notifications[0].question, state: 'answered', answer: { selections: ['lane_b'] } },
  }];
  rendered.rerender(<ChatsScreen />);
  expect(screen.getByTestId('chat-row-toggle-hostc-codex-action').props.accessibilityLabel).toBe('No status available');
});


test('terminal durable question does not clear a partially overlapping later chat list question', () => {
  const streamId = 'hostc:codex:ambiguous-later';
  mockState.sessions = [{
    ...session(streamId, 'Later grouped question'),
    question: {
      question_id: 'q-shared',
      header: 'Grouped question',
      prompt: 'Answer both parts.',
      options: [{ index: 1, label: 'Proceed' }],
      questions: [
        { question_id: 'q-shared', prompt: 'Earlier part', options: [{ index: 1, label: 'Done' }] },
        { question_id: 'q-later', prompt: 'Later part', options: [{ index: 1, label: 'Proceed' }] },
      ],
    },
  }];
  const open = agentQuestionNotification(streamId, {
    notification_id: 'n-ambiguous-terminal',
    state: 'answered',
    resolved_at: '2026-07-05T12:00:01.000Z',
    resolution: { by: 'user', at: '2026-07-05T12:00:01.000Z', action_kind: 'yes_no' },
  });
  mockState.notifications = [{
    ...open,
    question: {
      ...open.question,
      state: 'answered',
      answer: { selections: ['done'] },
      questions: [
        { question_id: 'q-shared' },
        { question_id: 'q-old-only' },
      ],
    },
  }];

  render(<ChatsScreen />);

  expect(screen.getByTestId(`chat-question-attention-bar-${streamId.replace(/:/g, '-')}`)).toBeTruthy();
});

test('open-question accent is flush to the card edge and clear of the machine sigil', () => {
  const streamId = 'hostc:codex:accent-geometry';
  mockState.sessions = [session(streamId, 'Accent geometry')];
  mockState.notifications = [agentQuestionNotification(streamId)];

  render(<ChatsScreen />);

  const bar = screen.getByTestId('chat-question-attention-bar-hostc-codex-accent-geometry');
  const style = require('react-native').StyleSheet.flatten(bar.props.style);
  expect(style.left).toBe(-14);
  expect(style.borderRadius).toBe(0);
});

test('inline durable multi-question submit preserves each child resolver id', async () => {
  const streamId = 'hostc:codex:durable-multi';
  mockState.sessions = [session(streamId, 'Needs two answers')];
  mockState.notifications = [agentQuestionNotification(streamId, {
    notification_id: 'n-durable-multi',
    question: {
      question_id: 'q-envelope',
      producer_stream_id: streamId,
      response_mode: 'single_choice',
      options: [],
      questions: [
        { question_id: 'q-lane', response_mode: 'single_choice', prompt: 'Which lane?', options: [{ label: 'Lane A', value: 'lane_a' }] },
        { question_id: 'q-window', response_mode: 'single_choice', prompt: 'Which window?', options: [{ label: 'Tonight', value: 'tonight' }] },
      ],
      state: 'open',
      answer: null,
    },
  })];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-durable-multi'));
  fireEvent.press(screen.getByTestId('smart-question-option-1'));
  fireEvent.press(screen.getByTestId('question-dot-1'));
  fireEvent.press(screen.getByTestId('smart-question-option-1'));
  await act(async () => fireEvent.press(screen.getByTestId('smart-question-submit')));

  expect(mockActions.answerPrompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
    questionId: 'q-lane', selections: ['lane_a'],
  }));
  expect(mockActions.answerPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
    questionId: 'q-window', selections: ['tonight'],
  }));
});

test('inline durable free_text question submits exact text with question_id', async () => {
  const typed = `  first line
second line  `;
  mockState.sessions = [session('hostc:codex:free-text', 'Needs text')];
  mockState.notifications = [
    agentQuestionNotification('hostc:codex:free-text', {
      notification_id: 'n-free-text',
      actions: [{ kind: 'ack', action_id: 'ack-free' }],
      question: {
        question_id: 'q-free-text',
        producer_stream_id: 'hostc:codex:free-text',
        response_mode: 'free_text',
        options: [],
        state: 'open',
        answer: null,
      },
    }),
  ];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-free-text'));
  fireEvent.changeText(screen.getByTestId('smart-question-free-text'), typed);
  fireEvent.changeText(screen.getByTestId('smart-question-note'), 'optional note');
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-free-text',
    text: typed,
  });
});

test('inline allow-custom choice submits typed custom text without selecting a predefined option', async () => {
  mockState.sessions = [session('hostc:codex:custom', 'Needs custom answer')];
  mockState.notifications = [
    agentQuestionNotification('hostc:codex:custom', {
      notification_id: 'n-custom',
      question: {
        question_id: 'q-custom',
        producer_stream_id: 'hostc:codex:custom',
        response_mode: 'single_choice',
        allow_custom: true,
        options: [
          { label: 'Lane A', value: 'lane_a', description: 'Safest rollout.' },
          { label: 'Lane B', value: 'lane_b' },
        ],
        state: 'open',
        answer: null,
      },
    }),
  ];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-custom'));
  expect(screen.queryByTestId('new-chat-button')).toBeNull();
  expect(screen.getByTestId('smart-question-option-description-1')).toHaveTextContent('Safest rollout.');
  expect(screen.queryByTestId('smart-question-option-description-2')).toBeNull();
  fireEvent.press(screen.getByTestId('smart-question-custom-toggle'));
  fireEvent.changeText(screen.getByTestId('smart-question-custom-answer'), 'with a canary first');
  expect(screen.queryByTestId('smart-question-note')).toBeNull();
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-custom',
    text: 'with a canary first',
  });
});

test('inline legacy question submit calls dismissQuestion fallback', async () => {
  mockState.sessions = [{
    ...session('hostc:codex:legacy', 'Legacy question'),
    question: {
      question_key: 'server-question-key',
      prompt: 'Pick one',
      options: [
        { index: 1, label: 'One' },
        { index: 2, label: 'Two' },
      ],
    },
  }];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-legacy'));
  fireEvent.press(screen.getByTestId('smart-question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.dismissQuestion).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc',
    sessionName: 'legacy',
    questionKey: 'server-question-key',
  }));
  expect(mockActions.answerPrompt).not.toHaveBeenCalled();
});

test('inline legacy and durable questions coexist and answer through distinct actions', async () => {
  mockState.sessions = [
    {
      ...session('hostc:codex:legacy', 'Legacy question'),
      question: {
        question_key: 'server-question-key',
        prompt: 'Pick one',
        options: [
          { index: 1, label: 'One' },
          { index: 2, label: 'Two' },
        ],
      },
    },
    session('hostc:codex:daemon', 'Daemon question'),
  ];
  mockState.notifications = [agentQuestionNotification('hostc:codex:daemon', { notification_id: 'n-daemon' })];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-legacy'));
  fireEvent.press(screen.getByTestId('smart-question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-daemon'));
  fireEvent.press(screen.getByTestId('smart-question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.dismissQuestion).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc',
    sessionName: 'legacy',
    questionKey: 'server-question-key',
  }));
  expect(mockActions.answerPrompt).toHaveBeenCalledWith({
    questionId: 'q-hostc:codex:daemon',
    selections: ['lane_b'],
  });
});

test('inline legacy scan-incomplete question requires only the active item', async () => {
  mockState.sessions = [{
    ...session('hostc:codex:legacy-scan', 'Legacy scan question'),
    question: {
      question_key: 'server-question-key',
      multi: true,
      scan_incomplete: true,
      active_index: 1,
      questions: [
        {
          index: 0,
          prompt: 'Earlier item',
          options: [{ index: 1, label: 'Earlier' }],
        },
        {
          index: 1,
          prompt: 'Active item',
          options: [{ index: 2, label: 'Active' }],
        },
      ],
    },
  }];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-legacy-scan'));

  expect(screen.getByTestId('smart-question-option-1').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('smart-question-submit-all').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('question-dot-1'));
  fireEvent.press(screen.getByTestId('smart-question-option-2'));
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.dismissQuestion).toHaveBeenCalledWith(expect.objectContaining({
    host: 'hostc',
    sessionName: 'legacy-scan',
    questionKey: 'server-question-key',
  }));
});

const boundedMultiSelectQuestion = {
  question_key: 'bounded-question-key',
  header: 'Hosts',
  prompt: 'Pick hosts.',
  options: [],
  multi: true,
  active_index: 0,
  submit_present: true,
  questions: [
    {
      index: 0,
      header: 'Hosts',
      prompt: 'Pick two hosts.',
      multiSelect: true,
      allow_custom: true,
      minSelections: 2,
      maxSelections: 2,
      options: [
        { index: 1, label: 'hosta', description: '', meta: false },
        { index: 2, label: 'hostc', description: '', meta: false },
        { index: 3, label: 'hostb', description: '', meta: false },
      ],
    },
  ],
};

test('inline legacy bounded multi-select enforces Session constraints', async () => {
  mockState.sessions = [{
    ...session('hostc:codex:bounded', 'Bounded legacy question'),
    question: boundedMultiSelectQuestion,
  }];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-bounded'));

  expect(screen.getByTestId('smart-question-submit').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('smart-question-constraint')).toHaveTextContent('Select 2 options');
  fireEvent.press(screen.getByTestId('smart-question-option-1'));
  expect(screen.getByTestId('smart-question-submit').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('smart-question-option-2'));
  expect(screen.queryByTestId('smart-question-constraint')).toBeNull();
  expect(screen.getByTestId('smart-question-submit').props.accessibilityState.disabled).toBe(false);
  fireEvent.press(screen.getByTestId('smart-question-option-3'));
  expect(screen.getByTestId('smart-question-submit').props.accessibilityState.disabled).toBe(true);
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.dismissQuestion).not.toHaveBeenCalled();
});

test('inline legacy bounded multi-select can submit an explicit custom answer', async () => {
  mockState.sessions = [{
    ...session('hostc:codex:bounded', 'Bounded legacy question'),
    question: boundedMultiSelectQuestion,
  }];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-bounded'));
  fireEvent.press(screen.getByTestId('smart-question-custom-toggle'));
  fireEvent.changeText(screen.getByTestId('smart-question-custom-answer'), 'run it on the hosts with capacity');
  await act(async () => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });

  expect(mockActions.dismissQuestion).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'bounded',
    questionKey: 'bounded-question-key',
  });
  expect(mockActions.sendMessage).toHaveBeenCalledWith({
    host: 'hostc',
    sessionName: 'bounded',
    text: buildPentacleQuestionAnswerText({
      question: boundedMultiSelectQuestion,
      answers: [{ text: 'run it on the hosts with capacity' }],
    }),
    optimisticId: 'optimistic-question-1',
  });
});

test('inline action rows show a badge when multiple open questions are bundled', () => {
  mockState.sessions = [session('hostc:codex:action', 'Needs answer')];
  mockState.notifications = [
    agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question-1' }),
    agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question-2' }),
  ];

  render(<ChatsScreen />);

  expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2);
});

test('inline durable answer clears the chat list badge while pending and restores it on failure', async () => {
  let rejectResolve: ((error: Error) => void) | undefined;
  (mockActions.beginOptimisticQuestionAnswer as jest.Mock).mockImplementationOnce(({ streamId, text }: { streamId: string; text: string }) => {
    mockState.optimisticSends = {
      'optimistic-question-1': {
        optimistic_id: 'optimistic-question-1',
        request_id: 'request-question-1',
        stream_id: streamId,
        text,
        status: 'dispatched',
        created_at: Date.now(),
        reconnect_count: 0,
      },
    };
    return 'optimistic-question-1';
  });
  mockActions.discardOptimisticQuestionAnswer.mockImplementationOnce(() => {
    mockState.optimisticSends = {};
  });
  mockActions.answerPrompt.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectResolve = reject;
  }));
  mockState.sessions = [session('hostc:codex:action', 'Needs answer', 'hidden')];
  mockState.notifications = [agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question' })];

  const view = render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-action'));
  fireEvent.press(screen.getByTestId('smart-question-option-1'));
  act(() => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });
  const pendingState = {
    ...mockState,
    notifications: [{
      ...mockState.notifications[0],
      client_resolution_pending: true,
    } as PentacleNotification],
  };
  expect(selectSmartChatList(pendingState).find((chat) => chat.streamId === 'hostc:codex:action')?.openQuestions).toHaveLength(0);
  mockState.notifications = pendingState.notifications;
  view.rerender(<ChatsScreen />);
  expect(screen.queryByTestId('question-panel-hostc:codex:action')).toBeNull();
  expect(screen.queryByTestId('chats-action-count')).toBeNull();
  expect(screen.getByTestId('chat-row-toggle-hostc-codex-action').props.accessibilityLabel).toBe('No status available');
  expect(screen.queryByTestId('chat-question-attention-bar-hostc:codex:action')).toBeNull();
  mockState.notifications = [{
    ...mockState.notifications[0],
    client_resolution_pending: false,
    client_resolution_error: 'resolve failed',
  } as PentacleNotification];
  view.rerender(<ChatsScreen />);
  await act(async () => rejectResolve?.(new Error('resolve failed')));

  expect(screen.getByTestId('question-panel-hostc:codex:action')).toBeTruthy();
  expect(screen.getByTestId('chats-action-count')).toBeTruthy();
  expect(screen.getByTestId('chat-row-toggle-hostc-codex-action').props.accessibilityLabel).toBe('Answer 1 question');
  expect(screen.getByText('resolve failed')).toBeTruthy();
  expect(screen.getByTestId('smart-question-option-1').props.accessibilityState.checked).toBe(true);
  expect(mockActions.discardOptimisticQuestionAnswer).toHaveBeenCalledWith('optimistic-question-1');
});

test('chat list restores a multi-question badge when a later child optimistic answer is discarded', () => {
  const streamId = 'hostc:codex:multi-restore';
  const question = {
    question_id: 'q-group',
    producer_stream_id: streamId,
    response_mode: 'single_choice',
    options: [],
    state: 'open',
    answer: null,
    questions: [
      { question_id: 'q-first', response_mode: 'single_choice', options: [{ label: 'A', value: 'a' }] },
      { question_id: 'q-second', response_mode: 'single_choice', options: [{ label: 'B', value: 'b' }] },
    ],
  };
  mockState.sessions = [{ ...session(streamId, 'Multi restore'), question }];
  mockState.notifications = [agentQuestionNotification(streamId, {
    notification_id: 'n-multi-restore',
    question,
  })];
  const optimisticSend = (questionId: string) => ({
    optimistic_id: `optimistic-${questionId}`,
    request_id: `request-${questionId}`,
    stream_id: streamId,
    text: JSON.stringify({
      type: 'notification.answer',
      notification_id: 'n-multi-restore',
      question_id: questionId,
      answer: { action_kind: 'yes_no' },
    }),
    status: 'queued',
    created_at: Date.now(),
    reconnect_count: 0,
  });
  mockState.optimisticSends = {
    first: optimisticSend('q-first'),
    second: optimisticSend('q-second'),
  };
  expect(selectSmartChatList(mockState).find((chat) => chat.streamId === streamId)?.openQuestions).toHaveLength(0);

  mockState.optimisticSends = { first: optimisticSend('q-first') };
  expect(selectSmartChatList(mockState).find((chat) => chat.streamId === streamId)?.openQuestions).toHaveLength(1);
});

test('transport-ambiguous question submit retains a local retry card after the server snapshot resolves it', async () => {
  let rejectResolve: ((error: Error) => void) | undefined;
  mockActions.answerPrompt.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectResolve = reject;
  }));
  mockState.sessions = [session('hostc:codex:action', 'Needs answer')];
  mockState.notifications = [agentQuestionNotification('hostc:codex:action', { notification_id: 'n-question' })];

  const view = render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-toggle-hostc-codex-action'));
  fireEvent.press(screen.getByTestId('smart-question-option-1'));
  act(() => {
    fireEvent.press(screen.getByTestId('smart-question-submit'));
  });
  mockState.notifications = [];
  view.rerender(<ChatsScreen />);
  await act(async () => rejectResolve?.(new Error('Pentacle socket closed')));

  expect(screen.getByTestId('question-panel-hostc:codex:action')).toBeTruthy();
  expect(screen.getByText('Pentacle socket closed')).toBeTruthy();
  expect(screen.getByTestId('smart-question-option-1').props.accessibilityState.checked).toBe(true);
  expect(mockActions.discardOptimisticQuestionAnswer).toHaveBeenCalledWith('optimistic-question-1');
});

test('non-question rows keep the CardAction footprint as a disabled caret and never open a panel', () => {
  mockState.sessions = [session('hostc:codex:reply', 'Reply target')];

  render(<ChatsScreen />);

  const action = screen.getByTestId('chat-row-toggle-hostc-codex-reply');
  expect(action.props.accessibilityState?.disabled).toBe(true);
  expect(action.props.accessibilityLabel).toBe('No status available');
  fireEvent.press(action);
  expect(screen.queryByTestId('reply-panel-hostc:codex:reply')).toBeNull();
  expect(screen.queryByTestId('reply-input-hostc:codex:reply')).toBeNull();
  expect(screen.queryByTestId('card-status-mini-hostc:codex:reply')).toBeNull();
});

test('tapping a non-question row navigates to the full Session', () => {
  mockState.sessions = [session('hostc:codex:reply', 'Reply target')];

  render(<ChatsScreen />);
  fireEvent.press(screen.getByTestId('chat-row-hostc-codex-reply'));

  expect(require('expo-router').router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Areply');
});

test('report action opens the correct session ReportsOverlay from the container', () => {
  mockReportsByStream['hostc:codex:rpt'] = [{ read: false, read_at: null }];
  mockState.sessions = [session('hostc:codex:rpt', 'Report holder'), session('hostc:codex:other', 'Other row')];

  render(<ChatsScreen />);
  const action = screen.getByTestId('chat-row-toggle-hostc-codex-rpt');
  expect(action.props.accessibilityLabel).toBe('Open 1 unread report');
  fireEvent.press(action);

  expect(screen.getByTestId('reports-overlay-hostc:codex:rpt')).toBeTruthy();
  expect(screen.queryByTestId('reports-overlay-hostc:codex:other')).toBeNull();
  delete mockReportsByStream['hostc:codex:rpt'];
});

test('authoritative updates reveal the next action: question, then report, then caret', () => {
  const streamId = 'hostc:codex:action';
  mockReportsByStream[streamId] = [{ read: false, read_at: null }];
  mockState.sessions = [{
    ...session(streamId, 'Needs answer'),
    status_card: { goal: 'Track the batch', updated_at: '2026-07-11T11:00:00.000Z' },
  }];
  mockState.notifications = [agentQuestionNotification(streamId)];

  const rendered = render(<ChatsScreen />);
  const actionId = 'chat-row-toggle-hostc-codex-action';
  expect(screen.getByTestId(actionId).props.accessibilityLabel).toBe('Answer 1 question');

  mockState.notifications = [];
  rendered.rerender(<ChatsScreen />);
  expect(screen.getByTestId(actionId).props.accessibilityLabel).toBe('Open 1 unread report');

  mockReportsByStream[streamId] = [{ read: true, read_at: '2026-07-11T12:00:00.000Z' }];
  // The production hook is an external-store subscription. Re-mount this
  // test double to model its authoritative report-store emission while the
  // chat-list selector deliberately preserves unchanged row props.
  rendered.unmount();
  render(<ChatsScreen />);
  expect(screen.getByTestId(actionId).props.accessibilityLabel).toBe('Expand chat row');
  delete mockReportsByStream[streamId];
});

test('native push unread never produces a report action without daemon reports', () => {
  mockState.sessions = [session('hostc:codex:push', 'Push target')];

  render(<ChatsScreen />);
  const action = screen.getByTestId('chat-row-toggle-hostc-codex-push');
  expect(screen.queryByTestId('chat-row-report-badge-hostc-codex-push')).toBeNull();
  expect(action.props.accessibilityState?.disabled).toBe(true);
  expect(action.props.accessibilityLabel).toBe('No status available');
});
