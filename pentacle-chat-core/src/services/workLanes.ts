// Work lanes projection v1 (spec_pentacle__first_class_work_lanes_2026_10).
// The daemon owns lane identity, state, count and order; this module only
// validates the wire shape, applies defensive presentation rules and resolves
// the tap target. It never reorders lanes or derives counts from sessions.
import type {
  PentacleEvent,
  PentacleStreamState,
  WorkLane,
  WorkLaneLead,
  WorkLaneOwnerKind,
  WorkLaneState,
  WorkLaneTap,
  WorkLaneUpdate,
  WorkLaneUpdateKind,
  WorkLaneVisibleChat,
  WorkLanesInventory,
} from '../types/pentacle';

const LANE_STATES: readonly WorkLaneState[] = ['active', 'paused', 'blocked', 'done'];
const OWNER_KINDS: readonly WorkLaneOwnerKind[] = ['operator', 'fd'];
const AVAILABILITY = ['open', 'history', 'unavailable'] as const;
const UPDATE_KINDS: readonly WorkLaneUpdateKind[] = [
  'major_decision', 'lane_started', 'lane_completed', 'lane_blocked', 'lane_unblocked', 'milestone',
];

export const LANE_UPDATE_PUBLISH_KIND = 'lane_update';

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeLead(value: unknown): WorkLaneLead | null {
  const raw = obj(value);
  if (!raw || !str(raw.stream_id)) return null;
  const presence = obj(raw.presence) ?? {};
  const card = obj(raw.status_card) ?? {};
  return {
    stream_id: String(raw.stream_id),
    generation: str(raw.generation) ?? '',
    qualifies: raw.qualifies === true,
    status: str(raw.status) ?? '',
    visibility: str(raw.visibility) ?? '',
    presence: {
      online: presence.online === true,
      working: presence.working === true,
      capture_liveness: str(presence.capture_liveness) ?? '',
      last_activity: str(presence.last_activity),
    },
    status_card: {
      goal: str(card.goal),
      active_step: str(card.active_step),
      update: str(card.update),
      eta_at: str(card.eta_at),
      eta_set_at: str(card.eta_set_at),
      updated_at: str(card.updated_at),
    },
    eta_stale: raw.eta_stale === true,
  };
}

function normalizeVisibleChat(value: unknown): WorkLaneVisibleChat | null {
  const raw = obj(value);
  if (!raw || !str(raw.stream_id)) return null;
  const available = AVAILABILITY.find((item) => item === raw.available);
  if (!available) return null;
  return {
    stream_id: String(raw.stream_id),
    generation: str(raw.generation),
    kind: raw.kind === 'composite' ? 'composite' : 'session',
    available,
  };
}

function normalizeLane(value: unknown): WorkLane | null {
  const raw = obj(value);
  if (!raw || !str(raw.lane_id)) return null;
  const state = LANE_STATES.find((item) => item === raw.state);
  const ownerKind = OWNER_KINDS.find((item) => item === raw.owner_kind);
  const visibleChat = normalizeVisibleChat(raw.visible_chat);
  if (!state || !ownerKind || !visibleChat) return null;
  const lead = normalizeLead(raw.lead);
  const lastRaw = obj(raw.last_update);
  const lastKind = UPDATE_KINDS.find((item) => item === lastRaw?.kind);
  // The daemon already presents `paused` for an active lane with no qualifying
  // lead. Re-assert it so a stale or older projection can never show ACTIVE
  // for work nobody is visibly leading.
  const unled = state === 'active' && (!lead || !lead.qualifies);
  return {
    lane_id: String(raw.lane_id),
    title: str(raw.title) ?? '',
    summary: str(raw.summary) ?? '',
    state: unled ? 'paused' : state,
    state_reason: unled ? 'lead_lost_unreconciled' : str(raw.state_reason) ?? '',
    blocker: str(raw.blocker),
    owner_kind: ownerKind,
    version: typeof raw.version === 'number' ? raw.version : 0,
    updated_at: str(raw.updated_at) ?? '',
    first_admitted_at: str(raw.first_admitted_at),
    done_at: str(raw.done_at),
    lead,
    visible_chat: visibleChat,
    last_update: lastRaw && lastKind && str(lastRaw.update_id)
      ? {
        update_id: String(lastRaw.update_id),
        kind: lastKind,
        event_id: typeof lastRaw.event_id === 'number' ? lastRaw.event_id : 0,
        ts: str(lastRaw.ts) ?? '',
      }
      : null,
  };
}

export function normalizeWorkLanesInventory(value: unknown): WorkLanesInventory | null {
  const raw = obj(value);
  if (!raw || !Array.isArray(raw.lanes)) return null;
  // Server order is preserved; `done` is history, never a header lane.
  const lanes = raw.lanes
    .map(normalizeLane)
    .filter((lane): lane is WorkLane => lane !== null && lane.state !== 'done');
  const counts = obj(raw.counts);
  const num = (key: string, fallback: number) =>
    typeof counts?.[key] === 'number' && Number.isFinite(counts[key]) ? Number(counts[key]) : fallback;
  const tally = (state: WorkLaneState) => lanes.filter((lane) => lane.state === state).length;
  const active = num('active', tally('active'));
  const paused = num('paused', tally('paused'));
  const blocked = num('blocked', tally('blocked'));
  return {
    lanes,
    counts: { open: num('open', active + paused + blocked), active, paused, blocked },
    truncated: raw.truncated === true,
    generated_at: str(raw.generated_at) ?? '',
  };
}

export function applyWorkLanesInventory(state: PentacleStreamState, value: unknown): PentacleStreamState {
  const inventory = normalizeWorkLanesInventory(value);
  if (!inventory) return state;
  // The daemon re-sends on every session-inventory recompute; an identical
  // projection must keep identity so subscribers do not re-render.
  if (state.workLanes && JSON.stringify(state.workLanes) === JSON.stringify(inventory)) return state;
  return { ...state, workLanes: inventory };
}

export function selectWorkLanes(state: Pick<PentacleStreamState, 'workLanes'>): WorkLane[] {
  return state.workLanes?.lanes ?? EMPTY_LANES;
}

const EMPTY_LANES: WorkLane[] = [];

/** Header count: the daemon's `counts.open` (active + paused + blocked). */
export function selectOpenLaneCount(state: Pick<PentacleStreamState, 'workLanes'>): number {
  return state.workLanes?.counts.open ?? 0;
}

export function selectWorkLaneCounts(state: Pick<PentacleStreamState, 'workLanes'>) {
  return state.workLanes?.counts ?? { open: 0, active: 0, paused: 0, blocked: 0 };
}

/**
 * Where a tap on a lane goes. `unavailable` never falls back to Bart, a hidden
 * worker or a new generation; a closed chat without a generation cannot be read.
 */
export function resolveWorkLaneTap(lane: Pick<WorkLane, 'visible_chat'>): WorkLaneTap {
  const chat = lane.visible_chat;
  if (chat.available === 'open') return { action: 'open_chat', stream_id: chat.stream_id };
  if (chat.available === 'history' && chat.generation) {
    return { action: 'history', stream_id: chat.stream_id, generation: chat.generation };
  }
  return { action: 'unavailable' };
}

/** Typed lane update carried by a composite `publish_kind: 'lane_update'` event, else null. */
export function parseLaneUpdateEvent(event: Pick<PentacleEvent, 'publish_kind' | 'raw'>): WorkLaneUpdate | null {
  if (event.publish_kind !== LANE_UPDATE_PUBLISH_KIND) return null;
  const raw = obj(obj(event.raw)?.lane_update);
  if (!raw) return null;
  const kind = UPDATE_KINDS.find((item) => item === raw.kind);
  const updateId = str(raw.update_id);
  const laneId = str(raw.lane_id);
  const summary = str(raw.summary);
  if (!kind || !updateId || !laneId || summary === null) return null;
  const source = obj(raw.source);
  const state = (value: unknown) => LANE_STATES.find((item) => item === value) ?? null;
  const owner = OWNER_KINDS.find((item) => item === raw.owner_kind) ?? null;
  return {
    update_id: updateId,
    lane_id: laneId,
    kind,
    summary,
    source: {
      type: str(source?.type) ?? '',
      id: str(source?.id) ?? '',
      ...(Array.isArray(source?.grouped_ids)
        ? { grouped_ids: source.grouped_ids.filter((id): id is string => typeof id === 'string') }
        : {}),
    },
    state: state(raw.state),
    prior_state: state(raw.prior_state),
    owner_kind: owner,
    title: str(raw.title) ?? '',
    ts: str(raw.ts) ?? '',
  };
}
