jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/services/pentacleStream', () => ({ requestWorkLaneShow: jest.fn(), selectOptimisticQuestionAnswerIdentities: () => [] }));
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, type WorkLaneMember, type WorkLaneShow, type WorkLaneShowOptions } from 'pentacle-chat-core';
import { lanesFlowFixture } from '../../../src/harness/lanesFlowFixture';
import LanesMap from '../../../src/components/lanes/LanesMap';
import { selectLaneCardViewModels } from '../../../src/services/workLanes';
const revision = 'a'.repeat(64);
function fixture() {
  const f = lanesFlowFixture();
  const lane = f.inventory.lanes[0];
  const members: WorkLaneMember[] = Array.from({ length: 65 }, (_, i) => ({ spec_id: `spec_sample_${String(i + 1).padStart(3, '0')}`, title: `Sample member ${i + 1}`, status: i < 32 ? 'completed' : 'in_progress', terminal: i < 32 ? 'completed' : null }));
  Object.assign(lane, { members: members.slice(0, 8), members_total: 65, detail_revision: revision, items_total: 65, items_completed: 32, items_dropped: 0 });
  f.inventory.lanes = [lane];
  const models = selectLaneCardViewModels(applyWorkLanesInventory(initialPentacleStreamState, f.inventory));
  const page = (after?: string): WorkLaneShow => {
    const start = after ? members.findIndex(m => m.spec_id === after) + 1 : 0, rows = members.slice(start, start + 32);
    return { lane_id: lane.lane_id, projection: { ...lane, members: rows }, members: rows, members_total: 65,
      members_next: start + rows.length < 65 ? rows.at(-1)!.spec_id : null, detail_revision: revision, updates: [], spec_changes: [], events: [] };
  };
  return { lane, models, members, page };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
beforeEach(() => jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true));
afterEach(() => jest.restoreAllMocks());
test('rendered 65-spec lane shows loaded counts until page three, then opens its final spec', async () => {
  const f = fixture(), second = deferred<WorkLaneShow>(), onOpen = jest.fn();
  const read = jest.fn().mockResolvedValueOnce(f.page()).mockImplementationOnce(() => second.promise)
    .mockResolvedValueOnce(f.page('spec_sample_064'));
  const view = render(<LanesMap lanes={f.models} focusedLaneId={f.lane.lane_id} onFocusLane={jest.fn()} assistantName="Sample guide"
    readShow={read} onOpenMember={onOpen} onLog={jest.fn()} onChat={jest.fn()} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(view.getByTestId('lanes-map-members-loading')).toBeTruthy();
  expect(view.getByTestId('spec-done-fold')).toHaveTextContent('✓32 loaded');
  expect(view.queryByTestId('lanes-map-members-error')).toBeNull();
  await act(async () => second.resolve(f.page('spec_sample_032')));
  expect(read).toHaveBeenCalledTimes(3);
  expect(view.queryByTestId('lanes-map-members-loading')).toBeNull();
  expect(view.getByTestId('spec-done-fold')).toHaveTextContent('✓32');
  fireEvent.press(view.getByTestId('spec-done-fold'));
  expect(view.getAllByTestId(/^spec-row-/)).toHaveLength(65);
  fireEvent.press(view.getByTestId('spec-row-spec_sample_065'));
  expect(onOpen).toHaveBeenCalledWith(f.models[0], expect.objectContaining({ spec_id: 'spec_sample_065' }));
  expect(view.getAllByText('Sample member 65').length).toBeGreaterThan(0);
});
test('source revision reloads outside-preview equal-count replacement while a presence update does not', async () => {
  const f = fixture();
  const read = jest.fn(async (_id: string, options?: WorkLaneShowOptions) => f.page(options?.members_after));
  const surface = (models = f.models) => <LanesMap lanes={models} focusedLaneId={f.lane.lane_id} onFocusLane={jest.fn()} assistantName="Sample guide"
    readShow={read} onOpenMember={jest.fn()} onLog={jest.fn()} onChat={jest.fn()} />;
  const view = render(surface());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  view.rerender(surface([{ ...f.models[0], lane: { ...f.lane, version: f.lane.version + 1 } }]));
  await act(async () => {}); expect(read).toHaveBeenCalledTimes(3);
  f.members[64] = { ...f.members[64], title: 'Replacement outside preview' };
  view.rerender(surface([{ ...f.models[0], lane: { ...f.lane, detail_revision: 'b'.repeat(64) } }]));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(6));
  expect(view.getByText('Replacement outside preview')).toBeTruthy();
});
