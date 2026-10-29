import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ChatsScreen, {
  isDefaultVisibleSession,
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

test('smart chat selector leaves assistant roles unpinned unless configured and pins an exact configured role ahead of attention', () => {
  const assistant = { ...session('hostc:codex:assistant', 'Assistant'), role: 'assistant', last_event_at: '2026-07-05T08:00:00.000Z' };
  const action = { ...session('hostc:codex:action', 'Needs answer'), last_event_at: '2026-07-05T10:00:00.000Z' };
  const working = { ...session('hostc:codex:working', 'Still working'), working: true, last_event_at: '2026-07-05T09:00:00.000Z' };
  mockState.sessions = [assistant, action, working];
  mockState.notifications = [agentQuestionNotification('hostc:codex:action')];

  expect(selectSmartChatList(mockState).map((item) => item.streamId)).toEqual([
    'hostc:codex:action',
    'hostc:codex:working',
    'hostc:codex:assistant',
  ]);

  const pinned = selectSmartChatList(mockState, 'all', undefined, 'assistant');
  expect(pinned.map((item) => item.streamId)).toEqual([
    'hostc:codex:assistant',
    'hostc:codex:action',
    'hostc:codex:working',
  ]);
  expect(pinned[0].isAssistantRole).toBe(true);
  expect(smartChatAttention(pinned[1])).toBe(true);
});

test.each(['', 'assistant'])('composite assistant stays first with assistant role config %j', (assistantRole) => {
  const primary = { ...session('hostc:assistant', 'Zephyr'), provider: 'composite', role: 'assistant_composite', session_kind: 'assistant_composite', last_event_at: '2026-07-05T07:00:00.000Z' };
  const action = { ...session('hostc:codex:action', 'Needs answer'), last_event_at: '2026-07-05T10:00:00.000Z' };
  const working = { ...session('hostc:codex:working', 'Still working'), working: true, last_event_at: '2026-07-05T09:00:00.000Z' };
  const legacy = { ...session('hostc:codex:legacy', 'Legacy assistant'), role: 'assistant', last_event_at: '2026-07-05T08:00:00.000Z' };
  mockState.sessions = [action, working, legacy, primary];
  mockState.notifications = [agentQuestionNotification('hostc:codex:action')];

  const rows = selectSmartChatList(mockState, 'all', undefined, assistantRole);
  expect(rows.map((item) => item.streamId)).toEqual(assistantRole ? [primary.stream_id, legacy.stream_id, action.stream_id, working.stream_id] : [primary.stream_id, action.stream_id, working.stream_id, legacy.stream_id]);
  expect(rows[0].isCompositeChat).toBe(true);
  expect(rows[0].role).toBe('assistant_composite');
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
