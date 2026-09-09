/**
 * Harness runtime — per-scenario arming via deep-link.
 *
 * Replaces the per-action `EXPO_PUBLIC_HARNESS_FORCE_WS_RECONNECT` and
 * `EXPO_PUBLIC_HARNESS_AUTOACCEPT_BIOMETRIC` build flags with a single
 * `EXPO_PUBLIC_HARNESS=1` compile-time gate plus runtime arming via
 * `pentacle://harness?actions=<csv>&scenario=<name>&<param>=<value>...`.
 *
 * Spec: public_behavior_contract (vendored from public-example's
 * harness_runtime_scenario_config_2026_05_08; API names match exactly so
 * a future shared-package extraction is mechanical). Only the URL-scheme
 * regex and the telemetry adapter shape differ — see the Conscious-divergence
 * notes in the alignment spec.
 *
 * Lifecycle:
 *   1. Cold launch: state is empty, `armed === false`.
 *   2. `app/_layout.tsx` module-scope block calls `Linking.getInitialURL()`:
 *      - On harness URL: `applyURL(url)` populates state, fires
 *        `harness:harness_armed` telemetry, sets `armed=true`.
 *      - On non-harness URL or null: `markBootResolved()` sets `armed=true`
 *        with empty state and does NOT fire `harness:harness_armed`.
 *   3. Auto-action gates check (compile flag) + `isArmed()` + `hasAction(token)`.
 *   4. Tests call `reset()` between cases.
 *
 * In-memory only (no AsyncStorage). Each cold launch starts empty so a
 * stale arming URL cannot replay across runs.
 */

import { useEffect, useState } from 'react';

import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import { logTelemetry } from 'pentacle-chat-core';

type State = {
  armed: boolean;
  actions: Set<string>;
  params: Map<string, string>;
  scenario: string | null;
};

const initial: State = {
  armed: false,
  actions: new Set(),
  params: new Map(),
  scenario: null,
};

const state: State = { ...initial };

const armedListeners = new Set<() => void>();

function notifyArmed(): void {
  for (const cb of armedListeners) {
    try {
      cb();
    } catch {}
  }
}

function isHarnessURL(url: string): boolean {
  return /^pentacle:\/\/harness(\?|$|\/)/i.test(url);
}

function parseQuery(url: string): URLSearchParams {
  const q = url.indexOf('?');
  if (q < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(q + 1));
}

/**
 * Atomically replace state from a harness URL. Returns true if the URL was
 * a harness URL (state was replaced and `armed` set true), false otherwise
 * (state untouched).
 *
 * Fires `harness:harness_armed` telemetry on success.
 */
/**
 * Byte budget for the `harness:harness_armed` `data` object. The full syslog
 * message (envelope + prefix) must stay under os_log's ~1024-byte truncation
 * point; the envelope and log prefix cost ~120 bytes, so this leaves headroom.
 */
const HARNESS_ARMED_DATA_BUDGET_BYTES = 700;

export function applyURL(url: string | null): boolean {
  if (!url || !isHarnessURL(url)) return false;
  const params = parseQuery(url);

  const actionsCsv = params.get('actions') ?? '';
  const actions = new Set(
    actionsCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const scenario = params.get('scenario') || null;

  const paramsMap = new Map<string, string>();
  for (const [k, v] of params) {
    if (k === 'actions' || k === 'scenario') continue;
    paramsMap.set(k, v);
  }

  const wasArmed = state.armed;
  state.armed = true;
  state.actions = actions;
  state.params = paramsMap;
  state.scenario = scenario;

  try {
    // The runner's same-run arming gate filters on `data.scenario_run_id`, so the
    // run id must be emitted as a VALUE — a `paramNames` entry is a key name and
    // never satisfies it (2026-08-29: chat_open_slo SETUP_FAIL with the app armed).
    const paramNames = [...paramsMap.keys()];
    const armed: Record<string, unknown> = {
      scenario,
      scenario_run_id: paramsMap.get('scenario_run_id') ?? null,
      actions: [...actions],
      paramNames,
    };
    // os_log truncates a message at ~1024 bytes and marks the cut with `<…>`,
    // which leaves invalid JSON that the log parser discards. chat_open_slo passes
    // ~35 params, so enumerating their names alone overran the cap and took the
    // arming event with it. Correlation fields outrank the name list: drop the
    // names rather than lose the event.
    if (JSON.stringify(armed).length > HARNESS_ARMED_DATA_BUDGET_BYTES) {
      delete armed.paramNames;
      armed.paramCount = paramNames.length;
    }
    logTelemetry(TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED, armed);
  } catch {}

  if (!wasArmed) notifyArmed();
  return true;
}

/**
 * One-shot — flips `armed = true` even if no harness URL was applied. Called
 * by `app/_layout.tsx` after the initial-URL Promise resolves so hooks
 * gating on `armed` can short-circuit and proceed.
 *
 * Does NOT fire `harness:harness_armed`. That event only fires on a
 * successful `applyURL` (i.e. an actual harness URL was processed).
 */
export function markBootResolved(): void {
  if (state.armed) return;
  state.armed = true;
  notifyArmed();
}

export function isArmed(): boolean {
  return state.armed;
}

export function hasAction(action: string): boolean {
  return state.actions.has(action);
}

export function getParam(name: string): string | undefined {
  return state.params.get(name);
}

export function getScenario(): string | null {
  return state.scenario;
}

/**
 * Async wait for `armed === true`. Used by event-driven callbacks
 * (e.g., `pentacleStream.onopen`) that fire outside the React lifecycle
 * and so cannot subscribe via `useHarnessReady`.
 *
 * Resolves immediately if already armed. Otherwise resolves when the
 * next `applyURL` / `markBootResolved` flips state, or after `timeoutMs`
 * — whichever comes first. The returned boolean indicates whether
 * armed flipped within the timeout.
 */
export function waitArmed(timeoutMs: number): Promise<boolean> {
  if (state.armed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cb = () => {
      if (settled) return;
      settled = true;
      armedListeners.delete(cb);
      resolve(true);
    };
    armedListeners.add(cb);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      armedListeners.delete(cb);
      resolve(state.armed);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Navigation-readiness gate
// ---------------------------------------------------------------------------
// The harness bootstrap runs at module load and from
// `Linking.getInitialURL().then(...)`, which on a COLD launch can resolve
// BEFORE the expo-router root navigator has mounted. A navigation-driving
// harness action (spawn_chat_then_send, open_chat_then_send, ...) that calls
// `router.push` at that point throws "Attempted to navigate before mounting
// the Root Layout component" — which the action layer swallows, so the flow
// silently aborts and never emits `harness:session_screen_mount`. RootLayout
// calls `markNavigationReady()` from a post-mount effect; navigation-driving
// dispatchers await `whenNavigationReady()` so the first push lands after the
// navigator is mounted.
let navigationReady = false;
const navigationReadyListeners = new Set<() => void>();
let harnessTokenReady = true;
const harnessTokenReadyListeners = new Set<() => void>();

export function markNavigationReady(): void {
  if (navigationReady) return;
  navigationReady = true;
  for (const cb of Array.from(navigationReadyListeners)) {
    try {
      cb();
    } catch {}
  }
  navigationReadyListeners.clear();
}

export function isNavigationReady(): boolean {
  return navigationReady;
}

/**
 * Resolves once the root navigator has mounted (RootLayout post-mount effect
 * called `markNavigationReady()`), or after `timeoutMs` as a safety valve.
 * Resolves immediately on the warm path (already mounted). The boolean
 * indicates whether navigation became ready within the timeout.
 */
export function whenNavigationReady(timeoutMs = 10000): Promise<boolean> {
  if (navigationReady) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cb = () => {
      if (settled) return;
      settled = true;
      navigationReadyListeners.delete(cb);
      resolve(true);
    };
    navigationReadyListeners.add(cb);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      navigationReadyListeners.delete(cb);
      resolve(navigationReady);
    }, timeoutMs);
  });
}

export function beginHarnessTokenReload(): void {
  harnessTokenReady = false;
}

export function markHarnessTokenReady(): void {
  if (harnessTokenReady) return;
  harnessTokenReady = true;
  for (const cb of Array.from(harnessTokenReadyListeners)) {
    try {
      cb();
    } catch {}
  }
  harnessTokenReadyListeners.clear();
}

export function isHarnessTokenReady(): boolean {
  return harnessTokenReady;
}

export function whenHarnessTokenReady(timeoutMs = 5000): Promise<boolean> {
  if (harnessTokenReady) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cb = () => {
      if (settled) return;
      settled = true;
      harnessTokenReadyListeners.delete(cb);
      resolve(true);
    };
    harnessTokenReadyListeners.add(cb);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      harnessTokenReadyListeners.delete(cb);
      resolve(harnessTokenReady);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Harness-active-stream tracker (replaces daemon run-id scoping)
// ---------------------------------------------------------------------------
// In production the app subscribes to every chat.event broadcast so the
// sidebar's live last-text preview updates (pentacleStreamReducer applies
// each event to its session summary). In the harness build that firehose
// also feeds logChatEventReceived -> [TELEMETRY], which on device floods
// idevicesyslog. Gate the MIRROR — not the WS subscription — to the chat(s)
// the scenario is actively driving / observing: production behavior is
// unchanged, and harness capture is naturally bounded to the active chat's
// events. Scenarios that observe a non-spawned chat add its stream_id once
// known (e.g. open-existing pickSession result, new-stream-observed marker).

const harnessActiveStreams = new Set<string>();

export function markStreamHarnessActive(streamId: string): void {
  if (!streamId) return;
  harnessActiveStreams.add(streamId);
}

export function isStreamHarnessActive(streamId: string): boolean {
  return harnessActiveStreams.has(streamId);
}

export function clearHarnessActiveStreams(): void {
  harnessActiveStreams.clear();
}

// Test-only: read the active set.
export function __getHarnessActiveStreamsForTests(): ReadonlySet<string> {
  return harnessActiveStreams;
}

/**
 * React hook — reactive `armed` state. NOT used by the biometric site
 * (which reads `isArmed()` synchronously to avoid mount-effect rerun on
 * armed flip; see the public harness contract.
 */
export function useHarnessReady(): boolean {
  const [ready, setReady] = useState(state.armed);
  useEffect(() => {
    if (state.armed) {
      if (!ready) setReady(true);
      return;
    }
    const cb = () => setReady(true);
    armedListeners.add(cb);
    return () => {
      armedListeners.delete(cb);
    };
  }, [ready]);
  return ready;
}

/**
 * Compose-driving plumbing (public_behavior_spec
 * Stage 2 §"Compose-driving plumbing"). The composer's `handleSend` closure
 * lives privately inside `ComposerBar`. To let harness scenarios drive
 * sends without leaking into production:
 *
 *   - `ComposerBar` exposes `onRegisterSendHandler` prop (under harness only).
 *   - `SessionScreen` wires it to `registerSendHandler(streamId, fn)`.
 *   - Action handlers call `dispatchSend(streamId, text)` to invoke the
 *     registered handler.
 *
 * Both `registerSendHandler` and `dispatchSend` short-circuit to no-ops
 * when `EXPO_PUBLIC_HARNESS !== '1'` so production bundles dead-code the
 * registration plumbing.
 */
export type HarnessFixtureImageRequest = {
  text?: string;
  fixtureImage: {
    name?: string;
    base64: string;
    mimeType: 'image/jpeg' | 'image/png';
    width?: number;
    height?: number;
    bytes?: number;
  };
};

export type HarnessSendRequest = string | HarnessFixtureImageRequest;

type SendHandler = (request: HarnessSendRequest) => Promise<void>;
type CopyHandler = (request: {
  targetId?: string;
  copyKind: 'message' | 'code';
  text: string;
}) => Promise<void>;

const sendHandlers = new Map<string, SendHandler>();
const sendHandlerWorkingChecks = new Map<string, () => boolean>();
const copyHandlers = new Map<string, CopyHandler>();

function harnessFlagOn(): boolean {
  return process.env.EXPO_PUBLIC_HARNESS === '1';
}

/**
 * Register a per-stream send handler that resolves the
 * composer's `handleSend` closure. Returns an unregister function that
 * removes the handler iff it is still the active one (LIFO-safe).
 *
 * Under production flag (`EXPO_PUBLIC_HARNESS !== '1'`) this is a no-op
 * that returns a no-op unregister.
 */
export function registerSendHandler(
  streamId: string,
  fn: SendHandler,
  isWorking?: () => boolean,
): () => void {
  if (!harnessFlagOn()) return () => undefined;
  sendHandlers.set(streamId, fn);
  if (isWorking) sendHandlerWorkingChecks.set(streamId, isWorking);
  // Emit so harness action handlers can wait for handler readiness before
  // calling dispatchSend. The ComposerBar's registration useEffect can
  // fire AFTER `harness:transcript_ready_settled`, which created a
  // dispatchSend → no_handler race on fast cold launches. Spec:
  // public_behavior_spec.
  logTelemetry(TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED, {
    stream_id: streamId,
  });
  return () => {
    if (sendHandlers.get(streamId) === fn) {
      sendHandlers.delete(streamId);
      sendHandlerWorkingChecks.delete(streamId);
    }
  };
}

export function registerCopyHandler(streamId: string, fn: CopyHandler): () => void {
  if (!harnessFlagOn()) return () => undefined;
  copyHandlers.set(streamId, fn);
  return () => {
    if (copyHandlers.get(streamId) === fn) {
      copyHandlers.delete(streamId);
    }
  };
}

export async function dispatchCopy(
  streamId: string,
  request: Parameters<CopyHandler>[0],
): Promise<{ status: 'ok' } | { status: 'no_handler' }> {
  if (!harnessFlagOn()) return { status: 'no_handler' };
  const handler = copyHandlers.get(streamId);
  if (!handler) return { status: 'no_handler' };
  await handler(request);
  return { status: 'ok' };
}

/** Tests + internal: read-only check whether a handler is registered. */
export function hasSendHandler(streamId: string): boolean {
  if (!harnessFlagOn()) return false;
  return sendHandlers.has(streamId);
}

/** Harness-only proof of the registered composer's queue decision state. */
export function isSendHandlerWorking(streamId: string): boolean {
  if (!harnessFlagOn()) return false;
  return sendHandlerWorkingChecks.get(streamId)?.() === true;
}

/**
 * Dispatch a send through the per-stream registered handler. Resolves to
 * `{status:'ok'}` after the handler resolves; resolves to
 * `{status:'no_handler'}` if no handler is registered for the stream OR
 * if the harness flag is off.
 */
export async function dispatchSend(
  streamId: string,
  request: HarnessSendRequest,
): Promise<{ status: 'ok' } | { status: 'no_handler' }> {
  if (!harnessFlagOn()) return { status: 'no_handler' };
  const handler = sendHandlers.get(streamId);
  if (!handler) return { status: 'no_handler' };
  await handler(request);
  return { status: 'ok' };
}

/** Tests only. */
export function __resetSendHandlersForTests(): void {
  sendHandlers.clear();
  sendHandlerWorkingChecks.clear();
  copyHandlers.clear();
}

/** Tests only. */
export function reset(): void {
  state.armed = initial.armed;
  state.actions = new Set();
  state.params = new Map();
  state.scenario = initial.scenario;
  armedListeners.clear();
  sendHandlers.clear();
  sendHandlerWorkingChecks.clear();
  copyHandlers.clear();
  navigationReady = false;
  navigationReadyListeners.clear();
  harnessTokenReady = true;
  harnessTokenReadyListeners.clear();
  harnessActiveStreams.clear();
}
