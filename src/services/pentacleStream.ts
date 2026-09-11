import { useCallback, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import { getDefaultPentacleWsUrl } from '../config/pentacle';
import { decodeThreadRead, logTelemetry, getHostTheme } from 'pentacle-chat-core';
import { buildDaemonQuestionAnswer } from './daemonQuestionAnswer';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import * as harnessRuntime from '../utils/harnessRuntime';
import { MOBILE_TELEMETRY_EVENTS } from './mobileTelemetryEvents';
import { INITIAL_CHAT_FETCH_LIMIT } from './chatLoadTuning';
import {
  finalizeStreamEventsResponse,
  hasReusableStreamEventsCoverage,
  streamEventsWindowForPurpose,
  type StreamEventsFinalizerResult,
  type StreamEventsPendingToken,
} from './streamEventsCoverage';
import { validateSpawnCatalog, type SpawnCatalog, type SpawnProvider } from './spawnCatalog';
import {
  createOperatorAuthV2Hello,
  OPERATOR_AUTH_V2_PREFIX,
  OPERATOR_AUTH_V2_WELCOME_TIMEOUT_MS,
  parseOperatorAuthV2Envelope,
  type OperatorAuthV2Credential,
} from './operatorAuthV2';
export type { SpawnCatalog, SpawnProvider } from './spawnCatalog';
import {
  markDaemonRestartSurvivorsIndeterminate,
  markDaemonRestartNotificationResolvesIndeterminate,
  rearmOfflineQueuedSends,
  rearmNotificationResolveSurvivors,
  expireNotificationResolveSurvivors,
  eligibleNotificationResolveReplayIds,
  rekeyOptimisticSend,
  rotateOptimisticSendRequestId,
  type NotificationResolveSurvivor,
} from './reconnectReplay';
import {
  applyPentacleEvent,
  applyFetchedStreamEvents,
  selectCurrentTailEvents,
  applyPentacleLimits,
  applyPentacleHostsStats,
  applyPentacleUpdates,
  applyNotificationFrame,
  applyNotificationList,
  applyPentacleHostStatus,
  applyPentacleSessionSummary,
  applyPentacleSessionInventory,
  applySnapshotWithOptimisticReconciliation,
  applyPentacleWorkingState,
  clearPentacleStreamDraft,
  clearPentacleTurn,
  initialPentacleStreamState,
  optimisticMatchesServerUser,
  serverEventTime,
  OPTIMISTIC_INVENTORY_GRACE_MS,
  OPTIMISTIC_RECONCILE_WINDOW_MS,
  markOptimisticAckedByRequestId,
  markOptimisticDispatchedByRequestId,
  markOptimisticFailedByOptimisticId,
  markOptimisticFailedByRequestId,
  retryOptimisticSend as reduceRetryOptimisticSend,
  markOptimisticIndeterminateByRequestId,
  markOptimisticReturnedToPromptByOptimisticId,
  onReconnect,
  reconcileOptimisticSendWithServerEvent,
  isSystemEndOfTurnEvent,
  isReturnedToPromptUserEvent,
  pruneOptimisticSend,
  selectSessionDetail,
  getSessionSendingState,
  sendOptimisticMessage as reduceSendOptimisticMessage,
  enqueueOptimisticMessage as reduceEnqueueOptimisticMessage,
  activateQueuedSends as reduceActivateQueuedSends,
  IDLE_TURN,
  mutatePentacleEventBuckets,
  peekEventsForStream,
  retainedPentacleEventCost,
  selectPentacleDerivedEventIndex,
  selectSafeSessionSummaryPreview,
} from 'pentacle-chat-core';
import type {
  PentacleEvent,
  PentacleHostStatus,
  PentacleLimit,
  PentacleNotification,
  PentacleSpecStatusCapability,
  PentacleSessionDetail,
  PentacleSessionSummary,
  PentacleStreamState,
  PentacleUpdateMessage,
  TurnState,
  WorkingStateData,
  ChatAttachment,
  ThreadReadResponse,
  EventBucketCoverage,
  EventBucketRequestStatus,
  EventBucketRequestPurpose,
  EventBucketRequestWindow,
  PentacleEventBucket,
  PentacleSafeSummaryPreview,
} from 'pentacle-chat-core';

export type DismissQuestionResult = {
  dismissed: boolean;
  textSubmitted: boolean;
};

export type SpawnSessionV2Result = {
  session: PentacleSessionSummary;
  requested?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  actual_launch?: Record<string, unknown>;
  resolution_source?: string;
  catalog_version?: string;
};

export class SpawnSessionError extends Error {
  errorCode: string;
  remediation?: string;
  supportedChoices?: unknown;

  constructor(errorCode: string, message: string, remediation?: string, supportedChoices?: unknown) {
    super(message);
    this.name = 'SpawnSessionError';
    this.errorCode = errorCode;
    this.remediation = remediation;
    this.supportedChoices = supportedChoices;
  }
}

export type InterruptConfirm = 'interrupted' | 'interrupt_unconfirmed' | 'not_working' | 'pane_unavailable' | 'coalesced';

export type InterruptSendResult = {
  interrupted: boolean;
  landed: boolean;
  confirm: InterruptConfirm;
  coalesced: boolean;
};

export class DismissQuestionError extends Error {
  errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'DismissQuestionError';
    this.errorCode = errorCode;
  }
}

export type PendingSessionCloseState = 'queued' | 'retrying' | 'accepted' | 'deferred' | 'cancelling' | 'exhausted' | 'failed';

export type PendingSessionClose = {
  streamId: string;
  host: string;
  sessionName: string;
  sessionGeneration?: string;
  intentId?: string;
  requestId: string;
  requestedAt: number;
  attempt: number;
  nextAttemptAt: number;
  state: PendingSessionCloseState;
  forceRequested?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type CloseSessionResult = {
  closed: boolean;
  deferred: boolean;
  queued: boolean;
  intentId?: string;
  sessionGeneration?: string;
};

export class CloseSessionError extends Error {
  errorCode: string;
  workState?: unknown;

  constructor(errorCode: string, message: string, workState?: unknown) {
    super(message);
    this.name = 'CloseSessionError';
    this.errorCode = errorCode;
    this.workState = workState;
  }
}

export type SendResponseClass = 'send.result' | 'send.error';

type RetryTelemetryContext = {
  streamId: string;
  priorOptimisticId: string;
  priorRequestId: string;
  currentOptimisticId: string;
  currentRequestId: string;
};

export class ExplicitSendRejectionError extends Error {
  readonly responseClass: SendResponseClass;
  readonly errorCode: string;

  constructor(responseClass: SendResponseClass, errorCode: string, message: string) {
    super(message);
    this.name = 'ExplicitSendRejectionError';
    this.responseClass = responseClass;
    this.errorCode = errorCode;
  }
}

function closeSessionErrorFromMessage(message: Record<string, unknown>) {
  const detail = message.error && typeof message.error === 'object'
    ? message.error as Record<string, unknown>
    : undefined;
  const scalarError = typeof message.error === 'string' ? message.error : undefined;
  return new CloseSessionError(
    String(detail?.code || message.error_code || scalarError || 'close_failed'),
    String(detail?.message || scalarError || message.error_code || 'Close failed'),
    message.work_state,
  );
}

// The v2 daemon emits `close.failed` (e.g. `{reason: 'ssh_unreachable'}`) when it cannot
// reach the host. Carry the reason as the error code so classification can recognise a
// non-transient offline failure instead of letting the promise time out.
function closeFailedErrorFromMessage(message: Record<string, unknown>) {
  const reason = typeof message.reason === 'string' ? message.reason : undefined;
  const scalarError = typeof message.error === 'string' ? message.error : undefined;
  return new CloseSessionError(
    reason || String(message.error_code || 'close_failed'),
    String(scalarError || message.detail || reason || 'Close failed'),
    message.work_state,
  );
}

const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10000, 30000];
const PRE_OPEN_CONNECT_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;
const PENDING_CLOSE_STORAGE_KEY = 'pentacle-mobile:pending-session-closes:v1';
const PENDING_CLOSE_TTL_MS = 10 * 60_000;
const PENDING_CLOSE_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
// How long a pending-close row survives absence from broadcast inventories before absence is
// accepted as closure. A closed session is simply dropped from the daemon's session_summaries —
// there is no tombstone frame — but so is a live one whose host misses a single LivePaneWatcher
// tick (chat_streamd._evict_inactive_summaries), so bare absence is not proof of closure. Held at
// parity with the reducer's OPTIMISTIC_INVENTORY_GRACE_MS, which exists for the same class of
// transient omission on the send side; named separately because this clock measures how long the
// stream has been missing, not how old the record is.
const PENDING_CLOSE_ABSENCE_GRACE_MS = OPTIMISTIC_INVENTORY_GRACE_MS;
const PING_INTERVAL_MS = 15_000;
const WATCHDOG_NO_FRAME_MS = PING_INTERVAL_MS * 2;
const FOCUSED_HEARTBEAT_INTERVAL_MS = 1_500;
const FOCUSED_PROBE_TIMEOUT_MS = 1_000;
// Opening a busy chat can issue a 300-event history refetch whose first frame
// takes longer than the normal dead-socket window. Only that request kind gets
// the lenient window; a pending send must still surface as ambiguous promptly.
const FOCUSED_HISTORY_PROBE_TIMEOUT_MS = 6_000;
const FOCUSED_INTERACTION_PROBE_DEBOUNCE_MS = 500;
const FOREGROUND_PROBE_TIMEOUT_MS = 2_000;
const FOREGROUND_RESYNC_DEBOUNCE_MS = 250;
const DISCONNECT_BANNER_GRACE_MS = 1_500;
const FOCUSED_STREAM_REFETCH_LIMIT = 300;
// This is the actual first-paint window: intent prefetch populates the
// transcript before navigation, so keep it aligned with the measured mount
// window instead of timing a smaller, unchanged payload.
const INTENT_PREFETCH_FETCH_LIMIT = INITIAL_CHAT_FETCH_LIMIT;
const INTENT_PREFETCH_MAX_QUEUE = 8;
const INTENT_PREFETCH_CONCURRENCY = 2;
const STREAM_EVENTS_CHUNK_LIMIT = 8;
const FOCUSED_LIVE_EVENT_BATCH_LIMIT = 32;
const BACKGROUND_LIVE_EVENT_BATCH_LIMIT = 1200;
const POST_OPTIMISTIC_LIVE_EVENT_BATCH_LIMIT = 8;
const FOCUSED_LIVE_EVENT_BATCH_DELAY_MS = 120;
const BACKGROUND_LIVE_EVENT_BATCH_DELAY_MS = 240;

export type StreamOpenEntrySource = 'list-settle' | 'press-in' | 'notification' | 'search' | 'cold-jump';

type StreamEventsRequestPurpose = EventBucketRequestPurpose;

type StreamEventsRequestOptions = {
  purpose?: StreamEventsRequestPurpose;
  entrySource?: StreamOpenEntrySource;
};

type StreamEventsInFlight = {
  promise: Promise<PentacleEvent[]>;
  limit?: number;
  purpose: StreamEventsRequestPurpose;
  entrySource?: StreamOpenEntrySource;
};

type PrefetchQueueEntry = {
  streamId: string;
  entrySource: StreamOpenEntrySource;
  enqueuedAt: number;
};

let eventFlowDiagnostics: typeof import('pentacle-chat-core') | null = null;
let summaryFlowDiagnostics: typeof import('./pentacleSummaryFlowDiagnostics') | null = null;
if (process.env.EXPO_PUBLIC_HARNESS === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  eventFlowDiagnostics = require('pentacle-chat-core');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  summaryFlowDiagnostics = require('./pentacleSummaryFlowDiagnostics');
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  generation: number;
  socket: WebSocket;
  requestPrefix: string;
  timeoutMs: number;
  optimisticId?: string;
  retryOnOptimisticIdConflict?: boolean;
  retryTelemetry?: RetryTelemetryContext;
  streamEvents?: PentacleEvent[];
  streamEventsStreamId?: string;
  streamEventsPurpose?: StreamEventsRequestPurpose;
  streamEventsLimit?: number;
  streamEventsEntrySource?: StreamOpenEntrySource;
  streamEventsHadResumeCursor?: boolean;
  streamEventsWindow?: EventBucketRequestWindow;
  streamEventsBefore?: number | null;
};

type CurrentTailReducerOptions = {
  requestedStreamId: string;
  mode: 'current-tail';
  ingressSource: string;
};

type CurrentTailApplyOutcome = {
  acceptedEvents?: PentacleEvent[];
  rejectedStreamIds?: readonly string[];
};

let ws: WebSocket | null = null;
let currentSocketGeneration = 0;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let preOpenConnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let activeHeartbeatIntervalMs: number | null = null;
let foregroundProbeTimer: ReturnType<typeof setTimeout> | null = null;
let foregroundResyncTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectBannerTimer: ReturnType<typeof setTimeout> | null = null;
let subscribers = 0;
let authToken: string | null = null;
let wsUrl: string | null = null;
let deferredConnectTimer: ReturnType<typeof setTimeout> | null = null;
let harnessTokenReadyConnectPending = false;
let resumePendingAfterClose = false;
let harnessForcedReconnectIssued = false;
let harnessForcedHistoryFetchFailureIssued = false;
let pendingReconnectSurvivorGeneration: number | null = null;
let receiptQueryInFlight: { toStreamId: string; requestId: string } | null = null;
const queuedReceiptQueries: Array<{ toStreamId: string; requestId: string }> = [];
let lastFrameReceivedAt = monotonicNowMs();
let awaitingPongSince: number | null = null;
let pendingForegroundProbe = false;
let focusedStreamId: string | null = null;
let lastAppState: AppStateStatus = AppState.currentState ?? 'active';
let lastFocusedInteractionProbeAt = 0;
let livenessCloseGeneration: number | null = null;
let livenessCloseErrorMessage = 'Pentacle stream disconnected';
let pendingDisconnectBannerGeneration: number | null = null;
let harnessSilentHalfOpenActive = false;
let harnessSilentHalfOpenGeneration: number | null = null;
let harnessSilentHalfOpenDropCount = 0;

// Screenshot-harness offline flag. Strictly gated on
// EXPO_PUBLIC_SCREENSHOT_HARNESS so production bundles dead-code every read
// (the constant folds to `undefined === '1'` → false). When true the stream
// never opens a real WebSocket and reconnect is a no-op, so seeded fixture
// state is never wiped by the token-load reconnect path. See
// src/harness/screenshotHarness.ts for the bootstrap that flips it.
let harnessOffline = false;

const listeners = new Set<() => void>();

// optimistic_send_stuck_after_daemon_restart_2026_09: a photo row whose upload
// leg has not landed keeps a re-upload closure (over the already-compressed
// staged asset) for the process lifetime of the optimistic unit, so Retry
// re-drives upload+send without re-picking. Entries die with the row — pruned
// once the optimistic_id leaves optimisticSends (landed, cancelled, rekeyed) —
// and never persist across app restarts.
const uploadRetryByOptimisticId = new Map<string, () => Promise<ChatAttachment[]>>();

function pruneUploadRetries(next: PentacleStreamState) {
  if (!uploadRetryByOptimisticId.size) return;
  for (const optimisticId of uploadRetryByOptimisticId.keys()) {
    const row = next.optimisticSends?.[optimisticId];
    if (!row || row.status === 'cancelled') uploadRetryByOptimisticId.delete(optimisticId);
  }
}

export function hasRetainedUploadForRetry(optimisticId: string): boolean {
  return uploadRetryByOptimisticId.has(optimisticId);
}
const assetFrameListeners = new Set<(message: Record<string, unknown>) => void>();
const pendingRequests = new Map<string, PendingRequest>();
// A queued row is eligible for automatic reconnect dispatch only after the
// caller has actually attempted its wire dispatch. This prevents reconnect
// from forwarding local attachment placeholders while an upload is pending.
const queuedOptimisticDispatchRequests = new Set<string>();
// notification_answer_replay_asymmetry §A — pending notification-answer resolves,
// keyed by notification_id, that must survive a transport cut and auto-replay once
// per reconnect generation exactly like a message send. The reducer's optimisticSends
// only tracks chat sends, so resolves get their own mobile-owned registry with the
// same survivor semantics (see reconnectReplay.ts). Each entry carries the built
// wire payload and a stable request_id reused across replays (§A "same request_id").
type PendingNotificationResolve = NotificationResolveSurvivor & {
  args: ResolveNotificationArgs;
  payload: Record<string, unknown>;
  request_id: string;
};
let pendingNotificationResolves: Record<string, PendingNotificationResolve> = {};
const pendingFetchBlobChunks = new Map<string, string[]>();
const pendingSessionCloses = new Map<string, PendingSessionClose>();
const pendingCloseInFlight = new Map<string, Promise<CloseSessionResult>>();
// streamId -> when it first went missing from an inventory on the CURRENT socket generation.
// Deliberately in-memory: a cold start has no trustworthy absence history, and hydration
// reconciles against a fresh inventory anyway.
const pendingCloseAbsentSince = new Map<string, number>();
let pendingCloseHydrated = false;
let pendingCloseHydrationPromise: Promise<void> | null = null;
let pendingClosePersistence: Promise<void> = Promise.resolve();
let pendingCloseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCloseInventoryGeneration: number | null = null;
const lastEventSeqByStream = new Map<string, number>();
const lastLiveBatchSeqByStream = new Map<string, number>();
const lastLiveBatchKindByStream = new Map<string, string>();
let lastLiveBatchGlobalSeq: number | undefined;
let lastLiveBatchGlobalKind: string | undefined;
const harnessPendingLiveSeqCounts = new Map<number, number>();
let harnessPendingLiveCount = 0;
let harnessMaxAppliedLiveSeq = 0;
let harnessMaxReceivedLiveSeq = 0;
type HarnessAllChatsCohort = {
  bindingKey: string;
  streamPrefix: string;
  streamIndexWidth: number;
  generation: number;
  sessionCount: number;
  setupEventCount: number;
  eventCount: number;
  burstSize: number;
};
type HarnessAppliedBurstIdentity = [streamId: string, daemonSeq: number];
const NO_HARNESS_APPLIED_BURST_IDENTITIES: HarnessAppliedBurstIdentity[] = [];
let harnessAllChatsCohort: HarnessAllChatsCohort | null = null;
let harnessAllChatsAppliedIdentities: Set<string> | null = null;
let harnessAllChatsAdmissionBindingByEvent: Map<PentacleEvent, string> | null = null;
let harnessAllChatsVerifiedThrough = 0;
const promptedPendingOptimisticSignatureByStream = new Map<string, string>();
const postOptimisticDrainByStream = new Set<string>();
const optimisticCountersByStream = new Map<string, number>();
const optimisticQuestionAnswers = new Map<string, { notificationId?: string; questionId?: string }>();
const streamSliceCache = new Map<string, PentacleStreamSlice>();
const streamEventsInFlight = new Map<string, StreamEventsInFlight>();
const streamEventsResumeBeforeByStream = new Map<string, number>();
const streamEventsOlderExhaustedByStream = new Set<string>();
const PREFETCH_COVERAGE_FRESH_MS = 5 * 60 * 1000;
const intentPrefetchQueue = new Map<string, PrefetchQueueEntry>();
const deferredIntentPrefetches = new Map<string, {
  entrySource: StreamOpenEntrySource;
  promise: Promise<PentacleEvent[]>;
}>();
const streamOpenEntrySources = new Map<string, StreamOpenEntrySource>();
let activeIntentPrefetches = 0;
let deferredStreamEventsTimer: ReturnType<typeof setTimeout> | null = null;
const deferredStreamEventBatches: Array<{
  events: PentacleEvent[];
  source: string;
  currentTailOptions?: CurrentTailReducerOptions;
}> = [];
let liveStreamEventsTimer: ReturnType<typeof setTimeout> | null = null;
let liveStreamEventBatch: PentacleEvent[] = [];
let liveImmediateApplyReason = '';
const harnessPersistedEventSeqKeys = new Set<string>();
const deferredBackgroundLiveEventsByStream = new Map<string, PentacleEvent[]>();

let state: PentacleStreamState = initialPentacleStreamState;

function monotonicNowMs() {
  return globalThis.performance?.now?.() ?? 0;
}

function emitIntentPrefetchTelemetry(
  name: (typeof MOBILE_TELEMETRY_EVENTS)[keyof typeof MOBILE_TELEMETRY_EVENTS],
  data: Record<string, unknown>,
) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime.isArmed()) return;
  logTelemetry(name as Parameters<typeof logTelemetry>[0], data);
}

function normalizeEntrySource(source?: StreamOpenEntrySource): StreamOpenEntrySource {
  return source || 'cold-jump';
}

function rememberStreamOpenEntrySource(streamId: string, source?: StreamOpenEntrySource) {
  const trimmed = String(streamId || '').trim();
  if (!trimmed) return;
  streamOpenEntrySources.set(trimmed, normalizeEntrySource(source));
}

function hasReusablePrefetchCoverage(streamId: string, requiredLimit = INTENT_PREFETCH_FETCH_LIMIT) {
  return hasReusableStreamEventsCoverage(state.eventBucketsByStream?.[streamId], {
    purpose: 'prefetch',
    generation: currentSocketGeneration,
    limit: requiredLimit,
    before: null,
    now: Date.now(),
  });
}

export type StreamEventsLoadState = {
  currentGenerationComplete: boolean;
  fresh: boolean;
  requestStatus: EventBucketRequestStatus;
};

const EMPTY_STREAM_EVENTS_LOAD_STATE: StreamEventsLoadState = Object.freeze({
  currentGenerationComplete: false,
  fresh: false,
  requestStatus: 'idle',
});

/** Bucket-authoritative load state for session mounts; no screen-local fetched flags. */
export function selectStreamEventsLoadState(
  snapshot: PentacleStreamState,
  streamId: string,
): StreamEventsLoadState {
  const bucket = snapshot.eventBucketsByStream?.[streamId];
  const coverage = bucket?.coverageByWindow?.history ?? bucket?.coverage;
  const request = bucket?.requestsByWindow?.history ?? bucket?.request;
  if (!coverage && !request) return EMPTY_STREAM_EVENTS_LOAD_STATE;
  const currentGenerationComplete = coverage?.complete === true && coverage.generation === currentSocketGeneration;
  const fresh = hasReusableStreamEventsCoverage(bucket, {
    purpose: 'mount-fetch',
    generation: currentSocketGeneration,
    limit: INITIAL_CHAT_FETCH_LIMIT,
    before: null,
    now: Date.now(),
  });
  return {
    currentGenerationComplete,
    fresh,
    requestStatus: request?.status ?? 'idle',
  };
}

export function sameStreamEventsLoadState(
  left: StreamEventsLoadState,
  right: StreamEventsLoadState,
) {
  return left.currentGenerationComplete === right.currentGenerationComplete &&
    left.fresh === right.fresh &&
    left.requestStatus === right.requestStatus;
}

export function markPentacleStreamRendered(streamId: string) {
  const trimmed = String(streamId || '').trim();
  if (!trimmed || !state.eventBucketsByStream?.[trimmed]) return;
  setState(mutatePentacleEventBuckets(state, {
    type: 'touch',
    streamId: trimmed,
    source: 'render',
  }));
}

function drainIntentPrefetchQueue() {
  while (activeIntentPrefetches < INTENT_PREFETCH_CONCURRENCY && intentPrefetchQueue.size > 0) {
    const entries = Array.from(intentPrefetchQueue.values());
    const entry = entries[entries.length - 1];
    if (!entry) return;
    intentPrefetchQueue.delete(entry.streamId);
    if (hasReusablePrefetchCoverage(entry.streamId)) {
      emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_SESSION_DEDUP_SKIP, {
        stream_id: entry.streamId,
        entry_source: entry.entrySource,
      });
      continue;
    }
    activeIntentPrefetches += 1;
    const focusedAtStart = focusedStreamId;
    emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_STARTED, {
      stream_id: entry.streamId,
      entry_source: entry.entrySource,
      fetch_limit: INTENT_PREFETCH_FETCH_LIMIT,
      queue_depth: intentPrefetchQueue.size,
      active_count: activeIntentPrefetches,
    });
    void requestStreamEvents(entry.streamId, INTENT_PREFETCH_FETCH_LIMIT, {
      purpose: 'prefetch',
      entrySource: entry.entrySource,
    })
      .then(() => {
        if (focusedAtStart !== entry.streamId && focusedStreamId !== entry.streamId) {
          emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_LATE_MERGED, {
            stream_id: entry.streamId,
            entry_source: entry.entrySource,
            focused_at_start: focusedAtStart,
            focused_now: focusedStreamId,
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        activeIntentPrefetches = Math.max(0, activeIntentPrefetches - 1);
        drainIntentPrefetchQueue();
      });
  }
}

function streamEventsInFlightKey(streamId: string, purpose: StreamEventsRequestPurpose) {
  return `${streamId}\u0000${streamEventsWindowForPurpose(purpose)}`;
}

function compatibleStreamEventsInFlight(streamId: string, purpose: StreamEventsRequestPurpose) {
  const candidate = streamEventsInFlight.get(streamEventsInFlightKey(streamId, purpose));
  return candidate &&
    streamEventsWindowForPurpose(candidate.purpose) === streamEventsWindowForPurpose(purpose)
    ? candidate
    : undefined;
}

function coalescableStreamEventsInFlight(streamId: string, purpose: StreamEventsRequestPurpose, limit?: number) {
  if (purpose === 'mount-fetch') {
    const compatible = compatibleStreamEventsInFlight(streamId, purpose);
    return compatible?.limit === limit ? compatible : undefined;
  }
  if (purpose === 'older-page') return undefined;
  const compatible = compatibleStreamEventsInFlight(streamId, purpose);
  const sufficient = (candidate: StreamEventsInFlight | undefined) => (
    candidate && (limit === undefined || (candidate.limit !== undefined && candidate.limit >= limit))
  );
  if (sufficient(compatible)) return compatible;
  if (purpose === 'manual') return undefined;
  return undefined;
}

function enqueueIntentPrefetch(streamId: string, entrySource: StreamOpenEntrySource, shouldDrain = true) {
  const trimmed = String(streamId || '').trim();
  if (!trimmed) return;
  rememberStreamOpenEntrySource(trimmed, entrySource);
  if (hasReusablePrefetchCoverage(trimmed)) {
    emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_SESSION_DEDUP_SKIP, {
      stream_id: trimmed,
      entry_source: entrySource,
    });
    return;
  }
  const inFlight = coalescableStreamEventsInFlight(trimmed, 'prefetch', INTENT_PREFETCH_FETCH_LIMIT);
  if (inFlight) {
    emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_COALESCED, {
      stream_id: trimmed,
      entry_source: entrySource,
      coalesced_with: inFlight.purpose,
    });
    void inFlight.promise.catch(() => undefined);
    return;
  }
  const undersizedInFlight = compatibleStreamEventsInFlight(trimmed, 'prefetch');
  if (undersizedInFlight) {
    const previous = deferredIntentPrefetches.get(trimmed);
    deferredIntentPrefetches.set(trimmed, {
      entrySource,
      promise: undersizedInFlight.promise,
    });
    if (previous?.promise !== undersizedInFlight.promise) {
      void undersizedInFlight.promise.catch(() => undefined).finally(() => {
        const deferred = deferredIntentPrefetches.get(trimmed);
        if (deferred?.promise !== undersizedInFlight.promise) return;
        deferredIntentPrefetches.delete(trimmed);
        enqueueIntentPrefetch(trimmed, deferred.entrySource);
      });
    }
    return;
  }
  if (intentPrefetchQueue.has(trimmed)) {
    intentPrefetchQueue.delete(trimmed);
  }
  intentPrefetchQueue.set(trimmed, {
    streamId: trimmed,
    entrySource,
    enqueuedAt: Date.now(),
  });
  while (intentPrefetchQueue.size > INTENT_PREFETCH_MAX_QUEUE) {
    const oldest = intentPrefetchQueue.values().next().value as PrefetchQueueEntry | undefined;
    if (!oldest) break;
    intentPrefetchQueue.delete(oldest.streamId);
    emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_SUPERSEDED_DROPPED, {
      stream_id: oldest.streamId,
      entry_source: oldest.entrySource,
      reason: 'queue_bound',
    });
  }
  emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_ENQUEUED, {
    stream_id: trimmed,
    entry_source: entrySource,
    queue_depth: intentPrefetchQueue.size,
  });
  if (shouldDrain) drainIntentPrefetchQueue();
}

export function prefetchSettledStreams(streamIds: string[], entrySource: StreamOpenEntrySource = 'list-settle') {
  const wanted = new Set(streamIds.map((streamId) => String(streamId || '').trim()).filter(Boolean));
  for (const entry of Array.from(intentPrefetchQueue.values())) {
    if (wanted.has(entry.streamId)) continue;
    intentPrefetchQueue.delete(entry.streamId);
    emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_SUPERSEDED_DROPPED, {
      stream_id: entry.streamId,
      entry_source: entry.entrySource,
      reason: 'superseded_visibility',
    });
  }
  for (const streamId of deferredIntentPrefetches.keys()) {
    if (!wanted.has(streamId)) deferredIntentPrefetches.delete(streamId);
  }
  for (const streamId of wanted) {
    enqueueIntentPrefetch(streamId, entrySource, false);
  }
  drainIntentPrefetchQueue();
}

export function prefetchStreamEvents(streamId: string, entrySource: StreamOpenEntrySource = 'press-in') {
  enqueueIntentPrefetch(streamId, entrySource);
}

export function markStreamOpenIntent(streamId: string, entrySource: StreamOpenEntrySource) {
  rememberStreamOpenEntrySource(streamId, entrySource);
}

export function consumeStreamOpenEntrySource(streamId: string): StreamOpenEntrySource {
  const trimmed = String(streamId || '').trim();
  if (!trimmed) return 'cold-jump';
  const source = streamOpenEntrySources.get(trimmed) || 'cold-jump';
  streamOpenEntrySources.delete(trimmed);
  return source;
}

function clearForegroundProbeTimer() {
  if (foregroundProbeTimer) {
    clearTimeout(foregroundProbeTimer);
    foregroundProbeTimer = null;
  }
}

function isAppActive() {
  return lastAppState === 'active';
}

function isFocusedForeground() {
  return !!focusedStreamId && isAppActive();
}

function usesFocusedFastLiveness() {
  return isFocusedForeground() && !String(focusedStreamId || '').startsWith('mock-host:');
}

function desiredHeartbeatIntervalMs() {
  return usesFocusedFastLiveness() ? FOCUSED_HEARTBEAT_INTERVAL_MS : PING_INTERVAL_MS;
}

function clearHeartbeatTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  activeHeartbeatIntervalMs = null;
}

function recordInboundFrame() {
  lastFrameReceivedAt = monotonicNowMs();
  awaitingPongSince = null;
  clearForegroundProbeTimer();
}

function normalizeInterruptResult(message: Record<string, unknown>): InterruptSendResult {
  const rawConfirm = message.confirm;
  const confirm: InterruptConfirm =
    rawConfirm === 'interrupted' ||
    rawConfirm === 'interrupt_unconfirmed' ||
    rawConfirm === 'not_working' ||
    rawConfirm === 'pane_unavailable' ||
    rawConfirm === 'coalesced'
      ? rawConfirm
      : 'interrupted';
  return {
    interrupted: typeof message.interrupted === 'boolean' ? message.interrupted : confirm !== 'not_working',
    landed: typeof message.landed === 'boolean' ? message.landed : confirm === 'interrupted',
    confirm,
    coalesced: typeof message.coalesced === 'boolean' ? message.coalesced : confirm === 'coalesced',
  };
}

type StreamSliceOptions = {
  visibleCount?: number | 'all';
  includeDraft?: boolean;
  showToolActions?: boolean;
};

export type PentacleConnectionSlice = {
  connected: boolean;
  connecting: boolean;
};

/**
 * Deliberately small first-frame selector. It must stay independent from
 * transcript/detail derivation so route focus can paint a shell before the
 * InteractionManager releases the expensive list work.
 */
export type PentacleSessionShellSlice = {
  connected: boolean;
  connecting: boolean;
  session: PentacleSessionSummary | null;
  retainedRows: number;
  request: EventBucketRequestStatus;
  preview: PentacleSafeSummaryPreview | null;
};

const EMPTY_SESSION_SHELL_SLICE: PentacleSessionShellSlice = Object.freeze({
  connected: false,
  connecting: false,
  session: null,
  retainedRows: 0,
  request: 'idle',
  preview: null,
});

const sessionShellSliceCache = new Map<string, {
  connected: boolean;
  connecting: boolean;
  session: PentacleSessionSummary | null;
  bucket: PentacleEventBucket | undefined;
  optimisticSends: PentacleStreamState['optimisticSends'];
  value: PentacleSessionShellSlice;
}>();

export type PentacleStreamSlice = {
  connecting: boolean;
  hasHydrated?: boolean;
  session: PentacleSessionSummary | null;
  detail: PentacleSessionDetail | null;
  hasOlderHistoryPage: boolean;
  specStatuses: PentacleSpecStatusCapability[];
  workingState?: WorkingStateData;
  turn: TurnState;
  sending: boolean;
  sendingImmediate: boolean;
  returnedToPromptDraft?: {
    optimisticId: string;
    text: string;
  };
};

const EMPTY_STREAM_SLICE: PentacleStreamSlice = Object.freeze({
  connecting: false,
  hasHydrated: false,
  session: null,
  detail: null,
  hasOlderHistoryPage: false,
  specStatuses: [],
  workingState: undefined,
  turn: IDLE_TURN,
  sending: false,
  sendingImmediate: false,
});

const streamActions = Object.freeze({
  sendMessage: sendPentacleMessage,
  sendTurn,
  enqueueTurn,
  dispatchQueuedSendsByOptimisticId,
  flushQueuedSends,
  interruptSend,
  replaceOptimisticAttachments,
  appendOptimisticUserMessage,
  beginOptimisticQuestionAnswer,
  queueOptimisticQuestionAnswer,
  discardOptimisticQuestionAnswer,
  markOptimisticFailed,
  retainUploadForRetry,
  retryOptimisticSend,
  spawnSession: spawnPentacleSession,
  spawnSessionV2: spawnPentacleSessionV2,
  getSpawnCatalog,
  renameSession: renamePentacleSession,
  closeSession: closePentacleSession,
  retryPendingClose: retryPendingSessionClose,
  cancelPendingClose: cancelPendingSessionClose,
  forcePendingClose: forcePendingSessionClose,
  clearDraft: clearPentacleDraft,
  reconnect: reconnectPentacleStream,
  registerPushToken: registerPentaclePushToken,
  listNotifications,
  resolveNotification,
  answerPrompt: answerDaemonPrompt,
  dismissQuestion,
  readThread: readPentacleThread,
  prefetchStreamEvents,
  prefetchSettledStreams,
  markStreamOpenIntent,
});

// Emit coalescing: a single inbound frame can drive several setState() calls
// (e.g. chat.event flushes the live batch AND applies the event). Without
// coalescing each one notifies subscribers, so the chat-list selector re-derives
// multiple times per frame under daemon-v2 volume. runCoalescedEmit() defers the
// notify to one flush at the end of the synchronous frame; nested frames flush
// only at the outermost boundary; a frame that changed nothing flushes nothing.
let emitDepth = 0;
let emitPending = false;

let pendingHarnessLiveApplyTiming: { startedAt: number; data: Record<string, unknown> } | null = null;

function flushPendingHarnessLiveApplyTiming(): void {
  const pending = pendingHarnessLiveApplyTiming;
  if (!pending) return;
  pendingHarnessLiveApplyTiming = null;
  emitHarnessUiTrace('live_apply_timing', {
    ...pending.data,
    set_state_ms: Math.round((monotonicNowMs() - pending.startedAt) * 10) / 10,
  });
}

function queueHarnessLiveApplyTiming(startedAt: number, data: Record<string, unknown>): void {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime.isArmed()) return;
  pendingHarnessLiveApplyTiming = { startedAt, data };
}

function emitListeners(path: 'direct' | 'coalesced') {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime.isArmed()) {
    listeners.forEach((listener) => listener());
    return;
  }
  const listenerMs: number[] = [];
  const startedAt = monotonicNowMs();
  listeners.forEach((listener) => {
    const listenerStartedAt = monotonicNowMs();
    listener();
    listenerMs.push(Math.round((monotonicNowMs() - listenerStartedAt) * 10) / 10);
  });
  emitHarnessUiTrace('store_listener_timing', {
    path,
    listener_count: listenerMs.length,
    listener_ms: listenerMs,
    total_ms: Math.round((monotonicNowMs() - startedAt) * 10) / 10,
    events_count: state.events.length,
  });
}

function emit() {
  if (emitDepth > 0) {
    emitPending = true;
    return;
  }
  emitListeners('direct');
  flushPendingHarnessLiveApplyTiming();
}

function runCoalescedEmit<T>(fn: () => T): T {
  emitDepth += 1;
  try {
    return fn();
  } finally {
    emitDepth -= 1;
    if (emitDepth === 0 && emitPending) {
      emitPending = false;
      emitListeners('coalesced');
  flushPendingHarnessLiveApplyTiming();
    }
    flushPendingHarnessLiveApplyTiming();
  }
}

type CloseAwareSessionSummary = PentacleSessionSummary & {
  created_at?: string;
  session_generation?: string;
  close_pending?: boolean;
  close_intent_id?: string;
  pending_close?: PendingSessionClose;
};

function pendingCloseFromUnknown(value: unknown): PendingSessionClose | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<PendingSessionClose>;
  if (
    typeof row.streamId !== 'string' || !row.streamId ||
    typeof row.host !== 'string' || !row.host ||
    typeof row.sessionName !== 'string' || !row.sessionName ||
    typeof row.requestId !== 'string' || !row.requestId ||
    typeof row.requestedAt !== 'number' || !Number.isFinite(row.requestedAt) ||
    typeof row.attempt !== 'number' || !Number.isInteger(row.attempt) || row.attempt < 0 ||
    typeof row.nextAttemptAt !== 'number' || !Number.isFinite(row.nextAttemptAt) ||
    !['queued', 'retrying', 'accepted', 'deferred', 'cancelling', 'exhausted', 'failed'].includes(String(row.state))
  ) return null;
  return { ...row } as PendingSessionClose;
}

function withPendingClosePresentation(next: PentacleStreamState): PentacleStreamState {
  let changed = false;
  const sessions = next.sessions.map((session) => {
    const closeAware = session as CloseAwareSessionSummary;
    const pending = pendingSessionCloses.get(session.stream_id);
    if (pending) {
      if (closeAware.pending_close === pending) return session;
      changed = true;
      return { ...session, pending_close: pending } as PentacleSessionSummary;
    }
    if (!closeAware.pending_close) return session;
    const { pending_close: _pendingClose, ...rest } = closeAware;
    changed = true;
    return rest as PentacleSessionSummary;
  });
  return changed ? { ...next, sessions } : next;
}

function refreshPendingClosePresentation() {
  setState(withPendingClosePresentation(state));
}

function persistPendingSessionCloses() {
  const payload = JSON.stringify({ version: 1, records: [...pendingSessionCloses.values()] });
  pendingClosePersistence = pendingClosePersistence
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(PENDING_CLOSE_STORAGE_KEY, payload));
  return pendingClosePersistence;
}

function ensurePendingSessionClosesHydrated() {
  if (pendingCloseHydrated) return Promise.resolve();
  if (pendingCloseHydrationPromise) return pendingCloseHydrationPromise;
  pendingCloseHydrationPromise = AsyncStorage.getItem(PENDING_CLOSE_STORAGE_KEY)
    .then((serialized) => {
      if (!serialized) return;
      const parsed = JSON.parse(serialized) as { version?: number; records?: unknown[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
      for (const value of parsed.records) {
        const pending = pendingCloseFromUnknown(value);
        if (pending) pendingSessionCloses.set(pending.streamId, pending);
      }
    })
    .catch(() => undefined)
    .then(() => {
      pendingCloseHydrated = true;
      pendingCloseHydrationPromise = null;
      const now = Date.now();
      let changed = false;
      for (const [streamId, pending] of pendingSessionCloses) {
        if (pending.state === 'deferred' || pending.state === 'accepted' || pending.state === 'failed') continue;
        if (now - pending.requestedAt < PENDING_CLOSE_TTL_MS) continue;
        pendingSessionCloses.set(streamId, {
          ...pending,
          state: 'exhausted',
          nextAttemptAt: 0,
          errorCode: 'retry_exhausted',
          errorMessage: 'Automatic delete retries expired after 10 minutes.',
        });
        changed = true;
      }
      refreshPendingClosePresentation();
      schedulePendingCloseRetry();
      if (changed) void persistPendingSessionCloses();
    });
  return pendingCloseHydrationPromise;
}

function sessionGeneration(session: PentacleSessionSummary | undefined) {
  const closeAware = session as CloseAwareSessionSummary | undefined;
  return String(closeAware?.session_generation || closeAware?.created_at || '') || undefined;
}

function pendingCloseRetryDelay(attempt: number) {
  return PENDING_CLOSE_BACKOFF_MS[Math.min(Math.max(0, attempt), PENDING_CLOSE_BACKOFF_MS.length - 1)];
}

// An unreachable host / failed close is a settled, honest failure — not a transport hiccup —
// so it must never enter the retry loop that a timeout previously produced.
const NON_TRANSIENT_CLOSE_CODES = ['ssh_unreachable', 'host_offline', 'close_failed'];

function isTransientCloseError(error: unknown) {
  if (error instanceof CloseSessionError) {
    if (NON_TRANSIENT_CLOSE_CODES.includes(error.errorCode)) return false;
    return ['session_working', 'daemon_unavailable', 'session_unreachable', 'request_timeout'].includes(error.errorCode);
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('not connected') || message.includes('disconnected') || message.includes('timed out');
}

function pendingCloseErrorFields(error: unknown, host?: string) {
  if (error instanceof CloseSessionError) {
    // An unreachable host is offline, not a transient transport failure. Relabel it with an
    // honest, host-named message and a stable `host_offline` code the row copy keys on.
    if (error.errorCode === 'ssh_unreachable' || error.errorCode === 'host_offline') {
      const label = host ? getHostTheme(host).label : '';
      return {
        errorCode: 'host_offline',
        errorMessage: `${label || 'The host'} is offline`,
      };
    }
    return {
      errorCode: error.errorCode,
      errorMessage: error.errorCode === 'session_working'
        ? 'Session is still working; delete will retry automatically.'
        : error.message,
    };
  }
  return {
    errorCode: 'transport_unavailable',
    errorMessage: error instanceof Error ? error.message : String(error || 'Delete request failed'),
  };
}

function schedulePendingCloseRetry() {
  if (pendingCloseRetryTimer) {
    clearTimeout(pendingCloseRetryTimer);
    pendingCloseRetryTimer = null;
  }
  if (
    !pendingCloseHydrated || !ws || ws.readyState !== WebSocket.OPEN ||
    pendingCloseInventoryGeneration !== currentSocketGeneration
  ) return;
  const now = Date.now();
  const due = [
    ...[...pendingSessionCloses.values()]
      .filter((pending) => pending.state === 'queued' || pending.state === 'retrying')
      .map((pending) => pending.nextAttemptAt || now),
    // Absence deadlines ride the same timer: without one, a genuinely closed row would sit until
    // some unrelated later broadcast happened to arrive.
    ...[...pendingCloseAbsentSince.values()].map((absentAt) => absentAt + PENDING_CLOSE_ABSENCE_GRACE_MS),
  ];
  if (!due.length) return;
  pendingCloseRetryTimer = setTimeout(() => {
    pendingCloseRetryTimer = null;
    void finalizeAbsentPendingCloses().then(drainPendingSessionCloses);
  }, Math.max(0, Math.min(...due) - now));
}

/**
 * Removes pending-close rows whose grace has run out while still absent.
 *
 * Reached only with the socket open on the current inventory generation — the only state in
 * which absence means anything — because schedulePendingCloseRetry arms the timer under that
 * guard and losing the socket disarms it either way: releaseSubscription calls clearTimers, and
 * a reconnect attempt calls connect(), which clears the absence map before this can act on it.
 * Disconnected time is therefore never credited toward the grace.
 */
async function finalizeAbsentPendingCloses() {
  const now = Date.now();
  let changed = false;
  for (const [streamId, absentAt] of [...pendingCloseAbsentSince]) {
    if (!pendingSessionCloses.has(streamId)) {
      pendingCloseAbsentSince.delete(streamId);
      continue;
    }
    if (now - absentAt < PENDING_CLOSE_ABSENCE_GRACE_MS) continue;
    pendingCloseAbsentSince.delete(streamId);
    pendingSessionCloses.delete(streamId);
    changed = true;
  }
  if (!changed) return;
  refreshPendingClosePresentation();
  await persistPendingSessionCloses();
}

async function markPendingCloseRetry(pending: PendingSessionClose, error: unknown) {
  const now = Date.now();
  const errorFields = pendingCloseErrorFields(error, pending.host);
  const exhausted = now - pending.requestedAt >= PENDING_CLOSE_TTL_MS;
  const next: PendingSessionClose = {
    ...pending,
    attempt: pending.attempt + 1,
    state: exhausted ? 'exhausted' : 'retrying',
    nextAttemptAt: exhausted ? 0 : now + pendingCloseRetryDelay(pending.attempt),
    ...errorFields,
  };
  pendingSessionCloses.set(pending.streamId, next);
  refreshPendingClosePresentation();
  await persistPendingSessionCloses();
  schedulePendingCloseRetry();
  return next;
}

function emitHarnessUiTrace(kind: string, data: Record<string, unknown>) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime.isArmed()) return;
  logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
    kind,
    timestamp_emitter_wall: Date.now(),
    ...data,
  });
}

function emitHarnessNewSessionWsCallback(rawFrame: string) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime.isArmed()) return;
  try {
    const message = JSON.parse(rawFrame);
    const event = message?.type === 'chat.event' ? message.event as PentacleEvent | undefined : undefined;
    const streamId = String(event?.stream_id || '');
    if (
      !event ||
      String(event.kind || '').toUpperCase() !== 'USER' ||
      !streamId ||
      state.sessions.some((session) => session.stream_id === streamId)
    ) return;
    const timing = event.raw?._harness_replay_timing as Record<string, unknown> | undefined;
    const callbackWallMs = Date.now();

    const socketWriteStartWallMs = Number(timing?.daemon_socket_write_start_wall_ms);
    emitHarnessUiTrace('live_new_session_ws_callback', {
      stream_id: streamId,
      seq: eventSeq(event) ?? null,
      frame_bytes: rawFrame.length,
      ws_callback_wall_ms: callbackWallMs,
      fixture_at_ms: timing?.fixture_at_ms ?? null,
      fixture_due_wall_ms: timing?.fixture_due_wall_ms ?? null,
      injector_send_wall_ms: timing?.injector_send_wall_ms ?? null,
      daemon_accept_wall_ms: timing?.daemon_accept_wall_ms ?? null,
      daemon_socket_write_start_wall_ms: timing?.daemon_socket_write_start_wall_ms ?? null,
      socket_write_start_to_ws_callback_ms: Number.isFinite(socketWriteStartWallMs)
        ? Math.round((callbackWallMs - socketWriteStartWallMs) * 10) / 10
        : null,
    });
  } catch {
    // The canonical parser below owns malformed-frame handling.
  }
}

function emitHarnessSessionRemovalWsCallback(rawFrame: string) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !harnessRuntime.isArmed()) return;
  try {
    const message = JSON.parse(rawFrame) as Record<string, unknown>;
    const frameType = String(message.type || '');
    const callbackWallMs = Date.now();
    if (frameType === 'session.inventory' || frameType === 'snapshot') {
      const sessions = Array.isArray(message.sessions) ? message.sessions as Array<Record<string, unknown>> : [];
      // One small record per session avoids native-log truncation of inventories.
      for (const session of sessions) {
        emitHarnessUiTrace('session_bootstrap_ws_callback', {
          frame_type: frameType,
          stream_id: session.stream_id,
          bootstrap_state: session.bootstrap_state ?? null,
          ws_callback_wall_ms: callbackWallMs,
        });
      }
    }
    if (frameType === 'spawn.ok') {
      const session = message.session as Record<string, unknown> | undefined;
      emitHarnessUiTrace('spawn_readiness_ws_callback', {
        stream_id: session?.stream_id ?? null,
        bootstrap_state: session?.bootstrap_state ?? null,
        state: message.state ?? null,
        ws_callback_wall_ms: callbackWallMs,
      });
    }
    if (frameType === 'close.ok' || frameType === 'close.degraded' || frameType === 'session.inventory') {
      const sessions = Array.isArray(message.sessions) ? message.sessions as Array<Record<string, unknown>> : [];
      emitHarnessUiTrace('session_removal_ws_callback', {
        frame_type: frameType,
        request_id: message.request_id ?? null,
        deferred: message.deferred ?? null,
        degraded: message.degraded ?? null,
        confirmed_process_dead: message.confirmed_process_dead ?? null,
        reap_status: message.reap_status ?? null,
        stream_ids: sessions.map((session) => String(session.stream_id || '')).filter(Boolean),
        ws_callback_wall_ms: callbackWallMs,
      });
      return;
    }
    const event = frameType === 'chat.event' ? message.event as PentacleEvent | undefined : undefined;
    const seq = event ? eventSeq(event) : null;
    if (!event || seq == null || seq % 64 !== 0) return;
    const timing = event.raw?._harness_replay_timing as Record<string, unknown> | undefined;
    const socketWriteStartWallMs = Number(timing?.daemon_socket_write_start_wall_ms);
    const harnessRunId = String(timing?.harness_run_id || '');
    if (!harnessRunId || !Number.isFinite(socketWriteStartWallMs)) return;
    emitHarnessUiTrace('session_removal_backlog_ws_sample', {
      stream_id: event.stream_id,
      seq,
      harness_run_id: harnessRunId,
      frame_id: timing?.frame_id ?? null,
      ws_callback_wall_ms: callbackWallMs,
      fixture_at_ms: timing?.fixture_at_ms ?? null,
      fixture_due_wall_ms: timing?.fixture_due_wall_ms ?? null,
      injector_send_wall_ms: timing?.injector_send_wall_ms ?? null,
      daemon_accept_wall_ms: timing?.daemon_accept_wall_ms ?? null,
      daemon_socket_write_start_wall_ms: timing?.daemon_socket_write_start_wall_ms ?? null,
      socket_write_start_to_ws_callback_ms: Number.isFinite(socketWriteStartWallMs)
        ? Math.round((callbackWallMs - socketWriteStartWallMs) * 10) / 10
        : null,
    });
  } catch {
    // The canonical parser below owns malformed-frame handling.
  }
}

function shallowEqualState(a: PentacleStreamState, b: PentacleStreamState) {
  return (
    a.connected === b.connected &&
    a.connecting === b.connecting &&
    a.hasHydrated === b.hasHydrated &&
    a.lastError === b.lastError &&
    a.events === b.events &&
    a.eventBucketsByStream === b.eventBucketsByStream &&
    a.eventBucketMutationRevision === b.eventBucketMutationRevision &&
    a.drafts === b.drafts &&
    a.hosts === b.hosts &&
    a.machineStats === b.machineStats &&
    a.sessions === b.sessions &&
    a.specStatuses === b.specStatuses &&
    a.limits === b.limits &&
    a.limitsHealth === b.limitsHealth &&
    a.updates === b.updates &&
    a.notifications === b.notifications &&
    a.workingStates === b.workingStates &&
    a.workingByStream === b.workingByStream &&
    a.optimisticSends === b.optimisticSends &&
    a.optimisticByRequestId === b.optimisticByRequestId
  );
}

function setState(next: PentacleStreamState, notify = true) {
  next = withPendingClosePresentation(next);
  if (shallowEqualState(state, next)) {
    return false;
  }
  const previous = state;
  for (const streamId of Object.keys(previous.eventBucketsByStream ?? {})) {
    if (next.eventBucketsByStream?.[streamId]) continue;
    streamEventsResumeBeforeByStream.delete(streamId);
    streamEventsOlderExhaustedByStream.delete(streamId);
    intentPrefetchQueue.delete(streamId);
    deferredIntentPrefetches.delete(streamId);
  }
  state = next;
  pruneUploadRetries(next);
  emitHarnessUiTrace('store_state_transition', {
    connected: next.connected,
    connecting: next.connecting,
    has_hydrated: next.hasHydrated,
    events_count: next.events.length,
    sessions_count: next.sessions.length,
    notifications_count: next.notifications?.length ?? 0,
    changed_keys: [
      previous.connected !== next.connected ? 'connected' : null,
      previous.connecting !== next.connecting ? 'connecting' : null,
      previous.hasHydrated !== next.hasHydrated ? 'hasHydrated' : null,
      previous.events !== next.events ? 'events' : null,
      previous.sessions !== next.sessions ? 'sessions' : null,
      previous.specStatuses !== next.specStatuses ? 'specStatuses' : null,
      previous.drafts !== next.drafts ? 'drafts' : null,
      previous.workingStates !== next.workingStates ? 'workingStates' : null,
      previous.workingByStream !== next.workingByStream ? 'workingByStream' : null,
      previous.optimisticSends !== next.optimisticSends ? 'optimisticSends' : null,
      previous.optimisticByRequestId !== next.optimisticByRequestId ? 'optimisticByRequestId' : null,
      previous.notifications !== next.notifications ? 'notifications' : null,
    ].filter(Boolean),
  });
  if (notify) emit();
  return true;
}

function updateState(patch: Partial<PentacleStreamState>) {
  setState({ ...state, ...patch });
}

function streamSliceCacheKey(streamId: string, options?: StreamSliceOptions) {
  return [
    streamId,
    options?.visibleCount ?? 80,
    options?.includeDraft === false ? 'nodraft' : 'draft',
    options?.showToolActions ? 'tools' : 'clean',
  ].join('|');
}

function sameSessionSlice(a: PentacleSessionSummary | null, b: PentacleSessionSummary | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.stream_id === b.stream_id &&
    a.host === b.host &&
    a.provider === b.provider &&
    a.session_name === b.session_name &&
    a.display_name === b.display_name &&
    a.title === b.title &&
    a.last_event_at === b.last_event_at &&
    a.last_text === b.last_text &&
    a.last_kind === b.last_kind &&
    a.draft === b.draft &&
    a.pending === b.pending &&
    a.working === b.working &&
    a.working_label === b.working_label &&
    a.online === b.online &&
    a.pane_status === b.pane_status &&
    a.pane_status_reason === b.pane_status_reason &&
    a.pane_status_since === b.pane_status_since &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.question === b.question &&
    a.status_card === b.status_card &&
    a.context_tokens === b.context_tokens &&
    a.model_context_window === b.model_context_window &&
    a.context_level === b.context_level &&
    a.spec_issues === b.spec_issues
  );
}

function sameStreamSlice(a: PentacleStreamSlice, b: PentacleStreamSlice) {
  return (
    a.connecting === b.connecting &&
    a.hasHydrated === b.hasHydrated &&
    sameSessionSlice(a.session, b.session) &&
    a.detail === b.detail &&
    a.hasOlderHistoryPage === b.hasOlderHistoryPage &&
    a.specStatuses === b.specStatuses &&
    a.workingState === b.workingState &&
    a.turn === b.turn &&
    a.sending === b.sending &&
    a.sendingImmediate === b.sendingImmediate &&
    a.returnedToPromptDraft?.optimisticId === b.returnedToPromptDraft?.optimisticId &&
    a.returnedToPromptDraft?.text === b.returnedToPromptDraft?.text
  );
}

export function selectPentacleConnectionSlice(snapshot: PentacleStreamState): PentacleConnectionSlice {
  return {
    connected: snapshot.connected,
    connecting: snapshot.connecting,
  };
}

export function selectSessionShellSlice(
  snapshot: PentacleStreamState,
  streamId: string,
): PentacleSessionShellSlice {
  if (!streamId) return EMPTY_SESSION_SHELL_SLICE;
  const session = snapshot.sessions.find((item) => item.stream_id === streamId) || null;
  const bucket = snapshot.eventBucketsByStream?.[streamId];
  const request = bucket?.requestsByWindow?.history?.status ?? bucket?.request?.status ?? 'idle';
  const retainedRows = bucket?.events.length ?? 0;
  const cached = sessionShellSliceCache.get(streamId);
  if (
    cached &&
    cached.connected === snapshot.connected &&
    cached.connecting === snapshot.connecting &&
    cached.session === session &&
    cached.bucket === bucket &&
    cached.optimisticSends === snapshot.optimisticSends
  ) return cached.value;

  // A completed authoritative response, including a zero-row response, owns
  // the empty state and must replace any summary preview.
  const preview = retainedRows === 0 && request !== 'ready'
    ? selectSafeSessionSummaryPreview(snapshot, streamId)
    : null;
  const value: PentacleSessionShellSlice = {
    connected: snapshot.connected,
    connecting: snapshot.connecting,
    session,
    retainedRows,
    request,
    preview,
  };
  sessionShellSliceCache.set(streamId, {
    connected: snapshot.connected,
    connecting: snapshot.connecting,
    session,
    bucket,
    optimisticSends: snapshot.optimisticSends,
    value,
  });
  return value;
}

export function sameSessionShellSlice(a: PentacleSessionShellSlice, b: PentacleSessionShellSlice) {
  return a === b || (
    a.connected === b.connected &&
    a.connecting === b.connecting &&
    a.session === b.session &&
    a.retainedRows === b.retainedRows &&
    a.request === b.request &&
    a.preview?.key === b.preview?.key
  );
}

export function samePentacleConnectionSlice(a: PentacleConnectionSlice, b: PentacleConnectionSlice) {
  return a.connected === b.connected && a.connecting === b.connecting;
}

export function selectStreamSlice(
  snapshot: PentacleStreamState,
  streamId: string,
  options: StreamSliceOptions = {},
): PentacleStreamSlice {
  if (!streamId) return EMPTY_STREAM_SLICE;
  const session = snapshot.sessions.find((item) => item.stream_id === streamId) || null;
  const sendingState = getSessionSendingState(snapshot, streamId);
  const returnedSend = Object.values(snapshot.optimisticSends ?? {})
    .filter((send) => send.stream_id === streamId && send.status === 'returned_to_prompt')
    .sort((left, right) => (right.returned_at ?? right.created_at) - (left.returned_at ?? left.created_at))[0];
  const detailStartedAt = monotonicNowMs();
  const detail = selectSessionDetail(snapshot, streamId, {
    visibleCount: options.visibleCount,
    includeDraft: options.includeDraft,
    showToolActions: options.showToolActions,
    // Row-level render telemetry is emitted from TranscriptRow mount, not
    // from this selector. Under live composite load this selector can run once
    // per inbound event; emitting for every visible row here creates an
    // O(events * visibleRows) telemetry storm that starves navigation and
    // optimistic-send reconciliation.
    emitRenderTelemetry: false,
  });
  emitHarnessUiTrace('session_detail_select_timing', {
    stream_id: streamId,
    visible_count: options.visibleCount ?? 80,
    events_count: peekEventsForStream(snapshot, streamId).length,
    retained_event_cost: retainedPentacleEventCost(snapshot),
    transcript_count: detail?.transcriptItems.length ?? 0,
    remaining_count: detail?.remainingCount ?? 0,
    duration_ms: Math.round((monotonicNowMs() - detailStartedAt) * 10) / 10,
  });
  const next: PentacleStreamSlice = {
    connecting: snapshot.connecting,
    hasHydrated: snapshot.hasHydrated,
    session,
    detail,
    hasOlderHistoryPage: canRequestOlderStreamEventsPage(streamId),
    specStatuses: snapshot.specStatuses ?? [],
    workingState: snapshot.workingStates?.[streamId],
    turn: snapshot.workingByStream?.[streamId] ?? IDLE_TURN,
    sending: sendingState.sending,
    sendingImmediate: sendingState.immediate,
    returnedToPromptDraft: returnedSend
      ? { optimisticId: returnedSend.optimistic_id, text: returnedSend.text }
      : undefined,
  };
  const key = streamSliceCacheKey(streamId, options);
  const previous = streamSliceCache.get(key);
  if (previous && sameStreamSlice(previous, next)) {
    return previous;
  }
  streamSliceCache.set(key, next);
  emitHarnessUiTrace('stream_slice_update', {
    stream_id: streamId,
    visible_count: options.visibleCount ?? 80,
    transcript_count: next.detail?.transcriptItems.length ?? 0,
    has_older_history_page: next.hasOlderHistoryPage,
    latest_event_at: next.detail?.latestEventAt ?? null,
    remaining_count: next.detail?.remainingCount ?? 0,
    session_last_event_at: next.session?.last_event_at ?? null,
    session_last_kind: next.session?.last_kind ?? null,
    working: Boolean(next.session?.working),
    turn_phase: next.turn.phase,
    sending: next.sending,
    sending_immediate: next.sendingImmediate,
    returned_to_prompt: Boolean(next.returnedToPromptDraft),
  });
  return next;
}

function socketGenerationMatches(generation: number) {
  return generation === currentSocketGeneration;
}

function invalidateCurrentSocketGeneration() {
  currentSocketGeneration += 1;
}

function settlePendingRequest(requestId: string) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return null;
  if (pending.timeout) {
    clearTimeout(pending.timeout);
    pending.timeout = null;
  }
  pendingRequests.delete(requestId);
  pendingFetchBlobChunks.delete(requestId);
  return pending;
}

function armPendingRequestTimeout(requestId: string, pending: PendingRequest) {
  if (pending.timeout) {
    clearTimeout(pending.timeout);
  }
  pending.timeout = setTimeout(() => {
    if (!socketGenerationMatches(pending.generation) || pending.socket !== ws) return;
    const sendStillPending = pending.requestPrefix !== 'send' &&
      Array.from(pendingRequests.values()).some((request) => (
        request.requestPrefix === 'send' &&
        request.generation === pending.generation &&
        request.socket === pending.socket
      ));
    if (pending.requestPrefix === 'request_stream_events') {
      finalizePendingStreamEventsFailure(requestId, pending, 'timeout');
    }
    const settled = settlePendingRequest(requestId);
    settled?.reject(new Error('Pentacle command timed out'));
    if (sendStillPending) return;
    if (pending.socket.readyState === WebSocket.OPEN) {
      closeSocketAfterCommandTimeout(pending.generation, pending.socket);
    }
  }, pending.timeoutMs);
}

// A command's own timeout is anchored to when it was SENT, which can be
// earlier than the last real inbound frame (e.g. a request fired right on
// connect, before the hello snapshot finishes arriving). Judging
// transport-staleness against `now` at that exact instant races the real
// watchdog window and can misreport a truly-dead transport as a one-off
// 'rpc_timeout' merely because this request's clock started early. Wait out
// the remainder of WATCHDOG_NO_FRAME_MS against the actual last-frame
// reference before finalizing the reason, mirroring the reschedule in
// sendLivenessPing.
function closeSocketAfterCommandTimeout(generation: number, socket: WebSocket) {
  const stalledForMs = monotonicNowMs() - lastFrameReceivedAt;
  if (stalledForMs >= WATCHDOG_NO_FRAME_MS) {
    forceCloseSocketForLiveness(generation, socket, 'watchdog_no_inbound_frame');
    return;
  }
  const referenceFrameAt = lastFrameReceivedAt;
  setTimeout(() => {
    if (!socketGenerationMatches(generation) || socket !== ws) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    forceCloseSocketForLiveness(
      generation,
      socket,
      lastFrameReceivedAt > referenceFrameAt ? 'rpc_timeout' : 'watchdog_no_inbound_frame',
    );
  }, WATCHDOG_NO_FRAME_MS - stalledForMs);
}

function refreshPendingRequestTimeout(requestId: string) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  armPendingRequestTimeout(requestId, pending);
}

function requestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const optimisticLaunchNamespace = requestId('launch');

function streamShortId(streamId: string) {
  const short = String(streamId || 'stream');
  return short.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'stream';
}

function nextOptimisticId(streamId: string) {
  const current = optimisticCountersByStream.get(streamId) || 0;
  const next = current + 1;
  optimisticCountersByStream.set(streamId, next);
  return `optimistic_${streamShortId(streamId)}_${optimisticLaunchNamespace}_${next}`;
}

function isReconcilableOptimisticStatus(status: string | undefined) {
  return status === 'queued' ||
    status === 'dispatched' ||
    status === 'acked' ||
    status === 'indeterminate' ||
    status === 'echoed';
}

function findMatchingOptimisticId(event: PentacleEvent, baseState = state) {
  if (event.optimistic_id) {
    const optimistic = baseState.optimisticSends?.[event.optimistic_id];
    if (
      optimistic &&
      optimistic.stream_id === event.stream_id &&
      // A daemon-stamped echo carries THIS row's optimistic_id, which is proof
      // the send actually landed — so it must clear even a 'failed' row. This
      // self-heals false failures (e.g. the 30s RPC timeout firing while the
      // daemon held a send-while-working, or a slow-but-successful readback):
      // the message shows as sent once its echo arrives instead of staying
      // stuck on a failed badge until app restart. The text-fallback branch
      // below stays conservative (failed excluded) so an unrelated same-text
      // message never resurrects a genuinely-failed row.
      (isReconcilableOptimisticStatus(optimistic.status) || optimistic.status === 'failed')
    ) {
      return event.optimistic_id;
    }
    return null;
  }
  const eventText = String(event.text || '');
  const isNotificationAnswer = /"type"\s*:\s*"notification\.answer"/.test(eventText);
  const notificationId = isNotificationAnswer
    ? eventText.match(/"notification_id"\s*:\s*"([^"]+)"/)?.[1]
    : undefined;
  const questionId = notificationId
    ? eventText.match(/"question_id"\s*:\s*"([^"]+)"/)?.[1]
    : undefined;
  if (notificationId) {
    for (const [optimisticId, meta] of optimisticQuestionAnswers) {
      const optimistic = baseState.optimisticSends?.[optimisticId];
      if (
        meta.notificationId === notificationId &&
        (!meta.questionId || !questionId || meta.questionId === questionId) &&
        optimistic?.stream_id === event.stream_id
      ) {
        return optimisticId;
      }
    }
  }
  for (const [optimisticId, optimistic] of Object.entries(baseState.optimisticSends ?? {})) {
    if (
      isReconcilableOptimisticStatus(optimistic.status) &&
      optimisticMatchesServerUser(optimistic, event, OPTIMISTIC_RECONCILE_WINDOW_MS)
    ) {
      return optimisticId;
    }
  }
  return null;
}

function findMatchingCompositeQueuedOptimisticIds(
  event: PentacleEvent,
  baseState: PentacleStreamState,
) {
  if (event.optimistic_id || String(event.kind || '').toUpperCase() !== 'USER') return [];
  const queued = Object.values(baseState.optimisticSends ?? {})
    .filter((send) => (
      send.stream_id === event.stream_id &&
      send.queued_at !== undefined &&
      (isReconcilableOptimisticStatus(send.status) || send.status === 'failed')
    ))
    .sort((left, right) => left.created_at - right.created_at);
  if (queued.length < 2) return [];
  return queued.map((send) => send.text).join('\n\n') === String(event.text || '')
    ? queued.map((send) => send.optimistic_id)
    : [];
}

function matchingOptimisticIdsForServerUser(
  event: PentacleEvent,
  baseState: PentacleStreamState,
) {
  const directOrFallback = findMatchingOptimisticId(event, baseState);
  if (directOrFallback) return [directOrFallback];
  return findMatchingCompositeQueuedOptimisticIds(event, baseState);
}

// A row reconciles from whichever authority lands first: a durable receipt/landed
// result, or a later stamped USER echo. The first is the transition; the second is a
// no-op restatement. Scenarios assert exactly one trace per row, so gate on the row.
const optimisticReconciledTraced = new Set<string>();

function logOptimisticReconciled(
  optimisticId: string,
  event: PentacleEvent | undefined,
  createdAt: number,
  streamId = event?.stream_id || '',
) {
  if (optimisticReconciledTraced.has(optimisticId)) return;
  optimisticReconciledTraced.add(optimisticId);
  const matchedAt = event ? serverEventTime(event) : Date.now();
  logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED, {
    optimistic_id: optimisticId,
    stream_id: streamId,
    matched_ms: Number.isFinite(matchedAt)
      ? Math.max(0, matchedAt - createdAt)
      : Math.max(0, Date.now() - createdAt),
  });
}

// Confirmation lag alone never fails a send: the daemon may legitimately hold
// send-while-working messages. A connection-generation loss is different: the
// non-idempotent mobile send contract cannot be replayed safely, so an
// unconfirmed dispatched send becomes visibly retryable. A later stamped echo
// still reconciles that conservative failure by optimistic_id.

function logFirstEventAfterSendIfTransitioned(
  before: PentacleStreamState,
  after: PentacleStreamState,
  streamId: string,
) {
  const prev = before.workingByStream?.[streamId];
  const next = after.workingByStream?.[streamId];
  if (prev?.phase === 'pending' && next?.phase === 'working' && typeof prev.sentAt === 'number') {
    logTelemetry(TELEMETRY_EVENTS.CHAT_SESSION_FIRST_EVENT_AFTER_SEND, {
      stream_id: streamId,
      elapsed_from_send_press_ms: Date.now() - prev.sentAt,
    });
  }
}

type UserEchoReconciliationResult = {
  next: PentacleStreamState;
  matched: boolean;
};

function withoutInboundUserEcho(current: PentacleStreamState, event: PentacleEvent) {
  const daemonSeq = Number(event.correlatedDaemonSeq ?? event.daemon_seq);
  if (!Number.isFinite(daemonSeq)) return current;
  const streamEvents = peekEventsForStream(current, event.stream_id);
  const events = streamEvents.filter((item) => !(
    item.client_origin !== true &&
    item.stream_id === event.stream_id &&
    String(item.kind || '').toUpperCase() === 'USER' &&
    Number(item.correlatedDaemonSeq ?? item.daemon_seq) === daemonSeq
  ));
  return events.length === streamEvents.length
    ? current
    : mutatePentacleEventBuckets(current, {
      type: 'replace-stream',
      streamId: event.stream_id,
      events,
    });
}

// One reconciliation owner handles every accepted USER echo, whether it arrives
// live, in a coalesced live batch, in a remount fetch, or in a snapshot. Native
// queued batches may arrive as one identity-poor USER row; in that narrow case
// the exact FIFO composite is split back onto its persisted original send IDs.
function reconcileAcceptedUserEchoes(
  reduced: PentacleStreamState,
  events: PentacleEvent[],
  source: string,
): UserEchoReconciliationResult {
  let next = reduced;
  let matched = false;
  for (const event of events) {
    if (String(event.kind || '').toUpperCase() !== 'USER' || event.client_origin === true) continue;
    const optimisticIds = matchingOptimisticIdsForServerUser(event, next);
    if (optimisticIds.length === 0) continue;
    matched = true;
    next = withoutInboundUserEcho(next, event);
    for (const optimisticId of optimisticIds) {
      const optimistic = next.optimisticSends?.[optimisticId];
      if (!optimistic) continue;
      if (isReturnedToPromptUserEvent(event)) {
        next = markOptimisticReturnedToPromptByOptimisticId(next, optimisticId, Date.now());
        continue;
      }
      const confirmation = optimisticIds.length > 1
        ? { ...event, text: optimistic.text }
        : event;
      next = reconcileOptimisticSendWithServerEvent(next, optimisticId, confirmation);
      optimisticQuestionAnswers.delete(optimisticId);
      logOptimisticReconciled(optimisticId, confirmation, optimistic.created_at);
      if (optimistic.request_id) {
        const pending = pendingRequests.get(optimistic.request_id);
        if (pending?.retryTelemetry) {
          emitRetryTelemetry(pending.retryTelemetry, source, 'sent');
        }
        const settled = settlePendingRequest(optimistic.request_id);
        settled?.resolve(true);
      }
    }
  }
  return { next, matched };
}

function applyServerUserEventWithReconciliation(event: PentacleEvent) {
  rememberEventSeqs([event]);
  const before = state;
  const reconciled = reconcileAcceptedUserEchoes(before, [event], 'chat.event');
  const next = reconciled.matched ? reconciled.next : applyPentacleEvent(before, event);
  const deferHarnessLiveEmit = process.env.EXPO_PUBLIC_HARNESS === '1';
  const stateChanged = setState(next, !deferHarnessLiveEmit);
  rememberHarnessLiveApplied([event], next, before);
  if (deferHarnessLiveEmit && stateChanged) emit();
  logFirstEventAfterSendIfTransitioned(before, next, event.stream_id);
  return next;
}

function connectionUrls() {
  const defaultWsUrl = getDefaultPentacleWsUrl();
  if (!wsUrl) wsUrl = defaultWsUrl;
  if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.getParam('ws_url')) {
    return [String(wsUrl || '').trim()].filter(Boolean);
  }
  const urls = [wsUrl, defaultWsUrl]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(urls));
}

function connectionErrorMessage(targetUrl: string) {
  if (hasSameUrlHost(targetUrl, getDefaultPentacleWsUrl())) {
    return 'Pentacle could not reach the tailnet endpoint. Make sure Tailscale is connected on this iPhone.';
  }
  return `Pentacle stream connection failed (${targetUrl})`;
}

function hasSameUrlHost(left: string, right: string) {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

function urlHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function eventSeq(event: PentacleEvent) {
  const seq = Number(event.daemon_seq);
  return Number.isFinite(seq) ? seq : undefined;
}

function eventSeqKey(event: PentacleEvent) {
  const seq = eventSeq(event);
  return seq === undefined ? '' : String(seq);
}

function clearHarnessAllChatsCohort() {
  harnessAllChatsCohort = null;
  harnessAllChatsAppliedIdentities = null;
  harnessAllChatsAdmissionBindingByEvent = null;
  harnessAllChatsVerifiedThrough = 0;
}

function positiveHarnessInteger(name: string) {
  const value = Number(harnessRuntime.getParam(name));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function ensureHarnessAllChatsCohort(): HarnessAllChatsCohort | null {
  if (
    process.env.EXPO_PUBLIC_HARNESS !== '1' ||
    !harnessRuntime.isArmed() ||
    !harnessRuntime.hasAction('all_chats_regression') ||
    harnessRuntime.getScenario() !== 'all_chats_freeze_sim_regression'
  ) {
    if (harnessAllChatsCohort) clearHarnessAllChatsCohort();
    return null;
  }
  const runId = harnessRuntime.getParam('scenario_run_id') || '';
  const baseStreamId = harnessRuntime.getParam('stream_id') || '';
  const streamMatch = /^(.*?)(\d+)$/.exec(baseStreamId);
  const sessionCount = positiveHarnessInteger('all_chats_session_count');
  const setupEventCount = positiveHarnessInteger('all_chats_setup_event_count');
  const eventCount = positiveHarnessInteger('all_chats_event_count');
  const burstSize = positiveHarnessInteger('all_chats_burst_size');
  if (
    !runId || !streamMatch || Number(streamMatch[2]) !== 0 ||
    sessionCount === undefined || setupEventCount === undefined || eventCount === undefined ||
    burstSize === undefined ||
    eventCount < setupEventCount || eventCount - setupEventCount > 80
  ) {
    if (harnessAllChatsCohort) clearHarnessAllChatsCohort();
    return null;
  }
  const bindingKey = [
    runId,
    streamMatch[1],
    streamMatch[2].length,
    currentSocketGeneration,
    sessionCount,
    setupEventCount,
    eventCount,
    burstSize,
  ].join('\u0000');
  if (harnessAllChatsCohort?.bindingKey === bindingKey) return harnessAllChatsCohort;
  harnessAllChatsCohort = {
    bindingKey,
    streamPrefix: streamMatch[1],
    streamIndexWidth: streamMatch[2].length,
    generation: currentSocketGeneration,
    sessionCount,
    setupEventCount,
    eventCount,
    burstSize,
  };
  harnessAllChatsAppliedIdentities = new Set<string>();
  harnessAllChatsAdmissionBindingByEvent = new Map<PentacleEvent, string>();
  harnessAllChatsVerifiedThrough = 0;
  return harnessAllChatsCohort;
}

function harnessAllChatsExpectedStreamId(cohort: HarnessAllChatsCohort, seq: number) {
  const index = (seq - 1) % cohort.sessionCount;
  return `${cohort.streamPrefix}${String(index).padStart(cohort.streamIndexWidth, '0')}`;
}

function harnessAllChatsIdentityKey(streamId: string, seq: number) {
  return `${streamId}\u0000${seq}`;
}

function rememberHarnessAllChatsAdmission(event: PentacleEvent) {
  const cohort = ensureHarnessAllChatsCohort();
  if (!cohort) return;
  const seq = eventSeq(event);
  const streamId = String(event.stream_id || '');
  if (
    seq === undefined || seq < 1 || seq > cohort.eventCount ||
    streamId !== harnessAllChatsExpectedStreamId(cohort, seq)
  ) return;
  harnessAllChatsAdmissionBindingByEvent?.set(event, cohort.bindingKey);
}

function stateContainsHarnessIdentity(
  appliedState: PentacleStreamState,
  streamId: string,
  seq: number,
) {
  const streamEvents = selectPentacleDerivedEventIndex(appliedState).byStream.get(streamId) || [];
  return streamEvents.some((event) => eventSeq(event) === seq);
}

function oldestLoadedSeqForStream(streamId: string) {
  let oldest: number | undefined;
  for (const event of peekEventsForStream(state, streamId)) {
    const seq = eventSeq(event);
    if (seq === undefined) continue;
    oldest = oldest === undefined ? seq : Math.min(oldest, seq);
  }
  return oldest;
}

function canRequestOlderStreamEventsPage(streamId: string) {
  const key = String(streamId || '').trim();
  return Boolean(key && streamEventsResumeBeforeByStream.has(key) && !streamEventsOlderExhaustedByStream.has(key));
}

function invalidateStreamSliceCache(streamId: string) {
  const prefix = `${streamId}|`;
  for (const key of streamSliceCache.keys()) {
    if (key.startsWith(prefix)) streamSliceCache.delete(key);
  }
}

function emitStreamEventsCursorChanged(streamId: string, notify = true) {
  if (!streamId) return;
  invalidateStreamSliceCache(streamId);
  emitHarnessUiTrace('stream_events_cursor_update', {
    stream_id: streamId,
    before_daemon_seq: streamEventsResumeBeforeByStream.get(streamId) ?? null,
    older_exhausted: streamEventsOlderExhaustedByStream.has(streamId),
    has_older_history_page: canRequestOlderStreamEventsPage(streamId),
  });
  if (notify) emit();
}

function updateStreamEventsResumeCursor(streamId: string, events: PentacleEvent[], notify = true) {
  const before = streamEventsResumeBeforeByStream.get(streamId);
  let oldest = before ?? oldestLoadedSeqForStream(streamId);
  for (const event of events) {
    if (event.stream_id !== streamId) continue;
    const seq = eventSeq(event);
    if (seq === undefined) continue;
    oldest = oldest === undefined ? seq : Math.min(oldest, seq);
  }
  if (oldest !== undefined) {
    streamEventsResumeBeforeByStream.set(streamId, oldest);
    // Only re-open the possibility of older pages when we actually learned about an event
    // older than the one we already held. Clearing unconditionally let any later refetch of
    // the NEWEST events (freshness-guard, focused-refetch) wipe a proven exhaustion and
    // resurrect the phantom affordance.
    // Reopen when we learn a cursor we did not have, or one older than we held. Requiring a
    // PRIOR cursor here would strand a stream that was marked exhausted by an empty response
    // (which sets no cursor at all): the first real backfill afterwards could never clear the
    // flag, permanently hiding history that does exist.
    if (before === undefined || oldest < before) {
      streamEventsOlderExhaustedByStream.delete(streamId);
    }
  }
  if (streamEventsResumeBeforeByStream.get(streamId) !== before) {
    emitStreamEventsCursorChanged(streamId, notify);
    return true;
  }
  return false;
}

function markOlderStreamEventsPageExhausted(streamId: string, notify = true) {
  if (!streamId || streamEventsOlderExhaustedByStream.has(streamId)) return false;
  streamEventsOlderExhaustedByStream.add(streamId);
  emitStreamEventsCursorChanged(streamId, notify);
  return true;
}

function noteCompletedStreamEventsRequest(
  streamId: string,
  events: PentacleEvent[],
  pending: PendingRequest | undefined,
  notify = true,
  rehydrateFailed = false,
) {
  if (!streamId) return false;
  let changed = updateStreamEventsResumeCursor(streamId, events, notify);
  // A response shorter than the limit it asked for means the server had nothing more to give,
  // so we have reached the beginning of the stream. This is the only evidence available — the
  // history frames carry no has_more/total field. It holds for EVERY purpose, not just
  // 'older-page': a mount-fetch that asks for 48 and gets 3 has already proven exhaustion.
  // Restricting it to 'older-page' is what left `hasOlderHistoryPage` true on chats with no
  // earlier page, so the affordance rendered and the press was a wasted round trip
  // (public behavior contract).
  // `rehydrate_failed` means the daemon could not read the backing history, NOT that the history
  // is absent (chat_streamd.py:12253-12256 — the field exists precisely so clients can tell
  // "empty chat" from "history unavailable, retry may help"). A short or empty page under that
  // flag proves nothing, so infer nothing.
  //
  // A missing/zero requested limit is likewise no evidence: without knowing what we asked for,
  // an empty response cannot distinguish "nothing older" from "we asked for nothing".
  const requested = pending?.streamEventsLimit;
  const canInferExhaustion = !rehydrateFailed && typeof requested === 'number' && requested > 0;
  if (canInferExhaustion && events.length < requested) {
    changed = markOlderStreamEventsPageExhausted(streamId, notify) || changed;
  }
  return changed;
}

function eventParentSeq(event: PentacleEvent) {
  const raw = event.raw || {};
  const parent = Number(raw.parent_seq || raw.parent_daemon_seq || raw.parent_sequence);
  return Number.isFinite(parent) ? parent : undefined;
}

// CHAT_EVENT_RECEIVED is a per-event firehose. It exists for dev/harness
// diagnostics only; in a production (release) build it must emit nothing —
// otherwise every daemon-v2 chat.event pays a JSON.stringify + console.log in
// the message handler. Dev and harness builds keep the mirror.
// (public behavior contract defect 3.)
export function isPerEventTelemetrySuppressed(
  isDev: boolean = typeof __DEV__ !== 'undefined' ? __DEV__ : false,
  harness: string | undefined = process.env.EXPO_PUBLIC_HARNESS,
): boolean {
  return !isDev && harness !== '1';
}

function logChatEventReceived(event: PentacleEvent, source: string) {
  if (isPerEventTelemetrySuppressed()) return;
  // Harness-only mirror gate. Production receives every chat.event so the
  // sidebar's last_text preview updates from the reducer, but in the harness
  // build that firehose feeds [TELEMETRY] and floods idevicesyslog on device.
  // Mirror only events for chat(s) the scenario is driving / observing
  // (harnessActiveStreams in harnessRuntime); production is unaffected because
  // the env-flag short-circuit returns false and logTelemetry remains the
  // sole emitter. See harnessRuntime § "Harness-active-stream tracker".
  if (
    process.env.EXPO_PUBLIC_HARNESS === '1' &&
    harnessRuntime.isArmed() &&
    (
      (harnessRuntime.hasAction('composite_chat_load_probe') && String(event.kind || '').toUpperCase() !== 'USER') ||
      !harnessRuntime.isStreamHarnessActive(String(event.stream_id || '')) ||
      (
        harnessRuntime.hasAction('composite_chat_load_probe') &&
        source === 'chat.event' &&
        focusedStreamId !== String(event.stream_id || '')
      )
    )
  ) {
    return;
  }
  logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RECEIVED, {
    stream_id: event.stream_id,
    kind: event.kind,
    seq: eventSeq(event),
    parent_seq: eventParentSeq(event),
    provider: event.provider,
    source,
  });
}

function recordTranscriptResume(events: PentacleEvent[], source: string) {
  if (!resumePendingAfterClose || events.length === 0) return;

  const byStream = new Map<string, PentacleEvent[]>();
  for (const event of events) {
    const streamId = String(event.stream_id || '');
    if (!streamId) continue;
    byStream.set(streamId, [...(byStream.get(streamId) || []), event]);
  }

  for (const [streamId, streamEvents] of byStream) {
    const seqs = streamEvents
      .map(eventSeq)
      .filter((seq): seq is number => seq !== undefined)
      .sort((a, b) => a - b);
    if (seqs.length === 0) continue;
    const previousSeq = lastEventSeqByStream.get(streamId);
    const firstSeq = seqs[0];
    logTelemetry(TELEMETRY_EVENTS.CHAT_TRANSCRIPT_RESUMED, {
      stream_id: streamId,
      from_seq: previousSeq ?? null,
      gap: previousSeq === undefined ? 0 : Math.max(0, firstSeq - previousSeq - 1),
      first_seq: firstSeq,
      source,
    });
  }

  resumePendingAfterClose = false;
}

function rememberEventSeqs(events: PentacleEvent[]) {
  for (const event of events) {
    const streamId = String(event.stream_id || '');
    const seq = eventSeq(event);
    if (!streamId || seq === undefined) continue;
    const previous = lastEventSeqByStream.get(streamId);
    if (previous === undefined || seq > previous) {
      lastEventSeqByStream.set(streamId, seq);
    }
  }
}

function applyEvent(event: PentacleEvent) {
  recordTranscriptResume([event], 'chat.event');
  rememberEventSeqs([event]);
  const before = state;
  const streamId = String(event.stream_id || '');
  const beforeOptimisticSignature = optimisticSignatureForState(before, streamId);
  const beforeEventsCount = before.events.length;
  const startedAt = monotonicNowMs();
  const reduceStartedAt = monotonicNowMs();
  const next = applyPentacleEvent(state, event);
  const reduceMs = monotonicNowMs() - reduceStartedAt;
  const setStateStartedAt = monotonicNowMs();
  const deferHarnessLiveEmit = process.env.EXPO_PUBLIC_HARNESS === '1';
  const stateChanged = setState(next, !deferHarnessLiveEmit);
  const appliedBurstIds = rememberHarnessLiveApplied([event], next, before);
  if (deferHarnessLiveEmit && stateChanged) {
    queueHarnessLiveApplyTiming(setStateStartedAt, {
    source: 'chat.event.immediate',
    immediate_reason: liveImmediateApplyReason || null,
    applied_count: 1,
    applied_burst_ids: appliedBurstIds,
    before_events_count: beforeEventsCount,
    after_events_count: next.events.length,
    duration_ms: Math.round((monotonicNowMs() - startedAt) * 10) / 10,
    reduce_ms: Math.round(reduceMs * 10) / 10,
    is_focused: focusedStreamId === streamId,
    classifier_timer_armed: liveStreamEventsTimer !== null,
    classifier_prev_global_seq: lastLiveBatchGlobalSeq ?? null,
    classifier_global_gap: eventSeq(event) !== undefined && lastLiveBatchGlobalSeq !== undefined
      ? eventSeq(event)! - lastLiveBatchGlobalSeq
      : null,
    first_seq: eventSeq(event) ?? null,
    last_seq: eventSeq(event) ?? null,
  });
    emit();
  }
  if (streamId && beforeOptimisticSignature && !optimisticSignatureForState(next, streamId)) {
    postOptimisticDrainByStream.add(streamId);
  }
  logFirstEventAfterSendIfTransitioned(before, next, event.stream_id);
  return next;
}

function recordHarnessSummaryInbound(streamId: string, lastText: string | undefined | null) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
  summaryFlowDiagnostics?.recordSummaryInbound(streamId);
  if (summaryFlowDiagnostics?.wouldStripSummary(lastText)) {
    summaryFlowDiagnostics.recordSummaryStrip(streamId, lastText);
  }
}

function recordHarnessEventOutcome(
  inboundEvents: readonly PentacleEvent[],
) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1' || !eventFlowDiagnostics) return;
  const seenInboundSeqs = new Set<string>();
  const persistedByStream: Record<string, number> = {};

  for (const event of inboundEvents) {
    const streamId = String(event.stream_id || '');
    if (!streamId) continue;
    const seqKey = eventSeqKey(event);
    const duplicate = Boolean(seqKey && (harnessPersistedEventSeqKeys.has(seqKey) || seenInboundSeqs.has(seqKey)));
    if (seqKey) seenInboundSeqs.add(seqKey);
    const reason = eventFlowDiagnostics.classifyDrop(event, { duplicate });
    if (reason) {
      eventFlowDiagnostics.recordDrop(streamId, reason);
      continue;
    }
    if (seqKey) {
      harnessPersistedEventSeqKeys.add(seqKey);
      persistedByStream[streamId] = (persistedByStream[streamId] || 0) + 1;
    }
  }

  for (const [streamId, delta] of Object.entries(persistedByStream)) {
    eventFlowDiagnostics.recordPersistedDelta(streamId, delta);
  }
}

function clearTimers() {
  pendingHarnessLiveApplyTiming = null;
  if (deferredConnectTimer) {
    clearTimeout(deferredConnectTimer);
    deferredConnectTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (preOpenConnectTimer) {
    clearTimeout(preOpenConnectTimer);
    preOpenConnectTimer = null;
  }
  clearHeartbeatTimer();
  clearForegroundProbeTimer();
  if (foregroundResyncTimer) {
    clearTimeout(foregroundResyncTimer);
    foregroundResyncTimer = null;
  }
  if (pendingCloseRetryTimer) {
    clearTimeout(pendingCloseRetryTimer);
    pendingCloseRetryTimer = null;
  }
  awaitingPongSince = null;
  pendingForegroundProbe = false;
  if (deferredStreamEventsTimer) {
    clearTimeout(deferredStreamEventsTimer);
    deferredStreamEventsTimer = null;
  }
  deferredStreamEventBatches.length = 0;
  if (liveStreamEventsTimer) {
    clearTimeout(liveStreamEventsTimer);
    liveStreamEventsTimer = null;
  }
  liveStreamEventBatch = [];
  lastLiveBatchSeqByStream.clear();
  lastLiveBatchKindByStream.clear();
  lastLiveBatchGlobalSeq = undefined;
  lastLiveBatchGlobalKind = undefined;
  harnessPendingLiveSeqCounts.clear();
  harnessPendingLiveCount = 0;
  harnessMaxAppliedLiveSeq = 0;
  harnessMaxReceivedLiveSeq = 0;
  clearHarnessAllChatsCohort();
  promptedPendingOptimisticSignatureByStream.clear();
  postOptimisticDrainByStream.clear();
  deferredBackgroundLiveEventsByStream.clear();
  harnessPersistedEventSeqKeys.clear();
}

function clearDisconnectBannerTimer() {
  if (disconnectBannerTimer) {
    clearTimeout(disconnectBannerTimer);
    disconnectBannerTimer = null;
  }
  pendingDisconnectBannerGeneration = null;
}

function scheduleDisconnectBanner(generation: number, message = 'Pentacle stream disconnected') {
  clearDisconnectBannerTimer();
  pendingDisconnectBannerGeneration = generation;
  disconnectBannerTimer = setTimeout(() => {
    if (pendingDisconnectBannerGeneration !== generation) return;
    disconnectBannerTimer = null;
    pendingDisconnectBannerGeneration = null;
    if (state.connected) return;
    updateState({ lastError: message, connecting: false });
  }, DISCONNECT_BANNER_GRACE_MS);
}

function scheduleReconnect(generation = currentSocketGeneration) {
  if (subscribers === 0 || reconnectTimer) return;
  const delay = RECONNECT_STEPS_MS[Math.min(reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
  const attempt = reconnectAttempt + 1;
  logTelemetry(TELEMETRY_EVENTS.CHAT_WS_RECONNECT_ATTEMPT, {
    backoff_ms: delay,
    attempt,
    subscriber_count: subscribers,
  });
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    if (!socketGenerationMatches(generation)) return;
    reconnectTimer = null;
    connect();
  }, delay);
}

function forceCloseSocketForLiveness(
  generation: number,
  socket: WebSocket,
  reason: string,
) {
  if (!socketGenerationMatches(generation) || socket !== ws) return;
  livenessCloseGeneration = generation;
  livenessCloseErrorMessage = reason === 'rpc_timeout'
    ? 'Pentacle command timed out'
    : 'Pentacle stream disconnected';
  updateState({ connected: false });
  pendingReconnectSurvivorGeneration = generation;
  failAmbiguousOptimisticSends(
    generation,
    reason === 'rpc_timeout'
      ? 'delivery_unconfirmed_after_rpc_timeout'
      : 'delivery_unconfirmed_after_disconnect',
  );
  invalidateCurrentSocketGeneration();
  ws = null;
  clearTimers();
  resumePendingAfterClose = true;
  logTelemetry(TELEMETRY_EVENTS.CHAT_WS_CLOSE, {
    reason,
    code: 4000,
    was_clean: false,
    source: 'liveness_force_close',
    subscriber_count: subscribers,
  });
  const pendingErrorMessage = livenessCloseErrorMessage;
  livenessCloseGeneration = null;
  livenessCloseErrorMessage = 'Pentacle stream disconnected';
  failPendingRequests(new Error(pendingErrorMessage));
  updateState({ connected: false, connecting: true });
  scheduleDisconnectBanner(generation, pendingErrorMessage);
  try {
    socket.close(4000, reason);
  } catch {}
  scheduleReconnect();
}

function sendLivenessPing(
  generation: number,
  socket: WebSocket,
  sendFailureReason: string,
  timeoutReason: string | null,
  timeoutMs: number,
  requiresFocusedForeground = false,
) {
  if (!socketGenerationMatches(generation) || socket !== ws) return;
  if (socket.readyState !== WebSocket.OPEN) return;
  if (requiresFocusedForeground && !isFocusedForeground()) return;
  const probeStartedAt = monotonicNowMs();
  try {
    socket.send(JSON.stringify({ type: 'ping' }));
    awaitingPongSince = probeStartedAt;
  } catch {
    forceCloseSocketForLiveness(generation, socket, sendFailureReason);
    return;
  }
  if (!timeoutReason) return;
  clearForegroundProbeTimer();
  foregroundProbeTimer = setTimeout(() => {
    foregroundProbeTimer = null;
    if (!socketGenerationMatches(generation) || socket !== ws) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (requiresFocusedForeground && !isFocusedForeground()) return;
    if (usesLenientFocusedProbeWindow(generation, socket)) {
      if (awaitingPongSince === probeStartedAt) awaitingPongSince = null;
      return;
    }
    if (lastFrameReceivedAt <= probeStartedAt) {
      forceCloseSocketForLiveness(generation, socket, timeoutReason);
    }
  }, timeoutMs);
}

function usesLenientFocusedProbeWindow(generation: number, socket: WebSocket) {
  let hasHistoryRequest = false;
  for (const request of pendingRequests.values()) {
    if (request.generation !== generation || request.socket !== socket) continue;
    if (request.requestPrefix === 'send') return false;
    if (request.requestPrefix === 'request_stream_events') hasHistoryRequest = true;
  }
  return hasHistoryRequest;
}

function focusedProbeTimeoutMs(generation: number, socket: WebSocket) {
  return usesLenientFocusedProbeWindow(generation, socket)
    ? FOCUSED_HISTORY_PROBE_TIMEOUT_MS
    : FOCUSED_PROBE_TIMEOUT_MS;
}

function sendHeartbeatPing(generation: number, socket: WebSocket) {
  sendLivenessPing(generation, socket, 'heartbeat_send_failed', null, 0);
}

function sendFocusedLivenessProbe(
  generation: number,
  socket: WebSocket,
  source: 'focused_heartbeat' | 'focused_interaction',
  timeoutOverrideMs?: number,
) {
  const timeoutMs = timeoutOverrideMs ?? focusedProbeTimeoutMs(generation, socket);
  if (source === 'focused_heartbeat') {
    logTelemetry(TELEMETRY_EVENTS.CHAT_FOCUSED_LIVENESS_PROBE, {
      source,
      stream_id: focusedStreamId,
      timeout_ms: timeoutMs,
      already_pending: false,
      app_state: lastAppState,
    });
  }
  sendLivenessPing(
    generation,
    socket,
    `${source}_send_failed`,
    `${source}_timeout`,
    timeoutMs,
    true,
  );
}

function refreshHeartbeatTimer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const intervalMs = desiredHeartbeatIntervalMs();
  if (pingTimer && activeHeartbeatIntervalMs === intervalMs) return;
  const generation = currentSocketGeneration;
  const socket = ws;
  clearHeartbeatTimer();
  activeHeartbeatIntervalMs = intervalMs;
  pingTimer = setInterval(() => {
    runHeartbeat(generation, socket);
  }, intervalMs);
}

function requestFocusedProbe(_source: 'focus' | 'foreground' | 'interaction' | 'send' | 'scroll' | 'tap' | 'pull') {
  if (!usesFocusedFastLiveness()) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    return true;
  }
  const now = monotonicNowMs();
  if (awaitingPongSince !== null) {
    if (_source === 'send') {
      sendFocusedLivenessProbe(
        currentSocketGeneration,
        ws,
        'focused_interaction',
        FOCUSED_PROBE_TIMEOUT_MS,
      );
      return true;
    }
    logTelemetry(TELEMETRY_EVENTS.CHAT_FOCUSED_LIVENESS_PROBE, {
      source: _source,
      stream_id: focusedStreamId,
      timeout_ms: focusedProbeTimeoutMs(currentSocketGeneration, ws),
      already_pending: true,
    });
    return true;
  }
  if (now - lastFocusedInteractionProbeAt < FOCUSED_INTERACTION_PROBE_DEBOUNCE_MS) return true;
  lastFocusedInteractionProbeAt = now;
  logTelemetry(TELEMETRY_EVENTS.CHAT_FOCUSED_LIVENESS_PROBE, {
    source: _source,
    stream_id: focusedStreamId,
    timeout_ms: focusedProbeTimeoutMs(currentSocketGeneration, ws),
    already_pending: false,
  });
  sendFocusedLivenessProbe(
    currentSocketGeneration,
    ws,
    'focused_interaction',
    _source === 'send' ? FOCUSED_PROBE_TIMEOUT_MS : undefined,
  );
  return true;
}

function runHeartbeat(generation: number, socket: WebSocket) {
  if (!socketGenerationMatches(generation) || socket !== ws) return;
  if (socket.readyState !== WebSocket.OPEN) return;
  const now = monotonicNowMs();
  const desiredInterval = desiredHeartbeatIntervalMs();
  if (activeHeartbeatIntervalMs !== desiredInterval) {
    refreshHeartbeatTimer();
    return;
  }
  if (usesFocusedFastLiveness()) {
    if (awaitingPongSince === null) {
      sendFocusedLivenessProbe(generation, socket, 'focused_heartbeat');
    }
    return;
  }
  if (now - lastFrameReceivedAt >= WATCHDOG_NO_FRAME_MS) {
    if (pendingRequests.size > 0) return;
    forceCloseSocketForLiveness(generation, socket, 'watchdog_no_inbound_frame');
    return;
  }
  if (awaitingPongSince === null) {
    sendHeartbeatPing(generation, socket);
  }
}

function refetchFocusedStreamTail() {
  const streamId = focusedStreamId;
  if (!streamId || !ws || ws.readyState !== WebSocket.OPEN) return;
  void requestStreamEvents(streamId, FOCUSED_STREAM_REFETCH_LIMIT, { purpose: 'focused-refetch' }).catch(() => {});
}

function probeForegroundSocket(generation: number, socket: WebSocket) {
  if (!socketGenerationMatches(generation) || socket !== ws) return;
  if (socket.readyState !== WebSocket.OPEN) return;
  sendLivenessPing(
    generation,
    socket,
    'foreground_probe_send_failed',
    'foreground_probe_timeout',
    FOREGROUND_PROBE_TIMEOUT_MS,
  );
}

function runForegroundResync(needsProbe: boolean) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  const generation = currentSocketGeneration;
  const socket = ws;
  refetchFocusedStreamTail();
  if (needsProbe && awaitingPongSince === null) {
    probeForegroundSocket(generation, socket);
  }
  refreshHeartbeatTimer();
}

function scheduleForegroundResync() {
  const now = monotonicNowMs();
  pendingForegroundProbe = pendingForegroundProbe || (!focusedStreamId && now - lastFrameReceivedAt >= WATCHDOG_NO_FRAME_MS);
  lastFrameReceivedAt = now;
  if (!focusedStreamId) {
    awaitingPongSince = null;
  }
  if (foregroundResyncTimer) {
    clearTimeout(foregroundResyncTimer);
  }
  foregroundResyncTimer = setTimeout(() => {
    foregroundResyncTimer = null;
    const needsProbe = pendingForegroundProbe;
    pendingForegroundProbe = false;
    runForegroundResync(needsProbe);
  }, FOREGROUND_RESYNC_DEBOUNCE_MS);
}

function handlePentacleAppStateChange(nextState: AppStateStatus) {
  const previous = lastAppState;
  lastAppState = nextState;
  refreshHeartbeatTimer();
  if (nextState !== 'active') return;
  if (previous === 'active') return;
  requestFocusedProbe('foreground');
  scheduleForegroundResync();
  void ensurePendingSessionClosesHydrated().then(() => drainPendingSessionCloses());
}

try {
  AppState.addEventListener('change', handlePentacleAppStateChange);
} catch {
  // Some non-RN test environments provide a partial AppState shim.
}

function failPendingRequests(error: Error) {
  let next = state;
  for (const [streamId, bucket] of Object.entries(state.eventBucketsByStream ?? {})) {
    const coverageByWindow = bucket.coverageByWindow ?? (bucket.coverage ? { history: bucket.coverage } : {});
    for (const [window, coverage] of Object.entries(coverageByWindow)) {
      next = mutatePentacleEventBuckets(next, {
        type: 'set-request-window',
        streamId,
        window: window as EventBucketRequestWindow,
        request: bucket.requestsByWindow?.[window as EventBucketRequestWindow],
        coverage: {
          ...coverage,
          complete: false,
          authoritativeZero: false,
          freshUntil: undefined,
        },
        replaceCoverage: true,
      });
    }
  }
  let bucketStateChanged = setState(next, false);
  for (const [requestId, pending] of pendingRequests) {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    if (pending.requestPrefix === 'request_stream_events') {
      bucketStateChanged = finalizePendingStreamEventsFailure(
        requestId,
        pending,
        'reconnect',
        false,
      ) || bucketStateChanged;
    }
    pending.reject(error);
  }
  pendingRequests.clear();
  pendingFetchBlobChunks.clear();
  if (bucketStateChanged) emit();
}

function failAmbiguousOptimisticSends(generation: number, reason: string) {
  void generation;
  void reason;
  receiptQueryInFlight = null;
  queuedReceiptQueries.length = 0;
}

// A queued row that was explicitly submitted while offline never reached the
// wire, so it is safe to dispatch once the next socket becomes healthy. Rows
// that reached the wire instead reconcile through their durable receipt.
function dispatchOfflineQueuedSends(generation: number) {
  for (const optimisticId of queuedOptimisticDispatchRequests) {
    const optimistic = state.optimisticSends?.[optimisticId];
    if (
      !optimistic ||
      optimistic.status !== 'queued' ||
      optimistic.socket_generation !== generation
    ) continue;
    const session = state.sessions.find((item) => item.stream_id === optimistic.stream_id);
    if (!session) continue;
    void dispatchHeldSend(optimisticId, session, optimistic.attachments).catch(() => {
      // An intervening transport cut leaves this never-confirmed row pending
      // for the next reconnect rather than manufacturing a delivery failure.
    });
  }
}

function applyRequestStreamEvents(
  events: PentacleEvent[],
  source: string,
  notify = true,
  currentTailOptions?: CurrentTailReducerOptions,
  currentTailOutcome?: CurrentTailApplyOutcome,
  finalizeState?: (next: PentacleStreamState) => PentacleStreamState,
) {
  const beforeEvents = selectPentacleDerivedEventIndex(state).chronological;
  const before = state;
  const currentTailSelection = source === 'chat.event' || !currentTailOptions
    ? undefined
    : selectCurrentTailEvents(
      before,
      events,
      currentTailOptions.requestedStreamId,
      currentTailOptions.ingressSource,
    );
  const acceptedEvents = currentTailSelection?.events ?? events;
  if (currentTailOutcome) {
    currentTailOutcome.acceptedEvents = acceptedEvents;
    currentTailOutcome.rejectedStreamIds = currentTailSelection?.rejectedStreamIds ?? [];
  }
  recordTranscriptResume(acceptedEvents, source);
  rememberEventSeqs(acceptedEvents);
  const beforeEventsCount = before.events.length;
  const touchedStreamIds = Array.from(new Set(acceptedEvents.map((event) => String(event.stream_id || '')).filter(Boolean)));
  const beforeOptimisticSignatures = touchedStreamIds.map((streamId) => [
    streamId,
    optimisticSignatureForState(before, streamId),
  ] as const);
  const startedAt = monotonicNowMs();
  for (const event of acceptedEvents) {
    logChatEventReceived(event, source);
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      eventFlowDiagnostics?.recordInbound(event);
    }
  }
  const reducedAt = monotonicNowMs();
  const reducedState = applyFetchedStreamEvents(
    before,
    acceptedEvents,
    source === 'chat.event'
      ? { mode: 'live' }
      : currentTailOptions
        ? { requestedStreamId: currentTailOptions.requestedStreamId, mode: 'fetch' }
        : undefined,
  );
  const reconciled = reconcileAcceptedUserEchoes(
    reducedState,
    acceptedEvents,
    source,
  );
  const reconciledState = source === 'chat.event'
    ? reconciled.next
    : {
      ...reconciled.next,
      sessions: reducedState.sessions,
      drafts: reducedState.drafts,
      workingByStream: reducedState.workingByStream,
    };
  const reducedMs = monotonicNowMs() - reducedAt;
  const outcomeStartedAt = monotonicNowMs();
  if (process.env.EXPO_PUBLIC_HARNESS === '1') {
    recordHarnessEventOutcome(
      acceptedEvents,
    );
  }
  const outcomeMs = monotonicNowMs() - outcomeStartedAt;
  const setStateStartedAt = monotonicNowMs();
  const finalizedState = finalizeState ? finalizeState(reconciledState) : reconciledState;
  const deferHarnessLiveEmit = source === 'chat.event' && notify && process.env.EXPO_PUBLIC_HARNESS === '1';
  const stateChanged = setState(finalizedState, deferHarnessLiveEmit ? false : notify);
  const appliedBurstIds = source === 'chat.event'
    ? rememberHarnessLiveApplied(acceptedEvents, finalizedState, before)
    : NO_HARNESS_APPLIED_BURST_IDENTITIES;
  if (deferHarnessLiveEmit && stateChanged) {
    if (source === 'chat.event') {
    queueHarnessLiveApplyTiming(setStateStartedAt, {
      source: 'chat.event.batch',
      applied_count: acceptedEvents.length,
      before_events_count: beforeEventsCount,
      after_events_count: reconciledState.events.length,
      duration_ms: Math.round((monotonicNowMs() - startedAt) * 10) / 10,
      reduce_ms: Math.round(reducedMs * 10) / 10,
      outcome_ms: Math.round(outcomeMs * 10) / 10,
      first_seq: eventSeq(acceptedEvents[0]) ?? null,
      last_seq: appliedBurstIds.length > 0
        ? appliedBurstIds[appliedBurstIds.length - 1][1]
        : eventSeq(acceptedEvents[acceptedEvents.length - 1]) ?? null,
      ...(appliedBurstIds.length > 0 ? { applied_burst_ids: appliedBurstIds } : {}),
    });
  }
    emit();
  }
  for (const [streamId, beforeSignature] of beforeOptimisticSignatures) {
    if (beforeSignature && !optimisticSignatureForState(reconciledState, streamId)) {
      postOptimisticDrainByStream.add(streamId);
    }
  }
  return stateChanged;
}

function scheduleDeferredStreamEventsDrain() {
  if (deferredStreamEventsTimer) return;
  deferredStreamEventsTimer = setTimeout(() => {
    deferredStreamEventsTimer = null;
    const batch = deferredStreamEventBatches.shift();
    if (batch) {
      applyRequestStreamEvents(batch.events, batch.source, true, batch.currentTailOptions);
    }
    if (deferredStreamEventBatches.length > 0) {
      scheduleDeferredStreamEventsDrain();
    }
  }, 16);
}

function deferRequestStreamEvents(
  events: PentacleEvent[],
  source: string,
  currentTailOptions?: CurrentTailReducerOptions,
) {
  if (!events.length) return;
  deferredStreamEventBatches.push({ events, source, currentTailOptions });
  scheduleDeferredStreamEventsDrain();
}

function currentTailReducerOptions(
  pending: PendingRequest | undefined,
  streamId: string,
  source: string,
): CurrentTailReducerOptions | undefined {
  if (
    !streamId ||
    (pending?.streamEventsPurpose !== 'freshness-guard' && pending?.streamEventsPurpose !== 'focused-refetch')
  ) return undefined;
  return {
    requestedStreamId: streamId,
    mode: 'current-tail',
    ingressSource: `${source}:${pending.streamEventsPurpose}`,
  };
}

function pendingStreamEventsToken(requestId: string, pending: PendingRequest): StreamEventsPendingToken | undefined {
  if (!pending.streamEventsStreamId || !pending.streamEventsPurpose || !pending.streamEventsWindow) return undefined;
  return {
    token: requestId,
    generation: pending.generation,
    socketMatches: pending.socket === ws,
    streamId: pending.streamEventsStreamId,
    purpose: pending.streamEventsPurpose,
    window: pending.streamEventsWindow,
    limit: pending.streamEventsLimit,
    before: pending.streamEventsBefore,
  };
}

function activeStreamEventsRequest(pending: StreamEventsPendingToken | undefined) {
  return pending
    ? state.eventBucketsByStream?.[pending.streamId]?.requestsByWindow?.[pending.window]
    : undefined;
}

function streamEventsCoverage(pending: StreamEventsPendingToken | undefined): EventBucketCoverage | undefined {
  return pending
    ? state.eventBucketsByStream?.[pending.streamId]?.coverageByWindow?.[pending.window]
    : undefined;
}

function applyStreamEventsFinalState(
  input: PentacleStreamState,
  pending: StreamEventsPendingToken,
  result: StreamEventsFinalizerResult,
) {
  const coverage = result.coverage
    ? { ...result.coverage, cursor: streamEventsResumeBeforeByStream.get(pending.streamId) ?? null }
    : undefined;
  const accessed = result.authoritativeAccepted
    ? mutatePentacleEventBuckets(input, {
      type: 'touch',
      streamId: pending.streamId,
      source: 'prefetch-complete',
    })
    : input;
  return mutatePentacleEventBuckets(accessed, {
    type: 'set-request-window',
    streamId: pending.streamId,
    window: pending.window,
    request: result.request,
    coverage,
    replaceCoverage: result.replaceCoverage,
  });
}

function finalizePendingStreamEventsFailure(
  requestId: string,
  pending: PendingRequest,
  kind: 'error' | 'timeout' | 'reconnect',
  notify = true,
) {
  const token = pendingStreamEventsToken(requestId, pending);
  const result = finalizeStreamEventsResponse({
    kind,
    pending: token,
    activeRequest: activeStreamEventsRequest(token),
    currentGeneration: currentSocketGeneration,
    existingCoverage: streamEventsCoverage(token),
    now: Date.now(),
    freshnessMs: PREFETCH_COVERAGE_FRESH_MS,
  });
  if (!result.matched || !token) return false;
  return setState(applyStreamEventsFinalState(state, token, result), notify);
}

// The batch "window" is open exactly while liveStreamEventsTimer is armed. While
// open, bulk (ASSIST/TOOL) rows accumulate and apply in one bulk update per flush;
// while closed, the next bulk row is a leading edge and applies immediately (see
// shouldApplyLiveEventImmediately). The window re-arms as long as a flood keeps
// filling the batch, so a sustained history/replay flood stays fully coalesced
// (only its leading edge applied immediately) — this holds even when each apply is
// slow (loaded machine), unlike a wall-clock-gap heuristic.
function applyLiveStreamBatch() {
  if (!liveStreamEventBatch.length) return;
  const events = liveStreamEventBatch;
  liveStreamEventBatch = [];
  applyRequestStreamEvents(events, 'chat.event');
}

function armLiveStreamBatchWindow() {
  if (liveStreamEventsTimer) return;
  const delayMs = focusedStreamId ? FOCUSED_LIVE_EVENT_BATCH_DELAY_MS : BACKGROUND_LIVE_EVENT_BATCH_DELAY_MS;
  liveStreamEventsTimer = setTimeout(onLiveStreamBatchWindowExpire, delayMs);
}

function onLiveStreamBatchWindowExpire() {
  liveStreamEventsTimer = null;
  const hadEvents = liveStreamEventBatch.length > 0;
  applyLiveStreamBatch();
  // Flood still filling the batch → keep the window open so the rest coalesces.
  // A quiet window (nothing queued) closes it — the next row leads a fresh edge.
  if (hadEvents) armLiveStreamBatchWindow();
}

// Explicit drain: apply any batched rows NOW and close the window. Used by the
// flush-on-immediate (before a USER/reconcile event) and flush-on-focus paths so
// batched lower-seq rows land in daemon_seq order before the immediate event.
function flushLiveStreamEventBatch() {
  if (liveStreamEventsTimer) {
    clearTimeout(liveStreamEventsTimer);
    liveStreamEventsTimer = null;
  }
  applyLiveStreamBatch();
}

// Harness-only applied-through-seq drain for the all_chats_freeze burst-phase
// barrier. `waitForDaemonSeq` resolving on "store contains an event >= N" is not
// the same as "N applied with every received live row drained": during the setup flood a lower-seq row
// on another stream can still sit in `liveStreamEventBatch` when seq N takes the
// immediate path (which drains only N's own stream). Releasing burst 1 then lets
// its frames coalesce with that setup straggler into one batch whose first_seq is
// a setup seq (< the burst's first), which the scenario's product-apply coverage
// excludes -> "burst 1 gap after sequence N". This force-drains the pending batch
// so the straggler is applied and the pipeline is idle before the burst releases;
// the returned {maxSeq, pending} lets the barrier resolve only when the applied
// high-water reaches N with nothing received-but-unapplied. Global sequence gaps
// are allowed and never imply loss. Only invoked under EXPO_PUBLIC_HARNESS.
export function __drainLiveApplyThroughForHarness(expectedDaemonSeq?: number): {
  maxSeq: number;
  pending: number;
  cohortAppliedCount?: number;
  cohortComplete?: boolean;
} {
  const cohort = ensureHarnessAllChatsCohort();
  const cohortComplete = Boolean(
    cohort && expectedDaemonSeq !== undefined &&
    expectedDaemonSeq <= cohort.eventCount &&
    harnessAllChatsVerifiedThrough >= expectedDaemonSeq,
  );
  if (
    expectedDaemonSeq === undefined ||
    cohortComplete ||
    harnessMaxAppliedLiveSeq >= expectedDaemonSeq ||
    harnessMaxReceivedLiveSeq >= expectedDaemonSeq
  ) {
    flushLiveStreamEventBatch();
  }
  const result: {
    maxSeq: number;
    pending: number;
    cohortAppliedCount?: number;
    cohortComplete?: boolean;
  } = { maxSeq: harnessMaxAppliedLiveSeq, pending: harnessPendingLiveCount };
  if (cohort) {
    result.cohortAppliedCount = harnessAllChatsAppliedIdentities?.size || 0;
    result.cohortComplete = Boolean(
      expectedDaemonSeq !== undefined &&
      expectedDaemonSeq <= cohort.eventCount &&
      harnessAllChatsVerifiedThrough >= expectedDaemonSeq,
    );
  }
  return result;
}

// An immediate correctness event only depends on lower-sequence rows from its
// own stream. Draining unrelated streams here makes a new background session
// wait behind a focused transcript flood even though its USER frame has already
// arrived. Preserve per-stream ordering without coupling independent streams.
function flushLiveStreamEventBatchForStream(streamId: string) {
  const matching: PentacleEvent[] = [];
  const remaining: PentacleEvent[] = [];
  for (const event of liveStreamEventBatch) {
    if (String(event.stream_id || '') === streamId) matching.push(event);
    else remaining.push(event);
  }
  if (!matching.length) return;
  liveStreamEventBatch = remaining;
  applyRequestStreamEvents(matching, 'chat.event');
}

function enqueueLiveStreamEvent(event: PentacleEvent) {
  const streamId = String(event.stream_id || '');
  const isFocusedStream = focusedStreamId === streamId;
  if (!isFocusedStream && deferredBackgroundLiveEventsByStream.has(streamId)) {
    deferredBackgroundLiveEventsByStream.set(streamId, [
      ...(deferredBackgroundLiveEventsByStream.get(streamId) || []),
      event,
    ]);
    return;
  }
  liveStreamEventBatch.push(event);
  const batchLimit = !isFocusedStream
    ? BACKGROUND_LIVE_EVENT_BATCH_LIMIT
    : postOptimisticDrainByStream.has(streamId)
      ? POST_OPTIMISTIC_LIVE_EVENT_BATCH_LIMIT
      : FOCUSED_LIVE_EVENT_BATCH_LIMIT;
  if (liveStreamEventBatch.length >= batchLimit) {
    // Start a fresh quiet window after the synchronous cap flush. Keeping the
    // old timer lets it expire immediately after a loaded apply and falsely
    // turns the next queued flood row into a new leading edge.
    if (liveStreamEventsTimer) {
      clearTimeout(liveStreamEventsTimer);
      liveStreamEventsTimer = null;
    }
    applyLiveStreamBatch();
    armLiveStreamBatchWindow();
    return;
  }
  if (isFocusedStream || !deferredBackgroundLiveEventsByStream.has(streamId)) {
    armLiveStreamBatchWindow();
  }
}

function optimisticSignatureForState(snapshot: PentacleStreamState, streamId: string) {
  const sends = snapshot.optimisticSends;
  if (!sends || !streamId) return '';
  return Object.values(sends)
    .filter((optimistic) => optimistic.stream_id === streamId && isReconcilableOptimisticStatus(optimistic.status))
    .map((optimistic) => optimistic.optimistic_id)
    .sort()
    .join('|');
}

function pendingOptimisticSignature(streamId: string) {
  return optimisticSignatureForState(state, streamId);
}

function isConsecutiveLiveBulkEvent(event: PentacleEvent) {
  const streamId = String(event.stream_id || '');
  const seq = eventSeq(event);
  if (!streamId || seq === undefined) return false;
  const previousSeq = lastLiveBatchSeqByStream.get(streamId);
  const previousKind = lastLiveBatchKindByStream.get(streamId);
  if (previousKind === 'USER' || lastLiveBatchGlobalKind === 'USER') return false;
  const interleavedStreamContinuation = previousSeq !== undefined &&
    seq > previousSeq &&
    lastLiveBatchGlobalSeq !== undefined &&
    seq < lastLiveBatchGlobalSeq;
  const globalContinuation = lastLiveBatchGlobalSeq !== undefined &&
    seq > lastLiveBatchGlobalSeq &&
    seq - lastLiveBatchGlobalSeq <= BACKGROUND_LIVE_EVENT_BATCH_LIMIT;
  return interleavedStreamContinuation || globalContinuation;
}

function rememberLiveBatchSeq(event: PentacleEvent) {
  const streamId = String(event.stream_id || '');
  const seq = eventSeq(event);
  if (!streamId || seq === undefined) return;
  const previousSeq = lastLiveBatchSeqByStream.get(streamId);
  if (previousSeq === undefined || seq > previousSeq) {
    lastLiveBatchSeqByStream.set(streamId, seq);
    lastLiveBatchKindByStream.set(streamId, String(event.kind || '').toUpperCase());
  }
  if (lastLiveBatchGlobalSeq === undefined || seq > lastLiveBatchGlobalSeq) {
    lastLiveBatchGlobalSeq = seq;
    lastLiveBatchGlobalKind = String(event.kind || '').toUpperCase();
  }
}

function rememberHarnessLiveReceived(event: PentacleEvent) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
  const seq = eventSeq(event);
  if (seq === undefined) return;
  rememberHarnessAllChatsAdmission(event);
  harnessPendingLiveSeqCounts.set(seq, (harnessPendingLiveSeqCounts.get(seq) || 0) + 1);
  harnessPendingLiveCount += 1;
  harnessMaxReceivedLiveSeq = Math.max(harnessMaxReceivedLiveSeq, seq);
}

function rememberHarnessLiveApplied(
  events: PentacleEvent[],
  appliedState: PentacleStreamState = state,
  previousState?: PentacleStreamState,
): HarnessAppliedBurstIdentity[] {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return NO_HARNESS_APPLIED_BURST_IDENTITIES;
  const cohort = ensureHarnessAllChatsCohort();
  const appliedBurstIdentities = cohort
    ? [] as HarnessAppliedBurstIdentity[]
    : NO_HARNESS_APPLIED_BURST_IDENTITIES;
  for (const event of events) {
    const seq = eventSeq(event);
    if (seq === undefined) continue;
    const pendingForSeq = harnessPendingLiveSeqCounts.get(seq) || 0;
    if (pendingForSeq > 1) harnessPendingLiveSeqCounts.set(seq, pendingForSeq - 1);
    else if (pendingForSeq === 1) harnessPendingLiveSeqCounts.delete(seq);
    if (pendingForSeq > 0) harnessPendingLiveCount -= 1;
    harnessMaxAppliedLiveSeq = Math.max(harnessMaxAppliedLiveSeq, seq);
    const streamId = String(event.stream_id || '');
    const admissionBinding = harnessAllChatsAdmissionBindingByEvent?.get(event);
    harnessAllChatsAdmissionBindingByEvent?.delete(event);
    if (
      !cohort || admissionBinding !== cohort.bindingKey ||
      seq < 1 || seq > cohort.eventCount ||
      streamId !== harnessAllChatsExpectedStreamId(cohort, seq)
    ) continue;
    const identityKey = harnessAllChatsIdentityKey(streamId, seq);
    if (
      harnessAllChatsAppliedIdentities?.has(identityKey) ||
      (previousState && stateContainsHarnessIdentity(previousState, streamId, seq)) ||
      !stateContainsHarnessIdentity(appliedState, streamId, seq)
    ) continue;
    harnessAllChatsAppliedIdentities?.add(identityKey);
    if (seq > cohort.setupEventCount) appliedBurstIdentities.push([streamId, seq]);
    while (harnessAllChatsVerifiedThrough < cohort.eventCount) {
      const nextSeq = harnessAllChatsVerifiedThrough + 1;
      const nextStreamId = harnessAllChatsExpectedStreamId(cohort, nextSeq);
      if (!harnessAllChatsAppliedIdentities?.has(harnessAllChatsIdentityKey(nextStreamId, nextSeq))) break;
      harnessAllChatsVerifiedThrough = nextSeq;
    }
  }
  return appliedBurstIdentities;
}

function shouldApplyLiveEventImmediately(event: PentacleEvent) {
  const kind = String(event.kind || '').toUpperCase();
  const streamId = String(event.stream_id || '');
  liveImmediateApplyReason = '';
  if (kind === 'DRAFT' || kind === 'WORKING') {
    if (focusedStreamId !== streamId) return false;
    postOptimisticDrainByStream.delete(streamId);
    liveImmediateApplyReason = `kind:${kind}`;
    return true;
  }
  if (kind === 'USER') {
    postOptimisticDrainByStream.delete(streamId);
    liveImmediateApplyReason = 'kind:USER';
    return true;
  }
  const seq = eventSeq(event);
  const priorLiveSeq = lastLiveBatchSeqByStream.get(streamId);
  const priorKnownSeq = Math.max(
    priorLiveSeq ?? Number.NEGATIVE_INFINITY,
    lastEventSeqByStream.get(streamId) ?? Number.NEGATIVE_INFINITY,
  );
  const pendingSignature = pendingOptimisticSignature(streamId);
  if (isSystemEndOfTurnEvent(event)) {
    if (pendingSignature) return false;
    if (seq !== undefined && seq > priorKnownSeq) {
      liveImmediateApplyReason = 'system:end-of-turn';
      return true;
    }
    return false;
  }
  // Correctness events apply+flush promptly. USER echoes already returned above
  // and reconcile through applyServerUserEventWithReconciliation; non-USER rows
  // only need the first-event-after-send prompt below, not one immediate apply
  // per ASSIST frame while the optimistic send remains pending.
  if (!pendingSignature) {
    promptedPendingOptimisticSignatureByStream.delete(streamId);
  } else if (promptedPendingOptimisticSignatureByStream.get(streamId) !== pendingSignature) {
    promptedPendingOptimisticSignatureByStream.set(streamId, pendingSignature);
    liveImmediateApplyReason = 'pending-optimistic-first-event';
    return true;
  }
  // Bulk (ASSIST/TOOL) rows: leading edge when no burst is known, then coalesce
  // consecutive daemon_seq frames even if the JS timer expired while the client
  // was busy applying the prior frame. Timer-only burst detection regressed the
  // composite fixture because client backpressure made every frame look like a
  // fresh leading edge; the sequence cursor keeps flood apply O(batch) instead of
  // O(frame).
  // L4's flush-on-immediate + flush-on-focus still drain the batch in daemon_seq
  // order before any USER/reconcile event and on chat open — no lower-seq rows drop.
  if (isConsecutiveLiveBulkEvent(event)) return false;
  if (focusedStreamId !== streamId && deferredBackgroundLiveEventsByStream.has(streamId)) return false;
  liveImmediateApplyReason = liveStreamEventsTimer === null ? 'timer-window-closed' : '';
  return liveStreamEventsTimer === null;
}

function isAmbiguousSendTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Pentacle stream (?:disconnected|is not connected)|Pentacle command timed out/.test(message);
}

function emitRetryTelemetry(
  context: RetryTelemetryContext,
  responseClass: string,
  uiOutcome: string,
  extra: Record<string, unknown> = {},
) {
  // Identity and outcome fields are intentionally bounded to generated ids and
  // daemon response classes. Never add message text, attachment data, or auth
  // material to this event.
  logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RETRY, {
    stream_id: context.streamId,
    optimistic_id: context.currentOptimisticId,
    prior_optimistic_id: context.priorOptimisticId,
    new_optimistic_id: context.currentOptimisticId,
    prior_request_id: context.priorRequestId,
    request_id: context.currentRequestId,
    new_request_id: context.currentRequestId,
    response_class: responseClass,
    ui_outcome: uiOutcome,
    ...extra,
  });
}

function sendRejectionDetails(message: Record<string, unknown>) {
  const detail = message.error && typeof message.error === 'object'
    ? message.error as Record<string, unknown>
    : undefined;
  const scalarError = typeof message.error === 'string' ? message.error : undefined;
  const errorCode = String(
    detail?.code ||
    message.error_code ||
    message.reason ||
    message.delivery ||
    message.state ||
    scalarError ||
    'send_failed',
  );
  const errorMessage = String(
    detail?.message ||
    scalarError ||
    message.reason ||
    message.error_code ||
    message.delivery ||
    message.state ||
    errorCode,
  );
  return { errorCode, errorMessage };
}

function handleExplicitSendRejection(
  requestIdValue: string,
  responseClass: SendResponseClass,
  message: Record<string, unknown>,
) {
  const pending = pendingRequests.get(requestIdValue);
  if (!pending) return false;
  const { errorCode, errorMessage } = sendRejectionDetails(message);

  if (errorCode === 'optimistic_id_conflict' && pending.retryOnOptimisticIdConflict) {
    const priorOptimisticId = pending.optimisticId || state.optimisticByRequestId?.[requestIdValue];
    const prior = priorOptimisticId ? state.optimisticSends?.[priorOptimisticId] : undefined;
    const session = prior
      ? state.sessions.find((item) => item.stream_id === prior.stream_id)
      : undefined;
    if (priorOptimisticId && prior && session) {
      const replacementOptimisticId = nextOptimisticId(prior.stream_id);
      const nextRequestId = requestId('send');
      const nextState = rekeyOptimisticSend(
        state,
        priorOptimisticId,
        replacementOptimisticId,
        nextRequestId,
      );
      const answerIdentity = optimisticQuestionAnswers.get(priorOptimisticId);
      if (answerIdentity) {
        optimisticQuestionAnswers.delete(priorOptimisticId);
        optimisticQuestionAnswers.set(replacementOptimisticId, answerIdentity);
      }
      const settled = settlePendingRequest(requestIdValue);
      if (!settled) return false;
      queuedOptimisticDispatchRequests.delete(priorOptimisticId);
      setState(nextState);
      const retryTelemetry: RetryTelemetryContext = {
        streamId: prior.stream_id,
        priorOptimisticId: pending.retryTelemetry?.priorOptimisticId || priorOptimisticId,
        priorRequestId: pending.retryTelemetry?.priorRequestId || prior.request_id,
        currentOptimisticId: replacementOptimisticId,
        currentRequestId: nextRequestId,
      };
      emitRetryTelemetry(retryTelemetry, errorCode, 'rekeyed', {
        error_code: errorCode,
      });
      const replacement = dispatchHeldSend(
        replacementOptimisticId,
        session,
        prior.attachments,
        { retryOnOptimisticIdConflict: false, retryTelemetry },
      );
      replacement.then(settled.resolve, settled.reject);
      return true;
    }
  }

  setState(markOptimisticFailedByRequestId(state, requestIdValue, errorCode));
  const settled = settlePendingRequest(requestIdValue);
  if (pending.retryTelemetry) {
    emitRetryTelemetry(pending.retryTelemetry, responseClass, 'error_surface', {
      error_code: errorCode,
    });
  }
  settled?.reject(new ExplicitSendRejectionError(responseClass, errorCode, errorMessage));
  return true;
}

const SPAWN_RPC_DIAGNOSTIC_RESPONSE_TYPES = new Set([
  'spawn_catalog_get.ok',
  'spawn_catalog_get.error',
  'spawn.ok',
  'spawn.error',
  'spawn.indeterminate',
]);
const SPAWN_RPC_DIAGNOSTIC_CADENCE_TYPES = new Set([
  'chat.event',
  'pong',
  'session.inventory',
  'snapshot',
  ...SPAWN_RPC_DIAGNOSTIC_RESPONSE_TYPES,
]);

function websocketDataCategory(data: unknown): 'empty' | 'string' | 'arraybuffer' | 'blob' | 'other' {
  if (data === null || data === undefined) return 'empty';
  if (typeof data === 'string') return 'string';
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return 'arraybuffer';
  if (typeof Blob !== 'undefined' && data instanceof Blob) return 'blob';
  return 'other';
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function safeInboundFrameType(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const frameType = (message as Record<string, unknown>).type;
  return typeof frameType === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(frameType)
    ? frameType
    : null;
}

function emitHarnessWsOnMessageBoundary(data: Record<string, unknown>) {
  emitHarnessUiTrace('ws_onmessage_boundary', data);
}
let spawnRpcDiagnosticWindowUntil = 0;

function emitHarnessSpawnRpcInboundCadence(message: Record<string, unknown>) {
  const frameType = String(message.type || '');
  if (
    Date.now() > spawnRpcDiagnosticWindowUntil ||
    !SPAWN_RPC_DIAGNOSTIC_CADENCE_TYPES.has(frameType)
  ) return;
  emitHarnessUiTrace('spawn_rpc_inbound_cadence', {
    stage: 'inbound-cadence',
    response_type: frameType,
    request_prefix: null,
    schema: null,
    request_id: SPAWN_RPC_DIAGNOSTIC_RESPONSE_TYPES.has(frameType) && typeof message.request_id === 'string'
      ? message.request_id
      : null,
    socket_generation: currentSocketGeneration,
  });
}

function emitHarnessSpawnRpcResponseMetadata(
  stage: 'inbound-response' | 'settled',
  message: Record<string, unknown>,
  matchedPending?: PendingRequest,
) {
  const responseType = String(message.type || '');
  if (!SPAWN_RPC_DIAGNOSTIC_RESPONSE_TYPES.has(responseType)) return;
  const requestId = typeof message.request_id === 'string' ? message.request_id : null;
  const pending = matchedPending || (requestId ? pendingRequests.get(requestId) : undefined);
  emitHarnessUiTrace('spawn_rpc_response_metadata', {
    stage,
    response_type: responseType,
    request_prefix: pending?.requestPrefix ?? null,
    schema: null,
    request_id: requestId,
    socket_generation: currentSocketGeneration,
    pending_generation: pending?.generation ?? null,
    pending_match: Boolean(pending),
    settled: stage === 'settled',
  });
}

function handleMessage(raw: string) {
  return runCoalescedEmit(() => handleMessageInner(raw));
}

function handleMessageInner(raw: string) {
  let message: any;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.isArmed()) {
      emitHarnessWsOnMessageBoundary({
        stage: 'json-parse',
        parse_category: error instanceof SyntaxError ? 'syntax-error' : 'unknown-error',
        frame_type: null,
        current_generation: currentSocketGeneration,
      });
    }
    return;
  }

  if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.isArmed()) {
    emitHarnessWsOnMessageBoundary({
      stage: 'json-parse',
      parse_category: 'success',
      frame_type: safeInboundFrameType(message),
      current_generation: currentSocketGeneration,
    });
  }

  emitHarnessSpawnRpcInboundCadence(message);
  emitHarnessSpawnRpcResponseMetadata('inbound-response', message);

  if (message.type === 'specs.capabilities.ok') {
    if (Array.isArray(message.statuses)) {
      updateState({
        specStatuses: message.statuses.flatMap((status: unknown): PentacleSpecStatusCapability[] => {
          if (!status || typeof status !== 'object') return [];
          const capability = status as PentacleSpecStatusCapability;
          const name = String(capability.name || '').trim();
          if (!name) return [];
          const color = String(capability.color || '').trim();
          return [{
            ...capability,
            name,
            ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { color } : { color: undefined }),
          }];
        }),
      });
    }
    return;
  }

  if (message.type === 'specs.capabilities.error') return;

  if (typeof message.type === 'string' && message.type.startsWith('asset.')) {
    assetFrameListeners.forEach((listener) => listener(message));
    if (typeof message.request_id === 'string') {
      const pending = pendingRequests.get(message.request_id);
      if (pending) {
        settlePendingRequest(message.request_id);
        if (message.type === 'asset.error' || message.type.endsWith('.error')) {
          pending.reject(new Error(String(message.error || message.error_code || 'asset command failed')));
        } else if (message.type.endsWith('.ok')) {
          pending.resolve(message);
        }
      }
    }
    return;
  }

  if ((message.type === 'thread.read.ok' || message.type === 'thread.error') && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending?.requestPrefix === 'thread-read') {
      const result = decodeThreadRead(message);
      settlePendingRequest(message.request_id);
      if (!result) {
        pending.reject(new Error('Thread history response malformed'));
      } else if (!result.ok) {
        pending.reject(new Error(result.message));
      } else {
        pending.resolve(result);
      }
      return;
    }
  }

  if (message.type === 'snapshot') {
    const sessions = Array.isArray(message.sessions)
      ? (message.sessions as PentacleSessionSummary[])
      : undefined;
    const events = Array.isArray(message.events)
      ? (message.events as PentacleEvent[])
      : undefined;
    const snapshotEvents = process.env.EXPO_PUBLIC_HARNESS === '1' && events?.length
      ? [...state.events, ...events]
      : events;
    for (const event of events || []) {
      logChatEventReceived(event, 'snapshot');
      if (process.env.EXPO_PUBLIC_HARNESS === '1') {
        eventFlowDiagnostics?.recordInbound(event);
      }
    }
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      for (const session of sessions || []) {
        recordHarnessSummaryInbound(session.stream_id, session.last_text);
      }
    }
    recordTranscriptResume(events || [], 'snapshot');
    rememberEventSeqs(events || []);
    const drafts = { ...((message.drafts as Record<string, PentacleEvent> | undefined) || {}) };
    const beforeEvents = selectPentacleDerivedEventIndex(state).chronological;
    const beforeOptimistics = state.optimisticSends ?? {};
    const snapshotState = applySnapshotWithOptimisticReconciliation(state, {
      events: snapshotEvents,
      drafts,
      hosts: message.hosts as Record<string, PentacleHostStatus> | undefined,
      sessions,
      limits: message.limits,
      limits_health: message.limits_health,
      updates: message.updates as PentacleUpdateMessage[] | undefined,
      notifications: message.notifications as PentacleNotification[] | undefined,
      working_states: message.working_states as Record<string, WorkingStateData> | undefined,
    });
    const reconciledSnapshot = reconcileAcceptedUserEchoes(
      snapshotState,
      events || [],
      'snapshot',
    );
    const nextState = {
      ...reconciledSnapshot.next,
      sessions: snapshotState.sessions,
      drafts: snapshotState.drafts,
      workingByStream: snapshotState.workingByStream,
    };
    for (const [optimisticId, optimistic] of Object.entries(beforeOptimistics)) {
      const matched = (events || []).find((event) =>
        optimisticMatchesServerUser(optimistic, event, OPTIMISTIC_RECONCILE_WINDOW_MS),
      );
      if (
        matched &&
        (
          !nextState.optimisticSends?.[optimisticId] ||
          nextState.optimisticSends?.[optimisticId]?.status === 'returned_to_prompt'
        )
      ) {
        logOptimisticReconciled(optimisticId, matched, optimistic.created_at);
        // Resolve any pending `send` RPC awaiting this optimistic's request_id
        // (see applyServerUserEventWithReconciliation for rationale).
        if (optimistic.request_id) {
          const pending = pendingRequests.get(optimistic.request_id);
          if (pending?.retryTelemetry) {
            emitRetryTelemetry(pending.retryTelemetry, 'snapshot', 'sent');
          }
          const settled = settlePendingRequest(optimistic.request_id);
          settled?.resolve(true);
        }
      }
    }
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      recordHarnessEventOutcome(
        events || [],
      );
    }
    setState(nextState);
    void reconcilePendingSessionCloses(sessions || [], currentSocketGeneration);
    return;
  }

  if (message.type === 'limits.update') {
    setState(applyPentacleLimits(state, message.limits));
    return;
  }

  if (message.type === 'auth.error') {
    updateState({
      connected: false,
      connecting: false,
      lastError: String(message.error || 'Pentacle authentication failed'),
    });
    return;
  }

  if (message.type === 'chat.event' && message.event) {
    const event = message.event as PentacleEvent;
    rememberHarnessLiveReceived(event);
    if (!shouldApplyLiveEventImmediately(event)) {
      rememberLiveBatchSeq(event);
      enqueueLiveStreamEvent(event);
      return;
    }
    const streamId = String(event.stream_id || '');
    const isNewLiveSession = String(event.kind || '').toUpperCase() === 'USER' &&
      !state.sessions.some((session) => session.stream_id === streamId);
    const receivedAt = monotonicNowMs();
    if (isNewLiveSession) {
      emitHarnessUiTrace('live_new_session_event_received', {
        stream_id: streamId,
        seq: eventSeq(event) ?? null,
        queued_same_stream_count: liveStreamEventBatch.filter((item) => item.stream_id === streamId).length,
        queued_other_stream_count: liveStreamEventBatch.filter((item) => item.stream_id !== streamId).length,
      });
    }
    // Drain lower-sequence rows from THIS stream before its immediate event.
    // A global drain would couple an unrelated new-session USER frame to a
    // focused transcript flood and delay its session-list surface by seconds.
    flushLiveStreamEventBatchForStream(streamId);
    logChatEventReceived(event, 'chat.event');
    if (process.env.EXPO_PUBLIC_HARNESS === '1') eventFlowDiagnostics?.recordInbound(event);
    const beforeEvents = selectPentacleDerivedEventIndex(state).chronological;
    const nextState = String(event.kind || '').toUpperCase() === 'USER' && event.client_origin !== true
      ? applyServerUserEventWithReconciliation(event)
      : applyEvent(event);
    if (isNewLiveSession) {
      emitHarnessUiTrace('live_new_session_event_applied', {
        stream_id: streamId,
        seq: eventSeq(event) ?? null,
        surfaced: state.sessions.some((session) => session.stream_id === streamId),
        receipt_to_applied_ms: Math.round((monotonicNowMs() - receivedAt) * 10) / 10,
      });
    }
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      recordHarnessEventOutcome(
        [event],
      );
    }
    rememberLiveBatchSeq(event);
    // Open the batch window so a burst that follows this leading-edge row (a
    // history/replay flood) coalesces instead of applying row-by-row.
    armLiveStreamBatchWindow();
    return;
  }

  if (message.type === 'working.state') {
    setState(applyPentacleWorkingState(state, message as WorkingStateData));
    return;
  }

  if (message.type === 'host.status' && message.host) {
    setState(applyPentacleHostStatus(state, message.host as PentacleHostStatus));
    return;
  }

  // Daemon-owned machine stats: one `hosts.stats` frame, delivered both in the
  // hello replay and as a live broadcast, is the single ingestion path. It is a
  // complete replacement of the fleet map (hosts absent from it are removed).
  if (message.type === 'hosts.stats' && message.hosts && typeof message.hosts === 'object') {
    if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.isArmed()) {
      for (const [host, stats] of Object.entries(message.hosts)) {
        emitHarnessUiTrace('hosts_stats_received', { host, stats });
      }
    }
    setState(applyPentacleHostsStats(state, message.hosts as Record<string, unknown>));
    return;
  }

  if (message.type === 'session.inventory' && Array.isArray(message.sessions)) {
    const sessions = message.sessions as PentacleSessionSummary[];
    setState(applyPentacleSessionInventory(
      state,
      sessions,
    ));
    void reconcilePendingSessionCloses(sessions, currentSocketGeneration);
    return;
  }

  if (message.type === 'updates') {
    setState(applyPentacleUpdates(state, message.updates as PentacleUpdateMessage[] | undefined));
    return;
  }

  // Live notification broadcast: upsert the record into the slice so the
  // Updates screen reflects new/changed notifications without a refetch.
  if (message.type === 'notification' && message.notification) {
    const record = message.notification as PentacleNotification;
    setState(applyNotificationFrame(state, record));
    // Always-on domain telemetry — fires on create AND resolve broadcasts.
    // The L3 harness asserts the live-broadcast path off this event.
    logTelemetry(TELEMETRY_EVENTS.NOTIFICATION_FRAME_APPLIED, {
      notification_id: record.notification_id,
      state: record.state,
      producer: record.producer,
    });
    return;
  }

  if (message.type === 'upload_blob.init.ok' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve(true);
    }
    return;
  }

  if (message.type === 'upload_blob.ok' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve({
        blob_sha: String(message.blob_sha || ''),
        size_bytes: typeof message.size_bytes === 'number' ? message.size_bytes : undefined,
      });
    }
    return;
  }

  if (message.type === 'upload_blob.error' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.reject(new Error(String(message.error || message.error_code || 'blob upload failed')));
    }
    return;
  }

  if (message.type === 'fetch_blob.chunk' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending && typeof message.content_b64 === 'string') {
      const chunks = pendingFetchBlobChunks.get(message.request_id) ?? [];
      chunks.push(message.content_b64);
      pendingFetchBlobChunks.set(message.request_id, chunks);
    }
    return;
  }

  if (message.type === 'fetch_blob.ok' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      const chunks = pendingFetchBlobChunks.get(message.request_id) ?? [];
      if (typeof message.content_b64 === 'string') chunks.push(message.content_b64);
      const content_b64 = chunks.join('');
      settlePendingRequest(message.request_id);
      pending.resolve({
        blob_sha: String(message.blob_sha || ''),
        size_bytes: typeof message.size_bytes === 'number' ? message.size_bytes : undefined,
        content_b64,
      });
    }
    return;
  }

  if (message.type === 'fetch_blob.error' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.reject(new Error(String(message.error || message.error_code || 'blob fetch failed')));
    }
    return;
  }

  if (message.type === 'notification.list.ok' && typeof message.request_id === 'string') {
    const notifications = Array.isArray(message.notifications)
      ? (message.notifications as PentacleNotification[])
      : [];
    const pending = pendingRequests.get(message.request_id);
    setState(pending?.requestPrefix === 'notification-lookup'
      ? notifications.reduce((next, record) => applyNotificationFrame(next, record), state)
      : applyNotificationList(state, notifications));
    logTelemetry(TELEMETRY_EVENTS.NOTIFICATION_LIST_SETTLED, { count: notifications.length });
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve(notifications);
    }
    return;
  }

  if (message.type === 'notification.resolve.ok' && typeof message.request_id === 'string') {
    if (message.notification) {
      const record = message.notification as PentacleNotification;
      setState(applyNotificationFrame(state, record));
      logTelemetry(TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_SETTLED, {
        notification_id: record.notification_id,
        state: record.state,
        action_kind: record.resolution?.action_kind,
      });
    }
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve(message.notification || true);
    }
    return;
  }

  if ((message.type === 'prompt.answer.ok' || message.type === 'prompt.answer.error') && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending?.requestPrefix === 'prompt-answer') {
      settlePendingRequest(message.request_id);
      if (message.type === 'prompt.answer.ok') pending.resolve(true);
      else pending.reject(new Error(String(message.error || message.error_code || 'Prompt answer failed')));
    }
    return;
  }

  // The daemon emits a single generic `notification.error` frame for every
  // notification.* command failure (mirroring `_schedule_error`), carrying the
  // request_id + an error_code/error — NOT per-verb `notification.<verb>.error`
  // frames. Reject the matching pending request on it.
  if (message.type === 'notification.error' && typeof message.request_id === 'string') {
    // Error-shape domain event (on the scenario deny list). Diagnostic only —
    // carries the daemon's error_code, no ok:true/false confirm field.
    logTelemetry(TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_FAILED, {
      error_code: message.error_code,
    });
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.reject(
        new Error(String(message.error || message.error_code || 'notification command failed')),
      );
    }
    return;
  }

  if (message.type === 'send.result' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    const receiptState = String(message.state || '');
    if (message.delivery === 'landed' || receiptState === 'landed') {
      if (pending) {
        const optimisticId = state.optimisticByRequestId?.[message.request_id];
        const optimistic = optimisticId ? state.optimisticSends?.[optimisticId] : undefined;
        const responseReason = String(message.reason || '');
        if (pending.retryTelemetry) {
          emitRetryTelemetry(pending.retryTelemetry, 'send.result', 'sent', {
            delivery: 'landed',
            ...(responseReason ? { response_reason: responseReason } : {}),
          });
        }
        setState(markOptimisticAckedByRequestId(state, message.request_id, Date.now()));
        if (optimisticId && optimistic && optimistic.status !== 'acked') {
          logOptimisticReconciled(optimisticId, undefined, optimistic.created_at, optimistic.stream_id);
        }
        scheduleOptimisticReconcileCatchUp(message.request_id);
        const settled = settlePendingRequest(message.request_id);
        settled?.resolve(true);
      }
    } else if (message.delivery === 'proof_unavailable' || receiptState === 'accepted') {
      setState(markOptimisticIndeterminateByRequestId(state, message.request_id, Date.now()));
      const settled = settlePendingRequest(message.request_id);
      settled?.resolve(true);
      queueSendReceiptQuery(message.request_id);
    } else {
      if (pending) {
        handleExplicitSendRejection(message.request_id, 'send.result', message);
      }
    }
    return;
  }

  if (message.type === 'send.receipt.get.ok') {
    const lookup = receiptQueryInFlight;
    receiptQueryInFlight = null;
    const receipts = Array.isArray(message.receipts) ? message.receipts : [];
    if (lookup && message.found === true && receipts.length === 1 && receipts[0] && typeof receipts[0] === 'object') {
      applyDurableSendReceipt(receipts[0] as Record<string, unknown>, lookup);
    }
    drainReceiptQueryQueue();
    return;
  }

  if (message.type === 'send.receipt.get.error') {
    receiptQueryInFlight = null;
    drainReceiptQueryQueue();
    return;
  }

  if (message.type === 'spawn_catalog_get.ok' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      emitHarnessSpawnRpcResponseMetadata('settled', message, pending);
      try {
        pending.resolve(validateSpawnCatalog(message));
      } catch (error) {
        pending.reject(error);
      }
    }
    return;
  }

  if (message.type === 'spawn_catalog_get.error' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      emitHarnessSpawnRpcResponseMetadata('settled', message, pending);
      pending.reject(new Error(String(message.error?.message || message.error || 'Spawn catalog unavailable')));
    }
    return;
  }

  if (
    (message.type === 'send.ok' || message.type === 'spawn.ok' || message.type === 'rename.ok' || message.type === 'close.ok' || message.type === 'close.degraded' || message.type === 'close.already_closed' || message.type === 'close.deferred' || message.type === 'register_push.ok') &&
    typeof message.request_id === 'string'
  ) {
    const pending = pendingRequests.get(message.request_id);
      if (pending) {
        if (message.type === 'send.ok') {
          const optimisticId = state.optimisticByRequestId?.[message.request_id];
          const optimistic = optimisticId ? state.optimisticSends?.[optimisticId] : undefined;
          setState(markOptimisticAckedByRequestId(state, message.request_id, Date.now()));
          if (optimisticId && optimistic && optimistic.status !== 'acked') {
            logOptimisticReconciled(optimisticId, undefined, optimistic.created_at, optimistic.stream_id);
          }
          scheduleOptimisticReconcileCatchUp(message.request_id);
        }
      if (message.type === 'spawn.ok' && message.session) {
        setState(applyPentacleSessionSummary(state, message.session as PentacleSessionSummary));
        logTelemetry(TELEMETRY_EVENTS.CHAT_SESSION_SPAWN_SUMMARY_APPLIED, {
          stream_id: String((message.session as PentacleSessionSummary).stream_id || ''),
          provider: String((message.session as PentacleSessionSummary).provider || ''),
          host: String((message.session as PentacleSessionSummary).host || ''),
        });
      } else if (message.type === 'rename.ok' && message.session) {
        setState(applyPentacleSessionSummary(state, message.session as PentacleSessionSummary));
      }
      settlePendingRequest(message.request_id);
      emitHarnessSpawnRpcResponseMetadata('settled', message, pending);
      pending.resolve(
        message.type === 'spawn.ok' && pending.requestPrefix === 'spawn.v2'
          ? {
            session: message.session,
            requested: message.session?.requested_launch_tuple ?? message.requested,
            resolved: message.session?.resolved_launch_tuple ?? message.resolved,
            actual_launch: message.session?.actual_launch_tuple ?? message.actual_launch,
            resolution_source: message.session?.resolution_source ?? message.resolution_source,
            catalog_version: message.session?.catalog_version ?? message.catalog_version,
          }
          : (message.type === 'close.ok' || message.type === 'close.degraded' || message.type === 'close.already_closed' || message.type === 'close.deferred')
            // Mirror the desktop rule: .ok/.already_closed settle as success; .deferred settles
            // as deferred (the pending-close queue waits for authoritative inventory removal).
            ? {
              closed: message.type === 'close.deferred' ? false : message.deferred !== true,
              deferred: message.type === 'close.deferred' ? true : message.deferred === true,
              queued: false,
              intentId: typeof message.intent_id === 'string' ? message.intent_id : undefined,
              sessionGeneration: typeof message.session_generation === 'string' ? message.session_generation : undefined,
            } satisfies CloseSessionResult
            : (message.session || true),
      );
    }
    return;
  }

  if (message.type === 'question.dismiss.ok' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve({
        dismissed: message.dismissed !== false,
        textSubmitted: !!message.text_submitted,
      });
    }
    return;
  }

  if (message.type === 'send.interrupt.ok' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve(normalizeInterruptResult(message));
    }
    return;
  }

  if (message.type === 'send.interrupt.error' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.reject(new Error(String(message.error || 'send.interrupt failed')));
    }
    return;
  }

  if (message.type === 'send.indeterminate' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    setState(markOptimisticIndeterminateByRequestId(state, message.request_id, Date.now()));
    if (pending) {
      settlePendingRequest(message.request_id);
      pending.resolve(true);
    }
    return;
  }

  // A spawn carrying an idempotency_key can come back indeterminate: v2 answers an in-flight
  // duplicate of the same key this way, having committed the action while its confirmation is
  // still pending. Settle the request rather than leaving it to time out, and mark it ambiguous so
  // the caller replays the SAME key — by then the winner is terminal, and the replay hands back its
  // `spawn.ok`. The frame says `do_not_respawn` for exactly this reason.
  // public behavior contract.
  if (message.type === 'spawn.indeterminate' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      emitHarnessSpawnRpcResponseMetadata('settled', message, pending);
      pending.reject(new SpawnSessionError(
        'spawn_indeterminate',
        'The agent may still be starting. Reopen the chat list before trying again.',
        typeof message.reconcile === 'string' ? message.reconcile : undefined,
      ));
    }
    return;
  }

  if (
    (message.type === 'send.error' || message.type === 'spawn.error' || message.type === 'rename.error' || message.type === 'close.error' || message.type === 'close.failed' || message.type === 'register_push.error') &&
    typeof message.request_id === 'string'
  ) {
    if (message.type === 'send.error') {
      handleExplicitSendRejection(message.request_id, 'send.error', message);
      return;
    }
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      if (message.type === 'spawn.error') {
        emitHarnessSpawnRpcResponseMetadata('settled', message, pending);
      }
      if (message.type === 'spawn.error' && pending.requestPrefix === 'spawn.v2') {
        const detail = message.error && typeof message.error === 'object' ? message.error : message;
        pending.reject(new SpawnSessionError(
          String(detail.code || message.error_code || 'spawn_failed'),
          String(detail.message || message.error || 'Failed to start session'),
          typeof detail.remediation === 'string' ? detail.remediation : undefined,
          detail.supported_choices,
        ));
      } else {
        pending.reject(message.type === 'close.error'
          ? closeSessionErrorFromMessage(message)
          : message.type === 'close.failed'
            ? closeFailedErrorFromMessage(message)
            : new Error(String(message.error || 'Command failed')));
      }
    }
    return;
  }

  if ((message.type === 'close.cancel.ok' || message.type === 'close.cancel.error') && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      if (message.type === 'close.cancel.ok') {
        pending.resolve(true);
      } else {
        pending.reject(new CloseSessionError(
          String(message.error_code || 'close_cancel_failed'),
          String(message.error || message.error_code || 'Cancel delete failed'),
        ));
      }
    }
    return;
  }

  if (message.type === 'question.dismiss.error' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      settlePendingRequest(message.request_id);
      const errorCode = String(message.error_code || 'question_dismiss_failed');
      pending.reject(new DismissQuestionError(
        errorCode,
        String(message.error || errorCode || 'Question dismiss failed'),
      ));
    }
    return;
  }

  if (message.type === 'request_stream_events.chunk' && typeof message.request_id === 'string') {
    const events = Array.isArray(message.events) ? (message.events as PentacleEvent[]) : [];
    const pending = pendingRequests.get(message.request_id);
    if (!pending) return;
    const token = pendingStreamEventsToken(message.request_id, pending);
    const result = finalizeStreamEventsResponse({
      kind: 'chunk',
      pending: token,
      activeRequest: activeStreamEventsRequest(token),
      currentGeneration: currentSocketGeneration,
      responseStreamId: typeof message.stream_id === 'string' ? message.stream_id : undefined,
      eventStreamIds: events.map((event) => String(event.stream_id || '')),
      existingCoverage: streamEventsCoverage(token),
      now: Date.now(),
      freshnessMs: PREFETCH_COVERAGE_FRESH_MS,
    });
    if (!result.matched || !token) return;
    if (result.cursorEvidence) updateStreamEventsResumeCursor(token.streamId, events, false);
    if (result.commit === 'progressive') {
      applyRequestStreamEvents(
        events,
        'request_stream_events.chunk',
        true,
        undefined,
        undefined,
        (next) => applyStreamEventsFinalState(next, token, result),
      );
    }
    refreshPendingRequestTimeout(message.request_id);
    pending.streamEvents = [...(pending.streamEvents || []), ...events];
    return;
  }

  if (message.type === 'request_stream_events.ok' && typeof message.request_id === 'string') {
    const events = Array.isArray(message.events) ? (message.events as PentacleEvent[]) : [];
    const pending = pendingRequests.get(message.request_id);
    if (!pending) return;
    const token = pendingStreamEventsToken(message.request_id, pending);
    const accumulated = [...(pending.streamEvents || []), ...events];
    const currentTailOptions = token?.window === 'current-tail'
      ? currentTailReducerOptions(pending, token.streamId, 'request_stream_events')
      : undefined;
    const tailSelection = currentTailOptions && token
      ? selectCurrentTailEvents(state, accumulated, token.streamId, currentTailOptions.ingressSource)
      : undefined;
    const rehydrateFailed = message.rehydrate_failed === true;
    const result = finalizeStreamEventsResponse({
      kind: 'terminal',
      pending: token,
      activeRequest: activeStreamEventsRequest(token),
      currentGeneration: currentSocketGeneration,
      responseStreamId: typeof message.stream_id === 'string' ? message.stream_id : undefined,
      eventStreamIds: accumulated.map((event) => String(event.stream_id || '')),
      complete: message.complete !== false,
      rehydrateFailed,
      currentTailAccepted: tailSelection ? tailSelection.rejectedStreamIds.length === 0 : undefined,
      eventCount: accumulated.length,
      existingCoverage: streamEventsCoverage(token),
      now: Date.now(),
      freshnessMs: PREFETCH_COVERAGE_FRESH_MS,
    });
    if (!result.matched || !token) return;
    const acceptedEvents = tailSelection?.events ?? accumulated;
    let cursorChanged = false;
    if (result.cursorEvidence) {
      cursorChanged = result.authoritativeAccepted
        ? noteCompletedStreamEventsRequest(token.streamId, acceptedEvents, pending, false, false)
        : updateStreamEventsResumeCursor(token.streamId, acceptedEvents, false);
    }
    const terminalEvents = token.window === 'history' ? events : acceptedEvents;
    let stateChanged = false;
    if (result.commit !== 'none') {
      stateChanged = applyRequestStreamEvents(
        terminalEvents,
        'request_stream_events',
        false,
        token.window === 'current-tail' ? currentTailOptions : undefined,
        undefined,
        (next) => applyStreamEventsFinalState(next, token, result),
      );
    } else {
      stateChanged = setState(applyStreamEventsFinalState(state, token, result), false);
    }
    if (cursorChanged || stateChanged) emit();
  flushPendingHarnessLiveApplyTiming();
    if (
      result.authoritativeAccepted &&
      pending.streamEventsPurpose !== 'freshness-guard' &&
      pending.streamEventsPurpose !== 'older-page' &&
      ((pending.streamEvents?.length || 0) > 0 || pending.streamEventsHadResumeCursor)
    ) {
      scheduleStreamEventsTailCatchUp(token.streamId, pending.streamEventsEntrySource);
    }
    settlePendingRequest(message.request_id);
    pending.resolve(accumulated);
    return;
  }

  if (message.type === 'request_stream_events.error' && typeof message.request_id === 'string') {
    const pending = pendingRequests.get(message.request_id);
    if (pending) {
      const token = pendingStreamEventsToken(message.request_id, pending);
      const result = finalizeStreamEventsResponse({
        kind: 'error',
        pending: token,
        activeRequest: activeStreamEventsRequest(token),
        currentGeneration: currentSocketGeneration,
        responseStreamId: typeof message.stream_id === 'string' ? message.stream_id : undefined,
        existingCoverage: streamEventsCoverage(token),
        now: Date.now(),
        freshnessMs: PREFETCH_COVERAGE_FRESH_MS,
      });
      if (!result.matched || !token) return;
      setState(applyStreamEventsFinalState(state, token, result));
      settlePendingRequest(message.request_id);
      pending.reject(new Error(String(message.error || 'request_stream_events failed')));
    }
    return;
  }
}

function connect() {
  // Screenshot harness: never open a socket. The seeded fixture state stands
  // in for a live stream so screens render fully offline.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === '1' && harnessOffline) return;
  if (subscribers === 0) return;
  if (
    process.env.EXPO_PUBLIC_HARNESS === '1'
    && harnessRuntime.isArmed()
    && !harnessRuntime.isHarnessTokenReady()
  ) {
    if (!harnessTokenReadyConnectPending) {
      harnessTokenReadyConnectPending = true;
      void harnessRuntime.whenHarnessTokenReady().then((ready) => {
        harnessTokenReadyConnectPending = false;
        if (ready && subscribers > 0) connect();
      });
    }
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const harnessAuthDisabled = process.env.EXPO_PUBLIC_HARNESS === '1'
    && harnessRuntime.isArmed()
    && harnessRuntime.hasAction('disable_pentacle_auth');
  if (!authToken && !harnessAuthDisabled && process.env.NODE_ENV !== 'test') {
    updateState({ connected: false, connecting: false, lastError: 'operator_enrollment_required' });
    return;
  }

  clearTimers();
  updateState({ connecting: true });
  const urls = connectionUrls();
  const targetUrl = urls[Math.min(reconnectAttempt, urls.length - 1)] || getDefaultPentacleWsUrl();
  const targetHost = urlHost(targetUrl);
  let v2Credential: OperatorAuthV2Credential | null = null;
  if (authToken?.startsWith(OPERATOR_AUTH_V2_PREFIX)) {
    try {
      v2Credential = parseOperatorAuthV2Envelope(authToken);
    } catch {
      updateState({ connected: false, connecting: false, lastError: 'operator_auth_v2_invalid' });
      return;
    }
  }

  try {
    ws = new WebSocket(targetUrl);
  } catch (error) {
    updateState({
      connected: false,
      connecting: false,
      lastError: error instanceof Error ? `${error.message} (${targetUrl})` : connectionErrorMessage(targetUrl),
    });
    scheduleReconnect();
    return;
  }
  const socket = ws;
  const myGen = ++currentSocketGeneration;
  let connectionReady = false;
  const teardownPreOpenSocket = (reason: string) => {
    if (!socketGenerationMatches(myGen) || socket !== ws) return;
    if (connectionReady || socket.readyState === WebSocket.OPEN) return;
    forceCloseSocketForLiveness(myGen, socket, reason);
  };
  pendingCloseInventoryGeneration = null;
  // Absence observed on the previous connection says nothing about this one's inventories, and
  // time spent disconnected must not count toward the grace.
  pendingCloseAbsentSince.clear();
  let operatorWelcomeTimer: ReturnType<typeof setTimeout> | null = null;
  let operatorAuthFailure: string | null = null;

  preOpenConnectTimer = setTimeout(() => {
    teardownPreOpenSocket('preopen_connect_timeout');
  }, PRE_OPEN_CONNECT_TIMEOUT_MS);

  const completeOpen = (authentication: { token?: string; auth_v2?: Record<string, string> }) => {
    if (connectionReady || !socketGenerationMatches(myGen) || socket !== ws) return;
    connectionReady = true;
    if (operatorWelcomeTimer) {
      clearTimeout(operatorWelcomeTimer);
      operatorWelcomeTimer = null;
    }
    if (reconnectAttempt > 0) {
      logTelemetry(TELEMETRY_EVENTS.CHAT_WS_RECONNECT_SUCCEEDED, {
        url_host: targetHost,
        attempt: reconnectAttempt,
      });
    }
    reconnectAttempt = 0;
    lastFrameReceivedAt = monotonicNowMs();
    awaitingPongSince = null;
    clearDisconnectBannerTimer();
    const connectedAt = Date.now();
    let reconnectState = state;
    if (pendingReconnectSurvivorGeneration !== null) {
      reconnectState = onReconnect(reconnectState, pendingReconnectSurvivorGeneration, connectedAt, myGen);
      pendingReconnectSurvivorGeneration = null;
    }
    reconnectState = rearmOfflineQueuedSends(reconnectState, myGen, connectedAt);
    if (reconnectState !== state) setState(reconnectState);
    socket.send(JSON.stringify({
      type: 'hello',
      client: 'pentacle-mobile',
      ...authentication,
      // Narrowed fleet scope: the app renders only default-visible sessions and
      // filters hidden/nested/subagent seats client-side, so include_subagents:false
      // lets the daemon drop those seats' inventory/working.state/chat.event/
      // completion.report frames at the source (the dominant inbound volume on a
      // busy evening; see public behavior contract).
      // Hidden seats' open prompt-ask cards still surface — they ride the global
      // notifications slice, which is not visibility-scoped, and are re-projected in
      // selectVisibleChatList / selectQuestionItems.
      subscribe: {
        events_mode: process.env.EXPO_PUBLIC_HARNESS === '1'
          && harnessRuntime.isArmed()
          && harnessRuntime.hasAction('all_chats_regression')
          ? 'full'
          : 'summary',
        // Default production/harness subscriptions keep the narrowed
        // include_subagents:false (4b08594a); the all_chats_regression stress
        // harness opts back into subagents so its full-events corpus is not
        // source-filtered.
        include_subagents: process.env.EXPO_PUBLIC_HARNESS === '1'
          && harnessRuntime.isArmed()
          && harnessRuntime.hasAction('all_chats_regression'),
      },
    }));
    socket.send(JSON.stringify({
      type: 'specs.capabilities',
      request_id: requestId('specs-capabilities'),
    }));
    updateState({ connected: true, connecting: false, lastError: undefined });
    void ensurePendingSessionClosesHydrated();
    dispatchOfflineQueuedSends(myGen);
    // §A: expire stale (>30 min) resolve survivors as visibly recoverable first, then
    // re-arm and replay the rest on this generation.
    const expiredResolves = expireNotificationResolveSurvivors(pendingNotificationResolves, connectedAt);
    if (expiredResolves.removed.length) {
      pendingNotificationResolves = expiredResolves.next;
      for (const removed of expiredResolves.removed) {
        surfaceNotificationResolveError(removed.notification_id, 'Answer expired before it could be delivered. Try again.');
      }
    }
    pendingNotificationResolves = rearmNotificationResolveSurvivors(pendingNotificationResolves, myGen, connectedAt);
    dispatchOfflineQueuedNotificationResolves(myGen);
    reconcilePendingSendReceipts();
    refetchFocusedStreamTail();
    refreshHeartbeatTimer();
  };

  const failOperatorAuthV2 = (reason: string) => {
    if (operatorAuthFailure || connectionReady || !socketGenerationMatches(myGen) || socket !== ws) return;
    operatorAuthFailure = reason;
    if (operatorWelcomeTimer) {
      clearTimeout(operatorWelcomeTimer);
      operatorWelcomeTimer = null;
    }
    livenessCloseGeneration = myGen;
    livenessCloseErrorMessage = reason;
    updateState({ connected: false, connecting: false, lastError: reason });
    socket.close(4001, reason);
  };

  ws.onopen = async () => {
    if (!socketGenerationMatches(myGen) || socket !== ws) return;
    if (preOpenConnectTimer) {
      clearTimeout(preOpenConnectTimer);
      preOpenConnectTimer = null;
    }
    const openedAttempt = reconnectAttempt;
    logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {
      url_host: targetHost,
      attempt: openedAttempt,
      subscriber_count: subscribers,
    });
    // Harness force-reconnect: gates on compile flag + arming + action token.
    // onopen fires outside the React lifecycle, so use waitArmed to bound the
    // cold-launch URL Promise race per harness_runtime_alignment_2026_05_09.
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      const armed = await harnessRuntime.waitArmed(500);
      if (!socketGenerationMatches(myGen) || socket !== ws) return;
      if (armed && harnessRuntime.hasAction('force_ws_reconnect')) {
        logTelemetry(TELEMETRY_EVENTS.HARNESS_FORCE_WS_RECONNECT_SCHEDULED, {
          url_host: targetHost,
          attempt: openedAttempt,
          trigger: 'force_ws_reconnect',
          delay_ms: 250,
        });
        if (!harnessForcedReconnectIssued) {
          harnessForcedReconnectIssued = true;
          setTimeout(() => {
            if (!socketGenerationMatches(myGen) || socket !== ws) return;
            socket.close(4000, 'harness_forced');
          }, 250);
        }
      }
    }
    if (v2Credential) {
      if (!connectionReady) {
        operatorWelcomeTimer = setTimeout(() => {
          failOperatorAuthV2('operator_auth_v2_required');
        }, OPERATOR_AUTH_V2_WELCOME_TIMEOUT_MS);
      }
      return;
    }
    completeOpen({ token: authToken || undefined });
  };

  ws.onmessage = (event) => {
    const generationMatch = socketGenerationMatches(myGen);
    const activeSocket = socket === ws;
    const boundaryBase = process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.isArmed()
      ? {
          byte_length: utf8ByteLength(String(event.data || '')),
          data_category: websocketDataCategory(event.data),
          callback_generation: myGen,
          current_generation: currentSocketGeneration,
          generation_match: generationMatch,
          active_socket: activeSocket,
        }
      : null;
    if (boundaryBase) emitHarnessWsOnMessageBoundary({ stage: 'entry', ...boundaryBase });
    if (!generationMatch) {
      if (boundaryBase) emitHarnessWsOnMessageBoundary({ stage: 'early-return', reason: 'generation-mismatch', ...boundaryBase });
      return;
    }
    if (!activeSocket) {
      if (boundaryBase) emitHarnessWsOnMessageBoundary({ stage: 'early-return', reason: 'inactive-socket', ...boundaryBase });
      return;
    }
    if (harnessSilentHalfOpenActive && harnessSilentHalfOpenGeneration === myGen) {
      if (boundaryBase) emitHarnessWsOnMessageBoundary({ stage: 'early-return', reason: 'silent-half-open', ...boundaryBase });
      harnessSilentHalfOpenDropCount += 1;
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SILENT_HALF_OPEN_DROPPED, {
        generation: myGen,
        dropped_count: harnessSilentHalfOpenDropCount,
        byte_length: String(event.data || '').length,
      });
      return;
    }
    const rawFrame = String(event.data || '');
    emitHarnessNewSessionWsCallback(rawFrame);
    emitHarnessSessionRemovalWsCallback(rawFrame);
    recordInboundFrame();
    if (v2Credential && !connectionReady) {
      try {
        const message = JSON.parse(rawFrame) as Record<string, unknown>;
        if (boundaryBase) emitHarnessWsOnMessageBoundary({
          stage: 'json-parse',
          parse_category: 'success',
          frame_type: safeInboundFrameType(message),
          current_generation: currentSocketGeneration,
        });
        if (message.type !== 'welcome') {
          if (boundaryBase) emitHarnessWsOnMessageBoundary({
            stage: 'early-return',
            reason: 'operator-auth-unexpected-frame',
            ...boundaryBase,
          });
          throw new Error('operator_auth_v2_required');
        }
        completeOpen({ auth_v2: createOperatorAuthV2Hello(v2Credential, message) });
        if (boundaryBase) emitHarnessWsOnMessageBoundary({
          stage: 'early-return',
          reason: 'operator-auth-handshake-consumed',
          ...boundaryBase,
        });
      } catch (error) {
        if (error instanceof SyntaxError) {
          if (boundaryBase) emitHarnessWsOnMessageBoundary({
            stage: 'json-parse',
            parse_category: 'syntax-error',
            frame_type: null,
            current_generation: currentSocketGeneration,
          });
          if (boundaryBase) emitHarnessWsOnMessageBoundary({
            stage: 'early-return',
            reason: 'operator-auth-parse-error',
            ...boundaryBase,
          });
        } else if (String(error instanceof Error ? error.message : error) !== 'operator_auth_v2_required') {
          if (boundaryBase) emitHarnessWsOnMessageBoundary({
            stage: 'early-return',
            reason: 'operator-auth-handshake-error',
            ...boundaryBase,
          });
        }
        failOperatorAuthV2(error instanceof Error ? error.message : 'operator_auth_v2_required');
      }
      return;
    }
    handleMessage(rawFrame);
  };

  ws.onerror = () => {
    if (!socketGenerationMatches(myGen) || socket !== ws) return;
    if (operatorAuthFailure) return;
    if (!connectionReady && socket.readyState !== WebSocket.OPEN) {
      updateState({
        connected: false,
        connecting: false,
        lastError: connectionErrorMessage(targetUrl),
      });
      teardownPreOpenSocket('preopen_socket_error');
      return;
    }
    updateState({
      connected: false,
      connecting: false,
      lastError: connectionErrorMessage(targetUrl),
    });
  };

  ws.onclose = (event) => {
    if (!socketGenerationMatches(myGen) || socket !== ws) return;
    if (operatorWelcomeTimer) {
      clearTimeout(operatorWelcomeTimer);
      operatorWelcomeTimer = null;
    }
    if (event?.code === 1012 || event?.reason === 'service_restart') {
      const next = markDaemonRestartSurvivorsIndeterminate(state, myGen);
      if (next !== state) setState(next);
      // §A: a daemon restart is not replay-safe — drop this generation's resolve
      // survivors out of replay eligibility and surface each as visibly recoverable.
      const restart = markDaemonRestartNotificationResolvesIndeterminate(pendingNotificationResolves, myGen);
      if (restart.removed.length) {
        pendingNotificationResolves = restart.next;
        for (const removed of restart.removed) {
          surfaceNotificationResolveError(removed.notification_id, 'Action interrupted by a service restart. Try again.');
        }
      }
    }
    pendingReconnectSurvivorGeneration = myGen;
    failAmbiguousOptimisticSends(myGen, 'delivery_unconfirmed_after_disconnect');
    flushLiveStreamEventBatch();
    invalidateCurrentSocketGeneration();
    ws = null;
    clearTimers();
    resumePendingAfterClose = true;
    logTelemetry(TELEMETRY_EVENTS.CHAT_WS_CLOSE, {
      reason: String(event?.reason || ''),
      code: Number(event?.code || 0),
      was_clean: Boolean(event?.wasClean),
      subscriber_count: subscribers,
	    });
	    updateState({ connected: false, connecting: true });
	    const pendingErrorMessage = livenessCloseGeneration === myGen
	      ? livenessCloseErrorMessage
	      : 'Pentacle stream disconnected';
	    livenessCloseGeneration = null;
	    livenessCloseErrorMessage = 'Pentacle stream disconnected';
	    failPendingRequests(new Error(pendingErrorMessage));
	    scheduleDisconnectBanner(myGen, pendingErrorMessage);
	    scheduleReconnect();
	  };
}

function ensureSubscribed() {
  subscribers += 1;
  if (!deferredConnectTimer) {
    const timerGen = currentSocketGeneration;
    deferredConnectTimer = setTimeout(() => {
      if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.isArmed()) {
        deferredConnectTimer = null;
        connect();
        return;
      }
      if (!socketGenerationMatches(timerGen)) return;
      deferredConnectTimer = null;
      connect();
    }, 0);
  }
}

function releaseSubscription() {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers > 0) return;
  failAmbiguousOptimisticSends(currentSocketGeneration, 'delivery_unconfirmed_after_disconnect');
  invalidateCurrentSocketGeneration();
  clearTimers();
  clearDisconnectBannerTimer();
  failPendingRequests(new Error('Pentacle stream disconnected'));
  if (ws) {
    ws.close();
    ws = null;
  }
}

function sendCommand<T>(
  payload: Record<string, unknown>,
  requestPrefix: string,
  options: {
    requestId?: string;
    onDispatched?: (requestId: string, generation: number) => void;
    onSocketSent?: (requestId: string, generation: number) => void;
    optimisticId?: string;
    retryOnOptimisticIdConflict?: boolean;
    retryTelemetry?: RetryTelemetryContext;
  } = {},
): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Pentacle stream is not connected'));
  }
  const request_id = options.requestId || requestId(requestPrefix);
  const myGen = currentSocketGeneration;
  const socket = ws;
  return new Promise<T>((resolve, reject) => {
    const pending: PendingRequest = {
      resolve,
      reject,
      timeout: null,
      generation: myGen,
      socket,
      requestPrefix,
      timeoutMs: RPC_TIMEOUT_MS,
      optimisticId: options.optimisticId,
      retryOnOptimisticIdConflict: options.retryOnOptimisticIdConflict,
      retryTelemetry: options.retryTelemetry,
    };
    pendingRequests.set(request_id, pending);
    armPendingRequestTimeout(request_id, pending);
    options.onDispatched?.(request_id, myGen);
    socket.send(JSON.stringify({ ...payload, request_id }));
    if (
      requestPrefix === 'spawn.v2' &&
      process.env.EXPO_PUBLIC_HARNESS === '1' &&
      harnessRuntime.isArmed()
    ) {
      spawnRpcDiagnosticWindowUntil = Date.now() + RPC_TIMEOUT_MS + 10000;
    }
    options.onSocketSent?.(request_id, myGen);
  });
}

export function sendPentacleAssetCommand<T extends Record<string, unknown>>(
  payload: Record<string, unknown>,
): Promise<T> {
  return sendCommand<T>(payload, 'asset');
}

export function subscribePentacleAssetFrames(
  listener: (message: Record<string, unknown>) => void,
) {
  assetFrameListeners.add(listener);
  return () => assetFrameListeners.delete(listener);
}

function buildStreamEventsRequestPayload(
  streamId: string,
  limit: number | undefined,
  purpose: StreamEventsRequestPurpose,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'request_stream_events',
    stream_id: streamId,
    chunk_limit: STREAM_EVENTS_CHUNK_LIMIT,
    order: 'newest_first',
  };
  if (typeof limit === 'number' && limit >= 0) {
    payload.limit = limit;
  }
  const resumeBefore = purpose === 'older-page'
    ? streamEventsResumeBeforeByStream.get(streamId)
    : undefined;
  if (resumeBefore !== undefined) {
    payload.before_daemon_seq = resumeBefore;
  }
  return payload;
}

function scheduleStreamEventsTailCatchUp(streamId: string, entrySource?: StreamOpenEntrySource) {
  const trimmed = String(streamId || '').trim();
  if (!trimmed) return;
  setTimeout(() => {
    if (subscribers <= 0) return;
    void requestStreamEvents(trimmed, FOCUSED_STREAM_REFETCH_LIMIT, {
      purpose: 'freshness-guard',
      entrySource: entrySource ?? streamOpenEntrySources.get(trimmed),
    }).catch(() => undefined);
  }, 0);
}

function scheduleOptimisticReconcileCatchUp(requestId: string) {
  const optimisticId = state.optimisticByRequestId?.[requestId];
  if (!optimisticId) return;
  const streamId = state.optimisticSends?.[optimisticId]?.stream_id;
  if (!streamId) return;
  scheduleStreamEventsTailCatchUp(streamId);
}

function queueSendReceiptQuery(requestId: string) {
  const optimisticId = state.optimisticByRequestId?.[requestId];
  const send = optimisticId ? state.optimisticSends?.[optimisticId] : undefined;
  if (!send || !['queued', 'dispatched', 'indeterminate'].includes(send.status)) return;
  const lookup = { toStreamId: send.stream_id, requestId: send.request_id };
  if (
    receiptQueryInFlight?.requestId === lookup.requestId ||
    queuedReceiptQueries.some((item) => item.requestId === lookup.requestId)
  ) return;
  queuedReceiptQueries.push(lookup);
  drainReceiptQueryQueue();
}

function drainReceiptQueryQueue() {
  if (receiptQueryInFlight || !ws || ws.readyState !== WebSocket.OPEN) return;
  const lookup = queuedReceiptQueries.shift();
  if (!lookup) return;
  receiptQueryInFlight = lookup;
  try {
    ws.send(JSON.stringify({
      type: 'send.receipt.get',
      to_stream_id: lookup.toStreamId,
      request_id: lookup.requestId,
    }));
  } catch {
    receiptQueryInFlight = null;
  }
}

function reconcilePendingSendReceipts() {
  for (const send of Object.values(state.optimisticSends ?? {})) {
    queueSendReceiptQuery(send.request_id);
  }
}

function applyDurableSendReceipt(
  receipt: Record<string, unknown>,
  lookup: { toStreamId: string; requestId: string },
  event?: PentacleEvent,
) {
  const requestId = String(receipt.request_id || '').trim();
  const toStreamId = String(receipt.to_stream_id || '').trim();
  if (requestId !== lookup.requestId || toStreamId !== lookup.toStreamId) return false;
  const optimisticId = state.optimisticByRequestId?.[requestId];
  const send = optimisticId ? state.optimisticSends?.[optimisticId] : undefined;
  if (!optimisticId || !send || send.stream_id !== toStreamId) return false;

  const receiptState = String(receipt.state || receipt.receipt_state || '');
  if (receiptState === 'landed') {
    setState(event
      ? reconcileOptimisticSendWithServerEvent(state, optimisticId, event)
      : markOptimisticAckedByRequestId(state, requestId, Date.now()));
    if (send.status !== 'acked') {
      logOptimisticReconciled(optimisticId, event, send.created_at, send.stream_id);
    }
    const settled = settlePendingRequest(requestId);
    settled?.resolve(true);
    return true;
  }
  if (receiptState === 'not_landed') {
    setState(markOptimisticFailedByRequestId(
      state,
      requestId,
      String(receipt.reason || receipt.delivery || 'not_landed'),
      Date.now(),
    ));
    return true;
  }
  if (receiptState === 'accepted') {
    setState(markOptimisticIndeterminateByRequestId(state, requestId, Date.now()));
    return true;
  }
  return false;
}

export async function spawnPentacleSession(args: {
  host: string;
  provider: 'claude' | 'codex';
}) {
  return sendCommand<PentacleSessionSummary>(
    { type: 'spawn', host: args.host, provider: args.provider },
    'spawn',
  );
}

type SpawnRpcDispatchHooks = {
  onDispatched?: (requestId: string, generation: number) => void;
  onSocketSent?: (requestId: string, generation: number) => void;
};

export function getSpawnCatalog(options: SpawnRpcDispatchHooks = {}) {
  return sendCommand<SpawnCatalog>(
    { type: 'spawn_catalog_get' },
    'spawn_catalog_get',
    options,
  );
}

export function spawnPentacleSessionV2(args: {
  host: string;
  provider: SpawnProvider;
  model: string;
  effort: string;
  spawnProfile: 'desktop_manual';
  catalogVersion: string;
  resolutionSource: 'profile_default' | 'explicit_override';
  // Optional. Objectives are a child-agent concept surfaced on the parent's status-card
  // roster; a top-level operator spawn carries none, so the daemon derives it (as it does
  // for desktop spawns, which never send one). When omitted the `objective` key is left off
  // the wire entirely — presence of the key, not its value, puts the daemon on its strict
  // branch. A caller that passes a non-empty objective (harness/child use) has it validated
  // and sent unchanged.
  objective?: string;
  // Optional D2 watch opt-out. Omitted by default (watch enabled at bounce B); there is no
  // mobile watch UI, but the field is carried consistently when a caller sets it.
  no_watch?: boolean;
  // One operator intent to start a chat. chat_streamd claims it, waits out an in-flight
  // duplicate, and replays the original spawn.ok, so retries and racing taps collapse onto
  // one session. public behavior contract.
  idempotencyKey?: string;
  onDispatched?: (requestId: string, generation: number) => void;
  onSocketSent?: (requestId: string, generation: number) => void;
}) {
  return sendCommand<SpawnSessionV2Result>({
    type: 'spawn',
    schema: 'SpawnRequestV2',
    host: args.host,
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    spawn_profile: args.spawnProfile,
    catalog_version: args.catalogVersion,
    resolution_source: args.resolutionSource,
    // Omit the key entirely when there is no objective (not `objective: ''`), so the daemon
    // takes its derived branch instead of the strict branch that key-presence triggers.
    ...(args.objective ? { objective: args.objective } : {}),
    ...(args.no_watch ? { no_watch: true } : {}),
    ...(args.idempotencyKey ? { idempotency_key: args.idempotencyKey } : {}),
  }, 'spawn.v2', {
    onDispatched: args.onDispatched,
    onSocketSent: args.onSocketSent,
  });
}

// On-demand fetch for a single stream's recent events. The hello-snapshot
// is delivered in summary mode (no events bundle), so transcripts call
// this when they mount to populate history. Idempotent at the caller
// site: the session screen skips the call if local state already has
// events for the stream. Spec:
// public behavior contract.
export async function requestStreamEvents(
  streamId: string,
  limit?: number,
  options: StreamEventsRequestOptions = {},
): Promise<PentacleEvent[]> {
  const trimmed = String(streamId || '').trim();
  if (!trimmed) return [];
  const purpose = options.purpose || 'manual';
  const inFlight = coalescableStreamEventsInFlight(trimmed, purpose, limit);
  if (inFlight) {
    emitIntentPrefetchTelemetry(MOBILE_TELEMETRY_EVENTS.INTENT_PREFETCH_COALESCED, {
      stream_id: trimmed,
      entry_source: options.entrySource ?? inFlight.entrySource ?? null,
      requested_purpose: purpose,
      coalesced_with: inFlight.purpose,
      in_flight_limit: inFlight.limit ?? null,
      requested_limit: limit ?? null,
    });
    return inFlight.promise;
  }
  if (
    process.env.EXPO_PUBLIC_HARNESS === '1' &&
    harnessRuntime.hasAction('fail_next_history_fetch') &&
    purpose === 'mount-fetch' &&
    !harnessForcedHistoryFetchFailureIssued
  ) {
    harnessForcedHistoryFetchFailureIssued = true;
    return Promise.reject(new Error('harness forced request_stream_events failure'));
  }
  const payload = buildStreamEventsRequestPayload(trimmed, limit, purpose);
  const inFlightKey = streamEventsInFlightKey(trimmed, purpose);
  const promise = sendCommand<PentacleEvent[]>(payload, 'request_stream_events', {
    onDispatched: (requestId, generation) => {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      const window = streamEventsWindowForPurpose(purpose);
      const before = Number.isFinite(Number(payload.before_daemon_seq))
        ? Number(payload.before_daemon_seq)
        : null;
      pending.streamEventsStreamId = trimmed;
      pending.streamEventsPurpose = purpose;
      pending.streamEventsWindow = window;
      pending.streamEventsLimit = limit;
      pending.streamEventsBefore = before;
      pending.streamEventsEntrySource = options.entrySource;
      pending.streamEventsHadResumeCursor = Object.prototype.hasOwnProperty.call(payload, 'before_daemon_seq');
      const priorToken = state.eventBucketsByStream?.[trimmed]?.requestsByWindow?.[window]?.token;
      if (priorToken && priorToken !== requestId) {
        const prior = settlePendingRequest(priorToken);
        prior?.reject(new Error('Pentacle stream events request superseded'));
      }
      const existingCoverage = state.eventBucketsByStream?.[trimmed]?.coverageByWindow?.[window];
      const coverage = existingCoverage ? {
        ...existingCoverage,
        complete: false,
        authoritativeZero: false,
        freshUntil: undefined,
      } : undefined;
      setState(mutatePentacleEventBuckets(state, {
        type: 'set-request-window',
        streamId: trimmed,
        window,
        request: {
          token: requestId,
          purpose,
          window,
          generation,
          limit,
          before,
          status: purpose === 'prefetch' ? 'prefetching' : 'loading',
        },
        coverage,
        replaceCoverage: true,
      }));
    },
  })
    .finally(() => {
      const ownsInFlight = streamEventsInFlight.get(inFlightKey)?.promise === promise;
      if (ownsInFlight) {
        streamEventsInFlight.delete(inFlightKey);
      }
    });
  streamEventsInFlight.set(inFlightKey, {
    promise,
    limit,
    purpose,
    entrySource: options.entrySource,
  });
  return promise;
}

export function appendOptimisticUserMessage(
  streamId: string,
  text: string,
  // A1 (photo/camera send): a photo-only message has empty text but ≥1 staged
  // image, so it must still produce an optimistic row. Caller passes true when
  // attachments accompany the send to bypass the empty-text guard.
  attachmentsOrHasAttachments: ChatAttachment[] | boolean = false,
) {
  const attachments = Array.isArray(attachmentsOrHasAttachments) ? attachmentsOrHasAttachments : undefined;
  const hasAttachments = Array.isArray(attachmentsOrHasAttachments)
    ? attachmentsOrHasAttachments.length > 0
    : attachmentsOrHasAttachments;
  const trimmed = String(text || '').trim();
  if (!streamId || (!trimmed && !hasAttachments)) return '';

  const now = Date.now();
  const optimistic_id = nextOptimisticId(streamId);
  const request_id = requestId('send');
  logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
    optimistic_id,
    stream_id: streamId,
  });
  setState(reduceSendOptimisticMessage(state, {
    streamId,
    text: trimmed,
    optimisticId: optimistic_id,
    requestId: request_id,
    createdAt: now,
    windowStartedAt: state.connected ? now : null,
    socketGeneration: currentSocketGeneration,
    ...(attachments?.length ? { attachments } : {}),
  }));
  return optimistic_id;
}

export function beginOptimisticQuestionAnswer(args: {
  streamId: string;
  text: string;
  notificationId?: string;
  questionId?: string;
}) {
  const optimisticId = appendOptimisticUserMessage(args.streamId, args.text);
  if (!optimisticId) return '';
  optimisticQuestionAnswers.set(optimisticId, {
    ...(args.notificationId ? { notificationId: args.notificationId } : {}),
    ...(args.questionId ? { questionId: args.questionId } : {}),
  });
  const optimistic = state.optimisticSends?.[optimisticId];
  if (optimistic) {
    setState(markOptimisticDispatchedByRequestId(state, optimistic.request_id, Date.now(), currentSocketGeneration));
  }
  return optimisticId;
}

const ACTIVE_QUESTION_ANSWER_SEND_STATUSES = new Set(['queued', 'dispatched', 'acked', 'indeterminate']);

export type OptimisticQuestionAnswerIdentity = {
  notificationId: string;
  questionId?: string;
};

// Single-slot memo keyed on the optimisticSends reference. The selector runs
// per emit from two chat-list call sites and JSON.parses every send; under
// daemon-v2 load that is a hot path, and optimisticSends changes reference only
// when a send is added/updated by the reducer, so identity-keyed memoization is
// exact.
let optimisticIdentitiesCacheKey: PentacleStreamState['optimisticSends'] | undefined | null = null;
let optimisticIdentitiesCacheValue: OptimisticQuestionAnswerIdentity[] = [];

export function selectOptimisticQuestionAnswerIdentities(
  source: Pick<PentacleStreamState, 'optimisticSends'>,
): OptimisticQuestionAnswerIdentity[] {
  if (optimisticIdentitiesCacheKey !== null && source.optimisticSends === optimisticIdentitiesCacheKey) {
    return optimisticIdentitiesCacheValue;
  }
  const identities = new Map<string, OptimisticQuestionAnswerIdentity>();
  for (const send of Object.values(source.optimisticSends ?? {})) {
    if (!ACTIVE_QUESTION_ANSWER_SEND_STATUSES.has(send.status)) continue;
    try {
      const payload = JSON.parse(send.text) as {
        type?: unknown;
        notification_id?: unknown;
        question_id?: unknown;
      };
      if (payload.type !== 'notification.answer' || typeof payload.notification_id !== 'string' || !payload.notification_id) {
        continue;
      }
      const questionId = typeof payload.question_id === 'string' && payload.question_id
        ? payload.question_id
        : undefined;
      const key = `${payload.notification_id}\n${questionId ?? ''}`;
      identities.set(key, {
        notificationId: payload.notification_id,
        ...(questionId ? { questionId } : {}),
      });
    } catch {
      // Ordinary optimistic chat text is not JSON and cannot suppress a question.
    }
  }
  const result = [...identities.values()].sort((left, right) => (
    left.notificationId.localeCompare(right.notificationId) ||
    String(left.questionId ?? '').localeCompare(String(right.questionId ?? ''))
  ));
  optimisticIdentitiesCacheKey = source.optimisticSends ?? null;
  optimisticIdentitiesCacheValue = result;
  return result;
}

export function selectOptimisticQuestionNotificationIds(
  source: Pick<PentacleStreamState, 'optimisticSends'>,
): string[] {
  const notificationIds = new Set(selectOptimisticQuestionAnswerIdentities(source).map(
    (identity) => identity.notificationId,
  ));
  return [...notificationIds].sort();
}

export function queueOptimisticQuestionAnswer(optimisticId: string) {
  const optimistic = state.optimisticSends?.[optimisticId];
  if (!optimistic) return;
  const optimisticSends = {
    ...(state.optimisticSends ?? {}),
    [optimisticId]: { ...optimistic, status: 'queued' as const, dispatched_at: undefined },
  };
  let next: PentacleStreamState = { ...state, optimisticSends };
  if (next.workingByStream?.[optimistic.stream_id]?.optimisticId === optimisticId) {
    next = clearPentacleTurn(next, optimistic.stream_id);
  }
  setState(next);
}

export function discardOptimisticQuestionAnswer(optimisticId: string) {
  const optimistic = state.optimisticSends?.[optimisticId];
  if (!optimistic) return;
  optimisticQuestionAnswers.delete(optimisticId);
  let next = pruneOptimisticSend(state, optimisticId);
  next = mutatePentacleEventBuckets(next, {
    type: 'optimistic-remove',
    streamId: optimistic.stream_id,
    optimisticId,
  });
  if (next.workingByStream?.[optimistic.stream_id]?.optimisticId === optimisticId) {
    next = clearPentacleTurn(next, optimistic.stream_id);
  }
  setState(next);
}

// Reducer-owned turn phase entry point. Synchronously appends the optimistic
// USER event AND sets workingByStream[streamId] = { phase: 'pending', ... }.
// The composer reads turn.phase !== 'idle' to gate the send button; the
// dock appears immediately because 'pending' counts as isWorking.
//
// Rejected (no-op + warn telemetry) if called while a turn is in flight.
// Defense in depth: the screen also disables the send button on non-idle phase
// per Stage 4. Returns the optimistic_id on success, '' on reject.
export function sendTurn(streamId: string, text: string, attachments?: ChatAttachment[]) {
  const trimmed = String(text || '').trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!streamId || (!trimmed && !hasAttachments)) return '';

  const currentTurn = state.workingByStream?.[streamId];
  if (currentTurn && currentTurn.phase !== 'idle') {
    logTelemetry(TELEMETRY_EVENTS.CHAT_SEND_WHILE_NOT_IDLE, {
      stream_id: streamId,
      phase: currentTurn.phase,
    });
    return '';
  }

  const optimistic_id = appendOptimisticUserMessage(streamId, trimmed, attachments);
  if (!optimistic_id) return '';
  return optimistic_id;
}

// B1 (send-while-working queue): the user sent a message while a turn was already
// in flight. Unlike sendTurn this does NOT begin or replace the active local
// turn. It appends a queued optimistic row without the retired turn_queued hold;
// the screen dispatches that exact optimistic_id after payload readiness so the
// daemon/provider CLI owns native FIFO queueing. Returns the optimistic_id, or ''
// if nothing to enqueue.
export function enqueueTurn(streamId: string, text: string, attachments?: ChatAttachment[]) {
  const trimmed = String(text || '').trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!streamId || (!trimmed && !hasAttachments)) return '';

  const now = Date.now();
  const optimistic_id = nextOptimisticId(streamId);
  const request_id = requestId('send');
  logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
    optimistic_id,
    stream_id: streamId,
  });
  setState(reduceEnqueueOptimisticMessage(state, {
    streamId,
    text: trimmed,
    optimisticId: optimistic_id,
    requestId: request_id,
    createdAt: now,
    queuedAt: now,
    ...(attachments?.length ? { attachments } : {}),
  }));
  return optimistic_id;
}

// B1: dispatch a queued optimistic send on the wire by its optimistic_id — NOT by
// text-match like sendPentacleMessage, because several queued sends may share the
// same text and the text-match would target the wrong row. Reuses the queued
// send's request_id so the daemon ack reconciles it.
function dispatchHeldSend(
  optimisticId: string,
  session: PentacleSessionSummary,
  attachments?: ChatAttachment[],
  options: {
    retryOnOptimisticIdConflict?: boolean;
    retryTelemetry?: RetryTelemetryContext;
  } = {},
): Promise<boolean> {
  const optimistic = state.optimisticSends?.[optimisticId];
  if (!optimistic) return Promise.resolve(false);
  if (
    optimistic.status === 'failed' ||
    optimistic.status === 'cancelled' ||
    optimistic.status === 'returned_to_prompt'
  ) {
    return Promise.resolve(false);
  }
  queuedOptimisticDispatchRequests.add(optimisticId);
  return sendCommand<boolean>(
    {
      type: 'send',
      host: session.host,
      session_name: session.session_name,
      text: optimistic.text,
      ...(attachments?.length ? { attachments } : {}),
      optimistic_id: optimisticId,
    },
    'send',
    {
      requestId: optimistic.request_id,
      optimisticId,
      retryOnOptimisticIdConflict: options.retryOnOptimisticIdConflict,
      retryTelemetry: options.retryTelemetry,
      onDispatched: (sentRequestId, generation) => {
        queuedOptimisticDispatchRequests.delete(optimisticId);
        setState(markOptimisticDispatchedByRequestId(state, sentRequestId, Date.now(), generation));
      },
    },
  );
  // The RPC rejection alone is not proof of non-delivery. The connection close
  // path classifies the unconfirmed generation as visibly retryable; the flush
  // caller swallows this promise rejection because the row is the user signal.
}

// Native-queue send-while-working path: chat-core no longer marks optimistic
// rows turn_queued. Dispatch the specific just-enqueued rows after payload
// readiness and let the daemon/provider CLI preserve FIFO while the active turn
// continues.
export function dispatchQueuedSendsByOptimisticId(
  streamId: string,
  optimisticIds: string | string[],
) {
  if (!streamId) return;
  const requested = Array.isArray(optimisticIds) ? optimisticIds : [optimisticIds];
  const requestedIds = new Set(requested.filter(Boolean));
  if (requestedIds.size === 0) return;
  const session = state.sessions.find((item) => item.stream_id === streamId);
  if (!session) return;
  const queued = Object.values(state.optimisticSends ?? {})
    .filter((send) => (
      requestedIds.has(send.optimistic_id) &&
      send.stream_id === streamId &&
      send.status === 'queued'
    ))
    .sort((a, b) => (a.queued_at ?? a.created_at) - (b.queued_at ?? b.created_at));
  for (const send of queued) {
    void dispatchHeldSend(send.optimistic_id, session, send.attachments).catch(() => {
      // Confirmation lag is handled by reconcile/send.result; do not turn a
      // timeout into a local hard failure.
    });
  }
}

// B1 compatibility fallback: dispatch legacy turn_queued sends FIFO. The native
// path above handles newly queued rows by optimistic_id without requiring this
// retired hold marker.
export function flushQueuedSends(streamId: string) {
  if (!streamId) return;
  const held = Object.values(state.optimisticSends ?? {})
    .filter((send) => (
      send.stream_id === streamId &&
      send.turn_queued === true &&
      send.status !== 'failed' &&
      send.status !== 'cancelled' &&
      send.status !== 'returned_to_prompt'
    ))
    .sort((a, b) => (a.queued_at ?? a.created_at) - (b.queued_at ?? b.created_at));
  if (held.length === 0) return;
  const session = state.sessions.find((item) => item.stream_id === streamId);
  if (!session) return;
  setState(reduceActivateQueuedSends(state, held.map((send) => send.optimistic_id)));
  for (const send of held) {
    void dispatchHeldSend(send.optimistic_id, session, send.attachments).catch(() => {
      // markOptimisticFailed already flipped the row; swallow so the unhandled
      // rejection does not surface (the failed affordance is the user signal).
    });
  }
}

// B1 (ESC cancel): interrupt the stream's current working turn via the daemon's
// `send.interrupt` RPC. The daemon issues a single tmux Escape; with a non-empty
// native queue Claude Code auto-flushes it as one combined turn (D4) — the client
// does not advance the queue here. The session screen debounces presses to exactly
// one effective interrupt per working turn (multi-ESC spam is dangerous, D4).
export function interruptSend(streamId: string): Promise<InterruptSendResult> {
  const session = state.sessions.find((item) => item.stream_id === streamId);
  if (!session) return Promise.reject(new Error('No session for interrupt'));
  return sendCommand<InterruptSendResult>(
    { type: 'send.interrupt', host: session.host, session_name: session.session_name },
    'send.interrupt',
  );
}

export function markOptimisticFailed(optimistic_id: string, reason = 'send_error') {
  const optimistic = state.optimisticSends?.[optimistic_id];
  if (!optimistic || optimistic.status === 'failed') return;
  logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED, {
    optimistic_id,
    stream_id: optimistic.stream_id,
    reason,
  });
  setState(markOptimisticFailedByOptimisticId(state, optimistic_id, reason));
}

// FEAT-SEND-RETRY: the user tapped Retry on a "failed sending" overlay. Re-arm
// the row back to "sending" and re-transmit it by optimistic_id. The dispatch
// rejection (RPC timeout / disconnect) is swallowed — the row stays "sending"
// and reconciles on the daemon echo (live or recovery refetch); only an explicit
// daemon reject (send.result / send.error) re-fails it.
export function retryOptimisticSend(optimisticId: string): Promise<boolean> {
  const optimistic = state.optimisticSends?.[optimisticId];
  if (!optimistic || optimistic.status !== 'failed') return Promise.resolve(false);
  const session = state.sessions.find((item) => item.stream_id === optimistic.stream_id);
  if (!session) return Promise.resolve(false);
  // idempotent_mobile_send §A: explicit retry mints a NEW request_id (keeping
  // optimistic_id) so the server treats it as a fresh logical send rather than a
  // replay of the failed one. Re-arm via the reducer, then rotate the request_id
  // client-side; dispatchHeldSend re-reads the rotated request_id from state.
  const priorRequestId = optimistic.request_id;
  const newRequestId = requestId('send');
  const retryTelemetry: RetryTelemetryContext = {
    streamId: optimistic.stream_id,
    priorOptimisticId: optimisticId,
    priorRequestId,
    currentOptimisticId: optimisticId,
    currentRequestId: newRequestId,
  };
  setState(rotateOptimisticSendRequestId(
    reduceRetryOptimisticSend(state, optimisticId, Date.now()),
    optimisticId,
    newRequestId,
  ));
  emitRetryTelemetry(retryTelemetry, 'retry_requested', 'pending');
  const dispatch = (attachments?: ChatAttachment[]) => dispatchHeldSend(
    optimisticId,
    session,
    attachments,
    { retryOnOptimisticIdConflict: true, retryTelemetry },
  ).catch((error) => {
    if (error instanceof Error && error.message === 'Pentacle stream is not connected') {
      // Rejected before any frame left (socket not open): nothing was
      // dispatched, so there is no echo to wait for — terminal, not ambiguous.
      markOptimisticFailed(optimisticId, error.message);
      emitRetryTelemetry(retryTelemetry, 'transport_undispatched', 'failed');
      return false;
    }
    if (isAmbiguousSendTransportError(error)) {
      emitRetryTelemetry(retryTelemetry, 'transport_ambiguous', 'recoverable');
      return false;
    }
    throw error;
  });
  const reupload = uploadRetryByOptimisticId.get(optimisticId);
  if (!reupload) return dispatch(optimistic.attachments);
  // The upload leg belongs to this unit: re-run the whole unit (fresh
  // upload_blob request_id, then the send). Unlike the send leg, an upload
  // rejection is terminal for any reason — no send has been dispatched, so
  // nothing could ever reconcile a row kept "sending".
  return reupload().then(
    (attachments) => {
      replaceOptimisticAttachments(optimisticId, attachments);
      return dispatch(attachments);
    },
    (error) => {
      markOptimisticFailed(optimisticId, error instanceof Error ? error.message : 'upload_error');
      emitRetryTelemetry(retryTelemetry, 'upload_failed', 'failed');
      return false;
    },
  );
}

export function retainUploadForRetry(
  optimisticId: string,
  reupload: () => Promise<ChatAttachment[]>,
) {
  if (!state.optimisticSends?.[optimisticId]) return;
  uploadRetryByOptimisticId.set(optimisticId, reupload);
}

export function replaceOptimisticAttachments(
  optimistic_id: string,
  attachments: ChatAttachment[],
) {
  const optimistic = state.optimisticSends?.[optimistic_id];
  if (!optimistic || !attachments.length) return;
  const optimisticSends = {
    ...(state.optimisticSends ?? {}),
    [optimistic_id]: {
      ...optimistic,
      attachments,
    },
  };
  const optimisticEvent = peekEventsForStream(state, optimistic.stream_id).find((event) => (
    event.optimistic_id === optimistic_id && event.client_origin === true
  ));
  const next = { ...state, optimisticSends };
  setState(optimisticEvent
    ? mutatePentacleEventBuckets(next, {
      type: 'optimistic-replace',
      streamId: optimistic.stream_id,
      optimisticId: optimistic_id,
      event: { ...optimisticEvent, attachments },
    })
    : next);
}

export async function sendPentacleMessage(args: {
  host: string;
  sessionName: string;
  text: string;
  optimisticId?: string;
  // A1 (photo/camera send): uploaded blob refs (+ metadata), FIFO. Only the
  // opaque `key`s travel on the send payload; image bytes already went phone→daemon
  // through the blob RPC, and `localPath` is daemon-side only.
  attachments?: ChatAttachment[];
}) {
  const streamId = state.sessions.find((session) => (
    session.host === args.host && session.session_name === args.sessionName
  ))?.stream_id;
  const trimmed = String(args.text || '').trim();
  const explicitOptimistic = args.optimisticId ? state.optimisticSends?.[args.optimisticId] : undefined;
  const optimistic = explicitOptimistic?.stream_id === streamId
    ? explicitOptimistic
    : Object.values(state.optimisticSends ?? {}).find((send) => (
      (send.status === 'queued' || optimisticQuestionAnswers.has(send.optimistic_id)) &&
      send.stream_id === streamId &&
      send.text === trimmed
    ));
  if (optimistic) queuedOptimisticDispatchRequests.add(optimistic.optimistic_id);
  return sendCommand<boolean>(
    {
      type: 'send',
      host: args.host,
      session_name: args.sessionName,
      text: args.text,
      // FIFO order preserved — mirrors the daemon's agent-inject order.
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      // Carry the optimistic_id on the wire so the daemon can stamp it (plus
      // correlatedDaemonSeq) onto the server USER echo. Without it the daemon
      // has nothing to echo and reconcile falls back to fragile exact-text
      // matching, which a tmux multi-line paste round-trip breaks → the
      // optimistic send never reconciles (reconcile_timeout). Identity-driven,
      // not telemetry: this is the real send wire, end to end.
      optimistic_id: optimistic?.optimistic_id,
    },
    'send',
    {
      requestId: optimistic?.request_id,
      optimisticId: optimistic?.optimistic_id,
      onDispatched: (sentRequestId, generation) => {
        if (optimistic) queuedOptimisticDispatchRequests.delete(optimistic.optimistic_id);
        setState(markOptimisticDispatchedByRequestId(state, sentRequestId, Date.now(), generation));
      },
    },
  );
}

export interface UploadBlobResult {
  blob_sha: string;
  size_bytes?: number;
}

export interface FetchBlobResult {
  blob_sha: string;
  size_bytes?: number;
  content_b64: string;
}

const BLOB_UPLOAD_CHUNK_BASE64_CHARS = 1024 * 1024;

function base64Chunks(dataBase64: string) {
  if (!dataBase64) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < dataBase64.length; offset += BLOB_UPLOAD_CHUNK_BASE64_CHARS) {
    chunks.push(dataBase64.slice(offset, offset + BLOB_UPLOAD_CHUNK_BASE64_CHARS));
  }
  return chunks;
}

function sendBlobChunk(requestId: string, dataBase64: string, final: false): void;
function sendBlobChunk(requestId: string, dataBase64: string, final: true): Promise<UploadBlobResult>;
function sendBlobChunk(requestId: string, dataBase64: string, final: boolean): Promise<UploadBlobResult> | void {
  if (final) {
    return sendCommand<UploadBlobResult>(
      { type: 'upload_blob_chunk', data_b64: dataBase64, final },
      'upload_blob',
      { requestId },
    );
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Pentacle stream is not connected');
  }
  ws.send(JSON.stringify({
    type: 'upload_blob_chunk',
    request_id: requestId,
    data_b64: dataBase64,
    final,
  }));
}

export async function uploadBlobBase64(
  dataBase64: string,
  sizeHintBytes?: number,
): Promise<UploadBlobResult> {
  const request_id = requestId('upload_blob');
  await sendCommand<boolean>(
    {
      type: 'upload_blob_init',
      ...(typeof sizeHintBytes === 'number' ? { size_hint_bytes: sizeHintBytes } : {}),
    },
    'upload_blob',
    { requestId: request_id },
  );

  const chunks = base64Chunks(dataBase64);
  for (let index = 0; index < chunks.length - 1; index += 1) {
    sendBlobChunk(request_id, chunks[index], false);
  }
  return sendBlobChunk(request_id, chunks[chunks.length - 1], true);
}

export function fetchBlobBase64(blobSha: string): Promise<FetchBlobResult> {
  const trimmed = String(blobSha || '').trim();
  if (!trimmed) return Promise.reject(new Error('Missing blob sha'));
  return sendCommand<FetchBlobResult>(
    { type: 'fetch_blob', blob_sha: trimmed },
    'fetch_blob',
  );
}

export async function renamePentacleSession(args: {
  host: string;
  sessionName: string;
  displayName: string;
}) {
  const myGen = currentSocketGeneration;
  const session = await sendCommand<PentacleSessionSummary>(
    {
      type: 'rename',
      host: args.host,
      session_name: args.sessionName,
      display_name: args.displayName,
    },
    'rename',
  );
  if (!socketGenerationMatches(myGen)) return session;
  setState(applyPentacleSessionSummary(state, session));
  return session;
}

async function performPendingSessionClose(
  pending: PendingSessionClose,
  options: { force?: boolean } = {},
): Promise<CloseSessionResult> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    schedulePendingCloseRetry();
    return { closed: false, deferred: false, queued: true };
  }
  try {
    const result = await sendCommand<CloseSessionResult>(
      {
        type: 'close',
        host: pending.host,
        session_name: pending.sessionName,
        // Force delete of an offline host is operator-confirmed: the operator has seen the
        // "<host> is offline" state and chosen Force delete, so send operator_confirm so the
        // daemon's operator-confirmed offline close applies (desktop parity).
        ...(options.force ? { force: true, operator_confirm: true } : { defer_if_working: true }),
      },
      options.force ? 'close-force' : 'close',
      { requestId: options.force ? requestId('close-force') : pending.requestId },
    );
    const current = pendingSessionCloses.get(pending.streamId);
    if (!current) return result;
    const next: PendingSessionClose = {
      ...current,
      // A deferred intent drains when the session quiesces; an immediate
      // (non-deferred) close has already succeeded. Both simply wait for
      // authoritative inventory removal rather than auto-retrying — re-dispatching
      // a close against an already-closed session can draw a not_found/unauthorized
      // reply and flip the row to a spurious "delete failed".
      state: result.deferred ? 'deferred' : 'accepted',
      ...(options.force ? { state: 'accepted' as const, forceRequested: false } : {}),
      intentId: result.intentId || current.intentId,
      sessionGeneration: result.sessionGeneration || current.sessionGeneration,
      nextAttemptAt: 0,
      errorCode: undefined,
      errorMessage: undefined,
    };
    pendingSessionCloses.set(pending.streamId, next);
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
    schedulePendingCloseRetry();
    return result;
  } catch (error) {
    const current = pendingSessionCloses.get(pending.streamId);
    if (!current) throw error;
    if (!options.force && isTransientCloseError(error)) {
      const next = await markPendingCloseRetry(current, error);
      return {
        closed: false,
        deferred: next.state === 'deferred',
        queued: true,
        intentId: next.intentId,
        sessionGeneration: next.sessionGeneration,
      };
    }
    pendingSessionCloses.set(pending.streamId, {
      ...current,
      state: 'failed',
      nextAttemptAt: 0,
      ...pendingCloseErrorFields(error, current.host),
    });
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
    throw error;
  }
}

function dispatchPendingSessionClose(
  pending: PendingSessionClose,
  options: { force?: boolean } = {},
): Promise<CloseSessionResult> {
  const active = pendingCloseInFlight.get(pending.streamId);
  if (active) {
    if (!options.force) return active;
    return active.catch(() => undefined).then(() => {
      const latest = pendingSessionCloses.get(pending.streamId);
      if (!latest) return { closed: true, deferred: false, queued: false };
      return dispatchPendingSessionClose(latest, options);
    });
  }
  const operation = performPendingSessionClose(pending, options);
  pendingCloseInFlight.set(pending.streamId, operation);
  void operation.finally(() => {
    if (pendingCloseInFlight.get(pending.streamId) === operation) {
      pendingCloseInFlight.delete(pending.streamId);
    }
  }).catch(() => undefined);
  return operation;
}

async function drainPendingSessionCloses() {
  await ensurePendingSessionClosesHydrated();
  if (
    !ws || ws.readyState !== WebSocket.OPEN ||
    pendingCloseInventoryGeneration !== currentSocketGeneration
  ) return;
  const now = Date.now();
  let expired = false;
  for (const [streamId, pending] of pendingSessionCloses) {
    if (
      (pending.state === 'queued' || pending.state === 'retrying') &&
      now - pending.requestedAt >= PENDING_CLOSE_TTL_MS
    ) {
      pendingSessionCloses.set(streamId, {
        ...pending,
        state: 'exhausted',
        nextAttemptAt: 0,
        errorCode: 'retry_exhausted',
        errorMessage: 'Automatic delete retries expired after 10 minutes.',
      });
      expired = true;
    }
  }
  if (expired) {
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
  }
  const due = [...pendingSessionCloses.values()].filter((pending) =>
    (pending.state === 'queued' || pending.state === 'retrying') && pending.nextAttemptAt <= now,
  );
  for (const pending of due) {
    await dispatchPendingSessionClose(pending, { force: pending.forceRequested === true }).catch(() => undefined);
  }
  schedulePendingCloseRetry();
}

async function reconcilePendingSessionCloses(sessions: PentacleSessionSummary[], generation: number) {
  await ensurePendingSessionClosesHydrated();
  if (!socketGenerationMatches(generation)) return;
  const byStream = new Map(sessions.map((session) => [session.stream_id, session]));
  const now = Date.now();
  let changed = false;
  const cancellationsToResume: string[] = [];
  for (const [streamId, pending] of pendingSessionCloses) {
    const session = byStream.get(streamId);
    if (!session) {
      // Absence is the only close signal the daemon sends, but a single omission is not proof:
      // start the grace and let sustained absence — or the timer below — finalize the removal.
      const firstAbsentAt = pendingCloseAbsentSince.get(streamId) ?? now;
      if (now - firstAbsentAt < PENDING_CLOSE_ABSENCE_GRACE_MS) {
        pendingCloseAbsentSince.set(streamId, firstAbsentAt);
        continue;
      }
      pendingCloseAbsentSince.delete(streamId);
      pendingSessionCloses.delete(streamId);
      changed = true;
      continue;
    }
    // Present again: the stream was never closed, so the grace restarts from scratch next time.
    pendingCloseAbsentSince.delete(streamId);
    const closeAware = session as CloseAwareSessionSummary;
    const currentGeneration = sessionGeneration(session);
    if (pending.sessionGeneration && currentGeneration && pending.sessionGeneration !== currentGeneration) {
      pendingSessionCloses.delete(streamId);
      changed = true;
      continue;
    }
    if (pending.sessionGeneration && !currentGeneration) {
      pendingSessionCloses.set(streamId, {
        ...pending,
        state: 'failed',
        nextAttemptAt: 0,
        errorCode: 'close_generation_unavailable',
        errorMessage: 'The current session generation could not be verified. Refresh before deleting.',
      });
      changed = true;
      continue;
    }
    if (pending.state === 'cancelling') {
      if (!closeAware.close_pending) {
        pendingSessionCloses.delete(streamId);
      } else if (closeAware.close_intent_id) {
        pendingSessionCloses.set(streamId, {
          ...pending,
          intentId: closeAware.close_intent_id,
          sessionGeneration: currentGeneration || pending.sessionGeneration,
          errorCode: undefined,
          errorMessage: undefined,
        });
        cancellationsToResume.push(streamId);
      } else {
        pendingSessionCloses.set(streamId, {
          ...pending,
          state: 'failed',
          nextAttemptAt: 0,
          errorCode: 'close_cancel_missing_intent',
          errorMessage: 'The pending delete could not be identified for cancellation. Refresh and retry.',
        });
      }
      changed = true;
      continue;
    }
    if (closeAware.close_pending) {
      const next: PendingSessionClose = {
        ...pending,
        state: pending.forceRequested ? 'queued' : 'deferred',
        intentId: closeAware.close_intent_id || pending.intentId,
        sessionGeneration: currentGeneration || pending.sessionGeneration,
        nextAttemptAt: pending.forceRequested ? Date.now() : 0,
        errorCode: undefined,
        errorMessage: undefined,
      };
      if (
        next.state !== pending.state || next.intentId !== pending.intentId ||
        next.sessionGeneration !== pending.sessionGeneration ||
        next.errorCode !== pending.errorCode || next.errorMessage !== pending.errorMessage
      ) {
        pendingSessionCloses.set(streamId, next);
        changed = true;
      }
    }
  }
  pendingCloseInventoryGeneration = generation;
  if (changed) {
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
  }
  for (const streamId of cancellationsToResume) {
    await cancelPendingSessionClose(streamId).catch(() => undefined);
  }
  await drainPendingSessionCloses();
}

export async function closePentacleSession(args: {
  host: string;
  sessionName: string;
  streamId: string;
}): Promise<CloseSessionResult> {
  await ensurePendingSessionClosesHydrated();
  const existing = pendingSessionCloses.get(args.streamId);
  if (existing) {
    return {
      closed: false,
      deferred: existing.state === 'deferred',
      queued: true,
      intentId: existing.intentId,
      sessionGeneration: existing.sessionGeneration,
    };
  }
  const now = Date.now();
  const pending: PendingSessionClose = {
    streamId: args.streamId,
    host: args.host,
    sessionName: args.sessionName,
    sessionGeneration: sessionGeneration(state.sessions.find((session) => session.stream_id === args.streamId)),
    requestId: requestId('close'),
    requestedAt: now,
    attempt: 0,
    nextAttemptAt: now,
    state: 'queued',
  };
  pendingSessionCloses.set(args.streamId, pending);
  // A new intent starts with a clean slate: never inherit absence accrued by a prior one.
  pendingCloseAbsentSince.delete(args.streamId);
  refreshPendingClosePresentation();
  try {
    await persistPendingSessionCloses();
  } catch (error) {
    pendingSessionCloses.delete(args.streamId);
    refreshPendingClosePresentation();
    throw error;
  }
  return dispatchPendingSessionClose(pending);
}

export async function retryPendingSessionClose(streamId: string) {
  await ensurePendingSessionClosesHydrated();
  const pending = pendingSessionCloses.get(streamId);
  if (!pending) return false;
  const now = Date.now();
  const next: PendingSessionClose = {
    ...pending,
    requestedAt: now,
    attempt: 0,
    nextAttemptAt: now,
    state: 'queued',
    forceRequested: false,
    errorCode: undefined,
    errorMessage: undefined,
  };
  pendingSessionCloses.set(streamId, next);
  refreshPendingClosePresentation();
  await persistPendingSessionCloses();
  await drainPendingSessionCloses();
  return true;
}

export async function cancelPendingSessionClose(streamId: string) {
  await ensurePendingSessionClosesHydrated();
  let pending = pendingSessionCloses.get(streamId);
  if (!pending) return false;
  let closeResult: CloseSessionResult | undefined;
  const active = pendingCloseInFlight.get(streamId);
  if (active) {
    pendingSessionCloses.set(streamId, {
      ...pending,
      state: 'cancelling',
      nextAttemptAt: 0,
      errorCode: undefined,
      errorMessage: undefined,
    });
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
    try {
      closeResult = await active;
    } catch {
      // A rejected close created no deferred intent; local cancellation is safe.
    }
    pending = pendingSessionCloses.get(streamId);
    if (!pending) return true;
  }
  if (pending.intentId && pending.sessionGeneration) {
    try {
      await sendCommand<boolean>({
        type: 'close.cancel',
        host: pending.host,
        session_name: pending.sessionName,
        intent_id: pending.intentId,
        session_generation: pending.sessionGeneration,
      }, 'close-cancel');
    } catch (error) {
      pendingSessionCloses.set(streamId, {
        ...pending,
        state: 'failed',
        nextAttemptAt: 0,
        ...pendingCloseErrorFields(error, pending.host),
      });
      refreshPendingClosePresentation();
      await persistPendingSessionCloses();
      throw error;
    }
  } else if (closeResult?.closed) {
    const error = new CloseSessionError('close_cancel_not_pending', 'The session close already started and can no longer be cancelled.');
    pendingSessionCloses.set(streamId, {
      ...pending,
      state: 'failed',
      nextAttemptAt: 0,
      ...pendingCloseErrorFields(error, pending.host),
    });
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
    throw error;
  } else if (closeResult?.queued && pending.state !== 'queued') {
    const error = new CloseSessionError(
      'close_cancel_ambiguous',
      'The delete request may have reached the server. Retry before cancelling.',
    );
    pendingSessionCloses.set(streamId, {
      ...pending,
      state: 'failed',
      nextAttemptAt: 0,
      ...pendingCloseErrorFields(error, pending.host),
    });
    refreshPendingClosePresentation();
    await persistPendingSessionCloses();
    throw error;
  }
  pendingSessionCloses.delete(streamId);
  refreshPendingClosePresentation();
  await persistPendingSessionCloses();
  schedulePendingCloseRetry();
  return true;
}

export async function forcePendingSessionClose(streamId: string) {
  await ensurePendingSessionClosesHydrated();
  const pending = pendingSessionCloses.get(streamId);
  if (!pending) return false;
  const next: PendingSessionClose = {
    ...pending,
    requestedAt: Date.now(),
    nextAttemptAt: Date.now(),
    state: 'queued',
    forceRequested: true,
    errorCode: undefined,
    errorMessage: undefined,
  };
  pendingSessionCloses.set(streamId, next);
  refreshPendingClosePresentation();
  await persistPendingSessionCloses();
  await drainPendingSessionCloses();
  return true;
}

export async function registerPentaclePushToken(args: {
  pushToken: string;
  platform: string;
  deviceName?: string;
}) {
  return sendCommand<boolean>(
    {
      type: 'register_push',
      push_token: args.pushToken,
      platform: args.platform,
      device_name: args.deviceName || '',
    },
    'register-push',
  );
}

// Fetch the current notification list (optionally filtered by state / limited).
// The reply (`notification.list.ok`) populates state.notifications via
// applyNotificationList so the Updates screen backfills on mount/focus; the
// live `notification` broadcast keeps it fresh afterwards.
export async function listNotifications(args: {
  states?: string[];
  limit?: number;
  notificationIds?: string[];
} = {}): Promise<PentacleNotification[]> {
  const payload: Record<string, unknown> = { type: 'notification.list' };
  if (args.notificationIds) {
    payload.notification_ids = args.notificationIds;
    return sendCommand<PentacleNotification[]>(payload, 'notification-lookup');
  }
  if (Array.isArray(args.states)) payload.states = args.states;
  if (typeof args.limit === 'number') payload.limit = args.limit;
  return sendCommand<PentacleNotification[]>(payload, 'notification-list');
}

// Resolve an open notification via one of its declared action kinds.
// Authenticates implicitly over the already-authenticated mobile-token
// socket (operator approved reusing the mobile device token). The reply
// (`notification.resolve.ok`) carries the updated record, applied in place
// via applyNotificationFrame.
export type ResolveNotificationArgs = {
  notification_id: string;
  action_kind: PentacleNotification['actions'][number]['kind'];
  question_id?: string;
  // B1 (Spec-QA Round 1): forward the clicked action's stable id so the daemon
  // resolves the EXACT action on multi-button notifications. Omitted on legacy
  // single-action notifications → daemon falls back to first-of-kind.
  action_id?: string;
  choice?: boolean;
  selections?: string[];
  text?: string;
  custom_text?: string;
  note?: string;
  by?: string;
};

type ClientNotification = PentacleNotification & {
  client_resolution_pending?: boolean;
  client_resolution_error?: string;
};

export function buildNotificationResolvePayload(args: ResolveNotificationArgs): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'notification.resolve',
    notification_id: args.notification_id,
    action_kind: args.action_kind,
  };
  if (typeof args.question_id === 'string') payload.question_id = args.question_id;
  if (typeof args.action_id === 'string') payload.action_id = args.action_id;
  if (typeof args.choice === 'boolean') payload.choice = args.choice;
  if (Array.isArray(args.selections)) payload.selections = args.selections;
  if (typeof args.text === 'string') payload.text = args.text;
  if (typeof args.custom_text === 'string') payload.custom_text = args.custom_text;
  if (typeof args.note === 'string') payload.note = args.note;
  if (typeof args.by === 'string') payload.by = args.by;
  return payload;
}

export async function resolveNotification(args: ResolveNotificationArgs): Promise<PentacleNotification | true> {
  const payload = buildNotificationResolvePayload(args);
  logTelemetry(TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_SENT, {
    notification_id: args.notification_id,
    action_kind: args.action_kind,
    ...(typeof args.question_id === 'string' ? { question_id: args.question_id } : {}),
    ...(typeof args.action_id === 'string' ? { action_id: args.action_id } : {}),
    ...(Array.isArray(args.selections) ? { selection_count: args.selections.length } : {}),
    ...(typeof args.text === 'string' ? { text_present: args.text.trim().length > 0 } : {}),
    ...(typeof args.custom_text === 'string' ? { custom_text_present: args.custom_text.trim().length > 0 } : {}),
    ...(typeof args.note === 'string' ? { note_present: args.note.trim().length > 0 } : {}),
  });
  const current = state.notifications.find(
    (notification) => notification.notification_id === args.notification_id,
  ) as ClientNotification | undefined;
  const original = current
    ? ({ ...current, client_resolution_pending: false, client_resolution_error: undefined } as ClientNotification)
    : undefined;
  if (original) {
    setState(applyNotificationFrame(state, {
      ...original,
      client_resolution_pending: true,
    } as ClientNotification));
  }
  // §A: register the resolve as a reconnect survivor so a transport cut auto-replays
  // it once per generation (same guarantees as a message send) instead of rejecting
  // and forcing a manual re-answer. A stable request_id is reused across replays; the
  // daemon's §B path dedups on notification identity, so replay is at-most-once.
  const notificationId = args.notification_id;
  const existing = pendingNotificationResolves[notificationId];
  const request_id = existing?.request_id ?? requestId('notification-resolve');
  const now = Date.now();
  const connected = !!ws && ws.readyState === WebSocket.OPEN;
  pendingNotificationResolves = {
    ...pendingNotificationResolves,
    [notificationId]: {
      notification_id: notificationId,
      args,
      payload,
      request_id,
      status: connected ? 'dispatched' : 'queued',
      socket_generation: currentSocketGeneration,
      window_started_at: connected ? now : null,
      created_at: existing?.created_at ?? now,
      reconnect_count: existing?.reconnect_count ?? 0,
    },
  };
  if (!connected) {
    // Offline at answer time: the resolve is durably queued for the next reconnect,
    // not discarded. Report optimistic success so the card stays "sending" and the
    // caller keeps the answer; the reconnect boundary drives it.
    return true;
  }
  return dispatchNotificationResolve(notificationId);
}

export async function answerDaemonPrompt(
  args: { questionId: string; selections?: string[]; text?: string },
): Promise<true> {
  const request_id = requestId('prompt-answer');
  const payload = buildDaemonQuestionAnswer({ request_id, question_id: args.questionId, selections: args.selections, text: args.text });
  if (process.env.EXPO_PUBLIC_HARNESS === '1' && harnessRuntime.isArmed()) {
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
      kind: 'prompt_answer_dispatched',
      question_id: args.questionId,
      text_present: Boolean(args.text?.trim()),
      selection_count: args.selections?.length ?? 0,
    });
  }
  return sendCommand<true>(payload, 'prompt-answer', { requestId: payload.request_id });
}

function clearPendingNotificationResolve(notificationId: string) {
  if (!pendingNotificationResolves[notificationId]) return;
  const { [notificationId]: _removed, ...rest } = pendingNotificationResolves;
  pendingNotificationResolves = rest;
}

function surfaceNotificationResolveError(notificationId: string, message: string) {
  const latest = state.notifications.find(
    (notification) => notification.notification_id === notificationId,
  ) as ClientNotification | undefined;
  if (!latest) return;
  setState(applyNotificationFrame(state, {
    ...latest,
    client_resolution_pending: false,
    client_resolution_error: message,
  } as ClientNotification));
}

// Drive one registered resolve on the wire. A terminal frame settles and removes
// the survivor. An ambiguous transport cut (socket closed / generation advanced)
// keeps it queued for the next reconnect and reports optimistic success so the
// answer is not discarded; a hard server rejection surfaces a recoverable error.
async function dispatchNotificationResolve(notificationId: string): Promise<PentacleNotification | true> {
  const entry = pendingNotificationResolves[notificationId];
  if (!entry) return true;
  const dispatchGeneration = currentSocketGeneration;
  try {
    const result = await sendCommand<PentacleNotification | true>(
      entry.payload,
      'notification-resolve',
      { requestId: entry.request_id },
    );
    clearPendingNotificationResolve(notificationId);
    return result;
  } catch (error) {
    const stillQueued = pendingNotificationResolves[notificationId];
    if (!stillQueued) {
      // Already terminalized elsewhere (e.g. the 1012 handler surfaced its own
      // specific message on close). Do not clobber it with a generic one.
      throw error;
    }
    const transportCut = !ws || ws.readyState !== WebSocket.OPEN || currentSocketGeneration !== dispatchGeneration;
    if (transportCut) {
      // Ambiguous cut — keep the survivor queued for the next reconnect generation.
      pendingNotificationResolves = {
        ...pendingNotificationResolves,
        [notificationId]: { ...stillQueued, status: 'queued' },
      };
      return true;
    }
    clearPendingNotificationResolve(notificationId);
    surfaceNotificationResolveError(notificationId, error instanceof Error ? error.message : 'Action failed');
    throw error;
  }
}

// Reconnect-boundary replay of every re-armed resolve survivor for this generation,
// alongside dispatchOfflineQueuedSends. Each is re-driven exactly once per generation.
function dispatchOfflineQueuedNotificationResolves(generation: number) {
  for (const notificationId of eligibleNotificationResolveReplayIds(pendingNotificationResolves)) {
    const entry = pendingNotificationResolves[notificationId];
    if (!entry || entry.socket_generation !== generation) continue;
    void dispatchNotificationResolve(notificationId).catch(() => {
      // A hard error is already surfaced on the card; a further transport cut
      // leaves the survivor queued for the next reconnect generation.
    });
  }
}

export async function readPentacleThread(args: {
  parentStreamId: string;
  childStreamId: string;
  limit?: number;
  cursor?: string;
}): Promise<Extract<ThreadReadResponse, { ok: true }>> {
  const result = await sendCommand<ThreadReadResponse>({
    type: 'thread.read',
    parent_stream_id: args.parentStreamId,
    child_stream_id: args.childStreamId,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  }, 'thread-read');
  if (!result.ok) throw new Error(result.message);
  return result;
}

export async function dismissQuestion(args: {
  host: string;
  sessionName: string;
  questionKey: string;
  text?: string;
}): Promise<DismissQuestionResult> {
  const payload: Record<string, unknown> = {
    type: 'question.dismiss',
    host: args.host,
    session_name: args.sessionName,
    question_key: args.questionKey,
  };
  if (args.text !== undefined) payload.text = args.text;
  return sendCommand<DismissQuestionResult>(payload, 'question-dismiss');
}

export function clearPentacleDraft(streamId: string) {
  setState(clearPentacleStreamDraft(state, streamId));
}

/**
 * Harness-only: force-close the underlying WebSocket with a custom reason
 * (default `harness_forced`). Used by `disconnect_after_send` scenarios to
 * simulate a mid-send drop. The normal `onclose` handler still fires —
 * `scheduleReconnect` will run and the stream re-establishes via the
 * default reconnect path.
 *
 * Mirrors the inline `ws?.close(4000, 'harness_forced')` already used by
 * `force_ws_reconnect` in `ws.onopen`, but exposed as a module-level
 * function so harness action handlers can invoke it on demand.
 *
 * Returns true if the socket was open and a close was issued, false
 * otherwise (already closed / never connected).
 */
export function harnessForceCloseWs(reason: string = 'harness_forced'): boolean {
  if (!ws) return false;
  try {
    ws.close(4000, reason);
  } catch {
    return false;
  }
  return true;
}

export function harnessActivateSilentHalfOpen(): boolean {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const socket = ws;
  const generation = currentSocketGeneration;
  harnessSilentHalfOpenActive = true;
  harnessSilentHalfOpenGeneration = generation;
  harnessSilentHalfOpenDropCount = 0;
  try {
    (socket as WebSocket & { close: WebSocket['close'] }).close = ((code?: number, reason?: string) => {
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SILENT_HALF_OPEN_CLOSE_SUPPRESSED, {
        generation,
        code: Number(code || 0),
        reason: String(reason || ''),
      });
      const delayMs = Math.max(0, Number(harnessRuntime.getParam('stale_onclose_delay_ms') || 3000) || 3000);
      setTimeout(() => {
        const onclose = socket.onclose;
        if (typeof onclose !== 'function') return;
        logTelemetry(TELEMETRY_EVENTS.HARNESS_SILENT_HALF_OPEN_LATE_ONCLOSE_FIRED, {
          generation,
          code: Number(code || 0),
          reason: String(reason || ''),
          delay_ms: delayMs,
        });
        try {
          onclose.call(socket, {
            code: Number(code || 0),
            reason: String(reason || ''),
            wasClean: false,
          } as CloseEvent);
        } catch {}
      }, delayMs);
    }) as WebSocket['close'];
  } catch {}
  logTelemetry(TELEMETRY_EVENTS.HARNESS_SILENT_HALF_OPEN_ARMED, {
    generation,
    ready_state: socket.readyState,
  });
  if (usesFocusedFastLiveness()) sendFocusedLivenessProbe(generation, socket, 'focused_heartbeat');
  return true;
}

export function reconnectPentacleStream(
  reason: 'refresh' | 'credential-change' | 'endpoint-change' = 'refresh',
) {
  // Screenshot harness: no-op. setPentacleAuthToken/setPentacleWsUrl call this
  // during token load; without the guard they would WIPE the seeded fixture
  // state (sessions/events/etc.) before the first paint.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === '1' && harnessOffline) return;
  clearDisconnectBannerTimer();
  pendingReconnectSurvivorGeneration = currentSocketGeneration;
  failAmbiguousOptimisticSends(currentSocketGeneration, 'delivery_unconfirmed_after_disconnect');
  invalidateCurrentSocketGeneration();
  clearTimers();
  failPendingRequests(new Error('Pentacle stream disconnected'));
  streamEventsResumeBeforeByStream.clear();
  streamEventsOlderExhaustedByStream.clear();
  intentPrefetchQueue.clear();
  deferredIntentPrefetches.clear();
  const preserveHarnessEvents = process.env.EXPO_PUBLIC_HARNESS === '1' &&
    harnessRuntime.isArmed() && harnessRuntime.hasAction('all_chats_regression');
  const crossesAccountBoundary = reason === 'credential-change' || reason === 'endpoint-change';
  setState(mutatePentacleEventBuckets({
    ...state,
    connected: false,
    connecting: true,
    hasHydrated: false,
    drafts: crossesAccountBoundary ? {} : state.drafts,
    sessions: crossesAccountBoundary ? [] : state.sessions,
    hosts: crossesAccountBoundary ? {} : state.hosts,
    updates: crossesAccountBoundary ? [] : state.updates,
    optimisticSends: crossesAccountBoundary ? {} : state.optimisticSends,
    optimisticByRequestId: crossesAccountBoundary ? {} : state.optimisticByRequestId,
    workingByStream: crossesAccountBoundary ? {} : state.workingByStream,
  }, preserveHarnessEvents
    ? { type: 'snapshot-replace', events: state.events }
    : { type: 'reset', reason }));
  if (ws) {
    ws.close();
    ws = null;
  }
  connect();
}

export function registerFocusedPentacleStream(streamId: string) {
  const registeredStreamId = String(streamId || '').trim();
  if (!registeredStreamId) return () => undefined;
  focusedStreamId = registeredStreamId;
  setState(mutatePentacleEventBuckets(
    mutatePentacleEventBuckets(state, {
      type: 'set-pin',
      streamId: registeredStreamId,
      pin: 'focused',
      pinned: true,
    }),
    { type: 'touch', streamId: registeredStreamId, source: 'focus' },
  ));
  const deferred = deferredBackgroundLiveEventsByStream.get(registeredStreamId);
  if (deferred) {
    if (deferred.length) liveStreamEventBatch = [...deferred, ...liveStreamEventBatch];
    deferredBackgroundLiveEventsByStream.delete(registeredStreamId);
  }
  // First-open working seed: WORKING/DRAFT events for this stream that arrived
  // before focus were batched (shouldApplyLiveEventImmediately defers them while
  // focusedStreamId !== streamId). The batch flush below routes through
  // applyRequestStreamEvents → applyFetchedStreamEvents, which STRIPS WORKING/
  // DRAFT — so those working seeds would be dropped (app:reducer=0) and the
  // composer's pre-dispatch working-check would miss them. Apply this stream's
  // batched WORKING/DRAFT here via the per-event reducer so working is derived at
  // registration, before the composer window. WORKING/DRAFT carry no transcript
  // row, so applying them ahead of the content flush preserves daemon_seq order
  // and the USER-first flush guarantee for the remaining (content) batch.
  if (liveStreamEventBatch.length) {
    const workingSeeds: PentacleEvent[] = [];
    const remainingBatch: PentacleEvent[] = [];
    for (const event of liveStreamEventBatch) {
      const kind = String(event.kind || '').toUpperCase();
      if (
        String(event.stream_id || '') === registeredStreamId &&
        (kind === 'WORKING' || kind === 'DRAFT')
      ) {
        workingSeeds.push(event);
      } else {
        remainingBatch.push(event);
      }
    }
    if (workingSeeds.length) {
      liveStreamEventBatch = remainingBatch;
      for (const event of workingSeeds) {
        liveImmediateApplyReason = `focus-working-seed:${String(event.kind || '').toUpperCase()}`;
        applyEvent(event);
      }
    }
  }
  // Drain any batched live events on focus so a newly-opened chat shows the
  // latest rows immediately instead of after the batch delay (≤240ms) — and
  // so the final non-immediate event of a burst (which relies on the batch
  // timer) can never be left stranded behind the synthesized placeholder row.
  flushLiveStreamEventBatch();
  refreshHeartbeatTimer();
  requestFocusedProbe('focus');
  return () => {
    const remainingLiveBatch = [];
    const deferredForStream = [];
    for (const event of liveStreamEventBatch) {
      if (String(event.stream_id || '') === registeredStreamId) {
        deferredForStream.push(event);
      } else {
        remainingLiveBatch.push(event);
      }
    }
    const nextDeferredForStream = [
      ...(deferredBackgroundLiveEventsByStream.get(registeredStreamId) || []),
      ...deferredForStream,
    ];
    if (nextDeferredForStream.length) {
      deferredBackgroundLiveEventsByStream.set(registeredStreamId, nextDeferredForStream);
    } else {
      deferredBackgroundLiveEventsByStream.delete(registeredStreamId);
    }
    if (deferredForStream.length) {
      liveStreamEventBatch = remainingLiveBatch;
    }
    if (liveStreamEventsTimer && deferredForStream.length) {
      clearTimeout(liveStreamEventsTimer);
      liveStreamEventsTimer = null;
      if (liveStreamEventBatch.length) armLiveStreamBatchWindow();
    }
    if (focusedStreamId === registeredStreamId) {
      focusedStreamId = null;
      setState(mutatePentacleEventBuckets(state, {
        type: 'set-pin',
        streamId: registeredStreamId,
        pin: 'focused',
        pinned: false,
      }));
      refreshHeartbeatTimer();
    }
  };
}

export function __getFocusedPentacleStreamForTests() {
  return focusedStreamId;
}

export function __resetPentacleStreamForTests() {
  invalidateCurrentSocketGeneration();
  clearTimers();
  clearDisconnectBannerTimer();
  failPendingRequests(new Error('test reset'));
  queuedOptimisticDispatchRequests.clear();
  pendingNotificationResolves = {};
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  ws = null;
  subscribers = 0;
  authToken = null;
  wsUrl = null;
  deferredConnectTimer = null;
  harnessTokenReadyConnectPending = false;
  resumePendingAfterClose = false;
  harnessForcedReconnectIssued = false;
  harnessForcedHistoryFetchFailureIssued = false;
  pendingReconnectSurvivorGeneration = null;
  receiptQueryInFlight = null;
  queuedReceiptQueries.length = 0;
  lastFrameReceivedAt = monotonicNowMs();
  awaitingPongSince = null;
  pendingForegroundProbe = false;
  focusedStreamId = null;
  livenessCloseGeneration = null;
  livenessCloseErrorMessage = 'Pentacle stream disconnected';
  pendingDisconnectBannerGeneration = null;
  if (pendingCloseRetryTimer) clearTimeout(pendingCloseRetryTimer);
  pendingCloseRetryTimer = null;
  pendingSessionCloses.clear();
  pendingCloseInFlight.clear();
  pendingCloseAbsentSince.clear();
  pendingCloseInventoryGeneration = null;
  pendingCloseHydrated = false;
  pendingCloseHydrationPromise = null;
  pendingClosePersistence = Promise.resolve();
  streamEventsResumeBeforeByStream.clear();
  streamEventsOlderExhaustedByStream.clear();
  streamEventsInFlight.clear();
  streamSliceCache.clear();
  intentPrefetchQueue.clear();
  deferredIntentPrefetches.clear();
  streamOpenEntrySources.clear();
  activeIntentPrefetches = 0;
  state = initialPentacleStreamState;
}

export function __handlePentacleStreamMessageForTests(message: Record<string, unknown>) {
  handleMessage(JSON.stringify(message));
}

export function __buildStreamEventsRequestPayloadForTests(
  streamId: string,
  limit: number | undefined,
  purpose: StreamEventsRequestPurpose = 'manual',
) {
  return buildStreamEventsRequestPayload(streamId, limit, purpose);
}

export function requestFocusedPentacleLivenessProbe(reason: 'interaction' | 'send' | 'scroll' | 'tap' | 'pull' = 'interaction') {
  return requestFocusedProbe(reason);
}

export function __handlePentacleAppStateChangeForTests(nextState: AppStateStatus) {
  handlePentacleAppStateChange(nextState);
}

export function getPentacleStreamState() {
  return state;
}

// ---------------------------------------------------------------------------
// Screenshot harness seam (spec: pentacle-mobile mock screenshot harness).
//
// These three exports exist ONLY for the react-native-web screenshot harness
// and are strictly gated by callers on EXPO_PUBLIC_SCREENSHOT_HARNESS === '1'.
// The module flag they toggle (harnessOffline) is itself only consulted behind
// the same env guard in connect()/reconnectPentacleStream(), so a production
// bundle (env replaced with `undefined`) dead-codes every branch.
// ---------------------------------------------------------------------------

export function harnessSetOffline(v: boolean) {
  harnessOffline = v;
}

export function harnessSeedSnapshot(
  snapshot: {
    events?: PentacleEvent[];
    drafts?: Record<string, PentacleEvent>;
    hosts?: Record<string, PentacleHostStatus>;
    hosts_stats?: Record<string, unknown>;
    sessions?: PentacleSessionSummary[];
    limits?: PentacleLimit[];
    updates?: PentacleUpdateMessage[];
    notifications?: PentacleNotification[];
  },
  opts?: {
    connected?: boolean;
    connecting?: boolean;
    hasHydrated?: boolean;
    lastError?: string;
  },
) {
  // Reuse the production reducers so seeded fixtures stay faithful to the wire
  // snapshot path — do NOT hand-build PentacleStreamState.
  let next = applySnapshotWithOptimisticReconciliation(initialPentacleStreamState, snapshot);
  if (snapshot.hosts_stats) {
    // Machine stats arrive as their own `hosts.stats` frame, not a snapshot
    // field — seed them through the same reducer the live frame uses.
    next = applyPentacleHostsStats(next, snapshot.hosts_stats);
  }
  if (snapshot.notifications) {
    next = applyNotificationList(next, snapshot.notifications);
  }
  setState({
    ...next,
    connected: opts?.connected ?? true,
    connecting: opts?.connecting ?? false,
    hasHydrated: opts?.hasHydrated ?? true,
    lastError: opts?.lastError,
  });
}

export function subscribePentacleStream(listener: () => void) {
  listeners.add(listener);
  void ensurePendingSessionClosesHydrated();
  ensureSubscribed();
  return () => {
    listeners.delete(listener);
    releaseSubscription();
  };
}

export function subscribePentacleStreamWhen(enabled: boolean, listener: () => void) {
  if (!enabled) {
    return () => undefined;
  }
  return subscribePentacleStream(listener);
}

export function __getPentacleStreamSubscriberCountForTests() {
  return subscribers;
}

export function getPentacleWsUrl() {
  if (!wsUrl) wsUrl = getDefaultPentacleWsUrl();
  return wsUrl;
}

export function setPentacleWsUrl(next: string | null) {
  const trimmed = String(next || '').trim();
  const nextUrl = trimmed || getDefaultPentacleWsUrl();
  if (wsUrl === nextUrl) {
    return;
  }
  wsUrl = nextUrl;
  reconnectPentacleStream('endpoint-change');
}

export function setPentacleAuthToken(token: string | null) {
  if (authToken === token) {
    return;
  }
  authToken = token;
  reconnectPentacleStream('credential-change');
}

function enrollPentacleDeviceWithProtocol(
  code: string,
  urlOverride: string | null | undefined,
  protocolVersion: 1 | 2,
): Promise<{ token: string }> {
  const defaultWsUrl = getDefaultPentacleWsUrl();
  const targetUrl = String(urlOverride || wsUrl || defaultWsUrl).trim() || defaultWsUrl;
  // Enrollment is a one-shot socket with local settled state only; it does not
  // mutate the shared stream lifecycle guarded by currentSocketGeneration.
  return new Promise((resolve, reject) => {
    let socket: WebSocket | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        socket?.close();
      } catch {
        // ignore close failures
      }
      fn();
    };

    try {
      socket = new WebSocket(targetUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to open enrollment socket'));
      return;
    }

    socket.onopen = () => {
      const request: Record<string, unknown> = {
        type: 'enroll',
        client: 'pentacle-mobile',
        code: code.trim().toUpperCase(),
      };
      if (protocolVersion === 2) {
        request.protocol_version = 2;
        request.scheme = 'hmac-sha256-v2';
      }
      socket?.send(JSON.stringify(request));
    };

    socket.onmessage = (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data || ''));
      } catch {
        finish(() => reject(new Error('Enrollment response malformed')));
        return;
      }
      if (message.type === 'enroll.ok') {
        const token = typeof message.token === 'string' ? message.token : '';
        const metadataMatches = message.protocol_version === protocolVersion
          && message.scheme === (protocolVersion === 2 ? 'hmac-sha256-v2' : 'shared-bearer-v1')
          && message.client_kind === 'pentacle-mobile';
        let tokenMatches = Boolean(token);
        if (metadataMatches && tokenMatches && protocolVersion === 2) {
          try {
            parseOperatorAuthV2Envelope(token);
          } catch {
            tokenMatches = false;
          }
        }
        if (metadataMatches && tokenMatches && protocolVersion === 1) {
          tokenMatches = !token.startsWith(OPERATOR_AUTH_V2_PREFIX);
        }
        if (!metadataMatches || !tokenMatches) {
          finish(() => reject(new Error('Enrollment response protocol mismatch')));
          return;
        }
        finish(() => resolve({ token }));
        return;
      }
      if (message.type === 'enroll.error') {
        finish(() => reject(new Error(String(message.error || 'Enrollment failed'))));
        return;
      }
      if (message.type !== 'welcome') {
        finish(() => reject(new Error('Enrollment response malformed')));
      }
    };

    socket.onerror = () => {
      finish(() => reject(new Error('Pentacle enrollment connection failed')));
    };

    socket.onclose = () => {
      if (!settled) {
        finish(() => reject(new Error('Pentacle enrollment connection closed')));
      }
    };
  });
}

export function enrollPentacleDevice(code: string, urlOverride?: string | null): Promise<{ token: string }> {
  return enrollPentacleDeviceWithProtocol(code, urlOverride, 2);
}

export function enrollPentacleDeviceLegacy(code: string, urlOverride?: string | null): Promise<{ token: string }> {
  return enrollPentacleDeviceWithProtocol(code, urlOverride, 1);
}

export function usePentacleStream() {
  const snapshot = useSyncExternalStore(
    subscribePentacleStream,
    getPentacleStreamState,
  );

  return {
    ...snapshot,
    ...streamActions,
  };
}

export function usePentacleStreamSelector<T>(
  selector: (snapshot: PentacleStreamState) => T,
  isEqual?: (a: T, b: T) => boolean,
) {
  return useSyncExternalStoreWithSelector(
    subscribePentacleStream,
    getPentacleStreamState,
    getPentacleStreamState,
    selector,
    isEqual,
  );
}

export function usePentacleStreamSelectorWhen<T>(
  enabled: boolean,
  selector: (snapshot: PentacleStreamState) => T,
  isEqual?: (a: T, b: T) => boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) => subscribePentacleStreamWhen(enabled, listener),
    [enabled],
  );

  return useSyncExternalStoreWithSelector(
    subscribe,
    getPentacleStreamState,
    getPentacleStreamState,
    selector,
    isEqual,
  );
}

export function usePentacleStreamActions() {
  return streamActions;
}
