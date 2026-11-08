jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import { lanesFlowFixture } from '../src/harness/lanesFlowFixture';
import { laneGoalParts, laneTopGoals, laneRowMeta, laneRowDetail, selectLaneCardViewModels } from '../src/services/workLanes';
import { applyWorkLanesInventory, initialPentacleStreamState, type WorkLane, type WorkLaneGoal } from 'pentacle-chat-core';
const base = (): WorkLane => ({ ...lanesFlowFixture().inventory.lanes[0], members: [], items_total: 100, items_completed: 40, items_dropped: 5 });
const goal = (id: string, rank = 1, state: WorkLaneGoal['state'] = 'in_progress'): WorkLaneGoal => ({ goal_id: id, title: id, rank, state, done: 1, total: 4 });
test('absent/empty goals use uncapped nondeprecated counts and one part', () => {
  const lane = base();
  for (const goals of [undefined, []]) {
    const parts = laneGoalParts({ ...lane, goals });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ goalId: null, done: 40, total: 95, state: 'in_progress' });
    expect(laneRowMeta({ ...lane, goals })).toEqual({ title: null, count: '40/95' });
  }
});
test('rank/id order, top two active goals, default last, exact tones and zero totals', () => {
  const lane: WorkLane = { ...base(), state: 'blocked', goals: [goal('z', 2), goal('b'), goal('a'), { ...goal('done', 0, 'done'), done: 4 }], default_goal: { state: 'not_started', done: 0, total: 3 } };
  expect(laneGoalParts(lane).map(p => p.goalId)).toEqual(['done', 'a', 'b', 'z', null]);
  expect(laneTopGoals(lane).map(p => p.goalId)).toEqual(['a', 'b']);
  expect(laneGoalParts(lane).map(p => p.tone)).toEqual(['green', 'amber', 'amber', 'amber', 'muted']);
  expect(laneRowMeta(lane)).toEqual({ title: 'a', count: '1/4' });
  expect(laneGoalParts({ ...lane, goals: [{ ...goal('empty', 1, 'not_started'), total: 0, done: 0 }], default_goal: { state: 'not_started', total: 0, done: 0 } })[0].fraction).toBe(0);
  expect(laneTopGoals({ ...lane, goals: [goal('later', 2, 'not_started'), goal('first', 1, 'done')], default_goal: undefined, members: [] })[0].goalId).toBe('first');
});
test('daemon default wins, inline fallback excludes assigned/deprecated and is explicitly marked', () => {
  const lane: WorkLane = { ...base(), goals: [goal('g')], members: [
    { spec_id: 'assigned', goal_id: 'not-carried', status: 'completed' },
    { spec_id: 'done', status: 'completed', terminal: 'completed' },
    { spec_id: 'open', status: 'needs_qa' }, { spec_id: 'dropped', status: 'deprecated' },
  ] };
  expect(laneGoalParts(lane)[1]).toMatchObject({ done: 1, total: 2, state: 'in_progress', fallback: true });
  expect(laneGoalParts({ ...lane, default_goal: { done: 2, total: 8, state: 'in_progress' } })[1]).toMatchObject({ done: 2, total: 8 });
  expect(laneGoalParts({ ...lane, default_goal: { done: 2, total: 8, state: 'in_progress' } })[1].fallback).toBeUndefined();
  expect(laneGoalParts({ ...lane, goals: Array.from({ length: 8 }, (_, i) => goal(String(i))) })).toHaveLength(9);
});
test('default top meta omits repeated lane title; details use blocker/question/freshness/host estimate', () => {
  const fixture = lanesFlowFixture();
  const model = selectLaneCardViewModels(applyWorkLanesInventory(initialPentacleStreamState, fixture.inventory))[0];
  expect(laneRowDetail({ ...model, lane: { ...model.lane, state: 'blocked' }, blockerLabel: 'Needs a build' })).toEqual({ text: 'Needs a build', tone: 'amber' });
  expect(laneRowDetail({ ...model, lane: { ...model.lane, state: 'active' }, waitingOnYou: 1, blockerLabel: 'Waiting on you: Which slot?' })).toEqual({ text: 'Which slot?', tone: 'amber' });
  expect(laneRowDetail({ ...model, lane: { ...model.lane, state: 'paused' }, freshnessLabel: '2h ago' }).text).toBe('2h ago');
  expect(laneRowDetail({ ...model, lane: { ...model.lane, state: 'active', members: [] }, waitingOnYou: 0, leadHost: 'hosta' }).text).toContain('hosta · ');
  const lane: WorkLane = { ...base(), goals: [goal('done', 1, 'done')], default_goal: { state: 'in_progress', done: 1, total: 2 } };
  expect(laneRowMeta(lane)).toEqual({ title: null, count: '1/2' });
});
