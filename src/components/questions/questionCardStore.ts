import { useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type CardStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
const SEEN_LIMIT = 500;

/** Process-local state. Hiding or recycling the transcript host never discards a draft or send.
 * With a storage key, the shown flag and seen question keys also survive an app relaunch: a card
 * he closed stays closed, and only a question he has not seen reopens it. No deck decision is made
 * until the stored state has loaded. */
export function createQuestionCardStore(storageKey?: string, storage: CardStorage = AsyncStorage) {
  let snapshot = { shown: false, pageKey: null as string | null };
  const seen = new Set<string>();
  const fields = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let hydrated = !storageKey;
  let touched = false;
  let discardStored = false;
  let pendingDeck: readonly string[] | null = null;
  // Keys on screen when he toggled or closed during loading count as seen, so only a later arrival reopens.
  const acknowledged = new Set<string>();
  const emit = () => listeners.forEach((listener) => listener());
  const persist = () => {
    if (!storageKey || !hydrated) return;
    const record = { shown: snapshot.shown, seen: [...seen].slice(-SEEN_LIMIT) };
    storage.setItem(storageKey, JSON.stringify(record)).catch(() => undefined);
  };
  const setShown = (shown: boolean) => {
    touched = true;
    if (!hydrated) pendingDeck?.forEach((key) => acknowledged.add(key));
    snapshot = { ...snapshot, shown }; emit(); persist();
  };
  const store = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    show() { if (!snapshot.shown) setShown(true); },
    hide() { if (snapshot.shown) setShown(false); },
    toggle(count: number) { if (count > 0) setShown(!snapshot.shown); },
    observeDeck(keys: readonly string[]) {
      if (!hydrated) { pendingDeck = keys; return; }
      const first = keys.find((key) => !seen.has(key));
      // Re-adding moves pending keys to the newest end, so the stored cap never drops one.
      keys.forEach((key) => { seen.delete(key); seen.add(key); });
      if (first !== undefined) { snapshot = { shown: true, pageKey: first }; emit(); persist(); }
    },
    setPageKey(pageKey: string | null) {
      if (snapshot.pageKey !== pageKey) { snapshot = { ...snapshot, pageKey }; emit(); }
    },
    field<T>(name: string, initial: T | (() => T)): T {
      if (!fields.has(name)) fields.set(name, typeof initial === 'function' ? (initial as () => T)() : initial);
      return fields.get(name) as T;
    },
    setField<T>(name: string, next: SetStateAction<T>) {
      const previous = fields.get(name) as T;
      const value = typeof next === 'function' ? (next as (prev: T) => T)(previous) : next;
      if (!Object.is(previous, value)) { fields.set(name, value); emit(); }
    },
    reset() {
      fields.clear(); seen.clear(); snapshot = { shown: false, pageKey: null };
      if (!hydrated) { touched = true; discardStored = true; pendingDeck = null; acknowledged.clear(); }
      emit(); persist();
    },
  };
  if (storageKey) {
    const finish = (raw: string | null) => {
      try {
        const record = raw && !discardStored ? JSON.parse(raw) as { shown?: unknown; seen?: unknown } : null;
        if (Array.isArray(record?.seen)) record.seen.forEach((key) => { if (typeof key === 'string' && !seen.has(key)) seen.add(key); });
        if (!touched && typeof record?.shown === 'boolean') snapshot = { ...snapshot, shown: record.shown };
      } catch { /* an unreadable record counts as none */ }
      acknowledged.forEach((key) => { seen.delete(key); seen.add(key); });
      hydrated = true;
      const keys = pendingDeck;
      pendingDeck = null;
      emit();
      // A toggle, close or reset made while loading was never written; store what is in effect now.
      if (touched) persist();
      if (keys) store.observeDeck(keys);
    };
    storage.getItem(storageKey).then(finish, () => finish(null));
  }
  return store;
}

const STORAGE_PREFIX = 'pentacle-mobile:question-card:v1:';
export const questionCardStore = createQuestionCardStore(`${STORAGE_PREFIX}assistant`);
const laneStores = new Map<string, ReturnType<typeof createQuestionCardStore>>();
export function laneQuestionCardStore(laneId: string) {
  if (!laneStores.has(laneId)) laneStores.set(laneId, createQuestionCardStore(`${STORAGE_PREFIX}lane:${laneId}`));
  return laneStores.get(laneId)!;
}
export const useQuestionCardVisibility = (store = questionCardStore) => useSyncExternalStore(store.subscribe, store.getSnapshot);

/** Overlay retains its local lifecycle; the embedded controller uses process-owned fields. */
export function useQuestionCardField<T>(name: string, initial: T | (() => T), persistent: boolean, store = questionCardStore): [T, Dispatch<SetStateAction<T>>] {
  const local = useState(initial);
  const value = useSyncExternalStore(store.subscribe, () => store.field(name, initial));
  return persistent ? [value, (next) => store.setField(name, next)] : local;
}
