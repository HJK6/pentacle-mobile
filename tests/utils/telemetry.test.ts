import { logTelemetry, setTelemetrySink, teeTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHAT_RENDER_STABILITY_REF,
  CHAT_QUICK_WINS_REF,
  CHAT_UI_BUG_BATCH_REF,
  CHAT_UI_PARITY_BATCH3_REF,
  E2E_TELEMETRY_FLOWS_REF,
  NOTIFICATIONS_L3_REF,
  OPTIMISTIC_ORPHAN_TELEMETRY_REF,
  QUESTION_L3_REF,
  TURN_PHASE_DERIVED_REF,
  TELEMETRY_BUG_REF,
  TELEMETRY_EVENT_BUG_REFS,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENT_NAMES, MOBILE_TELEMETRY_EVENTS } from '../../src/services/mobileTelemetryEvents';

afterEach(() => {
  setTelemetrySink(null);
});

function sourceFilesToScan(): string[] {
  const out: string[] = [];
  const visit = (relativePath: string) => {
    const absolutePath = resolve(relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolutePath)) {
        visit(`${relativePath}/${child}`);
      }
      return;
    }
    if (/\.[cm]?tsx?$/.test(relativePath)) {
      out.push(relativePath);
    }
  };
  visit('src');
  visit('app');
  return out;
}

function localTelemetryConstants(source: string): Record<string, string> {
  const constants: Record<string, string> = Object.fromEntries(
    [...source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*['"]([a-z][a-z0-9_]*[:.][a-z0-9_.]+)['"]/g)]
      .map((match) => [match[1], match[2]]),
  );
  for (const match of source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*TELEMETRY_EVENTS\.([A-Z0-9_]+)/g)) {
    const value = TELEMETRY_EVENTS[match[2] as keyof typeof TELEMETRY_EVENTS];
    if (value) constants[match[1]] = value;
  }
  for (const match of source.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*MOBILE_TELEMETRY_EVENTS\.([A-Z0-9_]+)/g)) {
    const value = MOBILE_TELEMETRY_EVENTS[match[2] as keyof typeof MOBILE_TELEMETRY_EVENTS];
    if (value) constants[match[1]] = value;
  }
  return constants;
}

function emittedTelemetryNames(source: string): Set<string> {
  const names = new Set<string>();
  const locals = localTelemetryConstants(source);
  for (const match of source.matchAll(/logTelemetry\(\s*([A-Z0-9_]+)\b/g)) {
    const value = locals[match[1]];
    if (value) names.add(value);
  }
  for (const match of source.matchAll(/logTelemetry\(\s*TELEMETRY_EVENTS\.([A-Z0-9_]+)\b/g)) {
    const value = TELEMETRY_EVENTS[match[1] as keyof typeof TELEMETRY_EVENTS];
    if (value) names.add(value);
  }
  for (const match of source.matchAll(/logTelemetry\(\s*MOBILE_TELEMETRY_EVENTS\.([A-Z0-9_]+)\b/g)) {
    const value = MOBILE_TELEMETRY_EVENTS[match[1] as keyof typeof MOBILE_TELEMETRY_EVENTS];
    if (value) names.add(value);
  }
  for (const match of source.matchAll(/logTelemetry\(\s*['"]([a-z][a-z0-9_]*[:.][a-z0-9_.]+)['"]/g)) {
    names.add(match[1]);
  }
  return names;
}

test('swaps telemetry sink and emits structured payloads', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, { url_host: 'default.example', attempt: 1 });

  expect(seen).toEqual([
    {
      subsystem: 'chat',
      message: TELEMETRY_EVENTS.CHAT_WS_OPEN,
      bug_ref: TELEMETRY_BUG_REF,
      data: { url_host: 'default.example', attempt: 1 },
    },
  ]);
});

test('tees telemetry sink and restores the previous sink', () => {
  const primary: TelemetryPayload[] = [];
  const tee: TelemetryPayload[] = [];
  setTelemetrySink((payload) => primary.push(payload));

  const restore = teeTelemetrySink((payload) => tee.push(payload));
  logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RENDERED, { stream_id: 'hostc:new' });
  restore();
  logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, { url_host: 'default.example' });

  expect(primary.map((payload) => payload.message)).toEqual([
    TELEMETRY_EVENTS.CHAT_EVENT_RENDERED,
    TELEMETRY_EVENTS.CHAT_WS_OPEN,
  ]);
  expect(tee.map((payload) => payload.message)).toEqual([TELEMETRY_EVENTS.CHAT_EVENT_RENDERED]);
});

test('tee cleanup is idempotent and never overwrites a newer sink', () => {
  const primary = jest.fn();
  const tee = jest.fn();
  const newer = jest.fn();
  setTelemetrySink(primary);
  const restore = teeTelemetrySink(tee);
  setTelemetrySink(newer);
  restore();
  restore();
  logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN);
  expect(primary).not.toHaveBeenCalled();
  expect(tee).not.toHaveBeenCalled();
  expect(newer).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
});

test('telemetry registry names are unique and case anchored', () => {
  expect(new Set(TELEMETRY_EVENT_NAMES).size).toBe(TELEMETRY_EVENT_NAMES.length);
  expect(new Set(MOBILE_TELEMETRY_EVENT_NAMES).size).toBe(MOBILE_TELEMETRY_EVENT_NAMES.length);
  expect(MOBILE_TELEMETRY_EVENT_NAMES).toEqual(expect.arrayContaining([
    MOBILE_TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_ATTEMPT,
    MOBILE_TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_READY,
    MOBILE_TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_FAILED,
    MOBILE_TELEMETRY_EVENTS.QUESTION_INPUT_FOCUSED,
    MOBILE_TELEMETRY_EVENTS.CHAT_HISTORY_BACKFILL_RENDERED,
    MOBILE_TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED,
    MOBILE_TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED,
    MOBILE_TELEMETRY_EVENTS.HARNESS_DISMISS_QUESTION_SCHEDULED,
    MOBILE_TELEMETRY_EVENTS.HARNESS_DISMISS_QUESTION_SENT,
    MOBILE_TELEMETRY_EVENTS.HARNESS_DISMISS_QUESTION_SKIPPED,
  ]));
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_TRANSCRIPT_RESUMED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.PUSH_TAP_ROUTED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_AUTOACCEPT_BIOMETRIC_SCHEDULED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_ROW_RENDERED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_DOCK_LABEL_RENDER);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_HEADER_STATUS_RENDER);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_NEW_STREAM_OBSERVED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_OPEN_STREAM_ATTEMPTED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_SURFACE_TRAILING_BLANK_DROPPED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_SESSION_FIRST_EVENT_AFTER_SEND);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_SESSION_SPAWN_SUMMARY_APPLIED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SCHEDULED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_SCHEDULED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_SCHEDULED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_SCHEDULED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_DONE);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_HISTORY_BACKFILL_RENDERED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED);
  expect(TELEMETRY_EVENT_NAMES).toContain(TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED);

  const chatUiBugBatchEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.CHAT_SURFACE_TRAILING_BLANK_DROPPED,
    TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT,
    TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED,
    TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED,
    TELEMETRY_EVENTS.CHAT_SESSION_FIRST_EVENT_AFTER_SEND,
    TELEMETRY_EVENTS.CHAT_SESSION_SPAWN_SUMMARY_APPLIED,
    TELEMETRY_EVENTS.CHAT_SEND_WHILE_NOT_IDLE,
  ]);
  const e2eTelemetryFlowEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED,
    TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED,
    TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT,
    TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT,
    TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT,
    TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED,
    TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED,
    TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED,
    TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE,
    TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_DONE,
    TELEMETRY_EVENTS.HARNESS_SEND_ERROR_SUPPRESSED,
    TELEMETRY_EVENTS.HARNESS_SEND_FIXTURE_IMAGE_SENT,
    TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SENT,
    TELEMETRY_EVENTS.HARNESS_RETRY_FAILED_SEND_SKIPPED,
  ]);
  // Notification coverage contract: 6
  // always-on notification:* domain events + 5 compile-gated harness:* action
  // events.
  const notificationsL3Events = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.NOTIFICATION_FRAME_APPLIED,
    TELEMETRY_EVENTS.NOTIFICATION_LIST_SETTLED,
    TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_SENT,
    TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_SETTLED,
    TELEMETRY_EVENTS.NOTIFICATION_RESOLVE_FAILED,
    TELEMETRY_EVENTS.NOTIFICATION_CARD_RENDERED,
    TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_DONE,
    TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_DONE,
    TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED,
  ]);
  // Agent-question coverage contract:
  // Always-on question:* domain events.
  const questionL3Events = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.QUESTION_CARD_RENDERED,
    TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_ATTEMPT,
    TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_FAILED,
    TELEMETRY_EVENTS.QUESTION_REOPEN_FETCH_READY,
    TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_ATTEMPT,
    TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_FAILED,
    TELEMETRY_EVENTS.QUESTION_ANSWER_SUBMIT_SENT,
    TELEMETRY_EVENTS.QUESTION_INPUT_FOCUSED,
    ...TELEMETRY_EVENT_NAMES.filter(
      (name) => TELEMETRY_EVENT_BUG_REFS[name] === QUESTION_L3_REF && String(name).startsWith('harness:'),
    ),
  ]);
  const chatUiParityBatch3Events = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.CHAT_COPY_INVOKED,
  ]);
  const chatRenderStabilityEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ITEM_MOUNTED,
    TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_ORDER_DUMP,
  ]);
  const chatQuickWinsEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.CHAT_HISTORY_BACKFILL_RENDERED,
    TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED,
    TELEMETRY_EVENTS.CHAT_TRANSCRIPT_ROW_RENDERED,
    TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_SCHEDULED,
    TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_DONE,
    TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_WHILE_WS_DOWN_ABORTED,
  ]);
  // Turn-phase derivation contract:
  // (working_indicator_contract):
  // the always-on chat:turn_phase_derived event emitted by the reducer.
  const turnPhaseDerivedEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.CHAT_TURN_PHASE_DERIVED,
  ]);
  const optimisticOrphanTelemetryEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_ORPHAN_SUSPECTED,
  ]);
  const currentTailRecompositionEvents = new Set<TelemetryEvent>([
    TELEMETRY_EVENTS.CHAT_CURRENT_TAIL_RECOMPOSITION,
  ]);
  for (const name of TELEMETRY_EVENT_NAMES) {
    let expectedRef: string;
    if (chatUiBugBatchEvents.has(name)) {
      expectedRef = CHAT_UI_BUG_BATCH_REF;
    } else if (chatUiParityBatch3Events.has(name)) {
      expectedRef = CHAT_UI_PARITY_BATCH3_REF;
    } else if (chatRenderStabilityEvents.has(name)) {
      expectedRef = CHAT_RENDER_STABILITY_REF;
    } else if (chatQuickWinsEvents.has(name)) {
      expectedRef = CHAT_QUICK_WINS_REF;
    } else if (turnPhaseDerivedEvents.has(name)) {
      expectedRef = TURN_PHASE_DERIVED_REF;
    } else if (optimisticOrphanTelemetryEvents.has(name)) {
      expectedRef = OPTIMISTIC_ORPHAN_TELEMETRY_REF;
    } else if (currentTailRecompositionEvents.has(name)) {
      expectedRef = 'chat-current-tail-recomposition';
    } else if (e2eTelemetryFlowEvents.has(name)) {
      expectedRef = E2E_TELEMETRY_FLOWS_REF;
    } else if (notificationsL3Events.has(name)) {
      expectedRef = NOTIFICATIONS_L3_REF;
    } else if (questionL3Events.has(name)) {
      expectedRef = QUESTION_L3_REF;
    } else {
      expectedRef = TELEMETRY_BUG_REF;
    }
    expect(TELEMETRY_EVENT_BUG_REFS[name]).toBe(expectedRef);
  }

  // New harness:* flow events use the harness subsystem prefix.
  for (const name of e2eTelemetryFlowEvents) {
    expect(String(name).startsWith('harness:')).toBe(true);
  }
  // Notifications L3 events split into a notification:* domain prefix (always
  // on) and a harness:* action prefix (compile-gated).
  for (const name of notificationsL3Events) {
    expect(
      String(name).startsWith('notification:') || String(name).startsWith('harness:'),
    ).toBe(true);
  }
  // Agent-question L3 events split into a question:* domain prefix (always on)
  // and a harness:* action prefix (compile-gated).
  for (const name of questionL3Events) {
    expect(
      String(name).startsWith('question:') || String(name).startsWith('harness:'),
    ).toBe(true);
  }
});

test('source logTelemetry event names are registered', () => {
  const registered = new Set<string>([
    ...TELEMETRY_EVENT_NAMES,
    ...MOBILE_TELEMETRY_EVENT_NAMES,
  ]);
  const emitted = new Set<string>();

  for (const relativePath of sourceFilesToScan()) {
    const source = readFileSync(resolve(relativePath), 'utf8');
    for (const name of emittedTelemetryNames(source)) {
      emitted.add(name);
    }
  }

  const missing = [...emitted].filter((name) => !registered.has(name)).sort();
  expect(missing).toEqual([]);
});

test('e2e telemetry flow events emit the harness subsystem and case reference', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED, { host: 'hostc', provider: 'codex' });
  logTelemetry(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED, {
    stream_id: 'hostc:codex:one',
    optimistic_id: 'optimistic_hostc_codex_one_1',
  });
  logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE, { from_value: false, to_value: true });

  expect(seen).toEqual([
    expect.objectContaining({
      subsystem: 'harness',
      message: TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED,
      bug_ref: E2E_TELEMETRY_FLOWS_REF,
      data: { host: 'hostc', provider: 'codex' },
    }),
    expect.objectContaining({
      subsystem: 'harness',
      message: TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED,
      bug_ref: E2E_TELEMETRY_FLOWS_REF,
      data: { stream_id: 'hostc:codex:one', optimistic_id: 'optimistic_hostc_codex_one_1' },
    }),
    expect.objectContaining({
      subsystem: 'harness',
      message: TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE,
      bug_ref: E2E_TELEMETRY_FLOWS_REF,
      data: { from_value: false, to_value: true },
    }),
  ]);
});

test('registered chat surface telemetry emits the chat UI case reference', () => {
  const seen: TelemetryPayload[] = [];
  setTelemetrySink((payload) => seen.push(payload));

  logTelemetry(TELEMETRY_EVENTS.CHAT_SURFACE_TRAILING_BLANK_DROPPED, { stream_id: 'alpha:chat', count: 1 });
  logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, { stream_id: 'alpha:chat', optimistic_id: 'optimistic_alpha_chat_1' });

  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      subsystem: 'chat_surface',
      message: TELEMETRY_EVENTS.CHAT_SURFACE_TRAILING_BLANK_DROPPED,
      bug_ref: CHAT_UI_BUG_BATCH_REF,
      data: { stream_id: 'alpha:chat', count: 1 },
    }),
    expect.objectContaining({
      subsystem: 'chat_surface',
      message: TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT,
      bug_ref: CHAT_UI_BUG_BATCH_REF,
      data: { stream_id: 'alpha:chat', optimistic_id: 'optimistic_alpha_chat_1' },
    }),
  ]));
});

test('default telemetry is silent and leaves serialization unreached', () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const payload = { toJSON: () => { throw new Error('must not serialize'); } };

  expect(() => logTelemetry('' as any, { diagnostic: 'fallback', payload })).not.toThrow();

  expect(logSpy).not.toHaveBeenCalled();
  logSpy.mockRestore();
});
