import { isTransientTranscriptNoise } from 'pentacle-chat-core';

export type SummaryFlowCounts = {
  summary_inbound_count: number;
  summary_strip_count: number;
  summary_strip_last_text_observed: string;
};

const counts = new Map<string, SummaryFlowCounts>();

function get(streamId: string): SummaryFlowCounts {
  let current = counts.get(streamId);
  if (!current) {
    current = {
      summary_inbound_count: 0,
      summary_strip_count: 0,
      summary_strip_last_text_observed: '',
    };
    counts.set(streamId, current);
  }
  return current;
}

export function wouldStripSummary(lastText: string | undefined | null): boolean {
  const text = String(lastText || '');
  return Boolean(text && isTransientTranscriptNoise(text));
}

export function recordSummaryInbound(streamId: string): void {
  get(streamId).summary_inbound_count += 1;
}

export function recordSummaryStrip(streamId: string, lastText: string | undefined | null): void {
  const current = get(streamId);
  current.summary_strip_count += 1;
  current.summary_strip_last_text_observed = String(lastText || '').slice(0, 200);
}

export function snapshotCounts(): Map<string, SummaryFlowCounts> {
  return new Map(Array.from(counts.entries(), ([streamId, value]) => [streamId, { ...value }]));
}

export function reset(): void {
  counts.clear();
}
