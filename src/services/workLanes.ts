// Mobile selectors over the daemon's work-lanes projection (spec
// spec_pentacle__first_class_work_lanes_2026_10 D8). Lane identity, state, count
// and order are daemon facts; nothing here derives them from chat sessions.
import {
  parseLaneUpdateEvent, peekEventsForStream, resolveWorkLaneTap, selectOpenLaneCount, selectWorkLaneCounts,
  selectWorkLanes,
  type PentacleEvent, type PentacleStreamState, type SessionStatusCard, type WorkLane, type WorkLaneState,
  type WorkLaneTap, type WorkLaneUpdate, type WorkLaneEstimate, type WorkLaneMember,
} from 'pentacle-chat-core';
import { selectQuestionDeck } from '../components/questions/questionSelectors';
import { BART_STREAM_ID } from '../components/status/statusSelectors';
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

/** Typed lane updates in Bart's visible timeline, newest first, one per message id. */
export function selectLaneUpdates(state: PentacleStreamState): LaneUpdateEntry[] {
  const seen = new Set<string>();
  const entries: LaneUpdateEntry[] = [];
  for (const event of peekEventsForStream(state, BART_STREAM_ID)) {
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
  if (lane.items_unresolved !== undefined && lane.items_unresolved > 0) return `${lane.items_unresolved} unresolved`;
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
  for (const entry of selectQuestionDeck(state)) {
    questionCounts.set(entry.streamId, (questionCounts.get(entry.streamId) ?? 0) + 1);
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
      blockerLabel: waitingOnYouLabel ?? lane.blocker,
      lastUpdateText,
      freshnessLabel: formatLaneFreshness(lane.freshness_at ?? lane.updated_at, now),
      leadHost: lane.lead?.stream_id.split(':')[0] || null,
      presenceLabel: !presence ? 'no lead' : !presence.online ? 'offline' : presence.working ? 'working' : 'idle',
      indexSnapshotAt: index?.available === false ? index.snapshot_at ?? '' : null,
    };
  });
}
