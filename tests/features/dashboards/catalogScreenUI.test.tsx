import React from 'react';
import { teeTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DashboardsScreen from '../../../app/(tabs)/dashboards';
import { DASHBOARD_ORDER, DASHBOARD_REGISTRY, mergeCatalogBoards } from '../../../src/features/dashboards/dashboardRegistry';
import { dashboardHubClient } from '../../../src/features/dashboards/dashboardHubClient';
import { type Catalog, type ReportDescriptor } from '../../../src/features/dashboards/catalogLoader';
import * as assets from '../../../src/services/pentacleAssets';
import fixtures from './fixtures/report_retrieval_cases.json';

let mockFocused = true;
let mockSpec: string | undefined = 'example__dashboard_catalog';
let mockReady = true;
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { get dashboardCatalogSpecId() { return mockSpec; } } } } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../../src/services/pentacleStream', () => ({ sendPentacleAssetCommand: jest.fn(), subscribePentacleAssetFrames: jest.fn() }));
jest.mock('../../../src/services/pentacleAssets', () => ({ ...jest.requireActual('../../../src/services/pentacleAssets'), listReportsBySpec: jest.fn(), getReportByOwner: jest.fn() }));
jest.mock('../../../src/components/Starfield', () => () => null);
jest.mock('../../../src/services/mobileTabsTelemetry', () => ({ logFocusedTab: jest.fn() }));
jest.mock('../../../src/utils/harnessRuntime', () => ({ useHarnessReady: () => mockReady, getParam: jest.fn() }));

const list = jest.mocked(assets.listReportsBySpec);
const get = jest.mocked(assets.getReportByOwner);
const catalogSpec = 'example__dashboard_catalog';
const latest = 'example-report-20261007T1300Z';
const reportDescriptor = fixtures.descriptor as ReportDescriptor;
const catalog = (): Catalog => ({ schema_version: 1, catalog_version: '0.2.0+aaaaaaa', package: { repo: 'example/catalog', commit: 'a'.repeat(40) }, requires: { host_api: 1 }, boards: [
  { id: 'example-report', name: 'Example Reports', kind: 'report', report: reportDescriptor },
  { id: 'example-board', name: 'Example Board', kind: 'web-adapter', web: { script: 'web/example-board.js', sha256: 'b'.repeat(64) } },
  { id: 'example-hosted', name: 'Example Hosted', kind: 'hosted-view', hosted: { url: 'https://viewer.example.test/app' } },
] });
let currentCatalog: unknown;
const refresh = () => screen.getByTestId('dashboards-scroll').props.refreshControl.props.onRefresh();
const catalogLists = () => list.mock.calls.filter(([spec]) => spec === catalogSpec);
const reportLists = () => list.mock.calls.filter(([spec]) => spec === reportDescriptor.spec_id);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  mockFocused = true; mockSpec = catalogSpec; mockReady = true;
  currentCatalog = catalog();
  list.mockReset().mockImplementation(async (spec) => spec === catalogSpec
    ? [{ asset_id: 'dashboard-catalog', title: 'Example Catalog', content_type: 'dashboard-catalog', stream_id: 'local:example-catalog' }]
    : [{ asset_id: latest, title: latest, content_type: 'report', stream_id: 'hostx:example-producer' }]);
  get.mockReset().mockImplementation(async (_owner, id) => id === 'dashboard-catalog'
    ? { asset_id: id, title: 'Example Catalog', content_type: 'dashboard-catalog', body: JSON.stringify(currentCatalog) }
    : { asset_id: id, title: id, content_type: 'report', body: { schema_version: 1, title: 'Example', sections: [{ id: 'example-section', title: 'Example section', blocks: [{ id: 'example-body', type: 'para', runs: [`Synthetic report ${id}.`] }] }] } });
});

test('unset config preserves the empty state without catalog, report, or hub calls', async () => {
  mockSpec = undefined;
  const connect = jest.spyOn(dashboardHubClient, 'connect');
  const hubRefresh = jest.spyOn(dashboardHubClient, 'refresh');
  try {
    render(<DashboardsScreen />);
    expect(screen.getByTestId('dashboards-empty-state')).toHaveTextContent('No dashboards yet');
    await act(async () => {});
    expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled(); expect(hubRefresh).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); hubRefresh.mockRestore(); }
});

test('catalog report/unsupported entries never connect or poll the retired hub', async () => {
  const connect = jest.spyOn(dashboardHubClient, 'connect');
  const hubRefresh = jest.spyOn(dashboardHubClient, 'refresh');
  try {
    render(<DashboardsScreen />);
    await screen.findByText(`Synthetic report ${latest}.`);
    expect(screen.getByTestId('dashboard-catalog-version')).toHaveTextContent('0.2.0+aaaaaaa');
    // Native contract: idb exposes an identifier only on an accessible element, not on a plain Text.
    expect(screen.getByTestId('dashboard-catalog-version').props).toMatchObject({ accessible: true, accessibilityLabel: '0.2.0+aaaaaaa' });
    expect(catalogLists()).toHaveLength(1); expect(reportLists()).toHaveLength(1);
    expect(get).toHaveBeenCalledWith('local:example-catalog', 'dashboard-catalog', catalogSpec);
    for (const id of ['example-board', 'example-hosted']) {
      fireEvent.press(screen.getByTestId(`dashboard-selector-${id}`));
      expect(screen.getByTestId(`dashboard-board-unsupported-${id}`)).toHaveTextContent('Unsupported on this client');
      expect(screen.getByTestId(`dashboard-board-unsupported-${id}`).props).toMatchObject({ accessible: true, accessibilityLabel: 'Unsupported on this client' });
    }
    jest.useFakeTimers(); act(() => jest.advanceTimersByTime(600_000));
    expect(catalogLists()).toHaveLength(1); expect(reportLists()).toHaveLength(1);
    expect(connect).not.toHaveBeenCalled(); expect(hubRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText('DISCONNECTED')).toBeNull();
  } finally { connect.mockRestore(); hubRefresh.mockRestore(); }
});

test('focus re-entry and pull each perform one catalog list and one active-report list', async () => {
  const rendered = render(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  mockFocused = false; rendered.rerender(<DashboardsScreen />);
  mockFocused = true; rendered.rerender(<DashboardsScreen />);
  await waitFor(() => expect(reportLists()).toHaveLength(2));
  await screen.findByText(`Synthetic report ${latest}.`);
  act(() => refresh());
  await waitFor(() => expect(reportLists()).toHaveLength(3));
  await screen.findByText(`Synthetic report ${latest}.`);
  expect(catalogLists()).toHaveLength(3);
});

test('catalog content version replacement reconciles a removed selection without restart', async () => {
  render(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  fireEvent.press(screen.getByTestId('dashboard-selector-example-hosted'));
  currentCatalog = { ...catalog(), catalog_version: '0.2.1+bbbbbbb', boards: [catalog().boards[0]] };
  act(() => refresh());
  await waitFor(() => expect(screen.getByTestId('dashboard-catalog-version')).toHaveTextContent('0.2.1+bbbbbbb'));
  await screen.findByText(`Synthetic report ${latest}.`);
  expect(screen.queryByTestId('dashboard-selector-example-hosted')).toBeNull();
  expect(screen.getByTestId('dashboard-selector-example-report').props.accessibilityState.selected).toBe(true);
  expect(reportLists()).toHaveLength(2);
});

test('transport failure keeps validated catalog with unavailable and age badges', async () => {
  render(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  list.mockRejectedValueOnce(new Error('asset_unavailable'));
  act(() => refresh());
  expect(await screen.findByTestId('dashboard-catalog-unavailable')).toHaveTextContent('Dashboard catalog unavailable: asset_unavailable');
  expect(screen.getByTestId('dashboard-catalog-cached')).toHaveTextContent(/^catalog cached \d+s$/);
  await screen.findByText(`Synthetic report ${latest}.`);
});

test('transport failure without cache shows a visible card and no boards', async () => {
  list.mockRejectedValue(new Error('asset_unavailable'));
  render(<DashboardsScreen />);
  expect(await screen.findByTestId('dashboard-catalog-unavailable')).toHaveTextContent('Dashboard catalog unavailable: asset_unavailable');
  expect(screen.queryByTestId('dashboard-selector')).toBeNull();
  expect(screen.queryByTestId('dashboard-catalog-cached')).toBeNull();
  expect(reportLists()).toHaveLength(0);
});

test.each(['malformed', 'unsupported'])('%s fetch hides cached boards but retains the good cache for a later outage', async (state) => {
  render(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  currentCatalog = state === 'malformed' ? { ...catalog(), unknown: true } : { ...catalog(), requires: { host_api: 2 } };
  act(() => refresh());
  expect(await screen.findByTestId('dashboard-catalog-error')).toHaveTextContent(/^Dashboard catalog unsupported\/malformed:/);
  expect(screen.queryByTestId('dashboard-selector')).toBeNull();
  expect(screen.queryByTestId('dashboard-catalog-cached')).toBeNull();
  list.mockRejectedValueOnce(new Error('asset_unavailable'));
  act(() => refresh());
  await screen.findByTestId('dashboard-catalog-cached');
  await screen.findByText(`Synthetic report ${latest}.`);
  expect(screen.getByTestId('dashboard-catalog-version')).toHaveTextContent('0.2.0+aaaaaaa');
});

test('stale catalog discovery after blur cannot render or start a report request', async () => {
  const pending = deferred<assets.PentacleReport[]>();
  list.mockReturnValueOnce(pending.promise);
  const rendered = render(<DashboardsScreen />);
  mockFocused = false; rendered.rerender(<DashboardsScreen />);
  await act(async () => pending.resolve([{ asset_id: 'dashboard-catalog', title: 'Example', content_type: 'dashboard-catalog', stream_id: 'local:example-catalog' }]));
  expect(screen.queryByTestId('dashboard-catalog-version')).toBeNull();
  expect(reportLists()).toHaveLength(0);
  mockFocused = true; rendered.rerender(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  expect(reportLists()).toHaveLength(1);
});

test('harness arming completes before reading configured catalog', async () => {
  const prior = process.env.EXPO_PUBLIC_HARNESS;
  process.env.EXPO_PUBLIC_HARNESS = '1'; mockReady = false;
  try {
    const rendered = render(<DashboardsScreen />);
    await act(async () => {});
    expect(list).not.toHaveBeenCalled();
    mockReady = true; rendered.rerender(<DashboardsScreen />);
    await screen.findByText(`Synthetic report ${latest}.`);
    expect(catalogLists()).toHaveLength(1);
  } finally {
    if (prior === undefined) delete process.env.EXPO_PUBLIC_HARNESS; else process.env.EXPO_PUBLIC_HARNESS = prior;
  }
});

test('merge leaves static registration untouched and preserves catalog array order', () => {
  const result = mergeCatalogBoards(catalog());
  expect(DASHBOARD_ORDER).toEqual([]); expect(DASHBOARD_REGISTRY).toEqual({});
  expect(result.order).toEqual(['example-report', 'example-board', 'example-hosted']);
  expect(result.registry['example-report'].hubKey).toBe('');
});

test('a built-in collision leaves that built-in intact and isolates the colliding catalog card', () => {
  const id = 'example-report';
  const definition = { id, hubKey: 'example.static', label: 'Example Static', resolve: () => null, render: () => null };
  DASHBOARD_ORDER.push(id); DASHBOARD_REGISTRY[id] = definition;
  try {
    const result = mergeCatalogBoards(catalog());
    expect(result.order).toEqual([id, `catalog:${id}`, 'example-board', 'example-hosted']);
    expect(result.registry[id]).toBe(definition);
    const Failure = result.registry[`catalog:${id}`].render;
    render(<Failure snapshot={null} onSelectBatch={jest.fn()} onMutateGate={jest.fn()} />);
    expect(screen.getByTestId('dashboard-board-error')).toHaveTextContent('Board failed to load: board id example-report conflicts with a built-in');
    expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  } finally { DASHBOARD_ORDER.pop(); delete DASHBOARD_REGISTRY[id]; }
});

test('a later pull wins over a pending catalog refresh and preserves its spinner', async () => {
  render(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  const first = deferred<assets.PentacleReport[]>();
  const second = deferred<assets.PentacleReport[]>();
  list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  act(() => refresh()); act(() => refresh());
  await act(async () => first.resolve([]));
  expect(screen.getByTestId('dashboards-scroll').props.refreshControl.props.refreshing).toBe(true);
  await act(async () => second.resolve([{ asset_id: 'dashboard-catalog', title: 'Example', content_type: 'dashboard-catalog', stream_id: 'local:example-catalog' }]));
  await screen.findByText(`Synthetic report ${latest}.`);
  expect(screen.getByTestId('dashboards-scroll').props.refreshControl.props.refreshing).toBe(false);
  expect(screen.queryByTestId('dashboard-catalog-unavailable')).toBeNull();
  expect(reportLists()).toHaveLength(2);
});

test('negative control: pull interrupted by blur clears refresh spinner after successful re-entry', async () => {
  const rendered = render(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  const pending = deferred<assets.PentacleReport[]>();
  list.mockReturnValueOnce(pending.promise);
  act(() => refresh());
  expect(screen.getByTestId('dashboards-scroll').props.refreshControl.props.refreshing).toBe(true);
  mockFocused = false; rendered.rerender(<DashboardsScreen />);
  await act(async () => pending.resolve([]));
  mockFocused = true; rendered.rerender(<DashboardsScreen />);
  await screen.findByText(`Synthetic report ${latest}.`);
  await waitFor(() => expect(reportLists()).toHaveLength(2));
  expect(screen.getByTestId('dashboards-scroll').props.refreshControl.props.refreshing).toBe(false);
});


test('catalog get denial records exact receipt and stops before report retrieval', async () => {
  const prior = process.env.EXPO_PUBLIC_HARNESS; process.env.EXPO_PUBLIC_HARNESS = '1';
  const events: TelemetryPayload[] = []; const detach = teeTelemetrySink(event => events.push(event));
  const denied = new Error('asset_unauthorized'); get.mockRejectedValueOnce(denied);
  try {
    render(<DashboardsScreen />);
    await screen.findByText('Dashboard catalog unavailable: asset_unauthorized');
    const records = events.filter(event => String(event.message) === 'harness:ui_trace' && event.data.kind === 'dashboard_catalog_asset_get');
    expect(records).toHaveLength(1);
    expect(records[0].data).toEqual({ kind: 'dashboard_catalog_asset_get', scenario_run_id: null,
      asset_id: 'dashboard-catalog', spec_id: catalogSpec, listed_stream_id: 'local:example-catalog',
      request_stream_id: 'local:example-catalog', status: 'error', error_code: 'asset_unauthorized' });
    expect(get).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledWith('local:example-catalog', 'dashboard-catalog', catalogSpec);
    expect(reportLists()).toHaveLength(0);
  } finally { detach(); if (prior === undefined) delete process.env.EXPO_PUBLIC_HARNESS; else process.env.EXPO_PUBLIC_HARNESS = prior; }
});
