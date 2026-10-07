jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));

import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, type WorkLane } from 'pentacle-chat-core';
import LanesSurface from '../../../src/components/lanes/LanesSurface';
import { selectLaneViewModels, selectWorkLaneCounts } from '../../../src/services/workLanes';

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8',
));
const NOW = Date.parse('2026-10-07T19:01:00Z');
const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory_frame);

function surface(overrides: Partial<React.ComponentProps<typeof LanesSurface>> = {}) {
  const onOpenLane = jest.fn();
  const onOpenLead = jest.fn();
  const view = render(<LanesSurface lanes={selectLaneViewModels(state, NOW)} counts={selectWorkLaneCounts(state)}
    truncated={false} now={NOW} top={0} bottom={0} onOpenLane={onOpenLane} onOpenLead={onOpenLead} {...overrides} />);
  return { view, onOpenLane, onOpenLead };
}

test('lists lanes in daemon order with the open count and only the three header states', () => {
  const { view } = surface();
  expect(view.getByText('Open lanes · 4')).toBeTruthy();
  const rows = view.getAllByTestId(/^lane-row-/).map((row) => row.props.testID);
  expect(rows).toEqual(fixture.expected.order.map((id: string) => `lane-row-${id}`));
  expect(view.getByTestId('lane-state-wl-blocked-0001').props.children).toBe('BLOCKED');
  expect(view.getByTestId('lane-state-wl-active-0002').props.children).toBe('ACTIVE');
  expect(view.getByTestId('lane-state-wl-paused-0003').props.children).toBe('PAUSED');
  expect(view.queryByText('DONE')).toBeNull();
});

test('a blocked lane names its blocker and a stale ETA is not reported late', () => {
  const { view } = surface();
  expect(view.getByText('Waiting for operator deploy window')).toBeTruthy();
  expect(view.getByTestId('lane-eta-wl-blocked-0001').props.children).toBe('Blocked');
  expect(view.getByTestId('lane-eta-wl-paused-0003').props.children).toBe('ETA stale');
  expect(view.getByTestId('lane-eta-wl-paused-0004').props.children).toBe('ETA stale');
  expect(view.getByTestId('lane-eta-wl-active-0002').props.children).toBe('~8h 59m');
  expect(view.queryByText(/late/)).toBeNull();
});

test('owner kind and lead presence are shown per lane', () => {
  const { view } = surface();
  expect(view.getByTestId('lane-owner-wl-paused-0003').props.children).toBe('OPERATOR');
  expect(view.getByTestId('lane-owner-wl-blocked-0001').props.children).toBe('FD');
  expect(view.getByTestId('lane-presence-wl-active-0002').props.children).toBe('working');
  expect(view.getByTestId('lane-presence-wl-blocked-0001').props.children).toBe('idle');
  expect(view.getByTestId('lane-presence-wl-paused-0003').props.children).toBe('offline');
});

test('tap hands the lane model to the opener; unavailable chats show an inline state and do not open', () => {
  const { view, onOpenLane } = surface();
  fireEvent.press(view.getByTestId('lane-row-wl-blocked-0001'));
  fireEvent.press(view.getByTestId('lane-row-wl-active-0002'));
  fireEvent.press(view.getByTestId('lane-row-wl-paused-0003'));
  expect(onOpenLane.mock.calls.map(([model]) => model.tap)).toEqual([
    fixture.expected.tap['wl-blocked-0001'], fixture.expected.tap['wl-active-0002'], fixture.expected.tap['wl-paused-0003'],
  ]);
  expect(view.getByTestId('lane-unavailable-wl-paused-0004').props.children).toBe('Chat unavailable');
  fireEvent.press(view.getByTestId('lane-row-wl-paused-0004'));
  expect(onOpenLane).toHaveBeenCalledTimes(3);
  expect(view.queryByTestId('lane-unavailable-wl-blocked-0001')).toBeNull();
});

test('expanding a lane with a qualifying lead reuses the shared status-card mini view', () => {
  const { view, onOpenLead } = surface();
  expect(view.queryByTestId('card-status-mini-fixture-host:v2-lead0002')).toBeNull();
  fireEvent.press(view.getByTestId('lane-toggle-wl-active-0002'));
  fireEvent.press(view.getByTestId('card-status-mini-fixture-host:v2-lead0002'));
  expect(onOpenLead).toHaveBeenCalledWith('fixture-host:v2-lead0002');
  expect(view.getByText('Mobile lanes UI')).toBeTruthy();
});

test('a lane without a qualifying lead has no lead card to expand', () => {
  const { view } = surface();
  expect(view.getByTestId('lane-toggle-wl-paused-0003').props.accessibilityState.disabled).toBe(true);
});

test('empty and truncated states are honest', () => {
  const empty = surface({ lanes: [], counts: { open: 0, active: 0, paused: 0, blocked: 0 } });
  expect(empty.view.getByText('No open lanes')).toBeTruthy();
  empty.view.unmount();
  const truncated = surface({ truncated: true, counts: { open: 70, active: 70, paused: 0, blocked: 0 } });
  expect(truncated.view.getByText('Showing 4 of 70 open lanes')).toBeTruthy();
});

test('the lane type is the wire type: a done lane is never rendered even if handed in', () => {
  const lanes = selectLaneViewModels(state, NOW);
  const done = { ...lanes[0], lane: { ...lanes[0].lane, lane_id: 'wl-done-9', state: 'done' } as WorkLane };
  const { view } = surface({ lanes: [done, ...lanes] });
  expect(view.queryByTestId('lane-row-wl-done-9')).toBeNull();
});
