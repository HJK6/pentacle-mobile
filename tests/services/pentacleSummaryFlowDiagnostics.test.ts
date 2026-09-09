import {
  recordSummaryInbound,
  recordSummaryStrip,
  reset,
  snapshotCounts,
  wouldStripSummary,
} from '../../src/services/pentacleSummaryFlowDiagnostics';

beforeEach(() => {
  reset();
});

test('summary-flow counters are isolated by stream', () => {
  recordSummaryInbound('alpha:one');
  recordSummaryInbound('alpha:one');
  recordSummaryStrip('alpha:one', 'Booting MCP server: codex_apps (7s • esc to interrupt)');
  recordSummaryInbound('beta:two');

  expect(snapshotCounts().get('alpha:one')).toEqual({
    summary_inbound_count: 2,
    summary_strip_count: 1,
    summary_strip_last_text_observed: 'Booting MCP server: codex_apps (7s • esc to interrupt)',
  });
  expect(snapshotCounts().get('beta:two')).toEqual({
    summary_inbound_count: 1,
    summary_strip_count: 0,
    summary_strip_last_text_observed: '',
  });
});

test('summary strip classifier captures the latest stripped text sample', () => {
  const transient = 'Booting MCP server: codex_apps (7s • esc to interrupt)';
  const longTransient = `${transient} ${'x'.repeat(240)}`;

  expect(wouldStripSummary(transient)).toBe(true);
  expect(wouldStripSummary('Stable assistant answer')).toBe(false);

  recordSummaryInbound('alpha:one');
  if (wouldStripSummary(longTransient)) {
    recordSummaryStrip('alpha:one', longTransient);
  }

  const counts = snapshotCounts().get('alpha:one');
  expect(counts?.summary_strip_count).toBe(1);
  expect(counts?.summary_strip_last_text_observed).toHaveLength(200);
  expect(counts?.summary_strip_last_text_observed.startsWith(transient)).toBe(true);
});
