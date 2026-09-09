import {
  configureBucketCostSampling,
  resetBucketCostSampling,
  emitBucketCostOpenSettle,
  startBucketCostIntervalSampling,
  stopBucketCostIntervalSampling,
  type BucketCostSample,
} from '../../src/services/bucketCostSampleSignals';
import { createBucketCostSampleTelemetrySink } from '../../src/services/bucketCostSampleForwarding';

type FakeTimers = {
  setInterval: jest.Mock;
  clearInterval: jest.Mock;
  trigger: () => void;
};

function fakeTimers(): FakeTimers {
  let cb: (() => void) | null = null;
  return {
    setInterval: jest.fn((fn: () => void) => {
      cb = fn;
      return 7 as unknown as ReturnType<typeof setInterval>;
    }),
    clearInterval: jest.fn(),
    trigger: () => cb?.(),
  };
}

afterEach(() => {
  resetBucketCostSampling();
});

test('open_settle sample carries the locked envelope keyed to the open', () => {
  const seen: BucketCostSample[] = [];
  configureBucketCostSampling({
    sink: (sample) => seen.push(sample),
    getWeightedCost: () => 18240,
    getRssBytes: () => 123456,
    clock: { monotonicNow: () => 4242 },
  });

  emitBucketCostOpenSettle('chat-open:3', 'hostc:reliability-00');

  // toEqual asserts the EXACT key set — no stray keys beyond the locked envelope.
  expect(seen).toEqual([
    {
      weightedCost: 18240,
      rssBytes: 123456,
      monotonicMs: 4242,
      sampleReason: 'open_settle',
      correlationId: 'chat-open:3',
      streamId: 'hostc:reliability-00',
    },
  ]);
});

test('open_settle without a correlationId is not sampled', () => {
  const seen: BucketCostSample[] = [];
  configureBucketCostSampling({
    sink: (sample) => seen.push(sample),
    getWeightedCost: () => 100,
    getRssBytes: () => null,
    clock: { monotonicNow: () => 1 },
  });

  emitBucketCostOpenSettle(null, 'hostc:reliability-00');
  emitBucketCostOpenSettle(undefined, 'hostc:reliability-00');
  emitBucketCostOpenSettle('', 'hostc:reliability-00');

  expect(seen).toEqual([]);
});

test('interval sampling emits at start and on each tick with no correlationId, then stops', () => {
  const seen: BucketCostSample[] = [];
  const timers = fakeTimers();
  let cost = 500;
  configureBucketCostSampling({
    sink: (sample) => seen.push(sample),
    getWeightedCost: () => cost,
    getRssBytes: () => null,
    clock: { monotonicNow: () => cost },
    timers,
    intervalMs: 1000,
  });

  startBucketCostIntervalSampling();
  expect(seen).toHaveLength(1); // immediate load-start sample
  expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 1000);

  cost = 900;
  timers.trigger();
  cost = 1300;
  timers.trigger();

  expect(seen).toHaveLength(3);
  for (const sample of seen) {
    expect(sample.sampleReason).toBe('interval');
    expect(sample).not.toHaveProperty('correlationId');
    expect(sample).not.toHaveProperty('streamId');
  }
  expect(seen.map((s) => s.weightedCost)).toEqual([500, 900, 1300]);

  stopBucketCostIntervalSampling();
  expect(timers.clearInterval).toHaveBeenCalledWith(7);
});

test('start is idempotent (a second start does not open a second interval)', () => {
  const timers = fakeTimers();
  configureBucketCostSampling({
    sink: () => undefined,
    getWeightedCost: () => 0,
    getRssBytes: () => null,
    timers,
  });
  startBucketCostIntervalSampling();
  startBucketCostIntervalSampling();
  expect(timers.setInterval).toHaveBeenCalledTimes(1);
});

test('rssBytes: unavailable/zero/negative/NaN readings collapse to null; positive is rounded', () => {
  const capture = (rss: number | null) => {
    const seen: BucketCostSample[] = [];
    configureBucketCostSampling({
      sink: (sample) => seen.push(sample),
      getWeightedCost: () => 10,
      getRssBytes: () => rss,
      clock: { monotonicNow: () => 0 },
    });
    emitBucketCostOpenSettle('c', 's');
    resetBucketCostSampling();
    return seen[0].rssBytes;
  };

  expect(capture(null)).toBeNull();
  expect(capture(0)).toBeNull();
  expect(capture(-5)).toBeNull();
  expect(capture(Number.NaN)).toBeNull();
  expect(capture(2048.7)).toBe(2049);
});

test('weightedCost is coerced to a non-negative integer', () => {
  const seen: BucketCostSample[] = [];
  configureBucketCostSampling({
    sink: (sample) => seen.push(sample),
    getWeightedCost: () => 733.4,
    getRssBytes: () => null,
    clock: { monotonicNow: () => 0 },
  });
  emitBucketCostOpenSettle('c', 's');
  expect(seen[0].weightedCost).toBe(733);
  expect(Number.isInteger(seen[0].weightedCost)).toBe(true);
});

test('production regression: an unconfigured sampler is inert (no emit, no interval, no throw)', () => {
  // Production never calls configureBucketCostSampling, so every entry point
  // must be a safe no-op that emits zero harness telemetry.
  resetBucketCostSampling();
  const realSetInterval = jest.spyOn(globalThis, 'setInterval');
  expect(() => {
    emitBucketCostOpenSettle('chat-open:1', 'hostc:reliability-00');
    startBucketCostIntervalSampling();
    stopBucketCostIntervalSampling();
  }).not.toThrow();
  expect(realSetInterval).not.toHaveBeenCalled();
  realSetInterval.mockRestore();
});

describe('bucket_cost_sample forwarding adapter', () => {
  function forward(sample: BucketCostSample) {
    const logTelemetry = jest.fn();
    const sink = createBucketCostSampleTelemetrySink((name, data) => logTelemetry(name, data));

    sink(sample);

    expect(logTelemetry).toHaveBeenCalledTimes(1);
    expect(logTelemetry).toHaveBeenCalledWith('harness:ui_trace', expect.any(Object));
    return logTelemetry.mock.calls[0][1];
  }

  test('forwards the open_settle wire envelope with snake_case stream_id', () => {
    expect(forward({
      weightedCost: 18240,
      rssBytes: 123456,
      monotonicMs: 4242,
      sampleReason: 'open_settle',
      correlationId: 'chat-open:3',
      streamId: 'hostc:reliability-00',
    })).toEqual({
      kind: 'bucket_cost_sample',
      weightedCost: 18240,
      rssBytes: 123456,
      monotonicMs: 4242,
      sampleReason: 'open_settle',
      correlationId: 'chat-open:3',
      stream_id: 'hostc:reliability-00',
    });
  });

  test('forwards interval samples with null rssBytes and no open-only fields', () => {
    expect(forward({
      weightedCost: 900,
      rssBytes: null,
      monotonicMs: 900,
      sampleReason: 'interval',
      correlationId: 'should-not-forward',
      streamId: 'should-not-forward',
    })).toEqual({
      kind: 'bucket_cost_sample',
      weightedCost: 900,
      rssBytes: null,
      monotonicMs: 900,
      sampleReason: 'interval',
    });
  });
});

