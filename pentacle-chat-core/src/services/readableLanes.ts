import type { WorkLane, WorkLaneDefaultGoal, WorkLaneMember } from '../types/pentacle';

export type GoalClass = 'working' | 'moving' | 'blocked' | 'queued' | 'done';
export type LaneClass = 'moving' | 'stalled' | 'idle' | 'paused';
const classes: Record<string, GoalClass> = { w: 'working', m: 'moving', b: 'blocked', q: 'queued', d: 'done' };

export function readableGoalClass(goal: WorkLaneDefaultGoal, letter?: string, legacyInventory = false): GoalClass {
  if (goal.total === 0) return 'queued';
  if (letter && classes[letter]) return classes[letter];
  if (legacyInventory) return goal.state === 'in_progress' ? 'moving' : goal.state === 'done' ? 'done' : 'queued';
  if (goal.total > 0 && goal.done === goal.total) return 'done';
  if (goal.moving !== undefined && goal.blocked !== undefined && goal.working !== undefined) {
    if (goal.working) return 'working';
    if (goal.moving > 0) return 'moving';
    if (goal.blocked > 0) return 'blocked';
    return 'queued';
  }
  return goal.state === 'in_progress' ? 'moving' : goal.state === 'done' && goal.total > 0 ? 'done' : 'queued';
}

export function readableLaneClass(lane: WorkLane): LaneClass {
  if (lane.state === 'paused') return 'paused';
  if (lane.goal_classes && lane.goal_counts) return lane.goal_counts[0] > 0 ? 'moving' : lane.goal_counts[1] > 0 ? 'stalled' : 'idle';
  return (lane.goals ?? []).some(g => readableGoalClass(g, undefined, true) === 'moving') ||
    (lane.default_goal && readableGoalClass(lane.default_goal, undefined, true) === 'moving') ? 'moving' : 'idle';
}

export function readableLeadGoals(lane: WorkLane) {
  const laneClass = readableLaneClass(lane);
  const goals = (lane.goals ?? []).map((goal, index) => ({ goal, goalClass: readableGoalClass(goal, lane.goal_classes?.[index], true), isDefault: false }));
  const def = lane.default_goal;
  if (def && def.total > 0) goals.push({ goal: { ...def, goal_id: '', title: lane.title, rank: Number.MAX_SAFE_INTEGER }, goalClass: readableGoalClass(def, lane.goal_classes?.[(lane.goals ?? []).length], true), isDefault: true });
  return goals.filter(({ goalClass }) => laneClass === 'stalled' ? goalClass === 'blocked' : laneClass === 'moving' && (goalClass === 'moving' || goalClass === 'working'))
    .sort((a, b) => a.goal.rank - b.goal.rank);
}

export function readableAge(at: string | null | undefined, now = Date.now()): string | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const mins = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  return mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}
export function readableHours(hours: number | null | undefined): string | null {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
  return hours < 1 ? '<1h left' : `~${Math.round(hours)}h left`;
}
export function readableSentence(member: WorkLaneMember): string | null {
  if (member.status === 'blocked') return member.blocked_line ? `Blocked on ${member.blocked_line}` : null;
  if ((member.open_questions?.count ?? 0) > 0) return 'Waiting on your answer.';
  return member.status_line || null;
}
export function readableSeatCount(member: WorkLaneMember): string | null {
  const seats = member.seats ?? [];
  const working = seats.filter(s => s.activity === 'working').length;
  return working ? `${working}${(member.seats_total ?? seats.length) > seats.length ? '+' : ''} on it now` : null;
}
export function readableTrouble(member: WorkLaneMember, now = Date.now()): string[] {
  const result: string[] = [];
  const active = member.worked?.active_h;
  if (active != null && member.estimate_first && active > member.estimate_first.p75)
    result.push(`${(active - member.estimate_first.median).toFixed(1)}h over estimate`);
  if ((member.worked?.qa_rounds ?? 0) >= 2) result.push(`${member.worked!.qa_rounds} review rounds`);
  const labels: Record<string, string> = { analysis: 'Planning', in_progress: 'Building', needs_qa: 'In review' };
  if (member.status && labels[member.status]) {
    const times = (member.transitions ?? []).map(t => Date.parse(t.at)).filter(Number.isFinite);
    const newest = times.length ? Math.max(...times) : NaN;
    const days = Math.floor((now - newest) / 86400000);
    if (days >= 2) result.push(`${labels[member.status]} ${days}d`);
  }
  return result;
}
