// Re-exports for tests/contracts/traces. Importers use:
//
//   import { runTrace, type TraceContract } from '../traces';
//   import { COMPOSER_SEND_WITH_NEWLINE } from '../traces/composer_send_with_newline';

export * from './types';
export {
  runTrace,
  assertStable,
  AssertStableError,
  rowIdsStable,
  createFakeDaemonHarness,
  type AssertStableCondition,
  type AssertStableConditionName,
  type AssertStableErrorKind,
  type AssertStableMutationLogEntry,
  type AssertStableOptions,
  type AssertStablePredicate,
  type AssertStableResult,
  type AssertStableSnapshot,
  type CanonicalStableRow,
  type TraceSetup,
  type FakeDaemonHarness,
  type FakeDaemonOptions,
} from './runner';

import { COMPOSER_SEND_WITH_NEWLINE } from './composer_send_with_newline';
import { SEND_TURN_CLAUDE } from './send_turn_claude';
import { SEND_TURN_CODEX } from './send_turn_codex';
import { EXISTING_CHAT_ASSIST_ARRIVES } from './existing_chat_assist_arrives';
import { CODEX_SINGLE_DIVIDER_PER_TURN } from './codex_single_divider_per_turn';
import {
  DURABLE_QUESTION_NOTIFICATION_DISPLAY,
  QUESTION_ASK_ANSWER_DISPLAY,
} from './question_ask_answer_display';
import { CHAT_EVENT_ORDERING_REPLAY } from './chat_event_ordering_replay';
import { OPTIMISTIC_ECHO_RECONCILE } from './optimistic_echo_reconcile';
import { PENDING_SEND_LIVE_APPLY } from './pending_send_live_apply';
import { HISTORY_FETCH_RETRY_HYDRATE } from './history_fetch_retry_hydrate';
import type { TraceContract } from './types';

export {
  COMPOSER_SEND_WITH_NEWLINE,
  SEND_TURN_CLAUDE,
  SEND_TURN_CODEX,
  EXISTING_CHAT_ASSIST_ARRIVES,
  CODEX_SINGLE_DIVIDER_PER_TURN,
  DURABLE_QUESTION_NOTIFICATION_DISPLAY,
  QUESTION_ASK_ANSWER_DISPLAY,
  CHAT_EVENT_ORDERING_REPLAY,
  OPTIMISTIC_ECHO_RECONCILE,
  PENDING_SEND_LIVE_APPLY,
  HISTORY_FETCH_RETRY_HYDRATE,
};

/**
 * Inventory of shipped trace contracts. Used by `tools/print_trace.ts` and any
 * tooling that needs to iterate the set.
 */
export const TRACE_INVENTORY: Readonly<Record<string, TraceContract>> = Object.freeze({
  composer_send_with_newline: COMPOSER_SEND_WITH_NEWLINE,
  send_turn_claude: SEND_TURN_CLAUDE,
  send_turn_codex: SEND_TURN_CODEX,
  existing_chat_assist_arrives: EXISTING_CHAT_ASSIST_ARRIVES,
  codex_single_divider_per_turn: CODEX_SINGLE_DIVIDER_PER_TURN,
  question_ask_answer_display: QUESTION_ASK_ANSWER_DISPLAY,
  durable_question_notification_display: DURABLE_QUESTION_NOTIFICATION_DISPLAY,
  chat_event_ordering_replay: CHAT_EVENT_ORDERING_REPLAY,
  optimistic_echo_reconcile: OPTIMISTIC_ECHO_RECONCILE,
  pending_send_live_apply: PENDING_SEND_LIVE_APPLY,
  history_fetch_retry_hydrate: HISTORY_FETCH_RETRY_HYDRATE,
});
