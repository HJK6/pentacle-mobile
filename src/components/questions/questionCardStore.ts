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
export const useQuestionCardVisibility = () => useSyncExternalStore(questionCardStore.subscribe, questionCardStore.getSnapshot);

/** Overlay retains its local lifecycle; the embedded controller uses process-owned fields. */
export function useQuestionCardField<T>(name: string, initial: T | (() => T), persistent: boolean): [T, Dispatch<SetStateAction<T>>] {
  const local = useState(initial);
  const value = useSyncExternalStore(questionCardStore.subscribe, () => questionCardStore.field(name, initial));
  return persistent ? [value, (next) => questionCardStore.setField(name, next)] : local;
}
