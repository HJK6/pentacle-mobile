import React from 'react';
import { Alert, Switch } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ForeclosureDashboardScreen from '../src/features/dashboards/ForeclosureDashboardScreen';
import type { DashboardGate, DashboardSnapshot } from '../src/features/dashboards/types';

function snapshot(gate: DashboardGate): DashboardSnapshot {
  return {
    _age_sec: 0,
    _data_stale: false,
    _server_received_at: '2026-07-17T08:00:01Z',
    _transport_stale: false,
    _updated_at: '2026-07-17T08:00:00Z',
    all_batches: ['2026-07-17'],
    batch: '2026-07-17',
    pipeline_summary: {
      current_stage: 'qualify',
      current_state: 'running',
      skiptrace_gate: gate,
      state_machine_batch: '2026-07-17',
    },
    stages: [],
  };
}

const success = {
  batch: '2026-07-17',
  changed: true,
  device_id: 'simulator-device',
  gate: 'open' as const,
  ok: true as const,
  setting: 'auto_submit_skipmatrix',
  updated_at: '2026-07-17T08:00:02Z',
};

afterEach(() => jest.restoreAllMocks());

test('gate row is the accessible switch target and opens confirmation when closed', async () => {
  const onMutateGate = jest.fn(async () => success);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const rendered = render(
    <ForeclosureDashboardScreen snapshot={snapshot('closed')} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />,
  );

  const control = screen.getByTestId('foreclosure-gate-control');
  expect(control.props.accessibilityRole).toBe('switch');
  expect(control.props.accessibilityState).toEqual({ checked: false, disabled: false });
  fireEvent.press(control);

  expect(alert).toHaveBeenCalledWith(
    'Reopen skip-trace gate?',
    'This releases qualified records for 2026-07-17.',
    expect.any(Array),
  );
  expect(alert).toHaveBeenCalledTimes(1);
  expect(onMutateGate).not.toHaveBeenCalled();
  const reopen = alert.mock.calls[0][2]?.find((button) => button.text === 'Reopen');
  await act(async () => reopen?.onPress?.());
  expect(onMutateGate).toHaveBeenCalledWith({ batch: '2026-07-17', gate: 'open' });
  expect(onMutateGate).toHaveBeenCalledTimes(1);

  const indicator = rendered.UNSAFE_getByType(Switch);
  expect(indicator.props.pointerEvents).toBe('none');
  expect(indicator.props.accessible).toBe(false);
  expect(indicator.props.onValueChange).toEqual(expect.any(Function));
});

test('gate row closes an open gate without confirmation', async () => {
  const onMutateGate = jest.fn(async (mutation) => ({ ...success, ...mutation }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  render(
    <ForeclosureDashboardScreen snapshot={snapshot('open')} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />,
  );

  const control = screen.getByTestId('foreclosure-gate-control');
  expect(control.props.accessibilityState).toEqual({ checked: true, disabled: false });
  await act(async () => fireEvent.press(control));

  expect(alert).not.toHaveBeenCalled();
  expect(onMutateGate).toHaveBeenCalledWith({ batch: '2026-07-17', gate: 'closed' });
  expect(onMutateGate).toHaveBeenCalledTimes(1);
});

test('gate row is disabled while a different batch is loading', () => {
  const onMutateGate = jest.fn(async () => success);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const transitioning = { ...snapshot('closed'), all_batches: ['2026-07-17', '2026-07-16'] };
  render(
    <ForeclosureDashboardScreen snapshot={transitioning} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />,
  );

  fireEvent.press(screen.getByTestId('foreclosure-batch-2026-07-16'));
  const control = screen.getByTestId('foreclosure-gate-control');
  expect(control.props.accessibilityState).toEqual({ checked: false, disabled: true });
  fireEvent.press(control);

  expect(alert).not.toHaveBeenCalled();
  expect(onMutateGate).not.toHaveBeenCalled();
});

test('gate row is disabled when the snapshot has no known gate state', () => {
  const onMutateGate = jest.fn(async () => success);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const unknown = snapshot('closed');
  unknown.pipeline_summary = { ...unknown.pipeline_summary as object, skiptrace_gate: 'unknown' };
  render(
    <ForeclosureDashboardScreen snapshot={unknown} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />,
  );

  const control = screen.getByTestId('foreclosure-gate-control');
  expect(control.props.accessibilityState).toEqual({ checked: false, disabled: true });
  fireEvent.press(control);

  expect(alert).not.toHaveBeenCalled();
  expect(onMutateGate).not.toHaveBeenCalled();
});

test('gate row disables while a mutation is pending and blocks duplicate delivery', async () => {
  let resolveMutation!: (value: typeof success) => void;
  const onMutateGate = jest.fn(() => new Promise<typeof success>((resolve) => {
    resolveMutation = resolve;
  }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  render(
    <ForeclosureDashboardScreen snapshot={snapshot('closed')} onSelectBatch={jest.fn()} onMutateGate={onMutateGate} />,
  );

  const control = screen.getByTestId('foreclosure-gate-control');
  fireEvent.press(control);
  const reopen = alert.mock.calls[0][2]?.find((button) => button.text === 'Reopen');
  act(() => reopen?.onPress?.());

  await waitFor(() => expect(control.props.accessibilityState).toEqual({ checked: false, disabled: true }));
  expect(control.props.accessibilityState).toEqual({ checked: false, disabled: true });
  fireEvent.press(control);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(onMutateGate).toHaveBeenCalledTimes(1);

  await act(async () => resolveMutation(success));
});
