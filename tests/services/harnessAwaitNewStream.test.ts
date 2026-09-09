import { subscribeAndOpenNewStream } from '../../src/services/harnessAwaitNewStream';
import { logTelemetry, setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type { PentacleEvent, PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';
import * as harnessDiagnostics from '../../src/services/harnessDiagnostics';
import { resetChatOpenNavigationIntents } from '../../src/services/chatOpenNavigationIntent';

jest.mock('../../src/services/harnessDiagnostics', () => ({
  dumpSingleSession: jest.fn(),
}));

function event(overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 1,
    host: 'hostc',
    provider: 'codex',
    session_id: '',
    session_name: 'codex-new',
    stream_id: 'hostc:new',
    timestamp: '2026-05-10T10:00:00.000Z',
    kind: 'USER',
    text: 'ACK marker:run-1',
    ...overrides,
  };
}

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: 'hostc:new',
    host: 'hostc',
    provider: 'codex',
    session_name: 'codex-new',
    last_event_at: '2026-05-10T10:00:00.000Z',
    last_text: 'ACK marker:run-1',
    last_kind: 'USER',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function state(events: PentacleEvent[]): PentacleStreamState {
  const streamId = events[0]?.stream_id || 'hostc:new';
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    events,
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions: [session({ stream_id: streamId })],
    updates: [],
    notifications: [],
  };
}

function makeStream(initial: PentacleStreamState) {
  let current = initial;
  const listeners: Array<() => void> = [];
  const unsubscribes: jest.Mock[] = [];
  return {
    stream: {
      getPentacleStreamState: jest.fn(() => current),
      subscribePentacleStream: jest.fn((listener: () => void) => {
        listeners.push(listener);
        const unsubscribe = jest.fn();
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      }),
    },
    setState(next: PentacleStreamState) {
      current = next;
      listeners.slice().forEach((listener) => listener());
    },
    unsubscribes,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  // Harness opens now route through the shared unit's intent coordinator
  // (performHarnessChatOpen -> performChatOpenNavigation -> intent). Its module
  // singleton retains per-stream terminals across opens, so a fresh coordinator
  // per test is required for each new-stream open to take the first-open `push`
  // branch rather than a stale same-stream `noop`.
  resetChatOpenNavigationIntents();
  (harnessDiagnostics.dumpSingleSession as jest.Mock).mockClear();
});

afterEach(() => {
  setTelemetrySink(null);
  jest.useRealTimers();
});

test('opens a marker-matched stream but does not dump before render telemetry', () => {
  const seen: TelemetryPayload[] = [];
  const router = { push: jest.fn() };
  const harnessStream = makeStream(state([]));
  setTelemetrySink((payload) => seen.push(payload));

  const cleanup = subscribeAndOpenNewStream(harnessStream.stream, 'run-1', 'hostc', router);
  harnessStream.setState(state([event({ stream_id: 'hostc:new/with space' })]));

  expect(seen.map((payload) => payload.message)).toEqual([
    TELEMETRY_EVENTS.HARNESS_NEW_STREAM_OBSERVED,
    TELEMETRY_EVENTS.HARNESS_OPEN_STREAM_ATTEMPTED,
  ]);
  expect(seen[0].data).toEqual({
    stream_id: 'hostc:new/with space',
    marker: 'run-1',
    host: 'hostc',
  });
  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Anew%2Fwith%20space');
  expect(harnessDiagnostics.dumpSingleSession).not.toHaveBeenCalled();

  jest.advanceTimersByTime(1000);

  expect(harnessDiagnostics.dumpSingleSession).not.toHaveBeenCalled();
  cleanup?.();
});

test('dumps after transcript-ready and chat:event_rendered for the matched stream and unsubscribes', () => {
  const seen: TelemetryPayload[] = [];
  const router = { push: jest.fn() };
  const harnessStream = makeStream(state([]));
  setTelemetrySink((payload) => seen.push(payload));

  subscribeAndOpenNewStream(harnessStream.stream, 'run-1', 'hostc', router);
  harnessStream.setState(state([event({ stream_id: 'hostc:new/with space' })]));

  logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RENDERED, { stream_id: 'hostc:new/with space' });
  expect(harnessDiagnostics.dumpSingleSession).not.toHaveBeenCalled();

  logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, { stream_id: 'hostc:new/with space' });
  logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RENDERED, { stream_id: 'hostc:new/with space' });

  expect(harnessDiagnostics.dumpSingleSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessions: [expect.objectContaining({ stream_id: 'hostc:new/with space' })] }),
    'hostc:new/with space',
    { dump_trigger: 'render_observed' },
  );
  expect(harnessStream.unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length > 0)).toBe(true);
  expect(seen.map((payload) => payload.message)).toEqual([
    TELEMETRY_EVENTS.HARNESS_NEW_STREAM_OBSERVED,
    TELEMETRY_EVENTS.HARNESS_OPEN_STREAM_ATTEMPTED,
    TELEMETRY_EVENTS.CHAT_EVENT_RENDERED,
    TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED,
    TELEMETRY_EVENTS.CHAT_EVENT_RENDERED,
  ]);
});

test('ignores chat:event_rendered from a different stream', () => {
  const router = { push: jest.fn() };
  const harnessStream = makeStream(state([]));
  setTelemetrySink(() => {});

  const cleanup = subscribeAndOpenNewStream(harnessStream.stream, 'run-1', 'hostc', router);
  harnessStream.setState(state([event({ stream_id: 'hostc:new' })]));

  logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RENDERED, { stream_id: 'hostc:other' });
  jest.advanceTimersByTime(1000);

  expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Anew');
  expect(harnessDiagnostics.dumpSingleSession).not.toHaveBeenCalled();
  cleanup?.();
});

test('falls back to a diagnostic dump when matching render telemetry never arrives', () => {
  const router = { push: jest.fn() };
  const harnessStream = makeStream(state([]));
  setTelemetrySink(() => {});

  subscribeAndOpenNewStream(harnessStream.stream, 'run-1', 'hostc', router);
  harnessStream.setState(state([event({ stream_id: 'hostc:new' })]));

  jest.advanceTimersByTime(5000);

  expect(harnessDiagnostics.dumpSingleSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessions: [expect.objectContaining({ stream_id: 'hostc:new' })] }),
    'hostc:new',
    { dump_trigger: 'timeout_fallback' },
  );
});

test('ignores matching marker text from a different host filter', () => {
  const seen: TelemetryPayload[] = [];
  const router = { push: jest.fn() };
  const harnessStream = makeStream(state([]));
  setTelemetrySink((payload) => seen.push(payload));

  subscribeAndOpenNewStream(harnessStream.stream, 'run-1', 'hostb', router);
  harnessStream.setState(state([event({ host: 'hostc' })]));

  expect(seen).toEqual([]);
  expect(router.push).not.toHaveBeenCalled();
  expect(harnessDiagnostics.dumpSingleSession).not.toHaveBeenCalled();
});

test('no-ops when marker is missing', () => {
  const router = { push: jest.fn() };
  const harnessStream = makeStream(state([event()]));

  const cleanup = subscribeAndOpenNewStream(harnessStream.stream, '', 'hostc', router);

  expect(cleanup).toBeNull();
  expect(harnessStream.stream.subscribePentacleStream).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

test('emits open_stream_attempted telemetry even when router.push throws (pre-mount)', () => {
  // Regression test: the subscribe callback can fire
  // before the React Root Layout mounts (cold launch). Both telemetry
  // events must still fire and the throw must not propagate.
  const seen: TelemetryPayload[] = [];
  const router = {
    push: jest.fn(() => {
      throw new Error(
        'Attempted to navigate before mounting the Root Layout component',
      );
    }),
  };
  const harnessStream = makeStream(state([]));
  setTelemetrySink((payload) => seen.push(payload));

  const cleanup = subscribeAndOpenNewStream(harnessStream.stream, 'run-1', 'hostc', router);
  expect(() =>
    harnessStream.setState(state([event({ stream_id: 'hostc:premount' })])),
  ).not.toThrow();

  expect(router.push).toHaveBeenCalledTimes(1);
  expect(seen.map((payload) => payload.message)).toEqual([
    TELEMETRY_EVENTS.HARNESS_NEW_STREAM_OBSERVED,
    TELEMETRY_EVENTS.HARNESS_OPEN_STREAM_ATTEMPTED,
  ]);
  cleanup?.();
});
