import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Swipeable } from 'react-native-gesture-handler';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Fonts,
  MACHINE_ORDER,
  MACHINES,
  SCREEN_PAD,
  TOP_INSET,
  Tokens,
  type MachineName,
} from '@/constants/Colors';
import ArcaneRingFrame from '../../src/components/ArcaneRingFrame';
import Bevel from '../../src/components/Bevel';
import Starfield from '../../src/components/Starfield';
import StatusTag from '../../src/components/StatusTag';
import { CardStatusMini, hasSessionStatusCardContent, type SessionStatusCardSource } from '../../src/components/SessionStatusCard';
import SummonModal, { type SummonMachine } from '../../src/components/SummonModal';
import RenameChatModal from '../../src/components/RenameChatModal';
import { Brackets, Spark, Spinner } from '../../src/components/ArcaneAtoms';
import {
  mobileQuestionItems,
  QuestionCardSurface,
  useMobileQuestionFlow,
  type MobileQuestionAnswer,
  type MobileQuestionEntry,
} from '../../src/components/MobileQuestions';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import useFluidWorkingSeconds from '../../src/hooks/useFluidWorkingSeconds';
import {
  selectOptimisticQuestionAnswerIdentities,
  usePentacleStreamActions,
  usePentacleStreamSelectorWhen,
  type PendingSessionClose,
  type SpawnCatalog,
} from '../../src/services/pentacleStream';
import { validateSpawnCatalog } from '../../src/services/spawnCatalog';
import { createSpawnIntentKeeper, executeSpawnIntent } from '../../src/services/spawnIntent';
import {
  isDefaultVisibleSession,
} from '../../src/services/sessionVisibility';
import {
  buildPentacleQuestionAnswerText,
  createChatListSelector,
  getPentacleSessionStatusLabel,
  logTelemetry,
  normalizePentacleHost,
  selectMachineStatusList,
  selectPentacleDerivedEventIndex,
  SESSION_SENDING_VISIBLE_AFTER_MS,
  type PentacleChatListItem,
  type ChildAgent,
  type PentacleEvent,
  type PentacleMachineCard,
  type PentacleNotification,
  type PentacleQuestion,
  type PentacleQuestionItem,
  type PentacleQuestionAnswerValue,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';
import * as harnessRuntime from '../../src/utils/harnessRuntime';
import ReportViewerModal from '../../src/components/ReportViewerModal';
import { reportUnreadCount, useSessionReports } from '../../src/services/pentacleAssets';
import { MOBILE_TELEMETRY_EVENTS } from '../../src/services/mobileTelemetryEvents';
import { CHAT_ROW_SWIPE_OPEN_THRESHOLD } from '../../src/services/chatRowSwipeSettle';
import { performChatOpenNavigation } from '../../src/services/chatOpenNavigation';
import { resetChatOpenNavigationIntents } from '../../src/services/chatOpenNavigationIntent';
import {
  agentQuestionStreamId,
  agentQuestionMatchesSessionQuestion,
  buildDurableQuestionResolution,
  buildDurableQuestionAnswerText,
  durableQuestionCardModel,
  durableQuestionDisplaySelections,
  fullyCoveredOptimisticQuestionNotificationIds,
  isAgentQuestionNotification,
  isOpenAgentQuestionNotification,
  terminalAgentQuestionMatchesSessionQuestion,
  type DurableQuestionCardModel,
  type DurableQuestionItemModel,
} from '../../src/services/agentQuestionNotifications';

export { isDefaultVisibleSession };

const SELECTABLE_TEXT = { selectable: false, selectionColor: Tokens.palette.green };
const selectMobileChatList = createChatListSelector();
const ALL_CHATS_HARNESS_ACTION = 'all_chats_regression';
const ALL_CHATS_HARNESS_SESSION_COUNT = 64;

export type AllChatsHarnessActionRequest = {
  action_id: string;
  action: 'scroll' | 'open_return' | 'pull_refresh';
  burst: number;
  stream_id?: string;
  expected_unread_count?: number;
  expected_open_question_count?: number;
};

export function allChatsHarnessCommitMatches(
  request: AllChatsHarnessActionRequest,
  unreadCount: number,
  openQuestionCount: number,
) {
  return (request.expected_unread_count === undefined || request.expected_unread_count === unreadCount) &&
    (request.expected_open_question_count === undefined ||
      request.expected_open_question_count === openQuestionCount);
}

type AllChatsHarnessActionHandler = (request: AllChatsHarnessActionRequest) => void | Promise<void>;
let allChatsHarnessActionHandler: AllChatsHarnessActionHandler | null = null;
let allChatsHarnessScreenReady = false;

export function isAllChatsHarnessScreenReady() {
  return process.env.EXPO_PUBLIC_HARNESS === '1' && allChatsHarnessScreenReady;
}

export function registerAllChatsHarnessActionHandler(handler: AllChatsHarnessActionHandler) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return () => undefined;
  allChatsHarnessActionHandler = handler;
  return () => {
    if (allChatsHarnessActionHandler === handler) allChatsHarnessActionHandler = null;
  };
}

export async function dispatchAllChatsHarnessAction(request: AllChatsHarnessActionRequest) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !allChatsHarnessActionHandler) {
    return { status: 'no_handler' as const };
  }
  await allChatsHarnessActionHandler(request);
  return { status: 'ok' as const };
}

export function allChatsHarnessRowDigest(rows: SmartChatListItem[]) {
  const serialized = rows.map((row, index) => ({
    index,
    stream_id: row.streamId,
    lastEventMs: row.lastEventMs,
    previewText: row.previewText,
    latestMessages: row.latestMessages,
    status: row.status,
    unread: reportUnreadCount(row.streamId),
    openQuestions: row.openQuestions.length,
  }));
  let hash = 0x811c9dc5;
  for (const character of JSON.stringify(serialized)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
type ProviderId = 'codex' | 'claude';

const HOST_TO_MACHINE: Record<string, MachineName> = {
  hosta: 'hosta',
  hostc: 'hostc',
  hostb: 'hostb',
  hostd: 'hostd',
};

function machineNameFor(host: string, title?: string): MachineName {
  const byTitle = MACHINE_ORDER.find((name) => title?.toLowerCase() === name.toLowerCase());
  return byTitle ?? HOST_TO_MACHINE[host.toLowerCase()] ?? 'hosta';
}

function testIdForStream(streamId: string) {
  return `chat-row-${streamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

type OfflineStatusSource = {
  hostStatus?: string;
  hostStatusReason?: string;
  hostStatusSince?: string;
  hostStatusReasonRaw?: string;
  hostStatusSinceRaw?: string;
};

function formatOfflineSince(iso?: string) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function offlineBadgeLabel(source: OfflineStatusSource) {
  const status = String(source.hostStatus || '').toLowerCase();
  const reason = String(source.hostStatusReason || source.hostStatusReasonRaw || '').toLowerCase();
  const since = source.hostStatusSince || source.hostStatusSinceRaw;
  if (status !== 'offline' && reason !== 'unreachable') return null;
  const age = formatOfflineSince(since);
  return age ? `OFFLINE ${age}` : 'OFFLINE';
}

// A narrowed subscription (include_subagents:false) no longer delivers a hidden seat's
// inventory row, but its open prompt-ask still arrives on the global notifications slice.
// Reconstruct a minimal chat-list row directly from that notification — built by hand
// rather than routed through selectMobileChatList, so it never triggers the per-session
// transcript scan (a hidden seat also delivers no events under the narrowed scope) and so
// it cannot evict the single-entry derived-event-index cache. The durable question action
// attaches downstream (openQuestionsForStream, notification-derived) and answering routes
// by notification_id (resolveNotification), so no session frame is required.
function synthesizeQuestionChatItem(
  streamId: string,
  notification: PentacleNotification,
): PentacleChatListItem {
  const parts = streamId.split(':');
  const host = normalizePentacleHost(parts[0] || '');
  return {
    streamId,
    host,
    hostTitle: host,
    provider: (parts.length >= 3 ? parts[1] : '').toUpperCase(),
    sessionName: parts.at(-1) || streamId,
    title: notification.title || 'Agent question',
    previewText: notification.body || 'Waiting for your answer…',
    status: 'idle',
    statusLabel: getPentacleSessionStatusLabel('idle'),
    workingElapsedSeconds: null,
    sending: false,
    sendingImmediate: false,
    updatedLabel: '',
    draft: '',
  };
}

export function selectVisibleChatList(
  state: PentacleStreamState,
  filter: 'all' | string = 'all',
  optimisticAnswers: readonly { notificationId: string; questionId?: string }[] = selectOptimisticQuestionAnswerIdentities(state),
) {
  const questionIndex = indexOpenQuestions(state.notifications as PentacleNotification[], optimisticAnswers);
  const questionStreamIds = questionIndex.streamIds;
  // Single pass: filter to visible + question-bearing rows AND record which streams are
  // present, so the synthesis below adds no extra full scan of state.sessions.
  const present = new Set<string>();
  const sessions = state.sessions.filter((session) => {
    present.add(session.stream_id);
    return isDefaultVisibleSession(session) || questionStreamIds.has(session.stream_id);
  });
  const rows = selectMobileChatList({ ...state, sessions }, filter);
  if (questionStreamIds.size === 0) return rows;
  const synthesized: PentacleChatListItem[] = [];
  for (const streamId of questionStreamIds) {
    if (present.has(streamId)) continue;
    const notification = questionIndex.openNotificationByStream.get(streamId);
    if (!notification) continue;
    const item = synthesizeQuestionChatItem(streamId, notification);
    if (filter !== 'all' && item.host !== filter) continue;
    synthesized.push(item);
  }
  return synthesized.length ? [...rows, ...synthesized] : rows;
}

type SmartQuestionAction =
  | { kind: 'durable'; id: string; model: DurableQuestionCardModel }
  | { kind: 'legacy'; id: string; question: PentacleQuestion; host: string; sessionName: string };

type StatusCardChatListItem = PentacleChatListItem & SessionStatusCardSource;
type DeletableChatListItem = PentacleChatListItem & { pendingClose?: PendingSessionClose };

export type SmartChatListItem = StatusCardChatListItem & {
  machineName: MachineName;
  openQuestions: SmartQuestionAction[];
  latestMessages: string[];
  lastEventMs: number;
  pendingClose?: PendingSessionClose;
  role: string | null;
  sessionGeneration: string | null;
  agents: readonly ChildAgent[];
};

const smartChatListCache = new Map<string, SmartChatListItem[]>();

type QuestionSubmission = {
  action: SmartQuestionAction;
  answers: MobileQuestionAnswer[];
  items?: DurableQuestionItemModel[];
};

function latestMessageOrder(left: PentacleEvent, right: PentacleEvent) {
  const rightTime = Date.parse(right.timestamp || '');
  const leftTime = Date.parse(left.timestamp || '');
  return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0) ||
    (right.daemon_seq ?? 0) - (left.daemon_seq ?? 0);
}

let smartEventSource: ReadonlyMap<string, readonly PentacleEvent[]> | null = null;
let smartEventIndex = {
  latestMessagesByStream: new Map<string, string[]>(),
};
// Per-stream memo keyed on the stream's events array ref. The reducer preserves
// an unchanged stream's `bucket.events` reference across a live delivery (only
// the delivered event's stream gets a new array), so on each `setState` only the
// changed stream is recomputed instead of re-scanning every retained event.
// This keeps the all-chats reconcile O(changed) rather than O(total) as the
// store grows (spec tap_shell_layout_regression_build_1155 — all_chats set_state).
let smartEventStreamCache = new Map<string, { events: readonly PentacleEvent[]; messages: string[] }>();

function computeLatestMessages(events: readonly PentacleEvent[]): string[] {
  const candidates: PentacleEvent[] = [];
  for (const event of events) {
    if (typeof event.text !== 'string' || !event.text.trim()) continue;
    if (!candidates.length || latestMessageOrder(event, candidates[0]) < 0) {
      candidates.unshift(event);
      if (candidates.length > 2) candidates.pop();
    } else if (candidates.length === 1) {
      candidates.push(event);
    } else if (latestMessageOrder(event, candidates[1]) < 0) {
      candidates[1] = event;
    }
  }
  return candidates.map((event) => event.text.trim());
}

function indexSmartEvents(eventsByStream: ReadonlyMap<string, readonly PentacleEvent[]>) {
  if (eventsByStream === smartEventSource) return smartEventIndex;
  const latestMessagesByStream = new Map<string, string[]>();
  const nextCache = new Map<string, { events: readonly PentacleEvent[]; messages: string[] }>();
  for (const [streamId, events] of eventsByStream) {
    const cached = smartEventStreamCache.get(streamId);
    const messages = cached && cached.events === events
      ? cached.messages
      : computeLatestMessages(events);
    nextCache.set(streamId, { events, messages });
    if (messages.length) latestMessagesByStream.set(streamId, messages);
  }
  smartEventStreamCache = nextCache;
  smartEventSource = eventsByStream;
  smartEventIndex = { latestMessagesByStream };
  return smartEventIndex;
}

function latestMessagesForStream(index: Map<string, string[]>, streamId: string, fallback: string) {
  const messages = index.get(streamId);
  if (messages?.length) return messages;
  const trimmed = String(fallback || '').trim();
  return [trimmed || 'Waiting for first message...'];
}

let openQuestionNotificationSource: readonly PentacleNotification[] | null = null;
let openQuestionOptimisticSignature = '';
let openQuestionIndex = {
  streamIds: new Set<string>(),
  actions: new Map<string, SmartQuestionAction[]>(),
  terminalByStream: new Map<string, PentacleNotification[]>(),
  pendingByStream: new Map<string, PentacleNotification[]>(),
  // The open question notification per stream, so a narrowed subscription
  // (include_subagents:false) can synthesize a chat row for a hidden seat whose
  // inventory row was never delivered but whose prompt-ask still arrived globally.
  openNotificationByStream: new Map<string, PentacleNotification>(),
};

function indexOpenQuestions(
  notifications: readonly PentacleNotification[],
  optimisticAnswers: readonly { notificationId: string; questionId?: string }[] = [],
) {
  const optimisticSignature = optimisticAnswers.map(
    (answer) => `${answer.notificationId}:${answer.questionId ?? ''}`,
  ).join('\n');
  if (notifications === openQuestionNotificationSource && optimisticSignature === openQuestionOptimisticSignature) {
    return openQuestionIndex;
  }
  const fullyPendingIds = fullyCoveredOptimisticQuestionNotificationIds(notifications, optimisticAnswers);
  const streamIds = new Set<string>();
  const actions = new Map<string, SmartQuestionAction[]>();
  const terminalByStream = new Map<string, PentacleNotification[]>();
  const pendingByStream = new Map<string, PentacleNotification[]>();
  const openNotificationByStream = new Map<string, PentacleNotification>();
  for (const notification of notifications) {
    if (!isAgentQuestionNotification(notification)) continue;
    const streamId = agentQuestionStreamId(notification);
    if (!streamId) continue;
    const open = isOpenAgentQuestionNotification(notification);
    if (open) {
      streamIds.add(streamId);
      if (!openNotificationByStream.has(streamId)) openNotificationByStream.set(streamId, notification);
    }
    if (fullyPendingIds.has(notification.notification_id)) {
      pendingByStream.set(streamId, [...(pendingByStream.get(streamId) ?? []), notification]);
      continue;
    }
    if (!open) {
      terminalByStream.set(streamId, [...(terminalByStream.get(streamId) ?? []), notification]);
      continue;
    }
    const model = durableQuestionCardModel(notification);
    if (!model) continue;
    const streamActions = actions.get(streamId) || [];
    streamActions.push({ kind: 'durable', id: notification.notification_id, model });
    actions.set(streamId, streamActions);
  }
  openQuestionNotificationSource = notifications;
  openQuestionOptimisticSignature = optimisticSignature;
  openQuestionIndex = { streamIds, actions, terminalByStream, pendingByStream, openNotificationByStream };
  return openQuestionIndex;
}

function openQuestionsForStream(
  durable: SmartQuestionAction[] | undefined,
  session: PentacleSessionSummary | undefined,
  chat: PentacleChatListItem,
  terminal: PentacleNotification[] | undefined,
  pending: PentacleNotification[] | undefined,
): SmartQuestionAction[] {
  if (durable?.length) return durable;
  if (!session?.question) return [];
  if (pending?.some((notification) => agentQuestionMatchesSessionQuestion(notification, session.question))) return [];
  if (terminal?.some((notification) => terminalAgentQuestionMatchesSessionQuestion(notification, session.question))) return [];
  return [{
    kind: 'legacy',
    id: `legacy:${chat.streamId}`,
    question: session.question,
    host: session.host,
    sessionName: session.session_name,
  }];
}

export function smartChatAttention(chat: Pick<SmartChatListItem, 'openQuestions'>) {
  return chat.openQuestions.length > 0;
}

// Priority arbitration for the one fixed CardAction footprint per card:
// question > unread report > caret. Pure so the matrix is exhaustively
// testable; callers feed authoritative daemon-derived counts only (native
// push unread must never reach this input).
export type CardAction =
  | { kind: 'question'; count: number; enabled: true }
  | { kind: 'report'; count: number; enabled: true }
  | { kind: 'caret'; enabled: boolean };

export function selectCardAction(input: {
  openQuestionItemCount: number;
  hasReports: boolean;
  reportUnreadCount: number;
  hasStatusCard: boolean;
}): CardAction {
  if (input.openQuestionItemCount > 0) {
    return { kind: 'question', count: input.openQuestionItemCount, enabled: true };
  }
  if (input.hasReports && input.reportUnreadCount > 0) {
    return { kind: 'report', count: input.reportUnreadCount, enabled: true };
  }
  return { kind: 'caret', enabled: input.hasStatusCard };
}

export function cardActionAccessibilityLabel(action: CardAction, expanded: boolean) {
  if (action.kind === 'question') {
    return `Answer ${action.count} question${action.count === 1 ? '' : 's'}`;
  }
  if (action.kind === 'report') {
    return `Open ${action.count} unread report${action.count === 1 ? '' : 's'}`;
  }
  if (!action.enabled) return 'No status available';
  return expanded ? 'Collapse chat row' : 'Expand chat row';
}

export function selectSmartChatList(
  state: PentacleStreamState,
  filter: 'all' | string = 'all',
  selectVisible: typeof selectVisibleChatList = selectVisibleChatList,
): SmartChatListItem[] {
  const harnessTiming = process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.hasAction(ALL_CHATS_HARNESS_ACTION);
  const startedAt = harnessTiming ? globalThis.performance.now() : 0;
  const optimisticAnswers = selectOptimisticQuestionAnswerIdentities(state);
  const questionIndex = indexOpenQuestions(
    state.notifications as PentacleNotification[],
    optimisticAnswers,
  );
  const eventIndex = indexSmartEvents(selectPentacleDerivedEventIndex(state).byStream);
  const sessionsByStream = new Map<string, PentacleSessionSummary>();
  for (const session of state.sessions) {
    sessionsByStream.set(session.stream_id, session);
  }
  const previousByStream = new Map((smartChatListCache.get(filter) || []).map((item) => [item.streamId, item]));
  const indexedAt = harnessTiming ? globalThis.performance.now() : 0;
  const visible = selectVisible(state, filter, optimisticAnswers);
  const visibleAt = harnessTiming ? globalThis.performance.now() : 0;
  const next = visible
    .map((chat) => {
      const machineName = machineNameFor(chat.host, chat.hostTitle);
      const session = sessionsByStream.get(chat.streamId);
      const candidate: SmartChatListItem = {
        ...chat,
        machineName,
        status_card: session?.status_card ?? null,
        context_tokens: session?.context_tokens ?? null,
        model_context_window: session?.model_context_window ?? null,
        context_level: session?.context_level ?? null,
        spec_issues: session?.spec_issues ?? null,
        pendingClose: (session as (PentacleSessionSummary & { pending_close?: PendingSessionClose }) | undefined)?.pending_close,
        role: session?.role ?? null,
        sessionGeneration: session?.session_generation ?? null,
        agents: session?.agents ?? [],
        openQuestions: openQuestionsForStream(
          questionIndex.actions.get(chat.streamId),
          session,
          chat,
          questionIndex.terminalByStream.get(chat.streamId),
          questionIndex.pendingByStream.get(chat.streamId),
        ),
        latestMessages: latestMessagesForStream(eventIndex.latestMessagesByStream, chat.streamId, chat.previewText),
        lastEventMs: Number.isFinite(Date.parse(session?.last_event_at || '')) ? Date.parse(session?.last_event_at || '') : 0,
      };
      const previous = previousByStream.get(candidate.streamId);
      return previous && sameSmartChatItem(previous, candidate) ? previous : candidate;
    })
    .sort((left, right) => {
      const leftTier = smartChatAttention(left) ? 0 : left.status === 'working' ? 1 : 2;
      const rightTier = smartChatAttention(right) ? 0 : right.status === 'working' ? 1 : 2;
      return leftTier - rightTier || right.lastEventMs - left.lastEventMs || left.streamId.localeCompare(right.streamId);
    });
  if (harnessTiming) {
    const finishedAt = globalThis.performance.now();
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
      kind: 'smart_list_selector_timing',
      index_ms: Math.round((indexedAt - startedAt) * 10) / 10,
      visible_ms: Math.round((visibleAt - indexedAt) * 10) / 10,
      decorate_sort_ms: Math.round((finishedAt - visibleAt) * 10) / 10,
      total_ms: Math.round((finishedAt - startedAt) * 10) / 10,
      events_count: state.events.length,
      row_count: next.length,
      event_revision: state.eventBucketMutationRevision ?? 0,
    });
  }
  const previous = smartChatListCache.get(filter);
  const value = previous && previous.length === next.length && previous.every((item, index) => item === next[index])
    ? previous
    : next;
  smartChatListCache.set(filter, value);
  return value;
}

function questionSignature(action: SmartQuestionAction) {
  const question = questionForAction(action);
  return [
    action.kind,
    action.id,
    question.header || '',
    question.prompt || '',
    (question.options || []).map((option) => `${option.index}:${option.label}:${option.meta ? 'meta' : ''}`).join('|'),
    (question.questions || []).map((item) => `${item.index}:${item.header || ''}:${item.prompt}:${(item.options || []).map((option) => `${option.index}:${option.label}:${option.meta ? 'meta' : ''}`).join(',')}`).join('|'),
  ].join('::');
}

function sameSmartChatItem(item: SmartChatListItem, other: SmartChatListItem | undefined) {
  return item === other || Boolean(other &&
      item.streamId === other.streamId &&
        item.host === other.host &&
        item.hostTitle === other.hostTitle &&
        item.provider === other.provider &&
        item.sessionName === other.sessionName &&
        item.title === other.title &&
        item.status === other.status &&
        item.statusLabel === other.statusLabel &&
        item.workingElapsedSeconds === other.workingElapsedSeconds &&
        item.sending === other.sending &&
        item.sendingImmediate === other.sendingImmediate &&
        item.previewText === other.previewText &&
        item.updatedLabel === other.updatedLabel &&
        item.machineName === other.machineName &&
        item.hostStatus === other.hostStatus &&
        item.hostStatusReason === other.hostStatusReason &&
        item.hostStatusSince === other.hostStatusSince &&
        item.status_card === other.status_card &&
        item.context_tokens === other.context_tokens &&
        item.model_context_window === other.model_context_window &&
        item.context_level === other.context_level &&
        item.spec_issues === other.spec_issues &&
        item.pendingClose === other.pendingClose &&
        item.role === other.role &&
        item.sessionGeneration === other.sessionGeneration &&
        item.agents === other.agents &&
        item.openQuestions.map(questionSignature).join('\n') === other.openQuestions.map(questionSignature).join('\n') &&
        item.latestMessages.join('\n') === other.latestMessages.join('\n'));
}

export function sameSmartChatItems(a: SmartChatListItem[], b: SmartChatListItem[]) {
  return a.length === b.length && a.every((item, index) => sameSmartChatItem(item, b[index]));
}

function PlusIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path
        d="M12 5v14M5 12h14"
        stroke={Tokens.palette.green}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export default function ChatsScreen() {
  const harnessComponentRenderCountRef = useRef(0);
  harnessComponentRenderCountRef.current += 1;
  const router = useRouter();
  const params = useLocalSearchParams<{ reportHarness?: string }>();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const harnessReady = harnessRuntime.useHarnessReady();
  const allChatsHarnessActive = process.env.EXPO_PUBLIC_HARNESS === '1' &&
    harnessReady && harnessRuntime.hasAction(ALL_CHATS_HARNESS_ACTION);
  const { token, isReady } = usePentacleToken();
  const actions = usePentacleStreamActions();
  const [filter, setFilter] = useState<'all' | string>('all');
  const [spawning, setSpawning] = useState<{ host: string; provider: ProviderId } | null>(null);
  const [summonVisible, setSummonVisible] = useState(false);
  const [spawnCatalog, setSpawnCatalog] = useState<SpawnCatalog | null>(null);
  const [spawnCatalogLoading, setSpawnCatalogLoading] = useState(false);
  const [spawnCatalogError, setSpawnCatalogError] = useState<string | null>(null);
  const [spawnSubmitError, setSpawnSubmitError] = useState<string | null>(null);
  const spawnCatalogRequestRef = useRef(0);
  const spawnCatalogConflictRefreshedRef = useRef(false);
  // `spawning` is React state, so it is stale for every tap that lands before its commit — which
  // is exactly the window the slow chats re-render opens. The synchronous ref is the guard that
  // actually holds; the state stays for rendering.
  // spec_example_2026_01.
  const spawnInFlightRef = useRef(false);
  const spawnIntentKeeperRef = useRef(createSpawnIntentKeeper());
  const [refreshing, setRefreshing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PentacleChatListItem | null>(null);
  const [expandedStreamId, setExpandedStreamId] = useState<string | null>(null);
  const [reportsStreamId, setReportsStreamId] = useState<string | null>(null);
  const [questionErrors, setQuestionErrors] = useState<Record<string, string | null>>({});
  const [questionRetryChats, setQuestionRetryChats] = useState<Record<string, SmartChatListItem>>({});
  const [questionSubmittingStreamIds, setQuestionSubmittingStreamIds] = useState<Set<string>>(() => new Set());
  const [swipeSettleToken, setSwipeSettleToken] = useState(0);
  const questionSubmittingStreamIdsRef = useRef<Set<string>>(new Set());
  const visibleStreamIdsRef = useRef<string[]>([]);
  const settlePrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollActiveRef = useRef(false);
  const chatsListRef = useRef<FlatList<SmartChatListItem>>(null);
  const harnessReadyEmittedRef = useRef(false);
  const pendingHarnessActionRef = useRef<(AllChatsHarnessActionRequest & { action_at_ms: number }) | null>(null);
  const [harnessCommitTick, setHarnessCommitTick] = useState(0);

  const harnessSources = usePentacleStreamSelectorWhen(
    allChatsHarnessActive && isFocused,
    (state) => ({
      sessions: state.sessions,
      eventBucketsByStream: state.eventBucketsByStream,
      eventBucketMutationRevision: state.eventBucketMutationRevision,
      notifications: state.notifications,
      drafts: state.drafts,
      workingStates: state.workingStates,
      workingByStream: state.workingByStream,
      optimisticSends: state.optimisticSends,
    }),
    (left, right) => left.sessions === right.sessions &&
      left.eventBucketsByStream === right.eventBucketsByStream &&
      left.eventBucketMutationRevision === right.eventBucketMutationRevision &&
      left.notifications === right.notifications &&
      left.drafts === right.drafts &&
      left.workingStates === right.workingStates &&
      left.workingByStream === right.workingByStream &&
      left.optimisticSends === right.optimisticSends,
  );
  const harnessStateRevisionRef = useRef(0);
  const harnessStateRevision = useMemo(() => {
    if (!allChatsHarnessActive) return 0;
    harnessStateRevisionRef.current += 1;
    return harnessStateRevisionRef.current;
  }, [
    allChatsHarnessActive,
    harnessSources.sessions,
    harnessSources.eventBucketsByStream,
    harnessSources.eventBucketMutationRevision,
    harnessSources.notifications,
    harnessSources.drafts,
    harnessSources.workingStates,
    harnessSources.workingByStream,
    harnessSources.optimisticSends,
  ]);

  const machines = usePentacleStreamSelectorWhen(isFocused, selectMachineStatusList, sameMachines);
  const chats = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => selectSmartChatList(
      allChatsHarnessActive
        ? { ...state, sessions: state.sessions.filter((session) => session.stream_id.startsWith('mock-host:freeze-')) }
        : state,
      filter,
    ),
    sameSmartChatItems,
  );
  const feed = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => ({
      connected: state.connected,
      connecting: state.connecting,
      hasHydrated: state.hasHydrated,
      lastError: state.lastError,
    }),
    (a, b) =>
      a.connected === b.connected &&
      a.connecting === b.connecting &&
      a.hasHydrated === b.hasHydrated &&
      a.lastError === b.lastError,
  );
  const activeMachines = machines.filter((machine) => machine.online);
  const canStartNewChat = Boolean(activeMachines.length && spawning === null);

  // Back at the list = every chat-open intent from the previous visit is stale.
  // This is the coordinator's release point and it runs in EVERY environment:
  // gating it to NODE_ENV==='test' is what let jest exercise a reset production
  // never performed, so a re-tap of an already-opened chat silently did nothing
  // (spec_example_2026_01). Focus (not
  // mount) is the signal: a rapid double-tap does not blur the list, so the
  // coordinator's in-flight suppression is untouched.
  useEffect(() => {
    if (!isFocused) return;
    resetChatOpenNavigationIntents();
  }, [isFocused]);

  useEffect(() => {
    if (isFocused) logFocusedTab('chats');
  }, [isFocused]);

  useEffect(() => {
    if (
      process.env.EXPO_PUBLIC_HARNESS !== '1' || !isFocused ||
      !harnessRuntime.hasAction('composite_chat_load_probe')
    ) return;
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
      kind: 'session_list_committed',
      timestamp_emitter_wall: Date.now(),
      stream_ids: chats.map((chat) => chat.streamId),
    });
  }, [chats, isFocused]);

  const scheduleSettledPrefetch = useCallback(() => {
    if (settlePrefetchTimerRef.current) {
      clearTimeout(settlePrefetchTimerRef.current);
      settlePrefetchTimerRef.current = null;
    }
    if (scrollActiveRef.current) return;
    settlePrefetchTimerRef.current = setTimeout(() => {
      settlePrefetchTimerRef.current = null;
      if (scrollActiveRef.current || !visibleStreamIdsRef.current.length) return;
      actions.prefetchSettledStreams(visibleStreamIdsRef.current, 'list-settle');
    }, 400);
  }, [actions]);

  useEffect(() => () => {
    if (settlePrefetchTimerRef.current) {
      clearTimeout(settlePrefetchTimerRef.current);
      settlePrefetchTimerRef.current = null;
    }
  }, []);

  const openChat = useCallback(
    (streamId: string) => {
      performChatOpenNavigation(
        streamId,
        {
          push: (href) => router.push(href as any),
          replace: (href) => router.replace(href as any),
        },
        () => setExpandedStreamId(null),
      );
    },
    [router],
  );

  const openRowReports = useCallback((streamId: string) => {
    setExpandedStreamId(null);
    setReportsStreamId(streamId);
  }, []);

  const openAgentThread = useCallback((parent: SmartChatListItem, child: ChildAgent) => {
    setExpandedStreamId(null);
    router.push({
      pathname: '/pentacle/session/[streamId]',
      params: {
        streamId: parent.streamId,
        openStatus: '1',
        agentHistory: child.stream_id,
        agentHistoryGeneration: child.session_generation,
      },
    } as any);
  }, [router]);

  // Deterministic reset: a row that leaves the visible list (filter change,
  // deletion, question resolution demotion) cannot keep a stale expansion.
  useEffect(() => {
    if (expandedStreamId && !chats.some((chat) => chat.streamId === expandedStreamId)) {
      setExpandedStreamId(null);
    }
  }, [chats, expandedStreamId]);

  const openChatStatus = useCallback((streamId: string) => {
    setExpandedStreamId(null);
    router.push({ pathname: '/pentacle/session/[streamId]', params: { streamId, openStatus: '1' } } as any);
  }, [router]);

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 65,
    minimumViewTime: 250,
  }).current;

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ item?: SmartChatListItem; isViewable?: boolean }> }) => {
    visibleStreamIdsRef.current = viewableItems
      .filter((item) => item.isViewable !== false)
      .map((item) => item.item?.streamId)
      .filter((streamId): streamId is string => typeof streamId === 'string' && streamId.length > 0);
    scheduleSettledPrefetch();
  }).current;

  const markScrollActive = useCallback(() => {
    scrollActiveRef.current = true;
    setSwipeSettleToken((current) => current + 1);
    if (settlePrefetchTimerRef.current) {
      clearTimeout(settlePrefetchTimerRef.current);
      settlePrefetchTimerRef.current = null;
    }
  }, []);

  const markScrollSettled = useCallback(() => {
    scrollActiveRef.current = false;
    scheduleSettledPrefetch();
  }, [scheduleSettledPrefetch]);

  const handleRowDelete = useCallback(
    (chat: DeletableChatListItem) => {
      if (chat.pendingClose) {
        const exhausted = chat.pendingClose.state === 'exhausted' || chat.pendingClose.state === 'failed';
        const showActionError = (error: unknown) => {
          Alert.alert('Pentacle', error instanceof Error ? error.message : 'Delete action failed');
        };
        Alert.alert(
          exhausted ? 'Delete stalled' : 'Delete pending',
          exhausted
            ? (chat.pendingClose.errorMessage || 'Automatic retries were exhausted. Choose how to continue.')
            : `${chat.title} will be removed when its active work finishes.`,
          exhausted
            ? [
              { text: 'Retry', onPress: () => void actions.retryPendingClose(chat.streamId).catch(showActionError) },
              { text: 'Cancel delete', style: 'cancel', onPress: () => void actions.cancelPendingClose(chat.streamId).catch(showActionError) },
              { text: 'Force delete', style: 'destructive', onPress: () => void actions.forcePendingClose(chat.streamId).catch(showActionError) },
            ]
            : [
              { text: 'Keep waiting', style: 'cancel' },
              { text: 'Cancel delete', onPress: () => void actions.cancelPendingClose(chat.streamId).catch(showActionError) },
              { text: 'Force delete', style: 'destructive', onPress: () => void actions.forcePendingClose(chat.streamId).catch(showActionError) },
            ],
        );
        return;
      }
      Alert.alert('Delete chat?', `Remove ${chat.title} from ${chat.hostTitle}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await actions.closeSession({
                host: chat.host,
                sessionName: chat.sessionName,
                streamId: chat.streamId,
              });
            } catch (error) {
              Alert.alert('Pentacle', error instanceof Error ? error.message : 'Failed to delete chat');
            }
          },
        },
      ]);
    },
    [actions],
  );

  const handleRowRename = useCallback((chat: PentacleChatListItem) => {
    setRenameTarget(chat);
  }, []);

  const submitRowRename = useCallback(
    async (value: string) => {
      const chat = renameTarget;
      setRenameTarget(null);
      if (!chat) return;
      const displayName = value.trim();
      if (!displayName || displayName === (chat.title || '').trim()) return;
      try {
        await actions.renameSession({
          host: chat.host,
          sessionName: chat.sessionName,
          displayName,
        });
      } catch (error) {
        Alert.alert('Pentacle', error instanceof Error ? error.message : 'Failed to rename chat');
      }
    },
    [actions, renameTarget],
  );

  const loadSpawnCatalog = useCallback(async () => {
    const request = ++spawnCatalogRequestRef.current;
    setSpawnCatalogLoading(true);
    setSpawnCatalogError(null);
    try {
      const catalog = validateSpawnCatalog(await actions.getSpawnCatalog());
      if (request !== spawnCatalogRequestRef.current) return;
      setSpawnCatalog(catalog);
    } catch (error) {
      if (request !== spawnCatalogRequestRef.current) return;
      setSpawnCatalog(null);
      setSpawnCatalogError(error instanceof Error ? error.message : 'Spawn catalog unavailable.');
    } finally {
      if (request === spawnCatalogRequestRef.current) setSpawnCatalogLoading(false);
    }
  }, [actions]);

  const handleSpawn = async (host: string, selection: {
    provider: ProviderId;
    model: string;
    effort: string;
    resolutionSource: 'profile_default' | 'explicit_override';
    objective: string;
  }) => {
    if (!spawnCatalog || spawnInFlightRef.current) return;
    spawnInFlightRef.current = true;
    const intentSelection = {
      host,
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort,
      catalogVersion: spawnCatalog.catalog_version,
    };
    try {
      const result = await executeSpawnIntent(
        spawnIntentKeeperRef.current,
        intentSelection,
        (idempotencyKey) => {
          setSpawnSubmitError(null);
          setSpawning({ host, provider: selection.provider });
          return actions.spawnSessionV2({
            host,
            provider: selection.provider,
            model: selection.model,
            effort: selection.effort,
            spawnProfile: 'desktop_manual',
            catalogVersion: spawnCatalog.catalog_version,
            resolutionSource: selection.resolutionSource,
            objective: selection.objective,
            idempotencyKey,
          });
        },
      );
      setSummonVisible(false);
      openChat(result.session.stream_id);
    } catch (error) {
      // A daemon-answered rejection is safe to retry under a fresh id; a transport or
      // indeterminate failure is not, because the chat may already exist.
      const message = error instanceof Error ? error.message : 'Failed to start session';
      setSpawnSubmitError(message);
      if ((error as { errorCode?: string })?.errorCode === 'spawn_catalog_version_conflict') {
        setSpawnCatalog(null);
        if (!spawnCatalogConflictRefreshedRef.current) {
          spawnCatalogConflictRefreshedRef.current = true;
          void loadSpawnCatalog();
        }
      }
    } finally {
      spawnInFlightRef.current = false;
      setSpawning(null);
    }
  };

  const handleStartNewChat = () => {
    if (spawnInFlightRef.current) return;
    spawnIntentKeeperRef.current.reset();
    if (!activeMachines.length) {
      Alert.alert('Pentacle', 'No live machines are available.');
      return;
    }
    spawnCatalogConflictRefreshedRef.current = false;
    setSpawnSubmitError(null);
    setSummonVisible(true);
    void loadSpawnCatalog();
  };

  const handleQuestionSubmit = useCallback(async (chat: SmartChatListItem, submissions: QuestionSubmission[]) => {
    if (questionSubmittingStreamIdsRef.current.has(chat.streamId)) return;
    questionSubmittingStreamIdsRef.current.add(chat.streamId);
    setQuestionErrors((prev) => ({ ...prev, [chat.streamId]: null }));
    setQuestionSubmittingStreamIds((current) => new Set(current).add(chat.streamId));
    try {
      for (const submission of submissions) {
        if (submission.action.kind === 'durable') {
          const action = submission.action;
          for (const [index, answer] of submission.answers.entries()) {
            const item = submission.items?.[index] || action.model.items[index];
            if (!item) throw new Error('Question is missing its durable resolver identity.');
            const resolution = buildDurableQuestionResolution(action.model, item, answer);
            const optimisticId = actions.beginOptimisticQuestionAnswer({
              streamId: chat.streamId,
              text: buildDurableQuestionAnswerText({
                notificationId: resolution.notification_id,
                actionKind: resolution.action_kind,
                ...(item.questionId ? { questionId: item.questionId } : {}),
                ...(resolution.text ? { text: resolution.text } : {}),
                ...(resolution.selections ? { selections: durableQuestionDisplaySelections(item, answer) } : {}),
                ...(resolution.custom_text ? { customText: resolution.custom_text } : {}),
                ...(resolution.note ? { note: resolution.note } : {}),
              }),
              notificationId: resolution.notification_id,
              ...(item.questionId ? { questionId: item.questionId } : {}),
            });
            if (!optimisticId) throw new Error('Question answer could not be queued. Try again.');
            setQuestionRetryChats((prev) => ({ ...prev, [chat.streamId]: chat }));
            try {
              if (!item.questionId) throw new Error('Question is missing its durable prompt identity.');
              await actions.answerPrompt({
                questionId: item.questionId,
                ...(resolution.selections ? { selections: resolution.selections } : {}),
                ...(resolution.text || resolution.custom_text || resolution.note
                  ? { text: resolution.text || resolution.custom_text || resolution.note }
                  : {}),
              });
              actions.queueOptimisticQuestionAnswer(optimisticId);
            } catch (error) {
              actions.discardOptimisticQuestionAnswer(optimisticId);
              if (String((error as { errorCode?: string })?.errorCode || '')) {
                setQuestionRetryChats((prev) => {
                  const next = { ...prev };
                  delete next[chat.streamId];
                  return next;
                });
              }
              throw error;
            }
          }
        } else {
          const keyedQuestion = submission.action.question as PentacleQuestion & { question_key?: string; questionKey?: string };
          const questionKey = String(keyedQuestion.question_key ?? keyedQuestion.questionKey ?? '');
          if (!questionKey) throw new Error('Question is missing its server key.');
          const answerText = buildPentacleQuestionAnswerText({
            question: submission.action.question,
            answers: submission.answers.map((answer) => (
              answer.customText && answer.selectedOptionIndex === undefined && !answer.selectedOptionIndices?.length
                ? { text: answer.customText }
                : answer
            )),
          });
          const optimisticId = actions.beginOptimisticQuestionAnswer({ streamId: chat.streamId, text: answerText });
          if (!optimisticId) throw new Error('Question answer could not be queued. Try again.');
          try {
            await actions.dismissQuestion({
              host: submission.action.host,
              sessionName: submission.action.sessionName,
              questionKey,
            });
          } catch (error) {
            if (String((error as { errorCode?: string })?.errorCode || '') !== 'stale_question') {
              actions.discardOptimisticQuestionAnswer(optimisticId);
              throw error;
            }
          }
          try {
            await actions.sendMessage({
              host: submission.action.host,
              sessionName: submission.action.sessionName,
              text: answerText,
              optimisticId,
            });
          } catch {
            setQuestionErrors((prev) => ({
              ...prev,
              [chat.streamId]: 'Answer could not be sent. Retry it from the chat transcript.',
            }));
          }
        }
      }
      setQuestionRetryChats((prev) => {
        if (!(chat.streamId in prev)) return prev;
        const next = { ...prev };
        delete next[chat.streamId];
        return next;
      });
      setExpandedStreamId(null);
    } catch (error) {
      setQuestionErrors((prev) => ({
        ...prev,
        [chat.streamId]: error instanceof Error ? error.message : 'Question answer could not be submitted.',
      }));
      throw error;
    } finally {
      setQuestionSubmittingStreamIds((current) => {
        const next = new Set(current);
        next.delete(chat.streamId);
        return next;
      });
      questionSubmittingStreamIdsRef.current.delete(chat.streamId);
    }
  }, [actions]);

  const handleRefresh = useCallback(async () => {
    try {
      setRefreshing(true);
      actions.reconnect();
    } finally {
      setTimeout(() => setRefreshing(false), 700);
    }
  }, [actions]);

  useEffect(() => {
    if (!allChatsHarnessActive || !isFocused || chats.length !== ALL_CHATS_HARNESS_SESSION_COUNT) {
      allChatsHarnessScreenReady = false;
      harnessReadyEmittedRef.current = false;
      return;
    }
    allChatsHarnessScreenReady = true;
    if (!harnessReadyEmittedRef.current) {
      harnessReadyEmittedRef.current = true;
      logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_READY as Parameters<typeof logTelemetry>[0], {
        state_revision: harnessStateRevision,
        row_count: chats.length,
        component_render_count: harnessComponentRenderCountRef.current,
      });
    }
    const unregister = registerAllChatsHarnessActionHandler(async (request) => {
      const actionAt = Date.now();
      pendingHarnessActionRef.current = { ...request, action_at_ms: actionAt };
      logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_ACTION_STARTED as Parameters<typeof logTelemetry>[0], {
        ...request,
        state_revision: harnessStateRevisionRef.current,
        action_at_ms: actionAt,
        component_render_count: harnessComponentRenderCountRef.current,
      });
      if (request.action === 'scroll') {
        chatsListRef.current?.scrollToOffset({ offset: Math.max(0, request.burst) * 96, animated: false });
      } else if (request.action === 'open_return') {
        const streamId = request.stream_id || chats[0]?.streamId;
        if (streamId) openChat(streamId);
        return;
      } else {
        await handleRefresh();
      }
      requestAnimationFrame(() => setHarnessCommitTick((value) => value + 1));
    });
    return () => {
      allChatsHarnessScreenReady = false;
      unregister();
    };
  }, [allChatsHarnessActive, isFocused, chats, handleRefresh, harnessStateRevision, openChat]);

  useEffect(() => {
    if (!allChatsHarnessActive || !isFocused) return;
    const pending = pendingHarnessActionRef.current;
    if (!pending) return;
    const unreadCount = chats.reduce((sum, item) => sum + reportUnreadCount(item.streamId), 0);
    const openQuestionCount = chats.reduce((sum, item) => sum + item.openQuestions.length, 0);
    if (!allChatsHarnessCommitMatches(pending, unreadCount, openQuestionCount)) return;
    pendingHarnessActionRef.current = null;
    const row = chats.find((item) => item.streamId === pending.stream_id) || chats[0];
    const committedAt = Date.now();
    const base = {
      action_id: pending.action_id,
      action: pending.action,
      burst: pending.burst,
      state_revision: harnessStateRevision,
      component_render_count: harnessComponentRenderCountRef.current,
    };
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_ROW_COMMITTED as Parameters<typeof logTelemetry>[0], {
      ...base,
      stream_id: row?.streamId || pending.stream_id || '',
      row_digest: allChatsHarnessRowDigest(chats),
      committed_at_ms: committedAt,
      newest_event_ms: Math.max(0, ...chats.map((item) => item.lastEventMs || 0)),
      unread_count: unreadCount,
      working: chats.filter((item) => item.status === 'working').length,
      open_question_count: openQuestionCount,
    });
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_ACTION_SETTLED as Parameters<typeof logTelemetry>[0], {
      ...base,
      settled_at_ms: Date.now(),
    });
  }, [allChatsHarnessActive, chats, harnessCommitTick, harnessStateRevision, isFocused]);

  const summonMachines: SummonMachine[] = useMemo(
    () => machines.map((machine) => ({ host: machine.host, title: machine.title, online: machine.online })),
    [machines],
  );
  const unresolvedActionCount = chats.reduce((count, chat) => count + chat.openQuestions.length, 0);

  const toggleChatRow = useCallback((streamId: string) => {
    setExpandedStreamId((current) => (current === streamId ? null : streamId));
  }, []);

  const prefetchChatRow = useCallback((streamId: string) => {
    actions.prefetchStreamEvents(streamId, 'press-in');
  }, [actions]);

  const renderChat = useCallback(
    ({ item: chat, index }: { item: SmartChatListItem; index: number }) => (
      <ChatRow
        chat={chat}
        index={index}
        expanded={expandedStreamId === chat.streamId}
        questionError={questionErrors[chat.streamId] ?? null}
        questionRetryChat={questionRetryChats[chat.streamId]}
        questionSubmitting={questionSubmittingStreamIds.has(chat.streamId)}
        swipeSettleToken={swipeSettleToken}
        onToggle={toggleChatRow}
        onOpen={openChat}
        onOpenStatus={openChatStatus}
        onOpenReports={openRowReports}
        onOpenAgentThread={openAgentThread}
        onRename={handleRowRename}
        onDelete={handleRowDelete}
        onPrefetchIntent={prefetchChatRow}
        onSubmitQuestions={handleQuestionSubmit}
      />
    ),
    [expandedStreamId, questionErrors, questionRetryChats, questionSubmittingStreamIds, swipeSettleToken, openAgentThread, openChat, openChatStatus, openRowReports, handleRowRename, handleRowDelete, handleQuestionSubmit, prefetchChatRow, toggleChatRow],
  );

  if (!isReady) {
    return (
      <View style={[styles.center, styles.container]}>
        <Starfield />
        <ActivityIndicator color={Tokens.palette.green} />
      </View>
    );
  }

  if (!token) {
    return (
      <View style={[styles.center, styles.container]}>
        <Starfield />
        <Text {...SELECTABLE_TEXT} style={styles.emptyBody}>
          Pentacle access is unavailable on this device.
        </Text>
      </View>
    );
  }

  const renderEmpty = () => {
    if (!feed.hasHydrated && (feed.connecting || !feed.lastError)) {
      return (
        <View style={styles.stateCard}>
          <Spinner />
          <Text {...SELECTABLE_TEXT} style={styles.loadingText}>
            SUMMONING CHATS…
          </Text>
        </View>
      );
    }
    if (feed.lastError) {
      return (
        <View style={styles.stateCard} testID="chats-unreachable">
          <Text {...SELECTABLE_TEXT} style={styles.emptyTitle}>
            tailnet unreachable
          </Text>
          <Text {...SELECTABLE_TEXT} style={styles.emptyBody}>
            {feed.lastError}
          </Text>
          <Pressable
            testID="chats-retry"
            onPress={handleRefresh}
            accessibilityRole="button"
            accessibilityLabel="Retry connection"
            style={styles.retryButton}
          >
            <Text {...SELECTABLE_TEXT} style={styles.retryButtonText}>RETRY</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.emptyCard}>
        <Text {...SELECTABLE_TEXT} style={styles.emptyGlyph}>
          ◌
        </Text>
        <Text {...SELECTABLE_TEXT} style={styles.emptyTitle}>
          No sessions yet
        </Text>
        <Text {...SELECTABLE_TEXT} style={styles.emptyBody}>
          Summon an agent on a live machine to begin a transcript.
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <Starfield />
      <View style={[styles.roster, { paddingTop: Math.max(insets.top, TOP_INSET) }]}>
        {MACHINE_ORDER.map((name) => {
          const machine = machines.find((item) => machineNameFor(item.host, item.title) === name);
          const online = Boolean(machine?.online);
          const selected = machine?.host === filter;
          const badge = machine ? offlineBadgeLabel({
            hostStatusReasonRaw: machine.hostStatusReason,
            hostStatusSinceRaw: machine.hostStatusSince,
          }) : null;
          return (
            <Pressable
              key={name}
              disabled={!machine}
              onPress={() => {
                if (!machine) return;
                setExpandedStreamId(null);
                setFilter(selected ? 'all' : machine.host);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${name}${badge ? ` ${badge.toLowerCase()}` : online ? ' online' : ' offline'}`}
              style={[styles.rosterButton, !online && styles.rosterButtonOffline, selected && styles.rosterButtonSelected]}
            >
              <ArcaneRingFrame machine={name} size={46} sigilSize={30} />
              {badge ? (
                <View testID={`agent-roster-offline-${name.toLowerCase()}`} style={styles.rosterOfflineBadge}>
                  <Text {...SELECTABLE_TEXT} style={styles.rosterOfflineBadgeText}>!</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.titleBar}>
        <Text {...SELECTABLE_TEXT} style={styles.screenTitle}>Agents</Text>
        {unresolvedActionCount > 0 ? (
          <View style={styles.actionCountPill} testID="chats-action-count">
            <View style={styles.actionCountDot} />
            <Text {...SELECTABLE_TEXT} style={styles.actionCountText}>{unresolvedActionCount}</Text>
          </View>
        ) : null}
      </View>

      <FlatList
        ref={chatsListRef}
        testID="chats-list"
        data={chats}
        keyExtractor={(item) => item.streamId}
        renderItem={renderChat}
        ListHeaderComponent={
          feed.lastError && chats.length > 0 ? (
            <Text {...SELECTABLE_TEXT} style={styles.errorText} testID="chats-error-banner">
              tailnet unreachable — pull to retry
            </Text>
          ) : null
        }
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 18) + 16 },
          chats.length === 0 && styles.emptyContent,
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Tokens.palette.green} />
        }
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        onScrollBeginDrag={markScrollActive}
        onMomentumScrollBegin={markScrollActive}
        onScrollEndDrag={markScrollSettled}
        onMomentumScrollEnd={markScrollSettled}
      />

      {expandedStreamId === null ? (
        <Pressable
          style={[
            styles.fab,
            { bottom: Math.max(insets.bottom, 12) + 72 },
            !canStartNewChat && styles.fabDisabled,
          ]}
          disabled={!canStartNewChat}
          onPress={handleStartNewChat}
          accessibilityLabel="Start agent"
          accessibilityRole="button"
          testID="new-chat-button"
        >
          {spawning ? <Spinner size={20} /> : <PlusIcon />}
        </Pressable>
      ) : null}

      <SummonModal
        visible={summonVisible}
        machines={summonMachines}
        catalog={spawnCatalog}
        catalogLoading={spawnCatalogLoading}
        catalogError={spawnCatalogError}
        submitting={spawning !== null}
        submitError={spawnSubmitError}
        onRetryCatalog={() => {
          spawnCatalogConflictRefreshedRef.current = false;
          void loadSpawnCatalog();
        }}
        onClose={() => {
          if (spawning) return;
          spawnCatalogRequestRef.current += 1;
          spawnIntentKeeperRef.current.reset();
          setSummonVisible(false);
        }}
        onPick={handleSpawn}
      />

      <RenameChatModal
        visible={renameTarget !== null}
        initialName={renameTarget?.title ?? ''}
        onSubmit={submitRowRename}
        onClose={() => setRenameTarget(null)}
      />

      {reportsStreamId || (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === '1' && params.reportHarness === '1') ? (
        <ReportViewerModal visible streamId={reportsStreamId || 'hosta:prediction-arb'} accent={MACHINES[machineNameFor(chats.find((chat) => chat.streamId === (reportsStreamId || 'hosta:prediction-arb'))?.host || '')].accent} onClose={() => setReportsStreamId(null)} />
      ) : null}
    </View>
  );
}

const SWIPE_ACTION_WIDTH = 64;

// One swipe action (icon only). Apple-style progressive reveal: each action
// slides in from the right as the row is dragged (translateX driven by the
// Swipeable `progress` 0→1), so they don't pop in fully on first touch and they
// retract in sync when the row closes. `offset` staggers the cascade — the
// rightmost action (smallest offset) leads.
function SwipeAction({
  progress,
  offset,
  onPress,
  testID,
  accessibilityLabel,
  icon,
  actionStyle,
}: {
  progress: Animated.AnimatedInterpolation<number>;
  offset: number;
  onPress: () => void;
  testID: string;
  accessibilityLabel: string;
  icon: 'pencil' | 'trash';
  actionStyle: object;
}) {
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [offset, 0],
    extrapolate: 'clamp',
  });
  return (
    <Animated.View style={[styles.swipeActionWrap, { transform: [{ translateX }] }]}>
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[styles.swipeAction, actionStyle]}
      >
        <FontAwesome name={icon} size={20} color={Tokens.palette.text} />
      </Pressable>
    </Animated.View>
  );
}

type ChatRowProps = {
  chat: StatusCardChatListItem | SmartChatListItem;
  index: number;
  expanded?: boolean;
  questionError?: string | null;
  questionRetryChat?: SmartChatListItem;
  questionSubmitting?: boolean;
  swipeSettleToken?: number;
  onOpen: (streamId: string) => void;
  onOpenStatus?: (streamId: string) => void;
  onOpenReports?: (streamId: string) => void;
  onOpenAgentThread?: (parent: SmartChatListItem, child: ChildAgent) => void;
  onRename: (chat: PentacleChatListItem) => void;
  onDelete: (chat: DeletableChatListItem) => void;
  onPrefetchIntent?: (streamId: string) => void;
  onToggle?: (streamId: string) => void;
  onSubmitQuestions?: (chat: SmartChatListItem, submissions: QuestionSubmission[]) => Promise<void>;
};

export function sameChatRowProps(left: ChatRowProps, right: ChatRowProps) {
  // NOTE: `index` is intentionally NOT compared. ChatRow never renders it, and
  // every inbound event re-sorts the list (a stream's lastEventMs bumps it up),
  // shifting the index of every row below. Comparing index re-rendered all those
  // rows for zero visible change — the O(n)-per-event reconcile that kept
  // all_chats set_state_ms over budget under burst load
  // (spec tap_shell_layout_regression_build_1155).
  return left.chat === right.chat
    && left.expanded === right.expanded
    && left.questionError === right.questionError
    && left.questionRetryChat === right.questionRetryChat
    && left.questionSubmitting === right.questionSubmitting
    && left.swipeSettleToken === right.swipeSettleToken
    && left.onOpen === right.onOpen
    && left.onOpenStatus === right.onOpenStatus
    && left.onOpenReports === right.onOpenReports
    && left.onOpenAgentThread === right.onOpenAgentThread
    && left.onRename === right.onRename
    && left.onDelete === right.onDelete
    && left.onPrefetchIntent === right.onPrefetchIntent
    && left.onToggle === right.onToggle
    && left.onSubmitQuestions === right.onSubmitQuestions;
}

export const ChatRow = memo(function ChatRow({
  chat,
  expanded = false,
  questionError = null,
  questionRetryChat,
  questionSubmitting = false,
  swipeSettleToken = 0,
  onOpen,
  onOpenStatus,
  onOpenReports,
  onOpenAgentThread,
  onToggle,
  onRename,
  onDelete,
  onPrefetchIntent,
  onSubmitQuestions,
}: ChatRowProps) {
  const displayChat = questionError && questionRetryChat ? questionRetryChat : chat;
  const smartChat = displayChat as Partial<SmartChatListItem>;
  const closeStatusLabel = smartChat.pendingClose
    ? (smartChat.pendingClose.state === 'exhausted' || smartChat.pendingClose.state === 'failed'
      ? 'Delete stalled — tap delete for options'
      : 'Delete pending — waiting for active work to finish')
    : null;
  const machineName = useMemo(
    () => smartChat.machineName ?? machineNameFor(chat.host, chat.hostTitle),
    [smartChat.machineName, chat.host, chat.hostTitle],
  );
  const machine = MACHINES[machineName];
  const working = chat.status === 'working';
  const fluidWorkingSeconds = useFluidWorkingSeconds(working ? chat.workingElapsedSeconds ?? null : null);
  const swipeRef = useRef<Swipeable>(null);
  const previousSwipeSettleTokenRef = useRef(swipeSettleToken);
  const swipeSettleReasonRef = useRef<'threshold' | 'parent_scroll' | 'action'>('threshold');
  const handleOpen = useCallback(() => onOpen(chat.streamId), [chat.streamId, onOpen]);
  const handlePressIn = useCallback(() => onPrefetchIntent?.(chat.streamId), [chat.streamId, onPrefetchIntent]);
  const openQuestions = smartChat.openQuestions ?? [];
  const openQuestionItemCount = openQuestions.reduce(
    (count, action) => count + mobileQuestionItems(questionForAction(action)).length,
    0,
  );
  const attention = openQuestions.length > 0;
  const hasStatusCard = hasSessionStatusCardContent(chat);
  const isNexus = smartChat.role === 'nexus';
  const childAgents = isNexus ? smartChat.agents ?? [] : [];
  const sessionReports = useSessionReports(chat.streamId);
  const action = selectCardAction({
    openQuestionItemCount: onSubmitQuestions ? openQuestionItemCount : 0,
    hasReports: sessionReports.length > 0,
    reportUnreadCount: reportUnreadCount(chat.streamId),
    hasStatusCard: hasStatusCard || isNexus,
  });
  const actionEnabled = action.kind === 'report' ? Boolean(onOpenReports) : action.enabled && Boolean(onToggle);
  // A report action has no inline expansion surface, so a row whose action
  // flips to report while expanded must not keep stale expanded styling.
  const actionExpanded = expanded && action.kind !== 'report' && !questionSubmitting;
  const submitQuestions = onSubmitQuestions;
  const handleAction = useCallback(() => {
    if (action.kind === 'report') {
      onOpenReports?.(chat.streamId);
      return;
    }
    onToggle?.(chat.streamId);
  }, [action.kind, chat.streamId, onOpenReports, onToggle]);
  const offlineBadge = offlineBadgeLabel({
    hostStatus: chat.hostStatus,
    hostStatusReason: chat.hostStatusReason,
    hostStatusSince: chat.hostStatusSince,
  });

  const handleRename = useCallback(() => {
    swipeSettleReasonRef.current = 'action';
    swipeRef.current?.close();
    onRename(chat);
  }, [chat, onRename]);

  const handleDelete = useCallback(() => {
    swipeSettleReasonRef.current = 'action';
    swipeRef.current?.close();
    onDelete(chat);
  }, [chat, onDelete]);

  const logSwipeSettled = useCallback((state: 'open' | 'closed', reason: 'threshold' | 'parent_scroll' | 'action') => {
    logTelemetry(MOBILE_TELEMETRY_EVENTS.CHAT_ROW_SWIPE_SETTLED as Parameters<typeof logTelemetry>[0], {
      stream_id: chat.streamId,
      subsystem: 'chat_list',
      bug_ref: 'swipe_action_snap',
      state,
      reason,
    });
  }, [chat.streamId]);

  useEffect(() => {
    if (previousSwipeSettleTokenRef.current === swipeSettleToken) return;
    previousSwipeSettleTokenRef.current = swipeSettleToken;
    swipeSettleReasonRef.current = 'parent_scroll';
    swipeRef.current?.close();
  }, [swipeSettleToken]);

  const renderRightActions = useCallback(
    (progress: Animated.AnimatedInterpolation<number>) => {
      const sid = chat.streamId.replace(/[^a-zA-Z0-9_-]/g, '-');
      return (
        <View style={styles.swipeActions}>
          <SwipeAction
            progress={progress}
            offset={SWIPE_ACTION_WIDTH * 2}
            testID={`chat-row-rename-${sid}`}
            accessibilityLabel={`Rename ${chat.title}`}
            onPress={handleRename}
            icon="pencil"
            actionStyle={styles.swipeRename}
          />
          <SwipeAction
            progress={progress}
            offset={SWIPE_ACTION_WIDTH}
            testID={`chat-row-delete-${sid}`}
            accessibilityLabel={`Delete ${chat.title}`}
            onPress={handleDelete}
            icon="trash"
            actionStyle={styles.swipeDelete}
          />
        </View>
      );
    },
    [chat.streamId, chat.title, handleRename, handleDelete],
  );

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      overshootRight={false}
      friction={2}
      rightThreshold={CHAT_ROW_SWIPE_OPEN_THRESHOLD}
      onSwipeableOpen={() => {
        swipeSettleReasonRef.current = 'threshold';
        logSwipeSettled('open', 'threshold');
      }}
      onSwipeableClose={() => {
        logSwipeSettled('closed', swipeSettleReasonRef.current);
        swipeSettleReasonRef.current = 'threshold';
      }}
      containerStyle={styles.swipeContainer}
    >
      <Bevel
        cut={12}
        fill={attention ? `${machine.accent}14` : 'rgba(255,255,255,0.018)'}
        stroke={attention ? `${machine.accent}55` : Tokens.palette.line}
        style={styles.chatBevel}
        contentStyle={styles.chatBevelContent}
      >
        <View>
          {attention ? <View testID={`chat-question-attention-bar-${chat.streamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`} style={[styles.attentionBar, { backgroundColor: machine.accent, shadowColor: machine.accent }]} /> : null}
          <View style={styles.chatRowShell}>
            <Pressable
              testID={testIdForStream(chat.streamId)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${chat.title}, ${closeStatusLabel || offlineBadge || chat.statusLabel}, ${chat.hostTitle}, ${chat.provider} · ${chat.updatedLabel}, ${chat.previewText}`}
              style={styles.chatRow}
              onPressIn={handlePressIn}
              onPress={handleOpen}
            >
              <ArcaneRingFrame machine={machineName} size={54} sigilSize={34} />
              <View style={styles.chatCopy}>
                <View style={styles.chatTitleRow}>
                  <StatusTag
                    status={chat.status === 'unresponsive' || working || chat.status === 'sending' ? chat.status : 'idle'}
                    elapsedSeconds={fluidWorkingSeconds}
                    sendingDelayMs={chat.sendingImmediate ? 0 : SESSION_SENDING_VISIBLE_AFTER_MS}
                  />
                  <Text {...SELECTABLE_TEXT} style={styles.chatTitle} numberOfLines={1}>
                    {chat.title}
                  </Text>
                </View>
                {!actionExpanded ? (
                  <Text {...SELECTABLE_TEXT} style={styles.chatPreview} numberOfLines={1}>
                    {closeStatusLabel || chat.previewText}
                  </Text>
                ) : null}
                <View style={styles.chatMetaRow}>
                  <MutedProviderLabel provider={chat.provider} />
                  {offlineBadge ? (
                    <View testID={`chat-row-offline-${chat.streamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`} style={styles.offlineBadge}>
                      <Text {...SELECTABLE_TEXT} style={styles.offlineBadgeText}>{offlineBadge}</Text>
                    </View>
                  ) : null}
                  <Text {...SELECTABLE_TEXT} style={styles.chatTime} numberOfLines={1}>
                    {chat.updatedLabel}
                  </Text>
                </View>
              </View>
            </Pressable>
            <Pressable
              onPress={actionEnabled ? handleAction : undefined}
              disabled={!actionEnabled}
              accessibilityRole="button"
              accessibilityState={actionEnabled ? undefined : { disabled: true }}
              accessibilityLabel={cardActionAccessibilityLabel(action, actionExpanded)}
              testID={`chat-row-toggle-${chat.streamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
              style={[styles.expandButton, attention && { borderColor: `${machine.accent}80`, backgroundColor: `${machine.accent}1c` }, actionExpanded && { borderColor: machine.accent, backgroundColor: `${machine.accent}1c` }]}
            >
              <Text {...SELECTABLE_TEXT} style={[styles.expandGlyph, actionExpanded && { color: machine.accent }]}>
                {action.kind === 'question' ? '?' : action.kind === 'report' ? '!' : actionExpanded ? 'x' : '⌄'}
              </Text>
              {action.kind === 'question' && action.count > 1 ? (
                <View style={[styles.questionBadge, { backgroundColor: machine.accent }]}>
                  <Text {...SELECTABLE_TEXT} style={styles.questionBadgeText}>{action.count}</Text>
                </View>
              ) : null}
              {action.kind === 'report' ? (
                <View testID={`chat-row-report-badge-${chat.streamId.replace(/[^a-zA-Z0-9_-]/g, '-')}`} style={[styles.questionBadge, { backgroundColor: machine.accent }]}>
                  <Text {...SELECTABLE_TEXT} style={styles.questionBadgeText}>{action.count}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
          {expanded && submitQuestions && (action.kind === 'question' || (questionSubmitting && questionRetryChat)) ? (
            <View style={[styles.expandedPanel, questionSubmitting && { display: 'none' }]}>
              <QuestionPanel
                chat={(action.kind === 'question' ? displayChat : questionRetryChat) as SmartChatListItem}
                accent={machine.accent}
                error={questionError}
                onSubmit={submitQuestions}
              />
            </View>
          ) : null}
          {actionExpanded && action.kind === 'caret' && action.enabled ? (
            <View style={styles.expandedPanel}>
              {childAgents.length ? <ChildAgentRows parent={smartChat as SmartChatListItem} agents={childAgents} onOpenThread={onOpenAgentThread} /> : null}
              {chat.status_card ? <CardStatusMini session={chat} card={chat.status_card} onOpen={onOpenStatus ?? onOpen} /> : null}
              {isNexus && !hasStatusCard ? (
                <Text testID={`nexus-status-unavailable-${agentRowId(chat.streamId)}`} {...SELECTABLE_TEXT} style={styles.threadModalEmpty}>
                  No current Nexus status card.
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Bevel>
    </Swipeable>
  );
}, sameChatRowProps);

function agentRowId(streamId: string) {
  return streamId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function ChildAgentRows({
  parent,
  agents,
  onOpenThread,
}: {
  parent: SmartChatListItem;
  agents: readonly ChildAgent[];
  onOpenThread?: (parent: SmartChatListItem, child: ChildAgent) => void;
}) {
  return (
    <View testID={`agent-status-rows-${agentRowId(parent.streamId)}`} style={styles.agentRows}>
      <Text {...SELECTABLE_TEXT} style={styles.agentRowsTitle}>CHILD AGENTS</Text>
      {agents.map((agent) => {
        const id = agentRowId(agent.stream_id);
        return (
          <View key={`${agent.stream_id}:${agent.session_generation}`} testID={`agent-status-row-${id}`} style={styles.agentStatusRow}>
            <View style={styles.agentStatusCopy}>
              <Text {...SELECTABLE_TEXT} style={styles.agentStatusName} numberOfLines={1}>{agent.display_name}</Text>
              <Text {...SELECTABLE_TEXT} style={styles.agentStatusMeta} numberOfLines={1}>{agent.state.toUpperCase()} · {agent.role || 'agent'}</Text>
              {agent.objective ? <Text {...SELECTABLE_TEXT} style={styles.agentStatusObjective} numberOfLines={2}>{agent.objective}</Text> : null}
            </View>
            <Pressable
              testID={`agent-thread-open-${id}`}
              accessibilityRole="button"
              accessibilityLabel={`Open history for ${agent.display_name}`}
              onPress={() => onOpenThread?.(parent, agent)}
              style={styles.agentHistoryButton}
            >
              <Text {...SELECTABLE_TEXT} style={styles.agentHistoryButtonText}>HISTORY</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

// Memoized: an SVG icon + label that depends only on `provider`, which never
// changes on a message update — skip its re-render under burst load
// (spec tap_shell_layout_regression_build_1155 slice 2b).
const MutedProviderLabel = memo(function MutedProviderLabel({ provider }: { provider: string }) {
  const normalized = String(provider).toLowerCase();
  const isClaude = normalized === 'claude';
  return (
    <View style={styles.providerMuted}>
      {isClaude ? <Spark size={11} color={Tokens.palette.muted} /> : <Brackets size={11} color={Tokens.palette.muted} />}
      <Text {...SELECTABLE_TEXT} style={styles.providerMutedText}>{isClaude ? 'Claude' : 'Codex'}</Text>
    </View>
  );
});

function questionForAction(action: SmartQuestionAction) {
  return action.kind === 'durable' ? action.model.question : action.question;
}

function QuestionPanel({
  chat,
  accent,
  error,
  onSubmit,
}: {
  chat: SmartChatListItem;
  accent: string;
  error: string | null;
  onSubmit: (chat: SmartChatListItem, submissions: QuestionSubmission[]) => Promise<void>;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const entries = useMemo<MobileQuestionEntry<SmartQuestionAction>[]>(() => chat.openQuestions.flatMap((action) => {
    const parent = questionForAction(action);
    return mobileQuestionItems(parent).map((question, itemIndex) => ({
      key: `${action.id}:${itemIndex}`,
      question,
      source: action,
      locked: !!(parent.scan_incomplete && question.index !== Number(parent.active_index || 0)),
    }));
  }), [chat.openQuestions]);
  const flow = useMobileQuestionFlow(entries);
  const clampedIndex = Math.min(activeIndex, Math.max(0, entries.length - 1));

  useEffect(() => {
    if (activeIndex !== clampedIndex) setActiveIndex(clampedIndex);
  }, [activeIndex, clampedIndex]);

  const submit = async () => {
    if (!flow.allAnswered || submitting) return;
    setSubmitting(true);
    try {
      const submissions = chat.openQuestions.map((action) => ({
        action,
        ...(action.kind === 'durable' ? { items: action.model.items } : {}),
        answers: entries
          .filter((entry) => entry.source.id === action.id)
          .map((entry) => flow.answerFor(entry)),
      }));
      await onSubmit(chat, submissions);
    } catch {
      // The parent owns the visible error and keeps this card expanded for retry.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View testID={`question-panel-${chat.streamId}`}>
      <QuestionCardSurface
        entries={entries}
        activeIndex={clampedIndex}
        flow={flow}
        accent={accent}
        submitting={submitting}
        error={error}
        onIndexChange={setActiveIndex}
        onSend={() => { void submit(); }}
      />
    </View>
  );
}
function sameMachines(a: PentacleMachineCard[], b: PentacleMachineCard[]) {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return (
        item.host === other.host &&
        item.title === other.title &&
        item.online === other.online &&
        item.sessionCount === other.sessionCount &&
        item.statusLabel === other.statusLabel &&
        item.error === other.error
      );
    })
  );
}

function sameChatItems(a: PentacleChatListItem[], b: PentacleChatListItem[]) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Tokens.palette.ink,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  roster: {
    position: 'relative',
    zIndex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Tokens.palette.line,
  },
  rosterButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 1,
  },
  rosterButtonOffline: {
    opacity: 0.42,
  },
  rosterButtonSelected: {
    transform: [{ scale: 1.08 }],
  },
  rosterOfflineBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 16,
    height: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Tokens.palette.ink,
    backgroundColor: Tokens.palette.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rosterOfflineBadgeText: {
    color: Tokens.palette.ink,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 11,
    lineHeight: 13,
  },
  titleBar: {
    position: 'relative',
    zIndex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: SCREEN_PAD,
    paddingTop: 12,
    paddingBottom: 4,
  },
  screenTitle: {
    color: Tokens.palette.text,
    fontFamily: Fonts.cinzel.bold,
    fontSize: 24,
    lineHeight: 28,
  },
  actionCountPill: {
    marginLeft: 'auto',
    minWidth: 32,
    height: 24,
    paddingHorizontal: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Tokens.palette.green,
    backgroundColor: `${Tokens.palette.green}1c`,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionCountDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: Tokens.palette.green,
  },
  actionCountText: {
    color: Tokens.palette.green,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 12,
    lineHeight: 14,
  },
  content: {
    position: 'relative',
    zIndex: 1,
    paddingHorizontal: SCREEN_PAD,
    paddingTop: 14,
    gap: 12,
  },
  emptyContent: {
    flexGrow: 1,
  },
  errorText: {
    color: Tokens.palette.red,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 14,
    lineHeight: 18,
  },
  stateCard: {
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    backgroundColor: Tokens.palette.panel,
    padding: 22,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
    letterSpacing: 1,
  },
  emptyCard: {
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    backgroundColor: Tokens.palette.panel,
    paddingHorizontal: 20,
    paddingVertical: 32,
    alignItems: 'center',
    gap: 12,
  },
  emptyGlyph: {
    fontSize: 30,
    color: Tokens.palette.muted,
  },
  emptyTitle: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 20,
  },
  emptyBody: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 280,
  },
  fab: {
    position: 'absolute',
    zIndex: 3,
    right: 18,
    width: 54,
    height: 54,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${Tokens.palette.green}1c`,
    borderWidth: 1,
    borderColor: Tokens.palette.green,
  },
  fabDisabled: {
    opacity: 0.45,
  },
  swipeContainer: {
    borderRadius: 12,
  },
  swipeActions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    width: SWIPE_ACTION_WIDTH * 2,
  },
  swipeActionWrap: {
    width: SWIPE_ACTION_WIDTH,
    height: '100%',
  },
  swipeAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeRename: {
    backgroundColor: `${Tokens.palette.green}33`,
  },
  swipeDelete: {
    backgroundColor: `${Tokens.palette.red}33`,
  },
  chatBevel: {
    minHeight: 82,
  },
  chatBevelContent: {
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  attentionBar: {
    position: 'absolute',
    // Bevel content is inset by 14px; offset back to the card edge so the
    // question accent never overlaps the machine sigil.
    left: -14,
    top: 9,
    bottom: 9,
    width: 3,
    borderRadius: 0,
    shadowOpacity: 0.9,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 0 },
  },
  chatRowShell: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  chatRow: {
    flexDirection: 'row',
    gap: 13,
    flex: 1,
    minWidth: 0,
  },
  chatCopy: {
    flex: 1,
    minWidth: 0,
  },
  chatTitle: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 17.5,
    lineHeight: 21,
    color: Tokens.palette.text,
    letterSpacing: 0,
    flex: 1,
    minWidth: 0,
  },
  chatTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  chatMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 7,
    minWidth: 0,
  },
  chatTime: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 10,
    letterSpacing: 1,
    flexShrink: 1,
  },
  offlineBadge: {
    height: 19,
    paddingHorizontal: 7,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.amber,
    backgroundColor: `${Tokens.palette.amber}1c`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  offlineBadgeText: {
    color: Tokens.palette.amber,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 9,
    lineHeight: 11,
    letterSpacing: 0,
  },
  chatPreview: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 12.5,
    lineHeight: 18.75,
    marginTop: 7,
  },
  providerMuted: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
  },
  providerMutedText: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: Tokens.type.meta,
    letterSpacing: 0,
  },
  expandButton: {
    position: 'relative',
    width: 30,
    height: 30,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  expandGlyph: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 17,
    lineHeight: 19,
  },
  retryButton: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.green,
  },
  retryButtonText: {
    color: Tokens.palette.green,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 12,
    letterSpacing: 2,
  },
  questionBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  questionBadgeText: {
    color: Tokens.palette.ink,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 9,
    lineHeight: 11,
  },
  expandedPanel: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: Tokens.palette.line,
    paddingTop: 12,
  },
  agentRows: {
    gap: 8,
  },
  agentRowsTitle: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  agentStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    borderRadius: 5,
    padding: 10,
  },
  agentStatusCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  agentStatusName: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 15,
  },
  agentStatusMeta: {
    color: Tokens.palette.green,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 9,
  },
  agentStatusObjective: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 12,
    lineHeight: 16,
  },
  agentHistoryButton: {
    borderWidth: 1,
    borderColor: Tokens.palette.green,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  agentHistoryButtonText: {
    color: Tokens.palette.green,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 9,
    letterSpacing: 0.7,
  },
  threadModalScrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  threadModalCard: {
    maxHeight: '76%',
    gap: 12,
    padding: 18,
    borderTopWidth: 1,
    borderColor: Tokens.palette.green,
    backgroundColor: Tokens.palette.ink,
  },
  threadModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  threadModalTitleCopy: {
    flex: 1,
    minWidth: 0,
  },
  threadModalEyebrow: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 10,
    letterSpacing: 1.1,
  },
  threadModalTitle: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 21,
  },
  threadModalClose: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    borderRadius: 4,
  },
  threadModalCloseText: {
    color: Tokens.palette.text,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 20,
  },
  threadModalError: {
    color: Tokens.palette.red,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14,
  },
  threadModalEmpty: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14,
  },
  threadExchangeRow: {
    gap: 4,
    borderLeftWidth: 2,
    borderLeftColor: Tokens.palette.green,
    paddingLeft: 9,
  },
  threadExchangeMeta: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 9,
  },
  threadExchangeText: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 15,
    lineHeight: 20,
  },
  panelRoot: {
    gap: 10,
  },
  questionStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  questionStepDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Tokens.palette.muted,
  },
  questionStepText: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10,
  },
  questionBlock: {
    gap: 8,
  },
  questionBlockLocked: {
    opacity: 0.5,
  },
  questionPrompt: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 15,
    lineHeight: 19,
  },
  questionOption: {
    minHeight: 38,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Tokens.palette.muted,
  },
  questionOptionText: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 14,
    lineHeight: 18,
    flex: 1,
  },
  questionConstraint: {
    color: Tokens.palette.amber,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 11,
    lineHeight: 14,
  },
  panelInput: {
    minHeight: 38,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    color: Tokens.palette.text,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  panelError: {
    color: Tokens.palette.red,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 13,
    lineHeight: 17,
  },
  panelSubmit: {
    height: 38,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelSubmitDisabled: {
    opacity: 0.55,
  },
  panelSubmitText: {
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 12,
    lineHeight: 14,
    letterSpacing: 0,
  },
});
