import { logTelemetry } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import { diagSessionDetailCounts } from 'pentacle-chat-core';
import * as pentacleEventFlowDiagnostics from 'pentacle-chat-core';
import * as pentacleSummaryFlowDiagnostics from './pentacleSummaryFlowDiagnostics';

function eventFlowPayload(streamId: string) {
  const counts = pentacleEventFlowDiagnostics.snapshotCounts().get(streamId);
  return {
    inbound_count: counts?.inbound_count || 0,
    persisted_count: counts?.persisted_count || 0,
    dropped_count_by_reason: counts?.dropped_count_by_reason || {},
    source_tag_counts: counts?.source_tag_counts || {},
  };
}

function summaryFlowPayload(streamId: string) {
  const counts = pentacleSummaryFlowDiagnostics.snapshotCounts().get(streamId);
  return {
    summary_inbound_count: counts?.summary_inbound_count || 0,
    summary_strip_count: counts?.summary_strip_count || 0,
    summary_strip_last_text_observed: counts?.summary_strip_last_text_observed || '',
  };
}

function sessionPayload(
  state: PentacleStreamState,
  session: PentacleSessionSummary,
  extra: Record<string, unknown> = {},
) {
  const renderCounts = diagSessionDetailCounts(state, session.stream_id);
  return {
    stream_id: session.stream_id,
    orphan: false,
    ...eventFlowPayload(session.stream_id),
    ...summaryFlowPayload(session.stream_id),
    ...renderCounts,
    last_text_length: String(session.last_text || '').length,
    last_kind: session.last_kind || '',
    working: Boolean(session.working),
    online: Boolean(session.online),
    host: session.host || '',
    provider: session.provider || '',
    session_name: session.session_name || '',
    last_event_at: session.last_event_at || '',
    ...extra,
  };
}

function orphanPayload(streamId: string) {
  return {
    stream_id: streamId,
    orphan: true,
    ...eventFlowPayload(streamId),
    ...summaryFlowPayload(streamId),
    rendered_full_count: 0,
    rendered_visible_count: 0,
    last_text_length: 0,
    last_kind: '',
    working: false,
    online: false,
    host: '',
    provider: '',
    session_name: '',
    last_event_at: '',
  };
}

export function dumpSingleSession(
  state: PentacleStreamState,
  streamId: string,
  extra: Record<string, unknown> = {},
): void {
  const session = state.sessions.find((item) => item.stream_id === streamId);
  if (!session) return;
  logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP, sessionPayload(state, session, extra));
}

export function dumpSessionState(state: PentacleStreamState): void {
  const sessionStreamIds = new Set<string>();
  const hostCounts: Record<string, number> = {};

  for (const session of state.sessions) {
    sessionStreamIds.add(session.stream_id);
    const host = String(session.host || '');
    hostCounts[host] = (hostCounts[host] || 0) + 1;
    logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP, sessionPayload(state, session));
  }

  let orphanCount = 0;
  const eventCounts = pentacleEventFlowDiagnostics.snapshotCounts();
  for (const streamId of eventCounts.keys()) {
    if (sessionStreamIds.has(streamId)) continue;
    orphanCount += 1;
    logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP, orphanPayload(streamId));
  }

  logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP_COMPLETE, {
    total_sessions: state.sessions.length,
    total_hosts: Object.keys(hostCounts).filter(Boolean).length,
    per_host_session_counts: hostCounts,
    total_orphan_streams: orphanCount,
  });
}
