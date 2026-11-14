import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  normalizeWorkLanesInventory, parseWorkLaneShow, readableDots, readableHomeCounts, readableItemKind, readableItemOrder,
  readableLaneClass, readableLeadGoals, readableRoad, readableStopWord, type RoadStop, type WorkLane, type WorkLaneGoal, type WorkLaneMember,
} from '../src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/work-lanes-inventory.json', import.meta.url), 'utf8'));
const frame = fixture.progress_v2[0].frame;
const g = (goal_id: string, rank: number, extra: Partial<WorkLaneGoal> = {}): WorkLaneGoal =>
  ({ goal_id, title: goal_id, rank, state: 'in_progress', done: 1, total: 4, ...extra });
const lane = (extra: Partial<WorkLane> = {}) => ({ lane_id: 'l', state: 'active', title: 'Lane', goals: [], ...extra } as unknown as WorkLane);
const ids = (stops: RoadStop[]) => stops.map(s => s.goal.goal_id ?? 'default');
const seat = { stream_id: 's', role: null, host: null, visibility: null, activity: 'working' as const, last_activity: null };

test('goal order: rank, ties by title, default goal last; letters pair by sent index before sorting', () => {
  const item = lane({ goals: [g('b', 2), g('z', 1), g('a', 2)], goal_classes: 'wmqm', default_goal: { state: 'in_progress', done: 0, total: 2 } });
  const road = readableRoad(item, { legacy: true });
  assert.deepEqual(ids(road), ['z', 'a', 'b', 'default']);
  assert.deepEqual(road.map(s => s.goalClass), ['moving', 'queued', 'working', 'moving']);
});

test('numbers count unfinished goals and done goals carry none', () => {
  const item = lane({ goals: [g('d1', 1), g('o1', 2), g('d2', 3), g('o2', 4), g('d3', 5)], goal_classes: 'dqdqd-' });
  assert.deepEqual(readableRoad(item, { legacy: true }).map(s => s.number), [null, 1, null, 2, null]);
});

test('position word: empty and blocked goals take part, started and done goals do not', () => {
  const item = lane({ goals: [g('m', 1), g('empty', 2, { total: 0, done: 0 }), g('q', 3), g('b', 4), g('q2', 5)], goal_classes: 'mqqbq-' });
  assert.deepEqual(readableRoad(item, { legacy: true }).map(s => s.position), [null, 'next', 'later', 'later', 'later']);
  const blockedFirst = lane({ goals: [g('b', 1), g('q', 2)], goal_classes: 'bq-' });
  assert.deepEqual(readableRoad(blockedFirst, { legacy: true }).map(s => s.position), ['next', 'later']);
});

test('lane class: four ordered rules plus parked', () => {
  const cases: Array<[string, WorkLane, boolean, string]> = [
    ['parked wins over everything', lane({ parked: { at: null, reason: null }, goal_classes: 'w-' }), true, 'parked'],
    ['paused with a working letter', lane({ state: 'paused', goals: [g('a', 1)], goal_classes: 'w-' }), false, 'paused'],
    ['working by letter', lane({ goals: [g('a', 1)], goal_classes: 'w-', goal_counts: [1, 0, 0, 0] }), false, 'working'],
    ['working by live seat with no w letter', lane({ goals: [g('a', 1)], goal_classes: 'q-', goal_counts: [0, 0, 1, 0] }), true, 'working'],
    ['all sent goals queued but an unsent goal in progress', lane({ goals: [g('a', 1)], goal_classes: 'q-', goal_counts: [1, 0, 8, 0] }), false, 'moving'],
    ['letters without counts', lane({ goals: [g('a', 1)], goal_classes: 'm-' }), false, 'moving'],
    ['letters without counts, nothing started', lane({ goals: [g('a', 1)], goal_classes: 'q-' }), false, 'idle'],
    ['neither letters nor counts: legacy state', lane({ goals: [g('a', 1)] }), false, 'moving'],
    ['only blocked goals', lane({ goals: [g('a', 1)], goal_classes: 'b-', goal_counts: [0, 1, 0, 0] }), false, 'idle'],
    ['only work is a working default goal', lane({ goals: [g('a', 1)], goal_classes: 'qw', goal_counts: [1, 0, 1, 0], default_goal: { state: 'in_progress', done: 0, total: 1 } }), false, 'working'],
  ];
  for (const [name, item, working, expected] of cases) assert.equal(readableLaneClass(item, working), expected, name);
});

test('home counts leave parked lanes out', () => {
  assert.deepEqual(readableHomeCounts(['working', 'moving', 'moving', 'idle', 'paused', 'parked', 'parked']), { working: 1, moving: 2, quiet: 2, parked: 2 });
});

test('lead goals: working first, then moving, in goal order, at most two', () => {
  const item = lane({ goals: [g('m1', 1), g('m2', 2), g('w', 3)], goal_classes: 'mmw-' });
  assert.deepEqual(ids(readableLeadGoals(item)), ['w', 'm1']);
  const def = lane({ goals: [g('m1', 1)], goal_classes: 'mw', default_goal: { state: 'in_progress', done: 0, total: 2 } });
  assert.deepEqual(ids(readableLeadGoals(def)), ['default', 'm1']);
  assert.deepEqual(readableLeadGoals(lane({ goals: [g('q', 1)], goal_classes: 'q-' })), []);
});

test('dots: exactly eight, more than eight, open default goal, no class letters', () => {
  const eight = Array.from({ length: 8 }, (_, i) => g(`g${i}`, i));
  assert.deepEqual(readableDots(lane({ goals: eight, goals_total: 8, goal_classes: 'dwmbqqqq-' })),
    { dots: ['done', 'working', 'moving', 'blocked', 'later', 'later', 'later', 'later'], more: 0 });
  assert.deepEqual(readableDots(lane({ goals: eight, goals_total: 11, goal_classes: 'qqqqqqqq-' })).more, 3);
  assert.deepEqual(readableDots(lane({ goals: [g('a', 1)], goals_total: 1, goal_classes: 'dq', default_goal: { state: 'not_started', done: 0, total: 2 } })).dots, ['done', 'next']);
  assert.deepEqual(readableDots(lane({ goals: [g('a', 1), g('b', 2, { state: 'not_started' }), g('c', 3, { state: 'done', done: 4 })], goals_total: 3 })).dots, ['moving', 'next', 'done']);
});

test('a valid goal road gives every dot and exact numbers for ten goals with two done', () => {
  const road = 'dmwqdbqqqq';
  const sent = [1, 2, 3, 5, 6, 7, 8, 9].map(pos => g(`g${pos}`, pos, { pos }));
  const item = lane({ goals: sent, goals_total: 10, goal_road: road, goal_classes: `${sent.map(x => road[x.pos!]).join('')}-` });
  assert.deepEqual(readableDots(item), { dots: ['done', 'moving', 'working', 'next', 'done', 'blocked', 'later', 'later', 'later', 'later'], more: 0 });
  const stops = readableRoad(item, { legacy: true });
  assert.deepEqual(stops.map(s => [s.goal.goal_id, s.number, s.position]),
    [['g1', 1, null], ['g2', 2, null], ['g3', 3, 'next'], ['g5', 4, 'later'], ['g6', 5, 'later'], ['g7', 6, 'later'], ['g8', 7, 'later'], ['g9', 8, 'later']]);
});

test('item kind: every overlapping pair resolves by the ordered rules', () => {
  const m = (extra: Partial<WorkLaneMember>): WorkLaneMember => ({ spec_id: 'x', ...extra });
  const q = { count: 1, first_question_id: null };
  const cases: Array<[WorkLaneMember, string]> = [
    [m({ status: 'completed', seats: [seat] }), 'done'],
    [m({ status: 'in_progress', seats: [seat], open_questions: q }), 'needs'],
    [m({ status: 'ready_for_dev', seats: [seat] }), 'working'],
    [m({ status: 'in_progress', seats: [{ ...seat, activity: 'idle' }] }), 'in_progress'],
    [m({ status: 'needs_qa' }), 'in_progress'],
    [m({ status: 'blocked' }), 'blocked'],
    [m({ status: 'analysis' }), 'next'],
    [m({ status: 'backlog' }), 'later'],
    [m({ status: 'mystery' }), 'later'],
    [m({}), 'later'],
  ];
  for (const [member, kind] of cases) assert.equal(readableItemKind(member), kind, JSON.stringify(member));
  const order = readableItemOrder([m({ spec_id: 'b', status: 'blocked' }), m({ spec_id: 'w', status: 'ready_for_dev', seats: [seat] }),
    m({ spec_id: 'n', status: 'in_progress', open_questions: q }), m({ spec_id: 'dep', status: 'deprecated' }), m({ spec_id: 'p', status: 'in_progress' })]);
  assert.deepEqual(order.map(x => x.member.spec_id), ['n', 'w', 'p', 'b']);
});

test('stop state word: seven ordered rules', () => {
  const now = Date.parse('2026-11-14T18:00:00Z');
  const stop = (goalClass: RoadStop['goalClass'], extra: Partial<WorkLaneGoal> = {}, position: RoadStop['position'] = null): RoadStop =>
    ({ goal: g('a', 1, extra), goalClass, isDefault: false, number: 1, position });
  const word = (s: RoadStop, o = {}) => readableStopWord(s, { now, ...o });
  assert.deepEqual(word(stop('done', { done: 4, progress_at: '2026-11-12T18:00:00Z' })), { text: 'done Nov 12' });
  assert.deepEqual(word(stop('done', { done: 4 })), { text: 'done' });
  assert.deepEqual(word(stop('working', { progress_at: '2026-11-14T17:00:00Z' }), { expanded: true, needsYou: true }), { text: 'needs you', tone: 'yellow' });
  assert.deepEqual(word(stop('working', { progress_at: '2026-11-14T17:00:00Z' }), { expanded: true }), { text: '1h', tone: 'green' });
  assert.deepEqual(word(stop('moving', { progress_at: '2026-11-14T17:00:00Z' }), { expanded: true }), { text: '1h' });
  assert.equal(word(stop('moving'), { expanded: true }), null);
  assert.deepEqual(word(stop('queued', { total: 0, done: 0 }, 'next')), { text: 'no items yet' });
  assert.deepEqual(word(stop('moving')), { text: 'in progress · 1/4' });
  assert.deepEqual(word(stop('working')), { text: 'in progress · 1/4' });
  assert.deepEqual(word(stop('blocked', { blocked: 2 })), { text: '2 blocked · 1/4', tone: 'yellow' });
  assert.deepEqual(word(stop('blocked')), { text: 'blocked · 1/4', tone: 'yellow' });
  assert.deepEqual(word(stop('queued', {}, 'next')), { text: 'next · 1/4' });
  assert.deepEqual(word(stop('queued', {}, 'later')), { text: 'later · 1/4' });
});

const base = frame.lanes[0];
const normalized = (extra: object) => normalizeWorkLanesInventory({ ...frame, lanes: [{ ...base, ...extra }] })!.lanes;

test('parked reader keeps the lane and only the parked element depends on it', () => {
  const at = '2026-11-01T10:00:00Z';
  const cases: Array<[unknown, unknown]> = [
    [undefined, undefined], [null, undefined], ['parked', undefined], [[], undefined],
    [{ at, reason: 'Waiting on hardware.' }, { at, reason: 'Waiting on hardware.' }],
    [{ at: null, reason: null }, { at: null, reason: null }],
    [{}, { at: null, reason: null }],
    [{ at: 'yesterday', reason: 'x'.repeat(200) }, { at: null, reason: 'x'.repeat(160) }],
  ];
  for (const state of ['paused', 'active'])
    for (const [parked, expected] of cases) {
      const lanes = normalized({ state, ...(parked === undefined ? {} : { parked }) });
      assert.equal(lanes.length, 1, JSON.stringify(parked));
      assert.deepEqual(lanes[0].parked, expected);
      assert.equal(lanes[0].state, state);
    }
  const show = parseWorkLaneShow({ lane: { lane_id: base.lane_id }, projection: { ...base, state: 'paused', parked: { at, reason: null } }, members: [] })!;
  assert.deepEqual(show.projection?.parked, { at, reason: null });
});

test('goal_road reader is valid only as a whole and never rejects a lane', () => {
  const goals = [{ ...g('a', 1), pos: 0 }, { ...g('b', 2), pos: 2 }];
  const good = normalized({ goals, goals_total: 3, goal_road: 'mqd' })[0];
  assert.equal(good.goal_road, 'mqd');
  assert.deepEqual(good.goals?.map(x => x.pos), [0, 2]);
  const bad: Array<[string, object]> = [
    ['wrong length', { goals, goals_total: 3, goal_road: 'mq' }],
    ['bad letter', { goals, goals_total: 3, goal_road: 'mxd' }],
    ['missing pos', { goals: [goals[0], g('b', 2)], goals_total: 3, goal_road: 'mqd' }],
    ['duplicate pos', { goals: [goals[0], { ...goals[1], pos: 0 }], goals_total: 3, goal_road: 'mqd' }],
    ['pos outside the road', { goals: [goals[0], { ...goals[1], pos: 3 }], goals_total: 3, goal_road: 'mqd' }],
  ];
  for (const [name, extra] of bad) {
    const lanes = normalized(extra);
    assert.equal(lanes.length, 1, name);
    assert.equal(lanes[0].goal_road, undefined, name);
    assert.equal(lanes[0].goals?.length, 2, name);
    assert.ok(lanes[0].goals?.every(x => x.pos === undefined), name);
  }
});
