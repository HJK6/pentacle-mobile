import {
  initialPentacleStreamState,
  markOptimisticDispatchedByRequestId,
  markOptimisticFailedByOptimisticId,
  onReconnect,
  sendOptimisticMessage,
} from 'pentacle-chat-core';
import type {
  OptimisticSendStatus,
  PentacleSessionSummary,
  PentacleStreamState,
} from 'pentacle-chat-core';

import {
  RECONNECT_REPLAY_MAX_AGE_MS,
  eligibleReconnectReplayOptimisticIds,
  markDaemonRestartSurvivorsIndeterminate,
  rearmOfflineQueuedSends,
  rotateOptimisticSendRequestId,
  eligibleNotificationResolveReplayIds,
  rearmNotificationResolveSurvivors,
  expireNotificationResolveSurvivors,
  markDaemonRestartNotificationResolvesIndeterminate,
  type NotificationResolveSurvivor,
} from '../src/services/reconnectReplay';

const STREAM_ID = 'hostc:codex:one';
const OPTIMISTIC_ID = 'optimistic_hostc_codex_one_1';
const REQUEST_ID = 'send-req-1';
const CREATED_AT = Date.parse('2026-07-23T12:00:00.000Z');
const GEN = 7;
const NEXT_GEN = 8;

function session(): PentacleSessionSummary {
  return {
    stream_id: STREAM_ID,
    host: 'hostc',
    provider: 'codex',
    session_name: 'one',
    last_event_at: '2026-07-23T12:00:00.000Z',
    last_text: '',
    last_kind: '',
    draft: '',
    pending: false,
    working: false,
    online: true,
  };
}

function buildState(): PentacleStreamState {
  return { ...initialPentacleStreamState, connected: true, sessions: [session()] };
}

function optimisticState(status: OptimisticSendStatus, gen = GEN): PentacleStreamState {
  const queued = sendOptimisticMessage(buildState(), {
    streamId: STREAM_ID,
    text: 'hello',
    optimisticId: OPTIMISTIC_ID,
    requestId: REQUEST_ID,
    createdAt: CREATED_AT,
    windowStartedAt: CREATED_AT,
    socketGeneration: gen,
  });
  if (status === 'queued') return queued;
  if (status === 'dispatched') {
    return markOptimisticDispatchedByRequestId(queued, REQUEST_ID, CREATED_AT + 10, gen);
  }
  if (status === 'failed') {
    return markOptimisticFailedByOptimisticId(queued, OPTIMISTIC_ID, 'send_error', CREATED_AT + 20);
  }
  return {
    ...queued,
    optimisticSends: {
      [OPTIMISTIC_ID]: { ...queued.optimisticSends![OPTIMISTIC_ID], status },
    },
  };
}

describe('rearmOfflineQueuedSends', () => {
  test('arms a never-dispatched offline row for exactly one replay on the new generation', () => {
    const offline = sendOptimisticMessage(buildState(), {
      streamId: STREAM_ID,
      text: 'offline',
      optimisticId: OPTIMISTIC_ID,
      requestId: REQUEST_ID,
      createdAt: CREATED_AT,
      windowStartedAt: null,
      socketGeneration: GEN + 1,
    });

    const next = rearmOfflineQueuedSends(offline, NEXT_GEN, CREATED_AT + 1_000);

    expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
      status: 'queued',
      reconnect_count: 1,
      socket_generation: NEXT_GEN,
      window_started_at: CREATED_AT + 1_000,
    });
    expect(eligibleReconnectReplayOptimisticIds(next, NEXT_GEN, CREATED_AT + 1_000)).toEqual([OPTIMISTIC_ID]);
  });

  test('does not rearm a queued row that already had a delivery window', () => {
    const state = optimisticState('queued');
    expect(rearmOfflineQueuedSends(state, NEXT_GEN, CREATED_AT + 1_000)).toBe(state);
  });

  test('does not rearm an expired offline row', () => {
    const offline = sendOptimisticMessage(buildState(), {
      streamId: STREAM_ID,
      text: 'offline',
      optimisticId: OPTIMISTIC_ID,
      requestId: REQUEST_ID,
      createdAt: CREATED_AT,
      windowStartedAt: null,
      socketGeneration: GEN + 1,
    });
    expect(rearmOfflineQueuedSends(
      offline,
      NEXT_GEN,
      CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS + 1,
    )).toBe(offline);
  });
});

describe('eligibleReconnectReplayOptimisticIds (§A auto-replay eligibility)', () => {
  const rearm = (status: OptimisticSendStatus) =>
    onReconnect(optimisticState(status), GEN, CREATED_AT + 1_000, NEXT_GEN);

  test.each<OptimisticSendStatus>(['queued', 'dispatched'])(
    'replays a %s survivor on the re-armed generation',
    (status) => {
      expect(eligibleReconnectReplayOptimisticIds(rearm(status), NEXT_GEN, CREATED_AT + 2_000)).toEqual([
        OPTIMISTIC_ID,
      ]);
    },
  );

  test.each<OptimisticSendStatus>(['acked', 'indeterminate', 'echoed', 'reconciled', 'failed'])(
    'never auto-replays a %s survivor',
    (status) => {
      expect(eligibleReconnectReplayOptimisticIds(rearm(status), NEXT_GEN, CREATED_AT + 2_000)).toEqual([]);
    },
  );

  test('excludes a survivor older than the 30-minute replay window', () => {
    const now = CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS + 1;
    expect(eligibleReconnectReplayOptimisticIds(rearm('dispatched'), NEXT_GEN, now)).toEqual([]);
  });

  test('includes a survivor exactly at the 30-minute boundary (inclusive)', () => {
    const now = CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS;
    expect(eligibleReconnectReplayOptimisticIds(rearm('dispatched'), NEXT_GEN, now)).toEqual([OPTIMISTIC_ID]);
  });

  test('ignores a survivor stamped for a different socket generation', () => {
    expect(eligibleReconnectReplayOptimisticIds(rearm('dispatched'), NEXT_GEN + 1, CREATED_AT + 2_000)).toEqual([]);
  });

  test('orders replay oldest-first (FIFO by queued_at ?? created_at)', () => {
    const first = sendOptimisticMessage(buildState(), {
      streamId: STREAM_ID,
      text: 'first',
      optimisticId: 'optimistic_a',
      requestId: 'req-a',
      createdAt: CREATED_AT,
      windowStartedAt: CREATED_AT,
      socketGeneration: GEN,
    });
    const both = sendOptimisticMessage(first, {
      streamId: STREAM_ID,
      text: 'second',
      optimisticId: 'optimistic_b',
      requestId: 'req-b',
      createdAt: CREATED_AT + 500,
      windowStartedAt: CREATED_AT + 500,
      socketGeneration: GEN,
    });
    const armed = onReconnect(both, GEN, CREATED_AT + 1_000, NEXT_GEN);
    expect(eligibleReconnectReplayOptimisticIds(armed, NEXT_GEN, CREATED_AT + 2_000)).toEqual([
      'optimistic_a',
      'optimistic_b',
    ]);
  });
});

describe('markDaemonRestartSurvivorsIndeterminate (§A restart safety)', () => {
  test.each<OptimisticSendStatus>(['queued', 'dispatched'])(
    'marks this generation\'s %s survivor indeterminate and ineligible for replay',
    (status) => {
      const armed = onReconnect(optimisticState(status), GEN, CREATED_AT + 1_000, NEXT_GEN);
      const marked = markDaemonRestartSurvivorsIndeterminate(armed, NEXT_GEN);

      expect(marked.optimisticSends?.[OPTIMISTIC_ID]?.status).toBe('indeterminate');
      expect(eligibleReconnectReplayOptimisticIds(marked, NEXT_GEN, CREATED_AT + 2_000)).toEqual([]);
    },
  );

  test('is a no-op for terminal or different-generation survivors', () => {
    const terminal = optimisticState('failed');
    expect(markDaemonRestartSurvivorsIndeterminate(terminal, GEN)).toBe(terminal);
    const otherGeneration = optimisticState('dispatched', GEN - 1);
    expect(markDaemonRestartSurvivorsIndeterminate(otherGeneration, GEN)).toBe(otherGeneration);
  });
});

describe('rotateOptimisticSendRequestId (§A explicit retry)', () => {
  const NEW_REQUEST_ID = 'send-req-2';

  test('mints the new request_id, retains optimistic_id, and re-points the index', () => {
    const next = rotateOptimisticSendRequestId(optimisticState('dispatched'), OPTIMISTIC_ID, NEW_REQUEST_ID);
    expect(next.optimisticSends?.[OPTIMISTIC_ID]).toMatchObject({
      optimistic_id: OPTIMISTIC_ID,
      request_id: NEW_REQUEST_ID,
    });
    expect(next.optimisticByRequestId?.[NEW_REQUEST_ID]).toBe(OPTIMISTIC_ID);
    expect(next.optimisticByRequestId?.[REQUEST_ID]).toBeUndefined(); // abandoned key dropped
  });

  test('is a no-op when the new id equals the current one', () => {
    const state = optimisticState('dispatched');
    expect(rotateOptimisticSendRequestId(state, OPTIMISTIC_ID, REQUEST_ID)).toBe(state);
  });

  test('is a no-op for an absent row', () => {
    const state = optimisticState('dispatched');
    expect(rotateOptimisticSendRequestId(state, 'nope', NEW_REQUEST_ID)).toBe(state);
  });
});

describe('notification-resolve survivors (§A parity)', () => {
  const RESOLVE_GEN = 4;
  const RESOLVE_NEXT_GEN = 5;

  function resolve(overrides: Partial<NotificationResolveSurvivor> = {}): NotificationResolveSurvivor {
    return {
      notification_id: 'n1',
      status: 'queued',
      socket_generation: RESOLVE_GEN,
      window_started_at: null,
      created_at: CREATED_AT,
      reconnect_count: 0,
      ...overrides,
    };
  }

  function resolves(...entries: NotificationResolveSurvivor[]): Record<string, NotificationResolveSurvivor> {
    return Object.fromEntries(entries.map((entry) => [entry.notification_id, entry]));
  }

  describe('eligibleNotificationResolveReplayIds', () => {
    test('includes queued and dispatched within the window, oldest first', () => {
      const map = resolves(
        resolve({ notification_id: 'newer', status: 'dispatched', created_at: CREATED_AT + 1_000 }),
        resolve({ notification_id: 'older', status: 'queued', created_at: CREATED_AT }),
      );
      expect(eligibleNotificationResolveReplayIds(map, CREATED_AT + 2_000)).toEqual(['older', 'newer']);
    });

    test('excludes survivors older than the 30-minute window', () => {
      const map = resolves(resolve({ created_at: CREATED_AT }));
      expect(eligibleNotificationResolveReplayIds(map, CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS + 1)).toEqual([]);
    });
  });

  describe('rearmNotificationResolveSurvivors', () => {
    test('retargets eligible survivors to the fresh generation and stamps the window', () => {
      const map = resolves(resolve({ status: 'dispatched' }));
      const next = rearmNotificationResolveSurvivors(map, RESOLVE_NEXT_GEN, CREATED_AT + 5_000);
      expect(next.n1).toMatchObject({
        status: 'dispatched',
        socket_generation: RESOLVE_NEXT_GEN,
        window_started_at: CREATED_AT + 5_000,
        reconnect_count: 1,
      });
    });

    test('leaves an expired survivor untouched for the caller to surface as recoverable', () => {
      const map = resolves(resolve({ created_at: CREATED_AT }));
      const next = rearmNotificationResolveSurvivors(map, RESOLVE_NEXT_GEN, CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS + 1);
      expect(next).toBe(map);
    });
  });

  describe('expireNotificationResolveSurvivors', () => {
    test('pulls out survivors older than the window and hands them back for surfacing', () => {
      const map = resolves(
        resolve({ notification_id: 'stale', created_at: CREATED_AT }),
        resolve({ notification_id: 'fresh', created_at: CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS }),
      );
      const { next, removed } = expireNotificationResolveSurvivors(map, CREATED_AT + RECONNECT_REPLAY_MAX_AGE_MS + 1);
      expect(removed.map((entry) => entry.notification_id)).toEqual(['stale']);
      expect(next.stale).toBeUndefined();
      expect(next.fresh).toBeTruthy();
    });

    test('is a no-op when nothing has expired', () => {
      const map = resolves(resolve({ created_at: CREATED_AT }));
      const { next, removed } = expireNotificationResolveSurvivors(map, CREATED_AT + 1_000);
      expect(removed).toEqual([]);
      expect(next).toBe(map);
    });
  });

  describe('markDaemonRestartNotificationResolvesIndeterminate', () => {
    test('drops this generation in-flight survivors and hands them back', () => {
      const map = resolves(
        resolve({ notification_id: 'restarted', status: 'dispatched', socket_generation: RESOLVE_GEN }),
        resolve({ notification_id: 'other-gen', status: 'queued', socket_generation: RESOLVE_GEN - 1 }),
      );
      const { next, removed } = markDaemonRestartNotificationResolvesIndeterminate(map, RESOLVE_GEN);
      expect(removed.map((entry) => entry.notification_id)).toEqual(['restarted']);
      expect(next.restarted).toBeUndefined();
      expect(next['other-gen']).toBeTruthy();
    });

    test('is a no-op when nothing matches the restarted generation', () => {
      const map = resolves(resolve({ socket_generation: RESOLVE_GEN - 1 }));
      const { next, removed } = markDaemonRestartNotificationResolvesIndeterminate(map, RESOLVE_GEN);
      expect(removed).toEqual([]);
      expect(next).toBe(map);
    });
  });
});
