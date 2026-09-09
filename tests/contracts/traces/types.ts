// Trace contract types — declarative sequences as first-class test artifacts.
//
// This file is jest-only (lives under tests/). It is excluded from the production
// Expo bundle by the test configuration.
//
// `TurnState` is a synthesized per-stream view populated from the existing
// session, working-state, and event fields.

import type { PentacleStreamState } from 'pentacle-chat-core';

export type { PentacleStreamState };

/**
 * Synthesized per-stream "turn" view consumed by assert predicates.
 *
 * Derived by `ReducerObserver` from `state.sessions` + `state.workingStates`
 * + `state.events`.
 */
export interface TurnState {
  streamId: string;
  phase: 'idle' | 'pending' | 'working';
  /** Monotonic timestamp (ms since runner start) of the first server-side event for this turn. */
  firstServerEventAt: number | null;
  /** Last assist text observed for this turn, if any. */
  lastAssistText?: string;
  /** Count of terminal-divider events observed in this turn window. */
  dividerCount?: number;
}

/** Element returned by ScreenObserver lookups. Concrete shape is implementation-defined. */
export type ObservedElement = { testID: string } & Record<string, unknown>;

export type Actor = 'user' | 'daemon' | 'reducer' | 'screen' | 'composer';

export type RelativeTime = 'sameTick' | '<50ms' | '<200ms' | '<500ms' | 'any' | 'end';

/** Snapshot passed to assert predicates. Strongly typed; no eval, IDE-refactorable. */
export interface TraceSnapshot {
  state: PentacleStreamState;
  streamId: string;
  /** Events captured so far by the runner. */
  observed: ObservedEvent[];
  observers: {
    reducer: ReducerObserver;
    screen: ScreenObserver;
    composer: ComposerObserver;
  };
}

export type AssertResult = boolean | { ok: boolean; msg?: string };
export type AssertFn = (snap: TraceSnapshot) => AssertResult;

export type UserStep = {
  actor: 'user';
  action: string;
  payload?: unknown;
  t?: RelativeTime;
  assertLabel?: string;
};

export type DaemonStep = {
  actor: 'daemon';
  event: string;
  payload?: unknown;
  /** Optional fixture row index (line number, 0-based) the payload was sourced from. */
  fixtureRow?: number;
  /** Set to true for events the implementer authored without a fixture row. */
  synthetic?: boolean;
  t?: RelativeTime;
  assertLabel?: string;
};

export type ReducerStep = {
  actor: 'reducer';
  effect: string;
  assert: AssertFn;
  t?: RelativeTime;
  assertLabel?: string;
};

export type ScreenStep = {
  actor: 'screen';
  effect: string;
  assert?: AssertFn;
  t?: RelativeTime;
  assertLabel?: string;
};

export type ComposerStep = {
  actor: 'composer';
  effect: string;
  assert?: AssertFn;
  t?: RelativeTime;
  assertLabel?: string;
};

export type PositiveStep = UserStep | DaemonStep | ReducerStep | ScreenStep | ComposerStep;

/**
 * Negative steps assert that a matching event does NOT fire.
 *
 * Time-anchor semantics: `within_steps` / `within_ms` window opens at the position
 * of the negative step in the trace array and extends forward. For a between-anchored
 * negative (e.g. "no unmount-remount during open-chat window"), place the negative
 * step at the start of the window and set `within_steps` to span to the closing step.
 *
 * Listener installation: the runner installs the negative-step listener BEFORE the
 * immediately preceding positive step's act() flush fires, so synchronous violations
 * within the same tick are captured.
 */
export type NegativeStep = {
  not: PositiveStep;
  within_steps?: number;
  within_ms?: number;
  assertLabel?: string;
};

export type TraceStep = PositiveStep | NegativeStep;

export interface TraceContract {
  name: string;
  /** Resolves to tests/contracts/fixtures/<fixture>.jsonl */
  fixture: string;
  description: string;
  steps: TraceStep[];
}

export function isNegativeStep(step: TraceStep): step is NegativeStep {
  return typeof (step as NegativeStep).not === 'object' && (step as NegativeStep).not !== null;
}

export function isPositiveStep(step: TraceStep): step is PositiveStep {
  return !isNegativeStep(step);
}

/** Observer interfaces — the runner and trace files share these contracts. */
export interface ReducerObserver {
  snapshot(): PentacleStreamState;
  getTurn(streamId: string): TurnState | undefined;
  subscribeToTurn(streamId: string, listener: (turn: TurnState) => void): () => void;
}

export interface ScreenObserver {
  isMountedByTestID(testID: string): boolean;
  findByTestID(testID: string): ObservedElement | null;
  queryTextByTestID(testID: string): string | null;
  /** True if the testID was mounted at any point since the observer started. */
  wasMountedAtAnyPointByTestID(testID: string): boolean;
}

export interface ComposerObserver {
  isSendButtonDisabled(): boolean;
  composerText(): string;
}

/** Concrete timing policy. Passed to runTrace. */
export type TimingPolicy =
  | {
      mode: 'advisory';
      /** L1 default — same React act() flush. */
      sameTick: 'act_flush';
    }
  | {
      mode: 'strict';
      /** Monotonic clock source (ms). Supplied by the harness extension's Leg 1 observer at L3. */
      clockSource: () => number;
      budgets: Record<RelativeTime, number>;
    };

export const DEFAULT_ADVISORY_POLICY: TimingPolicy = { mode: 'advisory', sameTick: 'act_flush' };

export interface ObservedEvent {
  ts_observer_monotonic: number;
  source: Actor;
  /** action / event / effect name */
  name: string;
  payload?: unknown;
}

export interface TraceFailReason {
  kind:
    | 'positive_step_assert_failed'
    | 'positive_step_timeout'
    | 'negative_step_violation'
    | 'fixture_load_failed'
    | 'setup_error';
  message: string;
  /** For negative-step violations: the offending observed event. */
  offendingEvent?: ObservedEvent;
}

export interface TraceResult {
  ok: boolean;
  failedAtStep?: { index: number; step: TraceStep; reason: TraceFailReason };
  observedSequence: ObservedEvent[];
  /** Markdown-renderable diff for failure output. */
  failureReport?: string;
}
