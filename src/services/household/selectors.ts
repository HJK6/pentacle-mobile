// Pure display rules for Personal, Lists and Calendar (spec § B4/B5). Every calendar day comes
// from `snapshot.today` (America/Chicago) and string/UTC arithmetic, never the device clock/zone.
import type { HouseholdEvent, HouseholdItem, HouseholdSnapshot, ListId, Who } from './types';

export const LIST_ORDER: ListId[] = ['tasks', 'grocery', 'meals', 'chores', 'study'];

export const LIST_META: Record<ListId, { name: string; placeholder: string }> = {
  tasks: { name: 'To-do', placeholder: 'New task…' },
  grocery: { name: 'Grocery', placeholder: 'Add an item…' },
  meals: { name: 'Meals', placeholder: 'Add a meal…' },
  chores: { name: 'Chores', placeholder: 'Add a chore…' },
  study: { name: 'Study plan', placeholder: 'Add a study block…' },
};

export const isListId = (value: unknown): value is ListId =>
  typeof value === 'string' && (LIST_ORDER as string[]).includes(value);

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ---- day arithmetic (UTC only) ----------------------------------------------------------------

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

function utc(date: string): Date {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const monthOf = (date: string): string => date.slice(0, 7);
export const dayOfMonth = (date: string): number => parts(date)[2];
export const monthName = (date: string): string => MONTHS[parts(date)[1] - 1];
export const yearOf = (date: string): string => date.slice(0, 4);
/** `Tue` */
export const dowShort = (date: string): string => DOW_SHORT[utc(date).getUTCDay()];
/** 0 = Sunday */
export const weekdayIndex = (date: string): number => utc(date).getUTCDay();

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const dateIn = (month: string, day: number): string => `${month}-${String(day).padStart(2, '0')}`;

/** `WED 7` */
export const dayLabel = (date: string): string => `${dowShort(date).toUpperCase()} ${dayOfMonth(date)}`;

/** `TUE · OCTOBER 6` */
export const personalHeaderLabel = (today: string): string =>
  `${dowShort(today).toUpperCase()} · ${monthName(today).toUpperCase()} ${dayOfMonth(today)}`;

/** Route `date?`: an America/Chicago `YYYY-MM-DD` in 2000-01-01 … 2100-12-31, else null (use today). */
export function parseRouteDate(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (value < '2000-01-01' || value > '2100-12-31') return null;
  const [y, m, d] = parts(value);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(`${value.slice(0, 4)}-${String(m).padStart(2, '0')}`)) {
    return null;
  }
  return value;
}

// ---- month paging -----------------------------------------------------------------------------

export const MIN_MONTH = '2000-01';
export const MAX_MONTH = '2100-12';

/** `2026-10` + 1 → `2026-11`; clamped to MIN_MONTH … MAX_MONTH. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
  return next < MIN_MONTH ? MIN_MONTH : next > MAX_MONTH ? MAX_MONTH : next;
}

/** The day selected after paging to `month`: today in today's month, otherwise the 1st. */
export const selectionForMonth = (month: string, today: string): string =>
  month === monthOf(today) ? today : dateIn(month, 1);

/** New-event date field: `WED OCT 7`, with `, 2027` when the year is not today's. */
export function dateFieldLabel(date: string, today: string): string {
  const label = `${dowShort(date).toUpperCase()} ${monthName(date).slice(0, 3).toUpperCase()} ${dayOfMonth(date)}`;
  return yearOf(date) === yearOf(today) ? label : `${label}, ${yearOf(date)}`;
}

// ---- items ------------------------------------------------------------------------------------

const PRIORITY_RANK = { hi: 0, med: 1, lo: 2 } as const;

/** Priority (hi, med, lo), then Cosmo order (position, id). Does not mutate its input. */
export function sortItems(items: HouseholdItem[]): HouseholdItem[] {
  return [...items].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.position - b.position || a.id - b.id,
  );
}

export type Tone = 'red' | 'amber' | 'muted';
export type ItemTag = { text: string; tone: Tone };

/** Due tag first, then HIGH/LOW (D2, D5). Undated `med` items carry no tag. */
export function itemTags(item: HouseholdItem, today: string): ItemTag[] {
  const tags: ItemTag[] = [];
  const due = item.due_date;
  if (due) {
    if (due < today) tags.push({ text: 'OVERDUE', tone: 'red' });
    else if (due === today) tags.push({ text: 'DUE TODAY', tone: 'red' });
    else if (due === addDays(today, 1)) tags.push({ text: 'DUE TOMORROW', tone: 'amber' });
    else tags.push({ text: `DUE ${monthName(due).slice(0, 3).toUpperCase()} ${dayOfMonth(due)}`, tone: 'amber' });
  }
  if (item.priority === 'hi') tags.push({ text: 'HIGH', tone: 'amber' });
  else if (item.priority === 'lo') tags.push({ text: 'LOW', tone: 'muted' });
  return tags;
}

/** Bart's lamp only from actual attribution; due/priority alone never implies Bart (D6). */
export const showItemLamp = (item: HouseholdItem): boolean => item.created_by === 'assistant';

/** Personal TO-DO: priority hi or due ≤ tomorrow (overdue included), list order then detail order. */
export function criticalItems(snapshot: HouseholdSnapshot): Array<{ list: ListId; item: HouseholdItem }> {
  const tomorrow = addDays(snapshot.today, 1);
  return LIST_ORDER.flatMap((list) =>
    sortItems(snapshot.lists[list] ?? [])
      .filter((item) => item.priority === 'hi' || (item.due_date !== null && item.due_date <= tomorrow))
      .map((item) => ({ list, item })),
  );
}

// ---- events -----------------------------------------------------------------------------------

export type WhoBar = 'me' | 'partner';

export const DEFAULT_PARTNER = 'Partner';
export const partnerName = (snapshot: HouseholdSnapshot | null | undefined): string =>
  snapshot?.people?.partner?.trim() || DEFAULT_PARTNER;

/** Viewer-relative (the viewer is the operator). Scope only adds the visible PRIVATE suffix. */
export function whoDisplay(event: HouseholdEvent, partner: string = DEFAULT_PARTNER): { label: string; bars: WhoBar[] } {
  const name = partner.toUpperCase();
  const base =
    event.who === 'both'
      ? { label: `ME + ${name}`, bars: ['me', 'partner'] as WhoBar[] }
      : event.who === 'partner'
        ? { label: name, bars: ['partner'] as WhoBar[] }
        : { label: 'ME', bars: ['me'] as WhoBar[] };
  const privateToMe = event.scope === 'private' && (event.who === 'partner' || event.who === 'both');
  return privateToMe ? { ...base, label: `${base.label} · PRIVATE` } : base;
}

export const isBartEvent = (event: HouseholdEvent): boolean => event.created_by === 'assistant';

/** All-day first, then 24 h time text, then id. */
export function byDateTime(a: HouseholdEvent, b: HouseholdEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time !== b.time) {
    if (a.time === null) return -1;
    if (b.time === null) return 1;
    return a.time < b.time ? -1 : 1;
  }
  return a.id - b.id;
}

export const eventsOn = (events: HouseholdEvent[], date: string): HouseholdEvent[] =>
  events.filter((e) => e.date === date).sort(byDateTime);

export const todayEvents = (snapshot: HouseholdSnapshot): HouseholdEvent[] =>
  eventsOn(snapshot.events, snapshot.today);

export function upcomingEvents(snapshot: HouseholdSnapshot): HouseholdEvent[] {
  const last = addDays(snapshot.today, 7);
  return snapshot.events
    .filter((e) => e.date > snapshot.today && e.date <= last)
    .sort(byDateTime)
    .slice(0, 4);
}

/** `14:30` → `2:30p`, null → `ALL DAY` (D3). */
export function formatTime(time: string | null): string {
  if (time === null) return 'ALL DAY';
  const [h, m] = time.split(':').map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
}

/** Blank → all day; `H:MM`/`HH:MM` 24 h; or 12 h with `a|am|p|pm`. */
export function parseTimeInput(text: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  const match = /^(\d{1,2}):(\d{2})\s*(a|am|p|pm)?$/i.exec(trimmed);
  if (!match) return { ok: false };
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return { ok: false };
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return { ok: false };
    hour = (hour % 12) + (meridiem.startsWith('p') ? 12 : 0);
  } else if (hour > 23) {
    return { ok: false };
  }
  return { ok: true, value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

/** New-event WHO toggles: Me → `self`, partner → `partner`, both → `both` (display only). */
export function whoFromToggles(toggles: { me: boolean; partner: boolean }): Who {
  if (toggles.me && toggles.partner) return 'both';
  return toggles.partner ? 'partner' : 'self';
}
