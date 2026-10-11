import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { validateCatalog, validateHostedDashboardUrl, createCatalogLoader, type Catalog } from '../../../src/features/dashboards/catalogLoader';
import { DASHBOARD_REGISTRY, DASHBOARD_ORDER, mergeCatalogBoards } from '../../../src/features/dashboards/dashboardRegistry';

const policy = { tailnetSuffix: 'example.ts.net', pentacleOrigin: 'https://chat.example.ts.net' };
const hosted = { id: 'project-map', name: 'Project map demo', kind: 'hosted-view' as const, hosted: { url: 'https://boards.example.ts.net:8444/project-map/' } };
const catalog = (): Catalog => ({ schema_version: 1, catalog_version: '1.0.0', package: { repo: 'example/catalog', commit: 'a'.repeat(40) }, requires: { host_api: 2 }, boards: [hosted] });

test('API 2 accepts mixed kinds and visibility; API 1 remains readable', () => {
  const c = catalog();
  c.boards.push({ id: 'native-board', name: 'Native', kind: 'built-in', visible: false });
  expect(validateCatalog(c)).toBe(c);
  expect(validateCatalog({ ...c, requires: { host_api: 1 }, boards: [hosted] }).boards).toEqual([hosted]);
  expect(() => validateCatalog({ ...c, boards: [{ ...hosted, visible: 'false' }] })).toThrow('boolean');
  expect(() => validateCatalog({ ...c, boards: [hosted, hosted] })).toThrow('duplicate');
});

test('catalog alone controls ordered visible membership and built-in lookup', () => {
  const native = { id: 'native-board', label: 'Old title', hubKey: 'example.native', render: () => <Text>Native body</Text>, resolve: () => null };
  DASHBOARD_REGISTRY[native.id] = native; DASHBOARD_ORDER.push(native.id, 'unlisted');
  try {
    const c = catalog(); c.boards = [hosted, { id: 'missing-board', name: 'Missing', kind: 'built-in' }, { id: native.id, name: 'Catalog title', kind: 'built-in' }, { ...hosted, id: 'hidden-board', visible: false }];
    const merged = mergeCatalogBoards(c);
    expect(merged.order).toEqual(['project-map', 'missing-board', 'native-board']);
    expect(Object.keys(merged.registry)).toEqual(merged.order);
    expect(merged.registry[native.id].render).toBe(native.render);
    expect(merged.registry[native.id].label).toBe('Catalog title');
    expect(DASHBOARD_REGISTRY[native.id]).toBe(native);
    const Missing = merged.registry['missing-board'].render;
    render(<Missing snapshot={null} onSelectBatch={jest.fn()} onMutateGate={jest.fn()} />);
    expect(screen.getByTestId('dashboard-board-error')).toHaveTextContent(/unavailable/);
  } finally { delete DASHBOARD_REGISTRY[native.id]; DASHBOARD_ORDER.splice(0); }
});

test.each([
  'http://boards.example.ts.net/app', 'https://foreign.test/app', 'https://lookalikeexample.ts.net/app',
  'https://boards.example.ts.net.foreign.test/app', 'https://example.ts.net/app',
  'https://user@boards.example.ts.net/app', 'https://user:pass@boards.example.ts.net/app',
  'https://boards.example.ts.net/app?', 'https://boards.example.ts.net/app#',
  'https://boards.example.ts.net/app?token=synthetic', 'https://boards.example.ts.net/app#synthetic',
  'https://chat.example.ts.net:8444/app', 'https://chat.example.ts.net/app',
  'https://boards.example.ts.net/a b', 'https://boards.example.ts.net/\\app',
  'https://boards.example.ts.net:99999/app', 'javascript:alert(1)',
])('refuses hosted URL %s', (url) => expect(() => validateHostedDashboardUrl(url, policy)).toThrow());

test.each([null, undefined, {}, { ...policy, tailnetSuffix: '' }, { ...policy, tailnetSuffix: 'net' }, { ...policy, pentacleOrigin: 'http://chat.example.ts.net' }, { ...policy, pentacleOrigin: 'https://chat.example.ts.net/path' }])('missing/invalid policy fails closed: %j', (value) => {
  expect(() => validateHostedDashboardUrl(hosted.hosted.url, value)).toThrow('configuration');
});

test('temporary policy admits serving URLs, then removal refuses cached URLs', async () => {
  const rows = [{ asset_id: 'dashboard-catalog', content_type: 'dashboard-catalog', stream_id: 'hosta:catalog', title: 'Catalog' }];
  const list = jest.fn().mockResolvedValue(rows);
  const records = new Map<string, string>();
  const storage = { getItem: jest.fn(async (k: string) => records.get(k) || null), setItem: jest.fn(async (k: string, v: string) => { records.set(k, v); }) };
  const loader = createCatalogLoader({ storage, listReportsBySpec: list, getReportByOwner: jest.fn().mockResolvedValue({ ...rows[0], body: catalog() }) });
  expect((await loader.refresh('example__catalog')).status).toBe('ready'); await loader.flush();
  list.mockRejectedValue(new Error('offline'));
  const restored = createCatalogLoader({ storage, listReportsBySpec: list });
  const cached = await restored.refresh('example__catalog'); expect(cached.cached).toBe(true);
  const board = cached.catalog!.boards[0]; if (board.kind !== 'hosted-view') throw new Error('wrong fixture');
  expect(validateHostedDashboardUrl(board.hosted.url, policy)).toBe(board.hosted.url);
  expect(() => validateHostedDashboardUrl(board.hosted.url, null)).toThrow('configuration');
  expect(() => validateHostedDashboardUrl(board.hosted.url, { ...policy, tailnetSuffix: 'other.ts.net' })).toThrow();
});

test('unknown built-in ids that match object properties still get an unavailable card', () => {
  const c = catalog(); c.boards = [{ id: 'constructor', name: 'Unknown native board', kind: 'built-in' }];
  const { registry, order } = mergeCatalogBoards(c);
  expect(order).toEqual(['constructor']);
  const Board = registry[order[0]].render;
  render(<Board snapshot={null} onSelectBatch={jest.fn()} onMutateGate={jest.fn()} />);
  expect(screen.getByTestId('dashboard-board-error')).toHaveTextContent(/unavailable/);
});
