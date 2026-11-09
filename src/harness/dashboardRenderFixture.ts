import type { Catalog } from '../features/dashboards/catalogLoader';

export type DashboardRenderFixture = 'mockups' | 'empty';
const catalog: Catalog = {
  schema_version: 1, catalog_version: '0.2.2+gallery-example',
  package: { repo: 'example/dashboard-catalog', commit: 'a'.repeat(40) },
  requires: { host_api: 2 },
  boards: [{ id: 'ui-review', name: 'Mockups', kind: 'built-in', visible: true }],
};

// Screenshot-only service boundaries. The real catalog validation, screen,
// selection, retry and Linking handoff run unchanged; no network is contacted.
export function seedDashboardRenderFixture(variant?: DashboardRenderFixture) {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS !== '1'
      || process.env.EXPO_PUBLIC_DASHBOARD_RENDER_FIXTURE !== '1') return;
  const loader = require('../features/dashboards/catalogLoader');
  const stream = require('../services/pentacleStream');
  const assets = require('../services/pentacleAssets');
  Object.assign(loader, { getCatalogSpecId: () => variant === 'mockups' ? 'example__dashboard_catalog' : undefined });
  Object.assign(stream, { getHostedDashboardPolicy: () => ({ tailnetSuffix: 'example.ts.net', pentacleOrigin: 'https://chat.example.ts.net' }) });
  const meta = { asset_id: 'dashboard-catalog', content_type: 'dashboard-catalog', title: 'Example catalog', stream_id: 'hosta:example-catalog' };
  Object.assign(assets, {
    listReportsBySpec: async () => [meta],
    getReportByOwner: async () => ({ ...meta, body: JSON.stringify(catalog) }),
  });
}
