import { act } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type {
  HouseholdEvent,
  HouseholdItem,
  HouseholdSnapshot,
  ListId,
} from '../../src/services/household/types';

// ---------------------------------------------------------------------------------------------
// Meaningful design colours (README § Design tokens). Compared case-insensitively.
// ---------------------------------------------------------------------------------------------
export const GREEN = '#3dff66';
export const AMBER = '#ffb53d';
export const RED = '#ff2e3e';
export const MUTED = '#7fa896';
export const DIM = '#9dc4b3';

export const TODAY = '2026-10-06'; // Tuesday, America/Chicago

// ---------------------------------------------------------------------------------------------
// Pure date helpers (UTC arithmetic only, so they cannot be skewed by the device zone)
// ---------------------------------------------------------------------------------------------
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const monthOfDate = (date: string): string => date.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
export function item(
  over: Partial<HouseholdItem> & Pick<HouseholdItem, 'id' | 'list' | 'label'>,
): HouseholdItem {
  return {
    priority: 'med',
    due_date: null,
    position: over.id,
    category: null,
    scope: 'private',
    created_by: 'app',
    done_at: null,
    routine_id: null,
    ...over,
  };
}

export function event(
  over: Partial<HouseholdEvent> & Pick<HouseholdEvent, 'id' | 'date' | 'title'>,
): HouseholdEvent {
  return {
    time: null,
    who: 'self',
    location: null,
    star: false,
    scope: 'private',
    created_by: 'app',
    ...over,
  };
}

export function fixtureSnapshot(): HouseholdSnapshot {
  return {
    today: TODAY,
    server_now: '2026-10-06T23:39:00Z',
    people: { partner: 'Sam' },
    lists: {
      tasks: [
        // Bart-created with due today → lamp + DUE TODAY
        item({ id: 1, list: 'tasks', label: 'Renew domain for altum.ai', due_date: TODAY, created_by: 'assistant', position: 1 }),
        // Bart-created, priority hi → lamp + HIGH
        item({ id: 2, list: 'tasks', label: 'Reply to Kalshi support', priority: 'hi', created_by: 'assistant', position: 2 }),
        item({ id: 3, list: 'tasks', label: 'Review index summary', position: 3 }),
        // partner-assistant-created SHARED item carrying due + hi metadata: tags but NO lamp
        item({ id: 4, list: 'tasks', label: 'Book flights for Nov', priority: 'hi', due_date: '2026-10-20', scope: 'shared', created_by: 'partner_assistant', position: 4 }),
        item({ id: 5, list: 'tasks', label: 'Sweep the garage', priority: 'lo', position: 5 }),
        item({ id: 6, list: 'tasks', label: 'Pay invoice', due_date: '2026-10-07', position: 6 }),
      ],
      grocery: [
        item({ id: 10, list: 'grocery', label: 'Oat milk', due_date: TODAY, scope: 'shared', created_by: 'partner_assistant', position: 1 }),
        item({ id: 11, list: 'grocery', label: 'Paneer', position: 2 }),
        item({ id: 12, list: 'grocery', label: 'Coffee beans', position: 3 }),
        item({ id: 13, list: 'grocery', label: 'Limes', position: 4 }),
      ],
      meals: [
        item({ id: 30, list: 'meals', label: 'Dal + rice', position: 1 }),
        item({ id: 31, list: 'meals', label: 'Sheet-pan chicken', position: 2 }),
        item({ id: 32, list: 'meals', label: 'Pasta night', position: 3 }),
      ],
      chores: [
        // overdue routine occurrence
        item({ id: 20, list: 'chores', label: 'Change HVAC filter', due_date: '2026-10-04', routine_id: 7, position: 1 }),
        item({ id: 21, list: 'chores', label: 'Take out recycling', position: 2 }),
      ],
      study: [],
    },
    events: [
      event({ id: 101, date: TODAY, time: null, title: 'Trash day', who: 'both', scope: 'shared', created_by: 'partner_assistant' }),
      event({ id: 102, date: TODAY, time: '09:30', title: 'Standup with design review' }),
      event({ id: 103, date: TODAY, time: '14:30', title: 'Vet — Pine St clinic', who: 'both', created_by: 'assistant' }),
      event({ id: 104, date: TODAY, time: '18:00', title: 'TestFlight cutoff', created_by: 'assistant' }),
      event({ id: 105, date: '2026-10-05', time: '12:00', title: 'Yesterday lunch' }),
      event({ id: 106, date: '2026-10-07', time: '11:00', title: 'Job A site visit', who: 'partner', scope: 'shared', created_by: 'partner_assistant' }),
      event({ id: 107, date: '2026-10-08', time: '16:00', title: 'Dentist' }),
      event({ id: 108, date: '2026-10-08', time: '08:00', title: 'Early run' }),
      event({ id: 109, date: '2026-10-09', time: '19:30', title: 'Dinner at Amma’s', who: 'both' }),
      event({ id: 110, date: '2026-10-13', time: '10:00', title: 'Arb desk weekly review', created_by: 'assistant' }),
      event({ id: 111, date: '2026-10-14', time: '10:00', title: 'Out of window' }),
      event({ id: 112, date: '2026-10-15', time: '15:00', title: 'CVS pickup', who: 'partner' }),
      event({ id: 113, date: '2026-10-21', time: '09:00', title: 'Soak test, physical device', created_by: 'assistant' }),
      event({ id: 114, date: '2026-10-21', time: '14:00', title: 'Evening class' }),
    ],
  };
}

export function emptyLists(): Record<ListId, HouseholdItem[]> {
  return { tasks: [], grocery: [], meals: [], chores: [], study: [] };
}

// ---------------------------------------------------------------------------------------------
// RPC error helper (contract v1.2: `<verb>.error` rejects with an Error carrying `errorCode`)
// ---------------------------------------------------------------------------------------------
export function rpcError(code?: string, message = 'household rpc failed'): Error {
  const err = new Error(message);
  if (code) (err as Error & { errorCode?: string }).errorCode = code;
  return err;
}

/** A client-side RPC timeout / disconnect rejection: an Error with NO errorCode. */
export const rpcTimeout = (): Error => rpcError(undefined, 'RPC timeout');

// ---------------------------------------------------------------------------------------------
// Outbound payload recorder: every frame the fake server sees is checked for forbidden fields.
// ---------------------------------------------------------------------------------------------
export const FORBIDDEN_OUTBOUND_KEYS = ['scope', 'priority', 'due_date', 'created_by'];
export const ALLOWED_VERBS = [
  'household.snapshot',
  'household.item.add',
  'household.item.done',
  'household.item.remove',
  'household.event.add',
  'household.event.remove',
];

const outboundViolations: string[] = [];

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

export function checkOutbound(verb: string, fields: unknown): string[] {
  const problems: string[] = [];
  if (!ALLOWED_VERBS.includes(verb)) problems.push(`unexpected verb ${verb}`);
  const keys = collectKeys(fields);
  for (const bad of FORBIDDEN_OUTBOUND_KEYS) {
    if (keys.includes(bad)) problems.push(`${verb} payload carries forbidden field "${bad}"`);
  }
  return problems;
}

/** Register once per test file: after all tests, no outbound payload may have carried a forbidden field. */
export function registerOutboundGuard(): void {
  afterAll(() => {
    expect(outboundViolations).toEqual([]);
  });
}

// ---------------------------------------------------------------------------------------------
// Fake household daemon (what the daemon adapter would answer). Frames follow the contract:
// `<verb>.ok` resolves with the WHOLE frame, `<verb>.error` rejects with an Error + errorCode.
// ---------------------------------------------------------------------------------------------
type Fields = Record<string, unknown>;
export type Override = (fields: Fields, server: FakeHousehold) => Promise<unknown>;

export class FakeHousehold {
  today = TODAY;
  people: HouseholdSnapshot['people'];
  lists: Record<ListId, HouseholdItem[]>;
  events: HouseholdEvent[];
  private nextId = 1000;
  private overrides = new Map<string, Override>();

  constructor(snapshot: HouseholdSnapshot = fixtureSnapshot()) {
    this.lists = JSON.parse(JSON.stringify(snapshot.lists));
    this.events = JSON.parse(JSON.stringify(snapshot.events));
    this.today = snapshot.today;
    this.people = snapshot.people;
  }

  override(verb: string, fn: Override): this {
    this.overrides.set(verb, fn);
    return this;
  }

  clearOverride(verb: string): this {
    this.overrides.delete(verb);
    return this;
  }

  /** The function to install as the sendHouseholdCommand mock implementation. */
  handle = (verb: string, fields: Fields = {}): Promise<any> => {
    outboundViolations.push(...checkOutbound(verb, fields));
    const custom = this.overrides.get(verb);
    if (custom) return custom(fields, this);
    return this.apply(verb, fields);
  };

  /** Default (committing) behaviour of each verb. */
  apply(verb: string, fields: Fields): Promise<any> {
    const server_now = '2026-10-06T23:40:00Z';
    switch (verb) {
      case 'household.snapshot': {
        const month = (fields.month as string | undefined) ?? monthOfDate(this.today);
        const weekAhead = addDays(this.today, 7);
        const events = this.events.filter(
          (e) => monthOfDate(e.date) === month || (e.date >= this.today && e.date <= weekAhead),
        );
        return Promise.resolve({
          type: 'household.snapshot.ok',
          request_id: 'household-test',
          today: this.today,
          month,
          people: this.people,
          lists: JSON.parse(JSON.stringify(this.lists)),
          events: JSON.parse(JSON.stringify(events)),
          server_now,
        });
      }
      case 'household.item.add': {
        const list = fields.list as ListId;
        const created = item({
          id: this.nextId++,
          list,
          label: String(fields.label),
          position: Math.max(0, ...this.lists[list].map((i) => i.position)) + 1,
        });
        this.lists[list].push(created);
        return Promise.resolve({ type: 'household.item.add.ok', item: created, server_now });
      }
      case 'household.item.done': {
        const found = this.findItem(fields.item_id as number);
        if (!found) return Promise.reject(rpcError('not_found'));
        this.lists[found.list] = this.lists[found.list].filter((i) => i.id !== found.id);
        return Promise.resolve({
          type: 'household.item.done.ok',
          item: { ...found, done_at: '2026-10-06T23:40:00Z' },
          server_now,
        });
      }
      case 'household.item.remove': {
        const found = this.findItem(fields.item_id as number);
        if (!found) return Promise.reject(rpcError('not_found'));
        this.lists[found.list] = this.lists[found.list].filter((i) => i.id !== found.id);
        return Promise.resolve({ type: 'household.item.remove.ok', item_id: found.id, server_now });
      }
      case 'household.event.add': {
        const created = event({
          id: this.nextId++,
          date: String(fields.date),
          time: (fields.time as string | null) ?? null,
          title: String(fields.title),
          who: fields.who as HouseholdEvent['who'],
        });
        this.events.push(created);
        return Promise.resolve({ type: 'household.event.add.ok', event: created, server_now });
      }
      case 'household.event.remove': {
        const id = fields.event_id as number;
        if (!this.events.some((e) => e.id === id)) return Promise.reject(rpcError('not_found'));
        this.events = this.events.filter((e) => e.id !== id);
        return Promise.resolve({ type: 'household.event.remove.ok', event_id: id, server_now });
      }
      default:
        return Promise.reject(rpcError('invalid_request'));
    }
  }

  findItem(id: number): HouseholdItem | undefined {
    for (const list of Object.keys(this.lists) as ListId[]) {
      const hit = this.lists[list].find((i) => i.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Commit a verb after `ms` (fake or real timers), as if Cosmo finished after the client gave up. */
  commitLater(ms: number, verb: string, fields: Fields): void {
    setTimeout(() => {
      void this.apply(verb, fields).catch(() => undefined);
    }, ms);
  }
}

/**
 * Build an override for `verb` that rejects as an unknown outcome.
 *  - commit 'now'   : the write is applied, THEN the call rejects (Cosmo committed, response lost)
 *  - commit 'never' : the write is never applied
 *  - commit <ms>    : applied `ms` after the rejection (Cosmo commits after the first readback)
 */
export function unknownOutcomeFor(
  verb: string,
  commit: 'now' | 'never' | number,
  error: () => Error = () => rpcError('unknown_outcome'),
): Override {
  return async (fields, server) => {
    if (commit === 'now') await server.apply(verb, fields);
    else if (typeof commit === 'number') server.commitLater(commit, verb, fields);
    throw error();
  };
}

// ---------------------------------------------------------------------------------------------
// Mock plumbing
// ---------------------------------------------------------------------------------------------
export function sendMock(): jest.Mock {
  return require('../../src/services/pentacleStream').sendHouseholdCommand as jest.Mock;
}

/** Install a fake daemon behind the sendHouseholdCommand mock and return it. */
export function installServer(server: FakeHousehold = new FakeHousehold()): FakeHousehold {
  sendMock().mockImplementation(server.handle);
  return server;
}

export type Call = { verb: string; fields: Fields };
export const calls = (): Call[] =>
  sendMock().mock.calls.map(([verb, fields]: [string, Fields]) => ({ verb, fields: fields ?? {} }));
export const snapshotCalls = (): Call[] => calls().filter((c) => c.verb === 'household.snapshot');
export const mutationCalls = (): Call[] => calls().filter((c) => c.verb !== 'household.snapshot');
export const callsOf = (verb: string): Call[] => calls().filter((c) => c.verb === verb);

// ---------------------------------------------------------------------------------------------
// Time helpers (tests that use these run under jest fake timers)
// ---------------------------------------------------------------------------------------------
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** Drain microtasks (RPC promise chains) without moving the clock. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Simulate a device whose zone is `offsetMinutes` east of UTC by skewing every LOCAL Date getter
 * (UTC getters stay correct). Code that derives a calendar day from the device clock/zone instead
 * of from `snapshot.today` / string arithmetic will then disagree with Chicago. Returns a restore fn.
 * (`process.env.TZ = ...` inside a jest test file does not change the zone, so this is the portable way.)
 */
export function poisonDeviceZone(offsetMinutes: number): () => void {
  const proto = Date.prototype as any;
  const names = [
    'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
    'getTimezoneOffset', 'toDateString', 'toLocaleDateString', 'toLocaleString', 'toLocaleTimeString',
  ];
  const saved: Record<string, unknown> = {};
  for (const n of names) saved[n] = proto[n];
  const shifted = (d: Date) => new Date(d.getTime() + offsetMinutes * 60000);
  proto.getFullYear = function () { return shifted(this).getUTCFullYear(); };
  proto.getMonth = function () { return shifted(this).getUTCMonth(); };
  proto.getDate = function () { return shifted(this).getUTCDate(); };
  proto.getDay = function () { return shifted(this).getUTCDay(); };
  proto.getHours = function () { return shifted(this).getUTCHours(); };
  proto.getMinutes = function () { return shifted(this).getUTCMinutes(); };
  proto.getSeconds = function () { return shifted(this).getUTCSeconds(); };
  proto.getTimezoneOffset = function () { return -offsetMinutes; };
  proto.toDateString = function () { return (saved.toDateString as Function).call(shifted(this)); };
  for (const n of ['toLocaleDateString', 'toLocaleString', 'toLocaleTimeString']) {
    proto[n] = function (locale?: string, opts?: object) {
      return (saved[n] as Function).call(shifted(this), locale, { ...opts, timeZone: 'UTC' });
    };
  }
  return () => {
    for (const n of names) proto[n] = saved[n];
  };
}

// ---------------------------------------------------------------------------------------------
// Test-instance helpers (react-test-renderer instances returned by RNTL queries)
// ---------------------------------------------------------------------------------------------
type Instance = {
  type: unknown;
  props: Record<string, any>;
  children: Array<Instance | string>;
  parent: Instance | null;
};

export function textOf(node: Instance | string | null | undefined): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return node.children.map((c) => textOf(c)).join('');
}

export function flatStyle(node: Instance | null | undefined): Record<string, any> {
  return (node && StyleSheet.flatten(node.props.style)) || {};
}

const lower = (v: unknown): string => String(v ?? '').toLowerCase();
export const sameColor = (a: unknown, b: string): boolean => lower(a) === b.toLowerCase();

function descendants(node: Instance): Instance[] {
  const out: Instance[] = [];
  for (const child of node.children) {
    if (typeof child !== 'string') {
      out.push(child, ...descendants(child));
    }
  }
  return out;
}

/** Text colour that applies to `node`'s text: its own style, a nested Text's style, or an ancestor's. */
export function colorOf(node: Instance): string | undefined {
  const own = flatStyle(node).color;
  if (own) return own as string;
  for (const d of descendants(node)) {
    const c = flatStyle(d).color;
    if (c) return c as string;
  }
  let up = node.parent;
  while (up) {
    const c = flatStyle(up).color;
    if (c) return c as string;
    up = up.parent;
  }
  return undefined;
}

/** All descendants (and the node itself) whose flattened style has this backgroundColor. */
export function withBackground(node: Instance, color: string): Instance[] {
  return [node, ...descendants(node)].filter(
    (n) => typeof n.type === 'string' && sameColor(flatStyle(n).backgroundColor, color), // host views only (no composite duplicates)
  );
}

/** True when the node or any descendant has `style[prop]` equal to `color` (case-insensitive). */
export function hasStyleColor(node: Instance, prop: string, color: string): boolean {
  return [node, ...descendants(node)].some((n) => sameColor(flatStyle(n)[prop], color));
}
