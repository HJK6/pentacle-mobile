import { useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

/** Process-local state. Hiding or recycling the transcript host never discards a draft or send. */
export function createQuestionCardStore() {
  let snapshot = { shown: false, pageKey: null as string | null };
  const seen = new Set<string>();
  const fields = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    show() { if (!snapshot.shown) { snapshot = { ...snapshot, shown: true }; emit(); } },
    hide() { if (snapshot.shown) { snapshot = { ...snapshot, shown: false }; emit(); } },
    toggle(count: number) { if (count > 0) { snapshot = { ...snapshot, shown: !snapshot.shown }; emit(); } },
    observeDeck(keys: readonly string[]) {
      const first = keys.find((key) => !seen.has(key));
      keys.forEach((key) => seen.add(key));
      if (first !== undefined) { snapshot = { shown: true, pageKey: first }; emit(); }
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
    reset() { fields.clear(); seen.clear(); snapshot = { shown: false, pageKey: null }; emit(); },
  };
}

export const questionCardStore = createQuestionCardStore();
const laneStores = new Map<string, ReturnType<typeof createQuestionCardStore>>();
export function laneQuestionCardStore(laneId: string) {
  if (!laneStores.has(laneId)) laneStores.set(laneId, createQuestionCardStore());
  return laneStores.get(laneId)!;
}
export const useQuestionCardVisibility = (store = questionCardStore) => useSyncExternalStore(store.subscribe, store.getSnapshot);

/** Overlay retains its local lifecycle; the embedded controller uses process-owned fields. */
export function useQuestionCardField<T>(name: string, initial: T | (() => T), persistent: boolean, store = questionCardStore): [T, Dispatch<SetStateAction<T>>] {
  const local = useState(initial);
  const value = useSyncExternalStore(store.subscribe, () => store.field(name, initial));
  return persistent ? [value, (next) => store.setField(name, next)] : local;
}
