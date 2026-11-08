import type { WorkLaneGoal } from 'pentacle-chat-core';
import { lanesFlowFixture } from './lanesFlowFixture';

/** Goal-field shapes are deliberately mixed so the sparse daemon remains a first-class case. */
export function lanesGoalsFixture(now = Date.now()) {
  const fixture = lanesFlowFixture(now);
  const counts = [1, 2, 3, 8, 0, 1];
  fixture.inventory.lanes.slice(0, 6).forEach((lane, index) => {
    const count = counts[index];
    if (!count) return;
    lane.goals = Array.from({ length: count }, (_, i): WorkLaneGoal => ({
      goal_id: `g_sample_${index}_${i}`, title: `Sample outcome ${i + 1}`,
      state: i < 3 ? 'in_progress' : i === 3 ? 'done' : 'not_started',
      done: i < 3 ? i + 1 : i === 3 ? 4 : 0, total: 4, rank: i + 1,
      ...(i === 0 ? { icon: 'flask' } : {}),
    }));
    lane.goals_total = count;
    lane.default_goal = { state: 'not_started', done: 0, total: index === 3 ? 2 : 0 };
    for (const member of lane.members ?? []) member.goal_id = lane.goals[0].goal_id;
    fixture.shows[lane.lane_id].projection = lane;
  });
  return fixture;
}
