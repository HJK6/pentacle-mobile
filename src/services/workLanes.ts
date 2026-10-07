// Mobile selectors over the daemon's work-lanes projection (spec
// spec_pentacle__first_class_work_lanes_2026_10 D8). Lane identity, state, count
// and order are daemon facts; nothing here derives them from chat sessions.
import {
  parseLaneUpdateEvent, peekEventsForStream, resolveWorkLaneTap, selectOpenLaneCount, selectWorkLaneCounts,
  selectWorkLanes,
  type PentacleEvent, type PentacleStreamState, type SessionStatusCard, type WorkLane, type WorkLaneState,
  type WorkLaneTap, type WorkLaneUpdate,
} from 'pentacle-chat-core';
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
