// Segment bookkeeping for one overlay recording (spec § V1): a segment is the interval the
// operator spends on a page while recording; a page whose single visit reaches MIN_SEGMENT_MS is
// covered. Pure, with explicit millisecond timestamps (zero = recording start).
export const MIN_SEGMENT_MS = 1500;
// The daemon rejects bindings with more than 20 items (voice_answers.v1).
export const MAX_BOUND_ITEMS = 20;

export type Segment = { start_s: number; end_s: number };

type Visit = { key: string; startMs: number; endMs: number | null };

const seconds = (ms: number) => Math.round(ms / 100) / 10;

export class SegmentTracker {
  private readonly tracked: ReadonlySet<string>;
  private readonly visits: Visit[] = [];
  private open: Visit | null = null;

  // `trackedKeys` is the page set at recording start: later arrivals and legacy pages are
  // never in it, so their dwell time is not recorded as a segment.
  constructor(trackedKeys: Iterable<string>) {
    this.tracked = new Set(trackedKeys);
  }

  // The operator is now on `key` (null: on no page). Re-entering the current page keeps its visit.
  enter(key: string | null, atMs: number) {
    if (this.open && this.open.key === key) return;
    this.closeOpen(atMs);
    if (key !== null && this.tracked.has(key)) {
      this.open = { key, startMs: atMs, endMs: null };
      this.visits.push(this.open);
    }
  }

  finish(atMs: number) {
    this.closeOpen(atMs);
  }

  // Covered pages, ordered by segment start, capped at MAX_BOUND_ITEMS. The open visit counts up
  // to `nowMs`. A page visited several times uses its longest qualifying visit.
  covered(nowMs: number): Map<string, Segment> {
    const best = new Map<string, { startMs: number; endMs: number }>();
    for (const visit of this.visits) {
      const endMs = visit.endMs ?? nowMs;
      if (endMs - visit.startMs < MIN_SEGMENT_MS) continue;
      const prior = best.get(visit.key);
      if (!prior || endMs - visit.startMs > prior.endMs - prior.startMs) {
        best.set(visit.key, { startMs: visit.startMs, endMs });
      }
    }
    const ordered = [...best.entries()].sort((a, b) => a[1].startMs - b[1].startMs).slice(0, MAX_BOUND_ITEMS);
    return new Map(ordered.map(([key, span]) => [key, { start_s: seconds(span.startMs), end_s: seconds(span.endMs) }]));
  }

  // Milliseconds until the open visit reaches MIN_SEGMENT_MS, or null when nothing is pending.
  msUntilCovered(nowMs: number): number | null {
    if (!this.open) return null;
    const remaining = MIN_SEGMENT_MS - (nowMs - this.open.startMs);
    return remaining > 0 ? remaining : null;
  }

  private closeOpen(atMs: number) {
    if (this.open) {
      this.open.endMs = atMs;
      this.open = null;
    }
  }
}
