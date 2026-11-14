// Work lanes projection v1 (spec_pentacle__first_class_work_lanes_2026_10).
// The daemon owns lane identity, state, count and order; this module only
// validates the wire shape, applies defensive presentation rules and resolves
// the tap target. It never reorders lanes or derives counts from sessions.
import type {
  PentacleEvent,
  PentacleStreamState,
  WorkLane,
  WorkLaneLead,
  WorkLaneEstimate,
  WorkLaneDefaultGoal,
  WorkLaneGoal,
  WorkLaneLogEvent,
  WorkLaneLogUpdate,
  WorkLaneMember,
  WorkLaneRecent,
  WorkLaneSeat,
  WorkLaneObservation,
  WorkLaneOwnerKind,
  WorkLaneShow,
  WorkLaneSpecChange,
  WorkLaneState,
  WorkLaneTap,
  WorkLaneUpdate,
  WorkLaneUpdateKind,
  WorkLaneVisibleChat,
  WorkLanesInventory,
  WorkIndex,
} from '../types/pentacle';
import { LANE_ICON_KEYS, type LaneIconKey } from './laneIcons';

const LANE_STATES: readonly WorkLaneState[] = ['active', 'paused', 'blocked', 'done'];
const OWNER_KINDS: readonly WorkLaneOwnerKind[] = ['operator', 'fd'];
const AVAILABILITY = ['open', 'history', 'unavailable'] as const;
const UPDATE_KINDS: readonly WorkLaneUpdateKind[] = [
  'major_decision', 'lane_started', 'lane_completed', 'lane_blocked', 'lane_unblocked', 'milestone',
];

export const LANE_UPDATE_PUBLISH_KIND = 'lane_update';
const COUNT_KEYS = ['open', 'active', 'paused', 'blocked'] as const;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
}

function nullableCount(value: unknown): value is number | null {
  return value === null || count(value);
}

function normalizeEstimate(value: unknown): WorkLaneEstimate | null | undefined {
  if (value === null) return null;
  const raw = obj(value);
  const hours = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!raw || !hours(raw.p25) || !hours(raw.p75) || !hours(raw.median)
    || raw.p25 > raw.median || raw.median > raw.p75) return undefined;
  return {
    p25: raw.p25, p75: raw.p75, median: raw.median,
    ...(typeof raw.provisional === 'boolean' ? { provisional: raw.provisional } : {}),
  };
}

function normalizeObservation(value: unknown): WorkLaneObservation | undefined {
  const raw = obj(value);
  const qualities: readonly WorkLaneObservation['quality'][] = ['fresh', 'stale', 'error', 'missing', 'ambiguous'];
  const quality = qualities.find((item) => item === raw?.quality);
  if (!raw || !quality) return undefined;
  return {
    quality,
    ...(nullableString(raw.observed_at) ? { observed_at: raw.observed_at } : {}),
    ...(nullableString(raw.error) ? { error: raw.error } : {}),
  };
}

const SEAT_ACTIVITY: readonly WorkLaneSeat['activity'][] = ['working', 'idle', 'offline', 'unknown'];

function normalizeSeat(value: unknown): WorkLaneSeat | null {
  const raw = obj(value);
  const streamId = str(raw?.stream_id);
  if (!raw || !streamId) return null;
  return {
    stream_id: streamId,
    role: str(raw.role),
    host: str(raw.host),
    visibility: str(raw.visibility),
    activity: SEAT_ACTIVITY.find((item) => item === raw.activity) ?? 'unknown',
    last_activity: str(raw.last_activity),
  };
}

function normalizeRecent(value: unknown): WorkLaneRecent[] | undefined {
  if (!Array.isArray(value) || value.length > 6) return undefined;
  const result: WorkLaneRecent[] = [];
  for (const item of value) {
    const raw = obj(item);
    if (!raw || typeof raw.at !== 'string' || !nullableTimestamp(raw.at) || typeof raw.spec_id !== 'string'
      || !['note', 'checks', 'done', 'blocked'].includes(String(raw.kind))) return undefined;
    if (raw.text !== undefined && !nullableString(raw.text)) return undefined;
    if (raw.count !== undefined && !count(raw.count)) return undefined;
    if (raw.kind === 'note' && typeof raw.text !== 'string') return undefined;
    if (raw.kind === 'checks' && !count(raw.count)) return undefined;
    result.push({ at: raw.at, spec_id: raw.spec_id, kind: raw.kind as WorkLaneRecent['kind'],
      ...(nullableString(raw.text) ? { text: raw.text } : {}),
      ...(count(raw.count) ? { count: raw.count } : {}) });
  }
  return result;
}

function normalizeMember(value: unknown): WorkLaneMember | null {
  const raw = obj(value);
  const specId = str(raw?.spec_id);
  if (!raw || !specId) return null;
  const member: WorkLaneMember = { spec_id: specId };
  if (nullableString(raw.goal_id)) member.goal_id = raw.goal_id;
  for (const key of ['title', 'status_text', 'next_action_text', 'source_changed_at', 'status_line', 'next_line', 'blocked_line', 'summary_line'] as const) {
    if (nullableString(raw[key])) member[key] = raw[key];
  }
  if (nullableTimestamp(raw.progress_at)) member.progress_at = raw.progress_at;
  if (str(raw.status)) member.status = String(raw.status);
  if (raw.terminal === null || raw.terminal === 'completed' || raw.terminal === 'deprecated') member.terminal = raw.terminal;
  for (const key of ['ac_checked', 'ac_total'] as const) {
    if (nullableCount(raw[key])) member[key] = raw[key];
  }
  const firstEstimate = normalizeEstimate(raw.estimate_first);
  if (firstEstimate !== undefined) member.estimate_first = firstEstimate;
  if (Array.isArray(raw.unblocks) && raw.unblocks.length <= 4 && raw.unblocks.every(v => obj(v) && typeof v.spec_id === 'string' && typeof v.title === 'string'))
    member.unblocks = raw.unblocks.map(v => ({ spec_id: v.spec_id, title: v.title }));
  const recent = normalizeRecent(raw.recent);
  if (recent) member.recent = recent;
  const estimate = normalizeEstimate(raw.estimate);
  if (estimate !== undefined) member.estimate = estimate;
  const observation = normalizeObservation(raw.observation);
  if (observation !== undefined) member.observation = observation;
  if (count(raw.obs_rev) && raw.obs_rev > 0) member.obs_rev = raw.obs_rev;
  if (Array.isArray(raw.seats)) {
    member.seats = raw.seats.map(normalizeSeat).filter((seat): seat is WorkLaneSeat => seat !== null);
    member.seats_total = count(raw.seats_total) ? Math.max(raw.seats_total, member.seats.length) : member.seats.length;
  }
  const questions = obj(raw.open_questions);
  if (questions && count(questions.count)) {
    member.open_questions = { count: questions.count, first_question_id: str(questions.first_question_id) };
  }
  const hours = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const worked = obj(raw.worked);
  if (raw.worked === null) member.worked = null;
  else if (worked && hours(worked.elapsed_h) && hours(worked.active_h) && typeof worked.censored === 'boolean'
    && count(worked.seats) && count(worked.qa_rounds) && typeof worked.as_of === 'string') {
    member.worked = { elapsed_h: worked.elapsed_h as number | null, active_h: worked.active_h as number | null,
      censored: worked.censored, seats: worked.seats, qa_rounds: worked.qa_rounds, as_of: worked.as_of };
  }
  const dispositions = ['open', 'done', 'waived', 'tracked', 'parked'];
  if (Array.isArray(raw.criteria) && raw.criteria.every(c => obj(c) && typeof c.title === 'string' && dispositions.includes(c.disposition)))
    member.criteria = raw.criteria.map(c => ({ title: c.title, disposition: c.disposition }));
  if (Array.isArray(raw.transitions) && raw.transitions.every(t => obj(t) && typeof t.status === 'string' && typeof t.at === 'string'))
    member.transitions = raw.transitions.map(t => ({ status: t.status, at: t.at }));
  const lead = obj(raw.lead_seat);
  if (raw.lead_seat === null) member.lead_seat = null;
  else if (lead && str(lead.stream_id) && typeof lead.host === 'string' && nullableString(lead.provider)
    && SEAT_ACTIVITY.includes(lead.activity as WorkLaneSeat['activity']) && nullableString(lead.eta_at) && nullableString(lead.active_step)) {
    member.lead_seat = { stream_id: String(lead.stream_id), host: lead.host, provider: lead.provider as string | null,
      activity: lead.activity as WorkLaneSeat['activity'], eta_at: lead.eta_at as string | null, active_step: lead.active_step as string | null };
  }
  return member;
}

function normalizeMembers(value: unknown, deduplicate = false): WorkLaneMember[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const members: WorkLaneMember[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const member = normalizeMember(item);
    // An invalid membership list is absent, not a deceptively complete subset.
    if (!member) return undefined;
    if (seen.has(member.spec_id)) {
      if (deduplicate) continue;
      return undefined;
    }
    seen.add(member.spec_id);
    members.push(member);
  }
  return members;
}

function normalizeWorkIndex(value: unknown): WorkIndex | undefined {
  const raw = obj(value);
  if (!raw || typeof raw.available !== 'boolean') return undefined;
  const index: WorkIndex = { available: raw.available };
  if (typeof raw.root_configured === 'boolean') index.root_configured = raw.root_configured;
  for (const key of ['snapshot_at', 'last_sweep_at', 'error'] as const) {
    if (nullableString(raw[key])) index[key] = raw[key];
  }
  return index;
}

function normalizeDefaultGoal(value: unknown): WorkLaneDefaultGoal | undefined {
  const raw = obj(value);
  if (!raw || !['in_progress', 'not_started', 'done'].includes(String(raw.state))
    || !count(raw.done) || !count(raw.total) || raw.done > raw.total) return undefined;
  const goal: WorkLaneDefaultGoal = { state: raw.state as WorkLaneDefaultGoal['state'], done: raw.done, total: raw.total };
  if (count(raw.moving) && raw.moving <= raw.total) goal.moving = raw.moving;
  if (count(raw.blocked) && raw.blocked <= raw.total) goal.blocked = raw.blocked;
  if (typeof raw.working === 'boolean') goal.working = raw.working;
  if (raw.left_h === null || (typeof raw.left_h === 'number' && Number.isFinite(raw.left_h) && raw.left_h >= 0)) goal.left_h = raw.left_h;
  if (nullableTimestamp(raw.progress_at)) goal.progress_at = raw.progress_at;
  if (nullableString(raw.summary_line)) goal.summary_line = raw.summary_line;
  const recent = normalizeRecent(raw.recent);
  if (recent) goal.recent = recent;
  return goal;
}

function normalizeGoal(value: unknown): WorkLaneGoal | undefined {
  const raw = obj(value), progress = normalizeDefaultGoal(value);
  if (!raw || !progress || !str(raw.goal_id) || !str(raw.title) || !count(raw.rank)) return undefined;
  return {
    ...progress, goal_id: String(raw.goal_id), title: String(raw.title), rank: raw.rank,
    ...(typeof raw.target_date === 'string' ? { target_date: raw.target_date } : {}),
    ...(raw.icon === null || LANE_ICON_KEYS.includes(raw.icon as LaneIconKey)
      ? { icon: raw.icon as LaneIconKey | null } : {}),
  };
}

// Valid only as a whole: one letter per goal of the lane and a distinct in-range `pos` on every sent goal.
function normalizeGoalRoad(raw: Obj, goals: WorkLaneGoal[] | undefined): { letters: string; pos: number[] } | null {
  const letters = raw.goal_road, rawGoals = raw.goals;
  if (!goals || !Array.isArray(rawGoals) || typeof letters !== 'string' || !/^[dwmbq]*$/.test(letters)
    || letters.length !== raw.goals_total) return null;
  const pos = rawGoals.map(goal => obj(goal)?.pos);
  if (!pos.every((at): at is number => count(at) && at < letters.length) || new Set(pos).size !== pos.length) return null;
  return { letters, pos };
}

function normalizeProgress(raw: Obj): Partial<WorkLane> {
  const progress: Partial<WorkLane> = {};
  if (typeof raw.goal_classes === 'string' && Array.isArray(raw.goals)
    && raw.goal_classes.length === raw.goals.length + 1
    && /^[dwmbq]*[dwmbq-]$/.test(raw.goal_classes)) progress.goal_classes = raw.goal_classes;
  if (Array.isArray(raw.goal_counts) && raw.goal_counts.length === 4 && raw.goal_counts.every(count))
    progress.goal_counts = raw.goal_counts as [number, number, number, number];
  if (nullableTimestamp(raw.progress_at)) progress.progress_at = raw.progress_at;
  if (nullableTimestamp(raw.state_at)) progress.state_at = raw.state_at;
  const recent = normalizeRecent(raw.recent);
  if (recent) progress.recent = recent;
  if (Array.isArray(raw.goals)) {
    const goals = raw.goals.map(normalizeGoal);
    if (goals.every((goal): goal is WorkLaneGoal => goal !== undefined)
      && new Set(goals.map(goal => goal.goal_id)).size === goals.length) progress.goals = goals;
  }
  if (count(raw.goals_total)) progress.goals_total = raw.goals_total;
  const road = normalizeGoalRoad(raw, progress.goals);
  if (road) {
    progress.goal_road = road.letters;
    progress.goals = progress.goals!.map((goal, i) => ({ ...goal, pos: road.pos[i] }));
  }
  const parked = obj(raw.parked);
  if (parked) progress.parked = {
    at: typeof parked.at === 'string' && nullableTimestamp(parked.at) ? parked.at : null,
    reason: typeof parked.reason === 'string' && parked.reason.trim() ? parked.reason.slice(0, 160) : null,
  };
  const defaultGoal = normalizeDefaultGoal(raw.default_goal);
  if (defaultGoal) progress.default_goal = defaultGoal;
  if (typeof raw.detail_revision === 'string' && /^[a-f0-9]{64}$/.test(raw.detail_revision))
    progress.detail_revision = raw.detail_revision;
  const members = normalizeMembers(raw.members);
  if (members !== undefined) progress.members = members;
  for (const key of ['members_total', 'items_total', 'items_completed', 'items_dropped',
    'items_open', 'items_unresolved', 'ac_members', 'open_estimated'] as const) {
    if (count(raw[key])) progress[key] = raw[key];
  }
  for (const key of ['ac_checked', 'ac_total'] as const) {
    if (nullableCount(raw[key])) progress[key] = raw[key];
  }
  for (const key of ['no_spec_reason', 'freshness_at'] as const) {
    if (nullableString(raw[key])) progress[key] = raw[key];
  }
  const estimate = normalizeEstimate(raw.open_estimate_h);
  if (estimate !== undefined) progress.open_estimate_h = estimate;
  if (typeof raw.estimate_complete === 'boolean') progress.estimate_complete = raw.estimate_complete;
  return progress;
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

// Any invalid or missing pointer fails closed: the lane stays visible with an honest
// "Chat unavailable" and no navigation target (never a guessed stream).
const UNAVAILABLE_CHAT: WorkLaneVisibleChat = { stream_id: '', generation: null, kind: 'session', available: 'unavailable' };

function normalizeVisibleChat(value: unknown): WorkLaneVisibleChat {
  const raw = obj(value);
  const streamId = str(raw?.stream_id);
  const available = AVAILABILITY.find((item) => item === raw?.available);
  const kind = raw?.kind === 'composite' || raw?.kind === 'session' ? raw.kind : null;
  // A present generation must be a string (null/absent are valid for composite and open chats).
  const badGeneration = raw?.generation !== undefined && raw.generation !== null && typeof raw.generation !== 'string';
  if (!raw || !streamId || !available || !kind || badGeneration) return { ...UNAVAILABLE_CHAT, stream_id: streamId ?? '' };
  const generation = str(raw.generation);
  // A closed chat is readable only for an exact generation.
  return {
    stream_id: streamId,
    generation,
    kind,
    available: available === 'history' && !generation ? 'unavailable' : available,
  };
}

function normalizeLane(value: unknown): WorkLane | null {
  const raw = obj(value);
  if (!raw || !str(raw.lane_id)) return null;
  const state = LANE_STATES.find((item) => item === raw.state);
  const ownerKind = OWNER_KINDS.find((item) => item === raw.owner_kind);
  const visibleChat = normalizeVisibleChat(raw.visible_chat);
  if (!state || !ownerKind) return null;
  const lead = normalizeLead(raw.lead);
  const lastRaw = obj(raw.last_update);
  const lastKind = UPDATE_KINDS.find((item) => item === lastRaw?.kind);
  // Member-work is authoritative even when the old lead is gone. Other active
  // lanes without a qualifying lead retain the legacy owner-loss fallback.
  const unled = state === 'active' && raw.state_reason !== 'members_working' && (!lead || !lead.qualifies);
  return {
    lane_id: String(raw.lane_id),
    ...(nullableString(raw.icon) ? { icon: raw.icon } : {}),
    title: str(raw.title) ?? '',
    summary: str(raw.summary) ?? '',
    state,
    state_reason: unled ? 'lead_lost' : str(raw.state_reason) ?? '',
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
    ...normalizeProgress(raw),
  };
}

export function normalizeWorkLanesInventory(value: unknown): WorkLanesInventory | null {
  const raw = obj(value);
  if (!raw || !Array.isArray(raw.lanes)) return null;
  // Existing top-level fields must be well formed; a malformed v1 projection is
  // rejected whole so the previous inventory is kept rather than showing a bad
  // count, state or truncation flag. Absent counts/flags derive from the lanes.
  if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') return null;
  if (raw.generated_at !== undefined && typeof raw.generated_at !== 'string') return null;
  const validCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const counts = obj(raw.counts);
  if (raw.counts !== undefined && (!counts || !COUNT_KEYS.every((key) => validCount(counts[key])))) return null;
  // Server order is preserved; `done` is history, never a header lane; a repeated
  // lane id keeps its first occurrence so list keys stay unique.
  const seen = new Set<string>();
  const lanes = raw.lanes
    .map(normalizeLane)
    .filter((lane): lane is WorkLane => {
      if (lane === null || lane.state === 'done' || seen.has(lane.lane_id)) return false;
      seen.add(lane.lane_id);
      return true;
    });
  const tally = (state: WorkLaneState) => lanes.filter((lane) => lane.state === state).length;
  const active = counts ? Number(counts.active) : tally('active');
  const paused = counts ? Number(counts.paused) : tally('paused');
  const blocked = counts ? Number(counts.blocked) : tally('blocked');
  const workIndex = normalizeWorkIndex(raw.work_index);
  return {
    lanes,
    counts: { open: counts ? Number(counts.open) : active + paused + blocked, active, paused, blocked },
    truncated: raw.truncated === true,
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : '',
    ...(workIndex ? { work_index: workIndex } : {}),
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
 * Where a tap on a lane goes. `unavailable` never falls back to the assistant, a hidden
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

type AuditEvent = WorkLaneLogEvent & {
  payload: Obj;
  update_id: string | null;
  publication_event_id: number | null;
};

function normalizeAuditEvent(value: unknown, laneId: string): AuditEvent | null {
  const raw = obj(value);
  if (!raw || (typeof raw.event_id !== 'string' && !count(raw.event_id))
    || !str(raw.operation) || !str(raw.created_at)
    || (raw.lane_id !== undefined && raw.lane_id !== laneId)) return null;
  const eventId = String(raw.event_id);
  if (!eventId) return null;
  const payload = obj(raw.payload) ?? {};
  return {
    event_id: eventId,
    operation: String(raw.operation),
    created_at: String(raw.created_at),
    summary: str(payload.summary) || null,
    payload,
    update_id: str(raw.update_id),
    publication_event_id: count(raw.publication_event_id) ? raw.publication_event_id : null,
  };
}

function compareEventIds(a: string | number | null, b: string | number | null): number {
  if (typeof a === 'number' && typeof b === 'number') return b - a;
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? 1 : leftNumber > rightNumber ? -1 : 0;
  }
  return left < right ? 1 : left > right ? -1 : 0;
}

function newestFirst<T extends { created_at: string; event_id: string | number | null }>(rows: T[]): T[] {
  const time = (stamp: string) => {
    const parsed = Date.parse(stamp);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return rows.sort((a, b) => time(b.created_at) - time(a.created_at) || compareEventIds(a.event_id, b.event_id));
}

function displayEstimate(estimate: WorkLaneEstimate | null): string {
  if (estimate === null) return '—';
  return `${estimate.p25}–${estimate.p75} h (median ${estimate.median}${estimate.provisional ? '; provisional' : ''})`;
}

function specChanges(event: AuditEvent, members: Map<string, WorkLaneMember>): WorkLaneSpecChange[] {
  const payload = event.payload;
  const specId = str(payload.spec_id);
  const prior = obj(payload.prior);
  const next = obj(payload.next);
  if (!specId || !prior || !next) return [];
  const base = {
    event_id: event.event_id,
    created_at: event.created_at,
    spec_id: specId,
    title: members.get(specId)?.title || specId,
    ...(count(payload.obs_rev) && payload.obs_rev > 0 ? { obs_rev: payload.obs_rev } : {}),
  };
  const rows: WorkLaneSpecChange[] = [];
  if (nullableString(prior.status) && nullableString(next.status) && prior.status !== next.status) {
    rows.push({ ...base, field: 'status', before: prior.status ?? '—', after: next.status ?? '—' });
  }
  if (nullableCount(prior.ac_checked) && nullableCount(prior.ac_total)
    && nullableCount(next.ac_checked) && nullableCount(next.ac_total)
    && (prior.ac_checked !== next.ac_checked || prior.ac_total !== next.ac_total)) {
    rows.push({
      ...base, field: 'ac',
      before: `${prior.ac_checked ?? '—'}/${prior.ac_total ?? '—'}`,
      after: `${next.ac_checked ?? '—'}/${next.ac_total ?? '—'}`,
    });
  }
  const before = normalizeEstimate(prior.estimate);
  const after = normalizeEstimate(next.estimate);
  if (before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
    rows.push({ ...base, field: 'estimate', before: displayEstimate(before), after: displayEstimate(after) });
  }
  return rows;
}

/**
 * Read the existing show reply without storing audit data in the session model.
 * Membership order is retained; log rows alone are sorted newest first. Views
 * page these complete arrays locally rather than requesting an invented cursor.
 */
export function parseWorkLaneShow(value: unknown): WorkLaneShow | null {
  const raw = obj(value);
  if (!raw || (raw.type !== undefined && raw.type !== 'work_lanes.show.ok')) return null;
  const lane = obj(raw.lane);
  const projection = normalizeLane(raw.projection);
  const laneId = str(lane?.lane_id) || projection?.lane_id;
  if (!laneId || (projection && projection.lane_id !== laneId)) return null;
  const paged = Object.hasOwn(raw, 'members_total') || Object.hasOwn(raw, 'members_next');
  const revision = raw.detail_revision;
  if ((revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))
    || (paged && (!count(raw.members_total) || !Object.hasOwn(raw, 'members_next')
      || !(raw.members_next === null || (typeof raw.members_next === 'string' && raw.members_next.length > 0))
      || typeof revision !== 'string'))
    || (typeof revision === 'string' && projection?.detail_revision && projection.detail_revision !== revision)) return null;
  if (paged && normalizeMembers(raw.members, true) === undefined) return null;
  const members = normalizeMembers(raw.members, paged) ?? projection?.members ?? [];
  const membersById = new Map(members.map((member) => [member.spec_id, member]));
  const audit = newestFirst((Array.isArray(raw.events) ? raw.events : [])
    .map((event) => normalizeAuditEvent(event, laneId))
    .filter((event): event is AuditEvent => event !== null));
  const byUpdate = new Map<string, AuditEvent>();
  const byPublication = new Map<number, AuditEvent>();
  for (const event of audit) {
    if (event.update_id && !byUpdate.has(event.update_id)) byUpdate.set(event.update_id, event);
    if (event.publication_event_id !== null && !byPublication.has(event.publication_event_id)) {
      byPublication.set(event.publication_event_id, event);
    }
  }
  const updates: WorkLaneLogUpdate[] = [];
  const seenUpdates = new Set<string>();
  const rawUpdates: unknown[] = Array.isArray(raw.updates) ? [...raw.updates] : [];
  if (projection?.last_update) rawUpdates.push(projection.last_update);
  for (const value of rawUpdates) {
    const update = obj(value);
    const updateId = str(update?.update_id);
    const kind = UPDATE_KINDS.find((item) => item === update?.kind);
    if (!update || !updateId || !kind || seenUpdates.has(updateId)) continue;
    seenUpdates.add(updateId);
    const linked = byUpdate.get(updateId) ?? (count(update.event_id) ? byPublication.get(update.event_id) : undefined);
    const stamp = linked?.created_at ?? str(update.ts) ?? '';
    updates.push({
      update_id: updateId, kind,
      event_id: linked?.event_id ?? (typeof update.event_id === 'string' || count(update.event_id) ? update.event_id : null),
      created_at: stamp,
      ts: stamp,
      summary: linked?.summary ?? null,
      ...(nullableString(update.spec_id) ? { spec_id: update.spec_id } : str(linked?.payload.spec_id) ? { spec_id: String(linked!.payload.spec_id) } : {}),
    });
  }
  const workIndex = normalizeWorkIndex(raw.work_index);
  return {
    lane_id: laneId,
    projection,
    members,
    ...(normalizeRecent(raw.recent) ? { recent: normalizeRecent(raw.recent) } : {}),
    ...(paged ? { members_total: raw.members_total as number, members_next: raw.members_next as string | null } : {}),
    ...(typeof revision === 'string' ? { detail_revision: revision } : {}),
    ...(workIndex ? { work_index: workIndex } : {}),
    updates: newestFirst(updates),
    spec_changes: newestFirst(audit.filter((event) => event.operation === 'item_change')
      .flatMap((event) => specChanges(event, membersById))),
    events: audit.filter((event) => event.operation !== 'item_change')
      .map(({ event_id, created_at, operation, summary }) => ({ event_id, created_at, operation, summary })),
  };
}
