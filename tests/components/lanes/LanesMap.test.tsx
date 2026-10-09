jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/services/pentacleStream', () => ({
  requestWorkLaneShow: jest.fn(), selectOptimisticQuestionAnswerIdentities: () => [],
}));
jest.mock('../../../src/components/lanes/lanesTelemetry', () => ({ emitHarnessUiTrace: jest.fn() }));

import { readFileSync } from 'fs';
import { join } from 'path';
import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, type WorkLaneMember, type WorkLaneShow } from 'pentacle-chat-core';
import { Tokens } from '../../../constants/Colors';
import LanesMap from '../../../src/components/lanes/LanesMap';
import LaneMembers from '../../../src/components/lanes/LaneMembers';
import LaneMemberDetail from '../../../src/components/lanes/LaneMemberDetail';
import { emitHarnessUiTrace } from '../../../src/components/lanes/lanesTelemetry';
import { selectLaneCardViewModels, type LaneCardViewModel } from '../../../src/services/workLanes';

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../../../pentacle-chat-core/tests/fixtures/work-lanes-inventory.json'), 'utf8',
));
const NOW = Date.parse('2026-01-02T00:05:00Z');
const progressCase = (name: string) => fixture.progress_v2.find((entry: { name: string }) => entry.name === name);
const modelsFor = (frame: unknown) => selectLaneCardViewModels(applyWorkLanesInventory(initialPentacleStreamState, frame), NOW);
const modelFor = (name = 'active_progress') => modelsFor(progressCase(name).frame)[0];

function surface(lanes = [modelFor()], initialFocus: string | null = null, initialPage = 0) {
  const onOpenMember = jest.fn();
  const onShowAll = jest.fn();
  const onLog = jest.fn();
  const onChat = jest.fn();
  function Driver({ models }: { models: LaneCardViewModel[] }) {
    const [focus, setFocus] = useState(initialFocus);
    const [page, setPage] = useState(initialPage);
    return <LanesMap lanes={models} assistantName="Orbit Guide" assistantSigil="flower"
      focusedLaneId={focus} onFocusLane={setFocus} page={page} onPageChange={setPage}
      onOpenMember={onOpenMember} onShowAll={onShowAll} onLog={onLog} onChat={onChat} />;
  }
  const view = render(<Driver models={lanes} />);
  return { view, onOpenMember, onShowAll, onLog, onChat, rerender: (models: LaneCardViewModel[]) => view.rerender(<Driver models={models} />) };
}

function overflowModels() {
  const source = progressCase('active_progress').frame;
  const members = Array.from({ length: 32 }, (_, index) => ({
    ...source.lanes[0].members[index % source.lanes[0].members.length],
    spec_id: `spec-derived-${index + 1}`, title: `Paper span ${index + 1}`,
  }));
  const frame = { ...source, counts: { open: 9, active: 9, paused: 0, blocked: 0 },
    lanes: Array.from({ length: 9 }, (_, index) => ({ ...source.lanes[0],
      lane_id: `wl-derived-${index + 1}`, title: `Bridge collection ${index + 1}`,
      members: members.slice(0, 8), members_total: 32, items_total: 32, items_open: 16, items_completed: 16,
    })),
  };
  return { lanes: modelsFor(frame), members };
}

test('uses the shared model in daemon order and the supplied assistant identity at the center', () => {
  const models = modelsFor(fixture.inventory_frame);
  const { view } = surface(models);
  expect(view.getByTestId('lanes-map-assistant').props.accessibilityLabel).toBe('Orbit Guide');
  expect(view.getByTestId('lanes-map-members-pending')).toBeTruthy();
  expect(view.getAllByTestId(/^lanes-map-lane-/).map((node) => node.props.testID))
    .toEqual(models.map((model) => `lanes-map-lane-${model.lane.lane_id}`));
  for (const model of models) {
    const node = view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`);
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityState.selected).toBe(false);
    expect(node.props.accessibilityLabel).toBe(`${model.lane.title}, ${model.stateLabel}, —/—`);
  }
});

test.each<string>(fixture.progress_v2.map((entry: { name: string }) => entry.name))('renders shared progress case %s when focused', (name) => {
  const model = modelFor(name);
  const { view } = surface([model], model.lane.lane_id);
  expect(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`).props.accessibilityState.selected).toBe(true);
  expect(view.getByTestId(`lanes-map-progress-${model.lane.lane_id}`).props.children).toBe(model.progressLabel);
  expect(view.getByText(model.stateLabel)).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-member-/).map((node) => node.props.testID))
    .toEqual(model.members.map((member) => `lanes-map-member-${member.spec_id}`));
  expect(view.queryByTestId(`lanes-map-more-${model.lane.lane_id}`)).toBeNull();
});

test('focus, member detail, log and chat controls pass the same selected model and back restores the orbit', () => {
  const model = modelFor();
  const { view, onOpenMember, onLog, onChat } = surface([model]);
  fireEvent.press(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`));
  expect(view.queryByTestId('lanes-map-assistant')).toBeNull();
  const member = model.members[0];
  const node = view.getByTestId(`lanes-map-member-${member.spec_id}`);
  expect(node.props.accessibilityLabel).toBe(`${member.title}, in progress`);
  expect(node.props.accessibilityState.selected).toBe(false);
  fireEvent.press(node);
  expect(onOpenMember).toHaveBeenCalledWith(model, member);
  fireEvent.press(view.getByTestId(`lanes-map-log-${model.lane.lane_id}`));
  fireEvent.press(view.getByTestId(`lanes-map-chat-${model.lane.lane_id}`));
  expect(onLog).toHaveBeenCalledWith(model);
  expect(onChat).toHaveBeenCalledWith(model);
  fireEvent.press(view.getByTestId('lanes-map-back'));
  expect(view.getByTestId('lanes-map-assistant')).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-member-/)).toHaveLength(0);
});

test('all nine lanes and all thirty-two members are reachable in order through the actual shared member list', async () => {
  const { lanes, members } = overflowModels();
  const readShow = jest.fn(async (laneId: string): Promise<WorkLaneShow> => ({
    lane_id: laneId, projection: lanes.find((model) => model.lane.lane_id === laneId)!.lane,
    members, updates: [], events: [], spec_changes: [],
  }));
  function Journey() {
    const [focus, setFocus] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [all, setAll] = useState<LaneCardViewModel | null>(null);
    const [member, setMember] = useState<WorkLaneMember | null>(null);
    if (member) return <LaneMemberDetail member={member} laneTitle="Bridge collection" onBack={() => setMember(null)} />;
    if (all) return <LaneMembers model={all} connected onBack={() => setAll(null)} onOpenMember={setMember} readShow={readShow} />;
    return <LanesMap lanes={lanes} assistantName="Orbit Guide" focusedLaneId={focus} onFocusLane={setFocus}
      page={page} onPageChange={setPage} onOpenMember={(_, selected) => setMember(selected)} onShowAll={setAll}
      onLog={() => undefined} onChat={() => undefined} />;
  }
  const view = render(<Journey />);
  expect(view.getByTestId('lanes-map-page-label').props.children).toEqual([1, '/', 2]);
  expect(view.getByTestId('lanes-map-page-prev').props.accessibilityState.disabled).toBe(true);
  expect(view.getAllByTestId(/^lanes-map-lane-/).map((node) => node.props.testID))
    .toEqual(lanes.slice(0, 8).map((model) => `lanes-map-lane-${model.lane.lane_id}`));
  for (let index = 0; index < lanes.length; index += 1) {
    const model = lanes[index];
    if (index === 8) fireEvent.press(view.getByTestId('lanes-map-page-next'));
    expect(view.getByTestId('lanes-map-page-label').props.children).toEqual([index === 8 ? 2 : 1, '/', 2]);
    fireEvent.press(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`));
    expect(view.getAllByTestId(/^lanes-map-member-/).map((node) => node.props.testID))
      .toEqual(members.slice(0, 8).map((member) => `lanes-map-member-${member.spec_id}`));
    const more = view.getByTestId(`lanes-map-more-${model.lane.lane_id}`);
    expect(more.props.accessibilityLabel).toBe('Show all 32 specs');
    expect(view.getByText('+24 more')).toBeTruthy();
    expect(view.getAllByTestId(/^lanes-map-(?:member-|more-)/)).toHaveLength(9);
    fireEvent.press(more);
    await waitFor(() => expect(view.getAllByTestId(/^lane-members-row-/)).toHaveLength(32));
    expect(view.getAllByTestId(/^lane-members-row-/).map((node) => node.props.testID))
      .toEqual(members.map((member) => `lane-members-row-${member.spec_id}`));
    fireEvent.press(view.getByTestId(`lane-members-row-${members[31].spec_id}`));
    expect(view.getByTestId(`member-detail-${members[31].spec_id}`)).toBeTruthy();
    fireEvent.press(view.getByTestId('member-detail-back'));
    fireEvent.press(view.getByTestId('lane-members-back'));
    expect(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`).props.accessibilityState.selected).toBe(true);
    fireEvent.press(view.getByTestId('lanes-map-back'));
  }
  expect(view.getByTestId('lanes-map-page-next').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(view.getByTestId('lanes-map-page-prev'));
  expect(view.getAllByTestId(/^lanes-map-lane-/)).toHaveLength(8);
  expect(new Set(readShow.mock.calls.map(([laneId]) => laneId))).toEqual(new Set(lanes.map((model) => model.lane.lane_id)));
});

test.each([0, 2, 8, 9, 32])('renders at most eight inline members and overflow only when total %i is greater than eight', (total) => {
  const { members } = overflowModels();
  const source = progressCase('active_progress').frame;
  const lanes = modelsFor({ ...source, lanes: [{ ...source.lanes[0], members: members.slice(0, Math.min(8, total)), members_total: total }] });
  const model = lanes[0];
  const { view, onShowAll } = surface(lanes, model.lane.lane_id);
  expect(view.queryAllByTestId(/^lanes-map-member-/)).toHaveLength(Math.min(8, total));
  const more = view.queryByTestId(`lanes-map-more-${model.lane.lane_id}`);
  if (total > 8) {
    expect(more).toBeTruthy();
    fireEvent.press(more!);
    expect(onShowAll).toHaveBeenCalledWith(model);
  } else expect(more).toBeNull();
});

test('a no-spec reason suppresses members and overflow even if contradictory optional member fields arrive', () => {
  const source = progressCase('active_progress').frame;
  const lanes = modelsFor({ ...source, lanes: [{ ...source.lanes[0], no_spec_reason: 'Planning the next collection', members_total: 32 }] });
  const { view } = surface(lanes, lanes[0].lane.lane_id);
  expect(view.getByText('Planning the next collection')).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-(?:member-|more-)/)).toHaveLength(0);
  expect(view.queryByText('Specs arrive when the daemon updates')).toBeNull();
});

test('v1 upgrades in place to increment one without losing the selected lane or requiring a remount', () => {
  const v1 = modelsFor(fixture.inventory_frame);
  const focusedId = v1[1].lane.lane_id;
  const { view, rerender } = surface(v1, focusedId);
  expect(view.getByTestId(`lanes-map-members-pending-${focusedId}`)).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-member-/)).toHaveLength(0);
  const source = progressCase('active_progress').frame;
  const next = modelsFor({ ...source, lanes: [{ ...source.lanes[0], lane_id: focusedId }] });
  rerender(next);
  expect(view.queryByTestId(`lanes-map-members-pending-${focusedId}`)).toBeNull();
  expect(view.getByTestId(`lanes-map-lane-${focusedId}`).props.accessibilityState.selected).toBe(true);
  expect(view.getAllByTestId(/^lanes-map-member-/)).toHaveLength(2);
});

test.each([1, 2, 3])('width 320 and font scale %i leave all target rectangles disjoint and at least 44 points', (fontScale) => {
  const dimensions = require('react-native/Libraries/Utilities/useWindowDimensions');
  const spy = jest.spyOn(dimensions, 'default').mockReturnValue({ width: 320, height: 640, scale: 1, fontScale });
  try {
    const { lanes } = overflowModels();
    const { view } = surface(lanes);
    fireEvent(view.getByTestId('lanes-map'), 'layout', { nativeEvent: { layout: { width: 320, height: 640, x: 0, y: 0 } } });
    const assertGeometry = (ids: RegExp) => {
      const targets = view.getAllByTestId(ids);
      const boxes = targets.map((target) => StyleSheet.flatten(target.props.style));
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.height).toBe(52 + 22 + 44 * fontScale);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(320 - 24 + 0.001);
      }
      for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) {
        const first = boxes[a];
        const second = boxes[b];
        const separate = first.left + first.width <= second.left || second.left + second.width <= first.left
          || first.top + first.height <= second.top || second.top + second.height <= first.top;
        expect(separate).toBe(true);
      }
    };
    assertGeometry(/^lanes-map-(?:lane-|assistant$)/);
    fireEvent.press(view.getByTestId(`lanes-map-lane-${lanes[0].lane.lane_id}`));
    assertGeometry(/^lanes-map-(?:lane-|member-)/);
    for (const id of ['lanes-map-back', `lanes-map-more-${lanes[0].lane.lane_id}`, `lanes-map-log-${lanes[0].lane.lane_id}`, `lanes-map-chat-${lanes[0].lane.lane_id}`]) {
      expect(StyleSheet.flatten(view.getByTestId(id).props.style).minHeight).toBeGreaterThanOrEqual(44);
    }
  } finally { spy.mockRestore(); }
});

test('working markers require active working leads and waiting-on-you uses the shared model count', () => {
  const source = progressCase('active_progress').frame;
  const base = source.lanes[0];
  const lanes = modelsFor({ ...source, lanes: ['active', 'blocked', 'paused'].map((state) => ({ ...base,
    lane_id: `wl-presence-${state}`, state, lead: { ...base.lead, presence: { ...base.lead.presence, working: true } },
  })) });
  const model = { ...lanes[0], waitingOnYou: 3, waitingOnYouLabel: 'Waiting on you · 3 questions', blockerLabel: 'Waiting on you · 3 questions' };
  const { view } = surface([model, ...lanes.slice(1)]);
  expect(view.getByTestId(`lanes-map-working-${model.lane.lane_id}`)).toBeTruthy();
  expect(view.queryByTestId('lanes-map-working-wl-presence-blocked')).toBeNull();
  expect(view.queryByTestId('lanes-map-working-wl-presence-paused')).toBeNull();
  expect(view.getByTestId(`lanes-map-waiting-${model.lane.lane_id}`)).toBeTruthy();
  expect(view.getByTestId(`lanes-map-waiting-${model.lane.lane_id}`).props.children).toEqual(['?', 3]);
  fireEvent.press(view.getByTestId(`lanes-map-lane-${model.lane.lane_id}`));
  expect(view.getByText('Waiting on you · 3 questions')).toBeTruthy();
});

test.each(['active', 'blocked', 'paused'])('spec node status colors stay distinct in a %s lane', (state) => {
  const source = progressCase('active_progress').frame;
  const memberSource = source.lanes[0].members[0];
  const colors = {
    completed: Tokens.palette.green,
    in_progress: state === 'blocked' ? Tokens.palette.amber : state === 'paused' ? Tokens.palette.muted : Tokens.palette.green,
    needs_qa: Tokens.palette.text,
    ready_for_dev: Tokens.palette.dim,
    analysis: Tokens.palette.dim,
    backlog: Tokens.palette.muted,
    deprecated: Tokens.palette.muted,
    missing: Tokens.palette.red,
    ambiguous: Tokens.palette.red,
  };
  for (const [status, color] of Object.entries(colors)) {
    const model = modelsFor({ ...source, lanes: [{ ...source.lanes[0], state,
      members: [{ ...memberSource, status, terminal: status === 'completed' || status === 'deprecated' ? status : null }], members_total: 1,
    }] })[0];
    const { view } = surface([model], model.lane.lane_id);
    const node = view.getByTestId(`lanes-map-member-${memberSource.spec_id}`);
    const ring = node.findAll((child) => StyleSheet.flatten(child.props.style)?.borderWidth === 2)[0];
    expect(StyleSheet.flatten(ring.props.style).borderColor).toBe(color);
    view.unmount();
  }
});

test.each(['missing', 'ambiguous'])('unresolved %s observation stays red even when the reported status is completed or working', (quality) => {
  const source = progressCase('active_progress').frame;
  const memberSource = source.lanes[0].members[0];
  for (const state of ['active', 'blocked', 'paused']) {
    const model = modelsFor({ ...source, lanes: [{ ...source.lanes[0], state,
      members: ['completed', 'in_progress'].map((status) => ({ ...memberSource, spec_id: `spec-quality-${status}`, status,
        observation: { ...memberSource.observation, quality },
      })), members_total: 2,
    }] })[0];
    const { view } = surface([model], model.lane.lane_id);
    for (const member of model.members) {
      const node = view.getByTestId(`lanes-map-member-${member.spec_id}`);
      const ring = node.findAll((child) => StyleSheet.flatten(child.props.style)?.borderWidth === 2)[0];
      expect(StyleSheet.flatten(ring.props.style).borderColor).toBe(Tokens.palette.red);
    }
    view.unmount();
  }
});

test('unavailable chats remain explicit and disabled while historical chats retain their own navigation', () => {
  const v1 = modelsFor(fixture.inventory_frame);
  const unavailable = v1.find((model) => model.tap.action === 'unavailable')!;
  const { view, onChat } = surface([unavailable], unavailable.lane.lane_id);
  const chat = view.getByTestId(`lanes-map-chat-${unavailable.lane.lane_id}`);
  expect(chat.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(chat);
  expect(onChat).not.toHaveBeenCalled();
  expect(view.getByText('Chat unavailable')).toBeTruthy();
  view.unmount();
  const historical = v1.find((model) => model.tap.action === 'history')!;
  const history = surface([historical], historical.lane.lane_id);
  fireEvent.press(history.view.getByTestId(`lanes-map-chat-${historical.lane.lane_id}`));
  expect(history.onChat).toHaveBeenCalledWith(historical);
});

test('an inventory replacement clamps the page and exits focus when its lane disappears', () => {
  const { lanes } = overflowModels();
  const { view, rerender } = surface(lanes, lanes[8].lane.lane_id, 1);
  rerender(lanes.slice(0, 1));
  expect(view.getByTestId('lanes-map-assistant')).toBeTruthy();
  expect(view.getByTestId('lanes-map-page-label').props.children).toEqual([1, '/', 1]);
  expect(view.queryByTestId('lanes-map-back')).toBeNull();
});

test('empty projections have an honest empty state and disabled paging', () => {
  const { view } = surface([]);
  expect(view.getByText('No open lanes')).toBeTruthy();
  expect(view.queryAllByTestId(/^lanes-map-lane-/)).toHaveLength(0);
  expect(view.getByTestId('lanes-map-page-prev').props.accessibilityState.disabled).toBe(true);
  expect(view.getByTestId('lanes-map-page-next').props.accessibilityState.disabled).toBe(true);
});

test('map telemetry passes only identifiers and counts to the harness-only transport', () => {
  const { lanes } = overflowModels();
  const { view } = surface(lanes);
  expect(emitHarnessUiTrace).toHaveBeenLastCalledWith('work_lanes_map_render', {
    page: 1, page_count: 2, lane_nodes: 8, focused_lane_id: null, member_nodes: 0, more_count: 0,
  });
  fireEvent.press(view.getByTestId(`lanes-map-lane-${lanes[0].lane.lane_id}`));
  expect(emitHarnessUiTrace).toHaveBeenLastCalledWith('work_lanes_map_render', {
    page: 1, page_count: 2, lane_nodes: 1, focused_lane_id: lanes[0].lane.lane_id, member_nodes: 9, more_count: 24,
  });
  expect(JSON.stringify((emitHarnessUiTrace as jest.Mock).mock.calls)).not.toContain(lanes[0].lane.title);
  expect(JSON.stringify((emitHarnessUiTrace as jest.Mock).mock.calls)).not.toContain(lanes[0].members[0].title);
});
