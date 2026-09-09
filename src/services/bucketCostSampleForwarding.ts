import type { logTelemetry } from 'pentacle-chat-core';
import type {
  BucketCostSample,
  BucketCostSampleReason,
  BucketCostSampleSink,
} from './bucketCostSampleSignals';

export type BucketCostSampleTelemetryData = {
  kind: 'bucket_cost_sample';
  weightedCost: number;
  rssBytes: number | null;
  monotonicMs: number;
  sampleReason: BucketCostSampleReason;
  correlationId?: string;
  stream_id?: string;
};

export type BucketCostSampleTelemetryLogger = (
  name: Parameters<typeof logTelemetry>[0],
  data: BucketCostSampleTelemetryData,
) => void;

export function buildBucketCostSampleTelemetryData(
  sample: BucketCostSample,
): BucketCostSampleTelemetryData {
  const isOpenSettle = sample.sampleReason === 'open_settle';
  return {
    kind: 'bucket_cost_sample',
    weightedCost: sample.weightedCost,
    rssBytes: sample.rssBytes,
    monotonicMs: sample.monotonicMs,
    sampleReason: sample.sampleReason,
    ...(isOpenSettle && sample.correlationId ? { correlationId: sample.correlationId } : {}),
    ...(isOpenSettle && sample.streamId ? { stream_id: sample.streamId } : {}),
  };
}

export function createBucketCostSampleTelemetrySink(
  logger: BucketCostSampleTelemetryLogger,
): BucketCostSampleSink {
  return (sample) => {
    logger(
      'harness:ui_trace' as Parameters<typeof logTelemetry>[0],
      buildBucketCostSampleTelemetryData(sample),
    );
  };
}
