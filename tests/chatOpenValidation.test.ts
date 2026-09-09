import {
  countedBucketRows,
  createChatOpenValidationCounters,
  retainedWeightedCost,
  WEIGHTED_EVENT_COST,
  weightedRetainedEventCost,
} from './helpers/chatOpenValidation';

test('test-only counters prove a focused selector visits only its focused bucket and records index rebuilds', () => {
  const counters = createChatOpenValidationCounters();
  const focusedRows = Array.from({ length: 600 }, (_, index) => ({ daemon_seq: index + 1 }));

  expect([...countedBucketRows(focusedRows, counters)]).toHaveLength(600);
  counters.rebuiltDerivedIndex();

  expect(counters.snapshot()).toEqual({ bucketRowsVisited: 600, derivedIndexRebuilds: 1 });
  counters.reset();
  expect(counters.snapshot()).toEqual({ bucketRowsVisited: 0, derivedIndexRebuilds: 0 });
});

test('weighted retention cost is deterministic and independent of heap allocation', () => {
  const heavy = {
    text: 'x'.repeat(513),
    attachments: [{}, {}],
    client_origin: true,
  };

  expect(weightedRetainedEventCost(heavy)).toBe(
    WEIGHTED_EVENT_COST.base + 3 + 2 * WEIGHTED_EVENT_COST.attachment + WEIGHTED_EVENT_COST.optimistic,
  );
  expect(retainedWeightedCost([heavy, { text: 'same' }])).toBe(
    weightedRetainedEventCost(heavy) + WEIGHTED_EVENT_COST.base + 1,
  );
});
