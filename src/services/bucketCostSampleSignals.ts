// Harness-only telemetry: `harness:ui_trace` kind `bucket_cost_sample`.
//
// Emits the retained weighted event cost (from the G5 deterministic accessor
// `retainedPentacleEventCost` in pentacle-chat-core) plus process RSS, so the
// SLO lane can certify the `totalEventCostMax` ceiling against a measured peak.
// Locked contract (spec chat_open_slo_meaningful_measurement, Nexus ruling 3):
//   data.kind      = "bucket_cost_sample"
//   weightedCost   = integer total retained weighted cost across ALL buckets
//   rssBytes       = process RSS in bytes, or null where unsupported
//                    (never 0, never omitted)
//   monotonicMs    = the SAME monotonic clock as chat_open_paint
//   sampleReason   = "open_settle" | "interval"
//   open_settle    = emitted once per open after the settle predicate; carries
//                    that open's correlationId + streamId
//   interval       = ~1Hz from corpus-load start through completion; no
//                    correlationId
//
// Production keeps the sampler UNCONFIGURED (default), so every entry point is
// a no-op and zero harness telemetry is emitted. The harness observer installs
// real providers via `configureBucketCostSampling` in app/_layout.tsx.

export type BucketCostSampleReason = 'open_settle' | 'interval';

export type BucketCostSample = {
  weightedCost: number;
  rssBytes: number | null;
  monotonicMs: number;
  sampleReason: BucketCostSampleReason;
  correlationId?: string;
  streamId?: string;
};

export type BucketCostSampleSink = (sample: BucketCostSample) => void;

export type BucketCostSampleClock = {
  monotonicNow: () => number;
};

export type BucketCostSampleTimers = Pick<typeof globalThis, 'setInterval' | 'clearInterval'>;

export type BucketCostSampleProviders = {
  sink: BucketCostSampleSink;
  getWeightedCost: () => number;
  getRssBytes: () => number | null;
  clock?: BucketCostSampleClock;
  timers?: BucketCostSampleTimers;
  intervalMs?: number;
};

const defaultClock: BucketCostSampleClock = {
  monotonicNow: () => globalThis.performance?.now?.() ?? Date.now(),
};

const DEFAULT_INTERVAL_MS = 1000;

type ResolvedProviders = Required<Omit<BucketCostSampleProviders, 'timers'>> & {
  timers: BucketCostSampleTimers;
};

let providers: ResolvedProviders | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// A legitimate process RSS is always a positive finite value; anything else
// (0, NaN, negative, unsupported reader) is reported as null per the contract.
function normalizeRss(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function buildSample(
  reason: BucketCostSampleReason,
  extra: Pick<BucketCostSample, 'correlationId' | 'streamId'>,
): BucketCostSample | null {
  if (!providers) return null;
  const weightedCost = providers.getWeightedCost();
  return {
    weightedCost: Number.isFinite(weightedCost) ? Math.max(0, Math.round(weightedCost)) : 0,
    rssBytes: normalizeRss(providers.getRssBytes()),
    monotonicMs: providers.clock.monotonicNow(),
    sampleReason: reason,
    ...extra,
  };
}

/** Installs the harness providers. Absent this call the sampler is inert. */
export function configureBucketCostSampling(next: BucketCostSampleProviders): void {
  stopBucketCostIntervalSampling();
  providers = {
    sink: next.sink,
    getWeightedCost: next.getWeightedCost,
    getRssBytes: next.getRssBytes,
    clock: next.clock ?? defaultClock,
    intervalMs: next.intervalMs ?? DEFAULT_INTERVAL_MS,
    timers: next.timers ?? globalThis,
  };
}

/** Test/teardown helper: stop interval sampling and clear providers. */
export function resetBucketCostSampling(): void {
  stopBucketCostIntervalSampling();
  providers = null;
}

/**
 * Emit one `open_settle` sample for the given open. Requires a correlationId —
 * a settle with no tracked correlationId (e.g. a non-instrumented open) is not
 * sampled.
 */
export function emitBucketCostOpenSettle(
  correlationId: string | null | undefined,
  streamId: string,
): void {
  if (!providers || !correlationId) return;
  const sample = buildSample('open_settle', { correlationId, streamId });
  if (sample) providers.sink(sample);
}

/**
 * Start ~1Hz `interval` sampling for the corpus-load window. Emits one sample
 * immediately (load start) and then every `intervalMs`. Idempotent.
 */
export function startBucketCostIntervalSampling(): void {
  if (!providers || intervalHandle) return;
  const first = buildSample('interval', {});
  if (first) providers.sink(first);
  intervalHandle = providers.timers.setInterval(() => {
    if (!providers) return;
    const sample = buildSample('interval', {});
    if (sample) providers.sink(sample);
  }, providers.intervalMs);
}

/** Stop interval sampling (corpus-load complete). Idempotent. */
export function stopBucketCostIntervalSampling(): void {
  if (intervalHandle === null) return;
  const clear = providers?.timers.clearInterval ?? globalThis.clearInterval;
  clear(intervalHandle);
  intervalHandle = null;
}
