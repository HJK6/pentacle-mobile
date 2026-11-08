jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/services/pentacleStream', () => ({ requestWorkLaneShow: jest.fn(), selectOptimisticQuestionAnswerIdentities: () => [] }));
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, render, within } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState } from 'pentacle-chat-core';
import LanesMap from '../../../src/components/lanes/LanesMap';
import { lanesGoalsFixture } from '../../../src/harness/lanesGoalsFixture';
import { laneGoalParts, laneTopGoals, selectLaneCardViewModels } from '../../../src/services/workLanes';
const treeBytes = (tree: unknown) => JSON.parse(JSON.stringify(tree, (key, value) => key === 'handlerTag' ? undefined : value));
const now = Date.parse('2026-11-01T12:00:00Z');
function surface(f = lanesGoalsFixture(now)) {
  const models = selectLaneCardViewModels(applyWorkLanesInventory(initialPentacleStreamState, f.inventory), now);
  return render(<LanesMap lanes={models} focusedLaneId={null} assistantName="Sample guide" onFocusLane={jest.fn()}
    onOpenMember={jest.fn()} onLog={jest.fn()} onChat={jest.fn()} readShow={async id => f.shows[id]} />);
}
beforeEach(() => jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true));
afterEach(() => jest.restoreAllMocks());
test('per-goal rings and equal row parts replace lane acceptance and state text', async () => {
  const f = lanesGoalsFixture(now), view = surface(f);
  await act(async () => {});
  for (const lane of f.inventory.lanes.slice(0, 6)) {
    const node = within(view.getByTestId(`lanes-map-lane-${lane.lane_id}`));
    expect(node.queryAllByTestId(/^lane-goal-arc-/)).toHaveLength(laneTopGoals(lane).length);
    const row = view.getByTestId(`lane-row-${lane.lane_id}`), parts = within(row).queryAllByTestId(/^lane-goal-part-/);
    expect(parts).toHaveLength(laneGoalParts(lane).length);
    for (const part of parts) expect(part.props.style).toMatchObject({ flex: 1, height: 4 });
    expect(within(row).queryAllByText(/^(WORKING|BLOCKED|NEEDS YOU)$/)).toHaveLength(0);
    expect(row.props.accessibilityLabel).toMatch(/NEEDS YOU|WORKING|BLOCKED|PAUSED|ACTIVE/);
  }
  expect(view.queryAllByTestId(/^lane-state-label/)).toHaveLength(0);
  expect(view.queryAllByTestId(/^lane-blocked-badge/)).toHaveLength(0);
  expect(view.queryAllByTestId(/^lane-needs-you-/).length).toBeGreaterThan(0);
  expect(view.getByTestId('lanes-group-needsYou')).toBeTruthy();
  expect(view.getByTestId('lanes-group-working')).toBeTruthy();
  expect(view.getByTestId('lanes-group-paused')).toBeTruthy();
});
test('sparse and explicit whole-lane default produce identical node and row trees', async () => {
  const f = lanesGoalsFixture(now), lane = f.inventory.lanes[4];
  const first = surface(f); await act(async () => {});
  const tree = treeBytes(first.toJSON());
  first.unmount();
  lane.goals = []; lane.default_goal = { state: 'in_progress', done: lane.items_completed ?? 0, total: (lane.items_total ?? 0) - (lane.items_dropped ?? 0) };
  const second = surface(f); await act(async () => {});
  expect(treeBytes(second.toJSON())).toEqual(tree);
});
