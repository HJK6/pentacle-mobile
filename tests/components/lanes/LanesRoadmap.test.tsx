jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('../../../src/services/pentacleStream', () => ({ requestWorkLaneShow: jest.fn(), selectOptimisticQuestionAnswerIdentities: () => [] }));
jest.mock('../../../src/components/voice/HeaderVoiceMic', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../src/services/voicePresentation', () => ({ useVoiceSurface: jest.fn() }));
jest.mock('../../../src/components/questions/QuestionDeckCard', () => {
  const React = require('react'); const { Text } = require('react-native');
  return function Question({ laneId, laneStreams }: { laneId?: string; laneStreams?: string[] }) {
    return <Text testID={`lane-question-${laneId}`}>Question for {laneId} via {laneStreams?.join(',')}</Text>;
  };
});
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { AccessibilityInfo, ScrollView } from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, type WorkLanesInventory } from 'pentacle-chat-core';
import LanesOverlay from '../../../src/components/lanes/LanesOverlay';
import { selectLaneCardViewModels } from '../../../src/services/workLanes';
import { lanesRoadmapFixture, type RoadmapVariant } from '../../../src/harness/lanesRoadmapFixture';

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const hidden = { includeHiddenElements: true };
function setup(variant: RoadmapVariant = 'views', { reduce = true, edit, rejectDetail = false }: { reduce?: boolean; edit?(inventory: WorkLanesInventory, shows: ReturnType<typeof lanesRoadmapFixture>['shows']): void; rejectDetail?: boolean } = {}) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduce);
  const fixture = lanesRoadmapFixture(variant, Date.parse('2026-11-14T18:00:00Z'));
  edit?.(fixture.inventory, fixture.shows);
  const models = (inventory: WorkLanesInventory) => selectLaneCardViewModels(applyWorkLanesInventory(initialPentacleStreamState, inventory));
  const readShow = jest.fn(async (id: string) => { if (rejectDetail) throw new Error('network failure'); return fixture.shows[id]; });
  const props = { inventory: null, assistantName: 'Assistant', connected: true, updates: [], top: 0, bottom: 0, onChat: jest.fn(), onClose: jest.fn(), readShow };
  const view = render(<LanesOverlay lanes={models(fixture.inventory)} {...props} />);
  const rerender = (inventory: WorkLanesInventory) => view.rerender(<LanesOverlay lanes={models(inventory)} {...props} />);
  return { ...view, fixture, readShow, rerender };
}
const lane = (n: number, variant = 'views') => `road-lane-${variant}-${n}`;
const settle = () => act(async () => {});

test('home cards: the question button expands the shipped question card in place, one at a time', async () => {
  const view = setup();
  await settle();
  const buttons = view.queryAllByTestId(/^lane-question-button-/).map(b => b.props.testID);
  expect(buttons).toEqual([`lane-question-button-${lane(2)}`, `lane-question-button-${lane(4)}`]);
  fireEvent.press(view.getByTestId(`lane-question-button-${lane(2)}`));
  await settle();
  expect(within(view.getByTestId(`lane-question-expanded-${lane(2)}`)).getByTestId(`lane-question-${lane(2)}`)).toBeTruthy();
  expect(view.readShow.mock.calls.filter(([id]) => id === lane(2))).toHaveLength(1);
  expect(view.getByTestId(`lane-question-${lane(2)}`)).toHaveTextContent(/hosta:road-lead-views-2/);
  fireEvent.press(view.getByTestId(`lane-question-button-${lane(4)}`));
  await settle();
  expect(view.queryByTestId(`lane-question-expanded-${lane(2)}`)).toBeNull();
  expect(view.getByTestId(`lane-question-expanded-${lane(4)}`)).toBeTruthy();
  fireEvent.press(view.getByTestId(`lane-question-button-${lane(4)}`));
  expect(view.queryByTestId(`lane-question-expanded-${lane(4)}`)).toBeNull();
  fireEvent.press(view.getByTestId(`lane-question-button-${lane(2)}`));
  await settle();
  // Answering the last question clears the lane's signal: the card collapses and the button goes.
  const answered = structuredClone(view.fixture.inventory);
  for (const m of answered.lanes[1].members ?? []) m.open_questions = { count: 0, first_question_id: null };
  view.rerender(answered);
  await settle();
  expect(view.queryByTestId(`lane-question-expanded-${lane(2)}`)).toBeNull();
  expect(view.queryByTestId(`lane-question-button-${lane(2)}`)).toBeNull();
  fireEvent.press(view.getByTestId(`lane-row-${lane(4)}`));
  await settle();
  expect(view.getByTestId('readable-lane')).toBeTruthy();
}, 15_000);

test('lane screen: the question card sits between the header and the first stop', async () => {
  const view = setup();
  fireEvent.press(view.getByTestId(`lane-row-${lane(2)}`));
  await settle();
  const screen = view.getByTestId('readable-lane');
  const order = within(screen).queryAllByTestId(/^(lane-question-|lane-road$)/).map(n => n.props.testID);
  expect(order).toEqual([`lane-question-${lane(2)}`, 'lane-road']);
  expect(view.getByTestId('stop-word-g_road_views_2_1')).toHaveTextContent('needs you');
}, 15_000);

test('road: lead goals expand, stop words follow the rules, numbers skip done goals', async () => {
  const view = setup();
  fireEvent.press(view.getByTestId(`lane-row-${lane(1)}`));
  await settle();
  const word = (g: number) => view.getByTestId(`stop-word-g_road_views_1_${g}`).props.children;
  expect([1, 2].map(word)).toEqual([expect.stringMatching(/^done [A-Z][a-z]{2} \d+$/), expect.stringMatching(/^done [A-Z][a-z]{2} \d+$/)]);
  expect(word(3)).toMatch(/^(now|\d+[mhd])$/);
  expect([5, 6, 7, 8].map(word)).toEqual(['2 blocked · 1/4', 'no items yet', 'later · 0/3', 'later · 0/2']);
  expect(view.getByTestId('stop-tail-g_road_views_1_3')).toHaveTextContent('+1 more · 2 next up · 2 later');
  expect(view.queryByTestId('stop-tail-g_road_views_1_5')).toBeNull();
  expect(view.getByTestId('goal-ring-g_road_views_1_5-hatch')).toBeTruthy();
  expect(view.getByTestId('road-rail-g_road_views_1_3-live')).toBeTruthy();
}, 15_000);

test('home: sections, counts, lines and dots follow the spec; no word "working", no needs-you, no blocked count', async () => {
  const view = setup();
  await settle();
  const sections = view.queryAllByTestId(/^readable-section-/).map(n => n.props.children[0]);
  expect(sections).toEqual(['Working now', 'In progress', 'Idle', 'Paused']);
  expect(view.queryByText(/Stalled/)).toBeNull();
  const lines = view.queryAllByTestId(/^lane-goal-line-/);
  expect(lines.length).toBeGreaterThan(8);
  for (const line of lines) expect(within(line).queryAllByText(/working|needs you|\d+ blocked/i)).toHaveLength(0);
  expect(view.getByTestId(`lane-goal-line-${lane(9)}-g_road_views_9_1`)).toHaveTextContent(/blocked · 0\/2$/);
  expect(view.getByTestId(`lane-dots-${lane(1)}-4-blocked`)).toBeTruthy();
  expect(view.queryAllByTestId(new RegExp(`^lane-dots-${lane(1)}-\\d+-`))).toHaveLength(10);
  expect(view.getByTestId(`lane-goal-line-${lane(1)}-g_road_views_1_3`)).toBeTruthy();
}, 15_000);

test('more goals than the frame sends: detail fills all dots and the omitted in-progress goal', async () => {
  const view = setup('overflow');
  await settle();
  const id = lane(1, 'overflow');
  expect(view.queryAllByTestId(new RegExp(`^lane-dots-${id}-\\d+-`))).toHaveLength(11);
  expect(view.queryByText('+3')).toBeNull();
  expect(view.queryByText('+1 more in progress')).toBeNull();
  expect(view.getByTestId('readable-section-in-progress')).toBeTruthy();
}, 15_000);

test('parked: off the map and the sections, behind the button with reason and date; muted lane shows the reason', async () => {
  const view = setup();
  await settle();
  for (const n of [21, 22]) {
    expect(view.queryByTestId(`lane-row-${lane(n)}`)).toBeNull();
    expect(view.queryByTestId(`lanes-map-lane-${lane(n)}`)).toBeNull();
  }
  expect(view.getByText('1 working · 6 in progress · 13 quiet')).toBeTruthy();
  fireEvent.press(view.getByTestId('parked-button'));
  await settle();
  expect(view.getByText('2 lanes on hold')).toBeTruthy();
  expect(view.getByText('Waiting for the new lens to arrive.')).toBeTruthy();
  expect(view.getByText(/^parked Nov 1 · 2 goals · 5 items$/)).toBeTruthy();
  expect(view.getByText(/^1 goal · 2 items$/)).toBeTruthy();
  fireEvent.press(view.getByTestId(`parked-lane-${lane(21)}`));
  await settle();
  expect(view.getByTestId('lane-parked-reason')).toHaveTextContent('Waiting for the new lens to arrive.');
}, 15_000);

test('without a parked key there is no Parked button; malformed keys never reject a lane', async () => {
  const plain = setup('views', { edit: inventory => { for (const l of inventory.lanes) delete (l as { parked?: unknown }).parked; } });
  await settle();
  expect(plain.queryByTestId('parked-button')).toBeNull();
  expect(plain.queryAllByTestId(/^lane-row-/)).toHaveLength(22);
  plain.unmount();
  const malformed = setup('malformed');
  await settle();
  expect(malformed.queryAllByTestId(/^lane-row-/)).toHaveLength(2);
  expect(malformed.queryByTestId('parked-button')).toBeNull();
}, 15_000);

test('reachability: every member of a lane with members under no goal opens in three taps and appears once', async () => {
  for (const variant of ['loose', 'loose_done'] as const) {
    const view = setup(variant);
    const id = lane(1, variant), members = view.fixture.shows[id].members;
    const reached = new Map<string, string>();
    fireEvent.press(view.getByTestId(`lane-row-${id}`));
    await settle();
    const heads = view.queryAllByTestId(/^goal-head-/).map(n => n.props.testID as string);
    if (variant === 'loose') expect(heads.at(-1)).toBe('goal-head-default');
    else {
      expect(heads).not.toContain('goal-head-default');
      const loose = new Set(members.filter(m => !m.goal_id).map(m => `spec-row-${m.spec_id}`));
      expect(view.queryAllByTestId(/^spec-row-/).filter(row => loose.has(row.props.testID))).toHaveLength(0);
      fireEvent.press(view.getByTestId('finished-earlier-open'));
      fireEvent.press(view.getByTestId('finished-earlier-more'));
      for (const row of view.queryAllByTestId(/^spec-row-/)) if (loose.has(row.props.testID)) reached.set(row.props.testID, 'finished');
    }
    for (const head of heads) {
      fireEvent.press(view.getByTestId(head));
      await settle();
      for (const fold of view.queryAllByTestId(/^goal-.*-(open|more)$/)) fireEvent.press(fold);
      for (const row of view.queryAllByTestId(/^spec-row-/)) {
        expect(reached.has(row.props.testID)).toBe(false);
        reached.set(row.props.testID, head);
      }
      fireEvent.press(view.getByTestId('lanes-back'));
    }
    expect([...reached.keys()].sort()).toEqual(members.map(m => `spec-row-${m.spec_id}`).sort());
    view.unmount();
  }
}, 15_000);

test('every Show N more and Show N finished opens in place and every item row opens its item', async () => {
  const view = setup();
  fireEvent.press(view.getByTestId(`lane-row-${lane(1)}`));
  await settle();
  fireEvent.press(view.getByTestId('goal-head-g_road_views_1_3'));
  await settle();
  expect(view.queryByTestId('spec-row-spec_road__views_1_17')).toBeNull();
  fireEvent.press(view.getByTestId('goal-done-open'));
  expect(view.getByTestId('spec-row-spec_road__views_1_17')).toBeTruthy();
  fireEvent.press(view.getByTestId('spec-row-spec_road__views_1_17'));
  await settle();
  expect(view.getByTestId('readable-spec')).toBeTruthy();
  fireEvent.press(view.getByTestId('lanes-back'));
  for (const row of view.queryAllByTestId(/^spec-row-/)) {
    fireEvent.press(row);
    expect(view.getByTestId('readable-spec')).toBeTruthy();
    fireEvent.press(view.getByTestId('lanes-back'));
  }
}, 15_000);

test('older daemon without class letters still renders the road with fallback classes', async () => {
  const view = setup('no_classes');
  await settle();
  expect(view.getByTestId('readable-section-in-progress')).toBeTruthy();
  fireEvent.press(view.getByTestId(`lane-row-${lane(1, 'no_classes')}`));
  await settle();
  expect(view.getByTestId('stop-word-g_road_no_classes_1_2')).toHaveTextContent('next · 0/2');
}, 15_000);

test('motion: only the named loops run on each screen, never under the top, never with reduce motion', async () => {
  const loops = (v: ReturnType<typeof setup>) => v.queryAllByTestId(/^(working-spoke|motion-spark|motion-rail|item-mark-.*-pulse)/, hidden)
    .map(n => String(n.props.testID).replace(/^(working-spoke|motion-spark|motion-rail|item-mark).*?(-pulse)?$/, '$1$2')).sort();
  const view = setup('views', { reduce: false });
  await settle();
  expect([...new Set(loops(view))]).toEqual(['motion-spark', 'working-spoke']);
  fireEvent.press(view.getByTestId(`lane-row-${lane(1)}`));
  await settle();
  await act(async () => { jest.advanceTimersByTime?.(0); await new Promise(r => setTimeout(r, 600)); });
  expect([...new Set(loops(view))]).toEqual(['item-mark-pulse', 'motion-rail']);
  fireEvent.press(view.getByTestId('goal-head-g_road_views_1_3'));
  await act(async () => { await new Promise(r => setTimeout(r, 600)); });
  expect([...new Set(loops(view))]).toEqual(['item-mark-pulse', 'motion-spark']);
  fireEvent.press(view.getByTestId('spec-row-spec_road__views_1_14'));
  await act(async () => { await new Promise(r => setTimeout(r, 600)); });
  expect(loops(view)).toEqual([]);
  view.unmount();
  const still = setup('views', { reduce: true });
  await settle();
  expect(loops(still)).toEqual([]);
  fireEvent.press(still.getByTestId(`lane-row-${lane(1)}`));
  await settle();
  expect(loops(still)).toEqual([]);
  expect(still.queryByTestId('lanes-layer-under', hidden)).toBeNull();
  fireEvent.press(still.getByTestId('lanes-back'));
  expect(still.queryByTestId('lanes-layer-over', hidden)).toBeNull();
  expect(still.getByTestId('readable-home')).toBeTruthy();
}, 15_000);

test('fast taps: interleaved opens and backs during transitions leave exactly one interactive top screen', async () => {
  jest.useFakeTimers();
  const view = setup('views', { reduce: false });
  await act(async () => { await Promise.resolve(); });
  fireEvent.press(view.getByTestId(`lane-row-${lane(1)}`));
  expect(view.getByTestId('lanes-layer-under', hidden)).toBeTruthy();
  fireEvent.press(view.getByTestId('lanes-back'));
  fireEvent.press(view.getByTestId(`lane-row-${lane(1)}`));
  await act(async () => { await Promise.resolve(); });
  fireEvent.press(view.getByTestId('goal-head-g_road_views_1_3'));
  fireEvent.press(view.getByTestId('spec-row-spec_road__views_1_14'));
  fireEvent.press(view.getByTestId('lanes-back'));
  fireEvent.press(view.getByTestId('spec-row-spec_road__views_1_15'));
  fireEvent.press(view.getByTestId('lanes-back'));
  fireEvent.press(view.getByTestId('lanes-back'));
  fireEvent.press(view.getByTestId('goal-head-g_road_views_1_4'));
  await act(async () => { jest.runAllTimers(); });
  expect(view.queryAllByTestId('lanes-layer-top', hidden)).toHaveLength(1);
  expect(view.queryAllByTestId(/^lanes-layer-(under|over)$/, hidden)).toHaveLength(0);
  expect(view.getByTestId('readable-goal')).toBeTruthy();
  expect(view.getByTestId('readable-header-title')).toHaveTextContent('Question cards on home');
  fireEvent.press(view.getByTestId('lanes-back'));
  await act(async () => { jest.runAllTimers(); });
  expect(view.getByTestId('readable-lane')).toBeTruthy();
  fireEvent.press(view.getByTestId('lanes-back'));
  await act(async () => { jest.runAllTimers(); });
  expect(view.getByTestId('readable-home')).toBeTruthy();
  expect(view.queryByTestId('lanes-back')).toBeNull();
}, 15_000);

test('no lanes component references the amber token', () => {
  const dir = path.join(__dirname, '../../../src/components/lanes');
  for (const file of fs.readdirSync(dir)) expect([file, /\bamber\b/.test(fs.readFileSync(path.join(dir, file), 'utf8'))]).toEqual([file, false]);
});

test('hero: the tapped lane icon flies into the lane header from a card, the map and the Parked list', async () => {
  const MockNativeMethods = jest.requireActual('react-native/jest/MockNativeMethods').default;
  const measure = MockNativeMethods.measureInWindow as jest.Mock;
  measure.mockImplementation((done: (x: number, y: number, w: number, h: number) => void) => done(30, 300, 36, 36));
  try {
    const view = setup('views', { reduce: false });
    await settle();
    const flies = async (tap: string) => {
      fireEvent.press(view.getByTestId(tap));
      await settle();
      expect(view.queryByTestId('lanes-hero-flight')).toBeNull();
      fireEvent(within(view.getByTestId('lanes-layer-top')).getByTestId('lanes-header-hero'), 'layout', { nativeEvent: { layout: { x: 60, y: 8, width: 34, height: 34 } } });
      expect(view.getByTestId('lanes-hero-flight')).toBeTruthy();
    };
    await flies(`lane-row-${lane(1)}`);
    fireEvent.press(within(view.getByTestId('lanes-layer-top')).getByTestId('lanes-back'));
    await flies(`lanes-map-lane-${lane(2)}`);
    fireEvent.press(within(view.getByTestId('lanes-layer-top')).getByTestId('lanes-back'));
    fireEvent.press(view.getByTestId('parked-button'));
    await settle();
    await flies(`parked-lane-${lane(21)}`);
    await act(async () => { await new Promise(r => setTimeout(r, 600)); });
    view.unmount();
  } finally { measure.mockReset(); }
}, 15_000);

test('dots: next is a grey ring and later a faint dotted ring; a bar label never shrinks', async () => {
  const view = setup();
  await settle();
  const circle = (id: RegExp) => view.UNSAFE_root.findAll(n => typeof n.props.testID === 'string' && id.test(n.props.testID))[0]
    .findAll(n => n.props.r != null && n.props.stroke != null)[0].props;
  expect(circle(/^lane-dots-.*-next$/).stroke).toBe('#7fa896');
  expect(circle(/^lane-dots-.*-later$/)).toMatchObject({ stroke: '#557567', strokeDasharray: '1.4 2' });
  fireEvent.press(view.getByTestId(`lane-row-${lane(1)}`));
  await settle();
  fireEvent.press(view.getByTestId('goal-head-g_road_views_1_5'));
  await settle();
  const style = [view.getByTestId('goal-bar-label').props.style].flat();
  expect(Object.assign({}, ...style)).toMatchObject({ flexShrink: 0 });
}, 15_000);

test('the question button is also an accessibility action on its lane row', async () => {
  const view = setup();
  await settle();
  const row = view.getByTestId(`lane-row-${lane(2)}`);
  expect(row.props.accessibilityActions).toEqual([{ name: 'question', label: 'Show question' }]);
  expect(view.getByTestId(`lane-row-${lane(3)}`).props.accessibilityActions).toBeUndefined();
  fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'question' } });
  await settle();
  expect(view.getByTestId(`lane-question-expanded-${lane(2)}`)).toBeTruthy();
  expect(view.getByTestId(`lane-row-${lane(2)}`).props.accessibilityActions).toEqual([{ name: 'question', label: 'Hide question' }]);
}, 15_000);

test('hatch patterns draw their own diagonal instead of rotating the tile', () => {
  // iOS clips a rotated pattern tile to its unrotated bounds, which turned the stripes into triangles.
  const src = fs.readFileSync(path.join(__dirname, '../../../src/components/lanes/RoadMarks.tsx'), 'utf8');
  expect(src).not.toMatch(/patternTransform/);
});


test('map: every non-parked lane is named on the map or counted in exactly one +N', async () => {
  const view = setup();
  await settle();
  const graph = within(view.getByTestId('lanes-constellation'));
  const named = graph.queryAllByTestId(/^lanes-map-lane-/).map(n => String(n.props.testID).replace('lanes-map-lane-', ''));
  const counted = [graph.queryByTestId('lanes-map-more'), graph.queryByTestId('lanes-map-more-busy')].filter(Boolean)
    .reduce((sum, n) => sum + Number(/^(\d+) more lanes$/.exec(n!.props.accessibilityLabel)![1]), 0);
  const open = view.fixture.inventory.lanes.filter(l => !l.parked);
  expect(new Set(named).size).toBe(named.length);
  expect(named.length + counted).toBe(open.length);
  for (const id of named) expect(within(graph.getByTestId(`lanes-map-label-${id}`)).getByText(open.find(l => l.lane_id === id)!.title)).toBeTruthy();
}, 15_000);

test('real mix: two busy lanes inside and all nine quiet lanes named on one outer circle, no +N', async () => {
  const view = setup('map_real');
  await settle();
  const graph = within(view.getByTestId('lanes-constellation')), id = (n: number) => lane(n, 'map_real');
  expect(graph.getByTestId('lanes-map-outer-circle')).toBeTruthy();
  expect(graph.queryByTestId('lanes-map-more')).toBeNull();
  expect(graph.queryByTestId('lanes-map-more-busy')).toBeNull();
  // Inner lanes carry the age line; outer lanes carry the name only, and their label is the lane title.
  for (const n of [2, 3]) expect(graph.getByTestId(`lanes-map-label-${id(n)}`)).toHaveTextContent(/ago$/);
  for (const n of [1, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const title = view.fixture.inventory.lanes[n - 1].title;
    expect(graph.getByTestId(`lanes-map-label-${id(n)}`)).toHaveTextContent(title, { exact: true });
    expect(graph.getByTestId(`lanes-map-lane-${id(n)}`).props.accessibilityLabel).toBe(title);
  }
  for (const n of [12, 13]) expect(graph.queryByTestId(`lanes-map-lane-${id(n)}`)).toBeNull();
  fireEvent.press(graph.getByTestId(`lanes-map-lane-${id(8)}`));
  await settle();
  expect(view.readShow).toHaveBeenCalledWith(id(8), expect.anything());
}, 15_000);

test('Idle and Paused cards list lanes by last activity; Working now and In progress keep list order', async () => {
  const view = setup('map_real');
  await settle();
  const titles = (section: string) => within(view.getByTestId(`readable-group-${section}`)).queryAllByTestId(/^lane-row-/)
    .map(n => view.fixture.inventory.lanes.find(l => `lane-row-${l.lane_id}` === n.props.testID)!.title);
  expect(titles('paused')).toEqual(['Pentacle', 'Business acquisition', '3D printing', 'Hosts and accounts', 'Altum CRM and phone', 'J3', 'Personal', 'Altum Automations', 'Animation']);
  expect(titles('in-progress')).toEqual(['Pentacle mobile', 'Government contracts']);
}, 15_000);

test('more than six busy lanes: six inside, the rest on the outer circle in the active styling before any quiet lane', async () => {
  const view = setup('map_a12_p9');
  await settle();
  const graph = within(view.getByTestId('lanes-constellation')), id = (n: number) => lane(n, 'map_a12_p9');
  const busy = Array.from({ length: 12 }, (_, i) => id(i + 1));
  const inside = busy.filter(b => within(graph.getByTestId(`lanes-map-label-${b}`)).queryByText(/ago$/));
  expect(inside).toHaveLength(6);
  for (const b of busy.filter(x => !inside.includes(x))) {
    // Active styling: one green progress ring, no age line.
    expect(graph.getByTestId(`lane-goal-arc-${b}-1`)).toBeTruthy();
    expect(graph.queryByTestId(`lane-goal-arc-${b}-2`)).toBeNull();
    expect(within(graph.getByTestId(`lanes-map-label-${b}`)).queryByText(/ago$/)).toBeNull();
  }
  expect(graph.queryByTestId('lanes-map-more-busy')).toBeNull();
  // Quiet lanes on the circle are muted: no progress ring.
  for (let n = 13; n <= 21; n++) expect(graph.queryByTestId(`lane-goal-arc-${id(n)}-1`)).toBeNull();
}, 15_000);

test('a working lane on the outer circle keeps a short stub of moving dashes towards the hub', async () => {
  const view = setup('map_a12_p9', { reduce: false, edit: inventory => {
    for (const l of inventory.lanes.slice(0, 12)) { l.goal_classes = 'w-'; l.goal_road = 'w'; l.goal_counts = [1, 0, 0, 0]; }
  } });
  await settle();
  const graph = within(view.getByTestId('lanes-constellation'));
  expect(graph.queryAllByTestId(/^lanes-map-link-stub-/, hidden)).toHaveLength(6);
  expect(graph.queryAllByTestId(/^working-spoke-stub-/, hidden).length).toBeGreaterThan(0);
}, 15_000);

test('busy lanes that cannot fit fold into a green +N, quiet lanes into a muted +N, each counted once', async () => {
  const view = setup('map_a30_p9');
  await settle();
  const graph = within(view.getByTestId('lanes-constellation'));
  const busyMore = graph.getByTestId('lanes-map-more-busy'), quietMore = graph.getByTestId('lanes-map-more');
  const placed = graph.queryAllByTestId(/^lanes-map-lane-/).length;
  const n = Number(/^(\d+) more lanes$/.exec(busyMore.props.accessibilityLabel)![1]);
  expect(placed + n).toBe(30);
  expect(busyMore).toHaveTextContent(`+${n}`);
  expect(quietMore.props.accessibilityLabel).toBe('9 more lanes');
  expect(quietMore).toHaveTextContent('+9');
  for (let i = 31; i <= 39; i++) expect(graph.queryByTestId(`lanes-map-lane-${lane(i, 'map_a30_p9')}`)).toBeNull();
}, 15_000);

test('pressing +N scrolls the home list to the top-most card it counts, with an 8 point margin', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype as unknown as { scrollTo(o: unknown): void }, 'scrollTo');
  const view = setup('map_a0_p40');
  await settle();
  const layout = (testID: string, y: number) => fireEvent(view.getByTestId(testID), 'layout', { nativeEvent: { layout: { x: 0, y, width: 400, height: 80 } } });
  layout('readable-group-paused', 600);
  const cards = view.queryAllByTestId(/^lane-card-/);
  cards.forEach((card, i) => layout(card.props.testID, 20 + 90 * i));
  const more = within(view.getByTestId('lanes-constellation')).getByTestId('lanes-map-more');
  const n = Number(/^(\d+) more lanes$/.exec(more.props.accessibilityLabel)![1]);
  scrollTo.mockClear();
  fireEvent.press(more);
  // Paused cards are in last-activity order, so the folded (least recent) lanes are the last n cards.
  expect(scrollTo).toHaveBeenCalledWith({ y: 600 + 20 + 90 * (cards.length - n) - 8, animated: true });
}, 15_000);

test('with six busy lanes and no quiet lanes the map is the approved single ring', async () => {
  const view = setup('map_a6_p9', { edit: inventory => { inventory.lanes = inventory.lanes.filter(l => l.state !== 'paused'); } });
  await settle();
  const graph = view.getByTestId('lanes-constellation');
  expect(graph.props.style).toMatchObject({ width: 440, height: 404 });
  expect(within(graph).queryByTestId('lanes-map-outer-circle')).toBeNull();
  const nodes = within(graph).queryAllByTestId(/^lanes-map-lane-/);
  expect(nodes).toHaveLength(6);
  for (const [i, node] of nodes.entries()) {
    let holder = node.parent;
    while (holder && holder.props.style?.left === undefined) holder = holder.parent;
    const angle = -Math.PI / 2 + 2 * Math.PI * i / 6, box = holder!.props.style;
    expect(node.props.style).toMatchObject({ width: 52, height: 52 });
    expect(box.left).toBeCloseTo(220 + 108 * Math.cos(angle) - 62, 6);
    expect(box.top).toBeCloseTo(190 + 108 * Math.sin(angle) - 26, 6);
  }
  for (const label of within(graph).queryAllByTestId(/^lanes-map-label-/)) expect(label.props.style).toMatchObject({ width: 124, height: 32 });
}, 15_000);

test('Finished earlier keeps the section rule without a second rule above the fold', async () => {
  const view = setup('loose_done');
  fireEvent.press(view.getByTestId(`lane-row-${lane(1, 'loose_done')}`));
  await settle();
  expect(view.getByTestId('finished-earlier-open')).toHaveStyle({ borderTopWidth: 0 });
  fireEvent.press(view.getByTestId('finished-earlier-open'));
  expect(view.getByTestId('finished-earlier-more')).toHaveStyle({ borderTopWidth: 1 });
});


test('home fills a working goal omitted from the bounded inventory using one detail page', async () => {
  const view = setup('overflow');
  await settle();
  expect(view.getByTestId('lane-goal-line-road-lane-overflow-1-g_road_overflow_1_10')).toHaveTextContent(/Stage 10/);
  expect(view.readShow).toHaveBeenCalledTimes(1);
});


test.each(['empty', 'completed'])('home preserves existing %s lane presentation', async state => {
  const view = setup('views', { edit: inventory => {
    const l = inventory.lanes[7];
    if (state === 'empty') { l.goals = []; l.goals_total = 0; l.goal_classes = '-'; l.goal_road = ''; l.goal_counts = [0, 0, 0, 0]; }
    else { l.goals = l.goals!.map(g => ({ ...g, state: 'done' as const, done: g.total })); l.goal_classes = 'd-'; l.goal_road = 'd'; l.goal_counts = [0, 0, 0, 1]; }
  } });
  await settle();
  expect(view.queryByTestId(`lane-goals-state-${lane(8)}`)).toBeNull();
  expect(view.queryAllByTestId(new RegExp(`^lane-goal-line-${lane(8)}-`))).toHaveLength(0);
});


test('home does not load historical member pages just to fill missing goals', async () => {
  const view = setup('overflow', { edit: (inventory, shows) => {
    const show = shows['road-lane-overflow-1'];
    show.members_next = 'more-members'; show.members_total = 1000;
    show.detail_revision = 'a'.repeat(64); inventory.lanes[0].detail_revision = show.detail_revision;
  } });
  await settle();
  expect(view.readShow).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('lane-goal-line-road-lane-overflow-1-g_road_overflow_1_10')).toBeTruthy();
});

test('failed goal hydration tells the truth and keeps the lane available', async () => {
  const view = setup('overflow', { rejectDetail: true });
  await settle();
  expect(view.getByTestId('lane-goals-state-road-lane-overflow-1')).toHaveTextContent(/Goals unavailable/);
  fireEvent.press(view.getByTestId('lane-row-road-lane-overflow-1'));
  await settle();
  expect(view.getByTestId('lanes-detail-retry')).toBeTruthy();
});

test('a new inventory revision cannot display stale hydrated goals', async () => {
  const view = setup('overflow', { edit: (inventory, shows) => {
    inventory.lanes[0].detail_revision = 'a'.repeat(64);
    shows['road-lane-overflow-1'].detail_revision = 'a'.repeat(64);
  } });
  await settle();
  expect(view.getByTestId('lane-goal-line-road-lane-overflow-1-g_road_overflow_1_10')).toBeTruthy();
  const changed = structuredClone(view.fixture.inventory);
  changed.lanes[0].detail_revision = 'b'.repeat(64);
  view.rerender(changed);
  await settle();
  expect(view.queryByTestId('lane-goal-line-road-lane-overflow-1-g_road_overflow_1_10')).toBeNull();
  expect(view.getByTestId('lane-goals-state-road-lane-overflow-1')).toHaveTextContent(/Goals unavailable/);
});


test.each([
  ['qqq', [1]], ['dqq', [2]], ['mqq', [1]], ['wqq', [1]], ['bqq', [1]],
  ['qmq', [1, 2]], ['qbw', [2, 3]], ['bmw', [1, 2]], ['mwq', [1, 2]], ['ddd', []],
])('home card follows lane priority for %s even when paused', async (letters, expected) => {
  const view = setup('views', { edit: inventory => {
    const l = inventory.lanes[7], base = l.goals![0];
    l.goals = [...letters].map((letter, i) => ({ ...base, goal_id: `choice-${i + 1}`, title: `Choice ${i + 1}`, pos: i, rank: i, done: letter === 'd' ? base.total : 0 }));
    l.goals_total = letters.length; l.goal_classes = `${letters}-`; l.goal_road = letters; l.goal_counts = [[...letters].filter(c => /[wm]/.test(c)).length, [...letters].filter(c => c === 'b').length, [...letters].filter(c => c === 'q').length, [...letters].filter(c => c === 'd').length];
  } });
  await settle();
  expect(view.queryAllByTestId(new RegExp(`^lane-goal-line-${lane(8)}-`)).map(n => n.props.testID)).toEqual(expected.map(n => `lane-goal-line-${lane(8)}-choice-${n}`));
});
