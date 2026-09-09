import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  selectUnifiedFeed,
  latestDisplayedSessionPreview,
  selectPentacleDerivedEventIndex,
  TELEMETRY_EVENTS,
  type ChatAttachment,
  type PentacleEvent,
  type PentacleNotification,
  type PentacleQuestionAnswerValue,
  type PentacleSessionSummary,
  type PentacleStreamState,
  type PentacleUnifiedFeedItem,
} from 'pentacle-chat-core';
import { Fonts, SCREEN_PAD, Tokens } from '@/constants/Colors';
import Bevel from '../../src/components/Bevel';
import Starfield from '../../src/components/Starfield';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import {
  usePentacleStreamActions,
  usePentacleStreamSelectorWhen,
} from '../../src/services/pentacleStream';
import { selectDefaultVisibleSessions } from '../../src/services/sessionVisibility';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';
import { logTelemetry } from 'pentacle-chat-core';
import {
  ComposerBar,
  hostChrome,
  type HostChrome,
} from '../pentacle/session/[streamId]';
import { settleUploadLeg, withRenderUris, type StagedUpload } from '../../src/services/optimisticSendUnit';
import {
  mobileQuestionItems,
  QuestionCardSurface,
  useMobileQuestionFlow,
  type MobileQuestionEntry,
} from '../../src/components/MobileQuestions';
import type { RenderAttachment } from '../../src/types/renderAttachment';
import {
  agentQuestionStreamId,
  durableQuestionCardModel,
  isAgentQuestionNotification,
  type DurableQuestionCardModel,
} from '../../src/services/agentQuestionNotifications';

type UnifiedAgentRow = PentacleUnifiedFeedItem & { rowType: 'agent' };
type UnifiedUserRow = {
  rowType: 'user';
  id: string;
  streamId: string;
  host: string;
  hostTitle: string;
  provider: string;
  sessionName: string;
  chatTitle: string;
  accent: string;
  timestampLabel: string;
  text: string;
  event: PentacleEvent;
};
type UnifiedRow = UnifiedAgentRow | UnifiedUserRow;
type UnifiedMessageGroup = {
  id: string;
  streamId: string;
  host: string;
  hostTitle: string;
  provider: string;
  sessionName: string;
  chatTitle: string;
  accent: string;
  timestampLabel: string;
  rows: UnifiedRow[];
  replyRow: UnifiedAgentRow | null;
};
type UnifiedQuestionItem = {
  id: string;
  streamId: string;
  chatTitle: string;
  accent: string;
  chrome: HostChrome;
  model: DurableQuestionCardModel;
};

type DurableQuestionAnswer = PentacleQuestionAnswerValue & {
  customText?: string;
};

type UnifiedSlice = {
  rows: UnifiedRow[];
  questions: UnifiedQuestionItem[];
  sessionsByStream: Record<string, PentacleSessionSummary>;
  workingPhasesByStream: Record<string, string>;
  connected: boolean;
  hasHydrated: boolean;
};

function streamPath(streamId: string) {
  return `/pentacle/session/${encodeURIComponent(streamId)}` as const;
}

function eventMs(event: PentacleEvent) {
  const ms = Date.parse(String(event.timestamp || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function formatClock(timestamp?: string) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sameRows(left: UnifiedRow[], right: UnifiedRow[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return (
      other &&
      item.rowType === other.rowType &&
      item.id === other.id &&
      item.text === other.text &&
      item.timestampLabel === other.timestampLabel &&
      item.chatTitle === other.chatTitle &&
      item.accent === other.accent
    );
  });
}

function sameQuestions(left: UnifiedQuestionItem[], right: UnifiedQuestionItem[]) {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && item.id === other.id && item.streamId === other.streamId && item.chatTitle === other.chatTitle;
  });
}

function sameUnifiedSlice(left: UnifiedSlice, right: UnifiedSlice) {
  return (
    left.connected === right.connected &&
    left.hasHydrated === right.hasHydrated &&
    sameRows(left.rows, right.rows) &&
    sameQuestions(left.questions, right.questions) &&
    Object.keys(left.workingPhasesByStream).length === Object.keys(right.workingPhasesByStream).length &&
    Object.entries(left.workingPhasesByStream).every(([streamId, phase]) => right.workingPhasesByStream[streamId] === phase)
  );
}

function notificationMs(notification: PentacleNotification) {
  const ms = Date.parse(String(notification.created_at || notification.updated_at || ''));
  return Number.isFinite(ms) ? ms : 0;
}

export function selectQuestionItems(
  notifications: readonly PentacleNotification[],
  sessionsByStream: Record<string, PentacleSessionSummary>,
): UnifiedQuestionItem[] {
  return notifications.flatMap((notification) => {
    if (!isAgentQuestionNotification(notification)) return [];
    if (notification.state !== 'open' || notification.question?.state !== 'open') return [];
    const model = durableQuestionCardModel(notification);
    if (!model) return [];
    const streamId = agentQuestionStreamId(notification);
    if (!streamId) return [];
    // Under a narrowed subscription (include_subagents:false) a hidden seat's session row
    // is absent, but its question notification still arrives globally. Render from the
    // notification, falling back to its title / the stream id for display chrome.
    const session = sessionsByStream[streamId];
    const host = session?.host || streamId.split(':')[0] || '';
    const chrome = hostChrome(host);
    return [{
      id: notification.notification_id,
      streamId,
      chatTitle: session?.title || session?.display_name || session?.session_name || notification.title || streamId,
      accent: chrome.accent,
      chrome,
      model,
    }];
  }).sort((left, right) => {
    const delta = notificationMs(left.model.notification) - notificationMs(right.model.notification);
    return delta || left.id.localeCompare(right.id);
  });
}

function questionSelections(model: DurableQuestionCardModel, answers: DurableQuestionAnswer[]) {
  const answer = answers[0] || {};
  const selectedIndices = Array.isArray(answer.selectedOptionIndices)
    ? answer.selectedOptionIndices
    : (typeof answer.selectedOptionIndex === 'number' ? [answer.selectedOptionIndex] : []);
  return selectedIndices
    .map((index) => model.optionValues.get(index))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function questionNote(answers: DurableQuestionAnswer[]) {
  const note = answers[0]?.note;
  return typeof note === 'string' && note.trim() ? note : undefined;
}

function selectUnifiedSlice(state: PentacleStreamState): UnifiedSlice {
  const visibleSessions = selectDefaultVisibleSessions(state.sessions);
  const sessionsByStream = Object.fromEntries(state.sessions.map((session) => [session.stream_id, session]));
  const visibleSessionsByStream = Object.fromEntries(visibleSessions.map((session) => [session.stream_id, session]));
  const visibleState = { ...state, sessions: visibleSessions };
  const derivedIndex = selectPentacleDerivedEventIndex(state);
  const agentRows: UnifiedRow[] = selectUnifiedFeed(visibleState).map((item) => ({ ...item, rowType: 'agent' }));
  const userRows: UnifiedRow[] = derivedIndex.chronological.flatMap((event) => {
    if (event.kind !== 'USER' || !event.client_origin) return [];
    const session = visibleSessionsByStream[event.stream_id];
    if (!session) return [];
    const chrome = hostChrome(session.host);
    return [{
      rowType: 'user',
      id: `user:${event.optimistic_id || event.stream_id}:${event.daemon_seq}:${event.timestamp}`,
      streamId: event.stream_id,
      host: session.host,
      hostTitle: chrome.title,
      provider: session.provider.toUpperCase(),
      sessionName: session.session_name,
      chatTitle: session.title || session.display_name || session.session_name,
      accent: chrome.accent,
      timestampLabel: formatClock(event.timestamp),
      text: event.text,
      event,
    }];
  });
  const retainedStreamIds = new Set(derivedIndex.byStream.keys());
  const summaryRows: UnifiedRow[] = visibleSessions.flatMap((session) => {
    if (retainedStreamIds.has(session.stream_id) || !session.last_event_at) return [];
    const text = latestDisplayedSessionPreview(visibleState, session, '');
    if (!text) return [];
    const chrome = hostChrome(session.host);
    const event: PentacleEvent = {
      daemon_seq: Number.NaN,
      host: session.host,
      provider: session.provider,
      session_id: session.stream_id,
      session_name: session.session_name,
      stream_id: session.stream_id,
      timestamp: session.last_event_at,
      kind: 'ASSIST',
      text,
    };
    return [{
      rowType: 'agent',
      id: `summary:${session.stream_id}:${session.last_event_at}`,
      streamId: session.stream_id,
      host: session.host,
      hostTitle: chrome.title,
      provider: session.provider.toUpperCase(),
      sessionName: session.session_name,
      chatTitle: session.title || session.display_name || session.session_name,
      accent: chrome.accent,
      timestampLabel: formatClock(session.last_event_at),
      text,
      kind: event.kind,
      event,
    }];
  });
  const rows = [...agentRows, ...userRows, ...summaryRows].sort((left, right) => {
    const delta = eventMs(left.event) - eventMs(right.event);
    if (delta !== 0) return delta;
    return left.id.localeCompare(right.id);
  });
  return {
    rows,
    questions: selectQuestionItems(state.notifications, sessionsByStream),
    sessionsByStream,
    workingPhasesByStream: Object.fromEntries(
      Object.entries(state.workingByStream || {}).map(([streamId, turn]) => [streamId, turn.phase]),
    ),
    connected: state.connected,
    hasHydrated: Boolean(state.hasHydrated),
  };
}

function labelsForRows(rows: UnifiedRow[]) {
  const labels: string[] = [];
  for (const row of rows) {
    if (row.timestampLabel && !labels.includes(row.timestampLabel)) {
      labels.push(row.timestampLabel);
    }
  }
  return labels.join(' · ');
}

function groupUnifiedRows(rows: UnifiedRow[]): UnifiedMessageGroup[] {
  const groups: UnifiedMessageGroup[] = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    const replyRow = row.rowType === 'agent' ? row : null;
    if (current && current.streamId === row.streamId) {
      current.rows.push(row);
      current.timestampLabel = labelsForRows(current.rows);
      if (replyRow) current.replyRow = replyRow;
      continue;
    }
    groups.push({
      id: `group:${row.id}`,
      streamId: row.streamId,
      host: row.host,
      hostTitle: row.hostTitle,
      provider: row.provider,
      sessionName: row.sessionName,
      chatTitle: row.chatTitle,
      accent: row.accent,
      timestampLabel: row.timestampLabel,
      rows: [row],
      replyRow,
    });
  }
  return groups;
}

function MessageGroupBubble({
  group,
  selected,
  onReply,
  onOpen,
}: {
  group: UnifiedMessageGroup;
  selected: boolean;
  onReply: (row: UnifiedAgentRow) => void;
  onOpen: (streamId: string) => void;
}) {
  const isUserOnly = group.rows.every((row) => row.rowType === 'user');
  const fill = isUserOnly ? `${group.accent}22` : `${group.accent}18`;
  const stroke = selected ? group.accent : `${group.accent}66`;
  return (
    <View style={[styles.messageRow, isUserOnly && styles.userMessageRow]}>
      <Bevel cut={8} fill={fill} stroke={stroke} style={styles.messageBubble} contentStyle={styles.messageContent}>
        <View style={styles.messageHeader}>
          <View style={styles.titleWrap}>
            <Text style={[styles.chatTitle, { color: group.accent }]} numberOfLines={1}>
              {group.chatTitle}
            </Text>
            <Text style={styles.messageMeta} numberOfLines={2}>
              {group.hostTitle} · {group.provider}{group.timestampLabel ? ` · ${group.timestampLabel}` : ''}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${group.chatTitle}`}
              testID={`unified-open-${group.streamId}`}
              style={styles.iconButton}
              onPress={() => onOpen(group.streamId)}
              hitSlop={8}
            >
              <FontAwesome name="external-link" size={13} color={Tokens.palette.text} />
            </Pressable>
            {group.replyRow ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reply to ${group.chatTitle}`}
                testID={`unified-reply-${group.streamId}`}
                style={[styles.iconButton, selected && { borderColor: group.accent }]}
                onPress={() => group.replyRow && onReply(group.replyRow)}
                hitSlop={8}
              >
                <FontAwesome name="reply" size={13} color={group.accent} />
              </Pressable>
            ) : null}
          </View>
        </View>
        {group.rows.map((row) => (
          <Text key={row.id} selectable style={row.rowType === 'user' ? styles.userMessageText : styles.messageText}>
            {row.text || (row.rowType === 'user' ? 'Sent' : '')}
          </Text>
        ))}
      </Bevel>
    </View>
  );
}

function QuestionsDrawer({
  visible,
  questions,
  submittingId,
  submitErrors,
  onClose,
  onOpenChat,
  onSubmit,
}: {
  visible: boolean;
  questions: UnifiedQuestionItem[];
  submittingId: string | null;
  submitErrors: Record<string, string | null | undefined>;
  onClose: () => void;
  onOpenChat: (streamId: string) => void;
  onSubmit: (item: UnifiedQuestionItem, answers: PentacleQuestionAnswerValue[]) => void;
}) {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.drawerBackdrop} onPress={onClose} />
      <View style={styles.drawer}>
        <View style={styles.drawerHandle} />
        <View style={styles.drawerHeader}>
          <Text style={styles.drawerTitle}>Pending Questions</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close questions" onPress={onClose} hitSlop={10}>
            <FontAwesome name="close" size={18} color={Tokens.palette.text} />
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.drawerScroll}>
          {questions.map((item) => (
            <View key={item.id} style={styles.questionCard}>
              <View style={styles.questionHeader}>
                <Text style={[styles.chatTitle, { color: item.accent }]} numberOfLines={1}>
                  {item.chatTitle}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.chatTitle}`}
                  testID={`unified-question-open-${item.streamId}`}
                  style={styles.iconButton}
                  onPress={() => onOpenChat(item.streamId)}
                  hitSlop={8}
                >
                  <FontAwesome name="external-link" size={13} color={Tokens.palette.text} />
                </Pressable>
              </View>
              <UnifiedQuestionCard
                item={item}
                submitting={submittingId === item.id}
                submitError={submitErrors[item.id] || null}
                onSubmit={onSubmit}
              />
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function UnifiedQuestionCard({ item, submitting, submitError, onSubmit }: {
  item: UnifiedQuestionItem;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (item: UnifiedQuestionItem, answers: PentacleQuestionAnswerValue[]) => void;
}) {
  const entries = useMemo<MobileQuestionEntry<UnifiedQuestionItem>[]>(() => {
    const parent = item.model.question;
    return mobileQuestionItems(parent).map((question, itemIndex) => ({
      key: `${item.id}:${itemIndex}`,
      question,
      source: item,
      locked: !!(parent.scan_incomplete && question.index !== Number(parent.active_index || 0)),
    }));
  }, [item]);
  const flow = useMobileQuestionFlow(entries);
  const [activeIndex, setActiveIndex] = useState(0);
  const clampedIndex = Math.min(activeIndex, Math.max(0, entries.length - 1));

  useEffect(() => {
    if (activeIndex !== clampedIndex) setActiveIndex(clampedIndex);
  }, [activeIndex, clampedIndex]);

  return (
    <QuestionCardSurface
      entries={entries}
      activeIndex={clampedIndex}
      flow={flow}
      accent={item.accent}
      submitting={submitting}
      error={submitError}
      onIndexChange={setActiveIndex}
      onSend={() => onSubmit(item, entries.map((entry) => flow.answerFor(entry)))}
    />
  );
}

export default function UnifiedScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const actions = usePentacleStreamActions();
  const { isReady } = usePentacleToken();
  const [selected, setSelected] = useState<UnifiedAgentRow | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [questionSubmittingId, setQuestionSubmittingId] = useState<string | null>(null);
  const [questionSubmitErrors, setQuestionSubmitErrors] = useState<Record<string, string | null>>({});
  const selectedRef = useRef<UnifiedAgentRow | null>(null);
  selectedRef.current = selected;

  const slice = usePentacleStreamSelectorWhen(isFocused, selectUnifiedSlice, sameUnifiedSlice);
  const targetSession = selected ? slice.sessionsByStream[selected.streamId] : null;
  const targetChrome: HostChrome = useMemo(
    () => hostChrome(targetSession?.host || selected?.host || ''),
    [selected?.host, targetSession?.host],
  );

  useEffect(() => {
    if (isFocused) logFocusedTab('unified');
  }, [isFocused]);

  const openChat = useCallback((streamId: string) => {
    router.push(streamPath(streamId));
  }, [router]);

  const handleReply = useCallback((row: UnifiedAgentRow) => {
    setSelected(row);
    Keyboard.dismiss();
  }, []);

  const handleError = useCallback((message: string) => {
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_ERROR_SUPPRESSED, {
        stream_id: selectedRef.current?.streamId || '',
        message,
      });
      return;
    }
    Alert.alert('Pentacle', message);
  }, []);

  const handleSend = useCallback(async (
    text: string,
    optimisticAttachments?: ChatAttachment[],
    thumbs?: RenderAttachment[],
    upload?: StagedUpload,
  ) => {
    const target = selectedRef.current;
    const session = target ? slice.sessionsByStream[target.streamId] : null;
    if (!target || !session) return;
    const streamId = target.streamId;
    const optimisticRowAttachments = withRenderUris(optimisticAttachments, thumbs);
    const markFailedAndThrow = (optimisticId: string, error: unknown) => {
      actions.markOptimisticFailed(
        optimisticId,
        error instanceof Error ? error.message : 'send_error',
      );
      throw error;
    };
    const transient = (error: unknown) => error instanceof Error && /Pentacle stream disconnected|Pentacle stream is not connected/.test(error.message);
    const timeout = (error: unknown) => error instanceof Error && /Pentacle command timed out/.test(error.message);
    const phase = slice.workingPhasesByStream[streamId] || 'idle';
    const working = phase !== 'idle';
    if (working) {
      const optimisticId = actions.enqueueTurn(streamId, text, optimisticRowAttachments);
      if (!optimisticId) return;
      // Upload leg: settles (or fails the row visibly and throws) before any
      // send is dispatched — never subject to the send-leg transport swallow.
      // Text-only sends skip it so the flush stays in the press tick.
      if (upload) await settleUploadLeg({ optimisticId, optimisticAttachments, thumbs, upload, actions });
      // Dispatch THIS row: enqueueTurn no longer sets the retired turn_queued
      // hold, so the legacy flushQueuedSends fallback would never select it.
      actions.dispatchQueuedSendsByOptimisticId(streamId, optimisticId);
      setSelected(null);
      return;
    }
    const optimisticId = optimisticAttachments?.length
      ? actions.sendTurn(streamId, text, optimisticRowAttachments)
      : actions.sendTurn(streamId, text);
    if (!optimisticId) return;
    const wireAttachments = upload
      ? await settleUploadLeg({ optimisticId, optimisticAttachments, thumbs, upload, actions })
      : optimisticAttachments;
    try {
      await actions.sendMessage(
        wireAttachments?.length
          ? { host: session.host, sessionName: session.session_name, text, attachments: wireAttachments }
          : { host: session.host, sessionName: session.session_name, text },
      );
    } catch (error) {
      // Send leg only: a transient rejection stays pending (pre-dispatch rows
      // are resubmitted once on reconnect; post-dispatch ones reconcile on echo).
      if (transient(error)) throw error;
	      if (timeout(error)) {
	        setSelected(null);
	        return;
	      }
	      markFailedAndThrow(optimisticId, error);
	    }
	    setSelected(null);
	  }, [actions, slice.sessionsByStream, slice.workingPhasesByStream]);

  const handleQuestionSubmit = useCallback(async (
    item: UnifiedQuestionItem,
    answers: DurableQuestionAnswer[],
  ) => {
    const answer = answers[0] || {};
    const selections = questionSelections(item.model, answers);
    const text = typeof answer.text === 'string' && answer.text.trim() ? answer.text : undefined;
    const customText = typeof answer.customText === 'string' && answer.customText.trim()
      ? answer.customText
      : undefined;
    if (selections.length && customText) {
      setQuestionSubmitErrors((prev) => ({ ...prev, [item.id]: 'Choose a predefined answer or Custom, not both.' }));
      return;
    }
    if (!selections.length && !text && !customText) {
      setQuestionSubmitErrors((prev) => ({ ...prev, [item.id]: 'Choose an answer before submitting.' }));
      return;
    }
    const note = questionNote(answers);
    const questionId = item.model.notification.question?.question_id || (item.model.question as { question_id?: string }).question_id;
    setQuestionSubmitErrors((prev) => ({ ...prev, [item.id]: null }));
    setQuestionSubmittingId(item.id);
    try {
      if (!questionId) throw new Error('Question is missing its durable prompt identity.');
      await actions.answerPrompt({
        questionId,
        ...(selections.length ? { selections } : {}),
        ...(customText || text || note ? { text: customText || text || note } : {}),
      });
    } catch (error) {
      setQuestionSubmitErrors((prev) => ({
        ...prev,
        [item.id]: String((error as Error)?.message || error || 'Question answer could not be submitted.'),
      }));
    } finally {
      setQuestionSubmittingId(null);
    }
  }, [actions]);

  const renderItem = useCallback(
    ({ item }: { item: UnifiedMessageGroup }) => (
      <MessageGroupBubble
        group={item}
        selected={Boolean(selected && item.rows.some((row) => row.id === selected.id))}
        onReply={handleReply}
        onOpen={openChat}
      />
    ),
    [handleReply, openChat, selected?.id, selected?.rowType],
  );

  const listData = useMemo(
    () => {
      const groups = groupUnifiedRows(slice.rows);
      return groups.length ? groups.reverse() : [];
    },
    [slice.rows],
  );
  const emptyLabel = !isReady || !slice.hasHydrated ? 'Connecting to Pentacle…' : 'No delivered agent messages yet.';
  const composerVisible = Boolean(selected && targetSession);

  return (
    <View style={styles.root}>
      <Starfield />
      <View style={[styles.screen, { paddingTop: Math.max(insets.top, 10) + 8 }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>UNIFIED</Text>
            <Text style={styles.title}>All Chats</Text>
          </View>
          <Text style={styles.count}>{slice.rows.length}</Text>
        </View>
        <FlatList
          testID="unified-feed-list"
          data={listData}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          inverted
          keyboardShouldPersistTaps="always"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          contentContainerStyle={[
            styles.feedContent,
            { paddingBottom: composerVisible ? 156 + insets.bottom : 28 + insets.bottom },
            !slice.rows.length && styles.emptyContent,
          ]}
          ListEmptyComponent={<Text style={styles.emptyText}>{emptyLabel}</Text>}
        />
      </View>
      {composerVisible ? (
        <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <View style={styles.composerTarget}>
            <Text style={[styles.composerTargetText, { color: targetChrome.accent }]} numberOfLines={1}>
              Replying to {targetSession?.title || targetSession?.display_name || targetSession?.session_name}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close reply composer" onPress={() => setSelected(null)} hitSlop={8}>
              <FontAwesome name="close" size={15} color={Tokens.palette.text} />
            </Pressable>
          </View>
          <ComposerBar
            host={targetChrome.title}
            chrome={targetChrome}
            disabled={!slice.connected}
            dismissToken={0}
            refocusToken={selected ? 1 : 0}
            onFocus={() => {}}
            onSend={handleSend}
            onError={handleError}
          />
        </View>
      ) : null}
      {slice.questions.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${slice.questions.length} pending questions`}
          testID="unified-question-badge"
          style={[styles.questionBadge, { bottom: Math.max(insets.bottom, 12) + (composerVisible ? 142 : 0) }]}
          onPress={() => setDrawerVisible(true)}
        >
          <FontAwesome name="question" size={15} color={Tokens.palette.ink} />
          <Text style={styles.questionBadgeText}>{slice.questions.length}</Text>
        </Pressable>
      ) : null}
      <QuestionsDrawer
        visible={drawerVisible}
        questions={slice.questions}
        submittingId={questionSubmittingId}
        submitErrors={questionSubmitErrors}
        onClose={() => setDrawerVisible(false)}
        onOpenChat={(streamId) => {
          setDrawerVisible(false);
          openChat(streamId);
        }}
        onSubmit={(item, answers) => {
          void handleQuestionSubmit(item, answers);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Tokens.palette.ink,
  },
  screen: {
    flex: 1,
    paddingHorizontal: SCREEN_PAD,
  },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10,
    letterSpacing: 0,
    color: Tokens.palette.green,
  },
  title: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 24,
    color: Tokens.palette.text,
  },
  count: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 13,
    color: Tokens.palette.dim,
  },
  feedContent: {
    paddingTop: 8,
    gap: 10,
  },
  emptyContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyText: {
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 16,
    color: Tokens.palette.muted,
    textAlign: 'center',
  },
  messageRow: {
    alignItems: 'flex-start',
  },
  userMessageRow: {
    alignItems: 'flex-end',
  },
  messageBubble: {
    width: '92%',
    maxWidth: 620,
  },
  messageContent: {
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  messageHeader: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  titleWrap: {
    minWidth: 0,
    flex: 1,
  },
  chatTitle: {
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 11,
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  messageMeta: {
    marginTop: 2,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 10,
    color: Tokens.palette.muted,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(8,11,10,0.48)',
  },
  messageText: {
    marginTop: 8,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 15,
    lineHeight: 20,
    color: Tokens.palette.text,
  },
  userMessageText: {
    marginTop: 8,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 15,
    lineHeight: 20,
    color: Tokens.palette.text,
  },
  composerWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: SCREEN_PAD,
    paddingTop: 8,
    backgroundColor: 'rgba(8,11,10,0.94)',
    borderTopWidth: 1,
    borderTopColor: Tokens.palette.line,
  },
  composerTarget: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 4,
  },
  composerTargetText: {
    flex: 1,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 11,
    letterSpacing: 0,
  },
  questionBadge: {
    position: 'absolute',
    right: 18,
    minWidth: 50,
    height: 42,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: Tokens.palette.amber,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  questionBadgeText: {
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 14,
    color: Tokens.palette.ink,
  },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: Tokens.palette.backdrop,
  },
  drawer: {
    maxHeight: '72%',
    paddingHorizontal: SCREEN_PAD,
    paddingTop: 8,
    paddingBottom: 18,
    backgroundColor: Tokens.palette.panel,
    borderTopWidth: 1,
    borderTopColor: Tokens.palette.line,
  },
  drawerHandle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: Tokens.palette.line,
    marginBottom: 12,
  },
  drawerHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  drawerTitle: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 19,
    color: Tokens.palette.text,
  },
  drawerScroll: {
    paddingBottom: 10,
  },
  questionCard: {
    marginTop: 10,
  },
  questionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
});
