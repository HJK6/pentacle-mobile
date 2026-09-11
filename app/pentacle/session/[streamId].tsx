import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AccessibilityInfo,
  Animated,
  AppState,
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInput as TextInputInstance,
  type AppStateStatus,
  type ViewToken,
  useWindowDimensions,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { Stack } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Svg, { Circle, Path } from 'react-native-svg';
import { useIsFocused } from '@react-navigation/native';
import useTranscriptQuestionBackfill from '../../../src/hooks/useTranscriptQuestionBackfill';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import {
  Fonts,
  MACHINES,
  SCREEN_PAD,
  TOP_INSET,
  Tokens,
  type MachineName,
} from '../../../constants/Colors';
import ArcaneRingFrame from '../../../src/components/ArcaneRingFrame';
import Bevel from '../../../src/components/Bevel';
import ProviderTag from '../../../src/components/ProviderTag';
import Starfield from '../../../src/components/Starfield';
import StatusTag from '../../../src/components/StatusTag';
import { StatusOverlay } from '../../../src/components/SessionStatusCard';
import SendingIndicator from '../../../src/components/SendingIndicator';
import { WandCastSendIcon } from '../../../src/components/SendGlyphs';
import ChatActionSheet from '../../../src/components/ChatActionSheet';
import RenameChatModal from '../../../src/components/RenameChatModal';
import { AgentThreadHistoryModal, type AgentThreadHistoryTarget } from '../../../src/components/AgentThreadHistoryModal';
import { Spinner } from '../../../src/components/ArcaneAtoms';
import { MediaBubble } from '../../../src/components/MediaBubble';
import { ImageViewerModal } from '../../../src/components/ImageViewerModal';
import ReportViewerModal from '../../../src/components/ReportViewerModal';
import {
  listReports,
  reportUnreadCount as getReportUnreadCount,
  useSessionReports,
} from '../../../src/services/pentacleAssets';
import {
  pickImagesFromLibrary,
  captureImageFromCamera,
  compressForUpload,
  MediaTooLargeError,
  type ProcessedAsset,
} from '../../../src/services/imageCapture';
import {
  beginStagedUpload,
  settleUploadLeg,
  withRenderUris,
  type StagedUpload,
} from '../../../src/services/optimisticSendUnit';
import {
  fetchRenderAttachments,
  renderAttachmentsWithLocalUris,
} from '../../../src/services/attachmentFetch';
import type { RenderAttachment } from '../../../src/types/renderAttachment';
import type { HarnessSendRequest } from '../../../src/utils/harnessRuntime';
import { transcriptOrderChunks } from '../../../src/utils/harnessTranscriptOrder';
import usePentacleToken from '../../../src/hooks/usePentacleToken';
import useFluidWorkingSeconds from '../../../src/hooks/useFluidWorkingSeconds';
import {
  consumeStreamOpenEntrySource,
  requestStreamEvents,
  requestFocusedPentacleLivenessProbe,
  registerFocusedPentacleStream,
  samePentacleConnectionSlice,
  selectOptimisticQuestionAnswerIdentities,
  selectPentacleConnectionSlice,
  selectStreamEventsLoadState,
  selectStreamSlice,
  sameStreamEventsLoadState,
  usePentacleStreamActions,
  usePentacleStreamSelectorWhen,
} from '../../../src/services/pentacleStream';
import * as pentacleStreamRuntime from '../../../src/services/pentacleStream';
import type { InterruptSendResult, PendingSessionClose, StreamOpenEntrySource } from '../../../src/services/pentacleStream';
import { isPentacleSessionSendEligible } from '../../../src/services/sessionInputReadiness';
import { useUserPreference } from '../../../src/services/userPreferences';
import { getHostTheme, getHostMachineName } from '../../../src/config/local';
import { interpretPentacleEvent, peekEventsForStream, invalidateSessionDetailCache, MAX_CHAT_ATTACHMENTS, SESSION_SENDING_VISIBLE_AFTER_MS, parsePeerAgentMessage, type ChatAttachment, type ChildAgent, type PentacleTranscriptItem } from 'pentacle-chat-core';
import { parseMarkdown, parseInline, type MdInline, type MdBlock } from 'pentacle-chat-core';
import { stripClaudeExpandHint } from 'pentacle-chat-core';
import { MISSING_SESSION_REDIRECT_MS, shouldArmRedirectTimer } from '../../../src/services/sessionScreenRedirect';
import { autoscrollTelemetryReason, planScroll } from '../../../src/services/sessionScreenScroll';
import { INITIAL_CHAT_FETCH_LIMIT } from '../../../src/services/chatLoadTuning';
import { selectChatOpenLoadState, shouldPromoteChatOpenTranscript, shouldSelectChatOpenTranscript } from '../../../src/services/chatOpenLoadState';
import { acknowledgeChatRowNavigationIntent } from '../../../src/services/chatOpenNavigationIntent';
import {
  markChatOpenFirstAuthoritativeRowMounted,
  markChatOpenShellLayoutCommitted,
} from '../../../src/services/chatOpenPaintSignals';
import { emitBucketCostOpenSettle } from '../../../src/services/bucketCostSampleSignals';
import {
  buildDurableQuestionResolution,
  buildDurableQuestionAnswerText,
  agentQuestionMatchesSessionQuestion,
  agentQuestionStreamId,
  durableQuestionCardModel,
  durableQuestionDisplaySelections,
  fullyCoveredOptimisticQuestionNotificationIds,
  isAgentQuestionNotification,
  isOpenAgentQuestionNotification,
  terminalAgentQuestionMatchesSessionQuestion,
  type DurableQuestionCardModel,
  type DurableQuestionItemModel,
} from '../../../src/services/agentQuestionNotifications';
import { handleChatCopy, type ChatCopyKind } from '../../../src/utils/chatCopy';
import {
  mobileQuestionItems,
  QuestionFab,
  QuestionOverlay,
  useMobileQuestionFlow,
  type MobileQuestionAnswer,
  type MobileQuestionEntry,
  type MobileQuestionItem,
} from '../../../src/components/MobileQuestions';
import { MOBILE_TELEMETRY_EVENTS } from '../../../src/services/mobileTelemetryEvents';
import { logTelemetry } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import { buildPentacleQuestionAnswerText, parsePentacleQuestionAnswerText } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleNotification, PentacleQuestion, PentacleQuestionAnswerDisplay, PentacleQuestionAnswerValue, PentacleSessionSummary, WorkingStateData, WorkingTaskData } from 'pentacle-chat-core';

type SessionQuestionSource =
  | { kind: 'pane'; parent: PentacleQuestion; itemIndex: number }
  | { kind: 'durable'; model: DurableQuestionCardModel; itemIndex: number };

type SessionQuestionAnswerProjection = {
  key: string;
  attemptId: number;
  source: 'pane' | 'durable';
  answeredAt?: string;
  notificationId?: string;
  childCount?: number;
  text: string;
  pending: boolean;
};

const P = {
  bg: Tokens.palette.ink,
  panel: Tokens.palette.panel,
  panelAlt: '#101712',
  border: Tokens.palette.line,
  borderStrong: 'rgba(120,255,160,0.34)',
  text: Tokens.palette.text,
  muted: Tokens.palette.muted,
  soft: Tokens.palette.dim,
  accent: Tokens.palette.green,
  accentDim: 'rgba(61,255,102,0.62)',
  accentGlow: 'rgba(61,255,102,0.12)',
  warning: Tokens.palette.amber,
  warningBg: 'rgba(255,181,61,0.10)',
  userBubble: `${Tokens.palette.green}16`,
  userBorder: `${Tokens.palette.green}55`,
  commandBg: Tokens.palette.codePanel,
  commandBorder: Tokens.palette.line,
  fileBg: 'rgba(61,255,102,0.06)',
  fileBorder: 'rgba(61,255,102,0.28)',
};

const MONO = Fonts.jetBrainsMono.regular;
const RAJ = Fonts.rajdhani.medium;
const RAJ_SEMI = Fonts.rajdhani.semiBold;
const RAJ_BOLD = Fonts.rajdhani.bold;
const animatedRowIds = new Set<string>();
const transcriptItemMountGenerations = new Map<string, number>();
const transcriptSwitchProbeState = { navigated: false, returned: false, doneStreams: new Set<string>() };
const SELECTABLE_TEXT = { selectable: true, selectionColor: P.accent };
const NON_SELECTABLE_TEXT = { selectable: false } as const;
const INITIAL_TRANSCRIPT_ROWS = 16;
const TRANSCRIPT_PAGE_ROWS = 48;
// Keep first paint richer than the 12-event emergency floor without returning
// to the 300-event payload that blocked long-chat opens. The real-daemon gate
// owns the 2s budget for this tuned window.
export const MOUNT_FETCH_LIMIT = INITIAL_CHAT_FETCH_LIMIT;
const INITIAL_RENDERED_TRANSCRIPT_ROWS = 4;
const TRANSCRIPT_RENDER_BATCH_ROWS = 2;
const COMPOSER_CLOSED_BOTTOM_INSET = 24;
const COMPOSER_KEYBOARD_BOTTOM_INSET = 8;
const NEAR_BOTTOM_OFFSET = 2;
// Hoisted so the transcript's anchoring prop keeps a stable identity across renders — this
// screen has an explicit render-stability contract (tests/sessionScreenRenderStability).
const TRANSCRIPT_BOTTOM_ANCHOR = { minIndexForVisible: 0 } as const;
const COPY_CONFIRMATION_MS = 1400;
export const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'] as const;
export const SPINNER_TICK_MS = 120;

let transcriptOrderGeneration = 0;
let harnessRuntime: typeof import('../../../src/utils/harnessRuntime') | null = null;
if (process.env.EXPO_PUBLIC_HARNESS === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  harnessRuntime = require('../../../src/utils/harnessRuntime');
}

function getHarnessRuntime() {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return null;
  if (!harnessRuntime) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    harnessRuntime = require('../../../src/utils/harnessRuntime');
  }
  return harnessRuntime;
}

type HarnessRowLifecycle = 'mount' | 'update' | 'unmount';

type HarnessRowTelemetryInput = {
  streamId: string;
  rowId: string;
  rowKind?: string;
  displayRule: string;
  text: string;
  eventKey?: string;
  optimisticId?: string;
  correlatedDaemonSeq?: number;
  sendState?: string;
  queuedOrigin?: boolean;
  sendAffordance?: string;
  attachmentCount?: number;
  componentName: string;
  componentKey?: string;
  viewportVisible?: boolean;
  emitUnmount?: boolean;
};

type HarnessRowMountHandle = {
  scenarioRunId: string;
  baseKey: string;
  mountGeneration: number;
};

type HarnessRenderTelemetryContext = {
  scenarioRunId: string;
};

const harnessMountGenerations = new Map<string, number>();
const harnessEmittedRowLifecycleKeys = new Set<string>();

function getHarnessRenderTelemetryContext(): HarnessRenderTelemetryContext | null {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed()) return null;
  const scenarioRunId = (
    harnessRuntime.getParam('scenario_run_id') ||
    harnessRuntime.getParam('run_id') ||
    harnessRuntime.getScenario() ||
    'unknown'
  );
  return { scenarioRunId };
}

function getHarnessScenarioRunId() {
  return getHarnessRenderTelemetryContext()?.scenarioRunId || null;
}

function logHarnessBPrimeTelemetry(name: Parameters<typeof logTelemetry>[0], data: Record<string, unknown>) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed()) return;
  logTelemetry(name, data);
}

function logHarnessUiTrace(kind: string, data: Record<string, unknown>) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed()) return;
  logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
    kind,
    timestamp_emitter_wall: Date.now(),
    ...data,
  });
}

function timestampObserverMonotonic() {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') {
    return perf.now();
  }
  return Date.now();
}

function textPrefix(text: string) {
  return Array.from(String(text || '')).slice(0, 40).join('');
}

function textDigest(text: string) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function logHarnessRowLifecycle(
  input: HarnessRowTelemetryInput,
  handle: HarnessRowMountHandle,
  lifecycle: HarnessRowLifecycle,
) {
  if (
    harnessRuntime?.hasAction('composite_chat_load_probe') &&
    input.componentName === 'TranscriptRow' &&
    !input.optimisticId
  ) {
    return;
  }
  const lifecycleStateKey = lifecycle === 'update'
    ? `${lifecycle}:${input.sendState || ''}:${input.sendAffordance || ''}:${input.queuedOrigin === true}:${input.correlatedDaemonSeq || ''}:${input.attachmentCount ?? 0}`
    : lifecycle;
  const lifecycleKey = `${handle.baseKey}:${handle.mountGeneration}:${lifecycleStateKey}`;
  if (harnessEmittedRowLifecycleKeys.has(lifecycleKey)) return;
  harnessEmittedRowLifecycleKeys.add(lifecycleKey);

  logTelemetry(TELEMETRY_EVENTS.HARNESS_ROW_RENDERED, {
    scenario_run_id: handle.scenarioRunId,
    stream_id: input.streamId,
    row_id: input.rowId,
    row_kind: input.rowKind || input.displayRule,
    displayRule: input.displayRule,
    display_rule: input.displayRule,
    text_prefix: textPrefix(input.text),
    text_digest: textDigest(input.text),
    event_key: input.eventKey || input.componentKey || 'uncorrelated_fallback',
    optimistic_id: input.optimisticId,
    send_state: input.sendState,
    queued_origin: input.queuedOrigin === true,
    send_affordance: input.sendAffordance,
    attachment_count: input.attachmentCount ?? 0,
    component_name: input.componentName,
    component_key: input.componentKey,
    lifecycle,
    mount_generation: handle.mountGeneration,
    viewport_visible: input.viewportVisible !== false,
    timestamp_emitter_wall: Date.now(),
    timestamp_observer_monotonic: timestampObserverMonotonic(),
  });

  const shouldEmitChatRendered =
    input.componentName === 'TranscriptRow' &&
    (lifecycle === 'mount' || Boolean(input.optimisticId && input.correlatedDaemonSeq));
  if (shouldEmitChatRendered) {
    const rowSeq = Number(input.correlatedDaemonSeq ?? input.rowId);
    logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RENDERED, {
      stream_id: input.streamId,
      kind: input.rowKind,
      seq: Number.isFinite(rowSeq) ? rowSeq : undefined,
      optimistic_id: input.optimisticId,
      correlated_daemon_seq: input.correlatedDaemonSeq,
      display_rule: input.displayRule,
      rendered_text: input.text,
      attachment_count: input.attachmentCount ?? 0,
      send_state: input.sendState,
      queued_origin: input.queuedOrigin === true,
      send_affordance: input.sendAffordance,
    });
  }

  if (lifecycle === 'mount') {
    logTelemetry(MOBILE_TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED, {
      scenario_run_id: handle.scenarioRunId,
      stream_id: input.streamId,
      row_id: input.rowId,
      row_kind: input.rowKind || input.displayRule,
      display_rule: input.displayRule,
      text_digest: textDigest(input.text),
      event_key: input.eventKey || input.componentKey || 'uncorrelated_fallback',
      component_name: input.componentName,
      send_state: input.sendState,
      queued_origin: input.queuedOrigin === true,
      send_affordance: input.sendAffordance,
      attachment_count: input.attachmentCount ?? 0,
      viewport_visible: input.viewportVisible !== false,
      timestamp_emitter_wall: Date.now(),
      timestamp_observer_monotonic: timestampObserverMonotonic(),
    });
  }
}

function beginHarnessRowMount(input: HarnessRowTelemetryInput): HarnessRowMountHandle | null {
  const scenarioRunId = getHarnessScenarioRunId();
  if (!scenarioRunId) return null;
  if (!input.streamId || !input.rowId) return null;
  if (input.viewportVisible === false) return null;

  const baseKey = [
    scenarioRunId,
    input.streamId,
    input.rowId,
    input.componentName,
  ].join('|');
  const mountGeneration = harnessMountGenerations.get(baseKey) || 0;
  const handle = { scenarioRunId, baseKey, mountGeneration };
  logHarnessRowLifecycle(input, handle, 'mount');
  return handle;
}

function finishHarnessRowMount(input: HarnessRowTelemetryInput, handle: HarnessRowMountHandle | null) {
  if (!handle) return;
  if (input.emitUnmount) {
    logHarnessRowLifecycle(input, handle, 'unmount');
  }
  harnessMountGenerations.set(handle.baseKey, handle.mountGeneration + 1);
}

function useHarnessRowRenderTelemetry(input: HarnessRowTelemetryInput) {
  const latestInputRef = useRef(input);
  const handleRef = useRef<HarnessRowMountHandle | null>(null);
  latestInputRef.current = input;

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1') return undefined;
    const handle = beginHarnessRowMount(latestInputRef.current);
    handleRef.current = handle;
    return () => {
      finishHarnessRowMount(latestInputRef.current, handle);
      handleRef.current = null;
    };
  }, [input.componentName, input.rowId, input.streamId]);

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
    if (input.componentName !== 'TranscriptRow') return;
    if (!input.optimisticId) return;
    if (!input.correlatedDaemonSeq && input.sendState !== 'failed') return;
    const handle = handleRef.current;
    if (!handle) return;
    logHarnessRowLifecycle(input, handle, 'update');
  }, [
    input.attachmentCount,
    input.componentName,
    input.correlatedDaemonSeq,
    input.optimisticId,
    input.queuedOrigin,
    input.rowId,
    input.sendState,
    input.sendAffordance,
    input.streamId,
  ]);
}

function logHarnessDockLabelRender(
  streamId: string,
  label: string,
  elapsedSeconds: number | null,
  componentKey: string,
) {
  const scenarioRunId = getHarnessScenarioRunId();
  if (!scenarioRunId) return;
  logTelemetry(TELEMETRY_EVENTS.HARNESS_DOCK_LABEL_RENDER, {
    scenario_run_id: scenarioRunId,
    stream_id: streamId,
    label,
    elapsed_seconds: elapsedSeconds,
    component_key: componentKey,
    timestamp_emitter_wall: Date.now(),
    timestamp_observer_monotonic: timestampObserverMonotonic(),
  });
}

function logHarnessHeaderStatusRender(
  streamId: string,
  optimisticId: string,
  status: 'sending' | 'working',
) {
  const scenarioRunId = getHarnessScenarioRunId();
  if (!scenarioRunId) return;
  logTelemetry(TELEMETRY_EVENTS.HARNESS_HEADER_STATUS_RENDER, {
    scenario_run_id: scenarioRunId,
    stream_id: streamId,
    optimistic_id: optimisticId,
    status,
    timestamp_emitter_wall: Date.now(),
    timestamp_observer_monotonic: timestampObserverMonotonic(),
  });
}

export type HostChrome = {
  header: string;
  accent: string;
  surface: string;
  border: string;
  title: string;
  machineName?: MachineName;
};

export function hostChrome(host: string): HostChrome {
  const theme = getHostTheme(host);
  const machineName = getHostMachineName(host);
  const machine = MACHINES[machineName];
  return {
    header: Tokens.palette.ink,
    accent: machine.accent || theme.accent || theme.color,
    surface: `${machine.accent}0e`,
    border: `${machine.accent}44`,
    title: theme.label || machineName,
    machineName,
  };
}

function displayTitleForShell(session: PentacleSessionSummary) {
  const title = String(session.title || session.display_name || '').trim();
  return title || session.session_name;
}

type ToolInvocation = {
  title: string;
  body: string;
};

type CopyRequestInput = {
  targetId: string;
  copyKind: ChatCopyKind;
  text: string;
};

type CopyHandler = (request: CopyRequestInput) => Promise<void>;

function optimisticAttachmentsForStaged(staged: ProcessedAsset[]): ChatAttachment[] {
  return staged.map((asset, index) => ({
    key: `local:${index}:${asset.uri}`,
    mime: asset.mimeType,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
    bytes: asset.bytes,
  }));
}

async function fixtureImageToProcessedAsset(request: Exclude<HarnessSendRequest, string>): Promise<ProcessedAsset> {
  const directory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!directory) throw new Error('No writable fixture image directory');
  const safeName = String(request.fixtureImage.name || `harness-fixture-${Date.now()}`)
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  const ext = request.fixtureImage.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const uri = `${directory}${safeName.endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`}`;
  await FileSystem.writeAsStringAsync(uri, request.fixtureImage.base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return {
    uri,
    fileName: uri.split('/').pop() || `harness-fixture.${ext}`,
    mimeType: request.fixtureImage.mimeType,
    width: request.fixtureImage.width ?? null,
    height: request.fixtureImage.height ?? null,
    bytes: request.fixtureImage.bytes ?? Math.max(0, Math.floor((request.fixtureImage.base64.length * 3) / 4)),
  };
}

function messageCopyTargetId(rowId: string) {
  return `${rowId}:copy:message`;
}

function codeCopyTargetId(rowId: string, blockId: string) {
  return `${rowId}:copy:code:${blockId}`;
}

function isBackfillRenderContent(item: PentacleTranscriptItem) {
  const displayRule = String(item.displayRule);
  return displayRule !== 'terminal:divider' &&
    displayRule !== 'activity:turn-summary' &&
    displayRule !== 'system:blank';
}

const PANE_CLAUDE_TOOL_INVOCATION = /^(Read|Edit|Write|Bash|Grep|Glob|Agent|TodoWrite)\([\s\S]*\)$/i;
const TOOL_ACTIVITY_RULES = new Set(['activity:command', 'activity:explored', 'activity:file-change']);
const QUESTION_ANSWER_SUBMIT_ATTEMPT = MOBILE_TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_ATTEMPT;
const QUESTION_ANSWER_SUBMIT_FAILED = MOBILE_TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_FAILED;
const QUESTION_ANSWER_SUBMIT_SENT = MOBILE_TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_SENT;
const QUESTION_INPUT_FOCUSED = MOBILE_TELEMETRY_EVENTS.QUESTION_INPUT_FOCUSED;
const QUESTION_REOPEN_FETCH_ATTEMPT = MOBILE_TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_ATTEMPT;
const QUESTION_REOPEN_FETCH_FAILED = MOBILE_TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_FAILED;
const QUESTION_REOPEN_FETCH_READY = MOBILE_TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_READY;
const CHAT_HISTORY_BACKFILL_RENDERED = MOBILE_TELEMETRY_EVENTS.CHAT_HISTORY_BACKFILL_RENDERED;
const CHAT_EMPTY_STATE_RENDERED = MOBILE_TELEMETRY_EVENTS.CHAT_EMPTY_STATE_RENDERED;
const CHAT_HISTORY_RECOVERY_REFETCH = MOBILE_TELEMETRY_EVENTS.CHAT_HISTORY_RECOVERY_REFETCH;
const CHAT_OPEN_SPINNER_ON_OPEN = MOBILE_TELEMETRY_EVENTS.CHAT_OPEN_SPINNER_ON_OPEN;
const CHAT_OPEN_INSTANT_OPEN = MOBILE_TELEMETRY_EVENTS.CHAT_OPEN_INSTANT_OPEN;
const CHAT_OPEN_FRESHNESS_REFETCH = MOBILE_TELEMETRY_EVENTS.CHAT_OPEN_FRESHNESS_REFETCH;
const HARNESS_TRANSCRIPT_ORDER_DUMP = MOBILE_TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ORDER_DUMP;
const QUESTION_FLOW_SUBSYSTEM = 'question_flow';
let historyRequestCycleSequence = 0;
const CHAT_OPEN_LOADING_SUBSYSTEM = 'chat_open_loading';
const TRACKD_BUG1_SUBMIT = 'trackD_bug1_submit';
const TRACKD_BUG2_REOPEN = 'trackD_bug2_reopen';
const TRACKD_BUG3_MULTISELECT = 'trackD_bug3_multiselect';
const TRACKD_BUG5_NOTES = 'trackD_bug5_notes';
export const SESSION_QUESTION_SUBMISSION_TIMEOUT_MS = 8_000;
const REMAINING_CHAT_BUG2_LOADING = 'remaining_chat_bugs_bug2_loading_state';

function sameNotificationIds(left: PentacleNotification[], right: PentacleNotification[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.notification_id === other?.notification_id &&
      item.state === other.state &&
      item.updated_at === other.updated_at &&
      (item as PentacleNotification & { client_resolution_pending?: boolean }).client_resolution_pending ===
        (other as PentacleNotification & { client_resolution_pending?: boolean })?.client_resolution_pending &&
      (item as PentacleNotification & { client_resolution_error?: string }).client_resolution_error ===
        (other as PentacleNotification & { client_resolution_error?: string })?.client_resolution_error;
  });
}

function questionDispatchWithTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Question answer dispatch timed out.')), SESSION_QUESTION_SUBMISSION_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function durableAnswerProjectionKey(notificationId: string, item: DurableQuestionItemModel, index: number) {
  return `durable:${notificationId}:${item.questionId || index}`;
}

export type AuthoritativeAnswerProjection = {
  notificationId?: string;
  childCount?: number;
};

function selectSessionShellSliceForScreen(state: any, streamId: string) {
  const selector = pentacleStreamRuntime.selectSessionShellSlice;
  if (typeof selector === 'function') return selector(state, streamId);
  const retainedRows = (state.events || []).filter((event: any) => event.stream_id === streamId).length;
  return {
    connected: Boolean(state.connected),
    connecting: Boolean(state.connecting),
    session: state.sessions?.find((item: any) => item.stream_id === streamId) || null,
    retainedRows,
    request: retainedRows > 0 ? 'ready' as const : 'idle' as const,
    preview: null,
  };
}

function hasSessionShellSelector() {
  return typeof pentacleStreamRuntime.selectSessionShellSlice === 'function';
}

function sameSessionShellSliceForScreen(a: ReturnType<typeof selectSessionShellSliceForScreen>, b: ReturnType<typeof selectSessionShellSliceForScreen>) {
  const comparator = pentacleStreamRuntime.sameSessionShellSlice;
  if (typeof comparator === 'function') return comparator(a, b);
  return a === b || (
    a.connected === b.connected &&
    a.connecting === b.connecting &&
    a.session === b.session &&
    a.retainedRows === b.retainedRows &&
    a.request === b.request &&
    a.preview?.key === b.preview?.key
  );
}

/**
 * Notifications whose answer is FULLY represented by authoritative resolved-notification
 * projections, and whose echoed transcript row may therefore be dropped as a duplicate.
 *
 * A multi-question notification yields one projection per child, and the echoed
 * `agent-question-answer` row carries no child identity — so partial coverage must NOT suppress
 * it, or the only representation of an unprojected child's answer disappears. Over-showing is
 * recoverable by the reader; hiding is not.
 */
export function fullyCoveredAnswerNotificationIds(
  projections: AuthoritativeAnswerProjection[],
): Set<string> {
  const coverage = new Map<string, { projected: number; total: number }>();
  for (const projection of projections) {
    const id = projection.notificationId;
    if (!id) continue;
    const total = projection.childCount ?? 0;
    const entry = coverage.get(id) ?? { projected: 0, total };
    entry.projected += 1;
    entry.total = Math.max(entry.total, total);
    coverage.set(id, entry);
  }
  const covered = new Set<string>();
  for (const [id, entry] of coverage) {
    if (entry.total > 0 && entry.projected >= entry.total) covered.add(id);
  }
  return covered;
}

// spec_pentacle_mobile__durable_question_optimistic_row_on_resolve_failure:
// an OFFLINE durable resolve settles an optimistic in-chat answer bubble that is
// queued for auto-replay. If that replay fails terminally (daemon 1012 / replay-
// window expiry) the notification surfaces `client_resolution_error`, but the
// settled optimistic row is left stale and the question card stays hidden. Return
// the keys of the SETTLED durable rows whose notification has failed terminally so
// the caller can discard them, restoring the true state and re-showing the card.
// A still-pending row (an in-flight re-answer) is deliberately preserved.
export function failedDurableAnswerProjectionKeys(
  projections: Record<string, Pick<SessionQuestionAnswerProjection, 'key' | 'source' | 'pending' | 'notificationId'>>,
  notifications: ReadonlyArray<PentacleNotification & { client_resolution_error?: string }>,
): string[] {
  const failed = new Set<string>();
  for (const notification of notifications) {
    const error = notification.client_resolution_error;
    if (typeof error === 'string' && error) failed.add(String(notification.notification_id));
  }
  if (failed.size === 0) return [];
  return Object.values(projections)
    .filter((projection) => (
      projection.source === 'durable' &&
      !projection.pending &&
      !!projection.notificationId &&
      failed.has(projection.notificationId)
    ))
    .map((projection) => projection.key);
}

export function suppressLocalQuestionAnswerEchoes<T extends Pick<PentacleTranscriptItem, 'eventCase' | 'notificationId'>>(
  items: T[],
  projectedNotificationIds: ReadonlySet<string>,
): T[] {
  return items.filter((item) => !(
    item.eventCase === 'agent-question-answer' &&
    item.notificationId &&
    projectedNotificationIds.has(item.notificationId)
  ));
}

function parseNotificationAnswerTell(text: string) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.shift()?.trim() !== '[notification.answer]') return null;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const notificationId = fields.get('notification_id') || '';
  if (!notificationId) return null;
  return {
    notificationId,
    actionKind: fields.get('action_kind') || 'answered',
    text: fields.get('text') || fields.get('custom_text') || '',
    note: fields.get('note') || '',
  };
}

export function formatNotificationAnswerTellItem(item: PentacleTranscriptItem): PentacleTranscriptItem {
  if (!item.isUser) return item;
  const answer = parseNotificationAnswerTell(item.text);
  if (!answer) return item;
  const protocolText = buildDurableQuestionAnswerText(answer);
  const interpreted = interpretPentacleEvent({
    daemon_seq: Number.NaN,
    host: '',
    provider: item.provider,
    session_id: '',
    session_name: '',
    stream_id: '',
    timestamp: '',
    kind: 'USER',
    text: protocolText,
  });
  return {
    ...item,
    label: interpreted.label,
    tone: interpreted.tone,
    text: interpreted.text,
    isUser: interpreted.tone === 'user',
    eventCase: interpreted.caseId,
    displayRule: interpreted.displayRule,
    notificationId: answer.notificationId,
  };
}

export function resolvedDurableQuestionProjections(notification: PentacleNotification) {
  const model = durableQuestionCardModel(notification);
  const payload = notification.question as (PentacleNotification['question'] & {
    questions?: Array<{ answer?: Record<string, unknown> | null }>;
  }) | null | undefined;
  if (!model || !payload) return [];
  const rawItems = Array.isArray(payload.questions) && payload.questions.length > 0 ? payload.questions : [payload];
  return model.items.flatMap((item, index) => {
    const raw = rawItems[index]?.answer;
    if (!raw) return [];
    const values = Array.isArray(raw.selections)
      ? raw.selections.map(String)
      : (typeof raw.value === 'string' ? [raw.value] : []);
    const selectedIndices = [...item.optionValues.entries()]
      .filter(([, value]) => values.includes(value))
      .map(([optionIndex]) => optionIndex);
    const customText = typeof raw.custom_text === 'string' ? raw.custom_text : '';
    const note = typeof raw.note === 'string' ? raw.note : '';
    const text = typeof raw.text === 'string' ? raw.text : '';
    const answer: MobileQuestionAnswer = text
      ? { text, ...(note ? { note } : {}) }
      : {
        ...(selectedIndices.length > 0
          ? (item.question.multiSelect
            ? { selectedOptionIndices: selectedIndices }
            : { selectedOptionIndex: selectedIndices[0] })
          : {}),
        ...(customText ? { customText } : {}),
        ...(note ? { note } : {}),
      };
    const displayAnswer = customText && selectedIndices.length === 0
      ? { text: customText, ...(note ? { note } : {}) }
      : answer;
    if (!text && !customText && selectedIndices.length === 0) return [];
    return [{
      key: durableAnswerProjectionKey(notification.notification_id, item, index),
      notificationId: String(notification.notification_id || ''),
      // How many answerable children this notification has in total. A multi-question
      // notification yields one projection PER CHILD, so the echo row may only be suppressed
      // once every child is projected (see transcriptData).
      childCount: model.items.length,
      // Resolution time is immutable; updated_at changes again when the agent consumes it.
      answeredAt: notification.resolved_at || notification.resolution?.at || undefined,
      text: buildDurableQuestionAnswerText({
        notificationId: notification.notification_id,
        questionId: item.questionId,
        actionKind: String(notification.resolution?.action_kind || 'answered'),
        ...(text ? { text } : {}),
        ...(customText ? { customText } : {}),
        ...(selectedIndices.length > 0
          ? { selections: durableQuestionDisplaySelections(item, displayAnswer) }
          : {}),
        ...(note ? { note } : {}),
      }),
    }];
  });
}

type QuestionTimelineItem = PentacleTranscriptItem & { answerTimestamp?: string };

function answerClock(timestamp?: string) {
  const date = timestamp ? new Date(timestamp) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function sessionQuestionProjectionItem(projection: Pick<SessionQuestionAnswerProjection, 'key' | 'text' | 'pending' | 'answeredAt'>): QuestionTimelineItem {
  const interpreted = interpretPentacleEvent({
    daemon_seq: -1,
    host: '',
    provider: '',
    session_id: '',
    session_name: '',
    stream_id: '',
    timestamp: '',
    kind: 'USER',
    text: projection.text,
  });
  return {
    id: `session-question-answer-${projection.key}`,
    timestampLabel: answerClock(projection.answeredAt),
    answerTimestamp: projection.answeredAt,
    label: interpreted.label,
    tone: interpreted.tone,
    provider: '',
    source: 'question-answer',
    text: interpreted.text,
    kind: 'USER',
    isUser: interpreted.tone === 'user',
    eventCase: interpreted.caseId,
    displayRule: interpreted.displayRule,
    ...(interpreted.notificationId ? { notificationId: interpreted.notificationId } : {}),
    pending: projection.pending,
    ...(projection.pending ? { sendState: 'sending' as const } : {}),
  };
}

// Dedupe may remove the echoed answer from detailItems, but its original position
// remains authoritative. Use that receipt first, then immutable resolution time.
// Legacy answers with neither retain the ask anchor. Never derive time from a
// formatted clock or invent a daemon sequence for a notification projection.
export function orderSessionTranscriptRows(
  detailItems: readonly PentacleTranscriptItem[],
  answerProjectionItems: readonly QuestionTimelineItem[],
  sourceItems: readonly PentacleTranscriptItem[] = detailItems,
  eventTimestamps: ReadonlyMap<string, string> = new Map(),
): PentacleTranscriptItem[] {
  const retained = new Set(detailItems.map((item) => item.id));
  const echoed = new Set(sourceItems
    .filter((item) => item.eventCase === 'agent-question-answer' && item.notificationId)
    .map((item) => item.notificationId!));
  const consumed = new Set<string>();
  const ordered: PentacleTranscriptItem[] = [];
  const timed = answerProjectionItems
    .filter((item) => Number.isFinite(Date.parse(item.answerTimestamp || '')))
    .slice().sort((a, b) => Date.parse(a.answerTimestamp!) - Date.parse(b.answerTimestamp!));
  const append = (projection: QuestionTimelineItem, anchor?: PentacleTranscriptItem) => {
    if (consumed.has(projection.id)) return;
    consumed.add(projection.id);
    ordered.push(anchor ? {
      ...projection,
      timestampLabel: anchor.timestampLabel || answerClock(eventTimestamps.get(anchor.id)) || projection.timestampLabel,
    } : projection);
  };
  for (const item of sourceItems) {
    const itemTime = Date.parse(eventTimestamps.get(item.id) || '');
    if (Number.isFinite(itemTime)) {
      for (const projection of timed) {
        if (!echoed.has(projection.notificationId || '') && Date.parse(projection.answerTimestamp!) < itemTime) {
          append(projection);
        }
      }
    }
    if (retained.has(item.id)) ordered.push(item);
    if (!item.notificationId) continue;
    for (const projection of answerProjectionItems) {
      if (projection.notificationId !== item.notificationId) continue;
      if (item.eventCase === 'agent-question-answer') append(projection, item);
      else if (item.eventCase === 'agent-question-ask' &&
        !echoed.has(item.notificationId) && !Number.isFinite(Date.parse(projection.answerTimestamp || ''))) {
        append(projection);
      }
    }
  }
  for (const projection of answerProjectionItems) append(projection);
  return ordered.reverse();
}

export default function PentacleSessionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const isFocused = useIsFocused();
  const params = useLocalSearchParams<{ streamId?: string; reports?: string; reportHarness?: string; openStatus?: string; agentHistory?: string; agentHistoryGeneration?: string }>();
  const streamId = decodeURIComponent(params.streamId || '');
  const routeAgentHistoryId = decodeURIComponent(params.agentHistory || '');
  const activeHarnessRuntime = getHarnessRuntime();
  const reportViewerHarnessRunId = activeHarnessRuntime?.getParam('scenario_run_id') || '';
  const reportViewerHarnessRoute =
    params.reportHarness === '1' &&
    reportViewerHarnessRunId.length > 0 &&
    streamId === `harness:report-viewer-e2e:${reportViewerHarnessRunId}` &&
    activeHarnessRuntime?.isArmed() === true &&
    activeHarnessRuntime.hasAction('open_report_viewer_e2e');
  const { token, isReady } = usePentacleToken();
  const actions = usePentacleStreamActions();
  const [isDragging, setIsDragging] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [reportsVisible, setReportsVisible] = useState(false);
  const [statusOverlayOpen, setStatusOverlayOpen] = useState(false);
  const [agentThreadTarget, setAgentThreadTarget] = useState<AgentThreadHistoryTarget | null>(null);
  const [appState, setAppState] = useState<AppStateStatus | null>(() => AppState.currentState);
  const [renameVisible, setRenameVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [visibleRows, setVisibleRows] = useState(INITIAL_TRANSCRIPT_ROWS);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [transcriptReady, setTranscriptReady] = useState(false);
  const [dismissComposerToken, setDismissComposerToken] = useState(0);
  const [refocusComposerToken, setRefocusComposerToken] = useState(0);
  const [composerHeight, setComposerHeight] = useState(82);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [harnessExpandedRowId, setHarnessExpandedRowId] = useState<string | null>(null);
  const [copiedTargetId, setCopiedTargetId] = useState<string | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionSubmitError, setQuestionSubmitError] = useState<string | null>(null);
  const [questionPageIndex, setQuestionPageIndex] = useState(0);
  const [questionOverlayOpen, setQuestionOverlayOpen] = useState(false);
  const [questionAnswerProjections, setQuestionAnswerProjections] = useState<Record<string, SessionQuestionAnswerProjection>>({});
  const [locallyResolvedNotificationIds, setLocallyResolvedNotificationIds] = useState<Set<string>>(() => new Set());
  const [locallyDismissedQuestionKey, setLocallyDismissedQuestionKey] = useState<string | null>(null);
  // A1 (photo/camera send): the tapped attachment shown full-screen in the viewer.
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const nextQuestionAnswerAttemptIdRef = useRef(0);
  const transcriptRef = useRef<FlatList<PentacleTranscriptItem> | null>(null);
  const transcriptScrollOffsetRef = useRef(0);
  const transcriptVisibleAnchorRef = useRef<{ id: string | null; seq: number | null; index: number | null } | null>(null);
  const transcriptLiveAnchorSampleCountRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionSubmissionInFlightRef = useRef(false);
  const historyDeepLinkConsumedRef = useRef('');
  const lastSeenIdRef = useRef<string | null>(null);
  const latestTopTranscriptIdRef = useRef<string | null>(null);
  const hasInitializedLastSeenRef = useRef(false);
  const previousLengthRef = useRef(0);
  const lastScrollTelemetryRef = useRef('');
  const transcriptProbeLoadCountRef = useRef(0);
  const transcriptLoadEarlierProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptLiveAnchorSampleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptLoadEarlierProbeStateRef = useRef({
    streamId: '',
    shouldRenderTranscript: false,
    loadingEarlier: false,
    isAtBottom: true,
    transcriptCount: 0,
    firstSeq: null as number | null,
    lastSeq: null as number | null,
    uniqueSeqCount: 0,
    seqsContiguous: false,
    remainingCount: 0,
    hasOlderHistoryPage: false,
  });
  const handleLoadEarlierRef = useRef<() => void>(() => {});
  const transcriptProbeScrolledRef = useRef(false);
  const transcriptScrollAnchorReadyRef = useRef(false);
  const transcriptLiveVisibleSeqRef = useRef<number | null>(null);
  const loadEarlierAffordanceLoggedRef = useRef(false);
  // Synchronous mirror of isAtBottom. onScroll updates React state asynchronously,
  // so a message arriving immediately after the user scrolls up could read a
  // stale isAtBottom=true and yank the view back to the bottom. The autoscroll
  // effect reads this ref (kept in sync via setAtBottom) for its keep-position
  // decision, while the state still drives rendering (the scroll-to-bottom pill).
  const isAtBottomRef = useRef(true);
  const setAtBottom = useCallback((value: boolean) => {
    isAtBottomRef.current = value;
    setIsAtBottom(value);
  }, []);
  const openEntrySourceRef = useRef<StreamOpenEntrySource>('cold-jump');
  const openTelemetryRef = useRef<{ streamId: string; spinner: boolean; instant: boolean } | null>(null);
  const chatOpenCorrelationIdRef = useRef<string | null>(null);
  const chatOpenShellPaintedForRef = useRef<string | null>(null);
  const chatOpenAuthoritativeRowPaintedForRef = useRef<string | null>(null);
  const historyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyBackfillRenderedRef = useRef<Set<string>>(new Set());
  // Loading recovery (FEAT-LOAD-RECOVERY): the resilient session summary
  // (`last_event_at`) advances even when a one-shot live `chat.event` frame is
  // dropped on a lossy link, so when the summary outruns the newest event we
  // actually hold we refetch this stream's recent history to backfill the gap.
  // Debounced + cooled down (and re-armed by `recoveryTick`) so a working turn's
  // summary churn cannot storm the daemon. Deliberately bypasses
  // Bucket coverage owns the ordinary mount backfill state; this ref only
  // deduplicates the separate summary-behind recovery request.
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryLastDispatchRef = useRef(0);
  const recoveryFetchStreamsRef = useRef<Set<string>>(new Set());
  const restoredReturnedDraftIdsRef = useRef<Set<string>>(new Set());
  // B1: latest busy-turn state for the (closure-captured) send handler — a send is
  // queued vs. dispatched based on the turn state at the moment of the tap.
  const isWorkingRef = useRef(false);
  // B1 (multi-ESC debounce, D4): identity of the working turn for which an
  // interrupt has already been issued. Spamming ESC within ONE working turn is a
  // no-op (exactly one effective `send.interrupt` per turn — ESC#2 would cancel
  // auto-flushed queued work); a NEW working turn (different identity) re-arms it.
  const escLatchRef = useRef<string | null>(null);
  const [interruptRetryIdentity, setInterruptRetryIdentity] = useState<string | null>(null);
  const [returnedDraftPrefill, setReturnedDraftPrefill] = useState<{ text: string; token: number } | null>(null);
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const [recoveryTick, setRecoveryTick] = useState(0);
  // FEAT-LOAD-RECONNECTING-HINT: true once the loading state has been showing
  // for a while, so a long load (lossy link / offline) surfaces a "Reconnecting…"
  // affordance instead of a bare spinner.
  const [loadingRunningLong, setLoadingRunningLong] = useState(false);
  const [historyBackfillReadyKey, setHistoryBackfillReadyKey] = useState('');
  const [showToolActions] = useUserPreference('showToolActions');
  const [showTurnDuration] = useUserPreference('showTurnDuration');
  const sessionReports = useSessionReports(streamId);
  const reportUnread = getReportUnreadCount(streamId);
  const reportsDeepLinkConsumedRef = useRef(false);

  useEffect(() => {
    if (params.openStatus !== '1') return;
    setStatusOverlayOpen(true);
    router.setParams({ openStatus: undefined } as any);
  }, [params.openStatus, router]);

  useEffect(() => {
    if (!isFocused) setStatusOverlayOpen(false);
  }, [isFocused]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => () => setStatusOverlayOpen(false), [streamId]);

  // Only Chats row opens participate in the coordinator. Focus is the
  // destination acknowledgement; mismatched and late acks are ignored there.
  useLayoutEffect(() => {
    if (!isFocused || !streamId) return;
    const correlationId = acknowledgeChatRowNavigationIntent(streamId);
    if (!correlationId) return;
    chatOpenCorrelationIdRef.current = correlationId;
    chatOpenShellPaintedForRef.current = null;
    chatOpenAuthoritativeRowPaintedForRef.current = null;
  }, [isFocused, streamId]);

  // Harness-only: register the composer's `handleSend` closure with
  // `harnessRuntime` so `dispatchSend(streamId, text)` can drive the send
  // path from a scenario action. Production bundles dead-code this branch
  // — the env var is `undefined` and the conditional collapses, so the
  // prop passed to `ComposerBar` is `undefined` and `ComposerBar`'s
  // `useEffect` short-circuits.
  // Spec: spec_pentacle_mobile_e2e_telemetry_flows_2026_05_13 Stage 2
  // §"Compose-driving plumbing"
  const harnessSendHandlerRegistrar = useMemo<
    ((fn: ((request: HarnessSendRequest) => Promise<void>) | null) => void) | undefined
  >(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime) return undefined;
    const runtime = harnessRuntime;
    let unregister: (() => void) | null = null;
    return (fn) => {
      if (unregister) {
        unregister();
        unregister = null;
      }
      if (fn === null) return;
      unregister = runtime.registerSendHandler(streamId, fn, () => isWorkingRef.current);
    };
  }, [streamId]);

  const shellSlice = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => selectSessionShellSliceForScreen(state, isFocused ? streamId : ''),
    sameSessionShellSliceForScreen,
  );
  const shellSelectorAvailable = hasSessionShellSelector();
  const shouldSelectTranscript = shouldSelectChatOpenTranscript(
    isFocused,
    shellSelectorAvailable,
    transcriptReady,
  );
  // The chat-open shell defers the heavy transcript selector to
  // InteractionManager. That is right for the mount frame, but rows arriving
  // while the deferral is still pending must not wait for it: without this the
  // first assistant event of a fresh chat sits in stream state, unrendered,
  // until the interaction/rAF flush.
  const transcriptPromotionBaselineRef = useRef<{ streamId: string; rows: number } | null>(null);
  useEffect(() => {
    if (!isFocused) {
      transcriptPromotionBaselineRef.current = null;
      return;
    }
    const baseline = transcriptPromotionBaselineRef.current;
    if (!baseline || baseline.streamId !== streamId) {
      transcriptPromotionBaselineRef.current = { streamId, rows: shellSlice.retainedRows };
      return;
    }
    if (shouldPromoteChatOpenTranscript(transcriptReady, baseline.rows, shellSlice.retainedRows)) {
      setTranscriptReady(true);
    }
  }, [isFocused, streamId, shellSlice.retainedRows, transcriptReady]);

  // Subscribed for the whole focused lifetime, not just once the transcript is
  // released: toggling `enabled` here tore the subscription down and rebuilt it
  // at the deferral boundary, so live rows could only reach the screen on the
  // next flush. The heavy derivation stays gated by the selector body below.
  const streamSlice = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => shouldSelectTranscript
      ? selectStreamSlice(
        state,
        isFocused ? streamId : '',
        { visibleCount: visibleRows, includeDraft: false, showToolActions },
      )
      : selectStreamSlice(state, ''),
    Object.is,
  );
  const connectionSlice = usePentacleStreamSelectorWhen(
    isFocused,
    selectPentacleConnectionSlice,
    samePentacleConnectionSlice,
  );
  const transcriptPeerSources = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => (state.events ?? [])
      .filter((event: PentacleEvent) => event.stream_id === streamId)
      .map((event: PentacleEvent) => ({
        id: String(event.optimistic_id || event.daemon_seq),
        sourceStreamId: String(event.raw?.sender || parsePeerAgentMessage(event.text)?.fromStreamId || ''),
      })),
    (left, right) => left.length === right.length && left.every((item, index) => (
      item.id === right[index]?.id && item.sourceStreamId === right[index]?.sourceStreamId
    )),
  );
  const historyLoadState = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => selectStreamEventsLoadState(state, isFocused ? streamId : ''),
    sameStreamEventsLoadState,
  );
  const questionNotifications = usePentacleStreamSelectorWhen(
    isFocused,
    (state) => ((state.notifications ?? []) as PentacleNotification[]).filter(
      (notification) => isAgentQuestionNotification(notification) && agentQuestionStreamId(notification) === streamId,
    ),
    sameNotificationIds,
  );
  const optimisticQuestionAnswerIdentities = usePentacleStreamSelectorWhen(
    isFocused,
    selectOptimisticQuestionAnswerIdentities,
    (left, right) => left.length === right.length && left.every((identity, index) => (
      identity.notificationId === right[index]?.notificationId &&
      identity.questionId === right[index]?.questionId
    )),
  );
  const pendingDurableNotificationIds = useMemo(() => {
    return fullyCoveredOptimisticQuestionNotificationIds(
      questionNotifications,
      optimisticQuestionAnswerIdentities,
    );
  }, [optimisticQuestionAnswerIdentities, questionNotifications]);
  const durableQuestionNotifications = useMemo(
    () => questionNotifications.filter(isOpenAgentQuestionNotification),
    [questionNotifications],
  );
  const authoritativeQuestionAnswerProjections = useMemo(
    () => questionNotifications.flatMap(resolvedDurableQuestionProjections),
    [questionNotifications],
  );
  const {
    connecting: streamConnecting,
    hasHydrated,
    session: selectedSession,
    detail,
    hasOlderHistoryPage,
    specStatuses,
    turn,
    workingState,
    sending,
    sendingImmediate,
    returnedToPromptDraft,
  } = streamSlice;
  useTranscriptQuestionBackfill(streamId, isFocused && connectionSlice.connected, detail?.transcriptItems);
  const historyFetchInFlight = historyLoadState.requestStatus === 'loading' ||
    historyLoadState.requestStatus === 'prefetching';
  const session = selectedSession ?? shellSlice.session;
  const statusOverlayCard = session?.status_card ?? {
    goal: 'Nexus status',
    plan: [],
    update: 'No current Nexus status card.',
    updated_at: session?.last_event_at || new Date(0).toISOString(),
  };
  const transcriptPeerSourceById = useMemo(
    () => new Map(transcriptPeerSources.map((item) => [item.id, item.sourceStreamId])),
    [transcriptPeerSources],
  );
  const directChildForTranscript = useCallback((item: PentacleTranscriptItem): ChildAgent | null => {
    if (session?.role !== 'nexus' || item.eventCase !== 'peer-agent-message' || item.disclosure?.mode !== 'collapsed-preview') return null;
    const senderStreamId = transcriptPeerSourceById.get(item.id);
    return session.agents?.find((child: ChildAgent) => child.stream_id === senderStreamId) ?? null;
  }, [session?.agents, session?.role, transcriptPeerSourceById]);
  useEffect(() => {
    if (!agentThreadTarget) return;
    const current = session?.role === 'nexus'
      ? session.agents?.find((child: ChildAgent) => child.stream_id === agentThreadTarget.child.stream_id && child.session_generation === agentThreadTarget.child.session_generation)
      : undefined;
    if (!current || (agentThreadTarget.parentGeneration && session?.session_generation !== agentThreadTarget.parentGeneration)) {
      setAgentThreadTarget(null);
    }
  }, [agentThreadTarget, session?.agents, session?.role, session?.session_generation]);
  useEffect(() => {
    const routeKey = `${streamId}:${routeAgentHistoryId}:${params.agentHistoryGeneration || ''}`;
    if (!routeAgentHistoryId || historyDeepLinkConsumedRef.current === routeKey || session?.role !== 'nexus') return;
    const child = session.agents?.find((candidate: ChildAgent) => (
      candidate.stream_id === routeAgentHistoryId &&
      (!params.agentHistoryGeneration || candidate.session_generation === params.agentHistoryGeneration)
    ));
    if (!child) return;
    historyDeepLinkConsumedRef.current = routeKey;
    setStatusOverlayOpen(true);
    setAgentThreadTarget({ parentStreamId: streamId, parentGeneration: session.session_generation ?? null, child });
  }, [params.agentHistoryGeneration, routeAgentHistoryId, session?.agents, session?.role, session?.session_generation, streamId]);
  const sessionSendEligible = isPentacleSessionSendEligible(shellSlice.session ?? selectedSession);
  const connecting = streamConnecting || shellSlice.connecting;
  useEffect(() => {
    if (!isFocused || !connectionSlice.connected || !streamId) return;
    void listReports(streamId).then(() => {
      if (params.reports === '1' && !reportsDeepLinkConsumedRef.current) {
        reportsDeepLinkConsumedRef.current = true;
        setReportsVisible(true);
      }
    }).catch(() => undefined);
  }, [connectionSlice.connected, isFocused, params.reports, streamId]);
  const hasQuestionAnswerProjection = Object.keys(questionAnswerProjections).length > 0 || authoritativeQuestionAnswerProjections.length > 0;
  const questionTimelineEvents = usePentacleStreamSelectorWhen(
    isFocused && hasQuestionAnswerProjection,
    (snapshot) => peekEventsForStream(snapshot, streamId),
    (left, right) => left === right || (left.length === right.length && left.every((event, index) => event === right[index])),
  );
  const questionEventTimestamps = useMemo(() => new Map(
    questionTimelineEvents.map((event) => [String(event.daemon_seq), event.timestamp]),
  ), [questionTimelineEvents]);
  const hasOptimisticPending = Boolean(
    detail?.transcriptItems.some((item) => item.pending) ||
    Object.values(questionAnswerProjections).some((projection) => projection.pending),
  );
  const turnBusy = turn.phase === 'pending' || turn.phase === 'working';
  const turnWorking = turn.phase === 'working';
  const daemonWorkingElapsedSeconds = workingState
    ? Math.floor(Math.max(0, workingState.elapsed_ms) / 1000)
    : null;
  // B1: keep the send-handler closure reading the live turn-busy state.
  isWorkingRef.current = turnBusy;
  // Visual working signal only. `turnBusy` still gates the empty-state/loading
  // paths and queue-vs-dispatch decisions; `showWorking` additionally
  // trusts the daemon's authoritative `session.working` flag so the opened detail
  // matches the all-chats list for EVERY working state — thinking / tool-running /
  // pre-reply USER-only transcript — not just mid-response.
  const unresponsive = detail?.status === 'unresponsive';
  const showWorking = !unresponsive && (Boolean(session?.working) || turnWorking);
  const headerStatus = unresponsive ? 'unresponsive' : showWorking ? 'working' : sending ? 'sending' : 'idle';
  const headerStatusLabel = unresponsive ? 'Session unresponsive — tmux did not answer' : undefined;
  const fluidWorkingSeconds = useFluidWorkingSeconds(showWorking ? daemonWorkingElapsedSeconds ?? 0 : null);
  const workingIdentity = `${turn.optimisticId ?? ''}:${turn.sentAt ?? ''}`;
  const handleVisibleHeaderStatusCommit = useCallback((status: 'sending' | 'working') => {
    const optimisticId = turn.optimisticId;
    const matchesTurn = status === 'sending' ? turn.phase === 'pending' : turn.phase === 'working';
    if (!matchesTurn || !optimisticId) return;
    logHarnessHeaderStatusRender(streamId, optimisticId, status);
  }, [streamId, turn.optimisticId, turn.phase]);
  // B1 (send-while-working queue): queued sends normally dispatch to the daemon
  // as soon as their payload is ready, even while the agent is still working, so
  // daemon-side batch-on-idle can hold and flush the FIFO set as one turn. This
  // idle effect remains a defensive fallback for any legacy-held row.
  // Drive the flush only from actual legacy-held presence
  // (sendState='queued' ⇔ turn_queued); durable queued-origin presentation must
  // not trigger a no-op flush on every return to idle.
  const hasHeldSends = Boolean(detail?.transcriptItems.some((item) => item.sendState === 'queued'));
  useEffect(() => {
    if (hasHeldSends && turn.phase === 'idle') {
      actions.flushQueuedSends(streamId);
    }
  }, [hasHeldSends, turn.phase, streamId, actions]);
  useEffect(() => {
    if (interruptRetryIdentity && (!showWorking || interruptRetryIdentity !== workingIdentity)) {
      setInterruptRetryIdentity(null);
    }
  }, [interruptRetryIdentity, showWorking, workingIdentity]);
  useEffect(() => {
    if (!returnedToPromptDraft?.optimisticId) return;
    if (restoredReturnedDraftIdsRef.current.has(returnedToPromptDraft.optimisticId)) return;
    restoredReturnedDraftIdsRef.current.add(returnedToPromptDraft.optimisticId);
    setReturnedDraftPrefill({
      text: returnedToPromptDraft.text,
      token: Date.now(),
    });
  }, [returnedToPromptDraft?.optimisticId, returnedToPromptDraft?.text]);

  // B1 (multi-ESC debounce, D4): issue exactly one `send.interrupt` per working
  // turn. The latch is keyed to the working turn's identity (optimisticId+sentAt),
  // so repeat presses in the same turn no-op and a new working turn re-arms it. A
  // failed interrupt RPC re-arms THIS turn so the user can retry. A daemon-only
  // working session (no local turn) has no optimisticId/sentAt → a stable empty
  // identity (":") that still latches gracefully: one effective interrupt, no
  // re-arm (acceptable — there is no client-held queue in that case), no crash.
  const handleInterruptPress = useCallback(() => {
    const identity = workingIdentity;
    if (escLatchRef.current === identity) return;
    escLatchRef.current = identity;
    setInterruptRetryIdentity(null);
    void actions.interruptSend(streamId)
      .then((result) => {
        if (shouldRetryInterrupt(result)) {
          if (escLatchRef.current === identity) escLatchRef.current = null;
          setInterruptRetryIdentity(identity);
        }
      })
      .catch(() => {
        if (escLatchRef.current === identity) escLatchRef.current = null;
      });
  }, [actions, streamId, workingIdentity]);
  const detailHasHydrated = Boolean(hasHydrated);
  const transcriptRowCount = detail?.transcriptItems.length ?? 0;
  const legacyHasContent = transcriptRowCount > 0 || hasQuestionAnswerProjection;
  const legacyLoaded = historyLoadState.currentGenerationComplete || legacyHasContent || turnBusy || hasOptimisticPending;
  const legacyHydrating = !legacyHasContent && (!legacyLoaded || historyFetchInFlight);
  const chatOpenLoadState = shellSelectorAvailable
    ? selectChatOpenLoadState({
      preview: Boolean(shellSlice.preview),
      retainedRows: shellSlice.retainedRows + (hasQuestionAnswerProjection ? 1 : 0),
      connected: shellSlice.connected,
      request: shellSlice.request,
    })
    : {
      shell: legacyLoaded && !legacyHasContent ? 'empty' as const : 'none' as const,
      list: legacyHasContent ? 'authoritative' as const : 'deferred' as const,
      spinner: legacyHydrating,
      status: legacyHydrating ? 'syncing' as const : legacyHasContent ? 'ready' as const : 'empty' as const,
    };
  const detailIsHydrating = chatOpenLoadState.spinner;
  const isLoadedEmpty = chatOpenLoadState.status === 'empty';
  const emptyStateVisible = isFocused && transcriptReady && isLoadedEmpty;
  const shouldRenderTranscript = isFocused &&
    (transcriptReady || !shellSelectorAvailable) &&
    chatOpenLoadState.list === 'authoritative';
  const transcriptProbeSeqs = (detail?.transcriptItems ?? [])
    .map((item) => item.correlatedDaemonSeq ?? Number(item.id))
    .filter((seq): seq is number => Number.isFinite(seq));
  const transcriptProbeUniqueSeqs = new Set(transcriptProbeSeqs);
  const transcriptProbeSeqsContiguous = transcriptProbeSeqs.length > 0
    && transcriptProbeUniqueSeqs.size === transcriptProbeSeqs.length
    && Math.max(...transcriptProbeSeqs) - Math.min(...transcriptProbeSeqs) + 1 === transcriptProbeSeqs.length;
  transcriptLoadEarlierProbeStateRef.current = {
    streamId,
    shouldRenderTranscript,
    loadingEarlier,
    isAtBottom: isAtBottomRef.current,
    transcriptCount: detail?.transcriptItems.length ?? 0,
    firstSeq: (detail?.transcriptItems[0]?.correlatedDaemonSeq ?? Number(detail?.transcriptItems[0]?.id)) || null,
    lastSeq: (detail?.transcriptItems[detail.transcriptItems.length - 1]?.correlatedDaemonSeq ?? Number(detail?.transcriptItems[detail.transcriptItems.length - 1]?.id)) || null,
    uniqueSeqCount: transcriptProbeUniqueSeqs.size,
    seqsContiguous: transcriptProbeSeqsContiguous,
    remainingCount: detail?.remainingCount ?? 0,
    hasOlderHistoryPage,
  };
  // FEAT-LOAD-RECONNECTING-HINT: while genuinely loading, surface "Reconnecting…"
  // when the socket is down/connecting or the load has been running long (the
  // history fetch keeps retrying with backoff underneath — we never blank out).
  const reconnectingHintVisible = detailIsHydrating &&
    (loadingRunningLong || connectionSlice.connecting || !connectionSlice.connected);
  const chrome = useMemo(() => hostChrome(session?.host || ''), [session?.host]);
  const activeQuestionRenderKey = session?.question ? buildQuestionKey(session.question) : '';
  const activeQuestionAnsweredDurably = !!session?.question && questionNotifications.some(
    (notification) => terminalAgentQuestionMatchesSessionQuestion(notification, session.question),
  );
  const activeQuestionAnsweredOptimistically = !!session?.question && questionNotifications.some(
    (notification) => pendingDurableNotificationIds.has(notification.notification_id) &&
      agentQuestionMatchesSessionQuestion(notification, session.question),
  );
  const activeQuestionHidden = activeQuestionAnsweredDurably || activeQuestionAnsweredOptimistically || !!(
    activeQuestionRenderKey && locallyDismissedQuestionKey === activeQuestionRenderKey
  );
  const durableQuestionCards = useMemo(
    () => durableQuestionNotifications
      .filter((notification) => !locallyResolvedNotificationIds.has(notification.notification_id))
      .map(durableQuestionCardModel)
      .filter((model): model is DurableQuestionCardModel => !!model),
    [durableQuestionNotifications, locallyResolvedNotificationIds],
  );
  const visibleDurableQuestionCards = useMemo(
    () => durableQuestionCards.filter(
      (model) => !pendingDurableNotificationIds.has(model.notification.notification_id),
    ),
    [durableQuestionCards, pendingDurableNotificationIds],
  );
  const questionFlowEntries = useMemo<MobileQuestionEntry<SessionQuestionSource>[]>(() => {
    const paneEntries = session?.question && !activeQuestionHidden
      ? mobileQuestionItems(session.question).map((question, itemIndex) => ({
        key: `pane:${activeQuestionRenderKey}:${itemIndex}`,
        question,
        source: { kind: 'pane' as const, parent: session.question as PentacleQuestion, itemIndex },
        locked: !!(session.question?.scan_incomplete && question.index !== Number(session.question.active_index || 0)),
      }))
      : [];
    const durableEntries = durableQuestionCards.flatMap((model) => mobileQuestionItems(model.question).map((question, itemIndex) => ({
      key: `durable:${model.notification.notification_id}:${itemIndex}`,
      question,
      source: { kind: 'durable' as const, model, itemIndex },
    })));
    return [...paneEntries, ...durableEntries];
  }, [activeQuestionHidden, activeQuestionRenderKey, durableQuestionCards, session?.question]);
  const canonicalQuestionEntries = useMemo(
    () => questionFlowEntries.filter((entry) => (
      entry.source.kind !== 'durable' ||
      !pendingDurableNotificationIds.has(entry.source.model.notification.notification_id)
    )),
    [pendingDurableNotificationIds, questionFlowEntries],
  );
  const questionFlow = useMobileQuestionFlow(questionFlowEntries);
  const visibleUnansweredQuestionCount = canonicalQuestionEntries.filter(
    (entry) => !questionFlow.answered.has(entry.key),
  ).length;
  const visibleQuestionFlow = {
    ...questionFlow,
    unansweredCount: visibleUnansweredQuestionCount,
    allAnswered: canonicalQuestionEntries.length > 0 && visibleUnansweredQuestionCount === 0,
  };
  const activeQuestionPageIndex = Math.min(questionPageIndex, Math.max(0, canonicalQuestionEntries.length - 1));
  const questionPagerIdentity = canonicalQuestionEntries.map((entry) => entry.key).join('|');

  useEffect(() => {
    if (!isFocused || !streamId) return undefined;
    logHarnessUiTrace('session_screen_mount', {
      stream_id: streamId,
      route_focused: isFocused,
    });
    return () => {
      logHarnessUiTrace('session_screen_unmount', {
        stream_id: streamId,
      });
    };
  }, [isFocused, streamId]);

  useEffect(() => {
    if (!isFocused || !streamId) return;
    logHarnessUiTrace('session_screen_render_state', {
      stream_id: streamId,
      transcript_count: transcriptRowCount,
      visible_rows: visibleRows,
      detail_is_hydrating: detailIsHydrating,
      transcript_ready: transcriptReady,
      history_fetch_in_flight: historyFetchInFlight,
      history_coverage_complete: historyLoadState.currentGenerationComplete,
      history_coverage_fresh: historyLoadState.fresh,
      history_request_status: historyLoadState.requestStatus,
      has_older_history_page: hasOlderHistoryPage,
      should_render_transcript: shouldRenderTranscript,
      empty_state_visible: emptyStateVisible,
      turn_phase: turn.phase,
      working: showWorking,
      sending,
      sending_immediate: sendingImmediate,
      has_optimistic_pending: hasOptimisticPending,
      latest_event_at: detail?.latestEventAt ?? null,
      session_last_event_at: session?.last_event_at ?? null,
    });
  }, [
    detail?.latestEventAt,
    detailIsHydrating,
    emptyStateVisible,
    hasOlderHistoryPage,
    hasOptimisticPending,
    historyFetchInFlight,
    historyLoadState,
    isFocused,
    sending,
    sendingImmediate,
    session?.last_event_at,
    shellSlice.preview?.key,
    shellSlice.request,
    shellSlice.retainedRows,
    shouldRenderTranscript,
    showWorking,
    streamId,
    transcriptReady,
    transcriptRowCount,
    turn.phase,
    visibleRows,
  ]);

  useEffect(() => {
    setQuestionPageIndex(0);
  }, [questionPagerIdentity]);

  useEffect(() => {
    const nextIndex = Math.min(questionPageIndex, Math.max(0, canonicalQuestionEntries.length - 1));
    if (nextIndex !== questionPageIndex) setQuestionPageIndex(nextIndex);
    if (canonicalQuestionEntries.length === 0) setQuestionOverlayOpen(false);
  }, [canonicalQuestionEntries.length, questionPageIndex]);

  // Harness-only: scenarios armed with `auto_open_question_overlay` get the
  // user-equivalent question-FAB press as soon as unanswered questions exist.
  // The redesigned question surface renders inside the full-screen overlay,
  // so telemetry-await scenarios (`question:card_rendered`) need this
  // deterministic open. Mirrors the
  // QuestionFab onPress exactly; production bundles dead-code the branch
  // (harnessRuntime is null without EXPO_PUBLIC_HARNESS).
  useEffect(() => {
    if (!harnessRuntime?.hasAction('auto_open_question_overlay')) return;
    if (questionOverlayOpen || canonicalQuestionEntries.length === 0) return;
    setQuestionPageIndex(0);
    setQuestionSubmitError(null);
    setQuestionOverlayOpen(true);
  }, [canonicalQuestionEntries.length, questionOverlayOpen]);

  const beginQuestionAnswerProjection = useCallback((
    source: 'pane' | 'durable',
    key: string,
    text: string,
    notificationId?: string,
    childCount?: number,
  ) => {
    const attemptId = ++nextQuestionAnswerAttemptIdRef.current;
    setQuestionAnswerProjections((current) => ({
      ...current,
      [key]: {
        key,
        attemptId,
        source,
        text,
        answeredAt: new Date().toISOString(),
        pending: true,
        ...(notificationId ? { notificationId } : {}),
        ...(childCount ? { childCount } : {}),
      },
    }));
    return attemptId;
  }, []);
  const settleQuestionAnswerProjection = useCallback((key: string, attemptId: number) => {
    setQuestionAnswerProjections((current) => {
      const projection = current[key];
      if (projection?.attemptId !== attemptId) return current;
      return { ...current, [key]: { ...projection, pending: false } };
    });
  }, []);
  const discardQuestionAnswerProjection = useCallback((key: string, attemptId: number) => {
    setQuestionAnswerProjections((current) => {
      if (current[key]?.attemptId !== attemptId) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  // Reconcile settled in-chat durable answers against a terminal replay failure:
  // when a notification surfaces `client_resolution_error`, drop its stale
  // optimistic row so the transcript stops showing a phantom answer and the
  // question card can re-appear for a manual re-answer.
  // (spec_pentacle_mobile__durable_question_optimistic_row_on_resolve_failure)
  useEffect(() => {
    const staleKeys = failedDurableAnswerProjectionKeys(questionAnswerProjections, questionNotifications);
    if (staleKeys.length === 0) return;
    setQuestionAnswerProjections((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of staleKeys) {
        if (next[key]) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [questionAnswerProjections, questionNotifications]);

  useEffect(() => {
    if (!session?.question) {
      setLocallyDismissedQuestionKey(null);
      setQuestionSubmitError(null);
    }
  }, [session?.question]);

  const submitQuestionAnswer = useCallback(async (answers: PentacleQuestionAnswerValue[], answeredQuestion?: PentacleQuestion) => {
    if (!session?.question) return false;
    const formatQuestion = answeredQuestion || session.question;
    const questionKey = serverQuestionKey(session.question);
    if (!questionKey) {
      setQuestionSubmitError('Question is missing its server key. Reopen the chat and try again.');
      return false;
    }
    let answerText = '';
    try {
      answerText = buildPentacleQuestionAnswerText({ question: formatQuestion, answers });
    } catch (err) {
      setQuestionSubmitError(err instanceof Error ? err.message : 'Question answer could not be formatted.');
      return false;
    }
    const withNotesCount = answers.filter((answer) => typeof answer.note === 'string' && answer.note.trim()).length;
    const bugRef = withNotesCount > 0
      ? TRACKD_BUG5_NOTES
      : (answers.some((answer) => Array.isArray(answer.selectedOptionIndices)) ? TRACKD_BUG3_MULTISELECT : TRACKD_BUG1_SUBMIT);
    const baseTelemetry = {
      stream_id: streamId,
      host: session.host,
      session_name: session.session_name,
      subsystem: QUESTION_FLOW_SUBSYSTEM,
      bug_ref: bugRef,
      answer_count: answers.length,
      with_notes_count: withNotesCount,
    };
    const projectionKey = `pane:${streamId}`;
    const projectionAttemptId = beginQuestionAnswerProjection('pane', projectionKey, answerText);
    setQuestionSubmitError(null);
    setQuestionSubmitting(true);
    const optimisticId = actions.beginOptimisticQuestionAnswer({ streamId, text: answerText });
    if (!optimisticId) {
      discardQuestionAnswerProjection(projectionKey, projectionAttemptId);
      setQuestionSubmitting(false);
      setQuestionSubmitError('Question answer could not be queued. Try again.');
      return false;
    }
    setQuestionOverlayOpen(false);
    logTelemetry(QUESTION_ANSWER_SUBMIT_ATTEMPT, baseTelemetry);
    try {
      await questionDispatchWithTimeout(actions.dismissQuestion({
        host: session.host,
        sessionName: session.session_name,
        questionKey,
      }));
      setLocallyDismissedQuestionKey(activeQuestionRenderKey);
    } catch (err) {
      const message = String((err as Error)?.message || err || 'answer_not_delivered');
      const errorCode = String((err as { errorCode?: string })?.errorCode || '');
      if (errorCode !== 'stale_question') {
        actions.discardOptimisticQuestionAnswer(optimisticId);
        discardQuestionAnswerProjection(projectionKey, projectionAttemptId);
        setLocallyDismissedQuestionKey(null);
        setQuestionOverlayOpen(true);
        setQuestionSubmitError(errorCode === 'question_dismiss_failed'
          ? 'Question was not dismissed. Try again.'
          : 'Question submit failed. Try again.');
        logTelemetry(QUESTION_ANSWER_SUBMIT_FAILED, {
          ...baseTelemetry,
          error: message,
          error_code: errorCode,
          retryable: true,
        });
        setQuestionSubmitting(false);
        return false;
      }
      setLocallyDismissedQuestionKey(activeQuestionRenderKey);
    }
    try {
      await questionDispatchWithTimeout(actions.sendMessage({
        host: session.host,
        sessionName: session.session_name,
        text: answerText,
        optimisticId,
      }));
      settleQuestionAnswerProjection(projectionKey, projectionAttemptId);
      logTelemetry(QUESTION_ANSWER_SUBMIT_SENT, baseTelemetry);
      return true;
    } catch (err) {
      discardQuestionAnswerProjection(projectionKey, projectionAttemptId);
      const message = String((err as Error)?.message || err || 'answer_not_delivered');
      const errorCode = String((err as { errorCode?: string })?.errorCode || '');
      setQuestionSubmitError('Answer could not be sent. Retry it from the transcript.');
      logTelemetry(QUESTION_ANSWER_SUBMIT_FAILED, {
        ...baseTelemetry,
        error: message,
        error_code: errorCode,
        retryable: true,
      });
      return true;
    } finally {
      setQuestionSubmitting(false);
    }
  }, [actions, activeQuestionRenderKey, beginQuestionAnswerProjection, discardQuestionAnswerProjection, session, settleQuestionAnswerProjection, streamId]);

  const submitDurableQuestionAnswer = useCallback(async (
    model: DurableQuestionCardModel,
    item: DurableQuestionItemModel,
    answers: MobileQuestionAnswer[],
  ) => {
    const answer = answers[0] || {};
    const questionId = item.questionId;
    let resolution;
    try {
      resolution = buildDurableQuestionResolution(model, item, answer);
    } catch (error) {
      setQuestionSubmitError(String((error as Error)?.message || error));
      return false;
    }
    const optimisticText = buildDurableQuestionAnswerText({
      notificationId: resolution.notification_id,
      actionKind: resolution.action_kind,
      ...(questionId ? { questionId } : {}),
      ...(resolution.text ? { text: resolution.text } : {}),
      ...(resolution.selections ? { selections: durableQuestionDisplaySelections(item, answer) } : {}),
      ...(resolution.custom_text ? { customText: resolution.custom_text } : {}),
      ...(resolution.note ? { note: resolution.note } : {}),
    });
    const itemIndex = Math.max(0, model.items.indexOf(item));
    const projectionKey = durableAnswerProjectionKey(model.notification.notification_id, item, itemIndex);
    const projectionAttemptId = beginQuestionAnswerProjection(
      'durable',
      projectionKey,
      optimisticText,
      resolution.notification_id,
      model.items.length,
    );
    const optimisticId = actions.beginOptimisticQuestionAnswer({
      streamId,
      text: optimisticText,
      notificationId: resolution.notification_id,
      ...(questionId ? { questionId } : {}),
    });
    if (!optimisticId) {
      discardQuestionAnswerProjection(projectionKey, projectionAttemptId);
      setQuestionSubmitError('Question answer could not be queued. Try again.');
      return false;
    }
    setQuestionSubmitError(null);
    setQuestionSubmitting(true);
    setQuestionOverlayOpen(false);
    try {
      if (!questionId) throw new Error('Question is missing its durable prompt identity.');
      await questionDispatchWithTimeout(actions.answerPrompt({
        questionId,
        ...(resolution.selections ? { selections: resolution.selections } : {}),
        ...(resolution.text || resolution.custom_text || resolution.note
          ? { text: resolution.text || resolution.custom_text || resolution.note }
          : {}),
      }));
      actions.queueOptimisticQuestionAnswer(optimisticId);
      settleQuestionAnswerProjection(projectionKey, projectionAttemptId);
      return true;
    } catch (err) {
      actions.discardOptimisticQuestionAnswer(optimisticId);
      discardQuestionAnswerProjection(projectionKey, projectionAttemptId);
      setQuestionOverlayOpen(true);
      setQuestionSubmitError(String((err as Error)?.message || err || 'Question answer could not be submitted.'));
      return false;
    } finally {
      setQuestionSubmitting(false);
    }
  }, [actions, beginQuestionAnswerProjection, discardQuestionAnswerProjection, settleQuestionAnswerProjection, streamId]);

  const submitAllQuestionAnswers = useCallback(async () => {
    if (!visibleQuestionFlow.allAnswered || questionSubmissionInFlightRef.current) return;
    questionSubmissionInFlightRef.current = true;
    try {
      setQuestionSubmitError(null);
      const paneEntries = canonicalQuestionEntries.filter((entry) => entry.source.kind === 'pane');
      if (paneEntries.length > 0 && session?.question) {
        const answers = paneEntries
          .sort((a, b) => a.source.itemIndex - b.source.itemIndex)
          .map((entry) => {
            const answer = questionFlow.answerFor(entry);
            if (answer.customText && answer.selectedOptionIndex === undefined && !answer.selectedOptionIndices?.length) {
              return { text: answer.customText };
            }
            return answer;
          });
        const paneOk = await submitQuestionAnswer(answers, session.question);
        if (!paneOk) return;
      }
      for (const model of visibleDurableQuestionCards) {
        const entries = canonicalQuestionEntries.filter(
          (entry) => entry.source.kind === 'durable' && entry.source.model === model,
        );
        for (const entry of entries) {
          if (entry.source.kind !== 'durable') continue;
          const item = model.items[entry.source.itemIndex];
          const durableOk = await submitDurableQuestionAnswer(model, item, [questionFlow.answerFor(entry)]);
          if (!durableOk) return;
        }
        setLocallyResolvedNotificationIds((current) => new Set(current).add(model.notification.notification_id));
      }
      setQuestionOverlayOpen(false);
    } finally {
      questionSubmissionInFlightRef.current = false;
    }
  }, [canonicalQuestionEntries, questionFlow, session?.question, submitDurableQuestionAnswer, submitQuestionAnswer, visibleDurableQuestionCards, visibleQuestionFlow.allAnswered]);

  const cancelDurableQuestion = useCallback(async (model: DurableQuestionCardModel) => {
    setQuestionSubmitError(null);
    setQuestionSubmitting(true);
    try {
      await actions.resolveNotification({
        notification_id: model.notification.notification_id,
        action_kind: 'resolved',
      });
      setLocallyResolvedNotificationIds((current) => new Set(current).add(model.notification.notification_id));
    } catch (err) {
      setQuestionSubmitError(String((err as Error)?.message || err || 'Question cancel failed. Try again.'));
    } finally {
      setQuestionSubmitting(false);
    }
  }, [actions]);

  const cancelQuestion = useCallback(async () => {
    if (!session?.question) return;
    const questionKey = serverQuestionKey(session.question);
    if (!questionKey) {
      setQuestionSubmitError('Question is missing its server key. Reopen the chat and try again.');
      return;
    }
    const baseTelemetry = {
      stream_id: streamId,
      host: session.host,
      session_name: session.session_name,
      subsystem: QUESTION_FLOW_SUBSYSTEM,
      bug_ref: TRACKD_BUG1_SUBMIT,
      answer_count: 0,
      with_notes_count: 0,
    };
    setQuestionSubmitError(null);
    setQuestionSubmitting(true);
    logTelemetry(QUESTION_ANSWER_SUBMIT_ATTEMPT, baseTelemetry);
    try {
      await actions.dismissQuestion({
        host: session.host,
        sessionName: session.session_name,
        questionKey,
      });
      setLocallyDismissedQuestionKey(activeQuestionRenderKey);
      logTelemetry(QUESTION_ANSWER_SUBMIT_SENT, baseTelemetry);
    } catch (err) {
      const message = String((err as Error)?.message || err || 'question_cancel_failed');
      const errorCode = String((err as { errorCode?: string })?.errorCode || '');
      if (errorCode === 'stale_question') {
        setLocallyDismissedQuestionKey(activeQuestionRenderKey);
        setQuestionSubmitError(null);
      } else if (errorCode === 'question_dismiss_failed') {
        setQuestionSubmitError('Question was not dismissed. Try again.');
      } else {
        setQuestionSubmitError('Question cancel failed. Try again.');
      }
      logTelemetry(QUESTION_ANSWER_SUBMIT_FAILED, {
        ...baseTelemetry,
        error: message,
        error_code: errorCode,
        retryable: errorCode === 'question_dismiss_failed',
      });
    } finally {
      setQuestionSubmitting(false);
    }
  }, [actions, activeQuestionRenderKey, session, streamId]);
  const transcriptData = useMemo(() => {
    const authoritativeItems = authoritativeQuestionAnswerProjections.map((projection) =>
      sessionQuestionProjectionItem({ ...projection, pending: false }));
    const authoritativeKeys = new Set(authoritativeQuestionAnswerProjections.map((projection) => projection.key));
    // The daemon also echoes each answer back into the producer's stream as a tell, which the
    // transcript projects as its own `agent-question-answer` row. That row and the authoritative
    // projection are the SAME answer, so rendering both is the duplicate this lane exists to
    // remove; prefer the authoritative one (built from the durable notification) and drop the echo.
    //
    // Suppress ONLY when every child of the notification is authoritatively projected. The echo
    // carries no child identity, so under partial coverage — one child answered, another not, or
    // a child dropped by resolvedDurableQuestionProjections' sparse-answer guard — dropping it
    // could hide the only representation of an answer. Over-showing is recoverable; hiding is not.
    const fullyCoveredNotificationIds = fullyCoveredAnswerNotificationIds(
      authoritativeQuestionAnswerProjections,
    );
    const projectionTexts = new Set(Object.values(questionAnswerProjections).map((projection) => projection.text));
    const fullyCoveredLocalNotificationIds = fullyCoveredAnswerNotificationIds(
      Object.values(questionAnswerProjections),
    );
    const normalizedDetailItems = (detail?.transcriptItems ?? []).map(formatNotificationAnswerTellItem);
    const detailItemsWithoutLocalEchoes = suppressLocalQuestionAnswerEchoes(normalizedDetailItems.filter((item) => !(
      item.isUser && item.pending && projectionTexts.has(item.text)
    )), fullyCoveredLocalNotificationIds);
    const detailItems = detailItemsWithoutLocalEchoes.filter((item) => !(
      item.eventCase === 'agent-question-answer' &&
      item.notificationId &&
      fullyCoveredNotificationIds.has(item.notificationId)
    ));
    const userTexts = new Set(detailItems
      .filter((item) => item.isUser)
      .map((item) => item.text));
    const optimisticItems = Object.values(questionAnswerProjections)
      .filter((projection) => !authoritativeKeys.has(projection.key))
      .filter((projection) => projection.source !== 'pane' || !userTexts.has(projection.text))
      .map(sessionQuestionProjectionItem);
    return orderSessionTranscriptRows(detailItems, [...authoritativeItems, ...optimisticItems], normalizedDetailItems, questionEventTimestamps);
  }, [authoritativeQuestionAnswerProjections, detail?.transcriptItems, questionAnswerProjections, questionEventTimestamps]);
  useEffect(() => {
    const correlationId = chatOpenCorrelationIdRef.current;
    const firstAuthoritative = transcriptData.find((item) => !String(item.id).startsWith('fallback:'));
    if (!correlationId || !firstAuthoritative || chatOpenAuthoritativeRowPaintedForRef.current === correlationId) return;
    chatOpenAuthoritativeRowPaintedForRef.current = correlationId;
    markChatOpenFirstAuthoritativeRowMounted(correlationId, streamId);
  }, [streamId, transcriptData]);
  const recordChatOpenShellLayout = useCallback(() => {
    const correlationId = chatOpenCorrelationIdRef.current;
    if (!correlationId || chatOpenShellPaintedForRef.current === correlationId) return;
    chatOpenShellPaintedForRef.current = correlationId;
    markChatOpenShellLayoutCommitted(correlationId, streamId);
  }, [streamId]);
  // Anchor probes require positive full visibility. A partially clipped newest
  // row must not certify bottom-follow after a late height expansion.
  const transcriptViewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 100 }), []);
  const onTranscriptViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const visible = viewableItems.find((entry) => entry.isViewable && entry.item) ?? viewableItems[0];
    const item = visible?.item as PentacleTranscriptItem | undefined;
    transcriptVisibleAnchorRef.current = item
      ? {
        id: item.id ?? null,
        seq: item.correlatedDaemonSeq ?? (Number(item.id) || null),
        index: typeof visible.index === 'number' ? visible.index : null,
      }
      : null;
  }).current;
  const logTranscriptAnchorSample = useCallback((phase: string) => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !streamId) return;
    const anchor = transcriptVisibleAnchorRef.current;
    const seqs = transcriptData
      .map((item) => item.correlatedDaemonSeq ?? Number(item.id))
      .filter((seq): seq is number => Number.isFinite(seq));
    const uniqueSeqs = new Set(seqs);
    logHarnessUiTrace('transcript_anchor_sample', {
      stream_id: streamId,
      phase,
      offset: transcriptScrollOffsetRef.current,
      anchor_id: anchor?.id ?? null,
      anchor_seq: anchor?.seq ?? null,
      anchor_index: anchor?.index ?? null,
      anchor_min_visible_percent: 100,
      transcript_count: transcriptData.length,
      first_seq: transcriptData[0]?.correlatedDaemonSeq ?? null,
      last_seq: transcriptData[transcriptData.length - 1]?.correlatedDaemonSeq ?? null,
      unique_seq_count: uniqueSeqs.size,
      seqs_contiguous: seqs.length > 0 && uniqueSeqs.size === seqs.length
        && Math.max(...seqs) - Math.min(...seqs) + 1 === seqs.length,
      is_at_bottom: isAtBottomRef.current,
    });
  }, [streamId, transcriptData]);

  const handleLoadEarlier = useCallback(() => {
    const loadedRemaining = detail?.remainingCount || 0;
    if ((!loadedRemaining && !hasOlderHistoryPage) || loadingEarlier) return;
    probeFocusedLiveness('pull');
    setLoadingEarlier(true);
    logTranscriptAnchorSample('before_load_earlier');
    if (loadedRemaining > 0) {
      requestAnimationFrame(() => {
        setVisibleRows((current) => current + Math.min(TRANSCRIPT_PAGE_ROWS, loadedRemaining));
        setTimeout(() => {
          setLoadingEarlier(false);
          logTranscriptAnchorSample('after_load_earlier');
        }, 160);
      });
      return;
    }
    void requestStreamEvents(streamId, TRANSCRIPT_PAGE_ROWS, {
      purpose: 'older-page',
      entrySource: openEntrySourceRef.current,
    })
      .then((events) => {
        const addedRows = Array.isArray(events) ? events.length : 0;
        if (addedRows > 0) {
          setVisibleRows((current) => current + Math.max(addedRows, TRANSCRIPT_PAGE_ROWS));
        }
        logHarnessUiTrace('transcript_load_earlier_fetch_result', {
          stream_id: streamId,
          requested_rows: TRANSCRIPT_PAGE_ROWS,
          received_rows: addedRows,
          empty_or_short: addedRows < TRANSCRIPT_PAGE_ROWS,
        });
      })
      .catch((err) => {
        logHarnessUiTrace('transcript_load_earlier_fetch_failed', {
          stream_id: streamId,
          error: String(err?.message || err),
        });
      })
      .finally(() => {
        setTimeout(() => {
          setLoadingEarlier(false);
          logTranscriptAnchorSample('after_load_earlier');
        }, 160);
      });
  }, [detail?.remainingCount, hasOlderHistoryPage, loadingEarlier, logTranscriptAnchorSample, streamId]);
  handleLoadEarlierRef.current = handleLoadEarlier;
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !isFocused || !streamId) return;
    if (!harnessRuntime.hasAction('transcript_load_earlier_probe')) return;
    let cancelled = false;
    const targetCount = Math.max(1, Number(harnessRuntime.getParam('load_earlier_count') || 1) || 1);
    const waitForScrollUp = harnessRuntime.getParam('load_earlier_wait_for_scroll_up') === '1';
    function clearProbeTimer() {
      if (transcriptLoadEarlierProbeTimerRef.current) {
        clearTimeout(transcriptLoadEarlierProbeTimerRef.current);
        transcriptLoadEarlierProbeTimerRef.current = null;
      }
    }
    function schedule(delayMs: number) {
      clearProbeTimer();
      transcriptLoadEarlierProbeTimerRef.current = setTimeout(tick, delayMs);
    }
    function finish(status: 'done' | 'no_remaining') {
      clearProbeTimer();
      const current = transcriptLoadEarlierProbeStateRef.current;
      logHarnessUiTrace('transcript_load_earlier_probe_done', {
        stream_id: streamId,
        status,
        load_count: transcriptProbeLoadCountRef.current,
        transcript_count: current.transcriptCount,
        first_seq: current.firstSeq,
        last_seq: current.lastSeq,
        unique_seq_count: current.uniqueSeqCount,
        seqs_contiguous: current.seqsContiguous,
        remaining_count: current.remainingCount,
        has_older_history_page: current.hasOlderHistoryPage,
        anchor_mode: status === 'done' ? 'maintain_visible_content_position' : undefined,
      });
    }
    function tick() {
      if (cancelled) return;
      const current = transcriptLoadEarlierProbeStateRef.current;
      if (current.streamId !== streamId || !current.shouldRenderTranscript || current.loadingEarlier) {
        schedule(80);
        return;
      }
      if (waitForScrollUp && (current.isAtBottom || !transcriptScrollAnchorReadyRef.current)) {
        schedule(80);
        return;
      }
      if (transcriptProbeLoadCountRef.current >= targetCount) {
        finish('done');
        return;
      }
      if (!current.remainingCount && !current.hasOlderHistoryPage) {
        finish('no_remaining');
        return;
      }
      transcriptProbeLoadCountRef.current += 1;
      logHarnessUiTrace('transcript_load_earlier_probe_step', {
        stream_id: streamId,
        load_count: transcriptProbeLoadCountRef.current,
        before_count: current.transcriptCount,
        first_seq: current.firstSeq,
        last_seq: current.lastSeq,
        unique_seq_count: current.uniqueSeqCount,
        seqs_contiguous: current.seqsContiguous,
        remaining_count: current.remainingCount,
        has_older_history_page: current.hasOlderHistoryPage,
      });
      handleLoadEarlierRef.current();
      schedule(260);
    }
    schedule(80);
    return () => {
      cancelled = true;
      clearProbeTimer();
    };
  }, [isFocused, streamId]);
	  // Bottom-follow probe: samples the REAL contentOffset and top viewable row after the
	  // transcript grows, with the viewport left where it is. The scroll-anchor probe above
	  // cannot cover this — it scrolls up first, and its sampling effect bails while
	  // isAtBottomRef is true — so pinned-to-bottom follow had no on-surface instrument.
	  useEffect(() => {
	    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !isFocused || !streamId) return;
	    if (!harnessRuntime.hasAction('transcript_bottom_follow_probe')) return;
	    if (!shouldRenderTranscript || !transcriptData.length) return;
	    // Several samples, not one: the follow is an ANIMATED scroll, so a single early sample
	    // can catch the viewport mid-flight and read as a follow failure. The last sample wins
	    // (the reader waits for quiet), so the settled value is the one that gets asserted.
	    const timers = [240, 700, 1200].map((delay) => setTimeout(
	      () => logTranscriptAnchorSample('bottom_follow'),
	      delay,
	    ));
	    return () => timers.forEach(clearTimeout);
	  }, [isFocused, logTranscriptAnchorSample, shouldRenderTranscript, streamId, transcriptData]);
	  useEffect(() => {
	    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !isFocused || !streamId) return;
	    if (!harnessRuntime.hasAction('transcript_bottom_follow_probe')) return;
	    if (harnessRuntime.getParam('expand_live_append') !== '1') return;
	    const liveSeq = Number(harnessRuntime.getParam('live_append_seq') || 0);
	    const liveRow = transcriptData.find((item) => (item.correlatedDaemonSeq ?? Number(item.id)) === liveSeq);
	    if (!liveRow || harnessExpandedRowId === liveRow.id) return;
	    const timer = setTimeout(() => {
	      setHarnessExpandedRowId(liveRow.id);
	      logHarnessUiTrace('transcript_live_row_expanded', { stream_id: streamId, seq: liveSeq });
	    }, 360);
	    return () => clearTimeout(timer);
	  }, [harnessExpandedRowId, isFocused, streamId, transcriptData]);
	  useEffect(() => {
	    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !isFocused || !streamId) return;
	    if (!harnessRuntime.hasAction('transcript_scroll_anchor_probe')) return;
	    if (!shouldRenderTranscript || transcriptProbeScrolledRef.current || transcriptData.length < 8) return;
	    transcriptProbeScrolledRef.current = true;
	    const offset = Math.max(3, Number(harnessRuntime.getParam('scroll_up_offset') || 420) || 420);
	    const attemptScroll = (remaining: number) => {
	      setAtBottom(false);
	      transcriptRef.current?.scrollToOffset({ offset, animated: false });
	      logHarnessUiTrace('transcript_anchor_configured', {
	        stream_id: streamId,
	        offset,
	        anchor_mode: 'maintain_visible_content_position',
	        transcript_count: transcriptData.length,
	      });
	      setTimeout(() => {
	        logTranscriptAnchorSample('scroll_up_after');
	        if (!isAtBottomRef.current && transcriptScrollOffsetRef.current > NEAR_BOTTOM_OFFSET) {
	          transcriptScrollAnchorReadyRef.current = true;
	        } else if (remaining > 1) {
	          setTimeout(() => attemptScroll(remaining - 1), 200);
	        }
	      }, 120);
	    };
	    setTimeout(() => attemptScroll(8), 80);
	  }, [isFocused, logTranscriptAnchorSample, shouldRenderTranscript, streamId, transcriptData, setAtBottom]);
	  useEffect(() => {
	    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !isFocused || !streamId) return;
	    if (!harnessRuntime.hasAction('transcript_scroll_anchor_probe')) return;
	    if (!transcriptProbeScrolledRef.current || isAtBottomRef.current) return;
	    const liveSeq = Number(harnessRuntime.getParam('live_append_seq') || 0);
	    const liveVisible = liveSeq > 0 && transcriptData.some((item) => (item.correlatedDaemonSeq ?? Number(item.id)) === liveSeq);
	    if (liveVisible && transcriptLiveVisibleSeqRef.current !== liveSeq) {
	      transcriptLiveVisibleSeqRef.current = liveSeq;
	      logHarnessUiTrace('transcript_live_append_visible', {
	        stream_id: streamId,
	        seq: liveSeq,
	        transcript_count: transcriptData.length,
	      });
	      if (transcriptLiveAnchorSampleTimerRef.current) clearTimeout(transcriptLiveAnchorSampleTimerRef.current);
	      transcriptLiveAnchorSampleTimerRef.current = setTimeout(() => {
	        transcriptLiveAnchorSampleTimerRef.current = null;
	        logTranscriptAnchorSample('anchored_transcript_update');
	      }, 80);
	      return;
	    }
	    if (transcriptLiveAnchorSampleCountRef.current >= 24) return;
	    if (transcriptLiveAnchorSampleTimerRef.current) return;
	    transcriptLiveAnchorSampleCountRef.current += 1;
	    transcriptLiveAnchorSampleTimerRef.current = setTimeout(() => {
	      transcriptLiveAnchorSampleTimerRef.current = null;
	      logTranscriptAnchorSample('anchored_transcript_update');
	    }, 80);
	  }, [isFocused, logTranscriptAnchorSample, streamId, transcriptData.length, transcriptData[0]?.id, transcriptData[transcriptData.length - 1]?.id]);
  useEffect(() => () => {
    if (transcriptLiveAnchorSampleTimerRef.current) {
      clearTimeout(transcriptLiveAnchorSampleTimerRef.current);
      transcriptLiveAnchorSampleTimerRef.current = null;
    }
  }, [streamId]);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !isFocused || !streamId) return;
    if (!harnessRuntime.hasAction('transcript_switch_probe')) return;
    if (!shouldRenderTranscript || transcriptData.length < 8) return;
    const nextStreamId = harnessRuntime.getParam('switch_stream_id');
    const returnStreamId = harnessRuntime.getParam('return_stream_id');
    const switchState = transcriptSwitchProbeState;
    if (nextStreamId && streamId !== nextStreamId && !switchState.navigated) {
      switchState.navigated = true;
      logHarnessUiTrace('transcript_switch_probe_step', {
        stream_id: streamId,
        next_stream_id: nextStreamId,
        phase: 'to_next',
        transcript_count: transcriptData.length,
        stream_identity_match_count: transcriptData.filter((item) => item.eventKey?.startsWith(`${streamId}:`)).length,
        stream_identity_mismatch_count: transcriptData.filter((item) => !item.eventKey?.startsWith(`${streamId}:`)).length,
      });
      setTimeout(() => {
        router.push(`/pentacle/session/${encodeURIComponent(nextStreamId)}` as any);
      }, 120);
      return;
    }
    if (returnStreamId && nextStreamId && streamId === nextStreamId && !switchState.returned) {
      switchState.returned = true;
      setTimeout(() => {
        logHarnessUiTrace('transcript_switch_probe_step', {
          stream_id: streamId,
          next_stream_id: returnStreamId,
          phase: 'return',
          transcript_count: transcriptData.length,
          stream_identity_match_count: transcriptData.filter((item) => item.eventKey?.startsWith(`${streamId}:`)).length,
          stream_identity_mismatch_count: transcriptData.filter((item) => !item.eventKey?.startsWith(`${streamId}:`)).length,
        });
        router.push(`/pentacle/session/${encodeURIComponent(returnStreamId)}` as any);
      }, 120);
      return;
    }
    const doneKey = `${streamId}:${switchState.navigated}:${switchState.returned}`;
    if (switchState.doneStreams.has(doneKey)) return;
    switchState.doneStreams.add(doneKey);
    logHarnessUiTrace('transcript_switch_probe_done', {
      stream_id: streamId,
      switched: switchState.navigated,
      returned: switchState.returned,
      transcript_count: transcriptData.length,
      stream_identity_match_count: transcriptData.filter((item) => item.eventKey?.startsWith(`${streamId}:`)).length,
      stream_identity_mismatch_count: transcriptData.filter((item) => !item.eventKey?.startsWith(`${streamId}:`)).length,
    });
  }, [isFocused, router, shouldRenderTranscript, streamId, transcriptData]);
  useEffect(() => {
    latestTopTranscriptIdRef.current = transcriptData[0]?.id ?? null;
  }, [transcriptData]);
  useEffect(() => {
    if (!isFocused || !streamId) return;
    const rowOrder = transcriptData.map((item) => ({
      id: item.id,
      seq: item.correlatedDaemonSeq ?? (Number(item.id) || null),
      pending: !!item.pending,
      send_state: item.sendState ?? null,
    }));
    logHarnessUiTrace('transcript_list_update', {
      stream_id: streamId,
      data_count: transcriptData.length,
      visible_rows: visibleRows,
      first_row_id: transcriptData[0]?.id ?? null,
      last_row_id: transcriptData[transcriptData.length - 1]?.id ?? null,
      first_seq: transcriptData[0]?.correlatedDaemonSeq ?? null,
      last_seq: transcriptData[transcriptData.length - 1]?.correlatedDaemonSeq ?? null,
      pending_count: transcriptData.filter((item) => item.pending).length,
      queued_count: transcriptData.filter((item) => item.sendState === 'queued').length,
      row_order: rowOrder,
    });
    if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime?.isArmed()) {
      const orderId = `${Date.now()}-${++transcriptOrderGeneration}`;
      for (const { kind, ...chunk } of transcriptOrderChunks(streamId, orderId, rowOrder.map(row => String(row.id)))) {
        logHarnessUiTrace(kind, chunk);
      }
    }
  }, [isFocused, streamId, transcriptData, visibleRows]);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed() || !streamId) return;
    if (harnessRuntime.hasAction('composite_chat_load_probe')) return;
    const scenarioRunId = getHarnessScenarioRunId();
    if (!scenarioRunId) return;
    const items = detail?.transcriptItems || [];
    logTelemetry(HARNESS_TRANSCRIPT_ORDER_DUMP, {
      scenario_run_id: scenarioRunId,
      stream_id: streamId,
      transcript_count: items.length,
      transcript_ids: items.map((item) => item.id),
      transcript_seq_order: items
        .map((item) => item.correlatedDaemonSeq ?? Number(item.id))
        .filter((seq) => Number.isFinite(seq)),
    });
  }, [detail?.transcriptItems, streamId]);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed()) return;
    if (!harnessRuntime.hasAction('scroll_chat_list')) return;
    const delayMs = Number(harnessRuntime.getParam('scroll_delay_ms') || 1200);
    const timer = setTimeout(() => {
      setIsDragging(true);
      setAtBottom(false);
      try {
        transcriptRef.current?.scrollToOffset({ offset: 240, animated: true });
      } catch {}
      logTelemetry(TELEMETRY_EVENTS.CHAT_USER_SCROLLED, {
        stream_id: streamId,
        offset: 240,
        autoscroll_enabled: false,
        is_dragging: true,
        near_bottom_offset: NEAR_BOTTOM_OFFSET,
        source: 'harness_scroll_chat_list',
      });
      setTimeout(() => setIsDragging(false), 250);
    }, Number.isFinite(delayMs) ? Math.max(0, delayMs) : 1200);
    return () => clearTimeout(timer);
  }, [setAtBottom, streamId]);
  const latestThinkingRowId = useMemo(
    () => computeActiveThinkingRowId(detail?.transcriptItems),
    [detail?.transcriptItems],
  );
  const copyFromChat = useCallback(async ({ targetId, copyKind, text }: CopyRequestInput) => {
    await handleChatCopy({
      streamId,
      targetId,
      copyKind,
      text,
    });
    setCopiedTargetId(targetId);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCopiedTargetId((current) => (current === targetId ? null : current));
      copiedTimerRef.current = null;
    }, COPY_CONFIRMATION_MS);
  }, [streamId]);
  const harnessCopyHandler = useCallback(
    async (request: { targetId?: string; copyKind: ChatCopyKind; text: string }) => {
      const text = String(request.text || '');
      const resolvedTargetId = request.targetId || findCopyTargetId(transcriptData, request.copyKind, text);
      await copyFromChat({
        targetId: resolvedTargetId || `harness:${request.copyKind}:${text.length}`,
        copyKind: request.copyKind,
        text,
      });
    },
    [copyFromChat, transcriptData],
  );
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime || !streamId) return undefined;
    return harnessRuntime.registerCopyHandler(streamId, harnessCopyHandler);
  }, [harnessCopyHandler, streamId]);
  const presentSendError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || 'Failed to send message');
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_ERROR_SUPPRESSED, {
        stream_id: streamId,
        message,
      });
      return;
    }
    Alert.alert('Pentacle', message);
  }, [streamId]);
  const retryFromChat = useCallback(async (optimisticId: string) => {
    try {
      await actions.retryOptimisticSend(optimisticId);
    } catch (error) {
      presentSendError(error);
    }
  }, [actions, presentSendError]);
  const renderTranscriptItem = useCallback(({ item }: { item: PentacleTranscriptItem }) => (
	    <View style={[styles.machineGroup, harnessExpandedRowId === item.id && styles.harnessExpandedRow]}>
      {item.timestampLabel ? <Text {...NON_SELECTABLE_TEXT} style={styles.machineTimestamp}>{item.timestampLabel}</Text> : null}
      <TranscriptRowWithFetchedAttachments
        item={item}
        chrome={chrome}
        streamId={streamId}
        isLatestThinking={item.id === latestThinkingRowId}
        onCopy={copyFromChat}
        showTurnDuration={showTurnDuration}
        queuedWhileWorking={item.queuedWhileWorking === true}
        onPressAttachment={setViewerUri}
        onRetry={retryFromChat}
        directChild={directChildForTranscript(item)}
        onOpenDirectChildThread={(child) => setAgentThreadTarget({
          parentStreamId: streamId,
          parentGeneration: session?.session_generation ?? null,
          child,
        })}
      />
    </View>
	  ), [chrome, copyFromChat, directChildForTranscript, harnessExpandedRowId, latestThinkingRowId, retryFromChat, session?.session_generation, showTurnDuration, streamId]);
  const loadedEarlierRemaining = detail?.remainingCount || 0;
  const loadEarlierAvailable = loadedEarlierRemaining > 0 || hasOlderHistoryPage;
  useEffect(() => {
    if (!isFocused || !streamId || !loadEarlierAvailable || loadEarlierAffordanceLoggedRef.current) return;
    loadEarlierAffordanceLoggedRef.current = true;
    logHarnessUiTrace('transcript_load_earlier_affordance_visible', {
      stream_id: streamId,
      remaining_count: loadedEarlierRemaining,
      has_older_history_page: hasOlderHistoryPage,
      visible_rows: visibleRows,
    });
  }, [hasOlderHistoryPage, isFocused, loadEarlierAvailable, loadedEarlierRemaining, streamId, visibleRows]);
  const renderTranscriptFooter = useCallback(() => (
    <>
      {emptyStateVisible ? (
        <View style={styles.emptyWrap}>
          <Text {...NON_SELECTABLE_TEXT} style={styles.emptyText}>No messages yet.</Text>
        </View>
      ) : null}
      {loadEarlierAvailable ? (
        <Pressable
          style={[styles.loadEarlierButton, { borderColor: chrome.border, backgroundColor: chrome.surface }]}
          onPress={handleLoadEarlier}
          disabled={loadingEarlier}
        >
          {loadingEarlier ? <ActivityIndicator color={chrome.accent} size="small" /> : <FontAwesome name="chevron-up" size={11} color={chrome.accent} />}
          <Text {...NON_SELECTABLE_TEXT} style={[styles.loadEarlierText, { color: chrome.accent }]}>
            {loadingEarlier
              ? 'Loading earlier messages'
              : loadedEarlierRemaining > 0
                ? `Load ${Math.min(TRANSCRIPT_PAGE_ROWS, loadedEarlierRemaining)} earlier messages`
                : 'Load earlier messages'}
          </Text>
        </Pressable>
      ) : null}
    </>
  ), [emptyStateVisible, loadEarlierAvailable, loadedEarlierRemaining, loadingEarlier, chrome, handleLoadEarlier]);

  useEffect(() => {
    openEntrySourceRef.current = consumeStreamOpenEntrySource(streamId);
    openTelemetryRef.current = { streamId, spinner: false, instant: false };
    setVisibleRows(INITIAL_TRANSCRIPT_ROWS);
    setLoadingEarlier(false);
    setTranscriptReady(false);
    setCopiedTargetId(null);
    setAtBottom(true);
    setUnreadCount(0);
    lastSeenIdRef.current = null;
    hasInitializedLastSeenRef.current = false;
    previousLengthRef.current = 0;
    lastScrollTelemetryRef.current = '';
    transcriptScrollOffsetRef.current = 0;
    transcriptVisibleAnchorRef.current = null;
    transcriptLiveAnchorSampleCountRef.current = 0;
    transcriptProbeLoadCountRef.current = 0;
    transcriptProbeScrolledRef.current = false;
    transcriptScrollAnchorReadyRef.current = false;
    transcriptLiveVisibleSeqRef.current = null;
    loadEarlierAffordanceLoggedRef.current = false;
    setQuestionSubmitting(false);
    setQuestionSubmitError(null);
    setQuestionAnswerProjections({});
    setReturnedDraftPrefill(null);
    restoredReturnedDraftIdsRef.current.clear();
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryLastDispatchRef.current = 0;
    recoveryFetchStreamsRef.current.clear();
    setLoadingRunningLong(false);
  }, [streamId]);

  // Detail cache work stays out of the first-frame shell. Bucket versions make
  // ordinary updates selective; this post-interaction fence covers legacy
  // compatibility snapshots while that migration remains available.
  useEffect(() => {
    if (!streamId || !transcriptReady) return;
    invalidateSessionDetailCache(streamId);
  }, [streamId, transcriptReady]);

  useEffect(() => {
    if (!isFocused || !streamId) return;
    if (!openTelemetryRef.current || openTelemetryRef.current.streamId !== streamId) {
      openTelemetryRef.current = { streamId, spinner: false, instant: false };
    }
    const entrySource = openEntrySourceRef.current;
    if (detailIsHydrating && !openTelemetryRef.current.spinner) {
      openTelemetryRef.current.spinner = true;
      logHarnessBPrimeTelemetry(CHAT_OPEN_SPINNER_ON_OPEN as Parameters<typeof logTelemetry>[0], {
        stream_id: streamId,
        entry_source: entrySource,
        transcript_count: transcriptRowCount,
        history_fetch_in_flight: historyFetchInFlight,
      });
      return;
    }
    if (!detailIsHydrating && transcriptRowCount > 0 && !openTelemetryRef.current.instant) {
      openTelemetryRef.current.instant = true;
      logHarnessBPrimeTelemetry(CHAT_OPEN_INSTANT_OPEN as Parameters<typeof logTelemetry>[0], {
        stream_id: streamId,
        entry_source: entrySource,
        fetch_limit: MOUNT_FETCH_LIMIT,
        transcript_count: transcriptRowCount,
      });
    }
  }, [detailIsHydrating, historyFetchInFlight, isFocused, streamId, transcriptRowCount]);

  // FEAT-LOAD-RECONNECTING-HINT: arm the long-load timer whenever the loading
  // state is up; a load that outlives it surfaces the "Reconnecting…" hint.
  useEffect(() => {
    if (!detailIsHydrating || !isFocused) {
      setLoadingRunningLong(false);
      return;
    }
    const timer = setTimeout(() => setLoadingRunningLong(true), 6000);
    return () => clearTimeout(timer);
  }, [detailIsHydrating, isFocused, streamId]);

  useEffect(() => {
    setQuestionSubmitting(false);
    setQuestionSubmitError(null);
  }, [session?.question]);

  useEffect(() => {
    if (!questionOverlayOpen || canonicalQuestionEntries.length === 0) return;
    const optionCounts = canonicalQuestionEntries.map((entry) => entry.question.options.filter((option) => !option.meta).length);
    logTelemetry(TELEMETRY_EVENTS.QUESTION_CARD_RENDERED, {
      stream_id: streamId,
      option_count: optionCounts[activeQuestionPageIndex] || 0,
      question_count: canonicalQuestionEntries.length,
      option_counts: optionCounts,
      free_text_count: canonicalQuestionEntries.filter((entry) => entry.question.free_text === true).length,
      scan_incomplete: canonicalQuestionEntries.some((entry) => !!entry.source.kind && !!entry.locked),
      locked_count: canonicalQuestionEntries.filter((entry) => entry.locked).length,
    });
  }, [activeQuestionPageIndex, canonicalQuestionEntries, questionOverlayOpen, streamId]);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!streamId || !isFocused) return undefined;
    return registerFocusedPentacleStream(streamId);
  }, [isFocused, streamId]);

  useEffect(() => {
    if (!streamId || !isFocused || !detail?.transcriptItems.length) return;
    pentacleStreamRuntime.markPentacleStreamRendered?.(streamId);
  }, [detail?.transcriptItems, isFocused, streamId]);

  function probeFocusedLiveness(reason: 'interaction' | 'send' | 'scroll' | 'tap' | 'pull' = 'interaction') {
    if (!isFocused) return;
    requestFocusedPentacleLivenessProbe(reason);
  }

  // The bucket owns both coverage and in-flight identity. A completed fresh
  // prefetch is already authoritative for this mount; stale coverage gets one
  // revalidation, and a matching in-flight prefetch is left to settle rather
  // than duplicated by screen-local fetch bookkeeping.
  useEffect(() => {
    if (!streamId || !isFocused || !connectionSlice.connected) return;
    if (historyLoadState.fresh || historyFetchInFlight) return;
    let cancelled = false;
    const requestCycleId = `${streamId}:${Date.now()}:${++historyRequestCycleSequence}`;
    const reopenTelemetry = {
      stream_id: streamId,
      subsystem: QUESTION_FLOW_SUBSYSTEM,
      bug_ref: TRACKD_BUG2_REOPEN,
      fetch_limit: MOUNT_FETCH_LIMIT,
      request_purpose: 'mount-fetch',
      request_cycle_id: requestCycleId,
    };
    invalidateSessionDetailCache(streamId);
    logTelemetry(QUESTION_REOPEN_FETCH_ATTEMPT, reopenTelemetry);
    void requestStreamEvents(streamId, MOUNT_FETCH_LIMIT, {
      purpose: 'mount-fetch',
      entrySource: openEntrySourceRef.current,
    })
	      .then((events) => {
	        if (cancelled) return;
	        const fetchedCount = Array.isArray(events) ? events.length : 0;
	        historyBackfillRenderedRef.current.delete(streamId);
	        if (fetchedCount > INITIAL_TRANSCRIPT_ROWS) {
	          setVisibleRows((current) => Math.max(current, fetchedCount));
	        }
	        setHistoryBackfillReadyKey(`${streamId}:${Date.now()}:${fetchedCount}`);
	        logTelemetry(QUESTION_REOPEN_FETCH_READY, reopenTelemetry);
	      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err?.message || err);
        logTelemetry(QUESTION_REOPEN_FETCH_FAILED, {
          ...reopenTelemetry,
          error: message,
        });
        // Non-fatal: live broadcast events still populate state. Log so it
        // shows up in harness applogs without crashing the screen.
        // eslint-disable-next-line no-console
        console.warn('[session] requestStreamEvents failed', { streamId, error: message });
        if (!historyRetryTimerRef.current) {
          historyRetryTimerRef.current = setTimeout(() => {
            historyRetryTimerRef.current = null;
            setHistoryRetryToken((current) => current + 1);
          }, 1000);
        }
      })
      .finally(() => {
        if (!cancelled) {
          invalidateSessionDetailCache(streamId);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionSlice.connected, historyFetchInFlight, historyLoadState.fresh, historyRetryToken, isFocused, streamId]);

  useEffect(() => {
    if (!emptyStateVisible || !streamId) return;
    logTelemetry(CHAT_EMPTY_STATE_RENDERED, {
      stream_id: streamId,
      transcript_count: detail?.transcriptItems.length ?? 0,
      has_hydrated: detailHasHydrated,
      history_fetch_in_flight: historyFetchInFlight,
      subsystem: CHAT_OPEN_LOADING_SUBSYSTEM,
      bug_ref: REMAINING_CHAT_BUG2_LOADING,
    });
  }, [detail?.transcriptItems.length, detailHasHydrated, emptyStateVisible, historyFetchInFlight, streamId]);

  useEffect(() => {
    if (connectionSlice.connected) return;
    recoveryFetchStreamsRef.current.clear();
    historyBackfillRenderedRef.current.clear();
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryLastDispatchRef.current = 0;
  }, [connectionSlice.connected]);

  // FEAT-LOAD-RECOVERY: when the resilient session summary (`last_event_at`) has
  // outrun the newest event we actually hold, a live `chat.event` frame was
  // dropped on the lossy link. Refetch this stream's recent history to backfill
  // it. Debounced + min-interval cooled down, and re-armed via `recoveryTick`
  // after each attempt so it keeps trying (without storming) until we catch up.
  useEffect(() => {
    if (!streamId || !isFocused || !connectionSlice.connected) return;
    const RECOVERY_DEBOUNCE_MS = 800;
    const RECOVERY_MIN_INTERVAL_MS = 4000;
    const summaryAtMs = session?.last_event_at ? Date.parse(session.last_event_at) : NaN;
    if (!Number.isFinite(summaryAtMs)) return;
    const haveAtMs = detail?.latestEventAt ? Date.parse(detail.latestEventAt) : NaN;
    const behind = !Number.isFinite(haveAtMs) || summaryAtMs > haveAtMs;
    if (!behind) return;
    if (recoveryTimerRef.current) return;
    if (recoveryFetchStreamsRef.current.has(streamId)) return;
    const sinceLast = Date.now() - recoveryLastDispatchRef.current;
    const delay = sinceLast >= RECOVERY_MIN_INTERVAL_MS
      ? RECOVERY_DEBOUNCE_MS
      : Math.max(RECOVERY_DEBOUNCE_MS, RECOVERY_MIN_INTERVAL_MS - sinceLast);
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      if (recoveryFetchStreamsRef.current.has(streamId)) return;
      recoveryLastDispatchRef.current = Date.now();
      recoveryFetchStreamsRef.current.add(streamId);
      logTelemetry(CHAT_HISTORY_RECOVERY_REFETCH, {
        stream_id: streamId,
        summary_at: session?.last_event_at ?? null,
        local_at: detail?.latestEventAt ?? null,
        fetch_limit: MOUNT_FETCH_LIMIT,
        subsystem: CHAT_OPEN_LOADING_SUBSYSTEM,
        bug_ref: REMAINING_CHAT_BUG2_LOADING,
      });
      logHarnessBPrimeTelemetry(CHAT_OPEN_FRESHNESS_REFETCH as Parameters<typeof logTelemetry>[0], {
        stream_id: streamId,
        entry_source: openEntrySourceRef.current,
        summary_last_event_at: session?.last_event_at ?? null,
        detail_latest_event_at: detail?.latestEventAt ?? null,
        delta_ms: summaryAtMs - (Number.isFinite(haveAtMs) ? haveAtMs : 0),
      });
      void requestStreamEvents(streamId, MOUNT_FETCH_LIMIT, {
        purpose: 'freshness-guard',
        entrySource: openEntrySourceRef.current,
      })
        .then(() => {
          invalidateSessionDetailCache(streamId);
        })
        .catch((err) => {
          // Non-fatal: the bumped tick re-runs this effect and retries under the
          // cooldown. Log so it shows up in harness applogs without crashing.
          // eslint-disable-next-line no-console
          console.warn('[session] recovery refetch failed', { streamId, error: String(err?.message || err) });
        })
        .finally(() => {
          recoveryFetchStreamsRef.current.delete(streamId);
          // Re-evaluate: still behind -> reschedule under the cooldown; caught up -> no-op.
          setRecoveryTick((current) => current + 1);
        });
    }, delay);
    return () => {
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [streamId, isFocused, connectionSlice.connected, session?.last_event_at, detail?.latestEventAt, recoveryTick]);

  useEffect(() => () => {
    if (historyRetryTimerRef.current) {
      clearTimeout(historyRetryTimerRef.current);
      historyRetryTimerRef.current = null;
    }
  }, []);

	  useEffect(() => {
	    if (!historyBackfillReadyKey || !streamId || historyBackfillRenderedRef.current.has(streamId)) return;
	    const firstContent = transcriptData.find((item) => isBackfillRenderContent(item));
	    if (!firstContent) return;
	    historyBackfillRenderedRef.current.add(streamId);
    logTelemetry(CHAT_HISTORY_BACKFILL_RENDERED, {
      stream_id: streamId,
      row_id: firstContent.id,
      display_rule: firstContent.displayRule,
      fetch_limit: MOUNT_FETCH_LIMIT,
	      transcript_count: transcriptData.length,
	    });
	    if (isAtBottomRef.current) {
	      requestAnimationFrame(() => {
	        transcriptRef.current?.scrollToOffset({ offset: 0, animated: false });
	        logHarnessUiTrace('transcript_history_bottom_aligned', {
	          stream_id: streamId,
	          transcript_count: transcriptData.length,
	        });
	      });
	    }
	  }, [historyBackfillReadyKey, streamId, transcriptData]);

  useEffect(() => {
    if (!isFocused) {
      setTranscriptReady(false);
      setLoadingEarlier(false);
      return;
    }

    setTranscriptReady(false);
    if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime?.isArmed()) {
      const interaction = InteractionManager.runAfterInteractions(() => {
        requestAnimationFrame(() => setTranscriptReady(true));
      });
      return () => {
        interaction.cancel();
      };
    }

    logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, { stream_id: streamId });
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settleTranscriptReady = (branch: 'interactions' | 'harness_timeout') => {
      if (cancelled || settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setTranscriptReady(true);
      logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: streamId,
        branch,
        subsystem: QUESTION_FLOW_SUBSYSTEM,
        bug_ref: TRACKD_BUG2_REOPEN,
      });
      // One bucket_cost_sample per open, keyed to this open's paint
      // correlationId, emitted exactly once right after the settle predicate.
      emitBucketCostOpenSettle(chatOpenCorrelationIdRef.current, streamId);
    };
    const interaction = InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => settleTranscriptReady('interactions'));
    });
    timer = setTimeout(() => settleTranscriptReady('harness_timeout'), 250);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      interaction.cancel();
    };
  }, [isFocused, streamId]);

	  useEffect(() => {
	    if (!isFocused || !detail || loadingEarlier) return;

    const newestId = transcriptData[0]?.id ?? null;
    const lastSeen = lastSeenIdRef.current;
    const scrollPlan = planScroll({
      hasInitialized: hasInitializedLastSeenRef.current,
      isAtBottom: isAtBottomRef.current,
      isDragging,
      transcriptLength: transcriptData.length,
      previousLength: previousLengthRef.current,
    });
    logTelemetry(TELEMETRY_EVENTS.CHAT_AUTOSCROLL_DECISION, {
      stream_id: streamId,
      enabled: scrollPlan.kind !== 'none',
      reason: autoscrollTelemetryReason({
        hasInitialized: hasInitializedLastSeenRef.current,
        isDragging,
        isAtBottom: isAtBottomRef.current,
        transcriptLength: transcriptData.length,
        previousLength: previousLengthRef.current,
      }, scrollPlan),
      transcript_length: transcriptData.length,
      previous_length: previousLengthRef.current,
      visible_rows: visibleRows,
    });
    previousLengthRef.current = transcriptData.length;

    const schedulePlannedScroll = () => {
      if (scrollPlan.kind === 'none') return undefined;

      let chaser: ReturnType<typeof setTimeout> | undefined;
      const frame = requestAnimationFrame(() => {
        const animated = scrollPlan.kind === 'growth';
        transcriptRef.current?.scrollToOffset({ offset: 0, animated });
        if (scrollPlan.kind === 'cold-start') {
          chaser = setTimeout(() => {
            transcriptRef.current?.scrollToOffset({ offset: 0, animated: true });
          }, 120);
        }
      });

      return () => {
        cancelAnimationFrame(frame);
        if (chaser) clearTimeout(chaser);
      };
    };

    if (!hasInitializedLastSeenRef.current) {
      hasInitializedLastSeenRef.current = true;
      lastSeenIdRef.current = newestId;
      setUnreadCount(0);
      return schedulePlannedScroll();
    }

    if (!isAtBottomRef.current) {
      if (newestId && newestId !== lastSeen) {
        const newSinceLastSeen = lastSeen
          ? transcriptData.findIndex((item) => item.id === lastSeen)
          : 0;
        const delta = newSinceLastSeen === -1 ? transcriptData.length : newSinceLastSeen;
        if (delta > 0) setUnreadCount(delta);
      }
      return;
    }

    setUnreadCount(0);
    lastSeenIdRef.current = newestId;
    return schedulePlannedScroll();
    // NOTE: the body reads isAtBottomRef.current (synchronous, race-free) for the
    // scroll decision, but `isAtBottom` (state) is kept in the deps deliberately —
    // it is load-bearing so the effect re-runs when the sticky-bottom state flips.
    // Do not remove it as an "unused dep".
  }, [detail?.streamId, detail?.transcriptItems.length, isAtBottom, isDragging, isFocused, loadingEarlier, transcriptData, visibleRows]);

  useEffect(() => {
    if (!detail || animatedRowIds.size <= 600) return;
    const visibleIds = new Set(detail.transcriptItems.map((item) => item.id));
    for (const id of animatedRowIds) {
      if (!visibleIds.has(id)) {
        animatedRowIds.delete(id);
      }
    }
  }, [detail]);

  useEffect(() => {
    if (!isFocused) return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(Math.max(0, event.endCoordinates.height));
      setUnreadCount(0);
      setAtBottom(true);
      lastSeenIdRef.current = transcriptData[0]?.id ?? null;
      requestAnimationFrame(() => {
        transcriptRef.current?.scrollToOffset({ offset: 0, animated: true });
      });
    });
    const onHide = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, [insets.bottom, isFocused, transcriptData]);

  useEffect(() => {
    const inputs = {
      isFocused,
      isReady,
      hasToken: Boolean(token),
      hasSession: Boolean(session),
      hasHydrated: Boolean(hasHydrated),
      connecting,
    };
    if (!shouldArmRedirectTimer(inputs)) return;
    const timer = setTimeout(() => {
      if (shouldArmRedirectTimer(inputs)) {
        router.replace('/chats' as any);
      }
    }, MISSING_SESSION_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [connecting, hasHydrated, isFocused, isReady, router, session, token]);

  const handleComposerSend = useCallback(async (
    text: string,
    optimisticAttachments?: ChatAttachment[],
    thumbs?: RenderAttachment[],
    upload?: StagedUpload,
  ) => {
    const liveSession = pentacleStreamRuntime.getPentacleStreamState().sessions
      .find((item) => item.stream_id === streamId);
    if (!session || !isPentacleSessionSendEligible(liveSession)) {
      throw new Error('Chat session is not ready');
    }
    probeFocusedLiveness('send');
    const hasAttachments = Boolean(optimisticAttachments?.length);
    const optimisticRowAttachments = withRenderUris(optimisticAttachments, thumbs);
    logHarnessUiTrace('send_submit_started', {
      stream_id: streamId,
      text_length: text.length,
      attachment_count: optimisticAttachments?.length ?? 0,
      working: isWorkingRef.current,
    });
    const afterSend = () => {
      actions.clearDraft(streamId);
      setUnreadCount(0);
      setAtBottom(true);
      lastSeenIdRef.current = latestTopTranscriptIdRef.current;
      transcriptRef.current?.scrollToOffset({ offset: 0, animated: true });
    };
    const markFailedAndThrow = (optimisticId: string, error: unknown) => {
      logHarnessUiTrace('send_mark_failed', {
        stream_id: streamId,
        optimistic_id: optimisticId,
        error: error instanceof Error ? error.message : String(error),
      });
      actions.markOptimisticFailed(
        optimisticId,
        error instanceof Error ? error.message : 'send_error',
      );
      throw error;
    };
    const isRetryableTransportError = (error: unknown) => (
      error instanceof Error &&
      /Pentacle stream (?:disconnected|is not connected)/.test(error.message)
    );
    const isRpcTimeoutError = (error: unknown) => (
      error instanceof Error && /Pentacle command timed out/.test(error.message)
    );
    // Upload leg of the optimistic unit: it settles BEFORE any send is
    // dispatched, so its rejection is terminal (visible failed + Retry) and
    // must never reach the send-leg "keep pending" swallow below. Text-only
    // sends skip it entirely so the send RPC still leaves in the press tick.
    const settleUpload = async (optimisticId: string) => {
      try {
        return await settleUploadLeg({ optimisticId, optimisticAttachments, thumbs, upload, actions });
      } catch (error) {
        logHarnessUiTrace('send_mark_failed', {
          stream_id: streamId,
          optimistic_id: optimisticId,
          leg: 'upload',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    if (isWorkingRef.current) {
      const optimisticId = actions.enqueueTurn(streamId, text, optimisticRowAttachments);
      if (!optimisticId) return;
      logHarnessUiTrace('send_optimistic_queued', {
        stream_id: streamId,
        optimistic_id: optimisticId,
        attachment_count: optimisticRowAttachments?.length ?? 0,
      });
      afterSend();
      const wireAttachments = upload ? await settleUpload(optimisticId) : undefined;
      actions.dispatchQueuedSendsByOptimisticId(streamId, optimisticId);
      logHarnessUiTrace('send_queued_dispatched', {
        stream_id: streamId,
        optimistic_id: optimisticId,
        attachment_count: wireAttachments?.length ?? 0,
      });
      return;
    }

    const optimisticId = hasAttachments
      ? actions.sendTurn(streamId, text, optimisticRowAttachments)
      : actions.sendTurn(streamId, text);
    if (!optimisticId) return;
    isWorkingRef.current = true;
    logHarnessUiTrace('send_optimistic_inserted', {
      stream_id: streamId,
      optimistic_id: optimisticId,
      attachment_count: optimisticRowAttachments?.length ?? 0,
    });
    afterSend();
    const wireAttachments = upload ? await settleUpload(optimisticId) : optimisticAttachments;
    if (upload && wireAttachments?.length) {
      logHarnessUiTrace('send_attachments_replaced', {
        stream_id: streamId,
        optimistic_id: optimisticId,
        attachment_count: wireAttachments.length,
      });
    }
    try {
      await actions.sendMessage(
        wireAttachments?.length
          ? { host: session.host, sessionName: session.session_name, text, attachments: wireAttachments }
          : { host: session.host, sessionName: session.session_name, text },
      );
      logHarnessUiTrace('send_rpc_resolved', {
        stream_id: streamId,
        optimistic_id: optimisticId,
      });
    } catch (error) {
      // Send leg only (the upload leg settled above): a transport rejection is
      // either pre-dispatch — the row is still `queued`, registered by
      // sendPentacleMessage, and `dispatchOfflineQueuedSends` resubmits it once
      // on the next socket — or post-dispatch, reconciled by the stamped echo.
      if (isRetryableTransportError(error)) {
        logHarnessUiTrace('send_rpc_disconnect_kept_pending', {
          stream_id: streamId,
          optimistic_id: optimisticId,
        });
        return;
      }
      if (isRpcTimeoutError(error)) {
        logHarnessUiTrace('send_rpc_timeout_kept_pending', {
          stream_id: streamId,
          optimistic_id: optimisticId,
        });
        return;
      }
      markFailedAndThrow(optimisticId, error);
    }
  }, [actions, isFocused, session, streamId]);

  const handleHarnessSend = useCallback(async (request: HarnessSendRequest) => {
    const text = typeof request === 'string' ? request : request.text ?? '';
    const trimmed = String(text || '').trim();
    const fixtureRequest = typeof request === 'string' ? null : request;
    if (!trimmed && !fixtureRequest) return;
    try {
      if (!fixtureRequest) {
        await handleComposerSend(trimmed);
        return;
      }
      const staged = [await fixtureImageToProcessedAsset(fixtureRequest)];
      const thumbs: RenderAttachment[] = staged.map((asset) => ({
        uri: asset.uri,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
      }));
      const optimisticAttachments = optimisticAttachmentsForStaged(staged);
      await handleComposerSend(trimmed, optimisticAttachments, thumbs, beginStagedUpload(staged));
    } catch (error) {
      presentSendError(error);
      throw error;
    }
  }, [handleComposerSend, presentSendError]);

  useEffect(() => {
    logHarnessUiTrace('session_send_eligibility', {
      stream_id: streamId,
      focused: isFocused,
      session_present: Boolean(session),
      bootstrap_state: session?.bootstrap_state ?? null,
      shell_bootstrap_state: shellSlice.session?.bootstrap_state ?? null,
      selected_bootstrap_state: selectedSession?.bootstrap_state ?? null,
      eligible: sessionSendEligible,
      registrar_present: Boolean(harnessSendHandlerRegistrar),
    });
    if (!isFocused || !harnessSendHandlerRegistrar || !session || !sessionSendEligible) return undefined;
    harnessSendHandlerRegistrar(handleHarnessSend);
    return () => {
      harnessSendHandlerRegistrar(null);
    };
  }, [handleHarnessSend, harnessSendHandlerRegistrar, isFocused, session, sessionSendEligible]);

  if (reportViewerHarnessRoute) {
    return (
      <View style={styles.container}>
        <ReportViewerModal visible streamId={streamId} accent={chrome.accent} e2eTableTargets onClose={() => undefined} />
      </View>
    );
  }

  if (!isReady) {
    return (
      <View style={[styles.center, styles.container]}>
        <Starfield />
        <Text {...NON_SELECTABLE_TEXT} style={styles.centerText}>Unlocking Pentacle…</Text>
      </View>
    );
  }

  if (!token) {
    return (
      <View style={[styles.center, styles.container]}>
        <Starfield />
        <Text {...NON_SELECTABLE_TEXT} style={styles.centerText}>Pentacle access is unavailable on this device.</Text>
      </View>
    );
  }

  if (!session) {
    return (
      <View style={[styles.center, styles.container]}>
        <Starfield />
        {hasHydrated && !connecting ? <ActivityIndicator color={P.accent} /> : <Spinner size={34} color={P.accent} />}
        <Text {...NON_SELECTABLE_TEXT} style={styles.centerText}>
          {hasHydrated && !connecting ? 'Returning to chats...' : 'LOADING CHAT…'}
        </Text>
      </View>
    );
  }

  const composerInset = keyboardHeight > 0
    ? COMPOSER_KEYBOARD_BOTTOM_INSET
    : COMPOSER_CLOSED_BOTTOM_INSET;
  const title = detail?.title || displayTitleForShell(session);
  const hostTitle = detail?.hostTitle || chrome.title;
  const dismissComposer = () => {
    setDismissComposerToken((current) => current + 1);
    Keyboard.dismiss();
  };
  const returnToChats = () => {
    Keyboard.dismiss();
    router.replace('/(tabs)/chats' as any);
  };
  const handleComposerFocus = () => {
    probeFocusedLiveness('tap');
    setUnreadCount(0);
    setAtBottom(true);
    lastSeenIdRef.current = transcriptData[0]?.id ?? null;
    requestAnimationFrame(() => {
      transcriptRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  };
  const currentTitle = title || session.session_name;
  const pendingClose = (session as PentacleSessionSummary & { pending_close?: PendingSessionClose }).pending_close;
  const showDeleteActionError = (error: unknown) => {
    Alert.alert('Pentacle', error instanceof Error ? error.message : 'Delete action failed');
  };
  const handleDelete = () => {
    setMenuVisible(false);
    if (pendingClose) {
      const exhausted = pendingClose.state === 'exhausted' || pendingClose.state === 'failed';
      Alert.alert(
        exhausted ? 'Delete stalled' : 'Delete pending',
        exhausted
          ? (pendingClose.errorMessage || 'Automatic retries were exhausted. Choose how to continue.')
          : `${title} will be removed when its active work finishes.`,
        exhausted
          ? [
            { text: 'Retry', onPress: () => void actions.retryPendingClose(streamId).catch(showDeleteActionError) },
            { text: 'Cancel delete', style: 'cancel', onPress: () => void actions.cancelPendingClose(streamId).catch(showDeleteActionError) },
            { text: 'Force delete', style: 'destructive', onPress: () => void actions.forcePendingClose(streamId).catch(showDeleteActionError) },
          ]
          : [
            { text: 'Keep waiting', style: 'cancel' },
            { text: 'Cancel delete', onPress: () => void actions.cancelPendingClose(streamId).catch(showDeleteActionError) },
            { text: 'Force delete', style: 'destructive', onPress: () => void actions.forcePendingClose(streamId).catch(showDeleteActionError) },
          ],
      );
      return;
    }
    Alert.alert('Delete chat?', `Remove ${title} from ${hostTitle}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await actions.closeSession({
              host: session.host,
              sessionName: session.session_name,
              streamId,
            });
            returnToChats();
          } catch (error) {
            Alert.alert('Pentacle', error instanceof Error ? error.message : 'Failed to delete chat');
          }
        },
      },
    ]);
  };
  const openRename = () => {
    setMenuVisible(false);
    setRenameVisible(true);
  };
  const submitRename = async (value: string) => {
    setRenameVisible(false);
    const displayName = value.trim();
    if (!displayName || displayName === currentTitle) return;
    try {
      await actions.renameSession({
        host: session.host,
        sessionName: session.session_name,
        displayName,
      });
    } catch (error) {
      Alert.alert('Pentacle', error instanceof Error ? error.message : 'Failed to rename chat');
    }
  };
  return (
    <View style={styles.container} testID="session-shell" onLayout={recordChatOpenShellLayout}>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />
      <Starfield />
      <View
        style={[
          styles.combinedHeader,
          {
            paddingTop: Math.max(insets.top + 6, TOP_INSET),
            backgroundColor: chrome.header,
            borderBottomColor: `${chrome.accent}33`,
          },
        ]}
        testID="combined-session-header"
      >
        <Pressable style={styles.headerBackButton} onPress={returnToChats} hitSlop={10} accessibilityLabel="Back to chats" accessibilityRole="button">
          <Text {...NON_SELECTABLE_TEXT} style={styles.headerBackGlyph}>‹</Text>
        </Pressable>
        <Pressable testID="session-status-overlay-trigger" onPress={() => setStatusOverlayOpen(true)} accessibilityRole="button" accessibilityLabel="Open session status" style={styles.headerStatusTrigger}>
          <ArcaneRingFrame machine={chrome.machineName} size={42} sigilSize={26} />
          <View style={styles.headerTitleBlock}>
            <Text {...NON_SELECTABLE_TEXT} style={styles.headerTitle} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.headerMetaRow}>
              <ProviderTag provider={session.provider} color={chrome.accent} />
              <StatusTag
                status={headerStatus}
                elapsedSeconds={fluidWorkingSeconds}
                sendingDelayMs={0}
                label={headerStatusLabel}
                onVisibleStatusCommit={
                  process.env.EXPO_PUBLIC_HARNESS === '1' && isFocused && appState === 'active' && !statusOverlayOpen
                    ? handleVisibleHeaderStatusCommit
                    : undefined
                }
              />
            </View>
          </View>
        </Pressable>
        <Pressable
          testID="session-header-menu-button"
          style={styles.headerMoreButton}
          onPress={() => {
            setMenuVisible(true);
            void listReports(streamId).catch(() => undefined);
          }}
          hitSlop={10}
          accessibilityLabel="Chat options"
          accessibilityRole="button"
        >
          <Text {...NON_SELECTABLE_TEXT} style={styles.headerMoreGlyph}>⋯</Text>
          {reportUnread > 0 ? (
            <View testID="session-report-unread-badge" style={styles.headerReportBadge}>
              <Text {...NON_SELECTABLE_TEXT} style={styles.headerReportBadgeText}>{reportUnread}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>
      <ChatActionSheet
        visible={menuVisible}
        title={currentTitle}
        reportCount={sessionReports.length}
        reportUnreadCount={reportUnread}
        onReports={() => {
          setMenuVisible(false);
          setReportsVisible(true);
        }}
        onRename={openRename}
        onDelete={handleDelete}
        onClose={() => setMenuVisible(false)}
      />
      <RenameChatModal
        visible={renameVisible}
        initialName={currentTitle}
        onSubmit={submitRename}
        onClose={() => setRenameVisible(false)}
      />
      {/* A1 (photo/camera send): full-screen viewer for a tapped attachment. */}
      <ImageViewerModal uri={viewerUri} onClose={() => setViewerUri(null)} />
      <ReportViewerModal visible={reportsVisible || (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === '1' && params.reportHarness === '1')} streamId={streamId} accent={chrome.accent} onClose={() => setReportsVisible(false)} />
      {statusOverlayOpen && (session.status_card || session.role === 'nexus') ? <StatusOverlay
        session={session}
        card={statusOverlayCard}
        specStatuses={specStatuses}
        onBackToChats={returnToChats}
        onClose={() => setStatusOverlayOpen(false)}
        renderHeader={({ close, backToChats, viewingUpdates }) => (
          <View
            style={[
              styles.combinedHeader,
              {
                paddingTop: Math.max(insets.top + 6, TOP_INSET),
                backgroundColor: chrome.header,
                borderBottomColor: `${chrome.accent}33`,
              },
            ]}
            testID="status-overlay-header"
          >
            <Pressable testID="status-overlay-back" style={styles.headerBackButton} onPress={backToChats} hitSlop={10} accessibilityLabel="Back to chats" accessibilityRole="button">
              <Text {...NON_SELECTABLE_TEXT} style={styles.headerBackGlyph}>‹</Text>
            </Pressable>
            <View style={styles.headerStatusTrigger}>
              <ArcaneRingFrame machine={chrome.machineName} size={42} sigilSize={26} />
              <View style={styles.headerTitleBlock}>
                <Text {...NON_SELECTABLE_TEXT} style={styles.headerTitle} numberOfLines={1}>{title}</Text>
                <View style={styles.headerMetaRow}>
                  <ProviderTag provider={session.provider} color={chrome.accent} />
                  <StatusTag
                    status={headerStatus}
                    elapsedSeconds={fluidWorkingSeconds}
                    sendingDelayMs={sendingImmediate ? 0 : SESSION_SENDING_VISIBLE_AFTER_MS}
                    label={headerStatusLabel}
                  />
                </View>
              </View>
            </View>
            <Pressable testID="status-overlay-close" style={styles.statusOverlayCloseButton} onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel={viewingUpdates ? 'Back to status card' : 'Close session status'}>
              <Text {...NON_SELECTABLE_TEXT} style={styles.statusOverlayCloseGlyph}>✕</Text>
            </Pressable>
          </View>
        )}
      >
        {session.role === 'nexus' ? <NexusStatusAgentRows
          agents={session.agents ?? []}
          onOpenThread={(child) => setAgentThreadTarget({
            parentStreamId: streamId,
            parentGeneration: session.session_generation ?? null,
            child,
          })}
        /> : null}
      </StatusOverlay> : null}
      <View style={styles.screenContent}>
        <View style={styles.sessionBody}>
          {shouldRenderTranscript ? (
            <FlatList
              ref={transcriptRef}
              testID="transcript-list"
              style={[styles.transcript, { marginBottom: composerHeight + keyboardHeight }]}
              data={transcriptData}
              keyExtractor={(item) => item.id}
              renderItem={renderTranscriptItem}
              ListFooterComponent={renderTranscriptFooter}
              inverted
              keyboardShouldPersistTaps="always"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              contentContainerStyle={styles.transcriptContent}
              // Anchored ONLY while the user is scrolled up. The list is inverted, so a new
              // row is data index 0 at content-layout y=0 and grows the content at its
              // START — exactly what position maintenance holds still. Scrolled up that is
              // the point (an incoming message must not yank the viewport). Pinned to the
              // bottom it is the bug: the list bumps contentOffset by the new row's height,
              // undoing the follow after layout, leaving the row off-screen and raising the
              // scroll-to-bottom arrow the user never asked for. Un-anchored, an inverted
              // list follows new content for free.
              //
              // Reads the REF, not `isAtBottom` state, and deliberately so. Native position
              // maintenance captures its anchor child before mounting new children, so the
              // prop must already be correct in the very commit that mounts a new row. The
              // ref flips synchronously inside onScroll; the state trails it by a commit. If
              // a scroll-up and a websocket append land in the SAME commit, a state-driven
              // prop would still read "at bottom", no anchor would be captured, and the
              // append would yank the viewport the user just scrolled — contract point 4.
              // The state is still what re-renders us (it drives the pill below), so the ref
              // read here always lands on a render the state change also schedules.
	              maintainVisibleContentPosition={isAtBottomRef.current ? undefined : TRANSCRIPT_BOTTOM_ANCHOR}
	              onContentSizeChange={() => {
	                if (isAtBottomRef.current && !loadingEarlier) {
	                  transcriptRef.current?.scrollToOffset({ offset: 0, animated: false });
	                }
	              }}
              onTouchStart={() => probeFocusedLiveness('tap')}
              onScrollBeginDrag={() => {
                probeFocusedLiveness('scroll');
                setIsDragging(true);
                dismissComposer();
              }}
	              onScroll={(event) => {
	                const y = event.nativeEvent.contentOffset.y;
	                transcriptScrollOffsetRef.current = y;
	                const atBottom = y <= NEAR_BOTTOM_OFFSET;
                const telemetryKey = `${atBottom}:${isDragging}`;
                if (lastScrollTelemetryRef.current !== telemetryKey) {
                  lastScrollTelemetryRef.current = telemetryKey;
                  logTelemetry(TELEMETRY_EVENTS.CHAT_USER_SCROLLED, {
                    stream_id: streamId,
                    offset: y,
                    autoscroll_enabled: atBottom,
                    is_dragging: isDragging,
                    near_bottom_offset: NEAR_BOTTOM_OFFSET,
                  });
                }
                setAtBottom(atBottom);
                if (atBottom && unreadCount > 0) {
                  setUnreadCount(0);
                  lastSeenIdRef.current = transcriptData[0]?.id ?? null;
                }
	              }}
	              onViewableItemsChanged={onTranscriptViewableItemsChanged}
	              viewabilityConfig={transcriptViewabilityConfig}
	              scrollEventThrottle={32}
              onScrollEndDrag={() => setIsDragging(false)}
              onMomentumScrollEnd={() => setIsDragging(false)}
              maxToRenderPerBatch={TRANSCRIPT_RENDER_BATCH_ROWS}
              initialNumToRender={INITIAL_RENDERED_TRANSCRIPT_ROWS}
              windowSize={3}
              removeClippedSubviews
            />
          ) : chatOpenLoadState.shell === 'preview' && shellSlice.preview ? (
            <View
              key={shellSlice.preview.key}
              style={[styles.transcriptLoading, { marginBottom: composerHeight + keyboardHeight }]}
              testID="session-shell-preview"
            >
              {shellSlice.preview.label ? <Text {...NON_SELECTABLE_TEXT} style={styles.loadingLabel}>{shellSlice.preview.label}</Text> : null}
              <Text {...SELECTABLE_TEXT} style={styles.loadingLabel} testID="session-shell-preview-text">
                {shellSlice.preview.text}
              </Text>
              {chatOpenLoadState.status === 'syncing' ? <Text {...NON_SELECTABLE_TEXT} style={styles.loadingLabel}>Syncing chat…</Text> : null}
            </View>
          ) : chatOpenLoadState.spinner ? (
            <View style={[styles.transcriptLoading, { marginBottom: composerHeight + keyboardHeight }]} testID="transcript-loading">
              <Spinner size={34} color={chrome.accent} />
              <Text {...NON_SELECTABLE_TEXT} style={styles.loadingLabel}>LOADING CHAT…</Text>
              {reconnectingHintVisible ? (
                <Text
                  {...NON_SELECTABLE_TEXT}
                  style={styles.loadingLabel}
                  testID="transcript-reconnecting-hint"
                >
                  Reconnecting…
                </Text>
              ) : null}
            </View>
          ) : (
            <View
              style={[styles.transcriptLoading, { marginBottom: composerHeight + keyboardHeight }]}
              testID={`session-shell-${chatOpenLoadState.status}`}
            >
              <Text {...NON_SELECTABLE_TEXT} style={styles.loadingLabel}>
                {chatOpenLoadState.status === 'offline'
                  ? 'Offline. Reconnect to load this chat.'
                  : chatOpenLoadState.status === 'error'
                    ? 'Could not load this chat.'
                    : 'No messages yet.'}
              </Text>
              {chatOpenLoadState.status === 'error' ? (
                <Pressable onPress={() => setHistoryRetryToken((current) => current + 1)} accessibilityRole="button" accessibilityLabel="Retry loading chat">
                  <Text {...NON_SELECTABLE_TEXT} style={styles.loadingLabel}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          )}
          <CopyConfirmationToast streamId={streamId} targetId={copiedTargetId} />
          {!isAtBottom ? (
            // One-tap scroll-to-bottom shown whenever the user has scrolled up.
            // When new messages have arrived while scrolled up, it also shows a
            // minimal unread count; otherwise it is just the jump-to-latest arrow.
            <Pressable
              style={[styles.newMessagesPill, { bottom: composerHeight + keyboardHeight + 8 }]}
              onPress={() => {
                probeFocusedLiveness('tap');
                transcriptRef.current?.scrollToOffset({ offset: 0, animated: true });
                setUnreadCount(0);
                setAtBottom(true);
                lastSeenIdRef.current = transcriptData[0]?.id ?? null;
              }}
              accessibilityLabel={unreadCount > 0
                ? `Scroll to ${unreadCount} new message${unreadCount === 1 ? '' : 's'}`
                : 'Scroll to latest messages'}
              accessibilityRole="button"
              testID="new-messages-pill"
            >
              <FontAwesome name="arrow-down" size={11} color={chrome.accent} />
              {unreadCount > 0 ? (
                <Text
                  {...NON_SELECTABLE_TEXT}
                  style={[styles.newMessagesPillText, { color: chrome.accent }]}
                  testID="new-messages-count"
                >
                  {unreadCount} new message{unreadCount === 1 ? '' : 's'}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
        </View>
        <View
          style={[styles.composerWrap, { bottom: keyboardHeight, paddingBottom: composerInset }]}
          testID="composer-wrap"
          collapsable={false}
          onLayout={(event) => {
            const nextHeight = Math.ceil(event.nativeEvent.layout.height);
            setComposerHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
          }}
        >
          {/* B1/C (working cancel): visible whenever the session is working — gated on
              showWorking (the daemon's authoritative session.working OR a local
              turn) so a daemon-reported-working session with no local optimistic
              turn (app reopened / turn started elsewhere) is still interruptible.
              One press interrupts via send.interrupt; repeat presses in the same
              working turn are debounced to a single effective interrupt. */}
          {showWorking ? (
            <WorkingIndicatorRow
              chrome={chrome}
              onCancel={handleInterruptPress}
              streamId={streamId}
              workingIdentity={workingIdentity}
              elapsedSeconds={fluidWorkingSeconds}
              retryNotice={interruptRetryIdentity === workingIdentity ? 'Stop did not take. Tap again to retry.' : null}
            />
          ) : null}
          <ComposerBar
            host={hostTitle}
            chrome={chrome}
            disabled={false}
            submissionDisabled={!sessionSendEligible}
            dismissToken={dismissComposerToken}
            refocusToken={refocusComposerToken}
            guardedPrefillText={returnedDraftPrefill?.text}
            guardedPrefillToken={returnedDraftPrefill?.token}
            onFocus={handleComposerFocus}
            onRegisterSendHandler={undefined}
            onSend={handleComposerSend}
            onError={presentSendError}
          />
        </View>
        <QuestionFab
          count={questionOverlayOpen ? 0 : visibleQuestionFlow.unansweredCount}
          accent={chrome.accent}
          onPress={() => {
            setQuestionPageIndex(0);
            setQuestionSubmitError(null);
            setQuestionOverlayOpen(true);
          }}
        />
      </View>
      {questionOverlayOpen ? (
        <View testID="question-card" style={styles.questionOverlayHost}>
          <QuestionOverlay
            entries={canonicalQuestionEntries}
            activeIndex={activeQuestionPageIndex}
            flow={visibleQuestionFlow}
            accent={chrome.accent}
            machineName={chrome.machineName}
            title={currentTitle}
            submitting={questionSubmitting}
            error={questionSubmitError}
            onIndexChange={setQuestionPageIndex}
            onCancel={() => {
              questionFlow.resetDrafts();
              setQuestionPageIndex(0);
              setQuestionOverlayOpen(false);
            }}
            onSend={() => { void submitAllQuestionAnswers(); }}
          />
        </View>
      ) : null}
      <AgentThreadHistoryModal
        target={agentThreadTarget}
        connected={connectionSlice.connected}
        readThread={actions.readThread}
        onClose={() => setAgentThreadTarget(null)}
        onBackToChats={returnToChats}
        onRowsRendered={({ parentStreamId, childStreamId, rows, nextCursor }) => logHarnessUiTrace('nexus_agents_history_rendered', {
          parent_stream_id: parentStreamId,
          child_stream_id: childStreamId,
          row_ids: rows.map((row) => row.row_id),
          row_texts: rows.map((row) => row.text),
          next_cursor: nextCursor,
        })}
      />
    </View>
  );
}

// Renders an Option-B answer message as a human-friendly structured block:
// per question, the header label, the chosen answer (option label(s) or free
// text), and the optional note. Presentation only — the underlying event text
// is unchanged (copy still yields the raw on-wire grammar).
function AnswerBubble({ answer }: { answer: PentacleQuestionAnswerDisplay }) {
  return (
    <View style={styles.answerBlock} testID="answer-bubble">
      {answer.items.map((item, index) => {
        const labels = item.selectedLabels ?? [];
        return (
          <View key={index} style={index > 0 ? styles.answerItemSpacing : undefined}>
            <Text {...NON_SELECTABLE_TEXT} style={styles.answerHeader}>{item.header}</Text>
            {labels.length > 1
              ? labels.map((label, labelIndex) => (
                  <View key={labelIndex} style={styles.answerBulletRow}>
                    <Text {...NON_SELECTABLE_TEXT} style={styles.answerBullet}>•</Text>
                    <Text {...SELECTABLE_TEXT} style={styles.answerValue}>{label}</Text>
                  </View>
                ))
              : labels.length === 1
                ? <Text {...SELECTABLE_TEXT} style={styles.answerValue}>{labels[0]}</Text>
                : item.text !== undefined
                  ? <Text {...SELECTABLE_TEXT} style={styles.answerValue}>{item.text}</Text>
                  : null}
            {item.note !== undefined
              ? <Text {...SELECTABLE_TEXT} style={styles.answerNote}>{item.note}</Text>
              : null}
          </View>
        );
      })}
    </View>
  );
}

function AgentMessageCard({
  item,
  chrome,
  onCopy,
  directChild,
  onOpenDirectChildThread,
}: {
  item: PentacleTranscriptItem;
  chrome: HostChrome;
  onCopy?: CopyHandler;
  directChild?: ChildAgent | null;
  onOpenDirectChildThread?: (child: ChildAgent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const longPressed = useRef(false);
  const disclosure = item.disclosure;
  const expandedText = disclosure?.expandedText ?? item.text;
  const previewText = disclosure?.previewText || item.text.trim();
  const previewTail = disclosure?.previewTail || '';
  const collapsible = Boolean(disclosure?.expandable);
  const label = item.label ? `Subagent · ${item.label}` : 'Subagent';
  const accessibilityBody = expanded ? expandedText : [previewText, previewTail].filter(Boolean).join('. ');

  return (
    <Pressable
      testID={`agent-message-card-${item.id}`}
      style={[styles.agentCard, { borderColor: `${chrome.accent}66` }]}
      accessible
      accessibilityRole={collapsible ? 'button' : undefined}
      accessibilityLabel={`${label}. ${accessibilityBody}`}
      accessibilityState={collapsible ? { expanded } : undefined}
      onPressIn={() => { longPressed.current = false; }}
      onPress={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        if (collapsible) setExpanded((current) => !current);
      }}
      onLongPress={() => {
        longPressed.current = true;
        void onCopy?.({ targetId: messageCopyTargetId(item.id), copyKind: 'message', text: expandedText });
      }}
      delayLongPress={350}
    >
      <View accessible={false} style={styles.plumbingPreviewRow}>
        <Text {...NON_SELECTABLE_TEXT} numberOfLines={1} testID={`agent-message-label-${item.id}`} style={[styles.agentLabel, styles.plumbingSender, { color: chrome.accent }]}>
          {label}
        </Text>
        {directChild ? (
          <Pressable
            testID={`direct-child-history-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Open history for direct child ${directChild.display_name}`}
            onPress={() => onOpenDirectChildThread?.(directChild)}
          >
            <Text {...NON_SELECTABLE_TEXT} style={[styles.agentLabel, { color: chrome.accent }]}>HISTORY</Text>
          </Pressable>
        ) : null}
        {!expanded ? <Text {...SELECTABLE_TEXT} numberOfLines={1} style={[styles.agentText, styles.plumbingPreviewText]}>{previewText}</Text> : null}
        {!expanded && previewTail ? <Text {...NON_SELECTABLE_TEXT} numberOfLines={1} style={styles.agentHiddenLines}>{previewTail}</Text> : null}
        {collapsible ? <FontAwesome name={expanded ? 'chevron-up' : 'chevron-down'} size={11} color={chrome.accent} /> : null}
      </View>
      {expanded ? <Text accessible={false} {...SELECTABLE_TEXT} style={styles.agentText}>{expandedText}</Text> : null}
    </Pressable>
  );
}

function NexusStatusAgentRows({
  agents,
  onOpenThread,
}: {
  agents: readonly ChildAgent[];
  onOpenThread: (child: ChildAgent) => void;
}) {
  useEffect(() => {
    logHarnessUiTrace('nexus_agents_roster_rendered', {
      child_stream_ids: agents.map((child) => child.stream_id),
      child_names: agents.map((child) => child.display_name),
      child_objectives: agents.map((child) => child.objective),
      child_states: agents.map((child) => child.state),
      child_models: agents.map((child) => child.model),
    });
  }, [agents]);
  if (!agents.length) {
    return <Text testID="nexus-status-childless" {...NON_SELECTABLE_TEXT} style={styles.nexusStatusUnavailable}>No direct child agents are active.</Text>;
  }
  return (
    <View testID="nexus-status-agents" style={styles.nexusStatusAgents}>
      <Text {...NON_SELECTABLE_TEXT} style={styles.nexusStatusHeading}>SUB-AGENTS</Text>
      {agents.map((child) => (
        <View key={`${child.stream_id}:${child.session_generation}`} style={styles.nexusStatusAgent}>
          <View style={styles.nexusStatusAgentCopy}>
            <Text {...NON_SELECTABLE_TEXT} style={styles.nexusStatusName}>{child.display_name}</Text>
            <Text {...NON_SELECTABLE_TEXT} style={styles.nexusStatusMeta}>{child.state.toUpperCase()} · {child.model || 'MODEL UNAVAILABLE'}</Text>
            <Text {...NON_SELECTABLE_TEXT} style={styles.nexusStatusObjective}>{child.objective || 'Objective unavailable.'}</Text>
          </View>
          <Pressable testID={`nexus-status-history-${nexusHistoryRowId(child.stream_id)}`} accessibilityRole="button" accessibilityLabel={`Open history for ${child.display_name}`} onPress={() => onOpenThread(child)}>
            <Text {...NON_SELECTABLE_TEXT} style={styles.nexusStatusHistory}>HISTORY</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function nexusHistoryRowId(streamId: string) {
  return streamId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function ToolResultCard({
  item,
  text,
  chrome,
}: {
  item: PentacleTranscriptItem;
  text: string;
  chrome: HostChrome;
}) {
  const [expanded, setExpanded] = useState(false);
  const disclosure = item.disclosure;
  const expandedText = disclosure?.expandedText ?? text;
  const previewText = disclosure?.previewText || text.trim();
  const previewTail = disclosure?.previewTail || '';
  const collapsible = Boolean(disclosure?.expandable);

  return (
    <Pressable
      testID={`tool-result-card-${item.id}`}
      style={styles.toolResultRow}
      accessible
      accessibilityRole={collapsible ? 'button' : undefined}
      accessibilityLabel={`Tool result. ${expanded ? expandedText : [previewText, previewTail].filter(Boolean).join('. ')}`}
      accessibilityState={collapsible ? { expanded } : undefined}
      onPress={() => { if (collapsible) setExpanded((current) => !current); }}
    >
      <Text accessible={false} {...NON_SELECTABLE_TEXT} style={styles.toolResultGlyph}>⎿</Text>
      <View accessible={false} style={styles.toolResultBody}>
        <View style={styles.plumbingPreviewRow}>
          {!expanded ? <Text {...SELECTABLE_TEXT} numberOfLines={1} style={[styles.toolResultText, styles.plumbingPreviewText]}>{previewText}</Text> : null}
          {!expanded && previewTail ? <Text {...NON_SELECTABLE_TEXT} numberOfLines={1} style={styles.toolResultTail}>{previewTail}</Text> : null}
          {collapsible ? <FontAwesome name={expanded ? 'chevron-up' : 'chevron-down'} size={11} color={chrome.accent} /> : null}
        </View>
        {expanded ? <Text {...SELECTABLE_TEXT} style={styles.toolResultText}>{expandedText}</Text> : null}
      </View>
    </Pressable>
  );
}

type UserSendAffordance = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'none';

function userSendAffordance(
  item: Pick<PentacleTranscriptItem, 'receiptCaption' | 'sendState'>,
  queuedWhileWorking: boolean,
): UserSendAffordance {
  if (item.sendState === 'cancelled') return 'cancelled';
  // A terminal optimistic failure takes precedence over a stale receipt caption.
  // The daemon can retain its prior "sending" receipt while publishing the
  // failed optimistic state, and the retry affordance must remain reachable.
  if (item.sendState === 'failed') return 'failed';
  if (item.receiptCaption) return item.receiptCaption;
  if (queuedWhileWorking && (item.sendState === 'queued' || item.sendState === 'sending')) return 'queued';
  return 'none';
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  chrome,
  streamId = '',
  isLatestThinking = false,
  onCopy,
  showTurnDuration = true,
  attachments,
  queuedWhileWorking = false,
  onPressAttachment,
  onRetry,
  directChild,
  onOpenDirectChildThread,
}: {
  item: PentacleTranscriptItem;
  chrome: HostChrome;
  streamId?: string;
  isLatestThinking?: boolean;
  onCopy?: CopyHandler;
  showTurnDuration?: boolean;
  // A1 (photo/camera send): image thumbs to render in this (user) bubble, FIFO.
  // Sourced from the transcript row. Tapping one opens the viewer.
  attachments?: RenderAttachment[];
  // B1 (send-while-working queue): this USER row was sent while the agent was
  // working, so it shows the native-CC-style queued affordance until delivery.
  queuedWhileWorking?: boolean;
  onPressAttachment?: (uri: string) => void;
  // FEAT-SEND-RETRY: tap-to-retry a "failed sending" row (re-arm → re-transmit).
  onRetry?: (optimisticId: string) => void;
  directChild?: ChildAgent | null;
  onOpenDirectChildThread?: (child: ChildAgent) => void;
}) {
  const hidesTurnDuration = !showTurnDuration &&
    (item.displayRule === 'terminal:divider' || item.displayRule === 'activity:turn-summary');
  const shouldAnimate = !animatedRowIds.has(item.id);
  const fade = useRef(new Animated.Value(shouldAnimate ? 0 : 1)).current;
  const lift = useRef(new Animated.Value(shouldAnimate ? 6 : 0)).current;
  const sendAffordance = userSendAffordance(item, queuedWhileWorking);
  const rowTelemetry = {
    streamId,
    rowId: item.id,
    rowKind: item.kind,
    displayRule: item.displayRule,
    text: item.text,
    eventKey: item.eventKey,
    optimisticId: item.optimisticId,
    correlatedDaemonSeq: typeof item.correlatedDaemonSeq === 'number' ? item.correlatedDaemonSeq : undefined,
    receiptCaption: item.receiptCaption,
    sendState: item.sendState,
    queuedOrigin: queuedWhileWorking,
    sendAffordance,
    attachmentCount: item.attachments?.length ?? 0,
    componentName: 'TranscriptRow',
    viewportVisible: !hidesTurnDuration,
  };

  useHarnessRowRenderTelemetry(rowTelemetry);

  useEffect(() => {
    if (harnessRuntime?.hasAction('composite_chat_load_probe') && !item.optimisticId) return;
    const mountGeneration = (transcriptItemMountGenerations.get(item.id) || 0) + 1;
    transcriptItemMountGenerations.set(item.id, mountGeneration);
    logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ITEM_MOUNTED, {
      id: item.id,
      mount_generation: mountGeneration,
      stream_id: streamId,
    });
  }, [item.id, streamId]);

  useEffect(() => {
    if (!shouldAnimate) return;
    animatedRowIds.add(item.id);
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: item.isUser ? 110 : 150,
        useNativeDriver: true,
      }),
      Animated.timing(lift, {
        toValue: 0,
        duration: item.isUser ? 110 : 150,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fade, item.id, item.isUser, lift, shouldAnimate]);

  const animatedStyle = {
    opacity: fade,
    transform: [{ translateY: lift }],
  };

  if (hidesTurnDuration) {
    return null;
  }

  if (item.isUser) {
    const targetId = messageCopyTargetId(item.id);
    // Parser-primary, uniform detection: a USER row whose text is an Option-B
    // answer message (`Answering your question(s):` …) renders as a clean
    // structured block instead of the raw AI-targeted grammar. Works for
    // optimistic, ingested, and history rows alike; malformed / non-answer
    // text returns null and falls back to the plain bubble below.
    const answer = parsePentacleQuestionAnswerText(item.text);
    // B3 (chat_send_turn_lifecycle_batch2): drive the user-send affordance off
    // the chat-core optimistic lifecycle (`sendState`) rather than only the
    // event's pending flag. A CANCELLED send (user interrupted it before it
    // landed) shows an explicit "Canceled" caption so it never reads as "sent".
    const canceled = sendAffordance === 'cancelled';
    // B1 (send-while-working queue): a row queued behind a working turn shows a
    // native-CC-style `❯ Queued` affordance before by-id dispatch; after dispatch
    // it reads as "Sending" until acked, then flips to "Sent" on delivery. The
    // captions show ONLY on queued-origin rows, never on ordinary idle sends.
    // Cancelled wins (an interrupted queued row reads "Canceled").
    const isQueuedAffordance = sendAffordance === 'queued';
    const isSentAffordance = sendAffordance === 'sent';
    const isSendingAffordance = sendAffordance === 'sending';
    const isFailedAffordance = sendAffordance === 'failed';
    // A1 (photo/camera send): a photo-only message has no text — render just the
    // image bubble(s), no empty text Bevel. Otherwise the text/answer bubble
    // sits below the thumbs (iMessage-style: photos above the caption).
    const hasTextBody = Boolean(answer) || item.text.trim().length > 0;
    return (
      <Animated.View style={[styles.userRow, animatedStyle]}>
        {attachments?.length ? (
          <View style={styles.userAttachments} testID={`message-attachments-${item.id}`}>
            {attachments.map((att, i) => (
              <MediaBubble
                key={i}
                uri={att.uri}
                width={att.width}
                height={att.height}
                borderColor={P.userBorder}
                testID={`message-image-${i}`}
                onPress={() => onPressAttachment?.(att.uri)}
              />
            ))}
          </View>
        ) : null}
        {hasTextBody ? (
          <Pressable
            testID={`message-bubble-${item.id}`}
            onLongPress={() => onCopy?.({ targetId, copyKind: 'message', text: item.text })}
            delayLongPress={350}
          >
            <Bevel
              cut={10}
              fill={P.userBubble}
              stroke={item.pending === false ? P.warning : P.userBorder}
              style={[styles.userBubble, item.pending === false && styles.userBubbleFailed]}
              contentStyle={styles.userBubbleContent}
            >
              {answer
                ? <AnswerBubble answer={answer} />
                : <Text {...SELECTABLE_TEXT} style={styles.userText}>{item.text}</Text>}
            </Bevel>
          </Pressable>
        ) : null}
        {canceled ? (
          <View style={styles.userSendStatusRow} testID="user-send-canceled">
            <FontAwesome name="ban" size={10} color={P.warning} />
            <Text {...NON_SELECTABLE_TEXT} style={styles.userSendStatusText}>Canceled</Text>
          </View>
        ) : null}
        {isQueuedAffordance ? (
          <View style={styles.userSendStatusRow} testID="queued-message-row">
            <Text {...NON_SELECTABLE_TEXT} style={styles.queuedChevron}>❯</Text>
            <Text {...NON_SELECTABLE_TEXT} style={styles.queuedSentText}>Queued</Text>
          </View>
        ) : null}
        {isSendingAffordance ? (
          <View style={styles.userSendStatusRow} testID="user-send-sending">
            <SendingIndicator />
            <Text {...NON_SELECTABLE_TEXT} style={styles.queuedSentText}>Sending</Text>
          </View>
        ) : null}
        {isFailedAffordance ? (
          <View style={styles.userSendStatusRow} testID="user-send-failed">
            <FontAwesome name="exclamation-circle" size={10} color={P.warning} />
            <Text {...NON_SELECTABLE_TEXT} style={styles.userSendStatusText}>Failed sending</Text>
            {item.optimisticId ? (
              <Pressable
                testID="user-send-retry"
                accessibilityRole="button"
                accessibilityLabel="Retry sending"
                hitSlop={8}
                onPress={() => onRetry?.(item.optimisticId as string)}
              >
                <Text
                  {...NON_SELECTABLE_TEXT}
                  style={[styles.userSendStatusText, { color: chrome.accent, fontWeight: '600' }]}
                >
                  Retry
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {isSentAffordance ? (
          <View style={styles.userSendStatusRow} testID="user-send-sent">
            <FontAwesome name="check" size={10} color={P.muted} />
            <Text {...NON_SELECTABLE_TEXT} style={styles.queuedSentText}>Sent</Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  if (item.displayRule === 'bubble:agent' || item.tone === 'agent') {
    return (
      <Animated.View testID={`agent-message-row-${item.id}`} style={[styles.agentRow, animatedStyle]}>
        <AgentMessageCard item={item} chrome={chrome} onCopy={onCopy} directChild={directChild} onOpenDirectChildThread={onOpenDirectChildThread} />
      </Animated.View>
    );
  }

  if (item.displayRule === 'terminal:divider') {
    const hasLabel = Boolean(item.text.trim());
    return (
      <Animated.View testID="terminal-divider-row" style={[styles.terminalDividerRow, animatedStyle]}>
        <View style={styles.terminalDividerLine} />
        {hasLabel ? <Text {...NON_SELECTABLE_TEXT} style={styles.terminalDividerText}>{item.text}</Text> : null}
        <View style={styles.terminalDividerLine} />
      </Animated.View>
    );
  }

  if (item.displayRule === 'activity:turn-summary') {
    return (
      <Animated.View testID="turn-summary-divider-row" style={[styles.terminalDividerRow, animatedStyle]}>
        <View style={styles.terminalDividerLine} />
        <Text {...NON_SELECTABLE_TEXT} style={styles.terminalDividerText}>{item.text}</Text>
        <View style={styles.terminalDividerLine} />
      </Animated.View>
    );
  }

  if (item.displayRule === 'system:compacted') {
    return (
      <Animated.View style={[styles.compactedRow, animatedStyle]}>
        <View style={styles.compactedCard}>
          <FontAwesome name="compress" size={11} color={P.warning} />
          <Text {...NON_SELECTABLE_TEXT} style={styles.compactedText}>{item.text}</Text>
        </View>
      </Animated.View>
    );
  }

  if (item.disclosure?.mode === 'collapsed-preview' && item.tone === 'tool') {
    return (
      <Animated.View style={animatedStyle}>
        <ToolResultCard item={item} text={item.text} chrome={chrome} />
      </Animated.View>
    );
  }

  if ((item.kind === 'TOOL_RESULT' || item.displayRule === 'activity:tool-output') && item.displayRule !== 'activity:question') {
    const toolResultText = stripClaudeExpandHint(item.text);
    if (!toolResultText || !toolResultText.trim()) return null;
    if (item.displayRule === 'activity:code-block') return null;
    return (
      <Animated.View style={animatedStyle}>
        <ToolResultCard item={item} text={toolResultText} chrome={chrome} />
      </Animated.View>
    );
  }

  if (item.displayRule === 'activity:code-block') {
    return (
      <Animated.View style={[styles.assistantRow, animatedStyle]}>
        <View style={styles.assistantCard}>
          <View style={styles.codeBlock}>
            <PreformattedScrollBlock text={item.text} textStyle={styles.codeText} />
          </View>
        </View>
      </Animated.View>
    );
  }

  if (item.displayRule.startsWith('activity:')) {
    if (item.displayRule === 'activity:tool-batch') {
      return (
        <Animated.View style={[styles.toolBatchRow, animatedStyle]}>
          <Text {...NON_SELECTABLE_TEXT} style={[styles.toolBatchText, { color: chrome.accent }]}>
            {item.text}
          </Text>
        </Animated.View>
      );
    }
    if (shouldRenderClaudePaneToolCard(item)) {
      const invocation = parseToolInvocation(item.text);
      return (
        <Animated.View style={[styles.toolUseRow, animatedStyle]}>
          <ToolInvocationCard invocation={invocation} chrome={chrome} renderTelemetry={rowTelemetry} />
        </Animated.View>
      );
    }
    const activity = splitActivityText(item.text);
    const isThinking = item.displayRule === 'activity:thinking';
    return (
      <Animated.View style={[styles.activityRow, animatedStyle]}>
        <View style={[styles.activityPill, { backgroundColor: chrome.surface, borderColor: chrome.border }]}>
          {isThinking ? (
            isLatestThinking ? (
              <AnimatedSpinnerGlyph style={[styles.activityThinkingGlyph, { color: chrome.accent }]} />
            ) : (
              <Text {...NON_SELECTABLE_TEXT} style={[styles.activityThinkingGlyph, { color: chrome.accent }]}>✻</Text>
            )
          ) : null}
          <View style={styles.activityBody}>
            <Text {...NON_SELECTABLE_TEXT} style={[styles.activityTitle, { color: chrome.accent }]}>
              {activity.title}
            </Text>
            {activity.detail ? (
              <Text {...SELECTABLE_TEXT} style={styles.activityText}>
                {activity.detail}
              </Text>
            ) : null}
          </View>
        </View>
      </Animated.View>
    );
  }

  const blocks = parseAssistantBlocks(item.text);
  const messageTargetId = messageCopyTargetId(item.id);
  return (
    <Animated.View style={[styles.assistantRow, animatedStyle]}>
      <Pressable
        testID={`message-card-${item.id}`}
        accessible={false}
        style={styles.assistantCard}
        onLongPress={() => onCopy?.({ targetId: messageTargetId, copyKind: 'message', text: item.text })}
        delayLongPress={350}
      >
        {blocks.map((block, index) => {
          if (block.type === 'edit') {
            return (
              <FileActionCard
                key={`${item.id}-edit-${index}`}
                title={block.title}
                meta={block.meta}
                body={block.body}
                chrome={chrome}
                rowId={item.id}
                blockId={`edit-${index}`}
                onCopy={onCopy}
              />
            );
          }
          if (block.type === 'command') {
            return (
              <View key={`${item.id}-cmd-${index}`} style={[styles.commandCard, { backgroundColor: chrome.surface, borderColor: chrome.border }]}>
                <Text {...SELECTABLE_TEXT} style={[styles.commandTitle, { color: chrome.accent }]}>{block.command}</Text>
                {block.output ? <Text {...SELECTABLE_TEXT} style={styles.commandOutput}>{block.output}</Text> : null}
              </View>
            );
          }
          return (
            <FormattedAssistantText
              key={`${item.id}-text-${index}`}
              text={block.text}
              rowId={item.id}
              blockId={`text-${index}`}
              onCopy={onCopy}
            />
          );
        })}
      </Pressable>
    </Animated.View>
  );
});

function TranscriptRowWithFetchedAttachments({
  item,
  ...props
}: Omit<React.ComponentProps<typeof TranscriptRow>, 'attachments'>) {
  const localAttachments = useMemo(
    () => renderAttachmentsWithLocalUris(item.attachments),
    [item.attachments],
  );
  const [fetchedAttachments, setFetchedAttachments] = useState<RenderAttachment[] | undefined>(localAttachments);

  useEffect(() => {
    let cancelled = false;
    if (localAttachments?.length || !item.attachments?.length) {
      setFetchedAttachments(localAttachments);
      return () => {
        cancelled = true;
      };
    }
    setFetchedAttachments(undefined);
    fetchRenderAttachments(item.attachments)
      .then((next) => {
        if (!cancelled) setFetchedAttachments(next);
      })
      .catch(() => {
        if (!cancelled) setFetchedAttachments(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [item.attachments, localAttachments]);

  return <TranscriptRow item={item} {...props} attachments={fetchedAttachments} />;
}

function ToolInvocationCard({
  invocation,
  chrome,
  renderTelemetry,
}: {
  invocation: ToolInvocation;
  chrome: HostChrome;
  renderTelemetry?: HarnessRowTelemetryInput;
}) {
  const isBash = invocation.title === 'Bash';
  const bodyPreview = truncateTranscriptLines(invocation.body, isBash ? 2 : 6);
  const hasBody = Boolean(bodyPreview.text);

  useHarnessRowRenderTelemetry({
    streamId: renderTelemetry?.streamId || '',
    rowId: renderTelemetry ? `${renderTelemetry.rowId}:tool_invocation_card` : '',
    displayRule: 'component:tool-invocation-card',
    text: `${invocation.title}\n${invocation.body}`,
    eventKey: renderTelemetry?.eventKey,
    optimisticId: renderTelemetry?.optimisticId,
    componentName: 'ToolInvocationCard',
    componentKey: renderTelemetry ? `${renderTelemetry.streamId}:ToolInvocationCard:${renderTelemetry.rowId}` : undefined,
    viewportVisible: renderTelemetry?.viewportVisible,
  });

  return (
    <View style={[styles.toolInvocationCard, { backgroundColor: chrome.surface, borderColor: chrome.border }]}>
      <Text {...NON_SELECTABLE_TEXT} style={[styles.toolInvocationTitle, { color: chrome.accent }]}>
        {invocation.title}
      </Text>
      {hasBody ? (
        <>
          <Text
            {...SELECTABLE_TEXT}
            style={styles.toolInvocationBody}
            numberOfLines={isBash ? 2 : undefined}
            ellipsizeMode={isBash ? 'tail' : undefined}
          >
            {bodyPreview.text}
          </Text>
          {bodyPreview.hiddenLines > 0 ? <Text {...SELECTABLE_TEXT} style={styles.toolResultTail}>{bodyPreview.tail}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

function CopyConfirmationToast({
  streamId,
  targetId,
}: {
  streamId: string;
  targetId: string | null;
}) {
  useHarnessRowRenderTelemetry({
    streamId,
    rowId: targetId ? `copy_confirmation:${targetId}` : '',
    displayRule: 'component:copy-confirmation',
    text: targetId ? 'Copied' : '',
    eventKey: targetId ? `${streamId}:copy_confirmation:${targetId}` : undefined,
    componentName: 'CopyConfirmation',
    componentKey: targetId ? `${streamId}:CopyConfirmation:${targetId}` : undefined,
    viewportVisible: Boolean(targetId),
    emitUnmount: true,
  });
  if (!targetId) return null;
  return (
    <View
      testID="chat-copy-confirmation"
      accessibilityLabel="Copied"
      style={styles.copyToast}
      pointerEvents="none"
    >
      <FontAwesome name="check" size={10} color={P.bg} />
      <Text {...NON_SELECTABLE_TEXT} style={styles.copyToastText}>Copied</Text>
    </View>
  );
}

export function FileActionCard({
  title,
  meta,
  body,
  chrome,
}: {
  title: string;
  meta: string;
  body: string;
  chrome: HostChrome;
  rowId?: string;
  blockId?: string;
  onCopy?: CopyHandler;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyPreview = truncateTranscriptLines(body, expanded ? Number.POSITIVE_INFINITY : 6);
  const hasBody = Boolean(body.trim());
  const hasHiddenLines = bodyPreview.hiddenLines > 0;

  return (
    <View style={[styles.fileCard, { backgroundColor: chrome.surface, borderColor: chrome.border }]}>
      <Pressable
        style={styles.fileHeader}
        onPress={() => {
          if (hasBody) setExpanded((current) => !current);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
        accessibilityState={{ expanded }}
        testID="file-action-header"
      >
        <View style={styles.fileHeaderText}>
          <Text {...NON_SELECTABLE_TEXT} style={[styles.fileTitle, { color: chrome.accent }]}>{title}</Text>
          {meta ? <Text {...NON_SELECTABLE_TEXT} style={[styles.fileMeta, { color: chrome.accent }]}>{meta}</Text> : null}
        </View>
        {hasBody ? (
          <FontAwesome name={expanded ? 'chevron-up' : 'chevron-down'} size={11} color={chrome.accent} />
        ) : null}
      </Pressable>
      {hasBody ? (
        <View style={styles.codeBlock}>
          <Text {...SELECTABLE_TEXT} style={styles.codeText}>{bodyPreview.text}</Text>
          {hasHiddenLines ? <Text {...SELECTABLE_TEXT} style={styles.toolResultTail}>{bodyPreview.tail}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

type QuestionKeyFields = {
  active_index?: number;
  id?: string;
  max?: number;
  max_select?: number;
  max_selected?: number;
  maxSelections?: number;
  min?: number;
  min_select?: number;
  min_selected?: number;
  minSelections?: number;
  multiSelect?: boolean;
  question_id?: string;
  question_key?: string;
  questionId?: string;
  questionKey?: string;
  scan_incomplete?: boolean;
};

function buildQuestionKey(question: PentacleQuestion) {
  const parent = question as PentacleQuestion & QuestionKeyFields;
  return JSON.stringify({
    multi: !!question.multi,
    multiSelect: !!parent.multiSelect,
    active_index: parent.active_index,
    scan_incomplete: !!parent.scan_incomplete,
    questions: mobileQuestionItems(question).map((item) => {
      const fields = item as MobileQuestionItem & QuestionKeyFields;
      return {
        id: String(fields.question_id || fields.questionId || fields.id || item.index),
        index: item.index,
        header: item.header || '',
        prompt: item.prompt || '',
        free_text: !!item.free_text,
        multiSelect: !!item.multiSelect,
        min: fields.min_select ?? fields.min_selected ?? fields.minSelections ?? fields.min,
        max: fields.max_select ?? fields.max_selected ?? fields.maxSelections ?? fields.max,
        options: (item.options || [])
          .filter((option) => !option.meta)
          .map((option) => [option.index, option.label]),
      };
    }),
  });
}

function serverQuestionKey(question: PentacleQuestion) {
  const fields = question as PentacleQuestion & QuestionKeyFields;
  const key = fields.question_key ?? fields.questionKey;
  return typeof key === 'string' && key ? key : '';
}

export function WorkingIndicatorRow({
  chrome,
  onCancel,
  streamId = '',
  workingIdentity = '',
  elapsedSeconds = null,
  retryNotice = null,
}: {
  chrome: HostChrome;
  onCancel: () => void;
  streamId?: string;
  workingIdentity?: string;
  elapsedSeconds?: number | null;
  retryNotice?: string | null;
}) {
  const displayElapsedSeconds = typeof elapsedSeconds === 'number' && Number.isFinite(elapsedSeconds)
    ? Math.max(0, elapsedSeconds)
    : 0;
  const hasPositiveElapsed = displayElapsedSeconds > 0;
  const [showRow, setShowRow] = useState(() => hasPositiveElapsed);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (hasPositiveElapsed) {
      setShowRow(true);
      return;
    }
    setShowRow(false);
    const timer = setTimeout(() => setShowRow(true), SESSION_SENDING_VISIBLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [streamId, workingIdentity, hasPositiveElapsed]);

  if (!showRow) return null;

  const spinnerDurationMs = prefersReducedMotion ? 3200 : 800;

  return (
    <View
      testID="working-dock"
      style={styles.workingIndicatorRow}
      collapsable={false}
    >
      <View testID="working-indicator-spinner" style={styles.workingIndicatorSpinner}>
        <Spinner
          size={13}
          color={chrome.accent}
          strokeWidth={3}
          durationMs={spinnerDurationMs}
          trackOpacity={0.15}
          segmentFraction={0.25}
        />
      </View>
      <Text
        {...NON_SELECTABLE_TEXT}
        testID="working-indicator-timer"
        style={[styles.workingIndicatorTimer, { color: chrome.accent }]}
      >
        {formatElapsedSeconds(displayElapsedSeconds)}
      </Text>
      {retryNotice ? (
        <Text
          {...NON_SELECTABLE_TEXT}
          testID="interrupt-retry-affordance"
          style={styles.workingIndicatorRetryText}
          numberOfLines={2}
        >
          {retryNotice}
        </Text>
      ) : null}
      <Pressable
        testID="esc-interrupt-button"
        accessibilityLabel="Cancel"
        accessibilityRole="button"
        onPress={onCancel}
        hitSlop={9}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
          styles.workingIndicatorCancel,
          {
            borderColor: `${chrome.accent}54`,
            backgroundColor: pressed || hovered ? `${chrome.accent}1f` : 'transparent',
          },
        ]}
      >
        <View
          testID="working-indicator-cancel-glyph"
          style={[styles.workingIndicatorCancelGlyph, { backgroundColor: chrome.accent }]}
        />
      </Pressable>
    </View>
  );
}

function shouldRetryInterrupt(result: InterruptSendResult | boolean | null | undefined): boolean {
  return Boolean(
    result &&
    typeof result === 'object' &&
    (result.confirm === 'interrupt_unconfirmed' || result.confirm === 'pane_unavailable')
  );
}


export function WorkingDock({
  chrome,
  streamId = '',
  workingState,
  workingStartedAt = null,
  verbose = false,
}: {
  chrome: HostChrome;
  streamId?: string;
  workingLabel?: string;
  lastEventAt?: string;
  workingState?: WorkingStateData;
  workingStartedAt?: number | null;
  verbose?: boolean;
}) {
  const now = useTicker(workingStartedAt !== null);
  const lastDisplayedSecondsRef = useRef(0);
  const hasStartedTimer = workingStartedAt !== null;

  useEffect(() => {
    if (workingStartedAt === null) {
      lastDisplayedSecondsRef.current = 0;
    }
  }, [workingStartedAt]);

  let displayedSeconds: number | null = null;
  if (hasStartedTimer) {
    displayedSeconds = Math.max(
      lastDisplayedSecondsRef.current,
      Math.floor(Math.max(0, now - workingStartedAt) / 1000),
    );
    lastDisplayedSecondsRef.current = displayedSeconds;
  }

  // The active dock title is provider-neutral. Provider-specific working_label
  // values stay out of the title; verbose mode only adds token/task details.
  const baseLabel = `Working${displayedSeconds !== null ? ` · ${formatElapsedSeconds(displayedSeconds)}` : ''}`;
  const label = verbose
    ? formatWorkingDockLabel(baseLabel, workingState)
    : baseLabel;
  const taskLines = verbose ? formatWorkingTaskLines(workingState) : [];
  const componentKey = `${streamId}:WorkingDock:${workingStartedAt ?? workingState?.timestamp ?? 'pending'}`;

  useHarnessRowRenderTelemetry({
    streamId,
    rowId: `working_dock:${streamId}`,
    displayRule: 'component:working-dock',
    text: label,
    eventKey: componentKey,
    componentName: 'WorkingDock',
    componentKey,
    viewportVisible: true,
    emitUnmount: true,
  });

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
    logHarnessDockLabelRender(streamId, label, displayedSeconds, componentKey);
  }, [componentKey, displayedSeconds, label, streamId]);

  return (
    <View style={[styles.activityDock, { backgroundColor: chrome.surface, borderColor: chrome.border }]}>
      <AnimatedSpinnerGlyph style={[styles.activityDockGlyph, { color: chrome.accent }]} />
      <View style={styles.activityDockBody}>
        <Text {...NON_SELECTABLE_TEXT} style={styles.activityDockTitle} numberOfLines={2}>{label}</Text>
        {taskLines.length ? (
          <View style={styles.activityDockTasks}>
            {taskLines.map((line) => (
              <Text {...NON_SELECTABLE_TEXT} key={line} style={styles.activityDockTaskText} numberOfLines={2}>{line}</Text>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function formatWorkingDockLabel(baseLabel: string, workingState?: WorkingStateData) {
  const parts = [baseLabel || 'Working'];
  if (workingState && workingState.tokens_output > 0 && workingState.tokens_phase !== 'idle') {
    const arrow = workingState.tokens_phase === 'up' ? '↑' : '↓';
    parts.push(`${arrow} ${formatCompactTokens(workingState.tokens_output)} tokens`);
  }
  const shellCount = workingState?.shell_count_started || 0;
  if (shellCount > 0) {
    parts.push(`${shellCount} shell${shellCount === 1 ? '' : 's'} started`);
  }
  return parts.join(' · ');
}

export function formatWorkingTaskLines(workingState?: WorkingStateData) {
  const summary = workingState?.task_summary;
  if (!summary || summary.total <= 0) return [];
  const lines = [`${summary.total} tasks (${summary.done} done, ${summary.in_progress} in progress, ${summary.open} open)`];
  const tasks = Array.isArray(workingState?.tasks) ? workingState.tasks : [];
  const visibleTasks = tasks.slice(0, 3);
  for (const task of visibleTasks) {
    lines.push(formatWorkingTaskLine(task));
  }
  const hiddenOpen = Math.max(0, tasks.length - visibleTasks.length);
  if (summary.done > 0) {
    lines.push(`… +${summary.done} completed`);
  }
  if (hiddenOpen > 0) {
    lines.push(`… +${hiddenOpen} open`);
  }
  return lines;
}

function formatWorkingTaskLine(task: WorkingTaskData) {
  const glyph = task.status === 'in_progress' ? '◼' : '◻';
  const blockers = Array.isArray(task.blocked_by)
    ? task.blocked_by.map((id) => `#${id}`).join(', ')
    : '';
  return `${glyph} ${task.subject}${blockers ? ` › blocked by ${blockers}` : ''}`;
}

function formatCompactTokens(value: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value).toLowerCase();
}

export function AnimatedSpinnerGlyph({ style }: { style: any }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % SPINNER_GLYPHS.length);
    }, SPINNER_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return <Text {...NON_SELECTABLE_TEXT} style={style}>{SPINNER_GLYPHS[index]}</Text>;
}

export function ComposerBar({
  host,
  chrome,
  disabled,
  submissionDisabled = false,
  dismissToken,
  refocusToken,
  prefillText,
  prefillToken,
  guardedPrefillText,
  guardedPrefillToken,
  onFocus,
  onSend,
  onError,
  onRegisterSendHandler,
}: {
  host: string;
  chrome: HostChrome;
  disabled: boolean;
  submissionDisabled?: boolean;
  dismissToken: number;
  refocusToken: number;
  prefillText?: string;
  prefillToken?: number;
  guardedPrefillText?: string;
  guardedPrefillToken?: number;
  onFocus: () => void;
  // A1 (photo/camera send): a send carries text AND/OR up to 5 image attachments.
  // `attachments` are daemon blob refs (wire payload, FIFO); `thumbs` are the
  // local file:// URIs for the optimistic bubble render.
  onSend: (
    text: string,
    optimisticAttachments?: ChatAttachment[],
    thumbs?: RenderAttachment[],
    upload?: StagedUpload,
  ) => Promise<void>;
  onError: (message: string) => void;
  onRegisterSendHandler?: (fn: ((request: HarnessSendRequest) => Promise<void>) | null) => void;
}) {
  const [composer, setComposer] = useState('');
  // Expanded state for the top-right "+" more-menu (photo + camera actions).
  const [moreExpanded, setMoreExpanded] = useState(false);
  // A1: images staged in the draft (compressed, pre-upload), FIFO. They preview
  // as a removable thumb strip above the input; text is still typeable alongside.
  const [stagedAttachments, setStagedAttachments] = useState<ProcessedAsset[]>([]);
  // True while a library/camera pick is being compressed — disables re-entry.
  const [picking, setPicking] = useState(false);
  // Synchronous double-send latch — `sendDisabled`/state only flip on re-render,
  // so a fast second tap can fire a second upload+send before React re-renders.
  // Mirrors altum's `sendInFlightRef` (commit 8ad1987).
  const sendInFlightRef = useRef(false);
  const inputRef = useRef<TextInputInstance | null>(null);

  useEffect(() => {
    inputRef.current?.blur();
  }, [dismissToken]);

  useEffect(() => {
    if (refocusToken > 0) {
      inputRef.current?.focus();
    }
  }, [refocusToken]);

  useEffect(() => {
    if (!prefillToken || prefillText === undefined) return;
    setComposer(prefillText);
    inputRef.current?.focus();
  }, [prefillText, prefillToken]);

  useEffect(() => {
    if (!guardedPrefillToken || guardedPrefillText === undefined) return;
    setComposer((current) => (current ? current : guardedPrefillText));
    inputRef.current?.focus();
  }, [guardedPrefillText, guardedPrefillToken]);

  // Harness-driven send entry point. Mirrors `handleSend` below but accepts a
  // caller-supplied text rather than reading the local `composer` state — this
  // lets `dispatchSend` drive the same code path without having to mutate the
  // TextInput. Keeps user-typed text intact when the harness sends.
  const fixtureImageToAsset = useCallback(async (request: Exclude<HarnessSendRequest, string>): Promise<ProcessedAsset> => {
    const directory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    if (!directory) throw new Error('No writable fixture image directory');
    const safeName = String(request.fixtureImage.name || `harness-fixture-${Date.now()}`)
      .replace(/[^A-Za-z0-9_.-]/g, '_');
    const ext = request.fixtureImage.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const uri = `${directory}${safeName.endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`}`;
    await FileSystem.writeAsStringAsync(uri, request.fixtureImage.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return {
      uri,
      fileName: uri.split('/').pop() || `harness-fixture.${ext}`,
      mimeType: request.fixtureImage.mimeType,
      width: request.fixtureImage.width ?? null,
      height: request.fixtureImage.height ?? null,
      bytes: request.fixtureImage.bytes ?? Math.max(0, Math.floor((request.fixtureImage.base64.length * 3) / 4)),
    };
  }, []);

  const handleHarnessSend = useCallback(
    async (request: HarnessSendRequest) => {
      const text = typeof request === 'string' ? request : request.text ?? '';
      const trimmed = String(text || '').trim();
      const fixtureRequest = typeof request === 'string' ? null : request;
      if (!trimmed && !fixtureRequest) return;
      try {
        if (!fixtureRequest) {
          await onSend(trimmed);
          return;
        }
        const staged = [await fixtureImageToAsset(fixtureRequest)];
        const thumbs: RenderAttachment[] = staged.map((asset) => ({
          uri: asset.uri,
          width: asset.width ?? undefined,
          height: asset.height ?? undefined,
        }));
        const optimisticAttachments = optimisticAttachmentsForStaged(staged);
        await onSend(trimmed, optimisticAttachments, thumbs, beginStagedUpload(staged));
      } catch (error) {
        onError(error instanceof Error ? error.message : `Failed to send message to ${host}`);
        throw error;
      }
    },
    [fixtureImageToAsset, host, onError, onSend],
  );

  useEffect(() => {
    if (!onRegisterSendHandler) return;
    onRegisterSendHandler(handleHarnessSend);
    return () => {
      onRegisterSendHandler(null);
    };
  }, [handleHarnessSend, onRegisterSendHandler]);

  // A1: add picked/captured photos to the draft, compressing each (HEIC→JPEG,
  // D2) before staging. The 5-image cap (D2) is enforced here — the library pick
  // is limited to the remaining slots, the camera is blocked at the cap, and a
  // belt-and-braces slice keeps the staged list ≤5. A `MediaTooLargeError` (a
  // photo that won't fit the ceiling) surfaces via onError without aborting the
  // others already staged.
  const stageProcessed = useCallback(
    (processed: ProcessedAsset[]) => {
      if (!processed.length) return;
      setStagedAttachments((prev) => [...prev, ...processed].slice(0, MAX_CHAT_ATTACHMENTS));
    },
    [],
  );

  const handlePickPhoto = useCallback(async () => {
    if (picking || sendInFlightRef.current) return;
    const remaining = MAX_CHAT_ATTACHMENTS - stagedAttachments.length;
    if (remaining <= 0) {
      onError(`You can attach up to ${MAX_CHAT_ATTACHMENTS} photos.`);
      return;
    }
    setPicking(true);
    try {
      const picked = await pickImagesFromLibrary(remaining);
      const processed: ProcessedAsset[] = [];
      for (const asset of picked) {
        try {
          processed.push(await compressForUpload(asset));
        } catch (error) {
          onError(
            error instanceof MediaTooLargeError
              ? 'That photo is too large to send.'
              : 'Could not process that photo.',
          );
        }
      }
      stageProcessed(processed);
    } finally {
      setPicking(false);
    }
  }, [onError, picking, stageProcessed, stagedAttachments.length]);

  const handlePickCamera = useCallback(async () => {
    if (picking || sendInFlightRef.current) return;
    if (stagedAttachments.length >= MAX_CHAT_ATTACHMENTS) {
      onError(`You can attach up to ${MAX_CHAT_ATTACHMENTS} photos.`);
      return;
    }
    setPicking(true);
    try {
      const shot = await captureImageFromCamera();
      if (!shot) return;
      try {
        stageProcessed([await compressForUpload(shot)]);
      } catch (error) {
        onError(
          error instanceof MediaTooLargeError
            ? 'That photo is too large to send.'
            : 'Could not process that photo.',
        );
      }
    } catch (error) {
      // B4: surface a friendly error instead of failing silently if the native
      // camera launch throws (e.g. a permission-state mismatch).
      onError('Could not open the camera.');
    } finally {
      setPicking(false);
    }
  }, [onError, picking, stageProcessed, stagedAttachments.length]);

  const removeStagedAttachment = useCallback((index: number) => {
    setStagedAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = () => {
    const text = composer.trim();
    const staged = stagedAttachments;
    // Send when there is text OR at least one photo (photo-only is allowed). B1
    // removed the working-state block — the user may send while the agent works
    // (the parent queues it). The connection `disabled` gate, the empty-input
    // guard, and the synchronous double-send latch still hold.
    if (disabled || submissionDisabled || (!text && staged.length === 0)) return;
    if (sendInFlightRef.current) {
      onError('A message is already sending. Please wait.');
      return;
    }
    sendInFlightRef.current = true;

    // Clear the draft optimistically (snappy UX); restore it if the send fails
    // so an all-or-nothing batch is never silently lost.
    setComposer('');
    setStagedAttachments([]);
    // composer_text_persists_after_send_2026_09: on iOS a multiline TextInput
    // commits pending marked text (predictive/QuickType input, dictation,
    // third-party keyboards — autocorrect itself is off here) when it resigns
    // first responder, which can re-populate the native view AFTER the
    // controlled `value` went to '' — the message sends, but the text stays on
    // screen and the next tap has nothing to send. Clear the native view
    // imperatively on both sides of the keyboard dismissal so the state and
    // the view agree, whatever the composition source.
    inputRef.current?.clear();
    Keyboard.dismiss();
    inputRef.current?.clear();

    // Text-only fast path — no upload, dispatch synchronously so the optimistic
    // bubble lands immediately (preserves the pre-A1 send behavior exactly).
    if (staged.length === 0) {
      onSend(text)
        .catch((error) => {
          setComposer((current) => (current ? current : text));
          onError(error instanceof Error ? error.message : `Failed to send message to ${host}`);
        })
        .finally(() => {
          sendInFlightRef.current = false;
        });
      return;
    }

    void (async () => {
      try {
        const thumbs: RenderAttachment[] = staged.map((asset) => ({
          uri: asset.uri,
          width: asset.width ?? undefined,
          height: asset.height ?? undefined,
        }));
        const optimisticAttachments = optimisticAttachmentsForStaged(staged);
        await onSend(text, optimisticAttachments, thumbs, beginStagedUpload(staged));
      } catch (error) {
        // Restore the draft so the user can retry the whole batch.
        setComposer((current) => (current ? current : text));
        setStagedAttachments((current) => (current.length ? current : staged));
        onError(error instanceof Error ? error.message : `Failed to send message to ${host}`);
      } finally {
        sendInFlightRef.current = false;
      }
    })();
  };

  // The "+" toggles the more-menu; any other composer interaction (typing/
  // focusing the input, sending, or a tap-away on the bar background) collapses
  // it. The collapse stays out of the way of the underlying action — focusing
  // still focuses, sending still sends.
  const collapseMore = useCallback(() => setMoreExpanded(false), []);
  const toggleMore = useCallback(() => setMoreExpanded((open) => !open), []);

  // Send is active when there is text OR at least one staged photo (a photo-only
  // message is allowed), unless the composer is disabled (connection/editable).
  // B1: the working state no longer disables send — sending mid-turn is allowed.
  const sendInactive = (!composer.trim() && stagedAttachments.length === 0) || disabled || submissionDisabled;

  return (
    <View
      style={styles.composerShell}
      testID="composer-bar"
      accessibilityLabel="Message composer"
      accessible
      collapsable={false}
    >
      {stagedAttachments.length ? (
        // A1: in-draft preview strip — each staged photo with a per-photo remove
        // affordance. The user can keep typing in the composer-input alongside.
        <View style={styles.attachmentStrip} testID="composer-attachment-strip">
          {stagedAttachments.map((asset, index) => (
            <View key={`${asset.uri}-${index}`} style={styles.attachmentThumbWrap}>
              <Image
                source={{ uri: asset.uri }}
                style={styles.attachmentThumb}
                testID={`composer-attachment-thumb-${index}`}
              />
              <Pressable
                testID={`composer-attachment-remove-${index}`}
                accessibilityLabel="Remove photo"
                accessibilityRole="button"
                onPress={() => removeStagedAttachment(index)}
                style={styles.attachmentRemove}
                hitSlop={8}
              >
                <FontAwesome name="close" size={11} color="#ffffff" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View
        testID="composer-capsule"
        collapsable={false}
        style={[
          styles.composerCapsule,
          {
            borderColor: `${chrome.accent}54`,
            shadowColor: chrome.accent,
          },
        ]}
      >
        <View
          pointerEvents="none"
          testID="composer-capsule-hairline"
          style={[StyleSheet.absoluteFill, styles.composerCapsuleHairline, { borderColor: `${chrome.accent}0f` }]}
        />
        <View style={[styles.composerBar, moreExpanded ? styles.composerBarExpanded : null]}>
        {moreExpanded ? (
          // Tap-away: catches presses on the bar background (the gaps not
          // covered by the input or the on-top action buttons) and collapses
          // the menu. First child ⇒ lowest in the sibling stack, so the input
          // and buttons rendered after it stay hittable.
          <Pressable
            testID="composer-tap-away"
            accessibilityLabel="Dismiss attachment menu"
            accessibilityRole="button"
            onPress={collapseMore}
            style={styles.composerTapAway}
          />
        ) : null}
        <TextInput
          testID="composer-input"
          accessibilityLabel="Message input"
          ref={inputRef}
          style={styles.composerInput}
          value={composer}
          onChangeText={(text) => {
            if (moreExpanded) {
              collapseMore();
            }
            setComposer(text);
          }}
          placeholder=""
          placeholderTextColor={P.muted}
          multiline
          textAlignVertical="center"
          autoCorrect={false}
          keyboardAppearance="dark"
          editable={!disabled}
          returnKeyType="default"
          blurOnSubmit={false}
          onFocus={() => {
            collapseMore();
            onFocus();
          }}
          onPressIn={collapseMore}
        />
        {!moreExpanded ? (
          <Pressable
            testID="composer-plus-button"
            accessibilityLabel="More actions"
            accessibilityRole="button"
            accessibilityState={{ expanded: moreExpanded }}
            onPress={toggleMore}
            style={styles.plusButton}
            hitSlop={8}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path
                d="M12 5v14M5 12h14"
                fill="none"
                stroke={Tokens.palette.green}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </Svg>
          </Pressable>
        ) : null}
        {moreExpanded ? (
          <Pressable
            testID="composer-camera-button"
            accessibilityLabel="Take photo"
            accessibilityRole="button"
            onPress={() => {
              collapseMore();
              void handlePickCamera();
            }}
            style={styles.cameraButton}
            hitSlop={8}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path
                d="M4 8h3l1.5-2h7L17 8h3v11H4z"
                fill="none"
                stroke={Tokens.palette.green}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <Circle cx={12} cy={13} r={3} fill="none" stroke={Tokens.palette.green} strokeWidth={2} />
            </Svg>
          </Pressable>
        ) : null}
        {moreExpanded ? (
          <Pressable
            testID="composer-photo-button"
            accessibilityLabel="Choose photo"
            accessibilityRole="button"
            onPress={() => {
              collapseMore();
              void handlePickPhoto();
            }}
            style={styles.photoButton}
            hitSlop={8}
          >
            <Svg width={18} height={18} viewBox="0 0 24 24">
              <Path
                d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5"
                fill="none"
                stroke={Tokens.palette.green}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <Circle cx={9} cy={9} r={1.5} fill="none" stroke={Tokens.palette.green} strokeWidth={2} />
            </Svg>
          </Pressable>
        ) : null}
        <Pressable
          testID="composer-send-button"
          accessibilityLabel="Send message"
          accessibilityRole="button"
          accessibilityState={{ disabled: sendInactive }}
          disabled={sendInactive}
          onPress={() => {
            collapseMore();
            handleSend();
          }}
          style={[styles.sendButton, sendInactive && styles.sendButtonDisabled]}
          hitSlop={8}
        >
          <WandCastSendIcon color={Tokens.palette.green} size={20} />
        </Pressable>
        </View>
      </View>
    </View>
  );
}

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'edit'; title: string; meta: string; body: string }
  | { type: 'command'; command: string; output: string };

const ACTION_PREFIX = /^(Edited|Added|Wrote|Created|Updated)\s+(.+?)(?:\s+\((.+)\))?$/;

// Render a shared chat-core markdown inline token tree to RN <Text> children.
// RN <Text> nests styles, so strong/em/code/link compose by nesting. Leaf
// strings are passed straight to <Text> (inert — no escaping needed on RN).
function renderMdInline(nodes: MdInline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'text':
        return node.value;
      case 'strong':
        return <Text key={key} style={styles.mdStrong}>{renderMdInline(node.children, key)}</Text>;
      case 'em':
        return <Text key={key} style={styles.mdEm}>{renderMdInline(node.children, key)}</Text>;
      case 'code':
        return <Text key={key} style={styles.mdCode}>{node.value}</Text>;
      case 'link':
        return (
          <Text
            key={key}
            style={styles.mdLink}
            onPress={() => { Linking.openURL(node.href).catch(() => undefined); }}
          >
            {renderMdInline(node.children, key)}
          </Text>
        );
      case 'break':
        return '\n';
      default:
        return null;
    }
  });
}

function mdInlinePlainText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((node) => {
    if (!node || typeof node !== 'object') return '';
    const n = node as { type?: string; value?: unknown; children?: unknown };
    switch (n.type) {
      case 'text':
      case 'code':
        return typeof n.value === 'string' ? n.value : '';
      case 'strong':
      case 'em':
      case 'link':
        return mdInlinePlainText(n.children);
      case 'break':
        return '\n';
      default:
        return '';
    }
  }).join('');
}

function mdCellPlainText(cell: unknown): string {
  return mdInlinePlainText(cell);
}

function mdTablePlainText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const table = block as { header?: unknown; rows?: unknown };
  const lines: string[] = [];
  if (Array.isArray(table.header)) {
    lines.push(table.header.map(mdCellPlainText).join(' | '));
  }
  if (Array.isArray(table.rows)) {
    for (const row of table.rows) {
      if (Array.isArray(row)) lines.push(row.map(mdCellPlainText).join(' | '));
    }
  }
  return lines.filter((line) => line.length > 0).join('\n');
}

type MdTableAlign = 'left' | 'center' | 'right' | null;

export type MdTableGridColumn = {
  align: MdTableAlign;
  minWidth: number;
};

export type MdTableGrid = {
  columns: MdTableGridColumn[];
  header: MdInline[][];
  rows: MdInline[][][];
  totalMinWidth: number;
};

const TABLE_CELL_MIN_WIDTH = 76;
const TABLE_CELL_MAX_WIDTH = 220;
const TABLE_CELL_CHAR_WIDTH = 7.5;
const TABLE_CELL_HORIZONTAL_PADDING = 20;

function isMdInlineCell(cell: unknown): cell is MdInline[] {
  return Array.isArray(cell);
}

function normalizeMdInlineCell(cell: unknown): MdInline[] {
  return isMdInlineCell(cell) ? cell : [];
}

function tableColumnTextWidth(cell: MdInline[] | undefined): number {
  const text = mdInlinePlainText(cell ?? []);
  const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.trim().length), 0);
  return Math.min(
    TABLE_CELL_MAX_WIDTH,
    Math.max(TABLE_CELL_MIN_WIDTH, Math.ceil(longestLine * TABLE_CELL_CHAR_WIDTH) + TABLE_CELL_HORIZONTAL_PADDING),
  );
}

export function deriveMdTableGrid(block: unknown): MdTableGrid | null {
  if (!block || typeof block !== 'object') return null;
  const table = block as { align?: unknown; header?: unknown; rows?: unknown };
  const header = Array.isArray(table.header) ? table.header.map(normalizeMdInlineCell) : [];
  const rows = Array.isArray(table.rows)
    ? table.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map(normalizeMdInlineCell))
    : [];
  const columnCount = Math.max(
    header.length,
    rows.reduce((max, row) => Math.max(max, row.length), 0),
  );
  if (columnCount === 0 || (header.length === 0 && rows.length === 0)) return null;

  const align = Array.isArray(table.align) ? table.align : [];
  const columns = Array.from({ length: columnCount }, (_, index): MdTableGridColumn => {
    const cells = [header[index], ...rows.map((row) => row[index])];
    const minWidth = cells.reduce((max, cell) => Math.max(max, tableColumnTextWidth(cell)), TABLE_CELL_MIN_WIDTH);
    const rawAlign = align[index];
    return {
      align: rawAlign === 'left' || rawAlign === 'center' || rawAlign === 'right' ? rawAlign : null,
      minWidth,
    };
  });

  return {
    columns,
    header,
    rows,
    totalMinWidth: columns.reduce((sum, column) => sum + column.minWidth, 0),
  };
}

function textAlignForTableCell(align: MdTableAlign): 'left' | 'center' | 'right' {
  return align === 'center' || align === 'right' ? align : 'left';
}

function renderMdTableGrid(block: unknown, key: string): React.ReactNode {
  const grid = deriveMdTableGrid(block);
  if (!grid) return null;
  const rows = [grid.header, ...grid.rows];
  return (
    <View key={key} style={styles.tableBlock}>
      <GestureScrollView
        horizontal
        showsHorizontalScrollIndicator
        nestedScrollEnabled
        directionalLockEnabled={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.tableScrollContent}
      >
        <View style={[styles.tableGrid, { width: grid.totalMinWidth }]}>
          {rows.map((row, rowIndex) => (
            <View key={`${key}-r${rowIndex}`} style={[styles.tableRow, rowIndex === 0 && styles.tableHeaderRow]}>
              {grid.columns.map((column, columnIndex) => (
                <View
                  key={`${key}-r${rowIndex}-c${columnIndex}`}
                  style={[
                    styles.tableCell,
                    rowIndex === 0 && styles.tableHeaderCell,
                    columnIndex === grid.columns.length - 1 && styles.tableCellLast,
                    { width: column.minWidth },
                  ]}
                  >
                    <Text
                    {...SELECTABLE_TEXT}
                      style={[
                        styles.assistantText,
                        styles.tableCellText,
                      rowIndex === 0 && styles.tableHeaderText,
                      { textAlign: textAlignForTableCell(column.align) },
                    ]}
                  >
                    {renderMdInline(row[columnIndex] ?? [], `${key}-r${rowIndex}-c${columnIndex}`)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </GestureScrollView>
    </View>
  );
}

function parsedBlocksContainTable(text: string): boolean {
  return parseMarkdown(text).some((block) => block.type === 'table');
}

function mdBlockPlainText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as {
    type?: string;
    children?: unknown;
    items?: unknown;
    text?: unknown;
    header?: unknown;
    rows?: unknown;
  };
  if (b.type === 'table') return mdTablePlainText(b);
  if (Array.isArray(b.children)) return mdInlinePlainText(b.children);
  if (typeof b.text === 'string') return b.text;
  if (Array.isArray(b.items)) {
    return b.items.map((item) => mdInlinePlainText(item)).filter(Boolean).join('\n');
  }
  return '';
}

type RenderableMdBlock = {
  type: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: MdInline[];
  text?: string;
  lang?: string | null;
  ordered?: boolean;
  items?: MdInline[][];
  header?: unknown;
  rows?: unknown;
};

function mdHeadingStyle(level: number) {
  if (level <= 1) return styles.mdH1;
  if (level === 2) return styles.mdH2;
  return styles.mdH3;
}

// Render markdown block tokens (from a prose chunk) to RN elements. Mirrors the
// desktop block renderer so both surfaces share the parser; mobile-specific
// block parsing (parseTextBlocks) still extracts code/list/divider upstream, so
// here we mostly see headings + paragraphs, but all block kinds are handled.
function renderMdBlocks(
  text: string,
  keyPrefix: string,
): React.ReactNode[] {
  return parseMarkdown(text).map((rawBlock: MdBlock, i) => {
    const block = rawBlock as unknown as RenderableMdBlock;
    const key = `${keyPrefix}-b${i}`;
    switch (block.type) {
      case 'heading':
        return (
          <Text key={key} {...SELECTABLE_TEXT} style={[styles.assistantText, styles.mdHeading, mdHeadingStyle(block.level ?? 3)]}>
            {renderMdInline(block.children ?? [], key)}
          </Text>
        );
      case 'paragraph':
        return (
          <Text key={key} {...SELECTABLE_TEXT} style={styles.assistantText}>
            {renderMdInline(block.children ?? [], key)}
          </Text>
        );
      case 'code_block':
        {
          const codeText = block.text ?? '';
          return (
            <View key={key} style={styles.codeBlock}>
              {block.lang ? <Text {...NON_SELECTABLE_TEXT} style={styles.codeLabel}>{block.lang}</Text> : null}
              <PreformattedScrollBlock text={codeText} textStyle={styles.codeText} />
            </View>
          );
        }
      case 'list':
        return (
          <View key={key} style={styles.bulletGroup}>
            {(block.items ?? []).map((item, j) => (
              <View key={`${key}-i${j}`} style={styles.bulletRow}>
                <Text {...NON_SELECTABLE_TEXT} style={[styles.bulletGlyph, block.ordered && styles.numberGlyph]}>
                  {block.ordered ? `${j + 1}.` : '◦'}
                </Text>
                <View style={styles.bulletBody}>
                  <Text {...SELECTABLE_TEXT} style={styles.assistantText}>{renderMdInline(item, `${key}-i${j}`)}</Text>
                </View>
              </View>
            ))}
          </View>
        );
      case 'blockquote': {
        const quoteText = mdBlockPlainText(block);
        return quoteText ? (
          <View key={key} style={styles.mdQuote}>
            <Text {...SELECTABLE_TEXT} style={[styles.assistantText, styles.mdQuoteText]}>
              {renderMdInline(parseInline(quoteText), key)}
            </Text>
          </View>
        ) : null;
      }
      case 'hr':
        return (
          <View key={key} style={styles.inlineDividerWrap}>
            <View style={styles.inlineDividerLine} />
            <View style={styles.inlineDividerAccent} />
            <View style={styles.inlineDividerLine} />
          </View>
        );
      case 'table': {
        return renderMdTableGrid(block, key);
      }
      default:
        {
          const fallbackText = mdBlockPlainText(block);
          return fallbackText ? (
            <Text key={key} {...SELECTABLE_TEXT} style={styles.assistantText}>
              {fallbackText}
            </Text>
          ) : null;
        }
    }
  });
}

export function FormattedAssistantText({
  text,
}: {
  text: string;
  rowId?: string;
  blockId?: string;
  onCopy?: CopyHandler;
}) {
  const blocks = parseTextBlocks(text);

  return (
    <View style={styles.textBlock}>
      {blocks.map((block, index) => {
        if (block.type === 'list') {
          return (
            <View key={`list-${index}`} style={styles.bulletGroup}>
              {block.items.map((entry, bulletIndex) => {
                return (
                  <View key={`bullet-${bulletIndex}`} style={styles.bulletRow}>
                    <Text {...NON_SELECTABLE_TEXT} style={[styles.bulletGlyph, entry.ordered && styles.numberGlyph]}>
                      {entry.ordered ? entry.marker : '◦'}
                    </Text>
                    <View style={styles.bulletBody}>
                      <Text {...SELECTABLE_TEXT} style={styles.assistantText}>{renderMdInline(parseInline(entry.content), `li-${index}-${bulletIndex}`)}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          );
        }

        if (block.type === 'divider') {
          return (
            <View key={`divider-${index}`} style={styles.inlineDividerWrap}>
              <View style={styles.inlineDividerLine} />
              <View style={styles.inlineDividerAccent} />
              <View style={styles.inlineDividerLine} />
            </View>
          );
        }

        if (block.type === 'code') {
          return (
            <View key={`code-${index}`} style={styles.codeBlock}>
              {block.language ? <Text {...NON_SELECTABLE_TEXT} style={styles.codeLabel}>{block.language}</Text> : null}
              <PreformattedScrollBlock text={block.text} textStyle={styles.codeText} />
            </View>
          );
        }

        if (block.type === 'paragraph' && isPreformattedText(block.text)) {
          if (parsedBlocksContainTable(block.text)) {
            return <React.Fragment key={`pre-table-${index}`}>{renderMdBlocks(block.text, `pre-table-${index}`)}</React.Fragment>;
          }
          return (
            <View key={`pre-${index}`} style={styles.codeBlock}>
              <PreformattedScrollBlock text={block.text} textStyle={styles.codeText} />
            </View>
          );
        }

        // Prose paragraph: render markdown (headings + inline emphasis/code/
        // links) via the shared chat-core parser. Returns one or more block
        // elements (each keyed) instead of a single literal <Text>.
        return <React.Fragment key={`para-${index}`}>{renderMdBlocks(block.text, `para-${index}`)}</React.Fragment>;
      })}
    </View>
  );
}

export function parseAssistantBlocks(text: string): AssistantBlock[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const first = lines[0] || '';
      const rest = lines.slice(1).join('\n').trim();

      const actionMatch = first.match(ACTION_PREFIX);
      if (actionMatch) {
        return {
          type: 'edit',
          title: `${actionMatch[1]} ${actionMatch[2]}`,
          meta: actionMatch[3] || '',
          body: rest,
        };
      }

      if (first.startsWith('Ran ')) {
        return {
          type: 'command',
          command: first.replace(/^Ran\s+/, ''),
          output: summarizeCommandOutput(rest.replace(/^└\s*/gm, '').trim()),
        };
      }

      return { type: 'text', text: chunk };
    });
}

function findCopyTargetId(
  items: readonly PentacleTranscriptItem[],
  copyKind: ChatCopyKind,
  text: string,
): string | null {
  if (copyKind === 'message') {
    const row = items.find((item) => item.text === text && (item.isUser || item.displayRule === 'bubble:assistant' || item.displayRule === 'bubble:agent'));
    return row ? messageCopyTargetId(row.id) : null;
  }

  for (const item of items) {
    if (item.displayRule === 'activity:code-block' && item.text === text) {
      return codeCopyTargetId(item.id, 'activity');
    }
    const blocks = parseAssistantBlocks(item.text);
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (block.type === 'edit' && block.body === text) {
        return codeCopyTargetId(item.id, `edit-${blockIndex}`);
      }
      if (block.type === 'command') {
        const commandText = [block.command, block.output].filter(Boolean).join('\n');
        if (commandText === text) return codeCopyTargetId(item.id, `cmd-${blockIndex}`);
      }
      if (block.type === 'text') {
        const formattedBlocks = parseTextBlocks(block.text);
        for (let formattedIndex = 0; formattedIndex < formattedBlocks.length; formattedIndex += 1) {
          const formatted = formattedBlocks[formattedIndex];
          if (formatted.type === 'code' && formatted.text === text) {
            return codeCopyTargetId(item.id, `text-${blockIndex}-code-${formattedIndex}`);
          }
          if (formatted.type === 'paragraph' && isPreformattedText(formatted.text) && formatted.text === text) {
            return codeCopyTargetId(item.id, `text-${blockIndex}-pre-${formattedIndex}`);
          }
        }
      }
    }
  }
  return null;
}

const BOX_DRAWING_CHAR = /[─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]/;

export function isPreformattedText(text: string): boolean {
  if (BOX_DRAWING_CHAR.test(text)) return true;
  const lines = String(text || '').split('\n');
  let pipeRows = 0;
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      pipeRows += 1;
      if (pipeRows >= 2) return true;
    }
  }
  return false;
}

export function computeActiveThinkingRowId(items: readonly PentacleTranscriptItem[] | null | undefined): string | null {
  if (!items || items.length === 0) return null;
  const last = items[items.length - 1];
  return last && last.kind === 'THINKING' ? last.id : null;
}

export function normalizePipeTable(text: string): string {
  const lines = String(text || '').split('\n');
  const output: string[] = [];
  let index = 0;

  const isPipeRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);

  while (index < lines.length) {
    if (!isPipeRow(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const run: string[] = [];
    while (index < lines.length && isPipeRow(lines[index])) {
      run.push(lines[index]);
      index += 1;
    }
    output.push(...(run.length >= 2 ? normalizePipeTableRun(run) : run));
  }

  return output.join('\n');
}

function normalizePipeTableRun(lines: string[]): string[] {
  const rows = lines.map(parsePipeTableRow);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const widths = Array.from({ length: columnCount }, () => 0);

  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      const cell = row.cells[index] || '';
      widths[index] = Math.max(widths[index], row.isSeparator ? 3 : cell.length);
    }
  }

  return rows.map((row) => {
    const segments = widths.map((width, index) => {
      if (row.isSeparator) return '-'.repeat(width + 2);
      const cell = row.cells[index] || '';
      return ` ${cell.padEnd(width, ' ')} `;
    });
    return `|${segments.join('|')}|`;
  });
}

function parsePipeTableRow(line: string) {
  const trimmed = line.trim();
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  const isSeparator = cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
  return { cells, isSeparator };
}

export function PreformattedScrollBlock({ text, textStyle }: { text: string; textStyle: any }) {
  const normalizedText = normalizePipeTable(String(text || ''));
  const lines = normalizedText.split('\n');
  const contentWidth = Math.max(
    1,
    ...lines.map((line) => Math.ceil(Math.max(line.length, 1) * TABLE_CELL_CHAR_WIDTH) + TABLE_CELL_HORIZONTAL_PADDING),
  );
  return (
    <GestureScrollView
      horizontal
      showsHorizontalScrollIndicator
      nestedScrollEnabled
      directionalLockEnabled={false}
      keyboardShouldPersistTaps="always"
      contentContainerStyle={styles.preformattedContent}
    >
      <View style={[styles.preformattedLines, { width: contentWidth }]}>
        {lines.map((line, index) => (
          <Text
            key={`pre-line-${index}`}
            {...SELECTABLE_TEXT}
            numberOfLines={1}
            style={[textStyle, styles.preformattedLineText]}
          >
            {line.length > 0 ? line : ' '}
          </Text>
        ))}
      </View>
    </GestureScrollView>
  );
}

function isBulletLine(line: string) {
  return /^([-*•]|\d+\.)\s+/.test(line.trim());
}

function parseBulletLine(line: string) {
  const trimmed = line.trim();
  const match = trimmed.match(/^([-*•]|\d+\.)\s+(.*)$/);
  return {
    marker: match?.[1] || '•',
    content: match?.[2] || trimmed,
  };
}

type FormattedTextBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; text: string; language: string }
  | { type: 'list'; items: { marker: string; content: string; ordered: boolean }[] }
  | { type: 'divider' };

export function parseTextBlocks(text: string): FormattedTextBlock[] {
  const lines = text.split('\n');
  const blocks: FormattedTextBlock[] = [];
  let paragraph: string[] = [];
  let listItems: { marker: string; content: string; ordered: boolean }[] = [];
  let codeLines: string[] = [];
  let codeLanguage = '';
  let inCodeBlock = false;

  const flushParagraph = () => {
    const value = paragraph.join('\n').trim();
    if (value) blocks.push({ type: 'paragraph', text: value });
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length) blocks.push({ type: 'list', items: listItems });
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fenceMatch = line.trim().match(/^```([A-Za-z0-9_-]*)\s*$/);

    if (fenceMatch) {
      if (inCodeBlock) {
        blocks.push({ type: 'code', text: codeLines.join('\n').replace(/\s+$/g, ''), language: codeLanguage });
        codeLines = [];
        codeLanguage = '';
        inCodeBlock = false;
        continue;
      }
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeLanguage = fenceMatch[1] || '';
      codeLines = [];
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine.replace(/\s+$/g, ''));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^[_\-─━═]{6,}\s*$/.test(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'divider' });
      continue;
    }

    if (isBulletLine(line.trim())) {
      flushParagraph();
      const parsed = parseBulletLine(line);
      listItems.push({
        marker: parsed.marker,
        content: parsed.content,
        ordered: /\d+\./.test(parsed.marker),
      });
      continue;
    }

    if (listItems.length && /^\s{2,}\S/.test(rawLine)) {
      const last = listItems[listItems.length - 1];
      last.content = `${last.content}\n${line.trim()}`;
      continue;
    }

    if (listItems.length) {
      flushList();
    }
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  if (inCodeBlock) {
    blocks.push({ type: 'code', text: codeLines.join('\n').replace(/\s+$/g, ''), language: codeLanguage });
  }
  return blocks;
}

function summarizeCommandOutput(output: string) {
  if (!output) return '';
  const lines = output.split('\n').map((line) => line.trimEnd());
  if (lines.length <= 3) {
    return lines.join('\n').trim();
  }
  const visible = lines.slice(0, 3).join('\n').trim();
  const hiddenCount = lines.length - 3;
  return `${visible}\n+${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}`;
}

function parseToolInvocation(text: string): ToolInvocation {
  const value = String(text || '').trim();
  if (!value) return { title: 'Tool', body: '' };

  const parenMatch = value.match(/^([A-Za-z][A-Za-z0-9_-]*)\(([\s\S]*)\)$/);
  if (parenMatch) {
    return {
      title: parenMatch[1],
      body: parenMatch[2].trim(),
    };
  }

  const colonMatch = value.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/);
  if (colonMatch) {
    return {
      title: colonMatch[1],
      body: colonMatch[2].trim(),
    };
  }

  const bodyMatch = value.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+([\s\S]+)$/);
  if (bodyMatch) {
    return {
      title: bodyMatch[1],
      body: bodyMatch[2].trim(),
    };
  }

  return { title: 'Tool', body: value };
}

function shouldRenderClaudePaneToolCard(item: PentacleTranscriptItem) {
  if (!TOOL_ACTIVITY_RULES.has(item.displayRule)) return false;
  if (String(item.provider || '').toLowerCase() !== 'claude') return false;
  if (String(item.source || '') === 'claude-jsonl') return false;
  return PANE_CLAUDE_TOOL_INVOCATION.test(item.text.trim());
}

function truncateTranscriptLines(text: string, maxLines: number) {
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) {
    return { text: lines.join('\n').trim(), hiddenLines: 0, tail: '' };
  }
  const hiddenLines = lines.length - maxLines;
  return {
    text: lines.slice(0, maxLines).join('\n').trim(),
    hiddenLines,
    tail: `… +${hiddenLines} line${hiddenLines === 1 ? '' : 's'}`,
  };
}

function splitActivityText(text: string) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines[0] || 'Activity';
  const detail = lines.slice(1).join('\n');
  return {
    title,
    detail: detail.length <= 220 ? detail : `${detail.slice(0, 217).trim()}...`,
  };
}

function useTicker(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  return now;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (typeof AccessibilityInfo.isReduceMotionEnabled === 'function') {
      void AccessibilityInfo.isReduceMotionEnabled()
        .then((enabled) => {
          if (mounted) setReduced(Boolean(enabled));
        })
        .catch(() => undefined);
    }
    const subscription = typeof AccessibilityInfo.addEventListener === 'function'
      ? AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
      : undefined;
    return () => {
      mounted = false;
      subscription?.remove?.();
    };
  }, []);

  return reduced;
}

function formatElapsed(timestamp?: string, now?: number) {
  if (!timestamp) return '00:00';
  const start = new Date(timestamp).getTime();
  if (Number.isNaN(start)) return '00:00';
  const totalSeconds = Math.max(0, Math.floor(((now || Date.now()) - start) / 1000));
  return formatElapsedSeconds(totalSeconds);
}

function formatElapsedSeconds(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  nexusStatusAgents: { gap: 10, marginTop: 6 },
  nexusStatusHeading: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1.4 },
  nexusStatusAgent: { flexDirection: 'row', alignItems: 'center', gap: 10, borderLeftWidth: 2, borderColor: `${Tokens.palette.green}88`, paddingLeft: 10 },
  nexusStatusAgentCopy: { flex: 1, gap: 2 },
  nexusStatusName: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 15 },
  nexusStatusMeta: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 },
  nexusStatusObjective: { color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 13, lineHeight: 18 },
  nexusStatusHistory: { color: Tokens.palette.green, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 },
  nexusStatusUnavailable: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 14 },
  container: {
    flex: 1,
    backgroundColor: P.bg,
    position: 'relative',
  },
  screenContent: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    zIndex: 1,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 12,
  },
  centerText: {
    color: P.muted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    letterSpacing: 1,
    fontFamily: MONO,
  },
  secondaryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: P.border,
    backgroundColor: P.panelAlt,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: P.text,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  combinedHeader: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 11,
    position: 'relative',
    zIndex: 2,
  },
  headerSide: {
    width: 76,
    minWidth: 76,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerStatusTrigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerTitleBlock: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 3,
  },
  headerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    maxWidth: '100%',
  },
  headerEyebrow: {
    maxWidth: '100%',
    fontSize: 10,
    lineHeight: 13,
    fontFamily: MONO,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  headerTitle: {
    maxWidth: '100%',
    color: P.text,
    fontSize: 18,
    lineHeight: 20,
    fontFamily: RAJ_BOLD,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 10,
    zIndex: 20,
  },
  sessionHeaderTitle: {
    flex: 1,
    color: P.text,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '800',
    textAlign: 'center',
  },
  headerIconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  headerBackButton: {
    width: 24,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  headerBackGlyph: {
    color: P.text,
    fontFamily: RAJ,
    fontSize: 30,
    lineHeight: 36,
  },
  headerMoreButton: {
    width: 30,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    position: 'relative',
  },
  headerReportBadge: {
    position: 'absolute',
    right: -5,
    top: 1,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Tokens.palette.green,
  },
  headerReportBadgeText: {
    color: Tokens.palette.ink,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 9,
  },
  headerMoreGlyph: {
    color: P.muted,
    fontFamily: RAJ,
    fontSize: 22,
    lineHeight: 24,
  },
  statusOverlayCloseButton: {
    width: 34,
    height: 34,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusOverlayCloseGlyph: {
    color: Tokens.palette.dim,
    fontFamily: RAJ_BOLD,
    fontSize: 15,
    lineHeight: 18,
  },
  backTouchOverlay: {
    position: 'absolute',
    left: 8,
    width: 72,
    height: 72,
    zIndex: 1000,
    backgroundColor: 'rgba(255,255,255,0.01)',
  },
  backTouchOverlayPixel: {
    width: 1,
    height: 1,
    opacity: 0.01,
  },
  transcript: {
    flex: 1,
    minHeight: 0,
    flexShrink: 1,
  },
  transcriptLoading: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  loadingLabel: {
    color: P.muted,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 1,
  },
  transcriptContent: {
    paddingHorizontal: SCREEN_PAD,
    paddingTop: 14,
    paddingBottom: 4,
    gap: 16,
  },
  sessionHero: {
    flexShrink: 0,
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 2,
    paddingHorizontal: 34,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 6,
  },
  sessionHeroBand: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 4,
  },
  sessionBody: {
    flex: 1,
    minHeight: 0,
    flexShrink: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  sessionEyebrow: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    fontFamily: MONO,
    textAlign: 'center',
  },
  sessionTitle: {
    color: P.text,
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '800',
    textAlign: 'center',
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  sessionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2f5a46',
    backgroundColor: '#0d1812',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sessionChipWorking: {
    backgroundColor: P.accentGlow,
  },
  sessionChipDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: P.accent,
  },
  sessionChipText: {
    color: P.text,
    fontSize: 11,
    lineHeight: 14,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    fontWeight: '700',
  },
  sessionSummary: {
    color: P.soft,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  emptyWrap: {
    paddingTop: 16,
  },
  emptyText: {
    color: P.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  loadEarlierButton: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  loadEarlierText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
  },
  timeline: {
    gap: 7,
  },
  machineGroup: {
    alignSelf: 'stretch',
  },
  harnessExpandedRow: {
    paddingBottom: 180,
  },
  machineTimestamp: {
    alignSelf: 'center',
    color: P.muted,
    fontSize: 9,
    lineHeight: 12,
    fontFamily: MONO,
    letterSpacing: 1,
    paddingTop: 7,
    paddingBottom: 1,
  },
  assistantRow: {
    alignSelf: 'stretch',
  },
  agentRow: {
    alignSelf: 'stretch',
    alignItems: 'flex-start',
    paddingVertical: 1,
  },
  agentCard: {
    maxWidth: '88%',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: P.panelAlt,
  },
  agentLabel: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: MONO,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  agentText: {
    color: P.soft,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: RAJ,
  },
  plumbingPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  plumbingSender: {
    maxWidth: '34%',
  },
  plumbingPreviewText: {
    flex: 1,
    minWidth: 0,
  },
  agentHiddenLines: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  activityRow: {
    alignSelf: 'stretch',
    paddingVertical: 1,
  },
  activityPill: {
    maxWidth: '94%',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: P.commandBorder,
    backgroundColor: '#091511',
  },
  activityBody: {
    flex: 1,
    gap: 2,
  },
  activityThinkingGlyph: {
    color: P.accent,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
    paddingRight: 6,
  },
  activityTitle: {
    color: P.accent,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
    fontWeight: '800',
  },
  activityText: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  toolUseRow: {
    maxWidth: '94%',
    alignSelf: 'flex-start',
    paddingVertical: 1,
  },
  toolInvocationCard: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: P.commandBg,
    borderWidth: 1,
    borderColor: P.commandBorder,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 4,
  },
  toolInvocationTitle: {
    color: P.accent,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: MONO,
    fontWeight: '800',
  },
  toolInvocationBody: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  toolResultRow: {
    maxWidth: '94%',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    paddingLeft: 14,
    paddingVertical: 1,
  },
  toolBatchRow: {
    maxWidth: '94%',
    alignSelf: 'flex-start',
    paddingLeft: 18,
    paddingVertical: 4,
  },
  toolBatchText: {
    color: P.accent,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  toolResultGlyph: {
    color: P.soft,
    fontSize: 13,
    lineHeight: 17,
    fontFamily: MONO,
  },
  toolResultBody: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  toolResultText: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: MONO,
  },
  toolResultTail: {
    color: P.soft,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  terminalDividerRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
  },
  terminalDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: P.borderStrong,
  },
  terminalDividerText: {
    color: P.soft,
    fontSize: 10,
    lineHeight: 13,
    fontFamily: MONO,
  },
  compactedRow: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: 5,
  },
  compactedCard: {
    maxWidth: '92%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#6e5730',
    backgroundColor: P.warningBg,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  compactedText: {
    color: P.warning,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
    fontWeight: '700',
  },
  assistantCard: {
    gap: 6,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  textBlock: {
    gap: 6,
  },
  assistantText: {
    color: P.soft,
    fontSize: 14.5,
    lineHeight: 22,
    fontFamily: RAJ,
  },
  // Markdown inline + heading styles (chat UI hardening batch 1).
  mdStrong: {
    fontFamily: RAJ_BOLD,
    color: P.text,
  },
  mdEm: {
    fontStyle: 'italic',
  },
  mdCode: {
    fontFamily: MONO,
    fontSize: 12,
    color: Tokens.palette.green,
    backgroundColor: `${Tokens.palette.green}1c`,
  },
  mdLink: {
    color: Tokens.palette.green,
    textDecorationLine: 'underline',
  },
  mdHeading: {
    fontFamily: RAJ_BOLD,
    color: P.text,
    marginTop: 6,
    marginBottom: 1,
  },
  mdH1: {
    fontSize: 17,
    lineHeight: 23,
  },
  mdH2: {
    fontSize: 15,
    lineHeight: 21,
  },
  mdH3: {
    fontSize: 14,
    lineHeight: 20,
  },
  codeBlock: {
    borderWidth: 1,
    borderColor: P.commandBorder,
    borderRadius: 4,
    backgroundColor: P.commandBg,
    paddingHorizontal: 13,
    paddingVertical: 12,
    gap: 6,
  },
  copyToast: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: P.accent,
    zIndex: 10,
  },
  copyToastText: {
    color: P.bg,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: MONO,
    fontWeight: '900',
  },
  preformattedContent: {
    paddingRight: 16,
    alignItems: 'flex-start',
  },
  preformattedLines: {
    alignItems: 'flex-start',
  },
  preformattedLineText: {
    flexShrink: 0,
  },
  codeLabel: {
    color: Tokens.palette.green,
    fontSize: 10,
    lineHeight: 12,
    fontFamily: Fonts.jetBrainsMono.bold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  codeText: {
    color: P.soft,
    fontSize: 12,
    lineHeight: 19,
    fontFamily: MONO,
  },
  tableBlock: {
    borderWidth: 1,
    borderColor: P.commandBorder,
    borderRadius: 4,
    backgroundColor: P.commandBg,
    overflow: 'hidden',
  },
  tableScrollContent: {
    paddingRight: 16,
  },
  tableGrid: {
    alignSelf: 'flex-start',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: `${P.commandBorder}99`,
  },
  tableHeaderRow: {
    backgroundColor: `${Tokens.palette.green}10`,
  },
  tableCell: {
    borderRightWidth: 1,
    borderRightColor: `${P.commandBorder}99`,
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  tableCellLast: {
    borderRightWidth: 0,
  },
  tableHeaderCell: {
    paddingVertical: 9,
  },
  tableCellText: {
    lineHeight: 18,
  },
  tableHeaderText: {
    fontFamily: RAJ_BOLD,
    color: P.text,
  },
  bulletGroup: {
    gap: 4,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
  },
  bulletBody: {
    flex: 1,
  },
  inlineDividerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  inlineDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: P.borderStrong,
  },
  inlineDividerAccent: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: P.accentDim,
    opacity: 0.85,
  },
  bulletGlyph: {
    color: Tokens.palette.green,
    fontSize: 14,
    lineHeight: 19,
    fontFamily: MONO,
    width: 14,
  },
  mdQuote: {
    borderLeftWidth: 2,
    borderLeftColor: Tokens.palette.green,
    paddingLeft: 11,
    marginVertical: 4,
  },
  mdQuoteText: {
    color: P.muted,
    fontStyle: 'italic',
  },
  numberGlyph: {
    color: P.accent,
  },
  fileCard: {
    backgroundColor: P.fileBg,
    borderWidth: 1,
    borderColor: P.fileBorder,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 8,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fileHeaderText: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  fileTitle: {
    color: P.accent,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: MONO,
  },
  fileMeta: {
    color: P.accentDim,
    fontSize: 10,
    lineHeight: 14,
    fontFamily: MONO,
  },
  commandCard: {
    backgroundColor: P.commandBg,
    borderWidth: 1,
    borderColor: P.commandBorder,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 4,
  },
  commandTitle: {
    color: P.accent,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  commandOutput: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  userRow: {
    alignItems: 'flex-end',
  },
  userAttachments: {
    alignItems: 'flex-end',
  },
  userBubble: {
    maxWidth: '84%',
  },
  userBubbleContent: {
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  userBubbleFailed: {
    opacity: 0.72,
  },
  userSendStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
    paddingHorizontal: 2,
  },
  userSendStatusText: {
    color: P.warning,
    fontSize: 10,
    lineHeight: 14,
    fontFamily: MONO,
  },
  // C (working indicator): chrome-less row above the composer.
  workingIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 4,
  },
  workingIndicatorSpinner: {
    width: 13,
    height: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workingIndicatorTimer: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: MONO,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  workingIndicatorRetryText: {
    flex: 1,
    minWidth: 0,
    color: P.warning,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: MONO,
  },
  workingIndicatorCancel: {
    marginLeft: 'auto',
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workingIndicatorCancelGlyph: {
    width: 9,
    height: 9,
    borderRadius: 1,
  },
  // B1 (send-while-working queue): queued/sent captions are neutral (not the
  // amber "Canceled" warning) — queued is in-flight, sent is success.
  queuedSentText: {
    color: P.muted,
    fontSize: 10,
    lineHeight: 14,
    fontFamily: MONO,
  },
  queuedChevron: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: MONO,
  },
  userText: {
    color: P.text,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: MONO,
  },
  answerBlock: {
    gap: 8,
  },
  answerItemSpacing: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: P.userBorder,
    paddingTop: 8,
  },
  answerHeader: {
    color: P.muted,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: MONO,
    marginBottom: 2,
  },
  answerValue: {
    color: P.text,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: MONO,
  },
  answerBulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  answerBullet: {
    color: P.accent,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: MONO,
  },
  answerNote: {
    color: P.muted,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: MONO,
    marginTop: 4,
  },
  composerWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    backgroundColor: 'transparent',
    paddingHorizontal: SCREEN_PAD,
    paddingTop: 10,
    gap: 10,
  },
  newMessagesPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: P.borderStrong,
    backgroundColor: P.panelAlt,
    zIndex: 5,
  },
  newMessagesPillText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '600',
  },
  questionStack: {
    marginBottom: 4,
  },
  questionOverlayHost: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 190,
  },
  questionStackContent: {
    gap: 14,
    paddingTop: 0,
    paddingBottom: 4,
  },
  questionSingleContent: {
    gap: 0,
  },
  questionCard: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 11,
  },
  questionCardLocked: {
    opacity: 0.55,
  },
  questionHeader: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: MONO,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  questionPrompt: {
    color: P.text,
    fontSize: 16,
    lineHeight: 21,
    fontFamily: RAJ_SEMI,
  },
  questionOptions: {
    gap: 7,
  },
  questionOption: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  questionOptionSelected: {
    backgroundColor: `${Tokens.palette.green}1e`,
  },
  questionOptionDisabled: {
    opacity: 0.6,
  },
  questionOptionPressed: {
    opacity: 0.6,
  },
  questionOptionLabel: {
    fontSize: 15,
    lineHeight: 19,
    fontFamily: RAJ_SEMI,
  },
  questionOptionDescription: {
    color: P.muted,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: RAJ,
  },
  questionPreviewScroll: {
    borderWidth: 1,
    borderColor: P.commandBorder,
    borderRadius: 4,
    backgroundColor: P.commandBg,
  },
  questionPreviewContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  questionPreviewText: {
    color: P.text,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  questionFreeText: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: P.text,
    fontSize: 13,
    lineHeight: 17,
    fontFamily: MONO,
  },
  questionNote: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: P.text,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: MONO,
  },
  questionFreeTextDisabled: {
    opacity: 0.6,
  },
  questionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  questionPager: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
  },
  questionPagerButton: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'transparent',
  },
  questionPagerLabel: {
    color: P.muted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: MONO,
  },
  questionSubmit: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  questionCancel: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'transparent',
  },
  questionSubmitText: {
    color: P.bg,
    fontSize: 15,
    lineHeight: 18,
    fontFamily: RAJ_BOLD,
  },
  questionWarning: {
    flex: 1,
    color: P.warning,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: MONO,
  },
  questionStateProbe: {
    width: 1,
    height: 1,
    opacity: 0,
  },
  activityDock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 999,
  },
  activityDockGlyph: {
    color: P.accent,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: MONO,
  },
  activityDockBody: {
    flexShrink: 1,
    alignItems: 'center',
    gap: 3,
  },
  activityDockTitle: {
    flexShrink: 1,
    color: P.muted,
    fontSize: 11,
    lineHeight: 14,
    fontFamily: MONO,
    textAlign: 'center',
  },
  activityDockTasks: {
    alignItems: 'flex-start',
    gap: 1,
  },
  activityDockTaskText: {
    color: P.muted,
    fontSize: 10,
    lineHeight: 13,
    fontFamily: MONO,
  },
  composerShell: {
    alignSelf: 'stretch',
  },
  composerCapsule: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: '#0c1410',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 22,
    elevation: 6,
  },
  composerCapsuleHairline: {
    borderWidth: 1,
    borderRadius: 12,
  },
  attachmentStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  attachmentThumbWrap: {
    position: 'relative',
  },
  attachmentThumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: '#1a1f2b',
  },
  attachmentRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // S0 redesign: the bar is a relative box so the "+" (top-right) and send
  // (bottom-right) anchor to corners; right/bottom padding reserves their lanes
  // so typed text never runs under them.
  composerBar: {
    position: 'relative',
    minHeight: 62,
    paddingLeft: 14,
    paddingRight: 44,
    paddingTop: 9,
    paddingBottom: 36,
  },
  composerBarExpanded: {
    minHeight: 108,
  },
  composerInput: {
    minHeight: 28,
    maxHeight: 120,
    paddingHorizontal: 0,
    paddingVertical: 0,
    color: P.text,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: MONO,
    letterSpacing: 1,
  },
  composerTapAway: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  plusButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  cameraButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  photoButton: {
    position: 'absolute',
    top: 40,
    right: 6,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  sendButton: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
});
