import type { EventBucketRequestPurpose, EventBucketRequestState, PentacleEventBucket } from 'pentacle-chat-core';
import {
  finalizeStreamEventsResponse,
  hasReusableStreamEventsCoverage,
  streamEventsWindowForPurpose,
  type StreamEventsFinalizerInput,
  type StreamEventsPendingToken,
} from '../../src/services/streamEventsCoverage';

const now = 10_000;
const freshnessMs = 500;

function pending(
  purpose: EventBucketRequestPurpose = 'mount-fetch',
  overrides: Partial<StreamEventsPendingToken> = {},
): StreamEventsPendingToken {
  return {
    token: 'r1',
    generation: 7,
    socketMatches: true,
    streamId: 'hostc:codex:one',
    purpose,
    window: streamEventsWindowForPurpose(purpose),
    limit: 48,
    before: purpose === 'older-page' ? 90 : null,
    ...overrides,
  };
}

function active(value: StreamEventsPendingToken): EventBucketRequestState {
  return {
    token: value.token,
    purpose: value.purpose,
    window: value.window,
    generation: value.generation,
    limit: value.limit,
    before: value.before,
    status: 'loading',
  };
}

function input(
  overrides: Partial<StreamEventsFinalizerInput> = {},
  token = pending(),
): StreamEventsFinalizerInput {
  return {
    kind: 'terminal',
    pending: token,
    activeRequest: active(token),
    currentGeneration: 7,
    responseStreamId: token.streamId,
    eventStreamIds: [token.streamId],
    complete: true,
    currentTailAccepted: true,
    eventCount: 1,
    now,
    freshnessMs,
    ...overrides,
  };
}

test.each([
  ['accepted nonzero history', input(), true, 'progressive', true, false],
  ['accepted zero history', input({ eventStreamIds: [], eventCount: 0 }), true, 'progressive', true, true],
  ['history chunk', input({ kind: 'chunk' }), true, 'progressive', false, undefined],
  ['complete false', input({ complete: false }), true, 'progressive', false, false],
  ['rehydrate failed', input({ rehydrateFailed: true }), true, 'progressive', false, false],
  ['error', input({ kind: 'error', eventStreamIds: [] }), true, 'none', false, false],
  ['timeout', input({ kind: 'timeout', eventStreamIds: [] }), true, 'none', false, false],
] as const)(
  '%s finalization',
  (_name, value, matched, commit, complete, authoritativeZero) => {
    const result = finalizeStreamEventsResponse(value);
    expect(result.matched).toBe(matched);
    expect(result.commit).toBe(commit);
    expect(result.coverage?.complete ?? false).toBe(complete);
    if (authoritativeZero !== undefined) {
      expect(result.coverage?.authoritativeZero).toBe(authoritativeZero);
    }
  },
);

test.each([
  ['current-tail accepted', 'focused-refetch', true, 1, 'atomic', true, false],
  ['current-tail zero', 'freshness-guard', true, 0, 'atomic', true, true],
  ['current-tail rejected', 'focused-refetch', false, 1, 'none', false, false],
  ['older-page accepted', 'older-page', true, 2, 'atomic', true, false],
  ['older-page zero', 'older-page', true, 0, 'atomic', true, true],
] as const)(
  '%s window finalization',
  (_name, purpose, accepted, eventCount, commit, complete, authoritativeZero) => {
    const token = pending(purpose);
    const result = finalizeStreamEventsResponse(input({
      currentTailAccepted: accepted,
      eventCount,
      eventStreamIds: eventCount ? [token.streamId] : [],
    }, token));
    expect(result.commit).toBe(commit);
    expect(result.coverage?.window).toBe(token.window);
    expect(result.coverage?.complete ?? false).toBe(complete);
    expect(result.coverage?.authoritativeZero ?? false).toBe(authoritativeZero);
  },
);

test.each([
  ['unknown token', { activeRequest: undefined }],
  ['duplicate or settled token', { activeRequest: { status: 'ready' } as EventBucketRequestState }],
  ['stale generation', { currentGeneration: 8 }],
  ['stale token', { activeRequest: { ...active(pending()), token: 'r2' } }],
  ['mismatched response stream', { responseStreamId: 'hostc:codex:other' }],
  ['missing response stream', { responseStreamId: undefined }],
  ['mismatched event stream', { eventStreamIds: ['hostc:codex:other'] }],
  ['mismatched socket', { pending: pending('mount-fetch', { socketMatches: false }) }],
] as const)('%s is a no-op', (_name, overrides) => {
  const value = input(overrides as Partial<StreamEventsFinalizerInput>);
  expect(finalizeStreamEventsResponse(value)).toMatchObject({
    matched: false,
    commit: 'none',
    settle: false,
    replaceCoverage: false,
  });
});

test('reconnect fences the matching old generation while retaining stale coverage evidence', () => {
  const token = pending('mount-fetch', { generation: 6, socketMatches: false });
  const result = finalizeStreamEventsResponse(input({
    kind: 'reconnect',
    currentGeneration: 7,
    eventStreamIds: [],
  }, token));
  expect(result).toMatchObject({ matched: true, commit: 'none', settle: true });
  expect(result.request?.status).toBe('idle');
  expect(result.coverage?.complete).toBe(false);
});

test('concurrent out-of-order windows stay isolated and an older same-window token cannot overwrite', () => {
  const history = pending('mount-fetch', { token: 'h1', limit: 300 });
  const tail = pending('focused-refetch', { token: 't1', limit: 300 });
  const tailResult = finalizeStreamEventsResponse(input({}, tail));
  const historyResult = finalizeStreamEventsResponse(input({}, history));
  expect([tailResult.coverage?.window, historyResult.coverage?.window]).toEqual(['current-tail', 'history']);

  const olderHistory = pending('mount-fetch', { token: 'h0', limit: 48 });
  const staleResult = finalizeStreamEventsResponse(input({ activeRequest: active(history) }, olderHistory));
  expect(staleResult).toMatchObject({ matched: false, commit: 'none', replaceCoverage: false });
});

test('window mapping keeps regular history progressive and only tail/page atomic', () => {
  expect(['mount-fetch', 'prefetch', 'manual'].map((purpose) => (
    streamEventsWindowForPurpose(purpose as EventBucketRequestPurpose)
  ))).toEqual(['history', 'history', 'history']);
  expect(streamEventsWindowForPurpose('focused-refetch')).toBe('current-tail');
  expect(streamEventsWindowForPurpose('older-page')).toBe('older-page');
});

test.each([
  ['fresh sufficient window', now + 1, 48, true, 7],
  ['expired TTL', now + freshnessMs + 1, 48, false, 7],
  ['insufficient limit', now + 1, 49, false, 7],
  ['stale generation', now + 1, 48, false, 8],
] as const)('%s controls prefetch reuse', (_name, at, limit, expected, generation) => {
  const bucket = {
    coverageByWindow: {
      history: {
        window: 'history',
        purpose: 'mount-fetch',
        generation: 7,
        requestLimit: 48,
        before: null,
        completedAt: now,
        complete: true,
        authoritativeZero: false,
        freshUntil: now + freshnessMs,
      },
    },
  } as PentacleEventBucket;
  expect(hasReusableStreamEventsCoverage(bucket, {
    purpose: 'prefetch',
    generation,
    limit,
    before: null,
    now: at,
  })).toBe(expected);
});

test('older-page evidence cannot satisfy a current history prefetch', () => {
  const bucket = {
    coverageByWindow: {
      'older-page': {
        window: 'older-page',
        purpose: 'older-page',
        generation: 7,
        requestLimit: 48,
        before: 90,
        complete: true,
        authoritativeZero: true,
        freshUntil: now + freshnessMs,
      },
    },
  } as PentacleEventBucket;
  expect(hasReusableStreamEventsCoverage(bucket, {
    purpose: 'prefetch',
    generation: 7,
    limit: 48,
    before: null,
    now,
  })).toBe(false);
});
