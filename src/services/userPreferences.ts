import { useCallback, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type UserPreferences = {
  showToolActions: boolean;
  showTurnDuration: boolean;
};

export const USER_PREFERENCES_STORAGE_KEY = 'pentacle-mobile:user-preferences:v1';

const DEFAULT_USER_PREFERENCES: UserPreferences = Object.freeze({
  showToolActions: false,
  showTurnDuration: false,
});

const listeners = new Set<() => void>();

let state: UserPreferences = { ...DEFAULT_USER_PREFERENCES };
let hydrateStarted = false;
let hydrated = false;
let mutationVersion = 0;
let hydrationRun = 0;

function emit() {
  listeners.forEach((listener) => listener());
}

function preferencesEqual(left: UserPreferences, right: UserPreferences) {
  return left.showToolActions === right.showToolActions &&
    left.showTurnDuration === right.showTurnDuration;
}

function parseStoredPreferences(raw: string | null): UserPreferences {
  if (!raw) return { ...DEFAULT_USER_PREFERENCES };

  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      showToolActions: typeof parsed.showToolActions === 'boolean'
        ? parsed.showToolActions
        : DEFAULT_USER_PREFERENCES.showToolActions,
      showTurnDuration: typeof parsed.showTurnDuration === 'boolean'
        ? parsed.showTurnDuration
        : DEFAULT_USER_PREFERENCES.showTurnDuration,
    };
  } catch {
    return { ...DEFAULT_USER_PREFERENCES };
  }
}

function applyHydratedPreferences(next: UserPreferences) {
  state = preferencesEqual(state, next) ? { ...state } : next;
  hydrated = true;
  emit();
}

function ensureHydrationStarted() {
  if (hydrateStarted) return;

  hydrateStarted = true;
  const run = hydrationRun;
  const versionAtStart = mutationVersion;

  AsyncStorage.getItem(USER_PREFERENCES_STORAGE_KEY)
    .then((raw) => {
      if (run !== hydrationRun) return;
      if (versionAtStart !== mutationVersion) {
        applyHydratedPreferences({ ...state });
        return;
      }
      applyHydratedPreferences(parseStoredPreferences(raw));
    })
    .catch(() => {
      if (run !== hydrationRun) return;
      applyHydratedPreferences({ ...state });
    });
}

ensureHydrationStarted();

export function getUserPreferencesState() {
  ensureHydrationStarted();
  return state;
}

export function getUserPreference<K extends keyof UserPreferences>(key: K): UserPreferences[K] {
  ensureHydrationStarted();
  return state[key];
}

export function subscribeUserPreferences(listener: () => void) {
  listeners.add(listener);
  ensureHydrationStarted();
  return () => {
    listeners.delete(listener);
  };
}

export async function setUserPreference<K extends keyof UserPreferences>(
  key: K,
  value: UserPreferences[K],
) {
  ensureHydrationStarted();
  const previous = state;
  const next = { ...state, [key]: value };
  mutationVersion += 1;

  if (!preferencesEqual(previous, next)) {
    state = next;
    emit();
  }

  await AsyncStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(state));
}

export function useUserPreference<K extends keyof UserPreferences>(key: K) {
  const snapshot = useSyncExternalStore(
    subscribeUserPreferences,
    getUserPreferencesState,
    getUserPreferencesState,
  );
  const setPreference = useCallback(
    (value: UserPreferences[K]) => setUserPreference(key, value),
    [key],
  );

  return [snapshot[key], setPreference] as [
    UserPreferences[K],
    (value: UserPreferences[K]) => Promise<void>,
  ];
}

export function __resetUserPreferencesForTests(next?: Partial<UserPreferences>) {
  hydrationRun += 1;
  state = { ...DEFAULT_USER_PREFERENCES, ...next };
  hydrateStarted = false;
  hydrated = false;
  mutationVersion = 0;
  listeners.clear();
}

export function __getUserPreferencesHydratedForTests() {
  return hydrated;
}
