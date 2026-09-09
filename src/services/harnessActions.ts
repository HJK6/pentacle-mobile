/**
 * Harness-only: on-device action handlers for the Stage 2 compose-driving
 * actions in public behavior contract.
 *
 * Each handler:
 *   - Emits `harness:<action>_scheduled` immediately.
 *   - Performs the work (router push, dispatchSend, settings toggle, etc.).
 *   - Emits the terminal `_done` / `_sent` / `_closed` / `_aborted` /
 *     `_skipped` event with payload typed per the spec.
 *
 * Handlers compose at module boundaries (router, pentacleStream actions,
 * userPreferences, harnessRuntime, telemetry) so unit tests can drive
 * them with thin mocks rather than reaching into the implementation.
 *
 * Production builds dead-code this module because the only caller site
 * (`app/_layout.tsx` under `process.env.EXPO_PUBLIC_HARNESS === '1'`) is
 * removed at bundle time.
 */
import { buildPentacleQuestionAnswerText, logTelemetry, teeTelemetrySink, type PentacleQuestionAnswerValue, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type {
  NotificationActionKind,
  PentacleNotification,
  PentacleQuestion,
  PentacleSessionSummary,
} from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from './mobileTelemetryEvents';
import { logMobileTabsTelemetry } from './mobileTabsTelemetry';
import * as harnessRuntime from '../utils/harnessRuntime';
import { validateSpawnObjective } from './spawnObjective';
import { performHarnessChatOpen } from './chatOpenNavigation';
import { validateSpawnCatalog } from './spawnCatalog';
import { createSpawnIntentKeeper, executeSpawnIntent } from './spawnIntent';

type RouterLike = {
  push: (href: any) => void;
  replace?: (href: any) => void;
};

type SpawnRpcDispatchHooks = {
  onDispatched?: (requestId: string, generation: number) => void;
  onSocketSent?: (requestId: string, generation: number) => void;
};

type StreamActionsLike = {
  sendMessage: (args: { host: string; sessionName: string; text: string }) => Promise<unknown>;
  appendOptimisticUserMessage: (streamId: string, text: string) => string;
  getSpawnCatalog: (hooks?: SpawnRpcDispatchHooks) => Promise<unknown>;
  spawnSessionV2: (args: {
    host: string;
    provider: 'claude' | 'codex';
    model: string;
    effort: string;
    spawnProfile: 'desktop_manual';
    catalogVersion: string;
    resolutionSource: 'profile_default';
    objective: string;
    no_watch?: boolean;
    idempotencyKey: string;
    onDispatched?: (requestId: string, generation: number) => void;
    onSocketSent?: (requestId: string, generation: number) => void;
  }) => Promise<{
    session: PentacleSessionSummary;
    requested?: Record<string, unknown>;
    resolved?: Record<string, unknown>;
    actual_launch?: Record<string, unknown>;
    resolution_source?: string;
    catalog_version?: string;
  }>;
  renameSession?: (args: { host: string; sessionName: string; displayName: string }) => Promise<unknown>;
  closeSession?: (args: { host: string; sessionName: string; streamId: string }) => Promise<unknown>;
  forcePendingClose?: (streamId: string) => Promise<unknown>;
};

type UserPreferencesLike = {
  getUserPreference: <K extends BooleanUserPreferenceKey>(key: K) => boolean;
  setUserPreference: <K extends BooleanUserPreferenceKey>(key: K, value: boolean) => Promise<void>;
};

type BooleanUserPreferenceKey = 'showToolActions' | 'showTurnDuration';

type ForceCloseWsLike = (reason?: string) => boolean;

const DEFAULT_RECONCILE_TIMEOUT_MS = 30000;
const RESOLVE_NOTIFICATION_TIMEOUT_MS = 20000;
const DISMISS_QUESTION_TIMEOUT_MS = 150000;
const HARNESS_DISMISS_QUESTION_SCHEDULED = 'harness:dismiss_question_scheduled' as Parameters<typeof logTelemetry>[0];
const HARNESS_DISMISS_QUESTION_SENT = 'harness:dismiss_question_sent' as Parameters<typeof logTelemetry>[0];
const HARNESS_DISMISS_QUESTION_SKIPPED = 'harness:dismiss_question_skipped' as Parameters<typeof logTelemetry>[0];
const HARNESS_SEND_FIXTURE_IMAGE_SENT =
  MOBILE_TELEMETRY_EVENTS.HARNESS_SEND_FIXTURE_IMAGE_SENT as Parameters<typeof logTelemetry>[0];
const HARNESS_UI_TRACE =
  MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0];

export const DISMISS_QUESTION_TELEMETRY_EVENTS = {
  SCHEDULED: HARNESS_DISMISS_QUESTION_SCHEDULED,
  SENT: HARNESS_DISMISS_QUESTION_SENT,
  SKIPPED: HARNESS_DISMISS_QUESTION_SKIPPED,
} as const;

const DISCONNECT_OPTIMISTIC_WAIT_MS = 5000;
const DISCONNECT_POST_OPTIMISTIC_GRACE_MS = 35;
const DISCONNECT_SEND_DISPATCH_WAIT_MS = 250;
const MOUNT_SETTLE_TIMEOUT_MS = 10000;
const WS_READY_TIMEOUT_MS = 15000;
const DEFAULT_SEND_TEXT = 'say your name';
const FAILED_ROW_TO_LIFECYCLE_GRACE_MS = 250;
const HARNESS_OPEN_CHAT_WHILE_WS_DOWN_SCHEDULED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_SCHEDULED;
const HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE =
  MOBILE_TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE;
const HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED;
const HARNESS_DISCONNECT_BEFORE_SEND_SCHEDULED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_DISCONNECT_BEFORE_SEND_SCHEDULED as Parameters<typeof logTelemetry>[0];
const HARNESS_DISCONNECT_BEFORE_SEND_CLOSED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_DISCONNECT_BEFORE_SEND_CLOSED as Parameters<typeof logTelemetry>[0];
const HARNESS_DISCONNECT_BEFORE_SEND_ABORTED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_DISCONNECT_BEFORE_SEND_ABORTED as Parameters<typeof logTelemetry>[0];
const CHAT_HISTORY_BACKFILL_RENDERED =
  MOBILE_TELEMETRY_EVENTS.CHAT_HISTORY_BACKFILL_RENDERED;
const HARNESS_RETRY_FAILED_SEND_SCHEDULED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SCHEDULED as Parameters<typeof logTelemetry>[0];
const HARNESS_RETRY_FAILED_SEND_SENT =
  MOBILE_TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SENT as Parameters<typeof logTelemetry>[0];
const HARNESS_RETRY_FAILED_SEND_SKIPPED =
  MOBILE_TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SKIPPED as Parameters<typeof logTelemetry>[0];

type FlowContext = {
  streamId: string | null;
  lastOptimisticId: string | null;
};

// Module-level scratch state tracked across action invocations within a
// single scenario run. F1 / F2 store the most recently produced
// `optimistic_id` here so `send_again` can scope its reconcile-wait.
const flowContext: FlowContext = { streamId: null, lastOptimisticId: null };
let spawnIntentKeeper = createSpawnIntentKeeper();

/** Tests only. */
export function __resetFlowContextForTests(): void {
  flowContext.streamId = null;
  flowContext.lastOptimisticId = null;
  spawnIntentKeeper = createSpawnIntentKeeper();
}

/** Tests only. */
export function __getFlowContextForTests(): FlowContext {
  return { ...flowContext };
}

/** Tests only. */
export function __setFlowContextForTests(next: Partial<FlowContext>): void {
  if (Object.prototype.hasOwnProperty.call(next, 'streamId')) {
    flowContext.streamId = next.streamId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'lastOptimisticId')) {
    flowContext.lastOptimisticId = next.lastOptimisticId ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForTelemetry(
  predicate: (payload: TelemetryPayload) => boolean,
  timeoutMs: number,
): Promise<TelemetryPayload | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: TelemetryPayload | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      restore();
      resolve(value);
    };
    const restore = teeTelemetrySink((payload) => {
      if (settled) return;
      try {
        if (predicate(payload)) finish(payload);
      } catch {
        // predicate must not throw; on accident, log and keep waiting
      }
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 16);
    };
    poll();
  });
}

function logHarnessTrace(kind: string, data: Record<string, unknown> = {}) {
  logTelemetry(HARNESS_UI_TRACE, {
    kind,
    timestamp_emitter_wall: Date.now(),
    ...data,
  });
}

function spawnRpcDispatchHooks(
  requestType: 'spawn' | 'spawn_catalog_get',
  requestPrefix: 'spawn.v2' | 'spawn_catalog_get',
  schema: 'SpawnRequestV2' | null,
): SpawnRpcDispatchHooks {
  const emit = (stage: 'dispatch-attempt' | 'local-websocket-send-return') => (
    requestId: string,
    socketGeneration: number,
  ) => logHarnessTrace('spawn_rpc_request_metadata', {
    stage,
    request_type: requestType,
    request_prefix: requestPrefix,
    schema,
    request_id: requestId,
    socket_generation: socketGeneration,
  });
  return {
    onDispatched: emit('dispatch-attempt'),
    onSocketSent: emit('local-websocket-send-return'),
  };
}

function isAuthoritativeContentRender(payload: TelemetryPayload, streamId: string): boolean {
  if (payload.message !== TELEMETRY_EVENTS.CHAT_EVENT_RENDERED) return false;
  if (String(payload.data.stream_id || '') !== streamId) return false;
  if (!['USER', 'ASSIST', 'SYSTEM'].includes(String(payload.data.kind || ''))) return false;
  if (String(payload.data.display_rule || '') === 'system:blank') return false;
  const seq = Number(payload.data.seq);
  return Number.isFinite(seq) && seq >= 0;
}

/**
 * Wait for the WS to be stably OPEN before issuing sendCommand-backed APIs.
 *
 * Action handlers run from the harness arming callback, which fires BEFORE
 * pentacleStream.connect() resolves. The initial WS opens, then closes
 * within ~50ms when the auth-token refresh (from `disable_pentacle_auth`)
 * triggers a reconnect. A naïve "wait for first ws_open" gate resolves on
 * the dying socket — the spawnSession message is queued on it but the
 * close swallows the request before chat_streamd receives it.
 *
 * Stability = ws_open fired AND no ws_close within `stableMs` after. If a
 * close lands inside the window, we reset and wait for the NEXT ws_open.
 *
 * Returns false on timeout so the caller can emit a clear SETUP_FAIL.
 */
function waitForWsOpen(
  timeoutMs: number = WS_READY_TIMEOUT_MS,
  stableMs: number = 250,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (stableTimer) clearTimeout(stableTimer);
      clearTimeout(deadline);
      restore();
      resolve(ok);
    };
    const restore = teeTelemetrySink((payload) => {
      if (settled) return;
      if (payload.message === TELEMETRY_EVENTS.CHAT_WS_OPEN) {
        opened = true;
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => finish(true), stableMs);
      } else if (payload.message === TELEMETRY_EVENTS.CHAT_WS_CLOSE && opened) {
        // Reset: the just-opened socket closed before the stability window
        // elapsed. Wait for the next ws_open.
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }
      }
    });
    const deadline = setTimeout(() => finish(false), timeoutMs);
  });
}

async function waitForHarnessReadyWs(
  timeoutMs: number = WS_READY_TIMEOUT_MS,
  stableMs: number = 250,
): Promise<boolean> {
  const tokenReady = await harnessRuntime.whenHarnessTokenReady(Math.min(5000, timeoutMs));
  if (!tokenReady) return false;
  return waitForWsOpen(timeoutMs, stableMs);
}

function waitForSessionMountAndSettle(
  streamId: string,
  timeoutMs: number = MOUNT_SETTLE_TIMEOUT_MS,
): Promise<{ mounted: boolean; settled: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let mounted = false;
    let transcriptSettled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      restore();
      resolve({ mounted, settled: transcriptSettled });
    };
    const restore = teeTelemetrySink((payload) => {
      if (settled) return;
      if (
        (
          payload.message === TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT ||
          (payload.message === HARNESS_UI_TRACE && payload.data.kind === 'session_screen_mount')
        ) &&
        String(payload.data.stream_id || '') === streamId
      ) {
        mounted = true;
      }
      if (
        payload.message === TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED &&
        String(payload.data.stream_id || '') === streamId
      ) {
        transcriptSettled = true;
      }
      if (mounted && transcriptSettled) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

type OpenSettleOutcome = { mounted: boolean; painted: boolean; transcriptSettled: boolean };

/**
 * Resolve when the opened chat has PAINTED its first authoritative row AND its
 * transcript settle has fired. Paint can only emit after the session screen
 * focused and acked its navigation intent, so it subsumes focus, ack, and the
 * row — and it is the exact signal `chat_open_slo` counts as a complete latency
 * sample. But the per-open `open_settle` bucket_cost_sample is emitted from the
 * screen's transcript-settle effect (`emitBucketCostOpenSettle`), and on a fast
 * Release build the paint can land BEFORE that settle. Advancing (and thus
 * tearing the screen down) on paint alone cancels the pending settle effect, so
 * the open never contributes its `open_settle` sample — 13/20 opens dropped it
 * on the build-1155 run, leaving only 7 open_settle + 13 corpus-load `interval`
 * samples and spuriously failing the completeness gate. Waiting for the settle
 * too makes every open contribute exactly one `open_settle` regardless of open
 * speed, without touching the paint-phase latency timestamps. Bounded by the
 * caller's per-open timeout, so a missing paint/settle is an honest INCOMPLETE
 * sample rather than a structurally impossible one.
 */
function waitForSessionMountAndPaint(
  streamId: string,
  timeoutMs: number = MOUNT_SETTLE_TIMEOUT_MS,
): Promise<OpenSettleOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let mounted = false;
    let painted = false;
    let transcriptSettled = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      restore();
      resolve({ mounted, painted, transcriptSettled });
    };
    const restore = teeTelemetrySink((payload) => {
      if (done) return;
      const data = payload.data as Record<string, unknown>;
      if (
        (
          payload.message === TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT ||
          (payload.message === HARNESS_UI_TRACE && data.kind === 'session_screen_mount')
        ) &&
        String(data.stream_id || '') === streamId
      ) {
        mounted = true;
      }
      if (
        payload.message === HARNESS_UI_TRACE &&
        data.kind === 'chat_open_paint' &&
        data.phase === 'first-authoritative-row-mount' &&
        String(data.stream_id || '') === streamId
      ) {
        painted = true;
      }
      if (
        payload.message === TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED &&
        String(data.stream_id || '') === streamId
      ) {
        transcriptSettled = true;
      }
      if (mounted && painted && transcriptSettled) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

function waitForSessionMount(
  streamId: string,
  timeoutMs: number = MOUNT_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (mounted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      restore();
      resolve(mounted);
    };
    const restore = teeTelemetrySink((payload) => {
      if (
        (
          payload.message === TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT ||
          (payload.message === HARNESS_UI_TRACE && payload.data.kind === 'session_screen_mount')
        ) &&
        String(payload.data.stream_id || '') === streamId
      ) {
        finish(true);
      }
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Wait for the ComposerBar's send-handler registration useEffect to fire.
// `harnessRuntime.registerSendHandler` emits
// `harness:send_handler_registered{stream_id}` so by the time this resolves
// the handler is guaranteed to be in the sendHandlers map. Otherwise
// `dispatchSend` races the registration on fast cold launches and returns
// `no_handler`. Spec:
// public behavior contract.
//
// Fast path: if the handler is already registered (registerSendHandler
// fired BEFORE this wait started), `harnessRuntime.hasSendHandler` returns
// true and we resolve immediately — the prior telemetry emit can't be
// observed by a tee that wasn't registered at the time.
function waitForSendHandlerRegistered(
  streamId: string,
  timeoutMs: number = MOUNT_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  if (harnessRuntime.hasSendHandler(streamId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      restore();
      resolve(ok);
    };
    const restore = teeTelemetrySink((payload) => {
      if (settled) return;
      if (
        payload.message === TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED &&
        String(payload.data.stream_id || '') === streamId
      ) {
        finish(true);
      }
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// spawn_chat_then_send
// ---------------------------------------------------------------------------

export type SpawnChatThenSendDeps = {
  host: string;
  provider: 'claude' | 'codex';
  text?: string;
  router: RouterLike;
  streamActions: StreamActionsLike;
  /** Tests only — override the send-handler-registration wait. */
  handlerRegisterTimeoutMs?: number;
  forceCloseBeforeSend?: boolean;
  forceCloseWs?: ForceCloseWsLike;
  closeTimeoutMs?: number;
};

export async function runSpawnChatThenSend(deps: SpawnChatThenSendDeps): Promise<void> {
  const text = deps.text || DEFAULT_SEND_TEXT;
  // Navigate to Chats tab so the spawn path matches the in-app user flow
  // (the +-new-chat button lives on Chats). The actual spawn is driven by
  // the production V2 spawn action below rather than tapping the
  // button — the navigation push is for visual fidelity / preflight
  // alignment with the manual flow. Swallow router errors: on cold launch
  // the harness arming callback fires before the Root Layout mounts, and
  // expo-router throws "Attempted to navigate before mounting the Root
  // Layout component." The spawn does not depend on this nav, so the
  // throw must not abort the flow.
  try { deps.router.push('/(tabs)/chats'); } catch {}
  // Wait for the WS to be OPEN before issuing the spawn — the harness
  // arming callback fires before pentacleStream.connect() resolves, so a
  // pre-connect spawnSession() would immediately reject. The _SCHEDULED
  // telemetry fires AFTER the wait so the scenario sees ws_open precede
  // spawn_scheduled. Surface the wait failure as a SETUP_FAIL-flavored
  // _sent emit so the scenario reports a clear reason rather than a
  // generic missing-event failure.
  const wsReady = await waitForHarnessReadyWs();
  if (!wsReady) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
      status: 'ws_not_ready',
      host: deps.host,
      provider: deps.provider,
    });
    return;
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED, {
    host: deps.host,
    provider: deps.provider,
  });
  let session;
  try {
    const catalog = validateSpawnCatalog(await deps.streamActions.getSpawnCatalog(
      spawnRpcDispatchHooks('spawn_catalog_get', 'spawn_catalog_get', null),
    ));
    const [model, effort] = catalog.profiles.desktop_manual[deps.provider]!;
    logTelemetry(HARNESS_UI_TRACE, {
      kind: 'spawn_tuple_metadata',
      stage: 'requested',
      profile: 'desktop_manual',
      model,
      effort,
      catalog_version: catalog.catalog_version,
    });
    // The daemon refuses an objective-less SpawnRequestV2; a fixture that omits `spawn_objective`
    // must fail here, before any frame is sent, rather than emit an empty objective.
    const objectiveCheck = validateSpawnObjective(harnessRuntime.getParam('spawn_objective'));
    if (!objectiveCheck.ok) {
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
        status: 'objective_invalid',
        host: deps.host,
        provider: deps.provider,
      });
      return;
    }
    const result = await executeSpawnIntent(
      spawnIntentKeeper,
      {
        host: deps.host,
        provider: deps.provider,
        model,
        effort,
        catalogVersion: catalog.catalog_version,
      },
      (idempotencyKey) => deps.streamActions.spawnSessionV2({
        host: deps.host,
        provider: deps.provider,
        model,
        effort,
        spawnProfile: 'desktop_manual',
        catalogVersion: catalog.catalog_version,
        resolutionSource: 'profile_default',
        objective: objectiveCheck.value,
        idempotencyKey,
        ...spawnRpcDispatchHooks('spawn', 'spawn.v2', 'SpawnRequestV2'),
      }),
    );
    const resolved = result.resolved || {};
    logTelemetry(HARNESS_UI_TRACE, {
      kind: 'spawn_tuple_metadata',
      stage: 'resolved',
      model: typeof resolved.model === 'string' ? resolved.model : null,
      effort: typeof resolved.effort === 'string' ? resolved.effort : null,
      resolution_source: result.resolution_source || null,
      catalog_version: result.catalog_version || catalog.catalog_version,
    });
    session = result.session;
    const runId = harnessRuntime.getParam('scenario_run_id') || harnessRuntime.getParam('run_id') || '';
  } catch (err) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
      status: 'spawn_rejected',
      host: deps.host,
      provider: deps.provider,
      error: String((err as Error)?.message || err),
    });
    return;
  }
  const streamId = session.stream_id;
  flowContext.streamId = streamId;
  // Mark this stream active for the harness telemetry mirror — only events
  // for active streams emit [TELEMETRY] (production behavior is unchanged).
  harnessRuntime.markStreamHarnessActive(streamId);
  performHarnessChatOpen(streamId, deps.router);

  const runId = harnessRuntime.getParam('scenario_run_id') || harnessRuntime.getParam('run_id') || '';
  if (runId && deps.streamActions.renameSession) {
    void deps.streamActions.renameSession({
      host: session.host || deps.host,
      sessionName: session.session_name,
      displayName: `[e2e:${runId}] ${deps.host} ${deps.provider} harness`,
    }).catch((err) => {
      logHarnessTrace('spawn_metadata_rename_failed', {
        stream_id: streamId,
        error: String((err as Error)?.message || err),
      });
    });
  }

  await waitForSessionMountAndSettle(streamId);
  if (!await waitForSendHandlerRegistered(streamId, deps.handlerRegisterTimeoutMs)) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
      stream_id: streamId, status: 'handler_not_ready',
    });
    return;
  }

  if (deps.forceCloseBeforeSend) {
    logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_SCHEDULED, { stream_id: streamId });
    const closePromise = waitForTelemetry(
      (payload) => payload.message === TELEMETRY_EVENTS.CHAT_WS_CLOSE,
      deps.closeTimeoutMs ?? MOUNT_SETTLE_TIMEOUT_MS,
    );
    if (!deps.forceCloseWs?.('harness_forced')) {
      logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_ABORTED, {
        reason: 'close_not_issued',
        stream_id: streamId,
      });
      return;
    }
    if (!await closePromise) {
      logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_ABORTED, {
        reason: 'close_not_observed',
        stream_id: streamId,
      });
      return;
    }
    logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_CLOSED, { stream_id: streamId });
  }

  logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED, {
    stream_id: streamId,
    text,
  });
  // Capture the optimistic_id by intercepting the next emit; both
  // appendOptimisticUserMessage (inside the registered send handler) and
  // logTelemetry fire synchronously off the same call.
  const optimisticPromise = waitForTelemetry(
    (payload) =>
      payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT &&
      String(payload.data.stream_id || '') === streamId,
    1000,
  );
  let result: { status: string } = { status: 'ok' };
  let dispatchError = '';
  try {
    result = await harnessRuntime.dispatchSend(streamId, text);
  } catch (err) {
    result = { status: 'dispatch_error' };
    dispatchError = String((err as Error)?.message || err);
  }
  const optimisticPayload = await optimisticPromise;
  if (optimisticPayload) {
    flowContext.lastOptimisticId = String(optimisticPayload.data.optimistic_id || '');
  }
  if (result.status !== 'ok' && flowContext.lastOptimisticId) {
    const reconciled = await waitForTelemetry(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED &&
        String(payload.data.optimistic_id || '') === flowContext.lastOptimisticId,
      DEFAULT_RECONCILE_TIMEOUT_MS,
    );
    if (reconciled) result = { status: 'ok' };
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
    stream_id: streamId,
    status: result.status,
    ...(flowContext.lastOptimisticId ? { optimistic_id: flowContext.lastOptimisticId } : {}),
    ...(dispatchError && result.status !== 'ok' ? { error: dispatchError } : {}),
  });
}

// ---------------------------------------------------------------------------
// open_chat_then_send
// ---------------------------------------------------------------------------

export type OpenChatThenSendDeps = {
  host: string;
  provider?: 'claude' | 'codex';
  text?: string;
  attemptOpenExistingChat: (host: string, provider?: 'claude' | 'codex') => string | null;
  streamIdOverride?: string;
  router?: RouterLike;
  /** Tests only — override the send-handler-registration wait. */
  handlerRegisterTimeoutMs?: number;
  /** Tests only — override the inventory-arrival poll deadline. */
  inventoryPollTimeoutMs?: number;
  forceCloseBeforeSend?: boolean;
  forceCloseWs?: ForceCloseWsLike;
  closeTimeoutMs?: number;
};

export async function runOpenChatThenSend(deps: OpenChatThenSendDeps): Promise<void> {
  const text = deps.text || DEFAULT_SEND_TEXT;
  // Wait for WS open before invoking attemptOpenExistingChat — the
  // session inventory used by pickSession is only populated after the
  // initial chat.inventory broadcast that follows ws_open. The _SCHEDULED
  // telemetry fires AFTER the wait so the scenario sees ws_open precede
  // open_chat_then_send_scheduled.
  const wsReady = await waitForHarnessReadyWs();
  if (!wsReady) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT, {
      status: 'no_handler',
      reason: 'ws_not_ready',
    });
    return;
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SCHEDULED, {
    host: deps.host,
    provider: deps.provider,
  });
  // Poll attemptOpenExistingChat — the session inventory arrives via the
  // hello-snapshot broadcast which lands asynchronously AFTER ws_open. On
  // fast cold launches the call right after waitForWsOpen would see an
  // empty state.sessions and bail with no_existing_chat. Spec:
  // public behavior contract (summary
  // mode made the snapshot small enough that the race got worse).
  let streamId: string | null = String(deps.streamIdOverride || '').trim() || null;
  const inventoryPollTimeout = deps.inventoryPollTimeoutMs ?? 5000;
  const inventoryDeadline = Date.now() + inventoryPollTimeout;
  // Always try at least once so callers with timeout=0 (tests) still get
  // a chance to observe the no_existing_chat path.
  if (streamId) {
    harnessRuntime.markStreamHarnessActive(streamId);
    if (deps.router) performHarnessChatOpen(streamId, deps.router);
  } else {
    streamId = deps.attemptOpenExistingChat(deps.host, deps.provider);
    while (!streamId && Date.now() < inventoryDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      streamId = deps.attemptOpenExistingChat(deps.host, deps.provider);
    }
  }
  if (!streamId) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT, {
      status: 'no_handler',
      reason: 'no_existing_chat',
    });
    return;
  }
  flowContext.streamId = streamId;
  harnessRuntime.markStreamHarnessActive(streamId);

  await waitForSessionMountAndSettle(streamId);
  if (!await waitForSendHandlerRegistered(streamId, deps.handlerRegisterTimeoutMs)) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT, {
      stream_id: streamId, status: 'handler_not_ready',
    });
    return;
  }

  if (deps.forceCloseBeforeSend) {
    logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_SCHEDULED, { stream_id: streamId });
    const closePromise = waitForTelemetry(
      (payload) => payload.message === TELEMETRY_EVENTS.CHAT_WS_CLOSE,
      deps.closeTimeoutMs ?? MOUNT_SETTLE_TIMEOUT_MS,
    );
    if (!deps.forceCloseWs?.('harness_forced')) {
      logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_ABORTED, {
        reason: 'close_not_issued',
        stream_id: streamId,
      });
      return;
    }
    if (!await closePromise) {
      logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_ABORTED, {
        reason: 'close_not_observed',
        stream_id: streamId,
      });
      return;
    }
    logTelemetry(HARNESS_DISCONNECT_BEFORE_SEND_CLOSED, { stream_id: streamId });
  }

  const optimisticPromise = waitForTelemetry(
    (payload) =>
      payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT &&
      String(payload.data.stream_id || '') === streamId,
    1000,
  );
  const result = await harnessRuntime.dispatchSend(streamId, text);
  const optimisticPayload = await optimisticPromise;
  if (optimisticPayload) {
    flowContext.lastOptimisticId = String(optimisticPayload.data.optimistic_id || '');
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT, {
    stream_id: streamId,
    status: result.status,
    ...(flowContext.lastOptimisticId ? { optimistic_id: flowContext.lastOptimisticId } : {}),
  });
}

export type SendFixtureImageDeps = {
  host: string;
  provider?: 'claude' | 'codex';
  text?: string;
  imageBase64: string;
  imageMimeType?: 'image/jpeg' | 'image/png';
  imageName?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageBytes?: number;
  attemptOpenExistingChat: (host: string, provider?: 'claude' | 'codex') => string | null;
  handlerRegisterTimeoutMs?: number;
  inventoryPollTimeoutMs?: number;
};

export type CompositeChatLoadDeps = {
  host: string;
  provider?: 'claude' | 'codex';
  initialStreamId?: string;
  // Multi-target open seam: an ordered list of DISTINCT stream_ids, consumed
  // one-per-open (open i visits openTargetStreamIds[i]) so a scenario can drive
  // N distinct-stream COLD opens instead of repeating initialStreamId. Harness
  // only; when absent the probe keeps its single-target behavior.
  openTargetStreamIds?: string[];
  text?: string;
  imageBase64: string;
  imageMimeType?: 'image/jpeg' | 'image/png';
  imageName?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageBytes?: number;
  router: RouterLike;
  attemptOpenExistingChat: (
    host: string,
    provider?: 'claude' | 'codex',
    streamIdOverride?: string | null,
  ) => string | null;
  getStreamPhase?: (streamId: string) => string | undefined;
  getSessionSummary?: (streamId: string) => {
    stream_id: string;
    host: string;
    provider?: string;
    session_name: string;
  } | null;
  streamActions?: Pick<StreamActionsLike, 'closeSession' | 'forcePendingClose'>;
  preOpenWaitMs?: number;
  repeatCount?: number;
  sendCount?: number;
  listDwellMs?: number;
  mountTimeoutMs?: number;
  handlerRegisterTimeoutMs?: number;
  workingWaitTimeoutMs?: number;
  inventoryPollTimeoutMs?: number;
  waitForSessionMount?: (streamId: string, timeoutMs: number) => Promise<boolean>;
  jsProbeIntervalMs?: number;
  createDeleteStreamId?: string;
  createDeleteSessionName?: string;
  createDeleteStartDelayMs?: number;
  createDeleteTimeoutMs?: number;
  createDeleteDwellMs?: number;
};

export type RetryFailedSendDeps = {
  retryOptimisticSend: (optimisticId: string) => void;
  streamId?: string;
  optimisticId?: string;
  timeoutMs?: number;
};

export async function runSendFixtureImage(deps: SendFixtureImageDeps): Promise<void> {
  const wsReady = await waitForHarnessReadyWs();
  if (!wsReady) return;
  let streamId: string | null = flowContext.streamId;
  const inventoryPollTimeout = deps.inventoryPollTimeoutMs ?? 5000;
  const inventoryDeadline = Date.now() + inventoryPollTimeout;
  if (!streamId) {
    streamId = deps.attemptOpenExistingChat(deps.host, deps.provider);
    while (!streamId && Date.now() < inventoryDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      streamId = deps.attemptOpenExistingChat(deps.host, deps.provider);
    }
  }
  if (!streamId) return;
  flowContext.streamId = streamId;
  harnessRuntime.markStreamHarnessActive(streamId);
  await waitForSessionMountAndSettle(streamId);
  if (!await waitForSendHandlerRegistered(streamId, deps.handlerRegisterTimeoutMs)) {
    logTelemetry(HARNESS_SEND_FIXTURE_IMAGE_SENT, {
      stream_id: streamId, status: 'handler_not_ready',
    });
    return;
  }

  const optimisticPromise = waitForTelemetry(
    (payload) =>
      payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT &&
      String(payload.data.stream_id || '') === streamId,
    1000,
  );
  const dispatchPromise = harnessRuntime.dispatchSend(streamId, {
    text: deps.text ?? '',
    fixtureImage: {
      name: deps.imageName,
      base64: deps.imageBase64,
      mimeType: deps.imageMimeType ?? 'image/png',
      width: deps.imageWidth,
      height: deps.imageHeight,
      bytes: deps.imageBytes,
    },
  })
    .catch((): { status: string } | null => null);
  const optimisticPayload = await optimisticPromise;
  if (optimisticPayload) {
    flowContext.lastOptimisticId = String(optimisticPayload.data.optimistic_id || '');
  }
  const result = optimisticPayload ? { status: 'ok' } : await dispatchPromise;
  logTelemetry(HARNESS_SEND_FIXTURE_IMAGE_SENT, {
    stream_id: streamId,
    status: result?.status ?? (flowContext.lastOptimisticId ? 'ok' : 'error'),
    ...(flowContext.lastOptimisticId ? { optimistic_id: flowContext.lastOptimisticId } : {}),
    has_text: Boolean(String(deps.text ?? '').trim()),
    attachment_count: 1,
    image_mime: deps.imageMimeType ?? 'image/png',
    ...(deps.imageName ? { image_name: deps.imageName } : {}),
  });
  await dispatchPromise;
}

function startJsBlockProbe(intervalMs: number) {
  const interval = Math.max(16, intervalMs);
  let samples = 0;
  let maxDriftMs = 0;
  const drifts: number[] = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const drift = Math.max(0, now - last - interval);
    samples += 1;
    maxDriftMs = Math.max(maxDriftMs, drift);
    drifts.push(drift);
    last = now;
  }, interval);
  return {
    stop() {
      clearInterval(timer);
      const sorted = drifts.slice().sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const trimCount = Math.floor(sorted.length * 0.2);
      const trimmed = trimCount > 0 ? sorted.slice(0, sorted.length - trimCount) : sorted;
      const trimmedMax = trimmed.length ? trimmed[trimmed.length - 1] : 0;
      return {
        samples,
        max_drift_ms: Math.round(maxDriftMs),
        median_drift_ms: Math.round(median),
        trimmed_max_drift_ms: Math.round(trimmedMax),
        drift_metric: 'median_drift_ms',
        drift_trim_fraction: 0.2,
      };
    },
  };
}

async function waitForCompositeQueuedState(
  streamId: string,
  getPhase: ((streamId: string) => string | undefined) | undefined,
  timeoutMs: number,
): Promise<{ phase: string | null; composerWorking: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const phase = getPhase?.(streamId) ?? null;
    const composerWorking = harnessRuntime.isSendHandlerWorking(streamId);
    if (phase === 'working' && composerWorking) return { phase, composerWorking };
    await delay(50);
  }
  return {
    phase: getPhase?.(streamId) ?? null,
    composerWorking: harnessRuntime.isSendHandlerWorking(streamId),
  };
}

async function attemptOpenExistingChatWithPoll(
  deps: CompositeChatLoadDeps,
  streamId: string | null,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  if (streamId) {
    const session = deps.getSessionSummary?.(streamId);
    logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED, {
      stream_id: streamId,
      host: session?.host || deps.host,
      stream_id_override: true,
    });
    try { harnessRuntime.markStreamHarnessActive(streamId); } catch {}
    // The stream_id-override open is the SLO scenario's actual open path — it
    // returns here WITHOUT calling deps.attemptOpenExistingChat, so it must
    // route through the shared navigation unit itself or the chat_open_paint
    // trace never fires (the reason paint was 0 on the first measurement build).
    performHarnessChatOpen(streamId, deps.router);
    return streamId;
  }
  let opened = deps.attemptOpenExistingChat(deps.host, deps.provider, streamId);
  while (!opened && Date.now() < deadline) {
    await delay(50);
    opened = deps.attemptOpenExistingChat(deps.host, deps.provider, streamId);
  }
  return opened;
}

async function dispatchCompositeSend(
  deps: CompositeChatLoadDeps,
  streamId: string,
): Promise<void> {
  if (!await waitForSendHandlerRegistered(streamId, deps.handlerRegisterTimeoutMs)) {
    logHarnessTrace('composite_send_skipped', { stream_id: streamId, reason: 'handler_not_ready' });
    return;
  }
  const queuedState = await waitForCompositeQueuedState(
    streamId,
    deps.getStreamPhase,
    deps.workingWaitTimeoutMs ?? 4000,
  );
  const phase = queuedState.phase;
  logHarnessTrace('composite_send_before_dispatch', {
    stream_id: streamId,
    phase,
    composer_working: queuedState.composerWorking,
  });
  if (phase !== 'working' || !queuedState.composerWorking) return;

  const sendCount = Math.max(1, deps.sendCount ?? 1);
  const pending: Array<{
    optimisticId: string;
    promise: Promise<{ status: string } | null>;
    index: number;
  }> = [];
  for (let index = 0; index < sendCount; index += 1) {
    const optimisticPromise = waitForTelemetry(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT &&
        String(payload.data.stream_id || '') === streamId,
      1500,
    );
    const sendRequest = deps.imageBase64
      ? {
        text: deps.text ?? '',
        fixtureImage: {
          name: deps.imageName,
          base64: deps.imageBase64,
          mimeType: deps.imageMimeType ?? 'image/png' as const,
          width: deps.imageWidth,
          height: deps.imageHeight,
          bytes: deps.imageBytes,
        },
      }
      : (deps.text ?? '');
    const dispatchPromise = harnessRuntime.dispatchSend(streamId, sendRequest)
      .catch((): { status: string } | null => null);
    const optimisticPayload = await optimisticPromise;
    const optimisticId = String(optimisticPayload?.data.optimistic_id || '');
    if (optimisticId) flowContext.lastOptimisticId = optimisticId;
    logHarnessTrace('composite_send_dispatched', {
      stream_id: streamId,
      status: optimisticPayload ? 'ok' : 'error',
      optimistic_id: optimisticId,
      phase,
      send_index: index,
      send_count: sendCount,
    });
    pending.push({ optimisticId, promise: dispatchPromise, index });
  }
  for (const send of pending) {
    const terminalResult = await send.promise;
    logHarnessTrace('composite_send_sent', {
      stream_id: streamId,
      status: terminalResult?.status ?? 'error',
      optimistic_id: send.optimisticId,
      send_index: send.index,
      send_count: sendCount,
    });
  }
}

async function waitForCompositeSessionPresence(
  deps: CompositeChatLoadDeps,
  streamId: string,
  present: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = Boolean(deps.getSessionSummary?.(streamId));
    if (exists === present) return true;
    await delay(50);
  }
  return Boolean(deps.getSessionSummary?.(streamId)) === present;
}

async function runCompositeCreateDeleteUnderLoad(deps: CompositeChatLoadDeps): Promise<void> {
  const streamId = String(deps.createDeleteStreamId || '').trim();
  const timeoutMs = deps.createDeleteTimeoutMs ?? 6000;
  const startDelayMs = Math.max(0, deps.createDeleteStartDelayMs ?? 6000);
  logHarnessTrace('composite_create_delete_scheduled', {
    stream_id: streamId || null,
    start_delay_ms: startDelayMs,
    timeout_ms: timeoutMs,
  });
  if (!streamId) {
    logHarnessTrace('composite_create_delete_skipped', { reason: 'missing_stream_id' });
    return;
  }
  if (startDelayMs > 0) await delay(startDelayMs);

  try { deps.router.push('/(tabs)/chats'); } catch {}
  const createStartedAt = Date.now();
  logHarnessTrace('composite_create_start', { stream_id: streamId });
  const created = await waitForCompositeSessionPresence(deps, streamId, true, timeoutMs);
  const createSettledAt = Date.now();
  logHarnessTrace('composite_create_settled', {
    stream_id: streamId,
    status: created ? 'present' : 'timeout',
    duration_ms: createSettledAt - createStartedAt,
  });
  if (!created) return;

  if (deps.createDeleteDwellMs && deps.createDeleteDwellMs > 0) {
    await delay(deps.createDeleteDwellMs);
  }
  const session = deps.getSessionSummary?.(streamId);
  const closeSession = deps.streamActions?.closeSession;
  if (!session || !closeSession) {
    logHarnessTrace('composite_delete_settled', {
      stream_id: streamId,
      status: 'missing_close_action',
      duration_ms: 0,
    });
    return;
  }

  const deleteStartedAt = Date.now();
  logHarnessTrace('composite_delete_start', { stream_id: streamId });
  const closeResult = closeSession({
    host: session.host,
    sessionName: session.session_name || deps.createDeleteSessionName || streamId,
    streamId,
  }).then(
    () => 'ok',
    () => 'error',
  );
  const closeStatus = await Promise.race([
    closeResult,
    delay(250).then(() => 'pending'),
  ]);
  let forceStatus = 'not_requested';
  if (closeStatus === 'ok' && deps.streamActions?.forcePendingClose) {
    forceStatus = await deps.streamActions.forcePendingClose(streamId).then(
      () => 'ok',
      () => 'error',
    );
  }
  const deleted = await waitForCompositeSessionPresence(deps, streamId, false, timeoutMs);
  logHarnessTrace('composite_delete_settled', {
    stream_id: streamId,
    status: deleted ? 'absent' : 'timeout',
    close_status: closeStatus,
    force_status: forceStatus,
    duration_ms: Date.now() - deleteStartedAt,
  });
}

export async function runCompositeChatLoadProbe(deps: CompositeChatLoadDeps): Promise<void> {
  const repeatCount = Math.max(1, deps.repeatCount ?? 5);
  const listDwellMs = Math.max(0, deps.listDwellMs ?? 160);
  const preOpenWaitMs = Math.max(0, deps.preOpenWaitMs ?? 1800);
  const mountTimeoutMs = deps.mountTimeoutMs ?? MOUNT_SETTLE_TIMEOUT_MS;
  const probe = startJsBlockProbe(deps.jsProbeIntervalMs ?? 50);
  logHarnessTrace('composite_load_scheduled', {
    host: deps.host,
    provider: deps.provider,
    repeat_count: repeatCount,
    pre_open_wait_ms: preOpenWaitMs,
  });

  const tokenReady = await harnessRuntime.whenHarnessTokenReady(5000);
  if (!tokenReady) {
    const jsProbe = probe.stop();
    logHarnessTrace('composite_load_done', { status: 'token_not_ready', ...jsProbe });
    return;
  }

  if (preOpenWaitMs > 0) await delay(preOpenWaitMs);

  const openTargets = deps.openTargetStreamIds && deps.openTargetStreamIds.length > 0
    ? deps.openTargetStreamIds
    : null;
  let streamId: string | null = openTargets?.[0]
    || flowContext.streamId
    || deps.initialStreamId
    || null;
  let sent = false;
  let createDeletePromise: Promise<void> | null = null;
  for (let i = 0; i < repeatCount; i += 1) {
    // Multi-target mode: open a DISTINCT stream per iteration (cold first-visit),
    // consumed one-per-open from the ordered list (clamped to the last target if
    // repeatCount exceeds the list). Single-target mode keeps repeating the same
    // stream. This is the seam that lets a scenario request N distinct-stream
    // cold opens without an app rebuild per scenario.
    if (openTargets) {
      streamId = openTargets[Math.min(i, openTargets.length - 1)];
    }
    if (i > 0) {
      try { deps.router.push('/(tabs)/chats'); } catch {}
      logHarnessTrace('composite_list_pushed', { iteration: i, stream_id: streamId });
      await delay(listDwellMs);
    }

    // The loop must not advance on mount alone: the next iteration pushes back to
    // the Chats list ~1ms later, which UNMOUNTS the session screen. Advancing at
    // mount tore 18 of 20 opens down before their focus/ack effect ran, so
    // `chatOpenCorrelationIdRef` was never set and NEITHER `shell-layout-commit`
    // NOR `first-authoritative-row-mount` could emit — `chat_open_slo` scored all
    // 18 `missing_authoritative_paint_phase`. Only the two opens with a long dwell
    // after them (iteration 0, behind the one-time composite send, and the final
    // iteration) ever completed (2026-08-29 exec-1 run). An injected waiter keeps
    // its own mount-only semantics so unit seams stay unchanged.
    const awaitOpenPainted = (target: string): Promise<OpenSettleOutcome> => (
      deps.waitForSessionMount
        ? deps.waitForSessionMount(target, mountTimeoutMs).then((mounted) => ({
            mounted,
            painted: false,
            transcriptSettled: false,
          }))
        : waitForSessionMountAndPaint(target, mountTimeoutMs)
    );
    const mountWaiter = streamId ? awaitOpenPainted(streamId) : null;
    logHarnessTrace('composite_open_start', { iteration: i, stream_id: streamId });
    const opened = await attemptOpenExistingChatWithPoll(
      deps,
      streamId,
      deps.inventoryPollTimeoutMs ?? 2000,
    );
    if (!opened) {
      logHarnessTrace('composite_open_missing_session', { iteration: i, stream_id: streamId });
      break;
    }
    streamId = opened;
    const openOutcome = mountWaiter ? await mountWaiter : await awaitOpenPainted(opened);
    flowContext.streamId = opened;
    harnessRuntime.markStreamHarnessActive(opened);
    logHarnessTrace('composite_open_settled', {
      iteration: i,
      stream_id: opened,
      mounted: openOutcome.mounted,
      painted: openOutcome.painted,
      transcript_settled: openOutcome.transcriptSettled,
    });
    if (!sent) {
      sent = true;
      await dispatchCompositeSend(deps, opened);
      createDeletePromise = runCompositeCreateDeleteUnderLoad({
        ...deps,
      }).catch((error) => {
        logHarnessTrace('composite_create_delete_error', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  if (!createDeletePromise) {
    createDeletePromise = runCompositeCreateDeleteUnderLoad({
      ...deps,
    }).catch((error) => {
      logHarnessTrace('composite_create_delete_error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await createDeletePromise;

  if (!streamId) {
    const jsProbe = probe.stop();
    logHarnessTrace('composite_load_done', { status: 'no_stream', ...jsProbe });
    return;
  }

  const jsProbe = probe.stop();
  logHarnessTrace('composite_load_done', {
    status: 'done',
    stream_id: streamId,
    optimistic_id: flowContext.lastOptimisticId,
    ...jsProbe,
  });
}

// ---------------------------------------------------------------------------
// retry_failed_send
// ---------------------------------------------------------------------------

export async function runRetryFailedSend(deps: RetryFailedSendDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
  const expectedStreamId = deps.streamId || flowContext.streamId || '';
  const expectedOptimisticId = deps.optimisticId || flowContext.lastOptimisticId || '';
  logTelemetry(HARNESS_RETRY_FAILED_SEND_SCHEDULED, {
    ...(expectedStreamId ? { stream_id: expectedStreamId } : {}),
    ...(expectedOptimisticId ? { optimistic_id: expectedOptimisticId } : {}),
  });
  const failed = await waitForTelemetry(
    (payload) => failedOptimisticTelemetryMatches(payload, expectedStreamId, expectedOptimisticId),
    timeoutMs,
  );
  if (!failed) {
    logTelemetry(HARNESS_RETRY_FAILED_SEND_SKIPPED, {
      reason: 'failed_timeout',
      ...(expectedStreamId ? { stream_id: expectedStreamId } : {}),
      ...(expectedOptimisticId ? { optimistic_id: expectedOptimisticId } : {}),
    });
    return;
  }
  const optimisticId = optimisticIdFromTelemetry(failed);
  const streamId = String(failed.data.stream_id || expectedStreamId || '');
  if (failed.message !== TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED) {
    await waitForTelemetry(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED &&
        String(payload.data.stream_id || '') === streamId &&
        String(payload.data.optimistic_id || '') === optimisticId,
      FAILED_ROW_TO_LIFECYCLE_GRACE_MS,
    );
  }
  flowContext.lastOptimisticId = optimisticId;
  if (streamId) flowContext.streamId = streamId;
  const retryObserved = waitForTelemetry(
    (payload) =>
      payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RETRY &&
      String(payload.data.optimistic_id || '') === optimisticId,
    1000,
  );
  deps.retryOptimisticSend(optimisticId);
  const retry = await retryObserved;
  if (!retry) {
    logTelemetry(HARNESS_RETRY_FAILED_SEND_SKIPPED, {
      reason: 'retry_not_observed',
      stream_id: streamId,
      optimistic_id: optimisticId,
    });
    return;
  }
  logTelemetry(HARNESS_RETRY_FAILED_SEND_SENT, {
    stream_id: streamId,
    optimistic_id: optimisticId,
    status: 'ok',
  });
}

function optimisticIdFromTelemetry(payload: TelemetryPayload): string {
  return String(payload.data.optimistic_id || payload.data.row_id || '');
}

function failedOptimisticTelemetryMatches(
  payload: TelemetryPayload,
  expectedStreamId: string,
  expectedOptimisticId: string,
): boolean {
  const streamId = String(payload.data.stream_id || '');
  const optimisticId = optimisticIdFromTelemetry(payload);
  if (expectedStreamId && streamId !== expectedStreamId) return false;
  if (expectedOptimisticId && optimisticId !== expectedOptimisticId) return false;
  if (!optimisticId) return false;
  if (payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED) return true;
  if (
    payload.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED ||
    payload.message === TELEMETRY_EVENTS.HARNESS_ROW_RENDERED ||
    payload.message === TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED
  ) {
    return String(payload.data.send_state || '') === 'failed';
  }
  return false;
}

// ---------------------------------------------------------------------------
// open_chat_while_ws_down
// ---------------------------------------------------------------------------

export type OpenChatWhileWsDownDeps = {
  host: string;
  provider?: 'claude' | 'codex';
  router: RouterLike;
  forceCloseWs: ForceCloseWsLike;
  attemptOpenExistingChat?: (host: string, provider?: 'claude' | 'codex') => string | null;
  closeTimeoutMs?: number;
};

export async function runOpenChatWhileWsDown(deps: OpenChatWhileWsDownDeps): Promise<void> {
  const observedBackfillStreams = new Set<string>();
  const restoreBackfillWatcher = teeTelemetrySink((payload) => {
    if (payload.message !== CHAT_HISTORY_BACKFILL_RENDERED) return;
    const streamId = String(payload.data.stream_id || '');
    if (streamId) observedBackfillStreams.add(streamId);
  });
  logTelemetry(HARNESS_OPEN_CHAT_WHILE_WS_DOWN_SCHEDULED, {
    host: deps.host,
    provider: deps.provider,
  });

  try {
    // When open_chat_while_ws_down starts BEFORE its partner open/spawn flow has
    // finished, learn the target stream from that flow's *_SENT signal.
    let learnedStreamFromSentSignal = false;
    if (
      !flowContext.streamId &&
      (harnessRuntime.hasAction('spawn_chat_then_send') ||
        harnessRuntime.hasAction('open_chat_then_send'))
    ) {
      const partnerSent = await waitForTelemetry(
        (payload) =>
          payload.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT ||
          payload.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT,
        DEFAULT_RECONCILE_TIMEOUT_MS,
      );
      const partnerStreamId = String(partnerSent?.data.stream_id || '');
      if (partnerStreamId) {
        flowContext.streamId = partnerStreamId;
        learnedStreamFromSentSignal = true;
      }
    }

    const streamId = flowContext.streamId;
    // Only wait for the authoritative content render when the partner flow had
    // ALREADY completed (stream pre-set in flowContext) — i.e. the chat opened
    // and rendered before the socket went down. If we only just learned the
    // stream from the *_SENT signal, the partner open is still in flight and the
    // socket is going down: no content render will arrive, so awaiting it would
    // hang. This is the "start before open_chat_then_send finishes, without
    // waiting for ws_open" path — proceed straight to the force-close.
    if (
      streamId &&
      !learnedStreamFromSentSignal &&
      (
        harnessRuntime.hasAction('spawn_chat_then_send') ||
        harnessRuntime.hasAction('open_chat_then_send')
      )
    ) {
      await waitForTelemetry(
        (payload) => isAuthoritativeContentRender(payload, streamId),
        DEFAULT_RECONCILE_TIMEOUT_MS,
      );
    }

    if (
      harnessRuntime.hasAction('fail_next_history_fetch') &&
      streamId &&
      !observedBackfillStreams.has(streamId)
    ) {
      await waitForTelemetry(
        (payload) =>
          payload.message === CHAT_HISTORY_BACKFILL_RENDERED &&
          String(payload.data.stream_id || '') === streamId,
        DEFAULT_RECONCILE_TIMEOUT_MS,
      );
    }

    try { deps.router.push('/(tabs)/chats'); } catch {}

    const closePromise = waitForTelemetry(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_WS_CLOSE &&
        String(payload.data.reason || '') === 'harness_forced',
      deps.closeTimeoutMs ?? MOUNT_SETTLE_TIMEOUT_MS,
    );
    const closeIssued = deps.forceCloseWs('harness_forced');
    if (!closeIssued) {
      logTelemetry(HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED, {
        reason: 'close_not_issued',
        stream_id: streamId || '',
      });
      return;
    }
    const closed = await closePromise;
    if (!closed) {
      logTelemetry(HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED, {
        reason: 'close_not_observed',
        stream_id: streamId || '',
      });
      return;
    }

    if (streamId) {
      harnessRuntime.markStreamHarnessActive(streamId);
      performHarnessChatOpen(streamId, deps.router);
      logTelemetry(HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE, {
        stream_id: streamId,
        source: 'flow_context',
      });
      return;
    }

    const opened = deps.attemptOpenExistingChat?.(deps.host, deps.provider) || null;
    if (!opened) {
      logTelemetry(HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED, {
        reason: 'no_existing_chat',
        host: deps.host,
        provider: deps.provider,
      });
      return;
    }
    flowContext.streamId = opened;
    logTelemetry(HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE, {
      stream_id: opened,
      source: 'existing_chat',
    });
  } finally {
    restoreBackfillWatcher();
  }
}

// ---------------------------------------------------------------------------
// send_again
// ---------------------------------------------------------------------------

export type SendAgainDeps = {
  text?: string;
  count?: number;
  timeoutMs?: number;
  /**
   * Returns the current turn phase for the stream. Production injects
   * `() => pentacleStream.getPentacleStreamState().workingByStream?.[streamId]?.phase`.
   * Tests can omit (default returns `'idle'` so the wait is a no-op).
   *
   * runSendAgain polls this after reconcile to wait for the assistant to
   * finish responding before dispatching turn 2. Otherwise `sendTurn`'s
   * `phase !== 'idle'` gate refuses the send and emits
   * `chat.compose.warn.send_while_not_idle`.
   */
  getStreamPhase?: (streamId: string) => string | undefined;
  /** Tests only — override the idle-wait timeout. */
  idleWaitTimeoutMs?: number;
  /** Tests only — override the idle-wait poll interval. */
  idleWaitPollMs?: number;
  waitForSettingsToggle?: boolean;
};

export type CopyChatSampleDeps = {
  messageText: string;
  codeText: string;
  delayMs?: number;
};

async function waitForStreamIdle(
  streamId: string,
  getPhase: ((streamId: string) => string | undefined) | undefined,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  if (!getPhase) return true; // No getter wired (test default) — skip wait.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const phase = getPhase(streamId);
    if (!phase || phase === 'idle') return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

export async function runSendAgain(deps: SendAgainDeps): Promise<void> {
  const text = deps.text || DEFAULT_SEND_TEXT;
  const count = Math.max(1, deps.count ?? 1);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
  // Start listening for OPTIMISTIC_RECONCILED IMMEDIATELY (before the
  // partner-wait and any settings-toggle wait) so we catch reconciles that
  // fire while we're still waiting on earlier actions. The daemon's broadcast
  // for the user-message echo can arrive in well under a second on a healthy
  // cross-host path (post public behavior contract),
  // so by the time the partner action emits its _SENT or the settings toggle
  // completes, the reconcile telemetry is often already past. waitForTelemetry
  // registers a tee that only sees future events, so without this early-start
  // we race-miss the reconcile and `runSendAgain` skips with
  // reason='reconcile_timeout' on every healthy run.
  const reconciledByOptimistic = new Map<string, TelemetryPayload>();
  const restoreReconcileWatcher = teeTelemetrySink((payload) => {
    if (payload.message !== TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED) return;
    const oid = String(payload.data.optimistic_id || '');
    if (oid) reconciledByOptimistic.set(oid, payload);
  });
  try {
    if (deps.waitForSettingsToggle) {
      await waitForTelemetry(
        (payload) => payload.message === TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE,
        timeoutMs,
      );
    }
    // All compose-driving actions are dispatched in the same synchronous
    // tick from subscribeHarnessHydrationActions. send_again must wait for
    // the partner action (spawn_chat_then_send / open_chat_then_send) to
    // populate flowContext.streamId AND lastOptimisticId before checking.
    // Otherwise this race skips with no_active_stream or no_prior_optimistic
    // while the initial send is still waiting for its send.result.
    if ((!flowContext.streamId || !flowContext.lastOptimisticId) &&
        (harnessRuntime.hasAction('spawn_chat_then_send') ||
         harnessRuntime.hasAction('open_chat_then_send'))) {
      await waitForTelemetry(
        (payload) =>
          payload.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT ||
          payload.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT,
        timeoutMs,
      );
    }
    const streamId = flowContext.streamId;
    if (!streamId) {
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED, {
        reason: 'no_active_stream',
        count_completed: 0,
      });
      return;
    }

    let countCompleted = 0;
    for (let i = 0; i < count; i += 1) {
      const priorOptimistic = flowContext.lastOptimisticId;
      if (!priorOptimistic) {
        logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED, {
          reason: 'no_prior_optimistic',
          stream_id: streamId,
          count_completed: countCompleted,
        });
        return;
      }
      // Fast path: the early-started reconcile watcher above may have
      // already captured the reconcile for this optimistic during the
      // partner-wait. Don't re-await a tee event that's already past.
      const alreadyReconciled = reconciledByOptimistic.get(priorOptimistic);
      const reconciled = alreadyReconciled ?? await waitForTelemetry(
        (payload) =>
          payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED &&
          String(payload.data.stream_id || '') === streamId &&
          String(payload.data.optimistic_id || '') === priorOptimistic,
        timeoutMs,
      );
      if (!reconciled) {
        logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED, {
          reason: 'reconcile_timeout',
          stream_id: streamId,
          count_completed: countCompleted,
        });
        return;
      }
      // Wait for the assistant to finish responding before dispatching the
      // next send. `reconcile` only confirms the user-message echo; the
      // turn isn't "done" until workingByStream[streamId].phase === 'idle'
      // (driven by the daemon's terminal SYSTEM event — see
      // `isSystemEndOfTurnEvent` in pentacleStreamReducer.ts). Without
      // this wait, dispatchSend would hit sendTurn's `phase !== 'idle'`
      // guard, emit `chat.compose.warn.send_while_not_idle`, and silently
      // refuse the send — send_again_sent would still report status:'ok'
      // but no actual turn-2 message would land.
      const idleReady = await waitForStreamIdle(
        streamId,
        deps.getStreamPhase,
        deps.idleWaitTimeoutMs ?? timeoutMs,
        deps.idleWaitPollMs ?? 50,
      );
      if (!idleReady) {
        logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED, {
          reason: 'idle_timeout',
          stream_id: streamId,
          count_completed: countCompleted,
        });
        return;
      }
      // Capture the next optimistic_id before dispatch so the next iteration
      // (or downstream actions) can scope on it.
      const nextOptimisticPromise = waitForTelemetry(
        (payload) =>
          payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT &&
          String(payload.data.stream_id || '') === streamId,
        1000,
      );
      const dispatchResult = await harnessRuntime.dispatchSend(streamId, text);
      const nextOptimistic = await nextOptimisticPromise;
      if (nextOptimistic) {
        flowContext.lastOptimisticId = String(nextOptimistic.data.optimistic_id || '');
      }
      countCompleted += 1;
      logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT, {
        stream_id: streamId,
        status: dispatchResult.status,
        ...(flowContext.lastOptimisticId ? { optimistic_id: flowContext.lastOptimisticId } : {}),
      });
    }
  } finally {
    restoreReconcileWatcher();
  }
}

// ---------------------------------------------------------------------------
// copy_chat_sample
// ---------------------------------------------------------------------------

export async function runCopyChatSample(deps: CopyChatSampleDeps): Promise<void> {
  if (
    !flowContext.streamId &&
    (harnessRuntime.hasAction('spawn_chat_then_send') ||
      harnessRuntime.hasAction('open_chat_then_send'))
  ) {
    await waitForTelemetry(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT ||
        payload.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT,
      DEFAULT_RECONCILE_TIMEOUT_MS,
    );
  }
  const streamId = flowContext.streamId;
  if (!streamId) return;
  const delayMs = Math.max(0, deps.delayMs ?? 750);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  await harnessRuntime.dispatchCopy(streamId, {
    copyKind: 'message',
    text: deps.messageText,
  });
  await harnessRuntime.dispatchCopy(streamId, {
    copyKind: 'code',
    text: deps.codeText,
  });
}

// ---------------------------------------------------------------------------
// disconnect_after_send
// ---------------------------------------------------------------------------

export type DisconnectAfterSendDeps = {
  forceCloseWs: ForceCloseWsLike;
  streamId?: string;
  optimisticWaitMs?: number;
};

export async function runDisconnectAfterSend(deps: DisconnectAfterSendDeps): Promise<void> {
  // The compose-driving actions are dispatched in the same synchronous
  // tick from subscribeHarnessHydrationActions, so disconnect_after_send
  // must wait for the partner action (spawn_chat_then_send /
  // open_chat_then_send) to populate flowContext.streamId before
  // checking. Otherwise this race-aborts with reason='no_active_stream'
  // on cold launch. Mirrors runSendAgain's partner-wait pattern.
  const waitMs = deps.optimisticWaitMs ?? DISCONNECT_OPTIMISTIC_WAIT_MS;
  const optimisticInsert = await waitForTelemetry(
    (payload) => {
      if (payload.message !== TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT) return false;
      const payloadStreamId = String(payload.data.stream_id || '');
      const expected = deps.streamId || flowContext.streamId;
      return expected ? payloadStreamId === expected : Boolean(payloadStreamId);
    },
    waitMs,
  );
  const streamId = deps.streamId || String(optimisticInsert?.data.stream_id || '') || flowContext.streamId;
  logTelemetry(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_SCHEDULED, {
    stream_id: streamId,
  });
  if (!streamId) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED, {
      reason: 'no_active_stream',
    });
    return;
  }
  if (!optimisticInsert) {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED, {
      reason: 'optimistic_not_observed',
      stream_id: streamId,
    });
    return;
  }
  const optimisticId = String(optimisticInsert.data.optimistic_id || '');
  if (optimisticId) flowContext.lastOptimisticId = optimisticId;
  const dispatched = await waitForTelemetry(
    (payload) => (
      payload.message === HARNESS_UI_TRACE &&
      String(payload.data.kind || '') === 'send_queued_dispatched' &&
      String(payload.data.stream_id || '') === streamId &&
      (!optimisticId || String(payload.data.optimistic_id || '') === optimisticId)
    ),
    DISCONNECT_SEND_DISPATCH_WAIT_MS,
  );
  if (!dispatched) await delay(DISCONNECT_POST_OPTIMISTIC_GRACE_MS);
  deps.forceCloseWs('harness_forced');
  logTelemetry(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED, {
    stream_id: streamId,
    optimistic_id: optimisticId,
  });
}

// ---------------------------------------------------------------------------
// open_settings_then_toggle
// ---------------------------------------------------------------------------

export type OpenSettingsThenToggleDeps = {
  router: RouterLike;
  preferences: UserPreferencesLike;
  key?: BooleanUserPreferenceKey;
  waitForActiveStreamIdle?: boolean;
  getStreamPhase?: (streamId: string) => string | undefined;
  idleWaitTimeoutMs?: number;
  idleWaitPollMs?: number;
};

export async function runOpenSettingsThenToggle(deps: OpenSettingsThenToggleDeps): Promise<void> {
  const key = deps.key || 'showToolActions';
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_SCHEDULED, { key });
  if (deps.waitForActiveStreamIdle) {
    if (
      !flowContext.streamId &&
      (harnessRuntime.hasAction('spawn_chat_then_send') ||
        harnessRuntime.hasAction('open_chat_then_send'))
    ) {
      await waitForTelemetry(
        (payload) =>
          payload.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT ||
          payload.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT,
        deps.idleWaitTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
      );
    }
    const streamId = flowContext.streamId;
    if (streamId) {
      await waitForStreamIdle(
        streamId,
        deps.getStreamPhase,
        deps.idleWaitTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
        deps.idleWaitPollMs ?? 50,
      );
    }
  }
  try { deps.router.push('/(tabs)/settings'); } catch {}
  const current = deps.preferences.getUserPreference(key);
  const next = !current;
  await deps.preferences.setUserPreference(key, next);
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE, {
    key,
    from_value: current,
    to_value: next,
  });
  try { deps.router.push('/(tabs)/chats'); } catch {}
}

// ---------------------------------------------------------------------------
// write_user_preference
// ---------------------------------------------------------------------------

export type WriteUserPreferenceDeps = {
  pref: string;
  value: string;
  preferences: UserPreferencesLike;
};

const BOOLEAN_PREFS: Set<string> = new Set(['showToolActions', 'showTurnDuration']);

function coerceBoolean(raw: string): boolean | null {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

export async function runWriteUserPreference(deps: WriteUserPreferenceDeps): Promise<void> {
  const { pref, value, preferences } = deps;
  if (!BOOLEAN_PREFS.has(pref)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[harnessActions.write_user_preference] unsupported preference key ${JSON.stringify(pref)}; skipping`,
    );
    return;
  }
  const coerced = coerceBoolean(value);
  if (coerced === null) {
    // eslint-disable-next-line no-console
    console.warn(
      `[harnessActions.write_user_preference] could not coerce value ${JSON.stringify(value)} for boolean pref ${pref}; skipping`,
    );
    return;
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_SCHEDULED, {
    key: pref,
    value: coerced,
  });
  await preferences.setUserPreference(pref as BooleanUserPreferenceKey, coerced);
  logTelemetry(TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_DONE, {
    key: pref,
    value: coerced,
  });
}

// ---------------------------------------------------------------------------
// open_updates
// ---------------------------------------------------------------------------

export type OpenUpdatesDeps = {
  router: RouterLike;
};

export async function runOpenUpdates(deps: OpenUpdatesDeps): Promise<void> {
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_SCHEDULED, {});
  // Navigate to the Updates tab so the Notifications surface mounts, focuses,
  // and useNotifications backfills the slice. On cold launch the harness arming
  // callback fires from the Linking.getInitialURL() resolution BEFORE the Root
  // Layout / tab navigator mounts, so a single push is dropped and the app
  // settles on the default (Chats) tab — leaving Updates unfocused, which means
  // useNotifications(isFocused=false) renders no cards and notification:card_rendered
  // never fires. Retry on a bounded cadence so the push lands once the navigator
  // is mounted; pushing a tab route is idempotent (switches the tab, no stacking),
  // so re-pushing after success is harmless. Errors are swallowed (router not
  // ready yet on early attempts).
  const ROUTE = '/(tabs)/updates';
  const push = () => {
    try {
      deps.router.push(ROUTE);
    } catch {}
  };
  // Push immediately and resolve the action right away (so the runner's await
  // does not block). The cold-boot retries below run in the BACKGROUND on
  // unref'd timers, so they re-land the navigation once the navigator mounts
  // without keeping the runtime (or a jest worker) alive.
  push();
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_DONE, {});
  const ATTEMPTS = 16; // ~12s at 750ms — comfortably outlasts cold-boot mount
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    const timer = setTimeout(push, i * 750);
    (timer as unknown as { unref?: () => void })?.unref?.();
  }
}

// ---------------------------------------------------------------------------
// tab_navigation
// ---------------------------------------------------------------------------

export type TabNavigationDeps = {
  router: RouterLike;
  stepDelayMs?: number;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTabNavigation(deps: TabNavigationDeps): Promise<void> {
  const stepDelayMs = deps.stepDelayMs ?? 900;
  logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_TAB_NAVIGATION_SCHEDULED, {
    mode: 'route_navigation_smoke',
  });
  for (const route of ['/(tabs)/chats', '/(tabs)/updates', '/(tabs)/settings']) {
    try {
      deps.router.push(route);
    } catch {}
    await delay(stepDelayMs);
  }
  logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_TAB_NAVIGATION_DONE, {
    mode: 'route_navigation_smoke',
  });
}

// ---------------------------------------------------------------------------
// all_chats_regression
// ---------------------------------------------------------------------------

const ALL_CHATS_READY = 'harness:all_chats_ready' as Parameters<typeof logTelemetry>[0];
const ALL_CHATS_ACTION_STARTED = 'harness:all_chats_action_started' as Parameters<typeof logTelemetry>[0];
const ALL_CHATS_ROW_COMMITTED = 'harness:all_chats_row_committed' as Parameters<typeof logTelemetry>[0];
const ALL_CHATS_ACTION_SETTLED = 'harness:all_chats_action_settled' as Parameters<typeof logTelemetry>[0];

export type AllChatsRegressionRequest = {
  action_id: string;
  action: 'scroll' | 'open_return' | 'pull_refresh';
  burst: number;
  stream_id?: string;
  expected_unread_count?: number;
  expected_open_question_count?: number;
};

export type AllChatsRegressionDeps = {
  dispatch: (request: AllChatsRegressionRequest) => Promise<{ status: string }>;
  waitForDaemonSeq?: (daemonSeq: number, timeoutMs: number) => Promise<boolean>;
  seedFixtureState?: () => Promise<void>;
  applyFixtureState?: (burst: number) => Promise<void>;
  getFixtureState?: () => {
    eventCount: number;
    maxDaemonSeq: number;
    unreadCount: number;
    openQuestionCount: number;
    sessionSummaryCount: number;
    perStreamRetainedMax: number;
  };
  returnToAllChats?: () => Promise<void>;
  streamId?: string;
  setupEventCount?: number;
  burstSize?: number;
  timeoutMs?: number;
  isReady?: () => boolean;
};

const ALL_CHATS_ACTIONS: Array<AllChatsRegressionRequest['action']> = [
  'scroll',
  'open_return',
  'scroll',
  'pull_refresh',
  'scroll',
];
const ALL_CHATS_STRESS_SETUP_EVENT_COUNT = 19_120;
const ALL_CHATS_STRESS_SETUP_TIMEOUT_MS = 180_000;

/** Harness-only route mount; readiness remains owned by the focused Chats seam. */
export function mountAllChatsRegressionScreen(router: RouterLike): boolean {
  logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_NAVIGATION_ATTEMPT, {});
  try {
    if (!router.replace) throw new Error('router replace unavailable');
    router.replace('/chats');
    logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_NAVIGATION_RESULT, {});
    return true;
  } catch {
    logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_ALL_CHATS_NAVIGATION_RESULT, {});
    return false;
  }
}

export async function runAllChatsRegression(deps: AllChatsRegressionDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const setupEventCount = deps.setupEventCount ?? 1_120;
  const burstSize = deps.burstSize ?? 16;
  const setupTimeoutMs = setupEventCount === ALL_CHATS_STRESS_SETUP_EVENT_COUNT
    ? Math.max(timeoutMs, ALL_CHATS_STRESS_SETUP_TIMEOUT_MS)
    : timeoutMs;
  const ready = deps.isReady
    ? await waitForCondition(deps.isReady, timeoutMs)
    : await waitForTelemetry((payload) => payload.message === ALL_CHATS_READY, timeoutMs);
  if (!ready) {
    logHarnessTrace('all_chats_regression_setup_fail', { reason: 'ready_timeout' });
    return;
  }
  if (deps.waitForDaemonSeq && !(await deps.waitForDaemonSeq(setupEventCount, setupTimeoutMs))) {
    logHarnessTrace('all_chats_regression_setup_fail', {
      reason: 'fixture_setup_timeout',
      expected_daemon_seq: setupEventCount,
    });
    return;
  }
  await deps.seedFixtureState?.();
  for (let index = 0; index < ALL_CHATS_ACTIONS.length; index += 1) {
    const request: AllChatsRegressionRequest = {
      action_id: `all-chats-${index + 1}`,
      action: ALL_CHATS_ACTIONS[index],
      burst: index + 1,
      ...(deps.streamId ? { stream_id: deps.streamId } : {}),
    };
    const expectedDaemonSeq = setupEventCount + request.burst * burstSize;
    logHarnessTrace('all_chats_fixture_advance', {
      ...request,
      expected_daemon_seq: expectedDaemonSeq,
    });
    if (deps.waitForDaemonSeq && !(await deps.waitForDaemonSeq(expectedDaemonSeq, timeoutMs))) {
      logHarnessTrace('all_chats_regression_product_fail', {
        reason: 'fixture_burst_timeout',
        action_id: request.action_id,
        burst: request.burst,
        expected_daemon_seq: expectedDaemonSeq,
      });
      return;
    }
    await deps.applyFixtureState?.(request.burst);
    const fixtureState = deps.getFixtureState?.();
    logHarnessTrace('all_chats_fixture_applied', {
      ...request,
      expected_daemon_seq: expectedDaemonSeq,
      store_event_count: fixtureState?.eventCount,
      max_daemon_seq: fixtureState?.maxDaemonSeq,
      unread_count: fixtureState?.unreadCount,
      open_question_count: fixtureState?.openQuestionCount,
      session_summary_count: fixtureState?.sessionSummaryCount,
      per_stream_retained_max: fixtureState?.perStreamRetainedMax,
    });
    const dispatchRequest: AllChatsRegressionRequest = {
      ...request,
      ...(fixtureState ? {
        expected_unread_count: fixtureState.unreadCount,
        expected_open_question_count: fixtureState.openQuestionCount,
      } : {}),
    };
    const started = waitForTelemetry(
      (payload) =>
        payload.message === ALL_CHATS_ACTION_STARTED &&
        payload.data.action_id === request.action_id &&
        payload.data.action === request.action &&
        payload.data.burst === request.burst,
      timeoutMs,
    );
    const committed = waitForTelemetry(
      (payload) =>
        payload.message === ALL_CHATS_ROW_COMMITTED &&
        payload.data.action_id === request.action_id &&
        payload.data.action === request.action &&
        payload.data.burst === request.burst,
      timeoutMs,
    );
    const settled = waitForTelemetry(
      (payload) =>
        payload.message === ALL_CHATS_ACTION_SETTLED &&
        payload.data.action_id === request.action_id &&
        payload.data.action === request.action &&
        payload.data.burst === request.burst,
      timeoutMs,
    );
    const result = await deps.dispatch(dispatchRequest);
    if (result.status !== 'ok') {
      logHarnessTrace('all_chats_regression_setup_fail', {
        reason: 'no_handler',
        action_id: request.action_id,
      });
      return;
    }
    if (request.action === 'open_return' && deps.returnToAllChats) {
      await deps.returnToAllChats();
    }
    const [startedPayload, committedPayload, settledPayload] = await Promise.all([
      started,
      committed,
      settled,
    ]);
    if (!startedPayload || !committedPayload || !settledPayload) {
      logHarnessTrace('all_chats_regression_product_fail', {
        reason: 'action_commit_timeout',
        action_id: request.action_id,
        burst: request.burst,
      });
      return;
    }
  }
  logHarnessTrace('all_chats_regression_complete', {
    bursts: ALL_CHATS_ACTIONS.length,
  });
}

// ---------------------------------------------------------------------------
// resolve_notification
// ---------------------------------------------------------------------------

export type ResolveNotificationDeps = {
  action_kind: NotificationActionKind;
  choice?: boolean;
  selections?: string[];
  text?: string;
  note?: string;
  delayMs?: number;
  /**
   * Optional disambiguation marker. When set, only notifications whose title
   * contains the marker are considered. This keeps a scenario from resolving
   * an unrelated open notification that happens to live on the shared daemon
   * (the configured daemon endpoint). When omitted, the first open notification
   * carrying `action_kind` (newest-first) is targeted, per the spec's
   * "first open notification" contract.
   */
  marker?: string;
  waitForQuestionRender?: boolean;
  questionStreamId?: string;
  questionRenderTimeoutMs?: number;
  getNotifications: () => PentacleNotification[];
  subscribe: (listener: () => void) => () => void;
  resolveNotification: (args: {
    notification_id: string;
    action_kind: NotificationActionKind;
    question_id?: string;
    choice?: boolean;
    selections?: string[];
    text?: string;
    note?: string;
  }) => Promise<unknown>;
  answerPrompt?: (args: { questionId: string; selections?: string[]; text?: string }) => Promise<unknown>;
  /** Tests only — override the open-notification wait deadline. */
  timeoutMs?: number;
};

function pickOpenMatching(
  notifications: PentacleNotification[],
  action_kind: NotificationActionKind,
  marker: string | undefined,
): PentacleNotification | null {
  // state.notifications is sorted newest-first (sortNotificationsNewestFirst),
  // so the first match is the most-recently-created open notification — which
  // is the one the scenario just seeded during its run() body.
  for (const n of notifications) {
    if (n.state !== 'open') continue;
    if (marker && !String(n.title || '').includes(marker)) continue;
    if (!(n.actions || []).some((a) => a.kind === action_kind)) continue;
    return n;
  }
  return null;
}

function waitForOpenNotification(
  deps: ResolveNotificationDeps,
  timeoutMs: number,
): Promise<PentacleNotification | null> {
  const immediate = pickOpenMatching(deps.getNotifications(), deps.action_kind, deps.marker);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PentacleNotification | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = deps.subscribe(() => {
      const match = pickOpenMatching(deps.getNotifications(), deps.action_kind, deps.marker);
      if (match) finish(match);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export async function runResolveNotification(deps: ResolveNotificationDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? RESOLVE_NOTIFICATION_TIMEOUT_MS;
  const target = await waitForOpenNotification(deps, timeoutMs);
  if (!target) {
    // Distinguish "no open notification at all (under marker scope)" from
    // "open notifications exist but none carry the requested action_kind".
    // Both are SETUP_FAIL signals for the scenario (deny-listed).
    const anyOpen = deps
      .getNotifications()
      .some(
        (n) =>
          n.state === 'open' && (!deps.marker || String(n.title || '').includes(deps.marker)),
      );
    logTelemetry(TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED, {
      reason: anyOpen ? 'no_matching_action' : 'no_open_notification',
      action_kind: deps.action_kind,
    });
    return;
  }
  if (deps.waitForQuestionRender) {
    const streamId = deps.questionStreamId || target.question?.producer_stream_id;
    const questionRendered = await waitForTelemetry(
      (payload) =>
        payload.message === TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED &&
        (!streamId || String(payload.data.stream_id || '') === streamId),
      deps.questionRenderTimeoutMs ?? timeoutMs,
    );
    if (!questionRendered) {
      logTelemetry(TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED, {
        reason: 'question_render_timeout',
        action_kind: deps.action_kind,
        notification_id: target.notification_id,
        ...(streamId ? { stream_id: streamId } : {}),
      });
      return;
    }
  }
  if (deps.delayMs && deps.delayMs > 0) {
    await delay(deps.delayMs);
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED, {
    action_kind: deps.action_kind,
  });
  try {
    if (target.question?.question_id && deps.answerPrompt) {
      await deps.answerPrompt({
        questionId: target.question.question_id,
        ...(deps.selections ? { selections: deps.selections } : {}),
        ...(typeof deps.text === 'string' || typeof deps.note === 'string' ? { text: deps.text || deps.note } : {}),
      });
      return;
    }
    await deps.resolveNotification({
      notification_id: target.notification_id,
      action_kind: deps.action_kind,
      ...(target.question?.question_id ? { question_id: target.question.question_id } : {}),
      // spawn_worker carries no choice; the daemon uses the notification's own
      // spawn_worker action spec. yes_no passes the bool choice through.
      ...(typeof deps.choice === 'boolean' ? { choice: deps.choice } : {}),
      ...(deps.selections ? { selections: deps.selections } : {}),
      ...(typeof deps.text === 'string' ? { text: deps.text } : {}),
      ...(deps.note ? { note: deps.note } : {}),
    });
  } catch {
    logTelemetry(TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED, {
      reason: 'resolve_rejected',
      action_kind: deps.action_kind,
      notification_id: target.notification_id,
    });
    return;
  }
  logTelemetry(TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_DONE, {
    notification_id: target.notification_id,
    action_kind: deps.action_kind,
  });
}

// ---------------------------------------------------------------------------
// dismiss_question
// ---------------------------------------------------------------------------

export type DismissQuestionDeps = {
  /**
   * Optional explicit 1-based option index to answer. When omitted, the first
   * non-meta option carried on the pending question is chosen — matching the
   * desktop walk's "click option N" behavior with a deterministic default.
   */
  option?: number;
  answers?: PentacleQuestionAnswerValue[];
  getSessions: () => PentacleSessionSummary[];
  subscribe: (listener: () => void) => () => void;
  dismissQuestion: (args: { host: string; sessionName: string; questionKey: string; text: string }) => Promise<unknown>;
  /** Tests only — override the pending-question wait deadline. */
  timeoutMs?: number;
};

type DismissQuestionPreparedParams =
  | { shouldRun: true; option?: number; answers?: PentacleQuestionAnswerValue[] }
  | { shouldRun: false };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateDismissQuestionAnswers(value: unknown): { answers: PentacleQuestionAnswerValue[] } | { detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { detail: 'dismiss_answers' };
  }
  const answers: PentacleQuestionAnswerValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { detail: `dismiss_answers[${index}]` };
    }
    const record = item as Record<string, unknown>;
    const hasSelectedOption = Object.prototype.hasOwnProperty.call(record, 'selectedOptionIndex');
    const hasSelectedOptions = Object.prototype.hasOwnProperty.call(record, 'selectedOptionIndices');
    const hasSelectedLabel = Object.prototype.hasOwnProperty.call(record, 'selectedOptionLabel');
    const hasSelectedLabels = Object.prototype.hasOwnProperty.call(record, 'selectedOptionLabels');
    const hasText = Object.prototype.hasOwnProperty.call(record, 'text');
    const note = typeof record.note === 'string' && record.note.trim() ? record.note : undefined;
    if (!hasSelectedOption && !hasSelectedOptions && !hasSelectedLabel && !hasSelectedLabels && !hasText && !note) {
      return { detail: `dismiss_answers[${index}].answer` };
    }
    const answer: PentacleQuestionAnswerValue = {};
    if (hasSelectedOption) {
      if (!isNonNegativeInteger(record.selectedOptionIndex)) {
        return { detail: `dismiss_answers[${index}].selectedOptionIndex` };
      }
      answer.selectedOptionIndex = record.selectedOptionIndex;
    }
    if (hasSelectedOptions) {
      if (
        !Array.isArray(record.selectedOptionIndices)
        || record.selectedOptionIndices.length === 0
        || !record.selectedOptionIndices.every((option) => isNonNegativeInteger(option))
      ) {
        return { detail: `dismiss_answers[${index}].selectedOptionIndices` };
      }
      answer.selectedOptionIndices = record.selectedOptionIndices;
    }
    if (hasSelectedLabel) {
      if (typeof record.selectedOptionLabel !== 'string' || !record.selectedOptionLabel.trim()) {
        return { detail: `dismiss_answers[${index}].selectedOptionLabel` };
      }
      answer.selectedOptionLabel = record.selectedOptionLabel;
    }
    if (hasSelectedLabels) {
      if (
        !Array.isArray(record.selectedOptionLabels)
        || record.selectedOptionLabels.length === 0
        || !record.selectedOptionLabels.every((label) => typeof label === 'string' && label.trim())
      ) {
        return { detail: `dismiss_answers[${index}].selectedOptionLabels` };
      }
      answer.selectedOptionLabels = record.selectedOptionLabels;
    }
    if (hasText) {
      if (typeof record.text !== 'string' || !record.text.trim()) {
        return { detail: `dismiss_answers[${index}].text` };
      }
      answer.text = record.text;
    }
    if (note) {
      answer.note = note;
    }
    answers.push(answer);
  }
  return { answers };
}

export function prepareDismissQuestionHarnessParams(params: {
  optionParam?: string;
  dismissAnswersParam?: string;
}): DismissQuestionPreparedParams {
  const optionNum = params.optionParam ? Number(params.optionParam) : NaN;
  const option = Number.isFinite(optionNum) && optionNum > 0 ? optionNum : undefined;
  if (!params.optionParam && params.dismissAnswersParam) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.dismissAnswersParam);
    } catch (err) {
      logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
        reason: 'json_parse_error',
        detail: String((err as Error)?.message || err),
      });
      return { shouldRun: false };
    }
    const validated = validateDismissQuestionAnswers(parsed);
    if ('detail' in validated) {
      logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
        reason: 'params_invalid',
        detail: validated.detail,
      });
      return { shouldRun: false };
    }
    return { shouldRun: true, answers: validated.answers };
  }
  return { shouldRun: true, option };
}

function firstNonMetaOption(question: PentacleQuestion): number | null {
  for (const opt of question.options || []) {
    if (!opt.meta) return opt.index;
  }
  return null;
}

function questionKey(question: PentacleQuestion): string {
  const record = question as PentacleQuestion & { question_key?: string; questionKey?: string };
  const key = record.question_key ?? record.questionKey;
  return typeof key === 'string' ? key : '';
}

function pickSessionWithQuestion(
  sessions: PentacleSessionSummary[],
  acceptsBatchedAnswers: boolean,
): PentacleSessionSummary | null {
  // Prefer the stream the compose flow just spawned (flowContext.streamId),
  // so a question lingering on an unrelated session on the shared daemon does
  // not get answered. Fall back to the first session carrying a question with
  // at least one selectable (non-meta) option.
  const scoped = flowContext.streamId;
  if (scoped) {
    const target = sessions.find((s) => s.stream_id === scoped);
    if (target && target.question && (acceptsBatchedAnswers || firstNonMetaOption(target.question) != null)) {
      return target;
    }
    return null;
  }
  // In a spawn/open-chat flow the answer MUST target the just-spawned stream
  // (flowContext.streamId), which is set asynchronously AFTER the compose action
  // lands — there is a window where this runs with scoped===null. Do NOT fall
  // back to the first unrelated session that merely happens to carry a pending
  // question on the shared daemon (stale throwaway-agent debris): that races the
  // spawn and answers the wrong (often dead) session. Return null so the caller
  // keeps polling until flowContext.streamId resolves to the spawned stream.
  if (
    harnessRuntime.hasAction('spawn_chat_then_send') ||
    harnessRuntime.hasAction('open_chat_then_send')
  ) {
    return null;
  }
  for (const s of sessions) {
    if (s.question && (acceptsBatchedAnswers || firstNonMetaOption(s.question) != null)) return s;
  }
  return null;
}

function waitForPendingQuestion(
  deps: DismissQuestionDeps,
  timeoutMs: number,
): Promise<PentacleSessionSummary | null> {
  const acceptsBatchedAnswers = Array.isArray(deps.answers);
  const immediate = pickSessionWithQuestion(deps.getSessions(), acceptsBatchedAnswers);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PentacleSessionSummary | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = deps.subscribe(() => {
      const match = pickSessionWithQuestion(deps.getSessions(), acceptsBatchedAnswers);
      if (match) finish(match);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export async function runDismissQuestion(deps: DismissQuestionDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DISMISS_QUESTION_TIMEOUT_MS;
  const target = await waitForPendingQuestion(deps, timeoutMs);
  if (!target || !target.question) {
    logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
      reason: 'no_pending_question',
    });
    return;
  }
  if (Array.isArray(deps.answers)) {
    const key = questionKey(target.question);
    if (!key) {
      logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
        reason: 'missing_question_key',
        stream_id: target.stream_id,
      });
      return;
    }
    const answerCount = deps.answers.length;
    const freeTextCount = deps.answers.filter((answer) => 'text' in answer).length;
    const text = buildPentacleQuestionAnswerText({
      question: target.question,
      answers: deps.answers,
    });
    logTelemetry(HARNESS_DISMISS_QUESTION_SCHEDULED, {
      stream_id: target.stream_id,
      answer_count: answerCount,
      free_text_count: freeTextCount,
    });
    try {
      await deps.dismissQuestion({
        host: target.host,
        sessionName: target.session_name,
        questionKey: key,
        text,
      });
    } catch (err) {
      logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
        reason: 'dismiss_rejected',
        stream_id: target.stream_id,
        answer_count: answerCount,
        free_text_count: freeTextCount,
        error: String((err as Error)?.message || err),
      });
      return;
    }
    logTelemetry(HARNESS_DISMISS_QUESTION_SENT, {
      stream_id: target.stream_id,
      answer_count: answerCount,
      free_text_count: freeTextCount,
    });
    return;
  }
  const option = deps.option ?? firstNonMetaOption(target.question);
  if (option == null) {
    logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
      reason: 'no_selectable_option',
      stream_id: target.stream_id,
    });
    return;
  }
  const key = questionKey(target.question);
  if (!key) {
    logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
      reason: 'missing_question_key',
      stream_id: target.stream_id,
    });
    return;
  }
  const text = buildPentacleQuestionAnswerText({
    question: target.question,
    answers: [{ selectedOptionIndex: option }],
  });
  logTelemetry(HARNESS_DISMISS_QUESTION_SCHEDULED, {
    stream_id: target.stream_id,
    option,
  });
  try {
    await deps.dismissQuestion({
      host: target.host,
      sessionName: target.session_name,
      questionKey: key,
      text,
    });
  } catch (err) {
    logTelemetry(HARNESS_DISMISS_QUESTION_SKIPPED, {
      reason: 'dismiss_rejected',
      stream_id: target.stream_id,
      option,
      error: String((err as Error)?.message || err),
    });
    return;
  }
  logTelemetry(HARNESS_DISMISS_QUESTION_SENT, {
    stream_id: target.stream_id,
    option,
  });
}
