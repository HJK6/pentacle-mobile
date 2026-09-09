// Load-path oracle (public_contract).
// Unlike chats.test.tsx (which supplies non-JSON optimisticSends so the
// question-identity thrash path never runs), this suite drives a valid
// notification.answer optimistic row and pins the per-emit index-rebuild
// budget the stream-load implementation must hold.
import { selectSmartChatList } from '../../../app/(tabs)/chats';
import type { PentacleNotification } from 'pentacle-chat-core';

// Count actual index rebuilds by wrapping the pure helper indexOpenQuestions()
// invokes only on a cache miss.
const fullyCoveredCalls = { count: 0 };

jest.mock('expo-router', () => require('../../helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('../../../src/utils/harnessRuntime', () => ({
  useHarnessReady: () => false,
  hasAction: () => false,
}));
jest.mock('../../../src/services/agentQuestionNotifications', () => {
  const actual = jest.requireActual('../../../src/services/agentQuestionNotifications');
  return {
    ...actual,
    fullyCoveredOptimisticQuestionNotificationIds: (...args: unknown[]) => {
      fullyCoveredCalls.count += 1;
      return (actual.fullyCoveredOptimisticQuestionNotificationIds as (...a: unknown[]) => unknown)(...args);
    },
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('../../../src/hooks/usePentacleToken', () => jest.fn());
jest.mock('../../../src/services/pentacleStream', () => ({
  // Faithful re-implementation of the selector so the identity signature
  // is non-empty (the condition under which the two call sites diverge).
  selectOptimisticQuestionAnswerIdentities: jest.fn((state: any) => Object.values(state.optimisticSends ?? {}).flatMap((send: any) => {
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
jest.mock('../../../src/services/pentacleAssets', () => ({
  useSessionReports: () => [],
  reportUnreadCount: () => 0,
  listReports: jest.fn().mockResolvedValue([]),
  isReportSessionClosed: () => false,
}));
jest.mock('../../../src/components/ReportViewerModal', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return ({ streamId }: { streamId: string }) => ReactActual.createElement(View, { testID: `reports-overlay-${streamId}` });
});
jest.mock('../../../src/hooks/useUnreadNotifications', () => ({
  __esModule: true,
  default: () => 0,
  useHasUnreadNotification: () => false,
  markRead: jest.fn(),
}));

function questionNotification(streamId: string, notificationId: string): PentacleNotification {
  return {
    notification_id: notificationId,
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
      options: [{ label: 'Lane A', value: 'lane_a' }, { label: 'Lane B', value: 'lane_b' }],
      state: 'open',
      answer: null,
    },
    resolution: null,
  } as unknown as PentacleNotification;
}

function loadState() {
  const streamId = 'hostc:codex:action';
  return {
    sessions: [{
      stream_id: streamId,
      host: 'hostc',
      provider: 'codex',
      session_name: 'action',
      title: 'Needs answer',
      last_event_at: '2026-07-05T12:00:00.000Z',
      last_text: 'preview',
      last_kind: 'ASSIST',
      online: true,
    }],
    // Fresh array each call so the outer indexOpenQuestions() call is always a
    // genuine cache miss and the count reflects one emit deterministically.
    notifications: [questionNotification(streamId, 'n-question')],
    events: [],
    drafts: {},
    workingByStream: {},
    turnsByStream: {},
    optimisticByRequestId: { 'request-1': 'optimistic-1' },
    optimisticSends: {
      'optimistic-1': {
        optimistic_id: 'optimistic-1',
        request_id: 'request-1',
        stream_id: streamId,
        status: 'dispatched',
        created_at: 1_700_000_000_000,
        text: JSON.stringify({ type: 'notification.answer', notification_id: 'n-question', question_id: `q-${streamId}` }),
      },
    },
  } as any;
}

test('one index rebuild per emit when an optimistic question answer is active', () => {
  fullyCoveredCalls.count = 0;
  selectSmartChatList(loadState());
  // The visible-list selector passes no optimistic signature, so its inner
  // indexOpenQuestions() call diverges from the outer one and rebuilds a second
  // time. The load fix threads the identities through both sites.
  expect(fullyCoveredCalls.count).toBe(1);
});
