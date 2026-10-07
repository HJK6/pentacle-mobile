import { MAX_BOUND_ITEMS, MIN_SEGMENT_MS, SegmentTracker } from '../../src/components/questions/voice/segments';

describe('SegmentTracker (spec § V1 segments)', () => {
  test('a page is covered once one visit reaches 1.5 s, not before', () => {
    const tracker = new SegmentTracker(['a:0', 'b:0']);
    tracker.enter('a:0', 0);
    expect(MIN_SEGMENT_MS).toBe(1500);
    expect(tracker.covered(1499).size).toBe(0);
    expect([...tracker.covered(1500).keys()]).toEqual(['a:0']);
  });

  test('visits shorter than 1.5 s never add up to coverage; the longest qualifying visit is the segment', () => {
    const tracker = new SegmentTracker(['a:0', 'b:0']);
    tracker.enter('a:0', 0);
    tracker.enter('b:0', 1000);
    tracker.enter('a:0', 2000);
    tracker.enter('b:0', 3400);
    tracker.enter('a:0', 4000);
    tracker.finish(4900);
    // a: 1.0 s + 1.4 s + 0.9 s (never 1.5 s in one visit); b: 1.0 s + 0.6 s
    expect(tracker.covered(4900).size).toBe(0);
    const longer = new SegmentTracker(['a:0']);
    longer.enter('a:0', 0);
    longer.enter(null, 1600);
    longer.enter('a:0', 3000);
    longer.enter(null, 6000);
    expect(longer.covered(6000).get('a:0')).toEqual({ start_s: 3, end_s: 6 });
  });

  test('the open visit counts up to now and the segment end is the live clock', () => {
    const tracker = new SegmentTracker(['a:0']);
    tracker.enter('a:0', 250);
    expect(tracker.covered(2000).get('a:0')).toEqual({ start_s: 0.3, end_s: 2 });
  });

  test('pages outside the start set (arrivals, legacy) are never tracked or covered', () => {
    const tracker = new SegmentTracker(['a:0']);
    tracker.enter('late:0', 0);
    tracker.enter('legacy:0', 100);
    tracker.enter('a:0', 200);
    tracker.finish(9000);
    expect([...tracker.covered(9000).keys()]).toEqual(['a:0']);
  });

  test('covered pages are ordered by segment start and capped at the daemon item limit', () => {
    expect(MAX_BOUND_ITEMS).toBe(20);
    const keys = Array.from({ length: 25 }, (_, i) => `k${i}:0`);
    const tracker = new SegmentTracker(keys);
    keys.forEach((key, i) => tracker.enter(key, i * 2000));
    tracker.finish(25 * 2000);
    const covered = [...tracker.covered(25 * 2000).keys()];
    expect(covered).toHaveLength(20);
    expect(covered[0]).toBe('k0:0');
    expect(covered[19]).toBe('k19:0');
  });

  test('entering the same page again while it is current does not restart its visit', () => {
    const tracker = new SegmentTracker(['a:0']);
    tracker.enter('a:0', 0);
    tracker.enter('a:0', 1000);
    expect(tracker.covered(1600).has('a:0')).toBe(true);
  });
});
