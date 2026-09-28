/**
 * Unit tests for the Notifications L3 action handlers in
 * `src/services/harnessActions.ts` (runOpenUpdates, runResolveNotification).
 * Mocks at module boundaries (router, telemetry sink, stream notifications,
 * resolveNotification) so the telemetry sequencing + skip-reason classifier
 * are exercised end-to-end.
 *
 * Spec: spec_pentacle_mobile_notifications_l3_coverage.
 */
import type { PentacleNotification, TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from '../src/services/mobileTelemetryEvents';

beforeAll(() => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
});
afterAll(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
});

type Actions = typeof import('../src/services/harnessActions');
type Telemetry = typeof import('pentacle-chat-core');

let activeTelemetry: Telemetry | null = null;

function loadFreshModules(): { actions: Actions; telemetry: Telemetry } {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const telemetry = require('pentacle-chat-core') as Telemetry;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actions = require('../src/services/harnessActions') as Actions;
  activeTelemetry = telemetry;
  return { actions, telemetry };
}

afterEach(() => {
  activeTelemetry?.setTelemetrySink(null);
  activeTelemetry = null;
});

function notification(overrides: Partial<PentacleNotification> = {}): PentacleNotification {
  return {
    notification_id: 'n1',
    created_at: '2026-05-25T12:00:00.000Z',
    updated_at: '2026-05-25T12:00:00.000Z',
    producer: 'altum',
    severity: 'warning',
    title: 'Lead needs a decision',
    body: 'Approve outreach?',
    dedup_key: 'dk-1',
    state: 'open',
    actions: [{ kind: 'ack', action_id: 'a0' }],
    resolution: null,
    ttl_seconds: 3600,
    expires_at: '2026-05-25T13:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

function names(seen: TelemetryPayload[]): string[] {
  return seen.map((p) => p.message);
}

describe('runOpenUpdates', () => {
  test('emits scheduled → done and navigates to the Updates tab', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const router = { push: jest.fn() };

    await actions.runOpenUpdates({ router });

    expect(router.push).toHaveBeenCalledWith('/(tabs)/updates');
    expect(names(seen)).toEqual([
      TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_SCHEDULED,
      TELEMETRY_EVENTS.HARNESS_OPEN_UPDATES_DONE,
    ]);
  });
});

describe('runTabNavigation', () => {
  test('pushes Chats, Updates, Settings and emits bug-anchored tab telemetry', async () => {
    jest.useFakeTimers();
    const { actions } = loadFreshModules();
    const router = { push: jest.fn() };
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const promise = actions.runTabNavigation({ router, stepDelayMs: 50 });
    await Promise.resolve();
    expect(router.push).toHaveBeenCalledWith('/(tabs)/chats');

    await jest.advanceTimersByTimeAsync(50);
    expect(router.push).toHaveBeenCalledWith('/(tabs)/updates');
    await jest.advanceTimersByTimeAsync(50);
    expect(router.push).toHaveBeenCalledWith('/(tabs)/settings');
    await jest.advanceTimersByTimeAsync(50);
    await promise;

    const payloads = logSpy.mock.calls.map((call) => JSON.parse(String(call[0]).replace('[TELEMETRY] ', '')));
    expect(payloads.map((payload) => payload.message)).toEqual([
      MOBILE_TELEMETRY_EVENTS.HARNESS_TAB_NAVIGATION_SCHEDULED,
      MOBILE_TELEMETRY_EVENTS.HARNESS_TAB_NAVIGATION_DONE,
    ]);
    expect(payloads[0].data).toMatchObject({ mode: 'route_navigation_smoke' });
    expect(payloads[1].data).toMatchObject({ mode: 'route_navigation_smoke' });
    expect(payloads.every(payload => payload.subsystem === 'harness')).toBe(true);
    logSpy.mockRestore();
  });
});

describe('runResolveNotification', () => {
  test('resolves an already-present open notification and emits scheduled → done', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const resolveNotification = jest.fn(async () => true);

    await actions.runResolveNotification({
      action_kind: 'ack',
      getNotifications: () => [notification({ notification_id: 'a', actions: [{ kind: 'ack', action_id: 'a0' }] })],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 1000,
    });

    expect(resolveNotification).toHaveBeenCalledWith({ notification_id: 'a', action_kind: 'ack' });
    expect(names(seen)).toEqual([
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED,
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_DONE,
    ]);
  });

  test('passes the bool choice through for yes_no', async () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);
    const resolveNotification = jest.fn(async () => true);

    await actions.runResolveNotification({
      action_kind: 'yes_no',
      choice: true,
      getNotifications: () => [notification({ notification_id: 'y', actions: [{ kind: 'yes_no', action_id: 'a0' }] })],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 1000,
    });

    expect(resolveNotification).toHaveBeenCalledWith({
      notification_id: 'y',
      action_kind: 'yes_no',
      choice: true,
    });
  });

  test('passes durable question selections and note through', async () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);
    const resolveNotification = jest.fn(async () => true);

    await actions.runResolveNotification({
      action_kind: 'ack',
      selections: ['approve'],
      note: 'ship it',
      getNotifications: () => [
        notification({
          notification_id: 'q',
          producer: 'agent_question.v1',
          actions: [{ kind: 'ack', action_id: 'a0', value: 'approve' }],
        }),
      ],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 1000,
    });

    expect(resolveNotification).toHaveBeenCalledWith({
      notification_id: 'q',
      action_kind: 'ack',
      selections: ['approve'],
      note: 'ship it',
    });
  });

  test('waits for question render before resolving when requested', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const resolveNotification = jest.fn(async () => true);

    const promise = actions.runResolveNotification({
      action_kind: 'ack',
      selections: ['approve'],
      waitForQuestionRender: true,
      questionStreamId: 'mock-host:mock-session',
      questionRenderTimeoutMs: 1000,
      getNotifications: () => [
        notification({
          notification_id: 'q',
          producer: 'agent_question.v1',
          actions: [{ kind: 'ack', action_id: 'a0', value: 'approve' }],
        }),
      ],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(resolveNotification).not.toHaveBeenCalled();
    telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED, {
      stream_id: 'mock-host:mock-session',
    });
    await promise;

    expect(resolveNotification).toHaveBeenCalledWith({
      notification_id: 'q',
      action_kind: 'ack',
      selections: ['approve'],
    });
    expect(names(seen)).toEqual([
      TELEMETRY_EVENTS.CHAT_QUESTION_RENDERED,
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED,
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_DONE,
    ]);
  });

  test('passes durable free_text question id and text through', async () => {
    const { actions, telemetry } = loadFreshModules();
    telemetry.setTelemetrySink(() => undefined);
    const resolveNotification = jest.fn(async () => true);

    await actions.runResolveNotification({
      action_kind: 'ack',
      text: '  exact\nanswer  ',
      note: 'ship it',
      getNotifications: () => [
        notification({
          notification_id: 'q-free',
          producer: 'agent_question.v1',
          actions: [{ kind: 'ack', action_id: 'a0' }],
          question: {
            question_id: 'question-free',
            producer_stream_id: 'hostc:codex:asker',
            response_mode: 'free_text' as any,
            options: [],
            state: 'open',
            answer: null,
          },
        }),
      ],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 1000,
    });

    expect(resolveNotification).toHaveBeenCalledWith({
      notification_id: 'q-free',
      action_kind: 'ack',
      question_id: 'question-free',
      text: '  exact\nanswer  ',
      note: 'ship it',
    });
  });

  test('waits for a matching notification to arrive via subscribe', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const resolveNotification = jest.fn(async () => true);

    let current: PentacleNotification[] = [];
    const listenerRef: { fn: (() => void) | null } = { fn: null };

    const promise = actions.runResolveNotification({
      action_kind: 'ack',
      getNotifications: () => current,
      subscribe: (cb) => {
        listenerRef.fn = cb;
        return () => {
          listenerRef.fn = null;
        };
      },
      resolveNotification,
      timeoutMs: 1000,
    });

    // Nothing yet → scheduled must NOT have fired.
    expect(names(seen)).toEqual([]);
    // The seeded notification arrives.
    current = [notification({ notification_id: 'late', actions: [{ kind: 'ack', action_id: 'a0' }] })];
    listenerRef.fn?.();
    await promise;

    expect(resolveNotification).toHaveBeenCalledWith({ notification_id: 'late', action_kind: 'ack' });
    expect(names(seen)).toEqual([
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED,
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_DONE,
    ]);
  });

  test('marker scoping ignores an unrelated open notification', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const resolveNotification = jest.fn(async () => true);

    await actions.runResolveNotification({
      action_kind: 'ack',
      marker: 'mk123',
      getNotifications: () => [
        notification({ notification_id: 'other', title: 'unrelated', actions: [{ kind: 'ack', action_id: 'a0' }] }),
      ],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 50,
    });

    expect(resolveNotification).not.toHaveBeenCalled();
    // An open notification exists, but none under our marker scope → the
    // "no open notification (in scope)" reason.
    expect(names(seen)).toEqual([TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED]);
    expect(seen[0].data).toMatchObject({ reason: 'no_open_notification', action_kind: 'ack' });
  });

  test('skips with no_matching_action when an open notification lacks the action', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const resolveNotification = jest.fn(async () => true);

    await actions.runResolveNotification({
      action_kind: 'spawn_worker',
      getNotifications: () => [notification({ notification_id: 'a', actions: [{ kind: 'ack', action_id: 'a0' }] })],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 50,
    });

    expect(resolveNotification).not.toHaveBeenCalled();
    expect(seen[0].data).toMatchObject({ reason: 'no_matching_action', action_kind: 'spawn_worker' });
  });

  test('skips with resolve_rejected when the resolve promise rejects', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((p) => seen.push(p));
    const resolveNotification = jest.fn(async () => {
      throw new Error('terminal state');
    });

    await actions.runResolveNotification({
      action_kind: 'ack',
      getNotifications: () => [notification({ notification_id: 'a', actions: [{ kind: 'ack', action_id: 'a0' }] })],
      subscribe: () => () => undefined,
      resolveNotification,
      timeoutMs: 1000,
    });

    expect(names(seen)).toEqual([
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SCHEDULED,
      TELEMETRY_EVENTS.HARNESS_RESOLVE_NOTIFICATION_SKIPPED,
    ]);
    expect(seen[1].data).toMatchObject({ reason: 'resolve_rejected' });
  });
});
