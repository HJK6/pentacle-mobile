jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/services/pentacleStream', () => ({ requestWorkLaneShow: jest.fn(), selectOptimisticQuestionAnswerIdentities: () => [] }));
jest.mock('../../../src/components/voice/HeaderVoiceMic', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../src/services/voicePresentation', () => ({ useVoiceSurface: jest.fn() }));
jest.mock('../../../src/components/questions/QuestionDeckCard', () => {
  const React = require('react'); const { Text } = require('react-native');
  return function Question({ laneId }: { laneId?: string }) { return <Text testID="lane-question">Question for {laneId}</Text>; };
});
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState } from 'pentacle-chat-core';
import LanesOverlay from '../../../src/components/lanes/LanesOverlay';
import { selectLaneCardViewModels } from '../../../src/services/workLanes';
import { readableLanesFixture } from '../../../src/harness/readableLanesFixture';

beforeEach(() => jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true));
afterEach(() => jest.restoreAllMocks());
function setup(variant: 'full' | 'sparse' | 'old' = 'full') {
  const fixture = readableLanesFixture(variant);
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const readShow = jest.fn(async (id: string) => fixture.shows[id]);
  const view = render(<LanesOverlay lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} assistantName="Assistant" connected updates={[]} top={0} bottom={0} onChat={jest.fn()} onClose={jest.fn()} readShow={readShow} />);
  return { ...view, readShow };
}
test('lane, goal and spec navigation uses the question card and never exposes raw fields', async () => {
  const view = setup();
  expect(view.queryByTestId('lane-question')).toBeNull();
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.getByTestId('lane-question')).toHaveTextContent('Question for sample-lane-4');
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  expect(view.getByTestId('readable-goal')).toBeTruthy();
  fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_1'));
  expect(view.getByTestId('readable-spec')).toBeTruthy();
  expect(view.getByText('Make the release checks reliable.')).toBeTruthy();
  expect(view.queryByText('The screen is ready. Another sentence stays hidden.')).toBeNull();
  expect(view.queryByText('Check the lane navigation.')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Back'));
  expect(view.getByTestId('readable-goal')).toBeTruthy();
});
test.each(['sparse', 'old'] as const)('%s input remains navigable without missing-field placeholders', async variant => {
  const view = setup(variant);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.getByTestId('readable-lane')).toBeTruthy();
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_1'));
  expect(view.getByTestId('readable-spec')).toBeTruthy();
  expect(view.queryByText('Make the release checks reliable.')).toBeNull();
});

test('a v1 show without a projection still opens the lane without inventing members', async () => {
  const fixture = readableLanesFixture('old');
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const show = fixture.shows['sample-lane-4'];
  const readShow = jest.fn(async () => ({ ...show, projection: null, members: [] }));
  const view = render(<LanesOverlay lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} assistantName="Assistant" connected updates={[]} top={0} bottom={0} onChat={jest.fn()} onClose={jest.fn()} readShow={readShow} />);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.getByTestId('readable-lane')).toBeTruthy();
  expect(view.queryByTestId('lanes-detail-retry')).toBeNull();
  expect(view.queryByTestId('spec-row-spec_sample__flow_1')).toBeNull();
});

test('loads every detail page before claiming a complete member count', async () => {
  const fixture = readableLanesFixture();
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const show = fixture.shows['sample-lane-4'];
  const revision = 'a'.repeat(64), first = show.members.slice(0, 16), second = show.members.slice(16);
  let release!: (value: typeof show) => void;
  const pending = new Promise<typeof show>(resolve => { release = resolve; });
  const readShow = jest.fn((_id: string, options?: { members_after?: string }) => options?.members_after
    ? pending : Promise.resolve({ ...show, detail_revision: revision, members: first, members_total: show.members.length, members_next: first[first.length - 1].spec_id }));
  const view = render(<LanesOverlay lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} assistantName="Assistant" connected updates={[]} top={0} bottom={0} onChat={jest.fn()} onClose={jest.fn()} readShow={readShow} />);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.getByTestId('lanes-members-paging')).toBeTruthy();
  await act(async () => { release({ ...show, detail_revision: revision, members: second, members_total: show.members.length, members_next: null }); await pending; });
  expect(view.queryByTestId('lanes-members-paging')).toBeNull();
  expect(readShow).toHaveBeenCalledTimes(2);
});

test('failed lane loading offers a same-lane retry and does not invent goal classes', async () => {
  const fixture = readableLanesFixture();
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const readShow = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(fixture.shows['sample-lane-4']);
  const view = render(<LanesOverlay lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} assistantName="Assistant" connected updates={[]} top={0} bottom={0} onChat={jest.fn()} onClose={jest.fn()} readShow={readShow} />);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.queryByTestId('goal-head-g_sample_3_0')).toBeNull();
  fireEvent.press(view.getByText('Lane details unavailable · Retry'));
  await act(async () => {});
  expect(view.getByTestId('goal-head-g_sample_3_0')).toBeTruthy();
  expect(readShow.mock.calls.map(call => call[0])).toEqual(['sample-lane-4', 'sample-lane-4']);
});

test('spec trouble and checks use the projected fields, not raw status text', async () => {
  const view = setup();
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_3'));
  expect(view.getByText(/3\.0h over estimate/)).toBeTruthy();
  expect(view.getByText(/2 review rounds/)).toBeTruthy();
  expect(view.getByText(/Navigate back without losing position/)).toBeTruthy();
  expect(view.queryByText('The screen is ready. Another sentence stays hidden.')).toBeNull();
  fireEvent.press(view.getByText(/2 passed/));
  expect(view.getByText(/Progress stays visible/)).toBeTruthy();
});

test('full fixture renders blocked facts and recent entries while ordinary specs have no trouble line', async () => {
  const view = setup();
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.getByTestId('lane-road')).toBeTruthy();
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_2'));
  expect(view.getByText('the review window')).toBeTruthy();
  expect(view.getByText(/2 checks passed/)).toBeTruthy();
  fireEvent.press(view.getByLabelText('Back'));
  fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_4'));
  expect(view.queryByText(/review rounds/)).toBeNull();
  expect(view.queryByText(/over estimate/)).toBeNull();
});

test('a no-spec lane does not expose contradictory fetched members', async () => {
  const fixture = readableLanesFixture();
  const lane = fixture.inventory.lanes[3];
  lane.no_spec_reason = 'No specs are assigned.';
  fixture.shows[lane.lane_id].projection = lane;
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const view = render(<LanesOverlay lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} assistantName="Assistant" connected updates={[]} top={0} bottom={0} onChat={jest.fn()} onClose={jest.fn()} readShow={async id => fixture.shows[id]} />);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.queryAllByTestId(/^spec-row-/)).toHaveLength(0);
});

test('opening a lane offline waits for reconnect instead of showing invented goals', async () => {
  const fixture = readableLanesFixture();
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const readShow = jest.fn(async (id: string) => fixture.shows[id]);
  const props = { lanes: selectLaneCardViewModels(state), inventory: state.workLanes, assistantName: 'Assistant', updates: [], top: 0, bottom: 0, onChat: jest.fn(), onClose: jest.fn(), readShow };
  const view = render(<LanesOverlay {...props} connected={false} />);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  expect(view.getByTestId('lanes-connection-wait')).toBeTruthy();
  expect(readShow).not.toHaveBeenCalled();
  view.rerender(<LanesOverlay {...props} connected />);
  await act(async () => {});
  expect(view.getByTestId('goal-head-g_sample_3_0')).toBeTruthy();
});
