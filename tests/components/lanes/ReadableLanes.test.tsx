jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/services/pentacleStream', () => ({ requestWorkLaneShow: jest.fn(), selectOptimisticQuestionAnswerIdentities: () => [] }));
jest.mock('../../../src/components/voice/HeaderVoiceMic', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../src/services/voicePresentation', () => ({ useVoiceSurface: jest.fn() }));
jest.mock('../../../src/components/questions/QuestionDeckCard', () => {
  const React = require('react'); const { Text } = require('react-native');
  return function Question({ laneId }: { laneId?: string }) { return <Text testID="lane-question">Question for {laneId}</Text>; };
});
import React from 'react';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { AccessibilityInfo, Text } from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, parseWorkLaneShow } from 'pentacle-chat-core';
import LanesOverlay from '../../../src/components/lanes/LanesOverlay';
import { selectLaneCardViewModels } from '../../../src/services/workLanes';
import { readableLanesFixture } from '../../../src/harness/readableLanesFixture';

beforeEach(() => jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true));
afterEach(() => jest.restoreAllMocks());
function setup(variant: 'full' | 'sparse' | 'old' | 'dot' = 'full') {
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
}, 15_000);

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

function snapshotPart(view: ReturnType<typeof render>, id: string) {
  function find(node: ReactTestRendererJSON | (ReactTestRendererJSON | string)[] | string | null): ReactTestRendererJSON | undefined {
    if (!node || typeof node === 'string') return undefined;
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    return node.props.testID === id ? node : find(node.children);
  }
  const node = find(view.toJSON());
  expect(node).toBeDefined();
  // Quoted JSON text preserves significant spaces without emitting trailing
  // whitespace in the snapshot file (the React JSX serializer leaves it bare).
  return JSON.parse(JSON.stringify(node));
}

test('legacy fixture card and item remain visually unchanged without optional keys', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-10T12:00:00Z'));
  const view = setup();
  expect(snapshotPart(view, 'lane-card-sample-lane-4')).toMatchSnapshot('legacy lane card');
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_1'));
  expect(snapshotPart(view, 'readable-spec')).toMatchSnapshot('legacy item');
});

async function openDotItem(view: ReturnType<typeof render>, id = 'spec_sample__flow_1') {
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  if (id === 'spec_sample__flow_1') expect(view.getByTestId('item-mark-spec_sample__flow_1-working')).toBeTruthy();
  fireEvent.press(view.getByTestId(`spec-row-${id}`));
}

test('waiting word precedes card and header ages, and Dot-only work joins Working now', async () => {
  const view = setup('dot');
  const card = within(view.getByTestId('lane-card-sample-lane-1'));
  expect(card.getByText('waiting on Dot · 3h')).toBeTruthy();
  const home = JSON.stringify(snapshotPart(view, 'readable-home'));
  const workingSection = home.indexOf('readable-section-working-now');
  const movingSection = home.indexOf('readable-section-in-progress');
  const dotCard = home.indexOf('lane-card-sample-lane-4');
  expect(dotCard).toBeGreaterThan(workingSection);
  expect(dotCard).toBeLessThan(movingSection);
  fireEvent.press(view.getByTestId('lane-row-sample-lane-1'));
  await act(async () => {});
  expect(view.getByText('waiting on Dot · 3h ago')).toBeTruthy();
});

test.each([
  ['spec_sample__flow_1', 'Dot is on it now', 'Review passed'],
  ['spec_sample__flow_2', 'Dot returned it, in review', 'Review failed'],
  ['spec_sample__flow_9', 'Waiting for Dot', 'Lead reported done'],
])('item %s places Dot above Now and Latest below Now', async (id, line, event) => {
  const view = setup('dot');
  await openDotItem(view, id);
  const item = within(view.getByTestId('readable-spec'));
  expect(item.getByText(line)).toBeTruthy();
  expect(item.getByText(`${event} · 2h ago`)).toBeTruthy();
  const labels = view.getByTestId('readable-spec').findAllByType(Text).map(n => n.props.children);
  expect(labels.indexOf('Dot')).toBeLessThan(labels.indexOf('Now'));
  expect(labels.indexOf('Latest')).toBeGreaterThan(labels.indexOf('Now'));
});

test('queued backlog small row shows only its waiting sentence; ordinary Later and Done rows stay terse', async () => {
  const view = setup('dot');
  fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
  await act(async () => {});
  fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
  await act(async () => {});
  expect(within(view.getByTestId('spec-row-spec_sample__flow_9')).getByText('Waiting for Dot')).toBeTruthy();
  expect(view.getByTestId('item-mark-spec_sample__flow_9-later')).toBeTruthy();
  expect(within(view.getByTestId('spec-row-spec_sample__flow_10')).queryByText('The screen is ready for review.')).toBeNull();
  fireEvent.press(view.getByTestId('goal-done-open'));
  expect(within(view.getByTestId('spec-row-spec_sample__flow_16')).queryByText('The screen is ready for review.')).toBeNull();
});

test.each(['older', 'equal', 'newer', 'missing'] as const)('Latest visibility compares %s progress against the event', async relation => {
  const fixture = readableLanesFixture('dot');
  const member = fixture.shows['sample-lane-4'].members[0];
  const at = Date.parse(member.latest_event!.at);
  member.progress_at = relation === 'missing' ? null : new Date(at + (relation === 'older' ? -1000 : relation === 'newer' ? 1000 : 0)).toISOString();
  const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
  const view = render(<LanesOverlay lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} assistantName="Assistant" connected updates={[]} top={0} bottom={0} onChat={jest.fn()} onClose={jest.fn()} readShow={async id => fixture.shows[id]} />);
  await openDotItem(view);
  expect(within(view.getByTestId('readable-spec')).queryByText('Latest') !== null).toBe(relation === 'older' || relation === 'missing');
});

test('an already open item keeps Dot through preview refresh, then shows a report-only detail revision and clears removed keys', async () => {
  const fixture = readableLanesFixture('dot');
  const lane = fixture.inventory.lanes[3], initial = fixture.shows[lane.lane_id];
  const member = initial.members[0];
  delete member.latest_event;
  lane.detail_revision = 'a'.repeat(64); initial.detail_revision = lane.detail_revision;
  const readShow = jest.fn(async () => initial);
  const props = { assistantName: 'Assistant', connected: true, updates: [], top: 0, bottom: 0, onChat: jest.fn(), onClose: jest.fn(), readShow };
  const projected = () => { const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory); return { lanes: selectLaneCardViewModels(state), inventory: state.workLanes }; };
  const view = render(<LanesOverlay {...props} {...projected()} />);
  await openDotItem(view);
  expect(within(view.getByTestId('readable-spec')).queryByText('Latest')).toBeNull();
  lane.members![0] = { ...lane.members![0], seats: [{ stream_id: 'sample', role: null, host: null, visibility: null, activity: 'idle', last_activity: null }] };
  view.rerender(<LanesOverlay {...props} {...projected()} />);
  expect(within(view.getByTestId('readable-spec')).getByText('Dot is on it now')).toBeTruthy();
  const updated = { ...initial, detail_revision: 'b'.repeat(64), projection: { ...lane, detail_revision: 'b'.repeat(64) }, members: initial.members.map(m => m.spec_id === member.spec_id ? { ...m, latest_event: { kind: 'review_passed' as const, at: new Date().toISOString() } } : m) };
  readShow.mockImplementation(async () => updated);
  lane.detail_revision = updated.detail_revision;
  view.rerender(<LanesOverlay {...props} {...projected()} />);
  await act(async () => {});
  expect(within(view.getByTestId('readable-spec')).getByText('Review passed · now ago')).toBeTruthy();
  const cleared = { ...updated, detail_revision: 'c'.repeat(64), projection: { ...lane, detail_revision: 'c'.repeat(64) }, members: updated.members.map(({ external, latest_event, ...m }) => m) };
  readShow.mockImplementation(async () => cleared);
  lane.detail_revision = cleared.detail_revision;
  view.rerender(<LanesOverlay {...props} {...projected()} />);
  await act(async () => {});
  const item = within(view.getByTestId('readable-spec'));
  expect(item.queryByText('Dot')).toBeNull(); expect(item.queryByText('Latest')).toBeNull();
});

test('malformed optional wire values preserve the existing card and item render', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-10T12:00:00Z'));
  const fixture = readableLanesFixture();
  const props = { assistantName: 'Assistant', connected: true, updates: [], top: 0, bottom: 0, onChat: jest.fn(), onClose: jest.fn() };
  async function capture(malformed: boolean) {
    if (malformed) {
      for (const lane of fixture.inventory.lanes) Object.assign(lane, { activity: 'unknown', external: { label: 'Dot', queued: -1 } });
      for (const show of Object.values(fixture.shows)) for (const member of show.members)
        Object.assign(member, { external: [{ label: 'Dot', state: 'unknown' }], latest_event: { kind: 'unknown', at: 'bad-time' } });
    }
    const state = applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory);
    const view = render(<LanesOverlay {...props} lanes={selectLaneCardViewModels(state)} inventory={state.workLanes} readShow={async id => parseWorkLaneShow(fixture.shows[id])!} />);
    const card = JSON.stringify(snapshotPart(view, 'lane-card-sample-lane-4'));
    fireEvent.press(view.getByTestId('lane-row-sample-lane-4'));
    await act(async () => {});
    fireEvent.press(view.getByTestId('goal-head-g_sample_3_0'));
    await act(async () => {});
    fireEvent.press(view.getByTestId('spec-row-spec_sample__flow_1'));
    const item = JSON.stringify(snapshotPart(view, 'readable-spec'));
    view.unmount();
    return { card, item };
  }
  const baseline = await capture(false);
  expect(await capture(true)).toEqual(baseline);
});
