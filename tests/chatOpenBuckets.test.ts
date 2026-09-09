import {
  eventsForStream,
  initialPentacleStreamState,
  mutatePentacleEventBuckets,
  PENTACLE_PER_STREAM_MAX_EVENTS,
  PENTACLE_TOTAL_EVENT_COST_MAX,
  retainedPentacleEventCost,
  selectPentacleDerivedEventIndex,
  selectSessionDetail,
  sendOptimisticMessage,
  setPentacleEventBucketValidationObserver,
  weightedPentacleEventCost,
  type PentacleEvent,
  type PentacleSessionSummary,
  type PentacleStreamState,
} from 'pentacle-chat-core';
import {
  createChatOpenValidationCounters,
  retainedWeightedCost,
  weightedRetainedEventCost,
} from './helpers/chatOpenValidation';

function event(streamId: string, seq: number, text = ''): PentacleEvent {
  return {
    daemon_seq: seq,
    host: streamId.split(':')[0],
    provider: 'codex',
    session_id: streamId,
    session_name: streamId,
    stream_id: streamId,
    timestamp: `2026-08-28T00:00:${String(seq).padStart(2, '0')}.000Z`,
    kind: 'ASSIST',
    text,
  };
}

function session(streamId: string): PentacleSessionSummary {
  return {
    stream_id: streamId,
    host: streamId.split(':')[0],
    provider: 'codex',
    session_name: streamId,
    last_event_at: '2026-08-28T00:00:59.000Z',
    last_text: '',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    working_label: '',
    online: true,
  };
}

function legacyState(events: PentacleEvent[], streamIds: string[]): PentacleStreamState {
  return {
    ...initialPentacleStreamState,
    events,
    eventBucketsByStream: undefined,
    eventBucketMutationRevision: undefined,
    sessions: streamIds.map(session),
  };
}

test('bucket truth preserves unrelated-stream identity and exposes a frozen compatibility projection', () => {
  const a = 'hostc:codex:a';
  const b = 'hostc:codex:b';
  const normalized = mutatePentacleEventBuckets(
    legacyState([event(a, 1), event(b, 2)], [a, b]),
    { type: 'snapshot-replace', events: [event(a, 1), event(b, 2)], retainedStreamIds: [a, b] },
  );
  const priorB = normalized.eventBucketsByStream?.[b];
  const next = mutatePentacleEventBuckets(normalized, { type: 'append', events: [event(a, 3)] });

  expect(eventsForStream(next, a)).toHaveLength(2);
  expect(next.eventBucketsByStream?.[b]).toBe(priorB);
  expect(Object.isFrozen(next.events)).toBe(true);
  expect(() => next.events.push(event(a, 4))).toThrow();
});

test('the compatibility projection stays frozen in production builds', () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const state = mutatePentacleEventBuckets(
      legacyState([event('hostc:codex:a', 1)], ['hostc:codex:a']),
      { type: 'append', events: [event('hostc:codex:a', 2)] },
    );
    expect(Object.isFrozen(state.events)).toBe(true);
    expect(Object.isFrozen(state.events[0])).toBe(true);
    expect(Object.isFrozen(state.eventBucketsByStream?.['hostc:codex:a']?.events)).toBe(true);
  } finally {
    process.env.NODE_ENV = prior;
  }
});

test('G4 observes only the focused bucket and one stable derived-index rebuild', () => {
  const streamIds = Array.from({ length: 10 }, (_, index) => `hostc:codex:${index}`);
  const events = streamIds.flatMap((streamId, streamIndex) => (
    Array.from({ length: 40 }, (_, row) => event(streamId, streamIndex * 40 + row + 1, `row ${row}`))
  ));
  const state = mutatePentacleEventBuckets(
    legacyState(events, streamIds),
    { type: 'snapshot-replace', events, retainedStreamIds: streamIds },
    { totalEventCostMax: 10_000 },
  );
  const counters = createChatOpenValidationCounters();
  setPentacleEventBucketValidationObserver(counters);
  try {
    expect(selectSessionDetail(state, streamIds[4], { visibleCount: 'all' })).not.toBeNull();
    expect(counters.snapshot().bucketRowsVisited).toBe(40);
    selectPentacleDerivedEventIndex(state);
    selectPentacleDerivedEventIndex(state);
    expect(counters.snapshot().derivedIndexRebuilds).toBe(1);
  } finally {
    setPentacleEventBucketValidationObserver(null);
  }
});

test('G5 cost semantics match lane-1 fixtures and the default is twenty stream caps', () => {
  const rows = [
    event('hostc:codex:a', 1, ''),
    { ...event('hostc:codex:a', 2, 'x'.repeat(257)), client_origin: true },
    { ...event('hostc:codex:a', 3, 'photo'), attachments: [{ key: 'a', mime: 'image/jpeg' }] },
  ];
  expect(rows.map(weightedPentacleEventCost)).toEqual(rows.map(weightedRetainedEventCost));
  expect(retainedPentacleEventCost(legacyState(rows, ['hostc:codex:a']))).toBe(retainedWeightedCost(rows));
  expect(PENTACLE_TOTAL_EVENT_COST_MAX).toBe(20 * PENTACLE_PER_STREAM_MAX_EVENTS);
});

test('retention evicts deterministic LRU candidates, preserves pins, and retries after unpin', () => {
  const a = 'hostc:codex:a';
  const b = 'hostc:codex:b';
  const c = 'hostc:codex:c';
  const all = [event(a, 1), event(a, 2), event(b, 3), event(b, 4), event(c, 5), event(c, 6)];
  const corpusBudget = 4;
  expect(corpusBudget).toBeLessThan(retainedWeightedCost(all));
  let state = mutatePentacleEventBuckets(
    legacyState(all, [a, b, c]),
    { type: 'snapshot-replace', events: all, retainedStreamIds: [a, b, c] },
    { totalEventCostMax: 100 },
  );
  state = mutatePentacleEventBuckets(state, { type: 'touch', streamId: a, source: 'focus' }, { totalEventCostMax: 100 });
  state = mutatePentacleEventBuckets(state, { type: 'set-pin', streamId: b, pin: 'focused', pinned: true }, { totalEventCostMax: 100 });
  state = mutatePentacleEventBuckets(state, { type: 'set-request', streamId: b, request: { status: 'idle' } }, { totalEventCostMax: corpusBudget });
  expect(state.eventBucketsByStream?.[c]).toBeUndefined();
  expect(state.eventBucketsByStream?.[a]).toBeDefined();
  expect(state.eventBucketsByStream?.[b]).toBeDefined();
  expect(retainedPentacleEventCost(state)).toBeLessThanOrEqual(corpusBudget);

  let pinned = mutatePentacleEventBuckets(
    legacyState([event(a, 1), event(b, 2)], [a, b]),
    { type: 'snapshot-replace', events: [event(a, 1), event(b, 2)], retainedStreamIds: [a, b] },
    { totalEventCostMax: 100 },
  );
  pinned = mutatePentacleEventBuckets(pinned, { type: 'set-pin', streamId: a, pin: 'focused', pinned: true }, { totalEventCostMax: 100 });
  pinned = mutatePentacleEventBuckets(pinned, { type: 'set-pin', streamId: b, pin: 'focused', pinned: true }, { totalEventCostMax: 1 });
  expect(retainedPentacleEventCost(pinned)).toBe(2);
  pinned = mutatePentacleEventBuckets(pinned, { type: 'set-pin', streamId: a, pin: 'focused', pinned: false }, { totalEventCostMax: 1 });
  expect(pinned.eventBucketsByStream?.[a]).toBeUndefined();
  expect(pinned.eventBucketsByStream?.[b]).toBeDefined();
});

test('active optimistic sends and loading requests pin their buckets before retention', () => {
  const a = 'hostc:codex:a';
  const optimistic = sendOptimisticMessage(legacyState([], [a]), {
    streamId: a,
    text: 'pending',
    optimisticId: 'optimistic-a',
    requestId: 'request-a',
    createdAt: Date.now(),
  });
  expect(optimistic.eventBucketsByStream?.[a]?.pins.optimistic).toBe(true);

  const loading = mutatePentacleEventBuckets(optimistic, {
    type: 'set-request',
    streamId: a,
    request: { status: 'loading' },
  }, { totalEventCostMax: 0 });
  expect(loading.eventBucketsByStream?.[a]?.pins.inFlight).toBe(true);
  expect(loading.eventBucketsByStream?.[a]).toBeDefined();
});

test('an unrelated projection rebuild cannot evict a window-fenced request bucket', () => {
  const active = 'hostc:codex:active';
  const other = 'hostc:codex:other';
  let state = mutatePentacleEventBuckets(legacyState([], []), {
    type: 'set-request-window',
    streamId: active,
    window: 'history',
    request: {
      token: 'history-1',
      purpose: 'mount-fetch',
      window: 'history',
      generation: 1,
      limit: 48,
      status: 'loading',
    },
    replaceCoverage: true,
  });
  state = mutatePentacleEventBuckets(state, {
    type: 'snapshot-replace',
    events: [event(other, 1)],
  });
  expect(state.eventBucketsByStream?.[active]?.requestsByWindow?.history?.token).toBe('history-1');
  expect(state.eventBucketsByStream?.[active]?.pins.inFlight).toBe(true);
});

test('per-stream cap keeps optimistic rows and invalidates older coverage', () => {
  const streamId = 'hostc:codex:cap';
  const optimistic = { ...event(streamId, 2), client_origin: true, optimistic_id: 'optimistic-2' };
  let state = mutatePentacleEventBuckets(
    legacyState([event(streamId, 1), optimistic, event(streamId, 3)], [streamId]),
    { type: 'snapshot-replace', events: [event(streamId, 1), optimistic, event(streamId, 3)], retainedStreamIds: [streamId] },
    { perStreamMaxEvents: 3, totalEventCostMax: 100 },
  );
  state = mutatePentacleEventBuckets(state, {
    type: 'set-coverage',
    streamId,
    coverage: { generation: 1, requestLimit: 3, complete: true, cursor: 1, authoritativeZero: false },
  }, { totalEventCostMax: 100 });
  state = mutatePentacleEventBuckets(state, { type: 'append', events: [event(streamId, 4)] }, {
    perStreamMaxEvents: 3,
    totalEventCostMax: 100,
  });
  const bucket = state.eventBucketsByStream?.[streamId];
  expect(bucket?.events).toHaveLength(3);
  expect(bucket?.events.some((row) => row.optimistic_id === 'optimistic-2')).toBe(true);
  expect(bucket?.events.some((row) => row.daemon_seq === 1)).toBe(false);
  expect(bucket?.coverage?.complete).toBe(false);
});

test('the derived index is chronological without changing compatibility insertion order', () => {
  const a = event('hostc:codex:a', 2);
  const b = { ...event('hostc:codex:b', 1), timestamp: '2026-08-27T23:59:00.000Z' };
  const state = mutatePentacleEventBuckets(
    legacyState([a, b], [a.stream_id, b.stream_id]),
    { type: 'snapshot-replace', events: [a, b], retainedStreamIds: [a.stream_id, b.stream_id] },
  );
  expect(state.events).toEqual([a, b]);
  expect(selectPentacleDerivedEventIndex(state).chronological).toEqual([b, a]);
});
