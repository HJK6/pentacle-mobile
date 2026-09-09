// Trace contract runner — walks a TraceContract step-by-step, asserts ordering
// and (optionally) timing tags, and produces a markdown-quality failure report.
//
// Jest parallel-worker safety: NO module-level state. Every runTrace call creates
// fresh harness instances. Two concurrent runTrace calls cannot observe each other.

import {
  DEFAULT_ADVISORY_POLICY,
  isNegativeStep,
  isPositiveStep,
  type AssertFn,
  type ComposerObserver,
  type DaemonStep,
  type NegativeStep,
  type ObservedElement,
  type ObservedEvent,
  type PentacleStreamState,
  type PositiveStep,
  type ReducerObserver,
  type ScreenObserver,
  type TimingPolicy,
  type TraceContract,
  type TraceFailReason,
  type TraceResult,
  type TraceSnapshot,
  type TraceStep,
  type TurnState,
  type UserStep,
} from './types';
import { INITIAL_PENTACLE_LIMITS } from 'pentacle-chat-core';

// ─────────────────────────────────────────────────────────────────────────────
// Public surface

export interface TraceSetup {
  streamId: string;
  driveUserAction(step: UserStep): Promise<void>;
  injectDaemonEvent(step: DaemonStep): Promise<void>;
  observers: {
    reducer: ReducerObserver;
    screen: ScreenObserver;
    composer: ComposerObserver;
  };
  /** Optional hook: lets the test reset the fake daemon between traces. */
  resetFakeDaemon?(): void;
  /** Provides the current PentacleStreamState. Called per-step to build the TraceSnapshot. */
  getState(): PentacleStreamState;
  /** Optional act() flush. Falls back to a microtask flush if omitted. */
  flush?(): Promise<void>;
  /**
   * Optional source of monotonic milliseconds. Strict-mode policy ignores this and uses
   * `policy.clockSource`; advisory mode uses this (or Date.now) for event timestamps.
   */
  monotonic?(): number;
}

export async function runTrace(
  trace: TraceContract,
  setup: TraceSetup,
  policy: TimingPolicy = DEFAULT_ADVISORY_POLICY,
): Promise<TraceResult> {
  return await new TraceRun(trace, setup, policy).run();
}

export type AssertStableConditionName =
  | 'working_dock_visible'
  | 'working_dock_not_visible'
  | 'transcript_count_unchanged'
  | 'row_ids_stable';

export interface CanonicalStableRow {
  row_id: string;
  content_version: string | number | null;
}

export interface AssertStableSnapshot extends TraceSnapshot {
  /**
   * Canonical rows only: no React keys, native tags, mount generations, or object
   * identities. Predicates that care about FlatList rows should use this field.
   */
  rows: CanonicalStableRow[];
}

export type AssertStablePredicate = (
  snap: AssertStableSnapshot,
) => boolean | { ok: boolean; msg?: string };

export type AssertStableCondition = AssertStableConditionName | AssertStablePredicate;

export interface AssertStableOptions {
  condition: AssertStableCondition;
  /** Use `required` to require the same predicate as `condition` during phase 1. */
  initial: 'required' | AssertStableCondition;
  settle_ms: number;
  quiet_window_ms: number;
  max_wait_ms: number;
}

export interface AssertStableMutationLogEntry {
  at_ms: number;
  source: 'initial' | 'poll' | 'event';
  event?: ObservedEvent;
  rows: CanonicalStableRow[];
  state: PentacleStreamState;
}

export interface AssertStableResult {
  ok: true;
  initial_satisfied_at_ms: number;
  quiet_window_ms: number;
  mutations: AssertStableMutationLogEntry[];
}

export type AssertStableErrorKind =
  | 'initial_state_never_reached'
  | 'condition_violated_during_quiet_window'
  | 'max_wait_exceeded';

export class AssertStableError extends Error {
  constructor(
    readonly kind: AssertStableErrorKind,
    message: string,
    readonly details: {
      lastState: PentacleStreamState;
      mutations: AssertStableMutationLogEntry[];
      observed: ObservedEvent[];
    },
  ) {
    super(message);
    this.name = 'AssertStableError';
  }
}

/**
 * Two-phase state-stability assertion for trace scenarios.
 *
 * Phase 1 waits from call time until `initial` is true, bounded by `settle_ms`.
 * Phase 2 starts at the first instant `initial` is true and requires `condition`
 * to remain true for `quiet_window_ms`. `max_wait_ms` is a hard total budget.
 * When a stalled poll observes both phase-one deadlines expired, the earlier
 * deadline wins; equal deadlines deterministically prefer `max_wait_exceeded`.
 *
 * FlatList row remounts are compared through canonical `{ row_id, content_version }`
 * rows, not React identity. Use `rowIdsStable` or `snap.rows` in custom predicates.
 * `AssertStableError` carries `details.lastState`, `details.mutations`, and
 * `details.observed`; condition-violation failures include the chronological
 * mutation log in `details.mutations`.
 */
export async function assertStable(
  setup: TraceSetup,
  options: AssertStableOptions,
): Promise<AssertStableResult> {
  validateAssertStableOptions(options);

  const observed: ObservedEvent[] = [];
  const pendingEvents: ObservedEvent[] = [];
  const detach = installEventListener(setup, (event) => {
    observed.push(event);
    pendingEvents.push(event);
  });

  const startMs = stableClockNow(setup);
  const maxDeadlineMs = startMs + options.max_wait_ms;
  const settleDeadlineMs = startMs + options.settle_ms;
  const baselineState = setup.getState();
  let lastSnapshot = buildAssertStableSnapshot(setup, observed);

  try {
    while (true) {
      await (setup.flush?.() ?? Promise.resolve());
      const now = stableClockNow(setup);
      lastSnapshot = buildAssertStableSnapshot(setup, observed);

      if (now >= maxDeadlineMs && maxDeadlineMs <= settleDeadlineMs) {
        throw buildAssertStableError(
          'max_wait_exceeded',
          'max_wait exceeded before initial state was reached',
          lastSnapshot,
          [],
          observed,
        );
      }

      const initialCondition =
        options.initial === 'required' ? options.condition : options.initial;
      const initial = evaluateStableCondition(initialCondition, lastSnapshot, baselineState);
      if (initial.ok) {
        return await assertStableQuietWindow(
          setup,
          options,
          observed,
          pendingEvents,
          baselineState,
          lastSnapshot,
          now,
          maxDeadlineMs,
        );
      }

      if (now >= settleDeadlineMs) {
        throw buildAssertStableError(
          'initial_state_never_reached',
          `initial state never reached within ${options.settle_ms}ms; last observed state: ${formatStableJson(lastSnapshot.state)}`,
          lastSnapshot,
          [],
          observed,
        );
      }

      await delay(nextAssertStableDelay(now, settleDeadlineMs, maxDeadlineMs));
    }
  } finally {
    detach();
  }
}

export function rowIdsStable(
  stateBefore: PentacleStreamState,
  stateAfter: PentacleStreamState,
  streamId?: string,
): boolean {
  const before = canonicalRowIdSet(stateBefore, streamId);
  const after = canonicalRowIdSet(stateAfter, streamId);
  if (before.length !== after.length) return false;
  return before.every((rowId, index) => rowId === after[index]);
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fake-daemon harness — used by runner unit tests and by future
// thin test wrappers that don't need a real Expo screen rendered.

export interface FakeDaemonHarness {
  setup: TraceSetup;
  /** Replace the simulated state. Reducer observers see the new state on next snapshot(). */
  setState(state: PentacleStreamState): void;
  /** Patch a fragment onto the state and notify subscribers. */
  patchState(partial: Partial<PentacleStreamState>): void;
  /** Set mounted testIDs. */
  setMounted(testID: string, mounted: boolean): void;
  /** Set rendered text for a testID. */
  setTextByTestID(testID: string, text: string | null): void;
  /** Composer state setters. */
  setComposerText(text: string): void;
  setSendButtonDisabled(disabled: boolean): void;
  /** Emit a positive-step-shaped event into the observed-event stream. */
  emit(event: Omit<ObservedEvent, 'ts_observer_monotonic'>): void;
}

export interface FakeDaemonOptions {
  streamId: string;
  initialState?: PentacleStreamState;
  /** Optional turn snapshotter. Default reads `state.workingStates[streamId]` + `sessions` shape. */
  computeTurn?: (state: PentacleStreamState, streamId: string) => TurnState | undefined;
  /** Optional driveUserAction override. Default emits an `observed` event. */
  driveUserAction?: (step: UserStep, harness: FakeDaemonHarness) => Promise<void>;
  /** Optional injectDaemonEvent override. Default emits an `observed` event. */
  injectDaemonEvent?: (step: DaemonStep, harness: FakeDaemonHarness) => Promise<void>;
}

export function createFakeDaemonHarness(opts: FakeDaemonOptions): FakeDaemonHarness {
  const monotonicStart = nowMs();
  const monotonic = () => nowMs() - monotonicStart;

  let state: PentacleStreamState = opts.initialState ?? emptyState();
  const mounted: Set<string> = new Set();
  const everMounted: Set<string> = new Set();
  const textByTestID: Map<string, string> = new Map();
  let composerText = '';
  let sendButtonDisabled = false;
  const eventLog: ObservedEvent[] = [];
  /** Listeners installed via the public observer subscribe API. */
  const turnSubscribers: Map<string, Set<(turn: TurnState) => void>> = new Map();
  /** Listeners installed by the runner for emit() / mount transitions. */
  const eventListeners: Set<(event: ObservedEvent) => void> = new Set();

  const computeTurnFn = opts.computeTurn ?? defaultComputeTurn;

  function notifyTurnSubscribers(streamId: string) {
    const turn = computeTurnFn(state, streamId);
    if (!turn) return;
    const subs = turnSubscribers.get(streamId);
    if (!subs) return;
    for (const sub of subs) sub(turn);
  }

  function emit(event: Omit<ObservedEvent, 'ts_observer_monotonic'>) {
    const observed: ObservedEvent = { ...event, ts_observer_monotonic: monotonic() };
    eventLog.push(observed);
    for (const l of eventListeners) l(observed);
  }

  const reducer: ReducerObserver = {
    snapshot: () => state,
    getTurn: (streamId) => computeTurnFn(state, streamId),
    subscribeToTurn: (streamId, listener) => {
      let subs = turnSubscribers.get(streamId);
      if (!subs) {
        subs = new Set();
        turnSubscribers.set(streamId, subs);
      }
      subs.add(listener);
      return () => {
        subs?.delete(listener);
      };
    },
  };

  const screen: ScreenObserver = {
    isMountedByTestID: (testID) => mounted.has(testID),
    findByTestID: (testID): ObservedElement | null =>
      mounted.has(testID) ? { testID } : null,
    queryTextByTestID: (testID) => (textByTestID.has(testID) ? textByTestID.get(testID) ?? null : null),
    wasMountedAtAnyPointByTestID: (testID) => everMounted.has(testID),
  };

  const composer: ComposerObserver = {
    isSendButtonDisabled: () => sendButtonDisabled,
    composerText: () => composerText,
  };

  const harness: FakeDaemonHarness = {
    // setup is populated below after harness construction so it can close over `harness` itself.
    setup: undefined as unknown as TraceSetup,
    setState(next) {
      state = next;
      notifyTurnSubscribers(opts.streamId);
    },
    patchState(partial) {
      state = { ...state, ...partial };
      notifyTurnSubscribers(opts.streamId);
    },
    setMounted(testID, isMounted) {
      const wasMounted = mounted.has(testID);
      if (isMounted) {
        mounted.add(testID);
        everMounted.add(testID);
        if (!wasMounted) emit({ source: 'screen', name: screenMountEffect(testID) });
      } else if (wasMounted) {
        mounted.delete(testID);
        emit({ source: 'screen', name: screenUnmountEffect(testID) });
      }
    },
    setTextByTestID(testID, text) {
      if (text == null) textByTestID.delete(testID);
      else {
        textByTestID.set(testID, text);
        emit({ source: 'screen', name: screenRenderEffect(testID), payload: { text } });
      }
    },
    setComposerText(text) {
      composerText = text;
      emit({ source: 'composer', name: 'composer_text_changed', payload: { text } });
    },
    setSendButtonDisabled(disabled) {
      sendButtonDisabled = disabled;
      emit({
        source: 'composer',
        name: disabled ? 'send_button_disabled' : 'send_button_enabled',
      });
    },
    emit,
  };

  const setup: TraceSetup = {
    streamId: opts.streamId,
    observers: { reducer, screen, composer },
    getState: () => state,
    monotonic,
    flush: async () => {
      // Microtask flush — fake harness has no React tree, no act() wrapper needed.
      await Promise.resolve();
    },
    resetFakeDaemon: () => {
      state = opts.initialState ?? emptyState();
      mounted.clear();
      everMounted.clear();
      textByTestID.clear();
      composerText = '';
      sendButtonDisabled = false;
      eventLog.length = 0;
      turnSubscribers.clear();
      eventListeners.clear();
    },
    driveUserAction: async (step) => {
      if (opts.driveUserAction) {
        await opts.driveUserAction(step, harness);
        return;
      }
      emit({ source: 'user', name: step.action, payload: step.payload });
    },
    injectDaemonEvent: async (step) => {
      if (opts.injectDaemonEvent) {
        await opts.injectDaemonEvent(step, harness);
        return;
      }
      emit({ source: 'daemon', name: step.event, payload: step.payload });
    },
  };

  harness.setup = setup;

  // Internal hook for the runner to install event listeners. Attached to `setup` (not
  // `harness`) because that's the object passed into runTrace. Non-enumerable so the
  // TraceSetup public surface stays focused.
  Object.defineProperty(setup, '__eventListeners', {
    value: eventListeners,
    enumerable: false,
  });
  Object.defineProperty(setup, '__eventLog', {
    value: eventLog,
    enumerable: false,
  });

  return harness;
}

// Internal: lets the runner attach a listener to either a fake-daemon-emitted event
// stream OR to its own observed-event buffer when running against a real screen.
function installEventListener(setup: TraceSetup, listener: (event: ObservedEvent) => void): () => void {
  const internal = (setup as unknown as { __eventListeners?: Set<(event: ObservedEvent) => void> });
  // If setup came from createFakeDaemonHarness, hook directly into its emit().
  // Otherwise the runner falls back to its own observed-event buffer (see TraceRun).
  if (internal.__eventListeners instanceof Set) {
    internal.__eventListeners.add(listener);
    return () => internal.__eventListeners?.delete(listener);
  }
  return () => undefined;
}

function defaultComputeTurn(state: PentacleStreamState, streamId: string): TurnState | undefined {
  const session = state.sessions.find((s) => s.stream_id === streamId);
  const ws = state.workingStates?.[streamId];
  if (!session && !ws) return undefined;
  const phase: TurnState['phase'] = ws
    ? 'working'
    : session?.pending
      ? 'pending'
      : 'idle';
  const firstServerEvent = state.events.find(
    (e) => e.stream_id === streamId && !e.client_origin,
  );
  return {
    streamId,
    phase,
    firstServerEventAt: firstServerEvent ? Date.parse(firstServerEvent.timestamp) || null : null,
  };
}

function emptyState(): PentacleStreamState {
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    events: [],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [],
    limits: INITIAL_PENTACLE_LIMITS,
    updates: [],
    notifications: [],
    workingStates: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal TraceRun: per-call instance, no shared state across calls.

class TraceRun {
  private readonly observed: ObservedEvent[] = [];
  private readonly armedNegatives: ArmedNegative[] = [];
  private readonly effectWindows = new Map<number, EffectWindow>();
  private readonly listeners = new Set<(event: ObservedEvent) => void>();
  private readonly detachExternal: () => void;

  constructor(
    private readonly trace: TraceContract,
    private readonly setup: TraceSetup,
    private readonly policy: TimingPolicy,
  ) {
    // Mirror events out of the fake harness into our observed[] buffer so assertions
    // can read them. When the setup is a real-screen wiring, callers can manually push
    // events via setup.observers (the runner doesn't depend on this hook).
    this.detachExternal = installEventListener(this.setup, (event) => this.onObserved(event));
  }

  async run(): Promise<TraceResult> {
    try {
      for (let i = 0; i < this.trace.steps.length; i++) {
        const step = this.trace.steps[i];
        // Decay armed negatives that have aged out by step count.
        this.decayArmedNegativesByStep(i);

        if (isNegativeStep(step)) {
          // Arming a negative AT this index: window begins here and extends forward.
          this.armNegative(step, i);
          continue;
        }

        // Before flushing this positive step, install listeners for any negatives whose
        // assertLabel-time anchor is "the immediately following positive step." Per spec
        // §"Listener installation," the runner installs the negative-step listener BEFORE
        // the preceding positive step's act() flush fires. We model that with a
        // look-ahead: if the NEXT step is a negative, install its listener now so a
        // same-tick violation triggered by this positive step is captured.
        const next = this.trace.steps[i + 1];
        if (next && isNegativeStep(next)) {
          this.armNegative(next, i + 1);
        }

        if (step.actor === 'user' || step.actor === 'daemon') {
          this.captureEffectWindowsAfterDriver(i);
        }

        const result = await this.executePositive(step, i);
        if (!result.ok) {
          return this.finalize({
            ok: false,
            failedAtStep: { index: i, step, reason: result.reason! },
          });
        }

        // After the positive step's act() flush, check if any armed negative fired.
        const violation = this.firstViolation();
        if (violation) {
          return this.finalize({
            ok: false,
            failedAtStep: {
              index: violation.armed.armedAtIndex,
              step: violation.armed.step,
              reason: {
                kind: 'negative_step_violation',
                message:
                  violation.armed.step.assertLabel ??
                  `negated event ${describeNegated(violation.armed.step.not)} fired during window`,
                offendingEvent: violation.event,
              },
            },
          });
        }
      }

      // End-of-trace: armed negatives without a fired match pass.
      return this.finalize({ ok: true });
    } finally {
      this.detachExternal();
      this.listeners.clear();
    }
  }

  private onObserved(event: ObservedEvent) {
    this.observed.push(event);
    for (const listener of this.listeners) listener(event);
    for (const armed of this.armedNegatives) {
      if (armed.violationAt) continue;
      if (matches(armed.step.not, event)) {
        armed.violationAt = event;
      }
    }
  }

  private armNegative(step: NegativeStep, atIndex: number) {
    if (this.armedNegatives.some((a) => a.step === step)) return;
    const armedAt = this.setup.monotonic ? this.setup.monotonic() : performance.now();
    this.armedNegatives.push({ step, armedAtIndex: atIndex, armedAtMs: armedAt });
  }

  private decayArmedNegativesByStep(currentIndex: number) {
    for (const armed of this.armedNegatives) {
      if (armed.disarmed) continue;
      const windowSteps = armed.step.within_steps;
      const windowMs = armed.step.within_ms;
      if (typeof windowSteps === 'number' && currentIndex - armed.armedAtIndex >= windowSteps) {
        armed.disarmed = true;
      }
      if (typeof windowMs === 'number' && this.setup.monotonic) {
        const elapsed = this.setup.monotonic() - armed.armedAtMs;
        if (elapsed >= windowMs) armed.disarmed = true;
      }
    }
  }

  private firstViolation(): { armed: ArmedNegative; event: ObservedEvent } | null {
    for (const armed of this.armedNegatives) {
      if (armed.disarmed) continue;
      if (armed.violationAt) return { armed, event: armed.violationAt };
    }
    return null;
  }

  private async executePositive(
    step: PositiveStep,
    index: number,
  ): Promise<{ ok: boolean; reason?: TraceFailReason }> {
    try {
      switch (step.actor) {
        case 'user':
          await this.setup.driveUserAction(step);
          break;
        case 'daemon':
          await this.setup.injectDaemonEvent(step);
          break;
        case 'reducer':
        case 'screen':
        case 'composer':
          return await this.waitForEffect(step, index);
      }

      await (this.setup.flush?.() ?? Promise.resolve());

      const assertFn = (step as { assert?: AssertFn }).assert;
      if (assertFn) {
        const snap: TraceSnapshot = {
          state: this.setup.getState(),
          streamId: this.setup.streamId,
          observed: this.observed.slice(),
          observers: this.setup.observers,
        };
        const result = assertFn(snap);
        const ok = typeof result === 'boolean' ? result : result.ok;
        if (!ok) {
          const msg =
            (typeof result === 'object' && result.msg) ||
            step.assertLabel ||
            describeStepLabel(step);
          return {
            ok: false,
            reason: {
              kind: 'positive_step_assert_failed',
              message: msg,
            },
          };
        }
      }

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: {
          kind: 'setup_error',
          message: `step ${index} threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  private captureEffectWindowsAfterDriver(driverIndex: number) {
    const windowStartObservedIndex = this.observed.length;
    const windowStartMs = this.clockNow();

    for (let i = driverIndex + 1; i < this.trace.steps.length; i++) {
      const step = this.trace.steps[i];
      if (isNegativeStep(step)) continue;
      if (step.actor === 'user' || step.actor === 'daemon') break;
      const assertFn = (step as { assert?: AssertFn }).assert;
      const initialAssert = assertFn ? this.evaluateAssert(assertFn) : undefined;
      this.effectWindows.set(i, {
        startObservedIndex: windowStartObservedIndex,
        startMs: windowStartMs,
        initialAssertOk: initialAssert?.ok,
      });
    }
  }

  private async waitForEffect(
    step: PositiveStep & { actor: 'reducer' | 'screen' | 'composer' },
    index: number,
  ): Promise<{ ok: boolean; reason?: TraceFailReason }> {
    const window = this.effectWindows.get(index) ?? {
      startObservedIndex: this.observed.length,
      startMs: this.clockNow(),
      initialAssertOk: undefined,
      precondition: true,
    };
    const timeoutMs = this.timeoutFor(step.t);
    const deadline = Number.isFinite(timeoutMs) ? window.startMs + timeoutMs : Number.POSITIVE_INFINITY;
    let lastAssert: AssertEvaluation | undefined;

    while (true) {
      await (this.setup.flush?.() ?? Promise.resolve());

      const matchingEvent = this.findMatchingEffectEvent(step, window.startObservedIndex);
      const assertFn = (step as { assert?: AssertFn }).assert;
      lastAssert = assertFn ? this.evaluateAssert(assertFn) : undefined;

      const assertOk = lastAssert?.ok ?? true;
      const transitioned =
        lastAssert?.ok === true && window.initialAssertOk === false;
      const preconditionSatisfied = window.precondition === true && assertOk;

      if (assertOk && (matchingEvent || transitioned || preconditionSatisfied)) {
        if (!matchingEvent) this.recordSyntheticEffect(step);
        return { ok: true };
      }

      const now = this.clockNow();
      if (now >= deadline) {
        if (lastAssert && !lastAssert.ok) {
          return {
            ok: false,
            reason: {
              kind: 'positive_step_assert_failed',
              message: lastAssert.msg ?? step.assertLabel ?? step.effect,
            },
          };
        }
        return {
          ok: false,
          reason: {
            kind: 'positive_step_timeout',
            message:
              step.assertLabel ??
              `${step.actor}.${step.effect} was not observed within ${formatTimeout(timeoutMs)}`,
          },
        };
      }

      await delay(Math.min(5, Math.max(1, deadline - now)));
    }
  }

  private findMatchingEffectEvent(
    step: PositiveStep & { actor: 'reducer' | 'screen' | 'composer' },
    startObservedIndex: number,
  ): ObservedEvent | undefined {
    return this.observed
      .slice(startObservedIndex)
      .find((event) => event.source === step.actor && event.name === step.effect);
  }

  private recordSyntheticEffect(step: PositiveStep & { actor: 'reducer' | 'screen' | 'composer' }) {
    const event: ObservedEvent = {
      ts_observer_monotonic: this.clockNow(),
      source: step.actor,
      name: step.effect,
    };
    this.onObserved(event);
  }

  private evaluateAssert(assertFn: AssertFn): AssertEvaluation {
    const snap: TraceSnapshot = {
      state: this.setup.getState(),
      streamId: this.setup.streamId,
      observed: this.observed.slice(),
      observers: this.setup.observers,
    };
    const result = assertFn(snap);
    if (typeof result === 'boolean') return { ok: result };
    return { ok: result.ok, msg: result.msg };
  }

  private timeoutFor(t: PositiveStep['t']): number {
    const tag = t ?? 'sameTick';
    if (this.policy.mode === 'strict') {
      return this.policy.budgets[tag];
    }
    switch (tag) {
      case 'sameTick':
        return 0;
      case '<50ms':
        return 50;
      case '<200ms':
        return 200;
      case '<500ms':
        return 500;
      case 'any':
      case 'end':
        return 500;
    }
  }

  private clockNow(): number {
    if (this.policy.mode === 'strict') return this.policy.clockSource();
    return this.setup.monotonic?.() ?? nowMs();
  }

  private finalize(partial: { ok: boolean; failedAtStep?: TraceResult['failedAtStep'] }): TraceResult {
    if (partial.ok) {
      return {
        ok: true,
        observedSequence: this.observed.slice(),
      };
    }
    return {
      ok: false,
      failedAtStep: partial.failedAtStep,
      observedSequence: this.observed.slice(),
      failureReport: this.buildFailureReport(partial.failedAtStep!),
    };
  }

  private buildFailureReport(fail: NonNullable<TraceResult['failedAtStep']>): string {
    const lines: string[] = [];
    lines.push(`### Trace \`${this.trace.name}\` failed at step ${fail.index}`);
    lines.push('');
    lines.push('**Step:**');
    lines.push('```json');
    lines.push(JSON.stringify(fail.step, replaceAssertFn, 2));
    lines.push('```');
    lines.push('');
    lines.push(`**Reason (${fail.reason.kind}):** ${fail.reason.message}`);
    if (fail.reason.offendingEvent) {
      lines.push('');
      lines.push('**Offending event:**');
      lines.push('```json');
      lines.push(JSON.stringify(fail.reason.offendingEvent, null, 2));
      lines.push('```');
    }
    lines.push('');
    const tail = this.observed.slice(-5);
    lines.push(`**Last ${tail.length} observed events:**`);
    lines.push('');
    lines.push('| ts_monotonic | source | name | payload |');
    lines.push('| ---: | --- | --- | --- |');
    for (const ev of tail) {
      lines.push(
        `| ${ev.ts_observer_monotonic.toFixed(2)} | ${ev.source} | ${ev.name} | ${formatPayload(ev.payload)} |`,
      );
    }
    return lines.join('\n');
  }
}

interface ArmedNegative {
  step: NegativeStep;
  armedAtIndex: number;
  armedAtMs: number;
  disarmed?: boolean;
  violationAt?: ObservedEvent;
}

interface EffectWindow {
  startObservedIndex: number;
  startMs: number;
  initialAssertOk?: boolean;
  precondition?: boolean;
}

interface AssertEvaluation {
  ok: boolean;
  msg?: string;
}

async function assertStableQuietWindow(
  setup: TraceSetup,
  options: AssertStableOptions,
  observed: ObservedEvent[],
  pendingEvents: ObservedEvent[],
  baselineState: PentacleStreamState,
  initialSnapshot: AssertStableSnapshot,
  initialAtMs: number,
  maxDeadlineMs: number,
): Promise<AssertStableResult> {
  const quietDeadlineMs = initialAtMs + options.quiet_window_ms;
  const mutations: AssertStableMutationLogEntry[] = [
    stableMutationLogEntry(initialAtMs, 'initial', initialSnapshot),
  ];
  let lastFingerprint = stableStateFingerprint(initialSnapshot.state);

  while (true) {
    await (setup.flush?.() ?? Promise.resolve());
    const now = stableClockNow(setup);
    const snapshot = buildAssertStableSnapshot(setup, observed);
    const fingerprint = stableStateFingerprint(snapshot.state);
    const events = pendingEvents.splice(0);

    if (fingerprint !== lastFingerprint || events.length > 0) {
      for (const event of events) {
        mutations.push(stableMutationLogEntry(now, 'event', snapshot, event));
      }
      if (fingerprint !== lastFingerprint) {
        mutations.push(stableMutationLogEntry(now, 'poll', snapshot));
        lastFingerprint = fingerprint;
      }
    }

    const condition = evaluateStableCondition(options.condition, snapshot, baselineState);
    if (!condition.ok) {
      const detail = condition.msg ? `: ${condition.msg}` : '';
      throw buildAssertStableError(
        'condition_violated_during_quiet_window',
        `condition violated during quiet window${detail}; chronological log of state mutations during the window: ${formatStableJson(mutations)}`,
        snapshot,
        mutations,
        observed,
      );
    }

    if (now >= quietDeadlineMs) {
      return {
        ok: true,
        initial_satisfied_at_ms: initialAtMs,
        quiet_window_ms: options.quiet_window_ms,
        mutations,
      };
    }

    if (now >= maxDeadlineMs) {
      throw buildAssertStableError(
        'max_wait_exceeded',
        `max_wait exceeded before ${options.quiet_window_ms}ms quiet window completed`,
        snapshot,
        mutations,
        observed,
      );
    }

    await delay(nextAssertStableDelay(now, quietDeadlineMs, maxDeadlineMs));
  }
}

function validateAssertStableOptions(options: AssertStableOptions) {
  const fields: Array<keyof Pick<
    AssertStableOptions,
    'settle_ms' | 'quiet_window_ms' | 'max_wait_ms'
  >> = ['settle_ms', 'quiet_window_ms', 'max_wait_ms'];
  for (const field of fields) {
    const value = options[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`assertStable ${field} must be a finite non-negative number`);
    }
  }
}

function evaluateStableCondition(
  condition: AssertStableCondition,
  snap: AssertStableSnapshot,
  baselineState: PentacleStreamState,
): { ok: boolean; msg?: string } {
  if (typeof condition === 'function') {
    const result = condition(snap);
    if (typeof result === 'boolean') return { ok: result };
    return { ok: result.ok, msg: result.msg };
  }

  switch (condition) {
    case 'working_dock_visible': {
      const phase = snap.observers.reducer.getTurn(snap.streamId)?.phase;
      const mounted = isWorkingDockMounted(snap);
      return {
        ok: phase === 'working' || mounted,
        msg: `working dock is not visible; phase=${phase ?? 'missing'} mounted=${mounted}`,
      };
    }
    case 'working_dock_not_visible': {
      const phase = snap.observers.reducer.getTurn(snap.streamId)?.phase;
      const mounted = isWorkingDockMounted(snap);
      return {
        ok: phase !== 'working' && !mounted,
        msg: `working dock is visible; phase=${phase ?? 'missing'} mounted=${mounted}`,
      };
    }
    case 'transcript_count_unchanged': {
      const before = canonicalRowsFromState(baselineState, snap.streamId).length;
      const after = snap.rows.length;
      return {
        ok: before === after,
        msg: `transcript row count changed from ${before} to ${after}`,
      };
    }
    case 'row_ids_stable':
      return {
        ok: rowIdsStable(baselineState, snap.state, snap.streamId),
        msg: 'canonical row_id set changed',
      };
  }
}

function isWorkingDockMounted(snap: AssertStableSnapshot): boolean {
  return (
    snap.observers.screen.isMountedByTestID('working-dock') ||
    snap.observers.screen.isMountedByTestID('working-dock-root') ||
    snap.observers.screen.isMountedByTestID('WorkingDock')
  );
}

function buildAssertStableSnapshot(
  setup: TraceSetup,
  observed: ObservedEvent[],
): AssertStableSnapshot {
  const state = setup.getState();
  return {
    state,
    streamId: setup.streamId,
    observed: observed.slice(),
    observers: setup.observers,
    rows: canonicalRowsFromState(state, setup.streamId),
  };
}

function buildAssertStableError(
  kind: AssertStableErrorKind,
  message: string,
  snap: AssertStableSnapshot,
  mutations: AssertStableMutationLogEntry[],
  observed: ObservedEvent[],
): AssertStableError {
  return new AssertStableError(kind, message, {
    lastState: snap.state,
    mutations,
    observed: observed.slice(),
  });
}

function stableMutationLogEntry(
  atMs: number,
  source: AssertStableMutationLogEntry['source'],
  snap: AssertStableSnapshot,
  event?: ObservedEvent,
): AssertStableMutationLogEntry {
  return {
    at_ms: atMs,
    source,
    event,
    rows: snap.rows,
    state: snap.state,
  };
}

function nextAssertStableDelay(now: number, ...deadlines: number[]): number {
  const nextDeadline = Math.min(...deadlines.filter((d) => Number.isFinite(d)));
  const untilDeadline = Math.max(0, nextDeadline - now);
  return Math.max(1, Math.min(5, untilDeadline));
}

function stableClockNow(setup: TraceSetup): number {
  return setup.monotonic?.() ?? nowMs();
}

function stableStateFingerprint(state: PentacleStreamState): string {
  return formatStableJson({
    phaseByStream: state.workingByStream,
    workingStreams: Object.keys(state.workingStates ?? {}).sort(),
    rows: canonicalRowsFromState(state),
    eventContentVersionByStream: state.eventContentVersionByStream,
    connected: state.connected,
    connecting: state.connecting,
    sessions: state.sessions.map((session) => ({
      stream_id: session.stream_id,
      pending: session.pending,
      working: session.working,
      last_kind: session.last_kind,
      last_event_at: session.last_event_at,
    })),
  });
}

function canonicalRowsFromState(
  state: PentacleStreamState,
  streamId?: string,
): CanonicalStableRow[] {
  const directRows = firstArray(
    readValue(state, 'rows'),
    readValue(state, 'transcriptRows'),
    readValue(state, 'renderedRows'),
  );
  const source = (directRows ?? state.events).filter((row) => rowMatchesStream(row, streamId));
  return source
    .map((row) => canonicalRowFromUnknown(row, state, streamId))
    .filter((row): row is CanonicalStableRow => row != null)
    .sort((a, b) => a.row_id.localeCompare(b.row_id));
}

function canonicalRowFromUnknown(
  value: unknown,
  state: PentacleStreamState,
  streamId?: string,
): CanonicalStableRow | null {
  const row = asRecord(value);
  if (!row) return null;
  const raw = asRecord(row.raw);
  const rowId =
    readString(row, 'row_id', 'rowId', 'event_key', 'eventKey') ??
    readString(raw, 'row_id', 'rowId', 'event_key', 'eventKey') ??
    eventLikeRowId(row);
  if (!rowId) return null;
  const rowStreamId = rowStreamIdFromUnknown(row) ?? streamId;
  return {
    row_id: rowId,
    content_version:
      readStableVersion(row, raw) ??
      (rowStreamId ? state.eventContentVersionByStream?.[rowStreamId] : undefined) ??
      null,
  };
}

function canonicalRowIdSet(state: PentacleStreamState, streamId?: string): string[] {
  return Array.from(
    new Set(canonicalRowsFromState(state, streamId).map((row) => row.row_id)),
  ).sort();
}

function rowMatchesStream(value: unknown, streamId?: string): boolean {
  if (!streamId) return true;
  const row = asRecord(value);
  if (!row) return false;
  const rowStreamId = rowStreamIdFromUnknown(row);
  return rowStreamId == null || rowStreamId === streamId;
}

function rowStreamIdFromUnknown(row: Record<string, unknown>): string | null {
  const raw = asRecord(row.raw);
  return (
    readString(row, 'stream_id', 'streamId') ??
    readString(raw, 'stream_id', 'streamId') ??
    streamIdFromRowId(readString(row, 'row_id', 'rowId', 'event_key', 'eventKey')) ??
    streamIdFromRowId(readString(raw, 'row_id', 'rowId', 'event_key', 'eventKey')) ??
    null
  );
}

function streamIdFromRowId(rowId: string | null): string | null {
  if (!rowId) return null;
  const optimisticMarker = ':optimistic:';
  const optimisticIndex = rowId.indexOf(optimisticMarker);
  if (optimisticIndex > 0) return rowId.slice(0, optimisticIndex);
  const seqSeparator = rowId.lastIndexOf(':');
  if (seqSeparator <= 0) return null;
  const seq = rowId.slice(seqSeparator + 1);
  return /^\d+$/.test(seq) ? rowId.slice(0, seqSeparator) : null;
}

function eventLikeRowId(row: Record<string, unknown>): string | null {
  const streamId = readString(row, 'stream_id', 'streamId');
  const optimisticId = readString(row, 'optimistic_id', 'optimisticId');
  if (streamId && optimisticId) return `${streamId}:optimistic:${optimisticId}`;
  const daemonSeq = readNumber(row, 'daemon_seq', 'daemonSeq');
  if (streamId && daemonSeq != null) return `${streamId}:${daemonSeq}`;
  const id = readString(row, 'id', 'key');
  return id ?? null;
}

function readStableVersion(
  row: Record<string, unknown>,
  raw: Record<string, unknown> | null,
): string | number | null {
  return (
    readStringOrNumber(row, 'content_version', 'contentVersion') ??
    readStringOrNumber(raw, 'content_version', 'contentVersion') ??
    null
  );
}

function firstArray(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function readValue(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function readNumber(record: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readStringOrNumber(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function matches(target: PositiveStep, event: ObservedEvent): boolean {
  if (target.actor !== event.source) return false;
  const targetName =
    target.actor === 'user'
      ? target.action
      : target.actor === 'daemon'
        ? target.event
        : target.effect;
  if (targetName !== event.name) return false;
  // Best-effort payload match: if target.payload is set, every property must equal.
  const targetPayload = (target as { payload?: unknown }).payload;
  if (targetPayload == null) return true;
  if (event.payload == null) return false;
  return shallowPayloadMatch(targetPayload, event.payload);
}

function shallowPayloadMatch(target: unknown, actual: unknown): boolean {
  if (target === actual) return true;
  if (target == null || actual == null) return false;
  if (typeof target !== 'object' || typeof actual !== 'object') return false;
  for (const key of Object.keys(target as Record<string, unknown>)) {
    if ((target as Record<string, unknown>)[key] !== (actual as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

function describeNegated(step: PositiveStep): string {
  switch (step.actor) {
    case 'user':
      return `${step.actor}.${step.action}`;
    case 'daemon':
      return `${step.actor}.${step.event}`;
    case 'reducer':
    case 'screen':
    case 'composer':
      return `${step.actor}.${step.effect}`;
  }
}

function describeStepLabel(step: PositiveStep): string {
  if (step.actor === 'user') return step.action;
  if (step.actor === 'daemon') return step.event;
  return step.effect;
}

function replaceAssertFn(_key: string, value: unknown): unknown {
  if (typeof value === 'function') return '<assert fn>';
  return value;
}

function formatPayload(payload: unknown): string {
  if (payload == null) return '—';
  try {
    return JSON.stringify(payload).slice(0, 60);
  } catch {
    return String(payload).slice(0, 60);
  }
}

function formatStableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTimeout(ms: number): string {
  return Number.isFinite(ms) ? `${ms}ms` : 'policy budget';
}

function screenMountEffect(testID: string): string {
  return `${testIDToTraceName(testID)}_mounts`;
}

function screenUnmountEffect(testID: string): string {
  return `${testIDToTraceName(testID)}_unmounts`;
}

function screenRenderEffect(testID: string): string {
  return `${testIDToTraceName(testID)}_renders`;
}

function testIDToTraceName(testID: string): string {
  return testID.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export { isNegativeStep, isPositiveStep };
export type { TraceStep };
