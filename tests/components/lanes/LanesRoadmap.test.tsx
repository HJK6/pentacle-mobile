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
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { applyWorkLanesInventory, initialPentacleStreamState, type WorkLanesInventory } from 'pentacle-chat-core';
import LanesOverlay from '../../../src/components/lanes/LanesOverlay';
import { selectLaneCardViewModels } from '../../../src/services/workLanes';
import { lanesRoadmapFixture, type RoadmapVariant } from '../../../src/harness/lanesRoadmapFixture';

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const hidden = { includeHiddenElements: true };
function setup(variant: RoadmapVariant = 'views', { reduce = true, edit }: { reduce?: boolean; edit?(inventory: WorkLanesInventory): void } = {}) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduce);
  const fixture = lanesRoadmapFixture(variant, Date.parse('2026-11-14T18:00:00Z'));
  edit?.(fixture.inventory);
  const models = (inventory: WorkLanesInventory) => selectLaneCardViewModels(applyWorkLanesInventory(initialPentacleStreamState, inventory));
  const readShow = jest.fn(async (id: string) => fixture.shows[id]);
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

test('more goals than the frame sends: eight dots, +N, and +N more in progress', async () => {
  const view = setup('overflow');
  await settle();
  const id = lane(1, 'overflow');
  expect(view.queryAllByTestId(new RegExp(`^lane-dots-${id}-\\d+-`))).toHaveLength(8);
  expect(view.getByText('+3')).toBeTruthy();
  expect(view.getByText('+1 more in progress')).toBeTruthy();
  expect(view.getByTestId('readable-section-in-progress')).toBeTruthy();
}, 15_000);

test('parked: off the map and the sections, behind the button with reason and date; muted lane shows the reason', async () => {
  const view = setup();
  await settle();
  for (const n of [12, 13]) {
    expect(view.queryByTestId(`lane-row-${lane(n)}`)).toBeNull();
    expect(view.queryByTestId(`lanes-map-lane-${lane(n)}`)).toBeNull();
  }
  expect(view.getByText('1 working · 6 in progress · 4 quiet')).toBeTruthy();
  fireEvent.press(view.getByTestId('parked-button'));
  await settle();
  expect(view.getByText('2 lanes on hold')).toBeTruthy();
  expect(view.getByText('Waiting for the new lens to arrive.')).toBeTruthy();
  expect(view.getByText(/^parked Nov 1 · 2 goals · 5 items$/)).toBeTruthy();
  expect(view.getByText(/^1 goal · 2 items$/)).toBeTruthy();
  fireEvent.press(view.getByTestId(`parked-lane-${lane(12)}`));
  await settle();
  expect(view.getByTestId('lane-parked-reason')).toHaveTextContent('Waiting for the new lens to arrive.');
}, 15_000);

test('without a parked key there is no Parked button; malformed keys never reject a lane', async () => {
  const plain = setup('views', { edit: inventory => { for (const l of inventory.lanes) delete (l as { parked?: unknown }).parked; } });
  await settle();
  expect(plain.queryByTestId('parked-button')).toBeNull();
  expect(plain.queryAllByTestId(/^lane-row-/)).toHaveLength(13);
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
    await flies(`parked-lane-${lane(12)}`);
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
