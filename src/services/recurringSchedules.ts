import { useSyncExternalStore } from 'react';

// Scheduled screen data: recurring rules (pause / resume / edit) and pending one-shot rows (read-only).
// Fed by pentacleStream from the operator snapshot (`recurring`, `schedules`) and `schedule.lifecycle`
// frames. Kept out of PentacleStreamState: only the Scheduled screen and the header entry read it.

export type RecurringRecurrence = { every: 'daily' | 'weekdays' | 'weekly'; at_time: string; days: string[]; tz: string };

export type RecurringRule = {
  recurring_id: string;
  name: string;
  state: 'active' | 'paused';
  tz: string;
  recurrence: RecurringRecurrence;
  recurrence_text: string;
  next_fire_at_utc: string;
  next_fire_local?: string | null;
  last_result: 'fired' | 'missed' | null;
  last_result_reason: string | null;
  missed_count: number;
};

export type OneShotSchedule = {
  schedule_id: string;
  state: string;
  prompt_preview: string;
  fires_at_utc: string;
  target_host?: string | null;
};

export type ScheduledSnapshot = { recurring: RecurringRule[]; oneShots: OneShotSchedule[] };

export type RecurringEdit = { name: string; every: string; at_time: string; days: string[]; tz: string };

const PENDING_STATES = new Set(['pending', 'retry_pending', 'firing']);
const EMPTY: ScheduledSnapshot = { recurring: [], oneShots: [] };

let snapshot: ScheduledSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: ScheduledSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function getScheduledSnapshot(): ScheduledSnapshot {
  return snapshot;
}

export function subscribeScheduled(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useScheduled(): ScheduledSnapshot {
  return useSyncExternalStore(subscribeScheduled, getScheduledSnapshot, getScheduledSnapshot);
}

export function resetScheduled() {
  publish(EMPTY);
}

export function normalizeRecurring(raw: unknown): RecurringRule | null {
  const row = raw as Partial<RecurringRule> | null;
  if (!row || typeof row !== 'object') return null;
  if (typeof row.recurring_id !== 'string' || !row.recurring_id) return null;
  if (row.state !== 'active' && row.state !== 'paused') return null;
  const { initial_prompt_b64: _prompt, ...rule } = row as Record<string, unknown>;
  return rule as unknown as RecurringRule;
}

function byNextFire(a: RecurringRule, b: RecurringRule): number {
  return String(a.next_fire_at_utc || '').localeCompare(String(b.next_fire_at_utc || ''))
    || String(a.name || '').localeCompare(String(b.name || ''));
}

function normalizeOneShot(raw: unknown): OneShotSchedule | null {
  const row = raw as Partial<OneShotSchedule> | null;
  if (!row || typeof row !== 'object' || typeof row.schedule_id !== 'string' || !row.schedule_id) return null;
  return PENDING_STATES.has(String(row.state || '')) ? (row as OneShotSchedule) : null;
}

function byFireTime(a: OneShotSchedule, b: OneShotSchedule): number {
  return String(a.fires_at_utc || '').localeCompare(String(b.fires_at_utc || ''))
    || a.schedule_id.localeCompare(b.schedule_id);
}

/** Hello snapshot: a complete replacement of whichever lists the frame carries. */
export function replaceScheduledFromSnapshot(message: { recurring?: unknown; schedules?: unknown }) {
  const recurring = Array.isArray(message.recurring)
    ? message.recurring.map(normalizeRecurring).filter((row): row is RecurringRule => row !== null).sort(byNextFire)
    : snapshot.recurring;
  const oneShots = Array.isArray(message.schedules)
    ? message.schedules.map(normalizeOneShot).filter((row): row is OneShotSchedule => row !== null).sort(byFireTime)
    : snapshot.oneShots;
  publish({ recurring, oneShots });
}

/** `schedule.lifecycle` push: one rule (`recurring`) or one one-shot row (`schedule`). */
export function applyScheduleLifecycle(message: { event?: unknown; recurring?: unknown; schedule?: unknown }) {
  const rule = normalizeRecurring(message.recurring);
  if (rule) {
    const others = snapshot.recurring.filter((row) => row.recurring_id !== rule.recurring_id);
    publish({
      ...snapshot,
      recurring: message.event === 'recurring_deleted' ? others : [...others, rule].sort(byNextFire),
    });
    return;
  }
  const shot = message.schedule as { schedule_id?: unknown } | null | undefined;
  if (!shot || typeof shot !== 'object' || typeof shot.schedule_id !== 'string') return;
  const others = snapshot.oneShots.filter((row) => row.schedule_id !== shot.schedule_id);
  const next = normalizeOneShot(shot);
  publish({ ...snapshot, oneShots: next ? [...others, next].sort(byFireTime) : others });
}

export function formatInZone(iso: string | null | undefined, tz: string | null | undefined): string {
  const millis = Date.parse(iso || '');
  if (!Number.isFinite(millis)) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).format(new Date(millis));
  } catch {
    return new Date(millis).toISOString();
  }
}

export function formatRelative(iso: string | null | undefined, now: number): string {
  const millis = Date.parse(iso || '');
  if (!Number.isFinite(millis)) return '';
  const delta = millis - now;
  const minutes = Math.round(Math.abs(delta) / 60000);
  if (minutes < 1) return 'now';
  const span = minutes < 60 ? `${minutes}m`
    : minutes < 48 * 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${Math.round(minutes / 1440)}d`;
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

export function lastRunText(rule: Pick<RecurringRule, 'last_result' | 'last_result_reason'>): string {
  if (rule.last_result === 'missed') return `missed: ${rule.last_result_reason || 'unknown'}`;
  return rule.last_result === 'fired' ? 'fired' : 'never run';
}

export type RecurringRowViewModel = {
  id: string; name: string; recurrence: string; next: string; last: string; state: RecurringRule['state'];
  actionLabel: 'Pause' | 'Resume';
};

export function selectRecurringRows(rules: RecurringRule[], now: number): RecurringRowViewModel[] {
  return rules.map((rule) => ({
    id: rule.recurring_id,
    name: rule.name,
    recurrence: rule.recurrence_text,
    next: rule.state === 'paused'
      ? 'paused'
      : `${formatInZone(rule.next_fire_at_utc, rule.tz)} (${formatRelative(rule.next_fire_at_utc, now)})`,
    last: lastRunText(rule),
    state: rule.state,
    actionLabel: rule.state === 'paused' ? 'Resume' : 'Pause',
  }));
}
