import { resolveBusinessDashboard, resolveForeclosureDashboard } from '../../../src/features/dashboards/dashboardData';
import type { DashboardEnvelope } from '../../../src/features/dashboards/types';
import businessEnvelope from '../../../test/e2e/fixtures/dashboard_hub/business.json';
import foreclosureEnvelope from '../../../test/e2e/fixtures/dashboard_hub/foreclosure.json';

const NOW = Date.parse('2026-07-17T08:00:10Z');

test('selects foreclosure snapshots by batch and preserves envelope staleness', () => {
  const envelope = foreclosureEnvelope as DashboardEnvelope;
  expect(resolveForeclosureDashboard(envelope, '', true, NOW)).toMatchObject({
    batch: '2026-07-17',
    all_batches: ['2026-07-17', '2026-07-16'],
    _data_stale: false,
  });
  expect(resolveForeclosureDashboard(envelope, '2026-07-16', false, NOW)).toMatchObject({
    batch: '2026-07-16',
    _transport_stale: true,
    pipeline_summary: { state_machine_batch: '2026-07-16' },
  });
  expect(resolveForeclosureDashboard(envelope, 'missing', true, NOW)).toMatchObject({
    batch: '2026-07-17',
    _missing_batch: 'missing',
  });
});

test('aggregates business snapshots using the desktop all-leads semantics', () => {
  const envelope = structuredClone(businessEnvelope) as DashboardEnvelope;
  const data = envelope.data as { snapshots: Record<string, Record<string, unknown>>; all_batches: string[] };
  data.snapshots.antwerp = {
    scraped: 10,
    deduped: 8,
    qualified: 3,
    promoted: 1,
    by_area: { Antwerp: { scraped: 10, qualified: 3, promoted: 1 } },
    by_source: { google: { scraped: 10, qualified: 3, promoted: 1 } },
    pipeline_stages: [{ stage: 'scrape', state: 'running', metrics: { pages: 2 } }],
    scraper_queue: { running: 1 },
  };
  data.all_batches.push('antwerp');
  const resolved = resolveBusinessDashboard(envelope, true, NOW);
  expect(resolved).toMatchObject({
    batch: 'All leads',
    all_leads: true,
    scraped: 420,
    deduped: 390,
    qualified: 147,
    promoted: 39,
    by_area: { Brussels: { scraped: 240, qualified: 90, promoted: 25 } },
    scraper_queue: { running: 2 },
    _data_stale: false,
  });
  expect(resolved?.pipeline_stages).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'scrape', state: 'running', metrics: { pages: 2 } }),
  ]));
});
