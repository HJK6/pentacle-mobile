// idempotent_mobile_send §A (Track B) — mobile-owned pure helpers for safe
// automatic replay of ambiguous sends across a reconnect, and for the explicit
// user-retry request_id rotation. These deliberately live in pentacle-mobile
// (not the shared pentacle-chat-core reducer): the submission-idempotency policy
// is a mobile client concern, and keeping it here leaves the shared submodule
// untouched so this slice — which merges last in the mobile train — rebases
// cleanly regardless of cross-lane chat-core churn.

import {
  mutatePentacleEventBuckets,
  peekEventsForStream,
  type OptimisticSendState,
  type PentacleStreamState,
} from 'pentacle-chat-core';

// Automatic reconnect replay is bounded to survivors no older than 30 minutes.
// Older ambiguous sends stay visibly recoverable (manual retry) rather than being
// silently re-driven long after the fact.
export const RECONNECT_REPLAY_MAX_AGE_MS = 30 * 60 * 1000;

// A submit can race the transport close after the old generation has already
// been invalidated. Such a row never reached the wire, so it has no delivery
// window and is safe to arm for the first healthy socket that follows.
export function rearmOfflineQueuedSends(
  state: PentacleStreamState,
  generation: number,
  now = Date.now(),
  maxAgeMs = RECONNECT_REPLAY_MAX_AGE_MS,
): PentacleStreamState {
  let changed = false;
  const optimisticSends = { ...(state.optimisticSends ?? {}) };
  for (const [optimisticId, send] of Object.entries(optimisticSends)) {
    if (
      send.status !== 'queued' ||
      send.window_started_at !== null ||
      now - send.created_at > maxAgeMs
    ) continue;
    optimisticSends[optimisticId] = {
      ...send,
      reconnect_count: send.reconnect_count + 1,
      window_started_at: now,
      socket_generation: generation,
    };
    changed = true;
  }
  return changed ? { ...state, optimisticSends } : state;
}

// Which optimistic sends the client re-drives on a fresh socket generation.
// Only `queued` (never reached the wire) and `dispatched` (put on the wire but
// cut before ack — ambiguous) are replayed, and only within the replay window.
// `acked` survivors are reconciled from authoritative history by the
// hello/snapshot path first and are never blindly replayed; `indeterminate`
// (owner-lost / timed-out), terminal, and older survivors remain visibly
// recoverable. `generation` is the just-re-armed socket generation from
// onReconnect(); pass the same value the reconnect stamped. Ordered oldest-first
// (queued_at ?? created_at) so replay preserves FIFO intent.
export function eligibleReconnectReplayOptimisticIds(
  state: PentacleStreamState,
  generation: number,
  now = Date.now(),
  maxAgeMs = RECONNECT_REPLAY_MAX_AGE_MS,
): string[] {
  return Object.values(state.optimisticSends ?? {})
    .filter((send: OptimisticSendState) => (
      send.socket_generation === generation &&
      (send.status === 'queued' || send.status === 'dispatched') &&
      now - send.created_at <= maxAgeMs
    ))
    .sort((a, b) => (a.queued_at ?? a.created_at) - (b.queued_at ?? b.created_at))
    .map((send) => send.optimistic_id);
}

// A daemon restart is not a replay-safe transport cut: the daemon may have
// crashed after the provider effect but before its idempotency row was durable.
// Move only this generation's still-ambiguous survivors out of replay
// eligibility; the stream layer then exposes them through its existing
// indeterminate -> failed/retryable presentation path.
export function markDaemonRestartSurvivorsIndeterminate(
  state: PentacleStreamState,
  generation: number,
): PentacleStreamState {
  let changed = false;
  const optimisticSends: Record<string, OptimisticSendState> = {
    ...(state.optimisticSends ?? {}),
  };
  for (const [optimisticId, send] of Object.entries(optimisticSends)) {
    if (
      send.socket_generation !== generation ||
      (send.status !== 'queued' && send.status !== 'dispatched')
    ) continue;
    optimisticSends[optimisticId] = { ...send, status: 'indeterminate' };
    changed = true;
  }
  return changed ? { ...state, optimisticSends } : state;
}

// §A: an explicit user retry is a NEW logical send, so it mints a fresh
// request_id (retaining optimistic_id). The server's durable send_idempotency
// guard must therefore NOT collapse it onto the prior send's terminal (failed /
// owner-lost) frame. Applied on top of the reducer's re-arm, this rotates the
// row's request_id and re-points the optimisticByRequestId index, dropping the
// abandoned key so a late frame for the retired request_id no longer resolves
// here. No-op when the row is absent or the id is unchanged.
export function rotateOptimisticSendRequestId(
  state: PentacleStreamState,
  optimisticId: string,
  newRequestId: string,
): PentacleStreamState {
  const send = state.optimisticSends?.[optimisticId];
  if (!send || send.request_id === newRequestId) return state;
  const priorRequestId = send.request_id;
  const optimisticSends = {
    ...(state.optimisticSends ?? {}),
    [optimisticId]: { ...send, request_id: newRequestId },
  };
  const optimisticByRequestId = { ...(state.optimisticByRequestId ?? {}) };
  delete optimisticByRequestId[priorRequestId];
  optimisticByRequestId[newRequestId] = optimisticId;
  return { ...state, optimisticSends, optimisticByRequestId };
}

// notification_answer_replay_asymmetry §A parity — mobile-owned survivor helpers
// for notification-answer resolves. `resolveNotification` is a plain RPC with no
// optimisticSends row, so it can't ride the message-send survivor path; these give
// the resolve registry the same reconnect semantics (queue-on-offline, replay
// once/gen, 30-min bound, no replay on daemon restart) while keeping the shared
// chat-core reducer untouched. They operate structurally on the survivor
// bookkeeping fields only, so the caller may store richer entries (args, payload,
// request_id) on top of them.
export type NotificationResolveSurvivorStatus = 'queued' | 'dispatched';

export interface NotificationResolveSurvivor {
  notification_id: string;
  status: NotificationResolveSurvivorStatus;
  socket_generation: number;
  window_started_at: number | null;
  created_at: number;
  reconnect_count: number;
}

// Which pending resolves survive a transport cut and are re-driven on the next
// healthy socket generation: `queued` (never on the wire) or `dispatched` (on the
// wire but cut before its terminal frame — ambiguous, safe to replay because the
// daemon's §B path dedups on notification identity + canonical intent). Only
// within the replay window; ordered oldest-first so replay preserves intent order.
export function eligibleNotificationResolveReplayIds<T extends NotificationResolveSurvivor>(
  resolves: Record<string, T>,
  now = Date.now(),
  maxAgeMs = RECONNECT_REPLAY_MAX_AGE_MS,
): string[] {
  return Object.values(resolves)
    .filter((resolve) => (
      (resolve.status === 'queued' || resolve.status === 'dispatched') &&
      now - resolve.created_at <= maxAgeMs
    ))
    .sort((a, b) => a.created_at - b.created_at)
    .map((resolve) => resolve.notification_id);
}

// Re-arm every eligible surviving resolve onto the fresh socket generation so the
// reconnect boundary re-drives it exactly once per generation — the resolve-side
// analogue of rearmOfflineQueuedSends. Expired (>30 min) survivors are ignored here;
// the caller sweeps them first with expireNotificationResolveSurvivors and surfaces
// each as visibly recoverable so a stale answer is never silently dropped.
export function rearmNotificationResolveSurvivors<T extends NotificationResolveSurvivor>(
  resolves: Record<string, T>,
  generation: number,
  now = Date.now(),
  maxAgeMs = RECONNECT_REPLAY_MAX_AGE_MS,
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = { ...resolves };
  for (const [id, resolve] of Object.entries(resolves)) {
    if (
      (resolve.status !== 'queued' && resolve.status !== 'dispatched') ||
      now - resolve.created_at > maxAgeMs
    ) continue;
    next[id] = {
      ...resolve,
      socket_generation: generation,
      window_started_at: now,
      reconnect_count: resolve.reconnect_count + 1,
    };
    changed = true;
  }
  return changed ? next : resolves;
}

// A resolve that outlived the 30-min replay window is no longer auto-replayed
// (§A: expired survivors are visibly recoverable, not silently re-driven). Pull
// this generation's expired survivors out of the registry and hand them back so
// the caller surfaces each as recoverable — otherwise an offline answer that never
// reconnected in time would be silently dropped with a permanently pending card.
export function expireNotificationResolveSurvivors<T extends NotificationResolveSurvivor>(
  resolves: Record<string, T>,
  now = Date.now(),
  maxAgeMs = RECONNECT_REPLAY_MAX_AGE_MS,
): { next: Record<string, T>; removed: T[] } {
  const removed: T[] = [];
  const next: Record<string, T> = {};
  for (const [id, resolve] of Object.entries(resolves)) {
    if (
      (resolve.status === 'queued' || resolve.status === 'dispatched') &&
      now - resolve.created_at > maxAgeMs
    ) {
      removed.push(resolve);
      continue;
    }
    next[id] = resolve;
  }
  return { next: removed.length ? next : resolves, removed };
}

// A daemon restart (1012 `service_restart`) is not a replay-safe transport cut:
// the restarted daemon may have lost its idempotency row, so replay could
// double-execute in the crash sliver. Drop this generation's in-flight survivors
// out of replay eligibility and hand them back so the caller surfaces each as
// visibly recoverable. Mirrors markDaemonRestartSurvivorsIndeterminate.
export function markDaemonRestartNotificationResolvesIndeterminate<T extends NotificationResolveSurvivor>(
  resolves: Record<string, T>,
  generation: number,
): { next: Record<string, T>; removed: T[] } {
  const removed: T[] = [];
  const next: Record<string, T> = {};
  for (const [id, resolve] of Object.entries(resolves)) {
    if (
      resolve.socket_generation === generation &&
      (resolve.status === 'queued' || resolve.status === 'dispatched')
    ) {
      removed.push(resolve);
      continue;
    }
    next[id] = resolve;
  }
  return { next: removed.length ? next : resolves, removed };
}

// A daemon can reject an explicit retry because its prior optimistic identity
// is already occupied. Rekey the single visible row as one pure state
// transition so the transcript, optimistic map, request index, and active-turn
// identity cannot diverge before the replacement dispatch.
export function rekeyOptimisticSend(
  state: PentacleStreamState,
  priorOptimisticId: string,
  nextOptimisticId: string,
  nextRequestId: string,
): PentacleStreamState {
  if (!priorOptimisticId || !nextOptimisticId || !nextRequestId || priorOptimisticId === nextOptimisticId) {
    return state;
  }
  const prior = state.optimisticSends?.[priorOptimisticId];
  if (!prior) return state;

  const nextSend: OptimisticSendState = {
    ...prior,
    optimistic_id: nextOptimisticId,
    request_id: nextRequestId,
    status: 'queued',
    dispatched_at: undefined,
    acked_at: undefined,
    window_started_at: null,
    failure_reason: undefined,
    failed_at: undefined,
  };
  const optimisticSends = { ...(state.optimisticSends ?? {}) };
  delete optimisticSends[priorOptimisticId];
  optimisticSends[nextOptimisticId] = nextSend;

  const optimisticByRequestId: Record<string, string> = {};
  for (const send of Object.values(optimisticSends)) {
    if (send.status !== 'returned_to_prompt') {
      optimisticByRequestId[send.request_id] = send.optimistic_id;
    }
  }

  const priorEvent = peekEventsForStream(state, prior.stream_id).find((event) => (
    event.optimistic_id === priorOptimisticId
  ));
  const workingByStream = state.workingByStream?.[prior.stream_id]?.optimisticId === priorOptimisticId
    ? {
      ...(state.workingByStream ?? {}),
      [prior.stream_id]: {
        ...state.workingByStream![prior.stream_id],
        optimisticId: nextOptimisticId,
      },
    }
    : state.workingByStream;

  const next = {
    ...state,
    optimisticSends,
    optimisticByRequestId,
    ...(workingByStream ? { workingByStream } : {}),
  };
  return priorEvent
    ? mutatePentacleEventBuckets(next, {
      type: 'optimistic-replace',
      streamId: prior.stream_id,
      optimisticId: priorOptimisticId,
      event: { ...priorEvent, optimistic_id: nextOptimisticId, pending: true },
    })
    : next;
}
