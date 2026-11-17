import { lanesGoalsFixture } from './lanesGoalsFixture';

/** Synthetic complete, sparse and pre-projection journeys through the real lane reducers. */
export function readableLanesFixture(variant: 'full' | 'sparse' | 'old' | 'dot' = 'full', now = Date.now()): ReturnType<typeof lanesGoalsFixture> {
  if (variant === 'dot') {
    const fixture = readableLanesFixture('full', now);
    const stamp = (hours: number) => new Date(now - hours * 3600000).toISOString();
    for (const index of [0, 3]) {
      const lane = fixture.inventory.lanes[index], show = fixture.shows[lane.lane_id];
      lane.state = 'active'; lane.state_reason = 'work_started'; lane.lead = null;
      lane.goal_classes = lane.goal_classes?.split('w').join('m');
      lane.progress_at = stamp(3);
      for (const goal of lane.goals ?? []) goal.working = false;
      for (const member of [...show.members, ...(lane.members ?? [])]) {
        member.seats = []; member.seats_total = 0; member.lead_seat = null;
        member.open_questions = { count: 0, first_question_id: null };
      }
    }
    const waiting = fixture.inventory.lanes[0], working = fixture.inventory.lanes[3];
    waiting.title = 'Prepare the next release and verify every supported client';
    waiting.activity = 'waiting_on_dot';
    waiting.external = { label: 'Dot', working: 0, review: 0, queued: 1, verified_at: stamp(1) };
    const queued = fixture.shows[waiting.lane_id].members[0];
    queued.status = 'backlog'; queued.goal_id = waiting.goals![0].goal_id;
    queued.external = [{ label: 'Dot', ref: 'sample-waiting', state: 'queued', verified_at: stamp(1) }];
    queued.latest_event = { kind: 'reported_done', at: stamp(2) };
    queued.progress_at = stamp(3);
    working.activity = 'working';
    working.external = { label: 'Dot', working: 1, review: 1, queued: 1, verified_at: stamp(1) };
    const members = fixture.shows[working.lane_id].members;
    for (const [index, state, kind] of [[0, 'working', 'review_passed'], [1, 'review', 'review_failed'], [8, 'queued', 'reported_done']] as const) {
      members[index].external = [{ label: 'Dot', ref: `sample-${state}`, state, verified_at: stamp(1) }];
      members[index].latest_event = { kind, at: stamp(2) };
      members[index].progress_at = stamp(3);
    }
    // Packet and event keys are detail-only, including after a live presence update.
    for (const lane of [waiting, working]) lane.members = fixture.shows[lane.lane_id].members.slice(0, 8).map(({ external, latest_event, criteria, transitions, ...preview }) => preview);
    fixture.inventory.counts = { open: 13, active: 5, blocked: 1, paused: 7 };
    return fixture;
  }
  const fixture = lanesGoalsFixture(now);
  const stamp = new Date(now - 12 * 60000).toISOString();
  for (const [i, lane] of fixture.inventory.lanes.entries()) {
    const show = fixture.shows[lane.lane_id];
    const goals = lane.goals ?? [];
    if (variant === 'full') for (const member of show.members) {
      if (member.worked) member.worked = { ...member.worked, qa_rounds: 0 };
    }
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
      if (variant === 'full' && show.members[1]) {
        show.members[1].blocked_line = 'the review window';
        const recent = [
          { at: stamp, spec_id: show.members[1].spec_id, kind: 'note' as const, text: 'Review window requested.' },
          { at: stamp, spec_id: show.members[1].spec_id, kind: 'checks' as const, count: 2 },
          { at: stamp, spec_id: show.members[1].spec_id, kind: 'blocked' as const, text: 'the review window' },
          { at: stamp, spec_id: show.members[1].spec_id, kind: 'done' as const },
        ];
        lane.recent = recent;
        goals[0].recent = recent;
        show.members[1].recent = recent;
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
