import { attemptOpenExistingChat } from '../../src/services/harnessOpenExistingChat';
import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import {
  setChatOpenPaintSink,
  beginChatOpenPaint,
  type ChatOpenPaintSignal,
} from '../../src/services/chatOpenPaintSignals';
import {
  acknowledgeChatRowNavigationIntent,
  resetChatOpenNavigationIntents,
} from '../../src/services/chatOpenNavigationIntent';

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: 'hostc:old',
    host: 'hostc',
    provider: 'codex',
    session_name: 'old',
    last_event_at: '2026-05-10T10:00:00.000Z',
    last_text: 'hello',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function state(sessions: PentacleSessionSummary[]): PentacleStreamState {
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    events: [],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions,
    updates: [],
    notifications: [],
  };
}

afterEach(() => {
  setTelemetrySink(null);
  setChatOpenPaintSink(null);
  resetChatOpenNavigationIntents();
});

test('opens the most-recent online session for the requested normalized host', () => {
  const seen: TelemetryPayload[] = [];
  const router = { push: jest.fn() };
  setTelemetrySink((payload) => seen.push(payload));

  const picked = attemptOpenExistingChat(
    state([
      session({ stream_id: 'hostc:older', host: ' hostc ', last_event_at: '2026-05-10T10:00:00.000Z' }),
      session({ stream_id: 'hostb:newest', host: 'hostb', last_event_at: '2026-05-10T12:00:00.000Z' }),
      session({ stream_id: 'hostc:offline', host: 'hostc', last_event_at: '2026-05-10T13:00:00.000Z', online: false }),
      session({ stream_id: 'hostc:newest/with space', host: 'hostc', last_event_at: '2026-05-10T11:00:00.000Z' }),
    ]),
    ' hostc ',
    router,
  );

  expect(picked).toBe('hostc:newest/with space');
  expect(seen).toEqual([
    expect.objectContaining({
      message: TELEMETRY_EVENTS.HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED,
      data: { stream_id: 'hostc:newest/with space', host: 'hostc' },
    }),
  ]);
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Anewest%2Fwith%20space');
});

test('no-ops when no online session exists for the requested host', () => {
  const seen: TelemetryPayload[] = [];
  const router = { push: jest.fn() };
  setTelemetrySink((payload) => seen.push(payload));

  const picked = attemptOpenExistingChat(
    state([
      session({ stream_id: 'hostc:offline', host: 'hostc', online: false }),
      session({ stream_id: 'hostb:online', host: 'hostb', online: true }),
    ]),
    'hostc',
    router,
  );

  expect(picked).toBeNull();
  expect(seen).toEqual([]);
  expect(router.push).not.toHaveBeenCalled();
});

test('returns the stream_id and emits attempted telemetry even when router.push throws (pre-mount)', () => {
  // Regression test: on cold launch the harness arming
  // callback fires before the React Root Layout mounts; expo-router throws
  // "Attempted to navigate before mounting the Root Layout component." The
  // open is best-effort visual navigation — the caller still needs the
  // stream_id back so downstream harness flow can proceed.
  const seen: TelemetryPayload[] = [];
  const router = {
    push: jest.fn(() => {
      throw new Error(
        'Attempted to navigate before mounting the Root Layout component',
      );
    }),
  };
  setTelemetrySink((payload) => seen.push(payload));

  const picked = attemptOpenExistingChat(
    state([session({ stream_id: 'hostc:premount', host: 'hostc' })]),
    'hostc',
    router,
  );

  expect(picked).toBe('hostc:premount');
  expect(router.push).toHaveBeenCalledTimes(1);
  const attempted = seen.find(
    (p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED,
  );
  expect(attempted?.data).toMatchObject({ stream_id: 'hostc:premount', host: 'hostc' });
});

test('skips agent worker sessions when picking an existing chat', () => {
  const router = { push: jest.fn() };
  const picked = attemptOpenExistingChat(
    state([
      session({
        stream_id: 'hostc:codex-hostc-1778958778',
        session_name: 'codex-hostc-1778958778',
        display_name: 'Synthetic worker session',
        last_event_at: '2026-05-10T13:00:00.000Z',
      }),
      session({
        stream_id: 'hostc:human-chat',
        session_name: 'human-chat',
        display_name: 'Human chat',
        last_event_at: '2026-05-10T12:00:00.000Z',
      }),
    ]),
    'hostc',
    router,
  );

  expect(picked).toBe('hostc:human-chat');
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Ahuman-chat');
});

test('stream_id override picks a specific eligible session', () => {
  const router = { push: jest.fn() };
  const picked = attemptOpenExistingChat(
    state([
      session({ stream_id: 'hostc:newest', session_name: 'newest', last_event_at: '2026-05-10T13:00:00.000Z' }),
      session({ stream_id: 'hostc:long-history', session_name: 'long-history', last_event_at: '2026-05-10T11:00:00.000Z' }),
    ]),
    'hostc',
    router,
    undefined,
    'hostc:long-history',
  );

  expect(picked).toBe('hostc:long-history');
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Along-history');
});

test('stream_id override routes before session inventory hydrates', () => {
  const router = { push: jest.fn() };
  const picked = attemptOpenExistingChat(
    state([]),
    'hostc',
    router,
    'claude',
    'hostc:fixture-before-inventory',
  );

  expect(picked).toBe('hostc:fixture-before-inventory');
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Afixture-before-inventory');
});

test('harness open begins the chat_open_paint trace and seeds the navigation intent', () => {
  // Root-cause seam: the reliability scenario opens via this harness path. Before the
  // fix it went straight to router.push, so beginChatOpenPaint was never called
  // and the destination screen acknowledged no correlationId -> zero paint
  // events. With a paint sink installed (as the harness observer does) the open
  // must emit `tap` + `router-dispatch-return` and hand the destination screen a
  // correlationId to acknowledge.
  const paint: ChatOpenPaintSignal[] = [];
  setChatOpenPaintSink((signal) => paint.push(signal));
  const router = { push: jest.fn() };

  const picked = attemptOpenExistingChat(
    state([session({ stream_id: 'hostc:paint', host: 'hostc' })]),
    'hostc',
    router,
  );

  expect(picked).toBe('hostc:paint');
  expect(paint.map((s) => s.phase)).toEqual(['tap', 'router-dispatch-return']);
  const correlationId = paint[0].correlationId;
  expect(correlationId).toBeTruthy();
  expect(paint.every((s) => s.correlationId === correlationId)).toBe(true);
  expect(paint.every((s) => s.streamId === 'hostc:paint')).toBe(true);
  // The destination screen's acknowledgement resolves the same correlationId.
  expect(acknowledgeChatRowNavigationIntent('hostc:paint')).toBe(correlationId);
});

test('production regression: harness open with the default NOOP paint sink emits ZERO chat_open_paint telemetry', () => {
  // Production default: no paint sink is installed (afterEach resets it to the
  // NOOP), so `beginChatOpenPaint` returns null and no chat_open_paint reaches
  // the telemetry channel. We CAPTURE the telemetry channel itself (the sink the
  // harness observer would forward paint into) and assert nothing paint-shaped
  // is emitted — the previous version created an observer it never installed, so
  // its assertions were vacuously true. A `harness:ui_trace` chat_open_paint
  // payload here would prove production leakage; other telemetry (the plain
  // open-existing-chat-attempted event) is expected and not paint.
  const telemetry: TelemetryPayload[] = [];
  setTelemetrySink((payload) => telemetry.push(payload));
  const router = { push: jest.fn() };

  const picked = attemptOpenExistingChat(
    state([session({ stream_id: 'hostc:noop', host: 'hostc' })]),
    'hostc',
    router,
  );

  expect(picked).toBe('hostc:noop');
  // Core production-NOOP invariant (mutation-detectable): with the default sink,
  // beginChatOpenPaint is disabled and returns null. If a regression flipped the
  // module's default sink to non-NOOP, this returns a correlationId and the whole
  // production guarantee — AC2 — is broken; this assertion fails loudly. (The
  // POSITIVE control — that this same harness path DOES emit paint once a sink is
  // installed — is the sibling test "harness open begins the chat_open_paint
  // trace", so this pair is mutation-complete without a tautological observer.)
  expect(beginChatOpenPaint('hostc:probe')).toBeNull();
  const paintPayloads = telemetry.filter(
    (p) => String(p.message) === 'harness:ui_trace' && (p.data as { kind?: string }).kind === 'chat_open_paint',
  );
  expect(paintPayloads).toEqual([]);
  // No correlationId was minted, so the destination has nothing to acknowledge —
  // a non-null here would mean paint ran and seeded the coordinator in prod.
  expect(acknowledgeChatRowNavigationIntent('hostc:noop')).toBeNull();
  // Sanity: the router still navigated and the plain attempted-telemetry DID
  // fire, proving the telemetry sink was actually capturing (not silent).
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Anoop');
  expect(telemetry.some((p) => String(p.message) === TELEMETRY_EVENTS.HARNESS_OPEN_EXISTING_CHAT_ATTEMPTED)).toBe(true);
});
