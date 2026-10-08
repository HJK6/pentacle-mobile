import React from 'react';
import { teeTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ReportBoard from '../../../src/features/dashboards/ReportBoard';
import UnsupportedBoard from '../../../src/features/dashboards/UnsupportedBoard';
import { type CatalogBoard, type ReportDescriptor } from '../../../src/features/dashboards/catalogLoader';
import * as assets from '../../../src/services/pentacleAssets';
import fixtures from './fixtures/report_retrieval_cases.json';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../../src/services/pentacleStream', () => ({ sendPentacleAssetCommand: jest.fn(), subscribePentacleAssetFrames: jest.fn() }));
jest.mock('../../../src/services/pentacleAssets', () => ({
  ...jest.requireActual('../../../src/services/pentacleAssets'),
  listReportsBySpec: jest.fn(), getReportByOwner: jest.fn(), listReports: jest.fn(),
  listReportComments: jest.fn(), markReportRead: jest.fn(),
}));
jest.mock('../../../src/components/Starfield', () => () => null);

const list = jest.mocked(assets.listReportsBySpec);
const get = jest.mocked(assets.getReportByOwner);
const descriptor = fixtures.descriptor as ReportDescriptor;
const board = (report: ReportDescriptor = descriptor): CatalogBoard => ({ id: 'example-report', name: 'Example Reports', kind: 'report', report });
const row = (id = 'example-report-20261007T1300Z'): assets.PentacleReport => ({ asset_id: id, title: id, content_type: 'report', stream_id: 'hostx:example-producer' });
const report = (assetId: string, text = `Synthetic report ${assetId}.`): assets.PentacleReport => ({
  ...row(assetId), body: { schema_version: 1, title: 'Synthetic report', sections: [{ id: 'example-section', title: 'Example section', blocks: [{ id: 'example-block', type: 'para', runs: [text] }] }] },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  list.mockReset().mockResolvedValue([row()]);
  get.mockReset().mockImplementation(async (_owner, id) => report(id));
});

for (const fixture of fixtures.cases) {
  test(`real report UI: ${fixture.name}`, async () => {
    const reportDescriptor = descriptor;
    list.mockResolvedValue(fixture.server_ids.map((id) => row(id)));
    render(<ReportBoard board={board(reportDescriptor)} />);
    const outcome = fixture.outcome;
    if (outcome.state === 'error') {
      expect(await screen.findByTestId('dashboard-board-error')).toHaveTextContent(`unsupported asset id ${'unexpected_id' in outcome ? outcome.unexpected_id : ''} in namespace ${descriptor.asset_id_prefix}`);
      expect(get).not.toHaveBeenCalled();
    } else if (outcome.state === 'empty') {
      expect(await screen.findByTestId('dashboard-report-empty')).toHaveTextContent(/No Example Reports yet \(last checked /);
      expect(get).not.toHaveBeenCalled();
    } else {
      expect(await screen.findByText(`Synthetic report ${outcome.latest}.`)).toBeTruthy();
      expect(screen.getByTestId('dashboard-report-latest').props.accessibilityLabel).toContain(outcome.latest!);
      for (const [key, rev] of outcome.keys ?? []) expect(screen.getAllByText(`Report ${key} r${rev}`).length).toBeGreaterThan(0);
      expect(screen.getByTestId('dashboard-board-example-report').props.accessibilityValue.text).toBe(outcome.state === 'partial' ? 'partial' : 'ready');
      if ('notice' in outcome && outcome.notice) expect(screen.getByTestId('dashboard-report-truncated')).toHaveTextContent(outcome.notice);
      expect(get).toHaveBeenCalledWith('hostx:example-producer', outcome.latest, descriptor.spec_id);
    }
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(descriptor.spec_id, { assetIdPrefix: descriptor.asset_id_prefix, producer: descriptor.producer_stream_id, sort: 'asset_id_desc', limit: 12 });
    expect(assets.listReports).not.toHaveBeenCalled();
    expect(assets.listReportComments).not.toHaveBeenCalled();
    expect(assets.markReportRead).not.toHaveBeenCalled();
  });
}

test('opening history fetches its listed owner, without any additional list request', async () => {
  const earlier = row('example-report-20261006T1300Z-r02');
  earlier.stream_id = 'local:example-owner';
  list.mockResolvedValue([row(), earlier]);
  render(<ReportBoard board={board()} />);
  await screen.findByText(`Synthetic report ${row().asset_id}.`);
  fireEvent.press(screen.getByTestId(`dashboard-report-item-${earlier.asset_id}`));
  expect(await screen.findByText(`Synthetic report ${earlier.asset_id}.`)).toBeTruthy();
  expect(get).toHaveBeenLastCalledWith('local:example-owner', earlier.asset_id, descriptor.spec_id);
  expect(list).toHaveBeenCalledTimes(1);
});

test('list:false renders the latest body with no history list', async () => {
  render(<ReportBoard board={board({ ...descriptor, list: false })} />);
  await screen.findByText(`Synthetic report ${row().asset_id}.`);
  expect(screen.queryByTestId('dashboard-report-list')).toBeNull();
});

test('full windows qualify latest unless the descriptor enforces its writer', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(`example-report-20261004T1300Z${index < 11 ? `-r${String(11 - index).padStart(2, '0')}` : ''}`));
  list.mockResolvedValue(rows);
  const rendered = render(<ReportBoard board={board({ ...descriptor, writer_enforced: false })} />);
  await screen.findByText('latest in loaded window');
  expect(screen.getByTestId('dashboard-report-truncated')).toHaveTextContent('history truncated: 1 of up to 3 loaded');
  rendered.rerender(<ReportBoard board={board({ ...descriptor, writer_enforced: true })} />);
  await screen.findByText('latest');
  expect(screen.queryByText('latest in loaded window')).toBeNull();
});

test.each(['list', 'get', 'parse', 'owner'])('%s failures render the exact error card and never retry authorization', async (stage) => {
  if (stage === 'list') list.mockRejectedValue(new Error('asset_unavailable'));
  if (stage === 'get') get.mockRejectedValue(new Error('asset_forbidden'));
  if (stage === 'parse') get.mockResolvedValue({ ...row(), body: '{}' });
  if (stage === 'owner') list.mockResolvedValue([{ ...row(), stream_id: undefined }]);
  render(<ReportBoard board={board()} />);
  expect(await screen.findByTestId('dashboard-board-error')).toHaveTextContent('Board failed to load: ' + ({ list: 'asset_unavailable', get: 'asset_forbidden', parse: 'This report has an unsupported document shape', owner: 'report is missing its owner stream_id' }[stage]));
  expect(list).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(stage === 'get' || stage === 'parse' ? 1 : 0);
});

test('renderer failures are isolated inside the board', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    get.mockResolvedValue({ ...row(), body: { schema_version: 1, title: 'Example', sections: [{ id: 'example-section', title: 'Example', blocks: null as unknown as assets.ReportBlock[] }] } });
    render(<ReportBoard board={board()} />);
    expect(await screen.findByTestId('dashboard-board-error')).toHaveTextContent(/^Board failed to load:/);
    expect(screen.getByTestId('dashboard-board-example-report').props.accessibilityValue.text).toBe('error');
  } finally { consoleError.mockRestore(); }
});

test('a newer refresh wins over an older pending list and no timer polls', async () => {
  const old = deferred<assets.PentacleReport[]>();
  const stableBoard = board();
  list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([row('example-report-20261008T1300Z')]);
  const rendered = render(<ReportBoard board={stableBoard} />);
  rendered.rerender(<ReportBoard board={stableBoard} refreshKey={1} />);
  await screen.findByText('Synthetic report example-report-20261008T1300Z.');
  await act(async () => old.resolve([row()]));
  expect(screen.getByTestId('dashboard-report-latest').props.accessibilityLabel).toContain('example-report-20261008T1300Z');
  expect(get).toHaveBeenCalledTimes(1);
  jest.useFakeTimers();
  act(() => jest.advanceTimersByTime(600_000));
  expect(list).toHaveBeenCalledTimes(2);
});

test('newer history selection wins over an older pending body', async () => {
  const first = deferred<assets.PentacleReport>();
  const earlier = row('example-report-20261006T1300Z');
  list.mockResolvedValue([row(), earlier]);
  get.mockReturnValueOnce(first.promise);
  render(<ReportBoard board={board()} />);
  await screen.findByTestId(`dashboard-report-item-${earlier.asset_id}`);
  fireEvent.press(screen.getByTestId(`dashboard-report-item-${earlier.asset_id}`));
  await screen.findByText(`Synthetic report ${earlier.asset_id}.`);
  await act(async () => first.resolve(report(row().asset_id, 'Stale body must not render')));
  expect(screen.queryByText('Stale body must not render')).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
});

test('blur invalidates a pending body; view entry performs one fresh list', async () => {
  const first = deferred<assets.PentacleReport>();
  const stableBoard = board();
  get.mockReturnValueOnce(first.promise);
  const rendered = render(<ReportBoard board={stableBoard} />);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  rendered.rerender(<ReportBoard board={stableBoard} active={false} />);
  await act(async () => first.resolve(report(row().asset_id, 'Hidden stale body')));
  expect(screen.queryByText('Hidden stale body')).toBeNull();
  rendered.rerender(<ReportBoard board={stableBoard} active />);
  await screen.findByText(`Synthetic report ${row().asset_id}.`);
  expect(list).toHaveBeenCalledTimes(2);
});

test.each(['web-adapter', 'hosted-view'] as const)('%s shows unsupported without fetching code or assets', (kind) => {
  const unsupported = kind === 'web-adapter'
    ? { id: 'example-board', name: 'Example Board', kind, web: { script: 'web/example-board.js', sha256: 'a'.repeat(64) } }
    : { id: 'example-hosted', name: 'Example Hosted', kind, hosted: { url: 'https://viewer.example.test/app' } };
  render(<UnsupportedBoard board={unsupported} />);
  expect(screen.getByTestId(`dashboard-board-unsupported-${unsupported.id}`)).toHaveTextContent('Unsupported on this client');
  expect(list).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});


test.each(['ok', 'error'] as const)('harness records actual owner-scoped get %s without invented session identity', async (status) => {
  const prior = process.env.EXPO_PUBLIC_HARNESS;
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const events: TelemetryPayload[] = [];
  const detach = teeTelemetrySink((event) => events.push(event));
  if (status === 'error') get.mockRejectedValue(new Error('asset_forbidden'));
  try {
    render(<ReportBoard board={board()} />);
    if (status === 'error') await screen.findByText('Board failed to load: asset_forbidden');
    else await screen.findByText(`Synthetic report ${row().asset_id}.`);
    const evidence = events.filter((event) => String(event.message) === 'harness:ui_trace' && event.data.kind === 'dashboard_report_asset_get');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].data).toEqual({
      kind: 'dashboard_report_asset_get',
      scenario_run_id: null, board_id: 'example-report', asset_id: row().asset_id,
      spec_id: descriptor.spec_id, listed_stream_id: row().stream_id, request_stream_id: row().stream_id,
      status, ...(status === 'error' ? { error_code: 'asset_forbidden' } : {}),
    });
    expect(get).toHaveBeenCalledTimes(1);
  } finally {
    detach();
    if (prior === undefined) delete process.env.EXPO_PUBLIC_HARNESS; else process.env.EXPO_PUBLIC_HARNESS = prior;
  }
});
