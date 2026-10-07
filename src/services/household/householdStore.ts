// Client state for Personal / Lists / Calendar over the household verbs (spec Target State 6).
// Cosmo is the only store: this holds the last snapshot plus short-lived UI state (5 s pending
// checks, rows hidden while their mutation is in flight, one notice line). Mutations are never
// resubmitted by the client; an unknown outcome is reconciled by readback (now and 6 s later,
// repeated every 6 s while reads fail: only a fresh snapshot may resolve it).
import { useSyncExternalStore } from 'react';
import * as client from './householdClient';
import { monthOf } from './selectors';
import type { HouseholdSnapshot, ListId, NewEvent } from './types';

export const CHECK_WINDOW_MS = 5000;
export const READBACK_DELAY_MS = 6000;
export const UNRESOLVED_NOTICE = "Couldn't confirm — checking again";
export const NOT_SAVED_NOTICE = 'Not saved';

/** `ok`: confirmed. `failed`: definite refusal. `saved`/`not_saved`: an unknown outcome after readback. */
export type MutationOutcome = 'ok' | 'failed' | 'saved' | 'not_saved' | 'ignored';
type Notice = { text: string; kind: 'unresolved' | 'error' } | null;

export type HouseholdState = {
  status: 'idle' | 'ready' | 'unavailable';
  snapshot: HouseholdSnapshot | null;
  /** The month last asked for explicitly (readbacks reuse it). */
  month: string | undefined;
  /** Item id → epoch ms when its 5 s check window ends. */
  pending: Record<number, number>;
  hiddenItems: Record<number, true>;
  hiddenEvents: Record<number, true>;
  notice: Notice;
  /** Mutations whose outcome is still being read back. */
  unresolved: number;
  refresh: (month?: string) => Promise<void>;
  checkItem: (itemId: number) => void;
  removeItem: (itemId: number) => Promise<MutationOutcome>;
  addItem: (list: ListId, label: string) => Promise<MutationOutcome>;
  addEvent: (value: NewEvent) => Promise<MutationOutcome>;
  removeEvent: (eventId: number) => Promise<MutationOutcome>;
};

type Listener = () => void;
const listeners = new Set<Listener>();
let state: HouseholdState;

function getState(): HouseholdState {
  return state;
}

function setState(partial: Partial<HouseholdState> | HouseholdState, replace = false): void {
  state = replace ? (partial as HouseholdState) : { ...state, ...partial };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const errorCode = (error: unknown): string | undefined =>
  (error as { errorCode?: unknown } | null)?.errorCode as string | undefined;
/** `unknown_outcome`, or a client timeout/disconnect (no errorCode): the write may have happened. */
const isUnknown = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === undefined || code === 'unknown_outcome';
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function without<T extends Record<number, unknown>>(record: T, key: number): T {
  const next = { ...record };
  delete next[key];
  return next;
}

const checkTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function refresh(month?: string): Promise<void> {
  if (arguments.length > 0) setState({ month });
  await load(getState().month);
}

/** Readback with the month last asked for; never throws. Returns the fresh snapshot, or null. */
async function load(month: string | undefined): Promise<HouseholdSnapshot | null> {
  try {
    const frame = await client.snapshot(month);
    const notice = getState().notice;
    const snapshot: HouseholdSnapshot = {
      today: frame.today,
      month: frame.month,
      lists: frame.lists,
      events: frame.events,
      server_now: frame.server_now,
      people: frame.people,
    };
    setState({
      status: 'ready',
      snapshot,
      // An error line lasts until the next successful refresh; "checking again" lasts until resolved.
      notice: notice?.kind === 'error' ? null : notice,
    });
    return snapshot;
  } catch {
    setState({ status: 'unavailable' });
    return null;
  }
}

/**
 * Send one mutation. Definite refusal → `failed` (no readback). Unknown outcome → readback now and
 * once more 6 s after that read finishes, then `saved` if `committed(snapshot)` holds, otherwise
 * `not_saved`. A failed read never decides: the kept snapshot may predate the write, so the
 * action stays unresolved and is read again every 6 s until a read succeeds.
 */
async function mutate(
  send: () => Promise<unknown>,
  committed: (snapshot: HouseholdSnapshot) => boolean,
  // Event writes pin their own month so a readback never judges them against another month.
  month: string | undefined = getState().month,
): Promise<MutationOutcome> {
  try {
    await send();
  } catch (error) {
    if (!isUnknown(error)) {
      setState({ notice: { text: NOT_SAVED_NOTICE, kind: 'error' } });
      return 'failed';
    }
    setState({ unresolved: getState().unresolved + 1, notice: { text: UNRESOLVED_NOTICE, kind: 'unresolved' } });
    await load(month);
    let snapshot: HouseholdSnapshot | null = null;
    while (!snapshot) {
      await sleep(READBACK_DELAY_MS);
      snapshot = await load(month);
    }
    setState({ unresolved: Math.max(0, getState().unresolved - 1) });
    if (committed(snapshot)) {
      if (getState().unresolved === 0 && getState().notice?.kind === 'unresolved') setState({ notice: null });
      return 'saved';
    }
    setState({ notice: { text: NOT_SAVED_NOTICE, kind: 'error' } });
    return 'not_saved';
  }
  await load(month);
  return 'ok';
}

const itemAbsent = (itemId: number) => (snapshot: HouseholdSnapshot) =>
  !Object.values(snapshot.lists).some((items) => items.some((item) => item.id === itemId));

async function finishItem(itemId: number, send: () => Promise<unknown>): Promise<MutationOutcome> {
  setState({ hiddenItems: { ...getState().hiddenItems, [itemId]: true } });
  const outcome = await mutate(send, itemAbsent(itemId));
  setState({ hiddenItems: without(getState().hiddenItems, itemId) });
  return outcome;
}

function checkItem(itemId: number): void {
  const current = getState();
  const timer = checkTimers.get(itemId);
  if (current.pending[itemId] !== undefined) {
    // A second tap inside the window is the undo: nothing is ever sent.
    if (timer) clearTimeout(timer);
    checkTimers.delete(itemId);
    setState({ pending: without(current.pending, itemId) });
    return;
  }
  const deadline = Date.now() + CHECK_WINDOW_MS;
  setState({ pending: { ...current.pending, [itemId]: deadline } });
  checkTimers.set(
    itemId,
    setTimeout(() => {
      checkTimers.delete(itemId);
      // A store reset (or an undo) replaced the pending entry: this timer is stale.
      if (getState().pending[itemId] !== deadline) return;
      setState({ pending: without(getState().pending, itemId) });
      void finishItem(itemId, () => client.doneItem(itemId));
    }, CHECK_WINDOW_MS),
  );
}

function removeItem(itemId: number): Promise<MutationOutcome> {
  return finishItem(itemId, () => client.removeItem(itemId));
}

function addItem(list: ListId, text: string): Promise<MutationOutcome> {
  const label = text.trim();
  const before = getState().snapshot?.lists[list] ?? [];
  if (!label || before.some((item) => item.label === label)) return Promise.resolve('ignored');
  const known = new Set(before.map((item) => item.id));
  return mutate(
    () => client.addItem(list, label),
    (snapshot) => (snapshot.lists[list] ?? []).some((item) => item.label === label && !known.has(item.id)),
  );
}

function addEvent(value: NewEvent): Promise<MutationOutcome> {
  const known = new Set((getState().snapshot?.events ?? []).map((event) => event.id));
  // The calendar follows the event to its month (it may differ from the month on screen).
  const month = monthOf(value.date);
  setState({ month });
  return mutate(
    () => client.addEvent(value),
    (snapshot) =>
      snapshot.events.some(
        (event) => !known.has(event.id) && event.date === value.date && event.title === value.title,
      ),
    month,
  );
}

async function removeEvent(eventId: number): Promise<MutationOutcome> {
  const event = getState().snapshot?.events.find((candidate) => candidate.id === eventId);
  setState({ hiddenEvents: { ...getState().hiddenEvents, [eventId]: true } });
  const outcome = await mutate(
    () => client.removeEvent(eventId),
    (snapshot) => !snapshot.events.some((candidate) => candidate.id === eventId),
    event ? monthOf(event.date) : getState().month,
  );
  setState({ hiddenEvents: without(getState().hiddenEvents, eventId) });
  return outcome;
}

state = {
  status: 'idle',
  snapshot: null,
  month: undefined,
  pending: {},
  hiddenItems: {},
  hiddenEvents: {},
  notice: null,
  unresolved: 0,
  refresh,
  checkItem,
  removeItem,
  addItem,
  addEvent,
  removeEvent,
};

type HouseholdStoreHook = {
  (): HouseholdState;
  getState: typeof getState;
  setState: typeof setState;
  subscribe: typeof subscribe;
};

function useHouseholdStoreImpl(): HouseholdState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export const useHouseholdStore: HouseholdStoreHook = Object.assign(useHouseholdStoreImpl, {
  getState,
  setState,
  subscribe,
});
