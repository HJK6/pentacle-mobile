import { dumpSessionState, dumpSingleSession } from '../../src/services/harnessDiagnostics';
import * as eventFlow from 'pentacle-chat-core';
import * as summaryFlow from '../../src/services/pentacleSummaryFlowDiagnostics';
import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'codex',
    session_id: 'hostc:chat-1',
    session_name: 'chat-1',
    stream_id: 'hostc:chat-1',
    timestamp: '2026-05-10T10:00:00.000Z',
    kind: 'ASSIST',
    text: 'visible answer',
    ...overrides,
  };
}

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: 'hostc:chat-1',
    host: 'hostc',
    provider: 'codex',
    session_name: 'chat-1',
    last_event_at: '2026-05-10T10:00:00.000Z',
    last_text: 'visible answer',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function state(): PentacleStreamState {
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    events: [event()],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [
      session(),
      session({
        stream_id: 'hostb:chat-2',
        host: 'hostb',
        session_name: 'chat-2',
        last_text: '',
        last_kind: '',
      }),
      session({
        stream_id: 'hosta:chat-3',
        host: 'hosta',
        session_name: 'chat-3',
        last_text: '',
        last_kind: '',
      }),
    ],
    updates: [],
    notifications: [],
  };
}

beforeEach(() => {
  eventFlow.reset();
  summaryFlow.reset();
});

afterEach(() => {
  setTelemetrySink(null);
});

test('dumpSessionState emits per-session payloads and terminator without render telemetry', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  eventFlow.recordInbound(event());
  eventFlow.recordPersistedDelta('hostc:chat-1', 1);
  summaryFlow.recordSummaryInbound('hostc:chat-1');
  eventFlow.recordInbound(event({
    daemon_seq: 2,
    stream_id: 'hostb:chat-2',
    host: 'hostb',
    session_id: 'hostb:chat-2',
    session_name: 'chat-2',
    text: 'Booting MCP server: codex_apps (7s • esc to interrupt)',
  }));
  eventFlow.recordDrop('hostb:chat-2', 'noise_filter');
  summaryFlow.recordSummaryInbound('hostb:chat-2');
  summaryFlow.recordSummaryStrip('hostb:chat-2', 'Booting MCP server: codex_apps (7s • esc to interrupt)');

  dumpSessionState(state());

  expect(seen.filter((item) => item.message === TELEMETRY_EVENTS.CHAT_EVENT_RENDERED)).toHaveLength(0);
  const dumps = seen.filter((item) => item.message === TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP);
  expect(dumps).toHaveLength(3);
  expect(dumps.map((item) => item.data.stream_id)).toEqual([
    'hostc:chat-1',
    'hostb:chat-2',
    'hosta:chat-3',
  ]);
  expect(dumps[0]?.data).toMatchObject({
    stream_id: 'hostc:chat-1',
    inbound_count: 1,
    persisted_count: 1,
    rendered_full_count: 1,
    rendered_visible_count: 1,
    host: 'hostc',
  });
  expect(dumps[1]?.data).toMatchObject({
    stream_id: 'hostb:chat-2',
    inbound_count: 1,
    persisted_count: 0,
    dropped_count_by_reason: { noise_filter: 1 },
    summary_inbound_count: 1,
    summary_strip_count: 1,
    rendered_full_count: 0,
    rendered_visible_count: 0,
    host: 'hostb',
  });
  expect(dumps[2]?.data).toMatchObject({
    stream_id: 'hosta:chat-3',
    inbound_count: 0,
    persisted_count: 0,
    rendered_full_count: 0,
    rendered_visible_count: 0,
    host: 'hosta',
  });
  expect(seen.at(-1)).toMatchObject({
    message: TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP_COMPLETE,
    data: {
      total_sessions: 3,
      total_hosts: 3,
      per_host_session_counts: { 'hostc': 1, 'hostb': 1, 'hosta': 1 },
      total_orphan_streams: 0,
    },
  });
});

test('dumpSingleSession emits only the requested session and no terminator', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  dumpSingleSession(state(), 'hostb:chat-2');

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    message: TELEMETRY_EVENTS.HARNESS_SESSION_STATE_DUMP,
    data: { stream_id: 'hostb:chat-2', host: 'hostb' },
  });
});
