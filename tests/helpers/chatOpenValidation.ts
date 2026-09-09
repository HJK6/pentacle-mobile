export type ChatOpenValidationSnapshot = {
  bucketRowsVisited: number;
  derivedIndexRebuilds: number;
};

export type ChatOpenValidationCounters = {
  visitBucketRows: (count?: number) => void;
  rebuiltDerivedIndex: () => void;
  reset: () => void;
  snapshot: () => ChatOpenValidationSnapshot;
};

/** Test-only accounting seam used by bucket selectors and derived-index tests. */
export function createChatOpenValidationCounters(): ChatOpenValidationCounters {
  let bucketRowsVisited = 0;
  let derivedIndexRebuilds = 0;
  return {
    visitBucketRows(count = 1) {
      bucketRowsVisited += count;
    },
    rebuiltDerivedIndex() {
      derivedIndexRebuilds += 1;
    },
    reset() {
      bucketRowsVisited = 0;
      derivedIndexRebuilds = 0;
    },
    snapshot() {
      return { bucketRowsVisited, derivedIndexRebuilds };
    },
  };
}

export function countedBucketRows<T>(
  rows: Iterable<T>,
  counters: Pick<ChatOpenValidationCounters, 'visitBucketRows'>,
): Iterable<T> {
  return {
    *[Symbol.iterator]() {
      for (const row of rows) {
        counters.visitBucketRows();
        yield row;
      }
    },
  };
}

export type WeightedRetainedEvent = {
  text?: unknown;
  attachments?: unknown;
  client_origin?: unknown;
};

export const WEIGHTED_EVENT_COST = {
  base: 1,
  textCharsPerUnit: 256,
  attachment: 8,
  optimistic: 1,
} as const;

/**
 * Stable retention metric: units are schema properties, never process heap
 * bytes. This is intentionally usable from tests before bucket storage lands.
 */
export function weightedRetainedEventCost(event: WeightedRetainedEvent): number {
  const textLength = typeof event.text === 'string' ? event.text.length : 0;
  const textUnits = Math.ceil(textLength / WEIGHTED_EVENT_COST.textCharsPerUnit);
  const attachmentCount = Array.isArray(event.attachments) ? event.attachments.length : 0;
  const optimisticUnit = event.client_origin === true ? WEIGHTED_EVENT_COST.optimistic : 0;
  return WEIGHTED_EVENT_COST.base + textUnits + attachmentCount * WEIGHTED_EVENT_COST.attachment + optimisticUnit;
}

export function retainedWeightedCost(events: Iterable<WeightedRetainedEvent>): number {
  let total = 0;
  for (const event of events) total += weightedRetainedEventCost(event);
  return total;
}
