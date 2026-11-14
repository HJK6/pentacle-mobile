import assert from 'node:assert/strict';
import test from 'node:test';
import { readableAge, readableGoalClass, readableHours, readableLaneClass, readableLeadGoals, readableSeatCount, readableSentence, readableTrouble } from '../src/services/readableLanes';
import type { WorkLane, WorkLaneMember, WorkLaneSeat } from '../src/types/pentacle';

const goal = { state: 'in_progress' as const, done: 0, total: 2 };
const lane = (extra: Partial<WorkLane> = {}) => ({ state: 'active', title: 'Lane', goals: [], ...extra } as WorkLane);
const seat = (activity: WorkLaneSeat['activity']) => ({ stream_id: 's', role: null, host: null, visibility: null, activity, last_activity: null });

test('goal classes prefer the inventory letter and otherwise derive detail or legacy state', () => {
  assert.equal(readableGoalClass(goal, 'b'), 'blocked');
  assert.equal(readableGoalClass({ ...goal, total: 0, done: 0, moving: 0, blocked: 0, working: false }), 'queued');
  assert.equal(readableGoalClass({ ...goal, done: 2, working: true }), 'done');
  assert.equal(readableGoalClass({ ...goal, moving: 1, blocked: 0, working: true }), 'working');
  assert.equal(readableGoalClass({ ...goal, moving: 1, blocked: 0, working: false }), 'moving');
  assert.equal(readableGoalClass({ ...goal, moving: 0, blocked: 1, working: false }), 'blocked');
  assert.equal(readableGoalClass(goal), 'moving');
  assert.equal(readableGoalClass({ ...goal, moving: 0, blocked: 1, working: false }, undefined, true), 'moving');
});
test('lane classes use uncapped counts and lead goals use class letters and rank', () => {
  const goals = Array.from({ length: 8 }, (_, rank) => ({ ...goal, goal_id: `${rank}`, title: `${rank}`, rank }));
  const item = lane({ goals, goal_counts: [1, 9, 2, 0], goal_classes: 'bbbbbbbm-' });
  assert.equal(readableLaneClass(item), 'moving');
  assert.deepEqual(readableLeadGoals(item).map(x => x.goal.goal_id), ['7']);
  assert.equal(readableLaneClass(lane({ goal_counts: [0, 1, 0, 0], goal_classes: '-' })), 'idle');
  assert.equal(readableLaneClass(lane({ goal_counts: [0, 0, 3, 1], goal_classes: '-' })), 'idle');
  assert.equal(readableLaneClass(lane({ state: 'paused', goal_counts: [1, 0, 0, 0] })), 'paused');
});
test('age and hours floor and round without inventing missing values', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(readableAge(null, now), null);
  assert.equal(readableAge('invalid', now), null);
  assert.equal(readableAge('2026-11-10T11:59:30Z', now), 'now');
  assert.equal(readableAge('2026-11-09T12:00:00Z', now), '1d');
  assert.equal(readableHours(.9), '<1h left');
  assert.equal(readableHours(1.5), '~2h left');
  assert.equal(readableHours(null), null);
});
test('sentences and seat counts respect missing data and truncated lists', () => {
  const member: WorkLaneMember = { spec_id: 'a', status: 'blocked', status_line: 'Working', blocked_line: 'approval', open_questions: { count: 1, first_question_id: null } };
  assert.equal(readableSentence(member), 'Blocked on approval');
  assert.equal(readableSentence({ ...member, blocked_line: null }), null);
  assert.equal(readableSentence({ ...member, status: 'in_progress' }), 'Waiting on your answer.');
  assert.equal(readableSeatCount({ ...member, seats: [seat('working')], seats_total: 2 }), '1+ on it now');
  assert.equal(readableSeatCount({ ...member, seats: [seat('idle')], seats_total: 2 }), null);
});
test('trouble uses the p75 threshold and newest stage transition', () => {
  const member: WorkLaneMember = { spec_id: 'a', status: 'needs_qa', estimate_first: { p25: 1, median: 2, p75: 3 }, worked: { active_h: 3, elapsed_h: 3, censored: false, seats: 1, qa_rounds: 1, as_of: '' }, transitions: [{ status: 'needs_qa', at: '2026-11-08T12:00:00Z' }] };
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.deepEqual(readableTrouble(member, now), ['In review 2d']);
  assert.deepEqual(readableTrouble({ ...member, worked: { ...member.worked!, active_h: 3.1, qa_rounds: 2 } }, now), ['1.1h over estimate', '2 review rounds', 'In review 2d']);
  assert.deepEqual(readableTrouble({ spec_id: 'a' }, now), []);
});

test('missing classes fall back to legacy state and empty goals stay queued', () => {
  assert.equal(readableGoalClass({ ...goal, total: 0, working: true }, 'w'), 'queued');
  assert.equal(readableLaneClass(lane({ goals: [{ ...goal, goal_id: 'g', title: 'G', rank: 1 }] })), 'moving');
  assert.equal(readableLaneClass(lane({ goals: [{ ...goal, goal_id: 'g', title: 'G', rank: 1, state: 'not_started' }] })), 'idle');
});
test('trouble thresholds require all inputs and a full two days', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const member: WorkLaneMember = { spec_id: 's', status: 'in_progress', transitions: [{ status: 'in_progress', at: '2026-11-08T12:00:01Z' }], worked: { active_h: 9, elapsed_h: null, censored: false, seats: 0, qa_rounds: 1, as_of: '' } };
  assert.deepEqual(readableTrouble(member, now), []);
  assert.equal(readableSeatCount({ ...member, seats: [seat('working'), seat('working')], seats_total: 2 }), '2 on it now');
  assert.equal(readableHours(0), '<1h left');
  assert.equal(readableAge('2026-11-10T11:00:01Z', now), '59m');
});

test('display boundaries floor ages and round hours without inventing missing inputs', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  for (const [offset, expected] of [[59_999, 'now'], [60_000, '1m'], [3_600_000, '1h'], [86_400_000, '1d']] as const)
    assert.equal(readableAge(new Date(now - offset).toISOString(), now), expected);
  for (const [hours, expected] of [[0.99, '<1h left'], [1, '~1h left'], [1.49, '~1h left'], [1.5, '~2h left']] as const)
    assert.equal(readableHours(hours), expected);
  assert.equal(readableHours(NaN), null);
});

test('a moving default goal uses the lane title and sorts last', () => {
  const item = lane({ goal_counts: [3, 0, 0, 0], goal_classes: 'mmw',
    goals: [{ ...goal, goal_id: 'later', title: 'Later', rank: 5 }, { ...goal, goal_id: 'earlier', title: 'Earlier', rank: 1 }],
    default_goal: { ...goal } });
  assert.deepEqual(readableLeadGoals(item).map(x => x.goal.title), ['Lane', 'Earlier']);
});
