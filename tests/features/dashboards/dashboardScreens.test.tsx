import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import BusinessDashboardScreen from '../../../src/features/dashboards/BusinessDashboardScreen';
import ForeclosureDashboardScreen from '../../../src/features/dashboards/ForeclosureDashboardScreen';
import TestingDashboardScreen from '../../../src/features/dashboards/TestingDashboardScreen';
import { resolveDashboardSnapshot } from '../../../src/features/dashboards/dashboardHubClient';
import { resolveBusinessDashboard, resolveForeclosureDashboard } from '../../../src/features/dashboards/dashboardData';
import type { DashboardEnvelope } from '../../../src/features/dashboards/types';
import businessEnvelope from '../../../test/e2e/fixtures/dashboard_hub/business.json';
import foreclosureEnvelope from '../../../test/e2e/fixtures/dashboard_hub/foreclosure.json';
import { testingEnvelope } from '../../fixtures/publicDashboardFixtures';

afterEach(() => jest.restoreAllMocks());

function snapshot(envelope: unknown, batch = '') {
  const value = envelope as DashboardEnvelope;
  if (value.dashboard_id === 'hosta.foreclosure') {
    return resolveForeclosureDashboard(value, batch, true, Date.parse('2026-07-17T08:00:10Z'));
  }
  if (value.dashboard_id === 'hosta.business') {
    return resolveBusinessDashboard(value, true, Date.parse('2026-07-17T08:00:10Z'));
  }
  return resolveDashboardSnapshot(
    value,
    true,
    Date.parse('2026-07-17T08:00:10Z'),
  );
}

test('foreclosure selects a batch and confirms reopening before optimistic gate state', async () => {
  const onSelectBatch = jest.fn();
  const onMutateGate = jest.fn().mockResolvedValue({
    ok: true,
    batch: '2026-07-16',
    gate: 'open',
    setting: 'auto_submit_skipmatrix',
    changed: true,
    device_id: 'phone-1',
    updated_at: '2026-07-17T08:00:00Z',
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const rendered = render(<ForeclosureDashboardScreen snapshot={snapshot(foreclosureEnvelope)} onSelectBatch={onSelectBatch} onMutateGate={onMutateGate} />);

  expect(screen.getAllByText('qualify').length).toBeGreaterThan(0);
  fireEvent.press(screen.getByTestId('foreclosure-batch-2026-07-16'));
  expect(onSelectBatch).toHaveBeenCalledWith('2026-07-16');
  expect(screen.getByTestId('foreclosure-gate-toggle').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByText('Switching batch…')).toBeTruthy();
  rendered.rerender(<ForeclosureDashboardScreen snapshot={snapshot(foreclosureEnvelope, '2026-07-16')} onSelectBatch={onSelectBatch} onMutateGate={onMutateGate} />);
  expect(screen.getByTestId('foreclosure-summary-stage')).toHaveTextContent('skipmatrix_csv');
  fireEvent(screen.getByTestId('foreclosure-gate-toggle'), 'valueChange', true);
  expect(alert).toHaveBeenCalledWith(
    'Reopen skip-trace gate?',
    expect.stringContaining('2026-07-16'),
    expect.any(Array),
  );
  const buttons = alert.mock.calls[0][2] as Array<{ text?: string; onPress?: () => void }>;
  await act(async () => buttons.find((button) => button.text === 'Reopen')?.onPress?.());
  expect(onMutateGate).toHaveBeenCalledWith(expect.objectContaining({ batch: '2026-07-16', gate: 'open' }));
  expect(screen.getByText('OPEN')).toBeTruthy();
});

test('foreclosure shows a failed mutation without leaving optimistic state behind', async () => {
  const onMutateGate = jest.fn().mockResolvedValue({ ok: false, error: 'write scope required' });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  render(<ForeclosureDashboardScreen snapshot={snapshot(foreclosureEnvelope)} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />);
  fireEvent(screen.getByTestId('foreclosure-gate-toggle'), 'valueChange', true);
  const buttons = alert.mock.calls[0][2] as Array<{ text?: string; onPress?: () => void }>;
  await act(async () => buttons.find((button) => button.text === 'Reopen')?.onPress?.());
  expect(await screen.findByTestId('foreclosure-gate-error')).toHaveTextContent('write scope required');
  expect(screen.getByText('CLOSED')).toBeTruthy();
});

test('foreclosure waits for the pushed snapshot when a reissue reports changed false', async () => {
  const onMutateGate = jest.fn().mockResolvedValue({
    ok: true,
    batch: '2026-07-17',
    gate: 'open',
    setting: 'auto_submit_skipmatrix',
    changed: false,
    device_id: 'phone-1',
    updated_at: '2026-07-17T08:00:00Z',
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const rendered = render(<ForeclosureDashboardScreen snapshot={snapshot(foreclosureEnvelope)} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />);
  fireEvent(screen.getByTestId('foreclosure-gate-toggle'), 'valueChange', true);
  const buttons = alert.mock.calls[0][2] as Array<{ text?: string; onPress?: () => void }>;
  await act(async () => buttons.find((button) => button.text === 'Reopen')?.onPress?.());
  expect(screen.getByText('CLOSED')).toBeTruthy();
  const pushed = JSON.parse(JSON.stringify(foreclosureEnvelope));
  pushed.data.snapshots['2026-07-17'].pipeline_summary.skiptrace_gate = 'open';
  rendered.rerender(<ForeclosureDashboardScreen snapshot={snapshot(pushed)} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />);
  expect(screen.getByText('OPEN')).toBeTruthy();
});

test('business fixture renders stages, totals, and horizontal detail tables', () => {
  render(<BusinessDashboardScreen snapshot={snapshot(businessEnvelope)} />);
  expect(screen.getAllByText('410').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Brussels').length).toBeGreaterThan(0);
  expect(screen.getAllByText('google').length).toBeGreaterThan(0);
  expect(screen.getByTestId('business-area-table')).toBeTruthy();
});

test('testing fixture renders all six read-only panels and staleness', () => {
  render(<TestingDashboardScreen snapshot={snapshot(testingEnvelope)} />);
  for (const id of ['now-running', 'latest-gate-runs', 'whats-left', 'time-estimates', 'per-test-analytics', 'recent-closures']) {
    expect(screen.getByTestId(`testing-panel-${id}`)).toBeTruthy();
  }
  expect(screen.getByText('LIVE')).toBeTruthy();
  expect(screen.getByText('dashboardHubClient')).toBeTruthy();
});

test('staleness badge distinguishes stale data from an offline transport', () => {
  const current = snapshot(businessEnvelope)!;
  const rendered = render(<BusinessDashboardScreen snapshot={{ ...current, _data_stale: true }} />);
  expect(screen.getByText('STALE')).toBeTruthy();
  rendered.rerender(<BusinessDashboardScreen snapshot={{ ...current, _transport_stale: true }} />);
  expect(screen.getByText('OFFLINE')).toBeTruthy();
});
