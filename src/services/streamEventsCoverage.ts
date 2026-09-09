import type {
  EventBucketCoverage,
  EventBucketRequestPurpose,
  EventBucketRequestState,
  EventBucketRequestWindow,
  PentacleEventBucket,
} from 'pentacle-chat-core';

export type StreamEventsPendingToken = {
  token: string;
  generation: number;
  socketMatches: boolean;
  streamId: string;
  purpose: EventBucketRequestPurpose;
  window: EventBucketRequestWindow;
  limit?: number;
  before?: number | null;
};

export type StreamEventsFinalizerInput = {
  kind: 'chunk' | 'terminal' | 'error' | 'timeout' | 'reconnect';
  pending?: StreamEventsPendingToken;
  activeRequest?: EventBucketRequestState;
  currentGeneration: number;
  responseStreamId?: string;
  eventStreamIds?: readonly string[];
  complete?: boolean;
  rehydrateFailed?: boolean;
  currentTailAccepted?: boolean;
  eventCount?: number;
  existingCoverage?: EventBucketCoverage;
  now: number;
  freshnessMs: number;
};

export type StreamEventsFinalizerResult = {
  matched: boolean;
  window?: EventBucketRequestWindow;
  commit: 'none' | 'progressive' | 'atomic';
  cursorEvidence: boolean;
  authoritativeAccepted: boolean;
  settle: boolean;
  request?: EventBucketRequestState;
  coverage?: EventBucketCoverage;
  replaceCoverage: boolean;
};

export function streamEventsWindowForPurpose(
  purpose: EventBucketRequestPurpose,
): EventBucketRequestWindow {
  if (purpose === 'older-page') return 'older-page';
  if (purpose === 'freshness-guard' || purpose === 'focused-refetch') return 'current-tail';
  return 'history';
}

function sameOptionalNumber(left: number | null | undefined, right: number | null | undefined) {
  return (left ?? null) === (right ?? null);
}

function tokenMatches(input: StreamEventsFinalizerInput) {
  const pending = input.pending;
  const active = input.activeRequest;
  if (!pending || !active?.token) return false;
  if (!pending.socketMatches && input.kind !== 'reconnect') return false;
  if (input.kind !== 'reconnect' && pending.generation !== input.currentGeneration) return false;
  if (
    active.token !== pending.token ||
    active.generation !== pending.generation ||
    active.purpose !== pending.purpose ||
    active.window !== pending.window ||
    active.limit !== pending.limit ||
    !sameOptionalNumber(active.before, pending.before)
  ) return false;
  const responseStreamId = String(input.responseStreamId || '').trim();
  if ((input.kind === 'chunk' || input.kind === 'terminal') && !responseStreamId) return false;
  if (responseStreamId && responseStreamId !== pending.streamId) return false;
  return (input.eventStreamIds ?? []).every((streamId) => streamId === pending.streamId);
}

function staleCoverage(
  input: StreamEventsFinalizerInput,
  pending: StreamEventsPendingToken,
): EventBucketCoverage {
  return {
    ...(input.existingCoverage ?? {}),
    window: pending.window,
    purpose: pending.purpose,
    generation: pending.generation,
    requestLimit: pending.limit ?? 0,
    before: pending.before ?? null,
    complete: false,
    authoritativeZero: false,
    freshUntil: undefined,
  };
}

/** Sole pure authority for request_stream_events response and failure state. */
export function finalizeStreamEventsResponse(
  input: StreamEventsFinalizerInput,
): StreamEventsFinalizerResult {
  if (!tokenMatches(input)) {
    return {
      matched: false,
      commit: 'none',
      cursorEvidence: false,
      authoritativeAccepted: false,
      settle: false,
      replaceCoverage: false,
    };
  }
  const pending = input.pending!;
  if (input.kind === 'chunk') {
    return {
      matched: true,
      window: pending.window,
      commit: pending.window === 'history' ? 'progressive' : 'none',
      cursorEvidence: pending.window === 'history',
      authoritativeAccepted: false,
      settle: false,
      request: input.activeRequest ? { ...input.activeRequest, status: 'loading' } : undefined,
      replaceCoverage: false,
    };
  }
  if (input.kind === 'error' || input.kind === 'timeout' || input.kind === 'reconnect') {
    return {
      matched: true,
      window: pending.window,
      commit: 'none',
      cursorEvidence: false,
      authoritativeAccepted: false,
      settle: true,
      request: { status: input.kind === 'reconnect' ? 'idle' : 'error' },
      coverage: staleCoverage(input, pending),
      replaceCoverage: true,
    };
  }
  const authoritativeAccepted = input.complete !== false &&
    input.rehydrateFailed !== true &&
    (pending.window !== 'current-tail' || input.currentTailAccepted === true);
  if (!authoritativeAccepted) {
    return {
      matched: true,
      window: pending.window,
      commit: pending.window === 'history' ? 'progressive' : 'none',
      cursorEvidence: pending.window === 'history',
      authoritativeAccepted: false,
      settle: true,
      request: { status: 'error' },
      coverage: staleCoverage(input, pending),
      replaceCoverage: true,
    };
  }
  const completedAt = input.now;
  return {
    matched: true,
    window: pending.window,
    commit: pending.window === 'history' ? 'progressive' : 'atomic',
    cursorEvidence: true,
    authoritativeAccepted: true,
    settle: true,
    request: { status: 'ready' },
    coverage: {
      window: pending.window,
      purpose: pending.purpose,
      generation: pending.generation,
      requestLimit: pending.limit ?? 0,
      before: pending.before ?? null,
      completedAt,
      complete: true,
      cursor: input.existingCoverage?.cursor ?? null,
      authoritativeZero: (input.eventCount ?? 0) === 0,
      freshUntil: completedAt + input.freshnessMs,
    },
    replaceCoverage: true,
  };
}

export function hasReusableStreamEventsCoverage(
  bucket: PentacleEventBucket | undefined,
  request: {
    purpose: EventBucketRequestPurpose;
    generation: number;
    limit?: number;
    before?: number | null;
    now: number;
  },
) {
  const window = streamEventsWindowForPurpose(request.purpose);
  const coverage = bucket?.coverageByWindow?.[window] ??
    (window === 'history' ? bucket?.coverage : undefined);
  return coverage?.complete === true &&
    (coverage.window ?? 'history') === window &&
    coverage.generation === request.generation &&
    coverage.requestLimit >= (request.limit ?? 0) &&
    sameOptionalNumber(coverage.before, request.before) &&
    (coverage.freshUntil ?? 0) > request.now;
}
