export const TELEMETRY_BUG_REF = 'spec_pentacle_mobile_test_migration_and_coverage';
export const CHAT_UI_BUG_BATCH_REF = 'chat_ui_bug_batch_2026_05_12';
export const E2E_TELEMETRY_FLOWS_REF = 'spec_pentacle_mobile_e2e_telemetry_flows_2026_05_13';
export const NOTIFICATIONS_L3_REF = 'spec_pentacle_mobile_notifications_l3_coverage';
export const QUESTION_L3_REF = 'spec_pentacle__chat_agent_question_parsing_2026_05_27';
export const CHAT_UI_PARITY_BATCH3_REF = 'spec_pentacle_mobile__chat_ui_parity_batch3_2026_05_27';
export const CHAT_RENDER_STABILITY_REF = 'spec_pentacle_mobile__chat_render_stability_2026_05_27';
export const CHAT_QUICK_WINS_REF = 'spec_pentacle_mobile_chat_quick_wins_2026_06_10';
export const TURN_PHASE_DERIVED_REF = 'spec_pentacle_mobile__chat_detail_working_indicator_missing_2026_06_16';
export const OPTIMISTIC_ORPHAN_TELEMETRY_REF = 'spec_pentacle__chat_streamd_optimistic_send_orphan_telemetry';
export const VOICE_INPUT_REF = 'spec_pentacle_mobile__voice_input_thoth_transcription_2026_09';

const HARNESS_PREFIX = 'harness';
const HARNESS_ARMED = 'harness_armed';
const HARNESS_AUTOACCEPT_BIOMETRIC = 'autoaccept_biometric_scheduled';
const HARNESS_FORCE_WS_RECONNECT = 'force_ws_reconnect_scheduled';
const HARNESS_SESSION_STATE_DUMP = 'session_state_dump';
const HARNESS_SESSION_STATE_DUMP_COMPLETE = 'session_state_dump_complete';
const HARNESS_SESSION_SCREEN_MOUNT = 'session_screen_mount';
const HARNESS_TRANSCRIPT_READY_SETTLED = 'transcript_ready_settled';
const HARNESS_TRANSCRIPT_ITEM_MOUNTED = ['transcript', 'item', 'mounted'].join(
  '_',
) as 'transcript_item_mounted';
const HARNESS_ROW_RENDERED = ['row', 'rendered'].join('_') as 'row_rendered';
const HARNESS_DOCK_LABEL_RENDER = ['dock', 'label', 'render'].join(
  '_',
) as 'dock_label_render';
const HARNESS_HEADER_STATUS_RENDER = ['header', 'status', 'render'].join(
  '_',
) as 'header_status_render';
const HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED = ['open', 'existing', 'chat', 'attempted'].join(
  '_',
) as 'open_existing_chat_attempted';
const HARNESS_NEW_STREAM_OBSERVED = ['new', 'stream', 'observed'].join(
  '_',
) as 'new_stream_observed';
const HARNESS_OPEN_STREAM_ATTEMPTED = ['open', 'stream', 'attempted'].join(
  '_',
) as 'open_stream_attempted';
const HARNESS_SEND_HANDLER_REGISTERED = ['send', 'handler', 'registered'].join(
  '_',
) as 'send_handler_registered';

export const TELEMETRY_EVENTS = {
  CHAT_WS_OPEN: 'chat:ws_open',
  CHAT_WS_CLOSE: 'chat:ws_close',
  CHAT_WS_RECONNECT_ATTEMPT: 'chat:ws_reconnect_attempt',
  CHAT_WS_RECONNECT_SUCCEEDED: 'chat:ws_reconnect_succeeded',
  CHAT_TRANSCRIPT_RESUMED: 'chat:transcript_resumed',
  CHAT_CURRENT_TAIL_RECOMPOSITION: 'chat:current_tail_recomposition',
  CHAT_EVENT_RECEIVED: 'chat:event_received',
  CHAT_EVENT_RENDERED: 'chat:event_rendered',
  CHAT_FOCUSED_LIVENESS_PROBE: 'chat:focused_liveness_probe',
  CHAT_SURFACE_TRAILING_BLANK_DROPPED: 'chat_surface:trailing_blank_dropped',
  CHAT_COMPOSE_OPTIMISTIC_INSERT: 'chat.compose.optimistic_insert',
  CHAT_COMPOSE_OPTIMISTIC_RECONCILED: 'chat.compose.optimistic_reconciled',
  CHAT_COMPOSE_OPTIMISTIC_FAILED: 'chat.compose.optimistic_failed',
  CHAT_COMPOSE_OPTIMISTIC_ORPHAN_SUSPECTED: 'chat.compose.optimistic_orphan_suspected',
  // FEAT-SEND-RETRY: the user tapped Retry on a "failed sending" overlay; the
  // row is re-armed to "sending" and re-transmitted.
  CHAT_COMPOSE_OPTIMISTIC_RETRY: 'chat.compose.optimistic_retry',
  CHAT_SESSION_FIRST_EVENT_AFTER_SEND: 'chat.session.first_event_after_send',
  CHAT_SESSION_SPAWN_SUMMARY_APPLIED: 'chat.session.spawn_summary_applied',
  CHAT_SEND_WHILE_NOT_IDLE: 'chat.compose.warn.send_while_not_idle',
  // Voice-input lifecycle (spec_pentacle_mobile__voice_input_thoth_transcription_2026_09).
  // Each emit carries subsystem:'mobile_voice', bug_ref (VOICE_INPUT_REF), stream_id,
  // recording_id, and where applicable duration_s/blob_sha/request_id/error_code.
  CHAT_VOICE_RECORD_STARTED: 'chat.voice.record_started',
  CHAT_VOICE_RECORD_STOPPED: 'chat.voice.record_stopped',
  CHAT_VOICE_RECORD_DISCARDED: 'chat.voice.record_discarded',
  CHAT_VOICE_UPLOAD_OK: 'chat.voice.upload_ok',
  CHAT_VOICE_UPLOAD_FAILED: 'chat.voice.upload_failed',
  CHAT_VOICE_TRANSCRIBE_OK: 'chat.voice.transcribe_ok',
  CHAT_VOICE_TRANSCRIBE_FAILED: 'chat.voice.transcribe_failed',
  CHAT_VOICE_TRANSCRIBE_CANCELLED: 'chat.voice.transcribe_cancelled',
  CHAT_VOICE_SEND_OUTCOME: 'chat.voice.send_outcome',
  CHAT_USER_SCROLLED: 'chat:user_scrolled',
  CHAT_AUTOSCROLL_DECISION: 'chat:autoscroll_decision',
  CHAT_HISTORY_BACKFILL_RENDERED: 'chat:history_backfill_rendered',
  CHAT_EMPTY_STATE_RENDERED: 'chat:empty_state_rendered',
  // FEAT-LOAD-RECOVERY: the session screen detected the resilient summary
  // (last_event_at) had outrun the newest event held and refetched recent
  // history to backfill a live frame dropped on a lossy link.
  CHAT_HISTORY_RECOVERY_REFETCH: 'chat:history_recovery_refetch',
  CHAT_QUESTION_RENDERED: 'chat:question_rendered',
  CHAT_TRANSCRIPT_ROW_RENDERED: 'chat:transcript_row_rendered',
  // Always-on turn-phase derivation telemetry (prod + harness). Emitted from the
  // chat-core reducer at every workingByStream phase transition — live events,
  // the detail-open fetch derivation, and the resync reconcile — so the
  // otherwise-invisible turn-phase derivation is observable for diagnosis and
  // validation. Data: {streamId, phase, source: 'fetch'|'live'|'resync',
  // drivingEventKey}. Spec:
  // spec_pentacle_mobile__chat_detail_working_indicator_missing_2026_06_16.
  CHAT_TURN_PHASE_DERIVED: 'chat:turn_phase_derived',
  CHAT_IMAGE_LOAD_STATE: 'chat:image_load_state',
  AUTH_BIOMETRIC_PROMPT_SCHEDULED: 'auth:biometric_prompt_scheduled',
  AUTH_BIOMETRIC_PROMPT_RESOLVED: 'auth:biometric_prompt_resolved',
  PUSH_NOTIFICATION_RECEIVED: 'push:notification_received',
  PUSH_TAP_ROUTED: 'push:tap_routed',
  // Always-on notification-surface domain telemetry (prod + harness). Mirrors
  // the chat:* domain events: emitted from pentacleStream's notification.*
  // message handlers and NotificationCard render, NOT gated on
  // EXPO_PUBLIC_HARNESS. Captured by idevicesyslog in L3 runs. Spec:
  // spec_pentacle_mobile_notifications_l3_coverage.
  NOTIFICATION_FRAME_APPLIED: 'notification:frame_applied',
  NOTIFICATION_LIST_SETTLED: 'notification:list_settled',
  NOTIFICATION_RESOLVE_SENT: 'notification:resolve_sent',
  NOTIFICATION_RESOLVE_SETTLED: 'notification:resolve_settled',
  NOTIFICATION_RESOLVE_FAILED: 'notification:resolve_failed',
  NOTIFICATION_CARD_RENDERED: 'notification:card_rendered',
  // Always-on agent-question domain telemetry (prod + harness). Mirrors the
  // notification:card_rendered render event: emitted from the QuestionCard
  // render when a session carries a pending question, NOT gated on
  // EXPO_PUBLIC_HARNESS. Captured by idevicesyslog in L3 runs. Spec:
  // spec_pentacle__chat_agent_question_parsing_2026_05_27.
  QUESTION_CARD_RENDERED: 'question:card_rendered',
  QUESTION_REOPEN_FETCH_ATTEMPT: 'question:reopen_fetch_attempt',
  QUESTION_REOPEN_FETCH_FAILED: 'question:reopen_fetch_failed',
  QUESTION_REOPEN_FETCH_READY: 'question:reopen_fetch_ready',
  QUESTION_ANSWER_SUBMIT_ATTEMPT: 'question:answer_submit_attempt',
  QUESTION_ANSWER_SUBMIT_FAILED: 'question:answer_submit_failed',
  QUESTION_ANSWER_SUBMIT_SENT: 'question:answer_submit_sent',
  QUESTION_INPUT_FOCUSED: 'question:input_focused',
  // Always-on chat-surface copy telemetry (prod + harness). Emitted when
  // mobile chat copy affordances copy message or raw code source text. Spec:
  // spec_pentacle_mobile__chat_ui_parity_batch3_2026_05_27.
  CHAT_COPY_INVOKED: 'chat:copy_invoked',
  HARNESS_HARNESS_ARMED: `${HARNESS_PREFIX}:${HARNESS_ARMED}`,
  HARNESS_AUTOACCEPT_BIOMETRIC_SCHEDULED: `${HARNESS_PREFIX}:${HARNESS_AUTOACCEPT_BIOMETRIC}`,
  HARNESS_FORCE_WS_RECONNECT_SCHEDULED: `${HARNESS_PREFIX}:${HARNESS_FORCE_WS_RECONNECT}`,
  HARNESS_SILENT_HALF_OPEN_ARMED: `${HARNESS_PREFIX}:silent_half_open_armed`,
  HARNESS_SILENT_HALF_OPEN_DROPPED: `${HARNESS_PREFIX}:silent_half_open_dropped`,
  HARNESS_SILENT_HALF_OPEN_CLOSE_SUPPRESSED: `${HARNESS_PREFIX}:silent_half_open_close_suppressed`,
  HARNESS_SILENT_HALF_OPEN_LATE_ONCLOSE_FIRED: `${HARNESS_PREFIX}:silent_half_open_late_onclose_fired`,
  HARNESS_SESSION_STATE_DUMP: `${HARNESS_PREFIX}:${HARNESS_SESSION_STATE_DUMP}`,
  HARNESS_SESSION_STATE_DUMP_COMPLETE: `${HARNESS_PREFIX}:${HARNESS_SESSION_STATE_DUMP_COMPLETE}`,
  HARNESS_SESSION_SCREEN_MOUNT: `${HARNESS_PREFIX}:${HARNESS_SESSION_SCREEN_MOUNT}`,
  HARNESS_TRANSCRIPT_READY_SETTLED: `${HARNESS_PREFIX}:${HARNESS_TRANSCRIPT_READY_SETTLED}`,
  HARNESS_TRANSCRIPT_ITEM_MOUNTED: `${HARNESS_PREFIX}:${HARNESS_TRANSCRIPT_ITEM_MOUNTED}`,
  HARNESS_ROW_RENDERED: `${HARNESS_PREFIX}:${HARNESS_ROW_RENDERED}`,
  HARNESS_DOCK_LABEL_RENDER: `${HARNESS_PREFIX}:${HARNESS_DOCK_LABEL_RENDER}`,
  HARNESS_HEADER_STATUS_RENDER: `${HARNESS_PREFIX}:${HARNESS_HEADER_STATUS_RENDER}`,
  HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED: `${HARNESS_PREFIX}:${HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED}`,
  HARNESS_NEW_STREAM_OBSERVED: `${HARNESS_PREFIX}:${HARNESS_NEW_STREAM_OBSERVED}`,
  HARNESS_OPEN_STREAM_ATTEMPTED: `${HARNESS_PREFIX}:${HARNESS_OPEN_STREAM_ATTEMPTED}`,
  HARNESS_SEND_HANDLER_REGISTERED: `${HARNESS_PREFIX}:${HARNESS_SEND_HANDLER_REGISTERED}`,
  HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED: `${HARNESS_PREFIX}:spawn_chat_then_send_scheduled`,
  HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED: `${HARNESS_PREFIX}:spawn_chat_then_send_composed`,
  HARNESS_SPAWN_CHAT_THEN_SEND_SENT: `${HARNESS_PREFIX}:spawn_chat_then_send_sent`,
  HARNESS_OPEN_CHAT_THEN_SEND_SCHEDULED: `${HARNESS_PREFIX}:open_chat_then_send_scheduled`,
  HARNESS_OPEN_CHAT_THEN_SEND_SENT: `${HARNESS_PREFIX}:open_chat_then_send_sent`,
  HARNESS_SEND_AGAIN_SENT: `${HARNESS_PREFIX}:send_again_sent`,
  HARNESS_SEND_AGAIN_SKIPPED: `${HARNESS_PREFIX}:send_again_skipped`,
  HARNESS_DISCONNECT_AFTER_SEND_SCHEDULED: `${HARNESS_PREFIX}:disconnect_after_send_scheduled`,
  HARNESS_DISCONNECT_AFTER_SEND_CLOSED: `${HARNESS_PREFIX}:disconnect_after_send_closed`,
  HARNESS_DISCONNECT_AFTER_SEND_ABORTED: `${HARNESS_PREFIX}:disconnect_after_send_aborted`,
  HARNESS_OPEN_SETTINGS_THEN_TOGGLE_SCHEDULED: `${HARNESS_PREFIX}:open_settings_then_toggle_scheduled`,
  HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE: `${HARNESS_PREFIX}:open_settings_then_toggle_done`,
  HARNESS_WRITE_USER_PREFERENCE_SCHEDULED: `${HARNESS_PREFIX}:write_user_preference_scheduled`,
  HARNESS_WRITE_USER_PREFERENCE_DONE: `${HARNESS_PREFIX}:write_user_preference_done`,
  HARNESS_SEND_ERROR_SUPPRESSED: `${HARNESS_PREFIX}:send_error_suppressed`,
  // Notifications L3 harness actions (compile-gated; dead-coded on prod).
  HARNESS_OPEN_UPDATES_SCHEDULED: `${HARNESS_PREFIX}:open_updates_scheduled`,
  HARNESS_OPEN_UPDATES_DONE: `${HARNESS_PREFIX}:open_updates_done`,
  HARNESS_RESOLVE_NOTIFICATION_SCHEDULED: `${HARNESS_PREFIX}:resolve_notification_scheduled`,
  HARNESS_RESOLVE_NOTIFICATION_DONE: `${HARNESS_PREFIX}:resolve_notification_done`,
  HARNESS_RESOLVE_NOTIFICATION_SKIPPED: `${HARNESS_PREFIX}:resolve_notification_skipped`,
  // Agent-question L3 harness action (compile-gated; dead-coded on prod).
  HARNESS_ANSWER_QUESTION_SCHEDULED: `${HARNESS_PREFIX}:answer_question_scheduled`,
  HARNESS_ANSWER_QUESTION_SENT: `${HARNESS_PREFIX}:answer_question_sent`,
  HARNESS_ANSWER_QUESTION_SKIPPED: `${HARNESS_PREFIX}:answer_question_skipped`,
  HARNESS_OPEN_CHAT_WHILE_WS_DOWN_SCHEDULED: `${HARNESS_PREFIX}:open_chat_while_ws_down_scheduled`,
  HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE: `${HARNESS_PREFIX}:open_chat_while_ws_down_done`,
  HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED: `${HARNESS_PREFIX}:open_chat_while_ws_down_aborted`,
  HARNESS_SEND_FIXTURE_IMAGE_SENT: `${HARNESS_PREFIX}:send_fixture_image_sent`,
  HARNESS_RETRY_FAILED_SEND_SCHEDULED: `${HARNESS_PREFIX}:retry_failed_send_scheduled`,
  HARNESS_RETRY_FAILED_SEND_SENT: `${HARNESS_PREFIX}:retry_failed_send_sent`,
  HARNESS_RETRY_FAILED_SEND_SKIPPED: `${HARNESS_PREFIX}:retry_failed_send_skipped`,
  HARNESS_TRANSCRIPT_ORDER_DUMP: `${HARNESS_PREFIX}:transcript_order_dump`,
} as const;

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS];

export const TELEMETRY_EVENT_NAMES = Object.values(TELEMETRY_EVENTS) as TelemetryEvent[];

export const TELEMETRY_EVENT_BUG_REFS: Record<TelemetryEvent, string> = {
  ...Object.fromEntries(TELEMETRY_EVENT_NAMES.map((name) => [name, TELEMETRY_BUG_REF])) as Record<
    TelemetryEvent,
    string
  >,
  [TELEMETRY_EVENTS.CHAT_IMAGE_LOAD_STATE]: 'spec_pentacle_mobile__decoded_photo_spinner_overlay_2026_09',
  [TELEMETRY_EVENTS.CHAT_SURFACE_TRAILING_BLANK_DROPPED]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_ORPHAN_SUSPECTED]: OPTIMISTIC_ORPHAN_TELEMETRY_REF,
  [TELEMETRY_EVENTS.CHAT_CURRENT_TAIL_RECOMPOSITION]: 'spec_pentacle_mobile__stale_feed_client_state_clobber_2026_08',
  [TELEMETRY_EVENTS.CHAT_SESSION_FIRST_EVENT_AFTER_SEND]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_SESSION_SPAWN_SUMMARY_APPLIED]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_SEND_WHILE_NOT_IDLE]: CHAT_UI_BUG_BATCH_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_RECORD_STARTED]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_RECORD_STOPPED]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_RECORD_DISCARDED]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_UPLOAD_OK]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_UPLOAD_FAILED]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_TRANSCRIBE_OK]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_TRANSCRIBE_FAILED]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_TRANSCRIBE_CANCELLED]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.CHAT_VOICE_SEND_OUTCOME]: VOICE_INPUT_REF,
  [TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SCHEDULED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_SCHEDULED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_SCHEDULED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_SCHEDULED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_DONE]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_SEND_ERROR_SUPPRESSED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.NOTIFICATION_FRAME_APPLIED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.NOTIFICATION_LIST_SETTLED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_SENT]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_SETTLED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_FAILED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.NOTIFICATION_CARD_RENDERED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.CHAT_COPY_INVOKED]: CHAT_UI_PARITY_BATCH3_REF,
  [TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ITEM_MOUNTED]: CHAT_RENDER_STABILITY_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_SCHEDULED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_DONE]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_DONE]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED]: NOTIFICATIONS_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_CARD_RENDERED]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_ATTEMPT]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_FAILED]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_READY]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_ATTEMPT]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_FAILED]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_SENT]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.QUESTION_INPUT_FOCUSED]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_ANSWER_QUESTION_SCHEDULED]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_ANSWER_QUESTION_SENT]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.HARNESS_ANSWER_QUESTION_SKIPPED]: QUESTION_L3_REF,
  [TELEMETRY_EVENTS.CHAT_HISTORY_BACKFILL_RENDERED]: CHAT_QUICK_WINS_REF,
  [TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED]: CHAT_QUICK_WINS_REF,
  [TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED]: CHAT_QUICK_WINS_REF,
  [TELEMETRY_EVENTS.CHAT_TURN_PHASE_DERIVED]: TURN_PHASE_DERIVED_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_SCHEDULED]: CHAT_QUICK_WINS_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE]: CHAT_QUICK_WINS_REF,
  [TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED]: CHAT_QUICK_WINS_REF,
  [TELEMETRY_EVENTS.HARNESS_SEND_FIXTURE_IMAGE_SENT]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SCHEDULED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SENT]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SKIPPED]: E2E_TELEMETRY_FLOWS_REF,
  [TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ORDER_DUMP]: CHAT_RENDER_STABILITY_REF,
};
