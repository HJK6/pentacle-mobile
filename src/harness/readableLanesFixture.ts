import { lanesGoalsFixture } from './lanesGoalsFixture';

/** Synthetic complete, sparse and pre-projection journeys through the real lane reducers. */
export function readableLanesFixture(variant: 'full' | 'sparse' | 'old' = 'full', now = Date.now()) {
  const fixture = lanesGoalsFixture(now);
  const stamp = new Date(now - 12 * 60000).toISOString();
  for (const [i, lane] of fixture.inventory.lanes.entries()) {
    const show = fixture.shows[lane.lane_id];
    const goals = lane.goals ?? [];
    if (variant !== 'old') {
      lane.goal_classes = `${goals.map((_, j) => i === 1 && j === 0 ? 'b' : j === 0 ? 'w' : 'q').join('')}${lane.default_goal?.total ? 'q' : '-'}`;
      lane.goal_counts = i === 1 ? [0, 1, Math.max(0, goals.length - 1), 0] : [goals.length ? 1 : 0, 0, Math.max(0, goals.length - 1), 0];
      lane.progress_at = variant === 'full' ? stamp : null;
      lane.state_at = variant === 'full' ? stamp : null;
      for (const [j, goal] of goals.entries()) Object.assign(goal, { moving: j === 0 && i !== 1 ? 2 : 0, blocked: i === 1 && j === 0 ? 1 : 0, working: i !== 1 && j === 0, left_h: variant === 'full' ? 14 : null, progress_at: variant === 'full' ? stamp : null, summary_line: variant === 'full' ? 'Make this outcome easy to understand.' : null });
      if (lane.default_goal) Object.assign(lane.default_goal, { moving: 0, blocked: 0, working: false, left_h: null, progress_at: null });
    }
    if (i === 3 && goals.length) {
      for (const member of show.members) member.goal_id = goals[0].goal_id;
      if (show.members[0]) {
        show.members[0].open_questions = { count: 1, first_question_id: 'q-embedded-1' };
        if (lane.members?.[0]) lane.members[0].open_questions = { count: 1, first_question_id: 'q-embedded-1' };
        if (variant === 'full') Object.assign(show.members[0], { summary_line: 'Make the release checks reliable.', progress_at: stamp, estimate_first: { p25: 1, median: 2, p75: 3 }, blocked_line: null, unblocks: [{ spec_id: 'spec_sample__target', title: 'Ship the build' }] });
      }
      if (show.members[2] && variant === 'full') Object.assign(show.members[2], { estimate_first: { p25: 1, median: 2, p75: 3 }, worked: { elapsed_h: 5, active_h: 5, censored: false, seats: 1, qa_rounds: 2, as_of: stamp }, transitions: [{ status: 'in_progress', at: new Date(now - 72 * 3600000).toISOString() }] });
    }
    if (variant === 'sparse') {
      for (const member of show.members) {
        member.status_line = null; member.next_line = null; member.blocked_line = null;
        member.summary_line = null; member.progress_at = null; member.estimate_first = null;
        member.unblocks = []; member.recent = [];
      }
    }
    show.projection = lane;
  }
  return fixture;
}
