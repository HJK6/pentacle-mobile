// Mobile selectors over the daemon's work-lanes projection (spec
// spec_pentacle__first_class_work_lanes_2026_10 D8). Lane identity, state, count
// and order are daemon facts; nothing here derives them from chat sessions.
import {
  parseLaneUpdateEvent, peekEventsForStream, resolveWorkLaneTap, selectOpenLaneCount, selectWorkLaneCounts,
  selectWorkLanes,
  type PentacleEvent, type PentacleStreamState, type SessionStatusCard, type WorkLane, type WorkLaneState,
  type WorkLaneTap, type WorkLaneUpdate, type WorkLaneEstimate, type WorkLaneMember, type WorkLaneGoalState,
  laneIconFor, LANE_ICON_KEYS, type LaneIconKey,
} from 'pentacle-chat-core';
import { firstSummarySentence } from './summaryProse';
import { selectQuestionDeck } from '../components/questions/questionSelectors';
import { ASSISTANT_STREAM_ID } from './assistantIdentity';
import { formatLaneEta } from './laneEta';

export { selectOpenLaneCount, selectWorkLaneCounts, selectWorkLanes };

export type LaneViewModel = {
  lane: WorkLane;
  tap: WorkLaneTap;
  etaStale: boolean;
  eta: string;
};

const STATE_LABELS: Record<WorkLaneState, string> = {
  active: 'ACTIVE', paused: 'PAUSED', blocked: 'BLOCKED', done: 'DONE',
};

export function laneStateLabel(state: WorkLaneState): string {
  return STATE_LABELS[state];
}

/** Daemon `eta_stale` wins over the shared formatter's `late Xm`; blocked lanes read `Blocked`. */
export function formatLaneEtaState(lane: WorkLane, now: number): string {
  if (lane.state === 'blocked') return 'Blocked';
  const lead = lane.lead;
  if (lead?.eta_stale) return 'ETA stale';
  return formatLaneEta({ eta_at: lead?.status_card.eta_at, eta_set_at: lead?.status_card.eta_set_at, now });
}

export function selectLaneViewModels(state: PentacleStreamState, now: number): LaneViewModel[] {
  return selectWorkLanes(state).map((lane) => ({
    lane,
    tap: resolveWorkLaneTap(lane),
    etaStale: lane.lead?.eta_stale === true,
    eta: formatLaneEtaState(lane, now),
  }));
}

/** The linked lead's card in the shared status-card shape, or null when there is no lead. */
export function laneLeadStatusCard(lane: WorkLane): SessionStatusCard | null {
  const lead = lane.lead;
  if (!lead) return null;
  const card = lead.status_card;
  return {
    goal: card.goal ?? undefined,
    plan: card.active_step ? [{ text: card.active_step, status: 'active' }] : undefined,
    update: card.update ?? undefined,
    eta_at: card.eta_at,
    eta_set_at: card.eta_set_at,
    updated_at: card.updated_at ?? '',
  };
}

export type LaneUpdateEntry = { event: PentacleEvent; update: WorkLaneUpdate };

/** Typed lane updates in the assistant's visible timeline, newest first, one per message id. */
export function selectLaneUpdates(state: PentacleStreamState): LaneUpdateEntry[] {
  const seen = new Set<string>();
  const entries: LaneUpdateEntry[] = [];
  for (const event of peekEventsForStream(state, ASSISTANT_STREAM_ID)) {
    const update = parseLaneUpdateEvent(event);
    const key = event.message_id || update?.update_id;
    if (!update || !key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ event, update });
  }
  return entries.sort((a, b) => b.event.daemon_seq - a.event.daemon_seq);
}

export type LaneProgressTone = 'green' | 'amber' | 'muted' | 'red';

export type LaneProgressSegment = {
  specId: string;
  status: string;
  fraction: number;
  tone: LaneProgressTone;
  unresolved: boolean;
};

/** The single presentation model shared by the list and map. */
export type LaneCardViewModel = {
  lane: WorkLane;
  tap: WorkLaneTap;
  stateLabel: string;
  stateTone: Exclude<LaneProgressTone, 'red'>;
  segments: LaneProgressSegment[];
  progressLabel: string;
  completed: number;
  total: number;
  members: WorkLaneMember[];
  membersTotal: number;
  membersPending: boolean;
  waitingOnYou: number;
  waitingOnYouLabel: string | null;
  questionText?: string | null;
  blockerLabel: string | null;
  lastUpdateText: string | null;
  freshnessLabel: string;
  leadHost: string | null;
  presenceLabel: string;
  indexSnapshotAt: string | null;
};

export function laneCardStateLabel(lane: WorkLane): string {
  if (lane.state === 'paused') {
    return ['lead_lost', 'lead_lost_unreconciled'].includes(lane.state_reason) ? 'PAUSED · LEAD LOST' : 'PAUSED';
  }
  // An owner-loss fault: the FD is repairing it; it is not a pause and not idle work.
  if (lane.state === 'active' && lane.state_reason === 'lead_lost') return 'ACTIVE · RECOVERING';
  // Open member seats do not imply busy work; lead presence remains separate.
  if (lane.state === 'active' && lane.state_reason === 'members_working') return 'ACTIVE';
  if (lane.state === 'active') return lane.lead?.presence.working ? 'WORKING' : 'ACTIVE · IDLE';
  return laneStateLabel(lane.state);
}

function formatHours(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${Math.round(hours * 2) / 2}h`;
}

/** Coarse open-work range; never a countdown or a lead-card ETA. */
export function formatWorkLaneEstimate(estimate: WorkLaneEstimate | null | undefined, complete = true): string {
  if (!estimate) return '—';
  const low = formatHours(estimate.p25);
  const high = formatHours(estimate.p75);
  const sameUnit = low.slice(-1) === high.slice(-1);
  return `${sameUnit ? low.slice(0, -1) : low}–${high}${complete ? '' : '+'}`;
}

/** Ordered truth precedence. Absent optional counts never imply terminal work. */
export function formatLaneCardProgress(lane: WorkLane): string {
  if (lane.no_spec_reason) return lane.no_spec_reason;
  if (lane.items_total === 0) return 'No specs';
  if (lane.items_open !== undefined && lane.items_open > 0) {
    return `est. open work ${formatWorkLaneEstimate(lane.open_estimate_h, lane.estimate_complete !== false)}`;
  }
  if (lane.items_open === 0 && lane.items_total !== undefined && lane.items_total > 0) {
    if (lane.items_completed === lane.items_total) return 'All specs done';
    if (lane.items_dropped === lane.items_total) return 'All specs dropped';
    if (lane.items_completed !== undefined && lane.items_dropped !== undefined
      && lane.items_completed + lane.items_dropped === lane.items_total) return 'No open work';
  }
  return '—';
}

export function formatLaneFreshness(at: string | null | undefined, now: number): string {
  if (!at) return '—';
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return '—';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

function memberSegment(lane: WorkLane, member: WorkLaneMember): LaneProgressSegment {
  const status = member.status ?? 'unknown';
  const unresolved = status === 'missing' || status === 'ambiguous'
    || member.observation?.quality === 'missing' || member.observation?.quality === 'ambiguous';
  const live = status === 'in_progress' || status === 'needs_qa';
  const checked = member.ac_checked ?? 0;
  const fraction = unresolved ? 0 : status === 'completed' ? 1
    : live && member.ac_total ? Math.min(1, Math.max(0, checked / member.ac_total)) : 0;
  const tone: LaneProgressTone = unresolved ? 'red' : lane.state === 'paused' ? 'muted'
    : lane.state === 'blocked' ? 'amber' : status === 'deprecated' ? 'muted' : 'green';
  return { specId: member.spec_id, status, fraction, tone, unresolved };
}

export function selectLaneCardViewModels(state: PentacleStreamState, now = Date.now()): LaneCardViewModel[] {
  const questionCounts = new Map<string, number>();
  const questionPrompts = new Map<string, string>();
  for (const entry of selectQuestionDeck(state)) {
    questionCounts.set(entry.streamId, (questionCounts.get(entry.streamId) ?? 0) + 1);
    questionPrompts.set(entry.streamId, entry.question.prompt);
  }
  const updates = new Map<string, WorkLaneUpdate>();
  for (const entry of selectLaneUpdates(state)) {
    if (!updates.has(entry.update.update_id)) updates.set(entry.update.update_id, entry.update);
  }
  const index = state.workLanes?.work_index;
  return selectWorkLanes(state).map((lane) => {
    const members = lane.no_spec_reason ? [] : lane.members ?? [];
    const waitingOnYou = questionCounts.get(lane.visible_chat.stream_id) ?? 0;
    const waitingOnYouLabel = waitingOnYou > 0
      ? `Waiting on you · ${waitingOnYou} ${waitingOnYou === 1 ? 'question' : 'questions'}` : null;
    const questionPrompt = questionPrompts.get(lane.visible_chat.stream_id);
    const lastUpdate = lane.last_update ? updates.get(lane.last_update.update_id) : undefined;
    const lastUpdateText = lastUpdate?.lane_id === lane.lane_id && lastUpdate.summary
      ? lastUpdate.summary : lane.last_update ? `${lane.last_update.kind} · ${lane.last_update.ts}` : null;
    const presence = lane.lead?.presence;
    return {
      lane,
      tap: resolveWorkLaneTap(lane),
      stateLabel: laneCardStateLabel(lane),
      stateTone: lane.state === 'blocked' ? 'amber' : lane.state === 'paused' ? 'muted' : 'green',
      segments: members.map((member) => memberSegment(lane, member)),
      progressLabel: formatLaneCardProgress(lane),
      completed: lane.items_completed ?? 0,
      total: lane.items_total ?? lane.members_total ?? members.length,
      members,
      membersTotal: lane.no_spec_reason ? 0 : lane.members_total ?? members.length,
      membersPending: !lane.no_spec_reason && lane.members === undefined,
      waitingOnYou,
      waitingOnYouLabel,
      questionText: questionPrompt?.trim() || null,
      blockerLabel: waitingOnYou === 1
        ? lane.blocker || (questionPrompt?.trim() ? `Waiting on you: ${questionPrompt}` : waitingOnYouLabel)
        : waitingOnYouLabel ?? lane.blocker,
      lastUpdateText,
      freshnessLabel: formatLaneFreshness(lane.freshness_at ?? lane.updated_at, now),
      leadHost: lane.lead?.stream_id.split(':')[0] || null,
      presenceLabel: !presence ? 'no lead' : !presence.online ? 'offline' : presence.working ? 'working' : 'idle',
      indexSnapshotAt: index?.available === false ? index.snapshot_at ?? '' : null,
    };
  });
}

export const memberHasLiveSeat = (member: WorkLaneMember) =>
  member.seats?.some((seat) => seat.activity === "working") === true;
export const laneNeedsYou = (lane: WorkLane) =>
  lane.state !== "done" &&
  (lane.members ?? []).some(
    (member) => (member.open_questions?.count ?? 0) > 0,
  );

export type LaneGoalPart = {
  goalId: string | null;
  title: string;
  state: WorkLaneGoalState;
  done: number;
  total: number;
  fraction: number;
  tone: 'green' | 'amber' | 'muted';
  fallback?: boolean;
};
const inferredGoalState = (done: number, total: number, members: WorkLaneMember[]): WorkLaneGoalState =>
  total > 0 && done === total ? 'done'
    : done > 0 || members.some(m => ['analysis', 'ready_for_dev', 'in_progress', 'blocked', 'needs_qa'].includes(m.status ?? ''))
      ? 'in_progress' : 'not_started';

/** Named goal progress is an uncapped daemon fact. Only the transitional fallback uses inline rows. */
export function laneGoalParts(lane: WorkLane): LaneGoalPart[] {
  const make = (goalId: string | null, title: string, state: WorkLaneGoalState, done: number, total: number, fallback = false): LaneGoalPart => ({
    goalId, title, state, done, total, fraction: total > 0 ? done / total : 0,
    tone: lane.state === 'blocked' && state === 'in_progress' ? 'amber'
      : state === 'not_started' ? 'muted' : 'green',
    ...(fallback ? { fallback: true } : {}),
  });
  const named = [...(lane.goals ?? [])].sort((a, b) => a.rank - b.rank || (a.goal_id < b.goal_id ? -1 : a.goal_id > b.goal_id ? 1 : 0));
  const members = (lane.members ?? []).filter(m => m.terminal !== 'deprecated' && m.status !== 'deprecated');
  if (!named.length) {
    const total = Math.max(0, (lane.items_total ?? lane.members_total ?? (lane.members ?? []).length) - (lane.items_dropped ?? 0));
    const done = lane.items_completed ?? 0;
    return total > 0 ? [make(null, lane.title, inferredGoalState(done, total, members), done, total)] : [];
  }
  const parts = named.map(g => make(g.goal_id, g.title, g.state, g.done, g.total));
  const unassigned = members.filter(m => !m.goal_id);
  const done = unassigned.filter(m => m.terminal === 'completed' || m.status === 'completed').length;
  const defaultGoal = lane.default_goal ?? { done, total: unassigned.length, state: inferredGoalState(done, unassigned.length, unassigned) };
  if (defaultGoal.total > 0) parts.push(make(null, lane.title, defaultGoal.state, defaultGoal.done, defaultGoal.total, !lane.default_goal));
  return parts;
}

export function laneTopGoals(lane: WorkLane): LaneGoalPart[] {
  const parts = laneGoalParts(lane), active = parts.filter(g => g.state === 'in_progress');
  return active.length ? active.slice(0, 2) : parts.slice(0, 1);
}

export function laneRowMeta(lane: WorkLane) {
  const top = laneTopGoals(lane)[0];
  return { title: top?.goalId ? top.title : null, count: `${top?.done ?? 0}/${top?.total ?? 0}` };
}

export function laneRowDetail(model: LaneCardViewModel): { text: string; tone: 'amber' | 'muted' } {
  if (model.lane.state === 'blocked') return { text: model.blockerLabel ?? '', tone: 'amber' };
  if (laneNeedsYou(model.lane) || model.waitingOnYou > 0)
    return { text: (model.questionText ?? model.blockerLabel ?? model.waitingOnYouLabel ?? '').replace(/^Waiting on you:\s*/i, ''), tone: 'amber' };
  if (model.lane.state === 'paused') return { text: model.freshnessLabel, tone: 'muted' };
  return { text: [model.leadHost, formatWorkLaneEstimate(model.lane.open_estimate_h, model.lane.estimate_complete !== false)].filter(Boolean).join(' · '), tone: 'muted' };
}
export const laneWorking = (lane: WorkLane) =>
  lane.state === "active" &&
  (lane.lead?.presence.working === true ||
    (lane.members ?? []).some(memberHasLiveSeat));
export type LaneFlowGroup = "needsYou" | "working" | "paused";
export function laneFlowGroup(lane: WorkLane): LaneFlowGroup {
  if (lane.state === "blocked" || laneNeedsYou(lane)) return "needsYou";
  return lane.state === "paused" ? "paused" : "working";
}
export function laneFlowRank(lane: WorkLane): number {
  return lane.state === "blocked"
    ? 0
    : laneNeedsYou(lane)
      ? 1
      : laneWorking(lane)
        ? 2
        : lane.state === "active"
          ? 3
          : 4;
}
const stamp = (value: string | null | undefined) => {
  const n = Date.parse(value ?? "");
  return Number.isFinite(n) ? n : 0;
};
export function laneRingOrder(lanes: readonly WorkLane[]): WorkLane[] {
  return [...lanes].sort(
    (a, b) =>
      laneFlowRank(a) - laneFlowRank(b) ||
      stamp(b.last_update?.ts) - stamp(a.last_update?.ts) ||
      a.lane_id.localeCompare(b.lane_id),
  );
}
export function lanePausedAge(lane: WorkLane, now: number): number {
  return Math.max(0, now - stamp(lane.last_update?.ts ?? lane.updated_at));
}
export function laneOrbits(lanes: readonly WorkLane[], now: number) {
  const ordered = laneRingOrder(lanes.filter((lane) => lane.state !== "done"));
  const active = ordered.filter((lane) => lane.state !== "paused");
  const paused = ordered.filter((lane) => lane.state === "paused");
  const dormant = paused.filter(
    (lane) => lanePausedAge(lane, now) >= 14 * 86400000,
  );
  return {
    inner: active.slice(0, 6),
    overflow: active.slice(6),
    paused: paused.filter((lane) => !dormant.includes(lane)),
    dormant,
  };
}
export function resolveLaneIcon(lane: Pick<WorkLane, "title" | "icon">): {
  key: LaneIconKey | null;
  monogram: string;
} {
  const key =
    LANE_ICON_KEYS.find((key) => key === lane.icon) ?? laneIconFor(lane.title);
  const words = lane.title.trim().split(/\s+/).filter(Boolean);
  const monogram =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => Array.from(word)[0])
          .join("")
      : Array.from(words[0] ?? "?")
          .slice(0, 2)
          .join("");
  return { key, monogram: monogram.toLocaleUpperCase("en-US") };
}
export type SpecGroups = {
  inProgress: WorkLaneMember[];
  ready: WorkLaneMember[];
  backlog: WorkLaneMember[];
  done: WorkLaneMember[];
  other: WorkLaneMember[];
};
export function specGroups(members: readonly WorkLaneMember[]): SpecGroups {
  const groups: SpecGroups = {
    inProgress: [],
    ready: [],
    backlog: [],
    done: [],
    other: [],
  };
  const ordered = [...members].sort(
    (a, b) =>
      stamp(b.source_changed_at) - stamp(a.source_changed_at) ||
      a.spec_id.localeCompare(b.spec_id),
  );
  for (const member of ordered) {
    const status = member.status;
    const key =
      status === "completed" || status === "deprecated"
        ? "done"
        : ["in_progress", "needs_qa", "blocked"].includes(status ?? "") ||
            (status === "analysis" && memberHasLiveSeat(member))
          ? "inProgress"
          : status === "ready_for_dev" || status === "analysis"
            ? "ready"
            : status === "backlog"
              ? "backlog"
              : "other";
    groups[key].push(member);
  }
  return groups;
}
export function specDetailModel(member: WorkLaneMember) {
  const present = (
    key: "status_line" | "next_line",
    fallback: string | null | undefined,
  ) =>
    Object.prototype.hasOwnProperty.call(member, key)
      ? (member[key] ?? null)
      : firstSummarySentence(fallback);
  const criteria = [...(member.criteria ?? [])].sort(
    (a, b) =>
      (a.disposition === "done" ? 2 : a.disposition === "open" ? 0 : 1) -
      (b.disposition === "done" ? 2 : b.disposition === "open" ? 0 : 1),
  );
  return {
    status: present("status_line", member.status_text),
    next: present("next_line", member.next_action_text),
    criteria,
    since: member.transitions?.at(-1)?.at ?? null,
  };
}
