import type { PentacleNotification, PentacleSessionSummary, WorkLane, WorkLaneMember, WorkLaneShow, WorkLanesInventory } from 'pentacle-chat-core';
import { ASSISTANT_STREAM_ID } from '../services/assistantIdentity';

/** Item shorthand: status, then w = a seat working now, ? = open question, e = no estimate. */
type Item = [status: string, flags?: string];
type GoalPlan = { title: string; items: Item[] };
type LanePlan = {
  title: string; icon: string; state?: 'active' | 'paused'; progressH: number; stateH?: number; question?: boolean;
  parked?: { at: string | null; reason: string | null } | unknown; goals: GoalPlan[]; loose?: Item[]; road?: boolean; classes?: boolean;
};
export type RoadmapVariant = 'views' | 'overflow' | 'loose' | 'loose_done' | 'no_classes' | 'malformed';

const sentences: Record<string, string> = {
  in_progress: 'Building the screen against the fixtures.', needs_qa: 'Waiting for the final review.', analysis: 'Writing the plan.',
  ready_for_dev: 'Ready to start.', backlog: 'Not started.', completed: 'Shipped.', blocked: 'Waiting on the build window.',
};
const titles = ['Draw the road', 'Hatch blocked rings', 'Open screens from the tap', 'Keep the map in agreement', 'Show parked lanes',
  'Move only where work happens', 'Answer from the card', 'Number the stops', 'Fold long lists', 'Mark items by shape', 'Check three widths', 'Load every page'];
const open = (status: string) => status !== 'completed' && status !== 'deprecated';

function plans(variant: RoadmapVariant, at: (hours: number) => string): LanePlan[] {
  const q = (n: number, status = 'backlog'): Item[] => Array.from({ length: n }, () => [status]);
  const road: GoalPlan[] = [
    { title: 'Readable lane screens', items: q(5, 'completed') },
    { title: 'Goal order from the daemon', items: q(3, 'completed') },
    { title: 'Roadmap screens', items: [['in_progress', 'w'], ['needs_qa'], ['in_progress'], ['blocked'], ['ready_for_dev'], ['analysis'], ['backlog'], ['backlog'], ['completed'], ['completed']] },
    { title: 'Question cards on home', items: [['in_progress'], ['ready_for_dev'], ['completed'], ['backlog', 'e']] },
    { title: 'Parked lanes', items: [['blocked'], ['blocked'], ['backlog'], ['completed']] },
    { title: 'Release notes', items: [] },
    { title: 'Web lanes screens', items: q(3) },
    { title: 'Daemon goal rule', items: [['ready_for_dev'], ['backlog']] },
    { title: 'Faster lane detail', items: q(2) },
    { title: 'Lane history', items: q(4) },
  ];
  if (variant === 'overflow') return [{ title: 'Long road', icon: 'columns', progressH: 3, road: false,
    goals: Array.from({ length: 11 }, (_, i) => ({ title: `Stage ${i + 1}`, items: i === 9 ? [['in_progress'], ['backlog']] : q(2) })) }];
  if (variant === 'loose' || variant === 'loose_done') return [{ title: 'Unplaced work', icon: 'wrench', progressH: 2,
    goals: [{ title: 'Placed goal', items: [['in_progress'], ['backlog']] }],
    loose: variant === 'loose' ? [['in_progress'], ['backlog'], ['completed'], ['completed']] : q(8, 'completed') }];
  if (variant === 'no_classes') return [{ title: 'Older daemon', icon: 'bot', progressH: 1, classes: false,
    goals: [{ title: 'Moving goal', items: [['in_progress'], ['backlog']] }, { title: 'Queued goal', items: q(2) }] }];
  if (variant === 'malformed') return [
    { title: 'Bad parked key', icon: 'key', progressH: 1, parked: 'yes', goals: [{ title: 'Still listed', items: [['in_progress'], ['backlog']] }] },
    { title: 'Bad goal road', icon: 'shield', progressH: 1, road: false, goals: [{ title: 'Still listed', items: [['in_progress']] }] },
  ];
  return [
    { title: 'Pentacle', icon: 'pentacle', progressH: 0.2, goals: road },
    { title: 'Mobile app', icon: 'phone', progressH: 1, question: true, goals: [
      { title: 'Signed builds', items: [['in_progress', '?'], ['in_progress'], ['completed'], ['completed'], ['backlog']] },
      { title: 'Voice capture', items: [['needs_qa'], ['completed'], ['ready_for_dev']] },
      { title: 'Offline drafts', items: q(3) }] },
    { title: 'Test harness', icon: 'flask', progressH: 3, goals: [
      { title: 'Stable simulator runs', items: [['in_progress'], ['blocked'], ['completed']] },
      { title: 'Release gate', items: [['blocked'], ['blocked'], ['backlog']] }, { title: 'Faster suites', items: q(2) }] },
    { title: 'Web client', icon: 'cursor', progressH: 5, question: true, goals: [
      { title: 'Message delivery', items: [['in_progress', '?'], ['needs_qa'], ['completed']] }, { title: 'Table formatting', items: q(2) }] },
    { title: 'Support desk', icon: 'headset', progressH: 8, goals: [{ title: 'Reply templates', items: [['in_progress'], ['completed'], ['ready_for_dev']] }] },
    { title: 'Media library', icon: 'film', progressH: 20, goals: [{ title: 'Import queue', items: [['needs_qa'], ['backlog']] }, { title: 'Thumbnails', items: q(3) }] },
    { title: 'Servers', icon: 'server', progressH: 30, goals: [{ title: 'Disk alarms', items: [['in_progress'], ['completed'], ['completed']] }] },
    { title: 'Paperwork', icon: 'briefcase', state: 'paused', progressH: 72, stateH: 50, goals: [{ title: 'Quarterly filing', items: [['completed'], ['ready_for_dev'], ['backlog']] }] },
    { title: 'Garden', icon: 'leaf', progressH: 96, goals: [{ title: 'Watering schedule', items: [['blocked'], ['backlog']] }, { title: 'Seed order', items: q(2) }] },
    { title: 'Home', icon: 'home', progressH: 120, goals: [{ title: 'Light timers', items: [['completed'], ['ready_for_dev']] }] },
    { title: 'Docs', icon: 'book', progressH: 200, goals: [{ title: 'Setup guide', items: q(3) }] },
    { title: 'Camera rig', icon: 'camera', state: 'paused', progressH: 400, stateH: 300, parked: { at: at(13 * 24), reason: 'Waiting for the new lens to arrive.' },
      goals: [{ title: 'Calibrate', items: q(3) }, { title: 'Mount', items: q(2) }] },
    { title: 'Market review', icon: 'chart', state: 'paused', progressH: 600, stateH: 500, parked: { at: null, reason: null }, goals: [{ title: 'Weekly notes', items: q(2) }] },
  ];
}

function letter(items: WorkLaneMember[]): string {
  if (items.length && items.every(m => !open(m.status ?? ''))) return 'd';
  const unfinished = items.filter(m => open(m.status ?? ''));
  if (unfinished.some(m => m.seats?.some(s => s.activity === 'working'))) return 'w';
  if (unfinished.some(m => ['in_progress', 'needs_qa'].includes(m.status ?? '') || (m.open_questions?.count ?? 0) > 0)) return 'm';
  if (unfinished.some(m => m.status === 'blocked')) return 'b';
  return 'q';
}

/** Lanes, goals and items for the roadmap screens, shaped as the final daemon wire contract (relay f56d9b50). */
export function lanesRoadmapFixture(variant: RoadmapVariant = 'views', now = Date.now()) {
  const at = (hours: number) => new Date(now - hours * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const notifications: PentacleNotification[] = [], sessions: PentacleSessionSummary[] = [];
  const shows: Record<string, WorkLaneShow> = {};
  const lanes = plans(variant, at).map((plan, li) => {
    const laneId = `road-lane-${variant}-${li + 1}`, lead = `hosta:road-lead-${variant}-${li + 1}`;
    let n = 0, questionId: string | null = null;
    const member = (goalId: string | null, [status, flags = '']: Item): WorkLaneMember => {
      const i = n++, id = `spec_road__${variant}_${li + 1}_${i + 1}`, working = flags.includes('w'), asks = flags.includes('?');
      if (asks) questionId = `q-road-${variant}-${li + 1}`;
      const seat = { stream_id: lead, role: 'lead', host: 'hosta', visibility: 'hidden', activity: working ? 'working' as const : 'idle' as const, last_activity: at(0) };
      return {
        spec_id: id, goal_id: goalId, title: titles[i % titles.length] + (i >= titles.length ? ` ${Math.floor(i / titles.length) + 1}` : ''), status,
        terminal: status === 'completed' ? 'completed' : null, ac_checked: status === 'completed' ? 4 : i % 4, ac_total: 4,
        estimate: flags.includes('e') || !open(status) ? null : { p25: 1, median: 2, p75: 3 },
        seats: ['in_progress', 'needs_qa'].includes(status) || working ? [seat] : [], seats_total: ['in_progress', 'needs_qa'].includes(status) || working ? 1 : 0,
        open_questions: { count: asks ? 1 : 0, first_question_id: asks ? questionId : null },
        status_line: sentences[status] ?? null, next_line: open(status) ? 'Check the captures.' : null,
        blocked_line: status === 'blocked' ? 'the build window' : null, summary_line: 'Make the lane easy to read at a glance.',
        progress_at: status === 'completed' ? at(24 * (2 + (i % 5))) : at(plan.progressH + i / 10),
        criteria: [{ title: 'Matches the approved mock', disposition: 'done' }, { title: 'Works with reduce motion', disposition: 'open' }],
      };
    };
    const goalMembers = plan.goals.map((g, gi) => g.items.map(item => member(`g_road_${variant}_${li + 1}_${gi + 1}`, item)));
    const loose = (plan.loose ?? []).map(item => member(null, item));
    const members = [...goalMembers.flat(), ...loose];
    const aggregate = (items: WorkLaneMember[]) => {
      const done = items.filter(m => m.status === 'completed').length, unfinished = items.filter(m => open(m.status ?? ''));
      const progress = items.map(m => m.progress_at!).sort().at(-1) ?? null;
      return { state: items.length && done === items.length ? 'done' as const : unfinished.some(m => ['in_progress', 'needs_qa'].includes(m.status ?? '')) ? 'in_progress' as const : 'not_started' as const,
        done, total: items.length, moving: unfinished.filter(m => ['in_progress', 'needs_qa'].includes(m.status ?? '')).length,
        blocked: unfinished.filter(m => m.status === 'blocked').length, working: letter(items) === 'w',
        left_h: unfinished.some(m => m.estimate) ? unfinished.reduce((sum, m) => sum + (m.estimate?.median ?? 0), 0) : null, progress_at: progress };
    };
    const letters = goalMembers.map(letter);
    const goals = plan.goals.map((g, gi) => ({ goal_id: `g_road_${variant}_${li + 1}_${gi + 1}`, title: g.title, rank: (gi + 1) * 10, ...aggregate(goalMembers[gi]),
      ...(plan.road === false ? {} : { pos: gi }) }));
    const defaultGoal = loose.length ? aggregate(loose) : { state: 'not_started' as const, done: 0, total: 0 };
    const sent = goals.slice(0, 8);
    const classes = plan.classes === false ? {} : {
      goal_classes: `${letters.slice(0, 8).join('')}${loose.length ? letter(loose) : '-'}`,
      goal_counts: [letters.filter(l => l === 'w' || l === 'm').length + (loose.length && /[wm]/.test(letter(loose)) ? 1 : 0),
        letters.filter(l => l === 'b').length, letters.filter(l => l === 'q').length, letters.filter(l => l === 'd').length],
      ...(plan.road === false ? variant === 'malformed' ? { goal_road: 'mq' } : {} : { goal_road: letters.join('') }),
    };
    const working = letters.includes('w');
    const lane = {
      lane_id: laneId, icon: plan.icon, title: plan.title, summary: 'A synthetic lane for the roadmap screens.', state: plan.state ?? 'active',
      state_reason: plan.state === 'paused' ? 'paused' : 'members_working', blocker: null, owner_kind: 'operator', version: 1, updated_at: at(plan.progressH),
      first_admitted_at: at(900), done_at: null,
      lead: { stream_id: lead, generation: 'road-generation', qualifies: true, status: 'open', visibility: 'hidden',
        presence: { online: true, working, capture_liveness: 'live', last_activity: at(0) },
        status_card: { goal: plan.title, active_step: null, update: null, eta_at: null, eta_set_at: null, updated_at: at(0) }, eta_stale: false },
      visible_chat: { stream_id: lead, generation: 'road-generation', kind: 'session', available: 'open' }, last_update: null,
      members: members.slice(0, 8).map(({ criteria, ...inline }) => inline), members_total: members.length,
      items_total: members.length, items_open: members.filter(m => open(m.status ?? '')).length, items_completed: members.filter(m => m.status === 'completed').length, items_dropped: 0,
      goals: sent, goals_total: goals.length, default_goal: defaultGoal, ...classes,
      progress_at: at(plan.progressH), state_at: at(plan.stateH ?? plan.progressH), ...(plan.parked !== undefined ? { parked: plan.parked } : {}),
    } as unknown as WorkLane;
    // The open question's member is inline so the home card sees it, as the list frame does for open questions.
    const asking = members.find(m => m.open_questions?.count);
    if (asking && !lane.members!.some(m => m.spec_id === asking.spec_id)) lane.members = [...lane.members!.slice(0, 7), asking];
    shows[laneId] = { lane_id: laneId, projection: { ...lane, goals } as WorkLane, members, updates: [], spec_changes: [], events: [] };
    if (questionId) {
      sessions.push({ stream_id: lead, host: 'hosta', provider: 'codex', session_name: `road-lead-${li + 1}`, title: plan.title, online: true, working: false,
        draft: '', pending: false, last_event_at: at(0), last_kind: 'ASSIST_TEXT', last_text: 'Ready for review.' } as PentacleSessionSummary);
      notifications.push({ notification_id: `road-question-${li + 1}`, created_at: at(0.5), updated_at: at(0.5), producer: 'agent_question.v1', answer_to_stream_id: lead,
        severity: 'info', title: plan.title, body: li === 1 ? 'Ship the signed build tonight or wait for the morning?' : 'Which table style should web chat use?',
        dedup_key: `road-question-${li + 1}`, state: 'open', actions: [{ kind: 'ack', action_id: 'answer' }],
        question: { question_id: questionId, producer_stream_id: lead, state: 'open', response_mode: 'single_choice',
          options: [{ label: 'Tonight', value: 'tonight' }, { label: 'In the morning', value: 'morning' }] } } as unknown as PentacleNotification);
    }
    return lane;
  });
  const inventory: WorkLanesInventory = { lanes, counts: { open: lanes.length, active: lanes.filter(l => l.state === 'active').length, paused: lanes.filter(l => l.state === 'paused').length, blocked: 0 },
    truncated: false, generated_at: at(0) };
  sessions.unshift({ stream_id: ASSISTANT_STREAM_ID, host: 'hosta', provider: 'composite', session_name: 'assistant', title: 'Assistant', online: true, working: false,
    draft: '', pending: false, last_event_at: at(0), last_kind: 'ASSIST_TEXT', last_text: 'Ready.' } as PentacleSessionSummary);
  return { inventory, shows, notifications, sessions };
}
