/**
 * Unit tests for the Stage 2 compose-driving action handlers in
 * `src/services/harnessActions.ts`. Tests mock at module boundaries
 * (router, telemetry sink, pentacleStream actions, userPreferences) so
 * harnessRuntime.dispatchSend and the telemetry sequencing are exercised
 * end-to-end.
 *
 * Spec: spec_pentacle_mobile_e2e_telemetry_flows_2026_05_13 Stage 2 §E.
 *
 * Module-reset note: `jest.resetModules()` produces fresh instances of the
 * telemetry, harnessRuntime, and harnessActions modules per test. The
 * actions module calls `logTelemetry` against ITS bound `telemetry` import,
 * so each test reads/writes through that same fresh `telemetry` instance
 * via `loadFreshModules().telemetry`.
 */
import type { TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';

beforeAll(() => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
});
afterAll(() => {
  delete process.env.EXPO_PUBLIC_HARNESS;
});

type Runtime = typeof import('../src/utils/harnessRuntime');
type Actions = typeof import('../src/services/harnessActions');
type Telemetry = typeof import('pentacle-chat-core');

let activeTelemetry: Telemetry | null = null;

function loadFreshModules(): { runtime: Runtime; actions: Actions; telemetry: Telemetry } {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const telemetry = require('pentacle-chat-core') as Telemetry;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtime = require('../src/utils/harnessRuntime') as Runtime;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actions = require('../src/services/harnessActions') as Actions;
  runtime.reset();
  actions.__resetFlowContextForTests();
  // The spawn path requires a one-line objective (daemon window-A cutover). A real
  // spawn_chat_then_send scenario URL carries it; default one here so existing flows submit,
  // and the missing-objective case re-applies a URL without it to assert fail-before-submit.
  runtime.applyURL('pentacle://harness?actions=&spawn_objective=Spawn%20then%20send%20smoke');
  activeTelemetry = telemetry;
  return { runtime, actions, telemetry };
}

afterEach(() => {
  activeTelemetry?.setTelemetrySink(null);
  activeTelemetry = null;
});

// ---------------------------------------------------------------------------
// spawn_chat_then_send
// ---------------------------------------------------------------------------

const catalog = {
    schema_version: 'CatalogV1' as const,
    catalog_version: 'catalog-v1',
    profiles: {
      desktop_manual: {
        codex: ['gpt-5.6-sol', 'high'] as [string, string],
        claude: ['opus', 'high'] as [string, string],
      },
    },
    models: { codex: { 'gpt-5.6-sol': { efforts: ['high'] } }, claude: { opus: { efforts: ['high'] } } },
};
const v2Actions = (spawnSessionV2: jest.Mock) => ({
  getSpawnCatalog: jest.fn(async (hooks) => {
    hooks?.onDispatched?.('spawn_catalog_get-test', 7);
    hooks?.onSocketSent?.('spawn_catalog_get-test', 7);
    return catalog;
  }),
  spawnSessionV2,
});

describe('spawn_chat_then_send', () => {
  test('happy path emits scheduled → composed → sent and dispatches send via the registered handler', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const router = { push: jest.fn() };
    const spawnSessionV2 = jest.fn(async (args) => {
      args.onDispatched?.('spawn.v2-test', 7);
      args.onSocketSent?.('spawn.v2-test', 7);
      return {
        session: {
          stream_id: 'hostc:codex:new1',
          session_name: 'codex-new1',
          host: 'hostc',
          provider: 'codex',
        },
        requested: { model: 'gpt-5.6-sol', effort: 'high' },
        resolved: { model: 'gpt-5.6-sol', effort: 'high' },
        resolution_source: 'profile_default',
        catalog_version: 'catalog-v1',
        actual_launch: { bootstrap_state: 'starting' },
      };
    });
    const sendHandler = jest.fn(async (text) => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:new1',
        optimistic_id: 'optimistic_hostc_codex_new1_1',
      });
      expect(text).toBe('say your name');
    });
    runtime.registerSendHandler('hostc:codex:new1', sendHandler);

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:new1',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:new1',
      });
    }, 300);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router,
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
      },
    });

    expect(spawnSessionV2).toHaveBeenCalledWith({
      host: 'hostc',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      spawnProfile: 'desktop_manual',
      catalogVersion: 'catalog-v1',
      resolutionSource: 'profile_default',
      objective: 'Spawn then send smoke',
      idempotencyKey: expect.any(String),
      onDispatched: expect.any(Function),
      onSocketSent: expect.any(Function),
    });
    expect(sendHandler).toHaveBeenCalledWith('say your name');
    expect(router.push).toHaveBeenCalledWith('/(tabs)/chats');
    expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Anew1');

    const messages = seen.map((p) => p.message);
    const scheduledIdx = messages.indexOf(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED);
    const composedIdx = messages.indexOf(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED);
    const sentIdx = messages.indexOf(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
    expect(scheduledIdx).toBeGreaterThanOrEqual(0);
    expect(composedIdx).toBeGreaterThan(scheduledIdx);
    expect(sentIdx).toBeGreaterThan(composedIdx);

    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
    expect(sent?.data).toMatchObject({ stream_id: 'hostc:codex:new1', status: 'ok' });
    expect(seen.filter((event) => (
      String(event.message) === 'harness:ui_trace' && event.data.kind === 'spawn_tuple_metadata'
    )).map((event) => event.data)).toEqual([
      expect.objectContaining({
        stage: 'requested', profile: 'desktop_manual', model: 'gpt-5.6-sol', effort: 'high',
        catalog_version: 'catalog-v1',
      }),
      expect.objectContaining({
        stage: 'resolved', model: 'gpt-5.6-sol', effort: 'high',
        resolution_source: 'profile_default', catalog_version: 'catalog-v1',
      }),
    ]);
    expect(seen.filter((event) => (
      String(event.message) === 'harness:ui_trace' &&
      event.data.kind === 'spawn_rpc_request_metadata'
    )).map((event) => event.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'dispatch-attempt', request_type: 'spawn_catalog_get', request_prefix: 'spawn_catalog_get',
        schema: null, request_id: 'spawn_catalog_get-test', socket_generation: 7,
      }),
      expect.objectContaining({
        stage: 'local-websocket-send-return', request_type: 'spawn', request_prefix: 'spawn.v2',
        schema: 'SpawnRequestV2', request_id: 'spawn.v2-test', socket_generation: 7,
      }),
    ]));

    expect(actions.__getFlowContextForTests()).toEqual({
      streamId: 'hostc:codex:new1',
      lastOptimisticId: 'optimistic_hostc_codex_new1_1',
    });
  });

  test('a V2 starting acknowledgement alone cannot complete the two-turn send', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const spawnSessionV2 = jest.fn(async () => ({
      session: {
        stream_id: 'hostc:codex:starting',
        session_name: 'codex-starting',
        host: 'hostc',
        provider: 'codex',
      },
      actual_launch: { bootstrap_state: 'starting' },
    }));

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:starting',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:starting',
      });
    }, 300);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router: { push: jest.fn() },
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
      },
      handlerRegisterTimeoutMs: 10,
    });

    const sent = seen.find((payload) => payload.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
    expect(sent?.data).toMatchObject({ stream_id: 'hostc:codex:starting', status: 'handler_not_ready' });
    expect(seen.some((payload) => payload.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT)).toBe(false);
  });

  test('an absent objective dispatches a top-level spawn without one', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    runtime.applyURL('pentacle://harness?actions=spawn_chat_then_send&scenario_run_id=no-objective');
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    const spawnSessionV2 = jest.fn(async (_input: unknown) => null);
    await actions.runSpawnChatThenSend({ host: 'hostc', provider: 'codex', router: { push: jest.fn() },
      streamActions: { sendMessage: jest.fn(), appendOptimisticUserMessage: jest.fn(), ...v2Actions(spawnSessionV2) } });
    expect(spawnSessionV2).toHaveBeenCalledTimes(1);
    expect(spawnSessionV2.mock.calls[0][0]).toEqual(expect.objectContaining({ host: 'hostc', objective: undefined }));
  });

  test.each([undefined, null, ''])('objective resolver accepts absent input %s', raw => {
    const { actions } = loadFreshModules();
    expect(actions.resolveHarnessSpawnObjective(raw)).toEqual({ ok: true });
  });
  test('objective resolver validates explicit input and invalid input never dispatches', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    expect(actions.resolveHarnessSpawnObjective('Synthetic task')).toEqual({ ok: true, objective: 'Synthetic task' });
    expect(actions.resolveHarnessSpawnObjective('   ')).toEqual({ ok: false });
    runtime.applyURL('pentacle://harness?actions=spawn_chat_then_send&scenario_run_id=invalid-objective&spawn_objective=%20%20%20');
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    const spawnSessionV2 = jest.fn();
    await actions.runSpawnChatThenSend({ host: 'hostc', provider: 'codex', router: { push: jest.fn() },
      streamActions: { sendMessage: jest.fn(), appendOptimisticUserMessage: jest.fn(), ...v2Actions(spawnSessionV2) } });
    expect(spawnSessionV2).not.toHaveBeenCalled();
  });

  test('routes before the optional harness rename and reports rename rejection without failing navigation', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    runtime.applyURL('pentacle://harness?actions=spawn_chat_then_send&scenario_run_id=fidelity-run&spawn_objective=Fidelity%20run');
    const seen: TelemetryPayload[] = [];
    const order: string[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const spawnSessionV2 = jest.fn(async () => ({ session: {
      stream_id: 'hostc:codex:rename',
      session_name: 'codex-rename',
      host: 'hostc',
      provider: 'codex',
    } }));
    const renameSession = jest.fn(async () => {
      order.push('rename');
      throw new Error('rename unavailable');
    });
    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:rename',
        optimistic_id: 'optimistic-rename',
      });
    });
    runtime.registerSendHandler('hostc:codex:rename', sendHandler);
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, { stream_id: 'hostc:codex:rename' });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, { stream_id: 'hostc:codex:rename' });
    }, 300);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router: { push: (href) => order.push(String(href)) },
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
        renameSession,
      },
    });

    expect(order.indexOf('/pentacle/session/hostc%3Acodex%3Arename')).toBeLessThan(order.indexOf('rename'));
    expect(sendHandler).toHaveBeenCalled();
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'harness:ui_trace', data: expect.objectContaining({ kind: 'spawn_metadata_rename_failed' }) }),
      expect.objectContaining({ message: TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, data: expect.objectContaining({ status: 'ok' }) }),
    ]));
  });

  test('does not attempt send when handler readiness expires', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const router = { push: jest.fn() };
    const spawnSessionV2 = jest.fn(async () => ({ session: {
      stream_id: 'hostc:codex:orphan',
      session_name: 'codex-orphan',
      host: 'hostc',
      provider: 'codex',
    } }));

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:orphan',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:orphan',
      });
    }, 300);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router,
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
      },
      // Shorten the handler-register wait so this no-handler case fails fast.
      // Production default is MOUNT_SETTLE_TIMEOUT_MS=10000.
      handlerRegisterTimeoutMs: 100,
    });

    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
    expect(sent?.data).toMatchObject({ status: 'handler_not_ready' });
    expect(seen.some((p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED)).toBe(false);
    expect(seen.some((p) => p.message === TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT)).toBe(false);
  });

  test('waits for harness token reload before accepting ws_open for initial send', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.beginHarnessTokenReload();

    let tokenReady = false;
    const router = { push: jest.fn() };
    const spawnSessionV2 = jest.fn(async () => {
      expect(tokenReady).toBe(true);
      return { session: {
        stream_id: 'hostc:codex:tokenready',
        session_name: 'codex-tokenready',
        host: 'hostc',
        provider: 'codex',
      } };
    });
    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:tokenready',
        optimistic_id: 'optimistic_tokenready_1',
      });
    });
    runtime.registerSendHandler('hostc:codex:tokenready', sendHandler);

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, { phase: 'too_early' }), 10);
    setTimeout(() => {
      tokenReady = true;
      runtime.markHarnessTokenReady();
    }, 500);
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, { phase: 'after_token' }), 520);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:tokenready',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:tokenready',
      });
    }, 900);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router,
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
      },
    });

    expect(spawnSessionV2).toHaveBeenCalledTimes(1);
    expect(sendHandler).toHaveBeenCalledTimes(1);
    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
    expect(sent?.data).toMatchObject({ stream_id: 'hostc:codex:tokenready', status: 'ok' });
    const scheduled = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED,
    );
    expect(scheduled).toBeTruthy();
  });

  test('cold-launch race: waits for send_handler_registered AFTER mount-and-settle before dispatching send', async () => {
    // Regression test for the ComposerBar useEffect race that the
    // send-handler-registered telemetry + waitForSendHandlerRegistered guard
    // exists to defeat. Spec:
    // spec_pentacle_mobile_send_handler_registration_race_2026_05_17.
    //
    // Simulate the production ordering on a fast cold launch:
    //   ws_open → spawn_summary_applied → session_screen_mount →
    //   transcript_ready_settled → (gap: ComposerBar mount + useEffect) →
    //   registerSendHandler.
    // The action handler must NOT call dispatchSend during the gap. Without
    // the guard, dispatchSend ran inside the gap and returned no_handler;
    // with the guard, it waits past `transcript_ready_settled` and resumes
    // once the registration fires.
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    const dispatchTimeline: { event: string; t: number }[] = [];
    const t0 = Date.now();
    const stamp = (event: string) => dispatchTimeline.push({ event, t: Date.now() - t0 });
    telemetry.setTelemetrySink((payload) => {
      seen.push(payload);
      if (
        payload.message === TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT
        || payload.message === TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED
        || payload.message === TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED
      ) {
        stamp(payload.message);
      }
    });

    const router = { push: jest.fn() };
    const spawnSessionV2 = jest.fn(async () => ({ session: {
      stream_id: 'hostc:codex:racerwait',
      session_name: 'codex-racerwait',
      host: 'hostc',
      provider: 'codex',
    } }));
    const sendHandler = jest.fn(async (text) => {
      stamp(`sendHandler_invoked:${text}`);
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:racerwait',
        optimistic_id: 'optimistic_racerwait_1',
      });
    });

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:racerwait',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:racerwait',
      });
    }, 300);
    // Registration fires 200ms AFTER transcript_ready_settled — the actual
    // production race window the guard must cover. Without the guard,
    // dispatchSend would have run at ~310ms with no handler.
    setTimeout(() => {
      runtime.registerSendHandler('hostc:codex:racerwait', sendHandler);
    }, 500);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router,
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
      },
    });

    // sendHandler MUST have been called (dispatchSend found the handler).
    expect(sendHandler).toHaveBeenCalledWith('say your name');
    // The _SENT must report status:'ok', NOT 'no_handler'.
    const sent = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT,
    );
    expect(sent?.data).toMatchObject({
      stream_id: 'hostc:codex:racerwait',
      status: 'ok',
    });
    // Ordering invariant: send_handler_registered MUST appear before the
    // sendHandler invocation — i.e. the guard waited.
    const regIdx = dispatchTimeline.findIndex(
      (e) => e.event === TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED,
    );
    const invokeIdx = dispatchTimeline.findIndex((e) =>
      e.event.startsWith('sendHandler_invoked'),
    );
    expect(regIdx).toBeGreaterThanOrEqual(0);
    expect(invokeIdx).toBeGreaterThan(regIdx);
    // Optimistic_id captured into flow context (proves the entire happy path
    // ran end-to-end despite the late registration).
    expect(actions.__getFlowContextForTests().lastOptimisticId).toBe(
      'optimistic_racerwait_1',
    );
  });

  test('cold-launch race: fast-path resolves immediately when handler is registered BEFORE the wait starts', async () => {
    // The complement to the race test above: if registerSendHandler fired
    // before runSpawnChatThenSend reached `waitForSendHandlerRegistered`,
    // the tee in `teeTelemetrySink` would never see the (already-past)
    // event and would time out at `MOUNT_SETTLE_TIMEOUT_MS`. The fast-path
    // check on `harnessRuntime.hasSendHandler` makes the wait resolve
    // immediately in that case. Without it, the F1 happy path would block
    // for 10s on every run.
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:earlyreg',
        optimistic_id: 'optimistic_earlyreg_1',
      });
    });
    // Register BEFORE the action runs — emulates production ordering when
    // the user navigates to an already-open SessionScreen.
    runtime.registerSendHandler('hostc:codex:earlyreg', sendHandler);

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:earlyreg',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:earlyreg',
      });
    }, 300);

    const t0 = Date.now();
    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router: { push: jest.fn() },
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(jest.fn(async () => ({ session: {
          stream_id: 'hostc:codex:earlyreg',
          session_name: 'codex-earlyreg',
          host: 'hostc',
          provider: 'codex',
        } }))),
      },
    });
    const elapsed = Date.now() - t0;

    expect(sendHandler).toHaveBeenCalled();
    // The whole flow must complete well under MOUNT_SETTLE_TIMEOUT_MS=10000.
    // Allow generous slack for slow CI but prove the fast path fired.
    expect(elapsed).toBeLessThan(1500);
    const sent = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT,
    );
    expect(sent?.data).toMatchObject({ status: 'ok' });
  });

  test('cold-launch race: send_handler_registered telemetry fires inside registerSendHandler with matching stream_id', async () => {
    // The new event is the sync-point the wait keys on. If anyone ever
    // moves the emit out of `registerSendHandler` (or forgets the
    // stream_id payload), the guard becomes a no-op. This test pins the
    // contract.
    const { runtime, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const unregister = runtime.registerSendHandler('hostc:codex:contract', jest.fn());

    const events = seen.filter(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED,
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ stream_id: 'hostc:codex:contract' });
    expect(runtime.hasSendHandler('hostc:codex:contract')).toBe(true);

    unregister();
    expect(runtime.hasSendHandler('hostc:codex:contract')).toBe(false);
    // Unregister must NOT emit a second registered event.
    expect(
      seen.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_HANDLER_REGISTERED),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// open_chat_then_send
// ---------------------------------------------------------------------------

describe('open_chat_then_send', () => {
  test('happy path emits scheduled → sent with seeded stream_id', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const sendHandler = jest.fn(async (text) => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:existing',
        optimistic_id: 'optimistic_hostc_codex_existing_1',
      });
      expect(text).toBe('hello');
    });
    runtime.registerSendHandler('hostc:codex:existing', sendHandler);

    const attemptOpenExistingChat = jest.fn(() => 'hostc:codex:existing');

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:existing',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:existing',
      });
    }, 300);

    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      text: 'hello',
      attemptOpenExistingChat,
    });

    expect(attemptOpenExistingChat).toHaveBeenCalledWith('hostc', 'codex');
    expect(sendHandler).toHaveBeenCalledWith('hello');

    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT);
    expect(sent?.data).toMatchObject({ stream_id: 'hostc:codex:existing', status: 'ok' });
    expect(actions.__getFlowContextForTests().streamId).toBe('hostc:codex:existing');
  });

  test('emits sent with no_handler when no existing chat is found', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const attemptOpenExistingChat = jest.fn(() => null);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {});
    }, 0);
    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      attemptOpenExistingChat,
      inventoryPollTimeoutMs: 0,
    });

    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT);
    expect(sent?.data).toMatchObject({ status: 'no_handler', reason: 'no_existing_chat' });
  });

  test('cold-launch race: waits for send_handler_registered AFTER mount-and-settle before dispatching send', async () => {
    // Mirror of the runSpawnChatThenSend cold-launch race test. The
    // ComposerBar useEffect that registers the send handler can fire AFTER
    // `harness:transcript_ready_settled` on a fast cold launch; without the
    // wait at harnessActions.ts:wait-for-send-handler-registered the
    // dispatchSend on the open-existing-chat path would race and return
    // no_handler. Asserting the wait is in place on this code path too so a
    // future removal here is caught by jest.
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const sendHandler = jest.fn(async (text) => {
      expect(text).toBe('say your name');
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:openracerwait',
        optimistic_id: 'optimistic_openracerwait_1',
      });
    });

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:openracerwait',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:openracerwait',
      });
    }, 300);
    // Registration fires 200ms AFTER transcript_ready_settled — the race
    // window the production wait must cover.
    setTimeout(() => {
      runtime.registerSendHandler('hostc:codex:openracerwait', sendHandler);
    }, 500);

    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      attemptOpenExistingChat: () => 'hostc:codex:openracerwait',
    });

    expect(sendHandler).toHaveBeenCalledWith('say your name');
    const sent = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT,
    );
    expect(sent?.data).toMatchObject({
      stream_id: 'hostc:codex:openracerwait',
      status: 'ok',
    });
  });

  test('force-closes the socket before dispatching the composer send when requested', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const streamId = 'hostc:codex:queued-reconnect';
    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: streamId,
        optimistic_id: 'optimistic_queued_reconnect_1',
      });
    });
    runtime.registerSendHandler(streamId, sendHandler);
    const forceCloseWs = jest.fn(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_CLOSE, { reason: 'Stream end encountered' });
      return true;
    });

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, { stream_id: streamId });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, { stream_id: streamId });
    }, 300);

    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      text: 'queued while offline',
      attemptOpenExistingChat: () => streamId,
      forceCloseBeforeSend: true,
      forceCloseWs,
    });

    expect(forceCloseWs).toHaveBeenCalledWith('harness_forced');
    expect(sendHandler).toHaveBeenCalledWith('queued while offline');
    const messages = seen.map((payload) => String(payload.message));
    expect(messages.indexOf('harness:disconnect_before_send_closed')).toBeLessThan(
      messages.indexOf(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT),
    );
    expect(messages).not.toContain('harness:disconnect_before_send_aborted');
  });
});

// ---------------------------------------------------------------------------
// open_chat_while_ws_down
// ---------------------------------------------------------------------------

describe('open_chat_while_ws_down', () => {
  test('uses the active flow stream, force-closes before navigating back to the session, and emits done', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    runtime.registerSendHandler('hostc:codex:existing', jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:existing',
        optimistic_id: 'optimistic_existing_1',
      });
    }));
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:existing',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:existing',
      });
    }, 300);
    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      attemptOpenExistingChat: () => 'hostc:codex:existing',
    });

    seen.length = 0;
    const router = { push: jest.fn() };
    const forceCloseWs = jest.fn(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_CLOSE, {
        reason: 'harness_forced',
      });
      return true;
    });

    await actions.runOpenChatWhileWsDown({
      host: 'hostc',
      provider: 'codex',
      router,
      forceCloseWs,
    });

    expect(forceCloseWs).toHaveBeenCalledWith('harness_forced');
    expect(router.push.mock.calls.map((call) => call[0])).toEqual([
      '/(tabs)/chats',
      '/pentacle/session/hostc%3Acodex%3Aexisting',
    ]);
    const messages = seen.map((p) => p.message);
    expect(messages).toContain('harness:open_chat_while_ws_down_scheduled');
    expect(messages).toContain(TELEMETRY_EVENTS.CHAT_WS_CLOSE);
    expect(messages).toContain('harness:open_chat_while_ws_down_done');
    expect(actions.__getFlowContextForTests().streamId).toBe('hostc:codex:existing');
  });

  test('can start before open_chat_then_send finishes without waiting for ws_open', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.applyURL('pentacle://harness?actions=open_chat_then_send,open_chat_while_ws_down');

    const router = { push: jest.fn() };
    const forceCloseWs = jest.fn(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_CLOSE, {
        reason: 'harness_forced',
      });
      return true;
    });

    const promise = actions.runOpenChatWhileWsDown({
      host: 'hostc',
      provider: 'codex',
      router,
      forceCloseWs,
    });
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT, {
        stream_id: 'hostc:codex:partner',
        status: 'ok',
      });
    }, 20);

    await promise;

    expect(seen.some((payload) => payload.message === TELEMETRY_EVENTS.CHAT_WS_OPEN)).toBe(false);
    expect(forceCloseWs).toHaveBeenCalledWith('harness_forced');
    expect(router.push).toHaveBeenCalledWith('/pentacle/session/hostc%3Acodex%3Apartner');
    const done = seen.find((payload) => String(payload.message) === 'harness:open_chat_while_ws_down_done');
    expect(done?.data).toMatchObject({
      stream_id: 'hostc:codex:partner',
      source: 'flow_context',
    });
  });
});

// ---------------------------------------------------------------------------
// send_again
// ---------------------------------------------------------------------------

describe('send_again', () => {
  test('happy path: fires send after reconcile event matches prior optimistic_id', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    // Seed flow context via open_chat_then_send so the first optimistic_id
    // is captured into module state.
    runtime.registerSendHandler('hostc:codex:flow', jest.fn(async (_text) => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:flow',
        optimistic_id: 'optimistic_hostc_codex_flow_1',
      });
    }));
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:flow',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:flow',
      });
    }, 300);
    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      attemptOpenExistingChat: () => 'hostc:codex:flow',
    });

    expect(actions.__getFlowContextForTests().lastOptimisticId).toBe(
      'optimistic_hostc_codex_flow_1',
    );

    seen.length = 0;
    // Re-register so send_again's dispatch emits a new optimistic_insert.
    runtime.registerSendHandler('hostc:codex:flow', jest.fn(async (text) => {
      expect(text).toBe('say your name');
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:flow',
        optimistic_id: 'optimistic_hostc_codex_flow_2',
      });
    }));

    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED, {
        stream_id: 'hostc:codex:flow',
        optimistic_id: 'optimistic_hostc_codex_flow_1',
      });
    }, 10);

    await actions.runSendAgain({ count: 1, timeoutMs: 1000 });

    const sent = seen.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ stream_id: 'hostc:codex:flow', status: 'ok' });
    expect(actions.__getFlowContextForTests().lastOptimisticId).toBe(
      'optimistic_hostc_codex_flow_2',
    );
  });

  test('timeout: emits skipped with reconcile_timeout reason and bails', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    runtime.registerSendHandler('hostc:codex:timeout', jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:timeout',
        optimistic_id: 'optimistic_hostc_codex_timeout_1',
      });
    }));
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:timeout',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:timeout',
      });
    }, 300);
    await actions.runOpenChatThenSend({
      host: 'hostc',
      provider: 'codex',
      attemptOpenExistingChat: () => 'hostc:codex:timeout',
    });
    seen.length = 0;

    // No reconcile event fired — send_again must time out and emit skipped.
    await actions.runSendAgain({ count: 1, timeoutMs: 50 });

    const skipped = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED);
    expect(skipped?.data).toMatchObject({
      reason: 'reconcile_timeout',
      stream_id: 'hostc:codex:timeout',
      count_completed: 0,
    });
    const sentEvents = seen.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT);
    expect(sentEvents).toHaveLength(0);
  });

  test('captures first-send reconcile while waiting for settings toggle before send_again', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.applyURL('pentacle://harness?actions=open_chat_then_send,open_settings_then_toggle,send_again');
    actions.__setFlowContextForTests({
      streamId: 'hostc:codex:toggle',
      lastOptimisticId: 'optimistic_toggle_1',
    });
    seen.length = 0;

    runtime.registerSendHandler('hostc:codex:toggle', jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:toggle',
        optimistic_id: 'optimistic_toggle_2',
      });
    }));
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED, {
        stream_id: 'hostc:codex:toggle',
        optimistic_id: 'optimistic_toggle_1',
      });
    }, 10);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE, {
        key: 'showTurnDuration',
        from_value: false,
        to_value: true,
      });
    }, 30);

    await actions.runSendAgain({ count: 1, timeoutMs: 1000, waitForSettingsToggle: true });

    expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED)).toBeUndefined();
    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT);
    expect(sent?.data).toMatchObject({ stream_id: 'hostc:codex:toggle', status: 'ok' });
  });

  test('cold-launch race: defers no_active_stream skip until partner spawn_chat_then_send _SENT fires', async () => {
    // Regression test for commit 1002326. All 5 compose-driving dispatchers
    // fire synchronously from subscribeHarnessHydrationActions, so without
    // the partner-wait runSendAgain raced past streamId being populated and
    // emitted no_active_stream before the partner action even started.
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.applyURL('pentacle://harness?actions=spawn_chat_then_send,send_again&spawn_objective=Spawn%20then%20send%20again');

    expect(actions.__getFlowContextForTests().streamId).toBeNull();

    const t0 = Date.now();
    const sendAgainPromise = actions.runSendAgain({ count: 1, timeoutMs: 200 });
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
        stream_id: 'hostc:claude:partner',
        status: 'ok',
      });
    }, 40);
    await sendAgainPromise;

    const elapsed = Date.now() - t0;
    // Without the fix this resolved synchronously (<5ms). With the fix it
    // waits for the partner _SENT (~40ms) before evaluating streamId.
    expect(elapsed).toBeGreaterThanOrEqual(30);
    // streamId remained null in this synthetic case, so it still skips —
    // but the skip happens AFTER the partner signal, not before.
    const skipped = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED);
    expect(skipped?.data).toMatchObject({ reason: 'no_active_stream', count_completed: 0 });
  });

  test('cold-launch race: waits for partner optimistic_id before checking prior optimistic', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.applyURL('pentacle://harness?actions=spawn_chat_then_send,send_again&spawn_objective=Spawn%20then%20send%20again');

    actions.__setFlowContextForTests({ streamId: 'hostc:codex:partner' });
    runtime.registerSendHandler('hostc:codex:partner', jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:partner',
        optimistic_id: 'optimistic_partner_2',
      });
    }));

    const t0 = Date.now();
    const sendAgainPromise = actions.runSendAgain({ count: 1, timeoutMs: 1000 });
    setTimeout(() => {
      actions.__setFlowContextForTests({
        streamId: 'hostc:codex:partner',
        lastOptimisticId: 'optimistic_partner_1',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT, {
        stream_id: 'hostc:codex:partner',
        status: 'ok',
        optimistic_id: 'optimistic_partner_1',
      });
    }, 40);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RECONCILED, {
        stream_id: 'hostc:codex:partner',
        optimistic_id: 'optimistic_partner_1',
      });
    }, 60);

    await sendAgainPromise;

    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED)).toBeUndefined();
    const sent = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SENT);
    expect(sent?.data).toMatchObject({
      stream_id: 'hostc:codex:partner',
      status: 'ok',
      optimistic_id: 'optimistic_partner_2',
    });
  });

  test('cold-launch race: skips immediately (no wait) when no partner compose-driving action is registered', async () => {
    // Counterpart to the partner-wait test: when send_again is the only
    // compose-driving action in the scenario, there is nothing to wait
    // for, and the no_active_stream skip must fire immediately.
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.applyURL('pentacle://harness?actions=send_again');

    const t0 = Date.now();
    await actions.runSendAgain({ count: 1, timeoutMs: 5000 });
    const elapsed = Date.now() - t0;

    // No partner action, no wait — must resolve quickly.
    expect(elapsed).toBeLessThan(50);
    const skipped = seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_SEND_AGAIN_SKIPPED);
    expect(skipped?.data).toMatchObject({ reason: 'no_active_stream', count_completed: 0 });
  });
});

// ---------------------------------------------------------------------------
// router.push pre-mount resilience (commit 1002326)
// ---------------------------------------------------------------------------

describe('router.push pre-mount resilience', () => {
  test('runSpawnChatThenSend completes terminal telemetry when both router.push calls throw', async () => {
    // On cold launch, subscribeHarnessHydrationActions fires before the
    // React Root Layout mounts, and expo-router throws "Attempted to
    // navigate before mounting the Root Layout component." The harness
    // does not depend on the visual navigation, so the throws must not
    // abort the spawn → composed → sent sequence.
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const router = {
      push: jest.fn(() => {
        throw new Error(
          'Attempted to navigate before mounting the Root Layout component',
        );
      }),
    };
    const spawnSessionV2 = jest.fn(async () => ({ session: {
      stream_id: 'hostc:codex:routerthrow',
      session_name: 'codex-routerthrow',
      host: 'hostc',
      provider: 'codex',
    } }));
    const sendHandler = jest.fn(async (text) => {
      expect(text).toBe('say your name');
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:routerthrow',
        optimistic_id: 'optimistic_routerthrow_1',
      });
    });
    runtime.registerSendHandler('hostc:codex:routerthrow', sendHandler);

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'hostc:codex:routerthrow',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'hostc:codex:routerthrow',
      });
    }, 300);

    await actions.runSpawnChatThenSend({
      host: 'hostc',
      provider: 'codex',
      router,
      streamActions: {
        sendMessage: jest.fn(),
        appendOptimisticUserMessage: jest.fn(),
        ...v2Actions(spawnSessionV2),
      },
    });

    expect(router.push).toHaveBeenCalledTimes(2);
    expect(spawnSessionV2).toHaveBeenCalled();
    expect(sendHandler).toHaveBeenCalledWith('say your name');
    const messages = seen.map((p) => p.message);
    expect(messages).toContain(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SCHEDULED);
    expect(messages).toContain(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_COMPOSED);
    expect(messages).toContain(TELEMETRY_EVENTS.HARNESS_SPAWN_CHAT_THEN_SEND_SENT);
  });

  test('runOpenSettingsThenToggle completes _done telemetry when both router.push calls throw', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const router = {
      push: jest.fn(() => {
        throw new Error(
          'Attempted to navigate before mounting the Root Layout component',
        );
      }),
    };
    const prefs: Record<string, boolean> = { showToolActions: false };
    await actions.runOpenSettingsThenToggle({
      router,
      preferences: {
        getUserPreference: ((key: string) => prefs[key]) as never,
        setUserPreference: ((key: string, value: boolean) => {
          prefs[key] = value;
          return Promise.resolve();
        }) as never,
      },
    });

    expect(router.push).toHaveBeenCalledTimes(2);
    expect(prefs.showToolActions).toBe(true);
    const done = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE,
    );
    expect(done?.data).toMatchObject({ key: 'showToolActions', from_value: false, to_value: true });
  });
});

// ---------------------------------------------------------------------------
// send_fixture_image
// ---------------------------------------------------------------------------

describe('send_fixture_image', () => {
  test('dispatches fixture image request and emits text/attachment shape telemetry', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const sendHandler = jest.fn(async (_request) => undefined);
    runtime.registerSendHandler('mock-host:mock-session', sendHandler);

    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'mock-host:mock-session',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'mock-host:mock-session',
      });
    }, 300);

    await actions.runSendFixtureImage({
      host: 'mock-host',
      provider: 'codex',
      text: '',
      imageBase64: 'aW1n',
      imageMimeType: 'image/png',
      imageName: 'photo-only.png',
      imageWidth: 1,
      imageHeight: 1,
      imageBytes: 3,
      attemptOpenExistingChat: jest.fn(() => 'mock-host:mock-session'),
    });

    expect(sendHandler).toHaveBeenCalledWith({
      text: '',
      fixtureImage: {
        base64: 'aW1n',
        mimeType: 'image/png',
        name: 'photo-only.png',
        width: 1,
        height: 1,
        bytes: 3,
      },
    });
    expect(seen.find((p) => p.message === 'harness:send_fixture_image_sent')?.data)
      .toMatchObject({
        stream_id: 'mock-host:mock-session',
        status: 'ok',
        has_text: false,
        attachment_count: 1,
        image_mime: 'image/png',
        image_name: 'photo-only.png',
      });
  });

  test('captures optimistic id for downstream failed-send retry action', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'optimistic_mock_attachment_1',
      });
    });
    runtime.registerSendHandler('mock-host:mock-session', sendHandler);
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'mock-host:mock-session',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'mock-host:mock-session',
      });
    }, 300);

    await actions.runSendFixtureImage({
      host: 'mock-host',
      provider: 'codex',
      imageBase64: 'aW1n',
      attemptOpenExistingChat: jest.fn(() => 'mock-host:mock-session'),
    });

    expect(seen.find((p) => p.message === 'harness:send_fixture_image_sent')?.data)
      .toMatchObject({ optimistic_id: 'optimistic_mock_attachment_1' });
  });

  test('emits terminal action telemetry when first fixture send fails after optimistic insert', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'optimistic_mock_attachment_1',
      });
      throw new Error('scripted_send_failure');
    });
    runtime.registerSendHandler('mock-host:mock-session', sendHandler);
    setTimeout(() => telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_OPEN, {}), 0);
    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_SESSION_SCREEN_MOUNT, {
        stream_id: 'mock-host:mock-session',
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'mock-host:mock-session',
      });
    }, 300);

    await actions.runSendFixtureImage({
      host: 'mock-host',
      provider: 'codex',
      imageBase64: 'aW1n',
      attemptOpenExistingChat: jest.fn(() => 'mock-host:mock-session'),
    });

    expect(seen.find((p) => p.message === 'harness:send_fixture_image_sent')?.data)
      .toMatchObject({
        stream_id: 'mock-host:mock-session',
        status: 'ok',
        optimistic_id: 'optimistic_mock_attachment_1',
      });
  });
});

describe('composite_chat_load_probe', () => {
  const deps = (overrides: Record<string, unknown> = {}) => ({
    host: 'mock-host',
    provider: 'codex' as const,
    initialStreamId: 'mock-host:mock-session',
    text: 'queued composite send',
    imageBase64: 'aW1n',
    router: { push: jest.fn() },
    attemptOpenExistingChat: jest.fn(() => 'mock-host:mock-session'),
    getStreamPhase: jest.fn(() => 'working'),
    getSessionSummary: jest.fn((streamId: string) => ({
      stream_id: streamId,
      host: 'mock-host',
      provider: 'codex',
      session_name: 'mock-session',
    })),
    repeatCount: 1,
    preOpenWaitMs: 0,
    workingWaitTimeoutMs: 100,
    waitForSessionMount: jest.fn(async () => true),
    ...overrides,
  });

  test('waits for the registered composer working state, not reducer phase alone', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    let composerWorking = false;
    const sendHandler = jest.fn(async () => {
      expect(composerWorking).toBe(true);
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'composite-queued-1',
      });
    });
    runtime.registerSendHandler('mock-host:mock-session', sendHandler, () => composerWorking);
    setTimeout(() => { composerWorking = true; }, 20);

    await actions.runCompositeChatLoadProbe(deps());

    expect(sendHandler).toHaveBeenCalledTimes(1);
    const before = seen.find(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_send_before_dispatch',
    );
    expect(before?.data).toMatchObject({ phase: 'working', composer_working: true });
    expect(seen.find(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_send_sent',
    )?.data).toMatchObject({
      stream_id: 'mock-host:mock-session',
      optimistic_id: 'composite-queued-1',
      status: 'ok',
    });
    expect(seen.some((payload) => payload.data.kind === 'composite_seed_send_dispatched')).toBe(false);
  });

  test('waits through fixture pacing and drift before dispatching', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    let phase = 'idle';
    let composerWorking = false;
    const sendHandler = jest.fn(async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'composite-queued-delayed',
      });
    });
    runtime.registerSendHandler('mock-host:mock-session', sendHandler, () => composerWorking);
    setTimeout(() => {
      phase = 'working';
      composerWorking = true;
    }, 550);

    await actions.runCompositeChatLoadProbe(deps({
      getStreamPhase: () => phase,
      workingWaitTimeoutMs: 800,
    }));

    expect(sendHandler).toHaveBeenCalledTimes(1);
    const before = seen.find(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_send_before_dispatch',
    );
    expect(before?.data).toMatchObject({ phase: 'working', composer_working: true });
  });

  test('dispatches consecutive queued probes without awaiting the prior send result', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    let callCount = 0;
    let resolveFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const sendHandler = jest.fn(async () => {
      callCount += 1;
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: `composite-queued-${callCount}`,
      });
      if (callCount === 1) await firstPending;
    });
    runtime.registerSendHandler('mock-host:mock-session', sendHandler, () => true);
    setTimeout(() => resolveFirst?.(), 20);

    await actions.runCompositeChatLoadProbe(deps({ sendCount: 2 }));

    expect(sendHandler).toHaveBeenCalledTimes(2);
    const dispatched = seen.filter(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_send_dispatched',
    );
    expect(dispatched.map((payload) => payload.data.optimistic_id)).toEqual([
      'composite-queued-1',
      'composite-queued-2',
    ]);
  });

  test('does not dispatch when phase says working but the registered composer is idle', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const sendHandler = jest.fn(async () => undefined);
    runtime.registerSendHandler('mock-host:mock-session', sendHandler, () => false);

    await actions.runCompositeChatLoadProbe(deps({ workingWaitTimeoutMs: 20 }));

    expect(sendHandler).not.toHaveBeenCalled();
    const before = seen.find(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_send_before_dispatch',
    );
    expect(before?.data).toMatchObject({ phase: 'working', composer_working: false });
  });

  test('does not dispatch when the composer reports working but reducer phase is idle', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const sendHandler = jest.fn(async () => undefined);
    runtime.registerSendHandler('mock-host:mock-session', sendHandler, () => true);
    telemetry.setTelemetrySink(() => undefined);

    await actions.runCompositeChatLoadProbe(deps({
      getStreamPhase: jest.fn(() => 'idle'),
      workingWaitTimeoutMs: 20,
    }));

    expect(sendHandler).not.toHaveBeenCalled();
  });

  test('honors create/delete delay while repeat navigation continues', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.registerSendHandler('mock-host:mock-session', async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'composite-queued-delayed-delete',
      });
    }, () => true);
    let created = true;
    const waitForMount = jest.fn(async () => true);

    await actions.runCompositeChatLoadProbe(deps({
      repeatCount: 3,
      listDwellMs: 0,
      createDeleteStreamId: 'mock-host:mock-created',
      createDeleteStartDelayMs: 20,
      createDeleteTimeoutMs: 100,
      createDeleteDwellMs: 0,
      waitForSessionMount: waitForMount,
      getSessionSummary: (streamId: string) => created && streamId === 'mock-host:mock-created'
        ? {
          stream_id: streamId,
          host: 'mock-host',
          provider: 'codex',
          session_name: 'mock-created',
        }
        : null,
      streamActions: {
        closeSession: jest.fn(async () => ({ closed: false, deferred: true, queued: false })),
        forcePendingClose: jest.fn(async () => {
          created = false;
          return true;
        }),
      },
    }));

    const traces = seen.filter((payload) => String(payload.message) === 'harness:ui_trace');
    expect(traces.find((payload) => payload.data.kind === 'composite_create_delete_scheduled')?.data)
      .toMatchObject({ start_delay_ms: 20 });
    const kinds = traces.map((payload) => payload.data.kind);
    expect(waitForMount).toHaveBeenCalledTimes(3);
    expect(kinds.indexOf('composite_list_pushed')).toBeLessThan(kinds.indexOf('composite_create_start'));
    expect(traces.find((payload) => payload.data.kind === 'composite_delete_settled')?.data)
      .toMatchObject({ status: 'absent', force_status: 'ok' });
  });

  test('uses the focused UI trace as the repeat-navigation mount boundary', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    runtime.registerSendHandler('mock-host:mock-session', async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'composite-focused-mount',
      });
    }, () => true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const navIntent = require('../src/services/chatOpenNavigationIntent');
    const router = { push: jest.fn(() => {
      telemetry.logTelemetry('harness:ui_trace' as Parameters<typeof telemetry.logTelemetry>[0], {
        kind: 'session_screen_mount',
        stream_id: 'mock-host:mock-session',
      });
      // The real session screen acknowledges the nav intent on focus, clearing
      // the coordinator's pending so the next open navigates instead of no-oping.
      navIntent.acknowledgeChatRowNavigationIntent('mock-host:mock-session');
    }) };

    await actions.runCompositeChatLoadProbe(deps({
      router,
      repeatCount: 2,
      listDwellMs: 0,
      mountTimeoutMs: 100,
      waitForSessionMount: undefined,
    }));

    const settled = seen.filter(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_open_settled',
    );
    expect(router.push).toHaveBeenCalledTimes(3);
    expect(settled).toHaveLength(2);
    expect(settled.every((payload) => payload.data.mounted === true)).toBe(true);
  });

  // The chat_open_slo measurement counts a sample complete only when the open
  // emits `first-authoritative-row-mount`. That paint can only fire after the
  // session screen focused and acked its nav intent, so the loop must not tear
  // the screen down before it lands. `transcript_ready_settled` is time-based and
  // fires ~13ms earlier, so it must NOT satisfy the gate (2026-08-29: advancing on
  // it left 18 of 20 samples missing both paint phases).
  const emitUiTrace = (telemetry: any, data: Record<string, unknown>) => {
    telemetry.logTelemetry('harness:ui_trace' as Parameters<typeof telemetry.logTelemetry>[0], data);
  };
  const registerNoopSendHandler = (runtime: any, telemetry: any) => {
    // Unblocks the probe's one-time send so the test exercises the open gate only.
    runtime.registerSendHandler('mock-host:mock-session', async () => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'composite-open-gate',
      });
    }, () => true);
  };

  test('does not advance the open loop on transcript_ready_settled alone', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    registerNoopSendHandler(runtime, telemetry);
    const router = { push: jest.fn(() => {
      emitUiTrace(telemetry, { kind: 'session_screen_mount', stream_id: 'mock-host:mock-session' });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'mock-host:mock-session',
      });
    }) };

    await actions.runCompositeChatLoadProbe(deps({
      router,
      waitForSessionMount: undefined,
      mountTimeoutMs: 60,
    }));

    const settled = seen.filter(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_open_settled',
    );
    // Mount + settle without the authoritative-row paint must NOT satisfy the
    // gate: the loop only advances at the mount timeout, and the sample is
    // reported paint-incomplete.
    expect(settled).toHaveLength(1);
    expect(settled[0].data).toMatchObject({ mounted: true, painted: false, transcript_settled: true });
  });

  // Regression (spec chat_open_slo_open_settle_sampler_overlap): on a fast Release
  // build the authoritative-row paint can land BEFORE the transcript settle. The
  // open loop must not tear the session screen down on paint alone, or the settle
  // effect is cancelled and the per-open `open_settle` bucket_cost_sample is never
  // emitted (observed 7/20 open_settle, 13 interval). The loop must wait for the
  // settle so every open contributes exactly one open_settle regardless of speed.
  test('waits for transcript settle before advancing when paint precedes it (open_settle not dropped)', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    registerNoopSendHandler(runtime, telemetry);
    const streamId = 'mock-host:mock-session';
    const router = { push: jest.fn(() => {
      emitUiTrace(telemetry, { kind: 'session_screen_mount', stream_id: streamId });
      emitUiTrace(telemetry, {
        kind: 'chat_open_paint',
        correlationId: 'chat-open:1',
        stream_id: streamId,
        phase: 'first-authoritative-row-mount',
        monotonicMs: 1,
        wallTimeMs: 1,
      });
      // The transcript settle (which fires the per-open open_settle emit) lands
      // AFTER the paint on a fast build.
      setTimeout(() => {
        telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
          stream_id: streamId,
        });
      }, 10);
    }) };

    await actions.runCompositeChatLoadProbe(deps({
      router,
      waitForSessionMount: undefined,
      mountTimeoutMs: 500,
    }));

    const settleIdx = seen.findIndex(
      (payload) => String(payload.message) === String(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED)
        && String(payload.data.stream_id || '') === streamId,
    );
    const openSettledIdx = seen.findIndex(
      (payload) => String(payload.message) === 'harness:ui_trace'
        && payload.data.kind === 'composite_open_settled'
        && payload.data.iteration === 0,
    );
    // The settle must be observed BEFORE the open is completed/torn down.
    expect(settleIdx).toBeGreaterThanOrEqual(0);
    expect(openSettledIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeLessThan(openSettledIdx);
    expect(seen[openSettledIdx].data).toMatchObject({
      mounted: true,
      painted: true,
      transcript_settled: true,
    });
  });

  test('advances the open loop once mount, paint, and transcript settle all land', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    registerNoopSendHandler(runtime, telemetry);
    const router = { push: jest.fn(() => {
      emitUiTrace(telemetry, { kind: 'session_screen_mount', stream_id: 'mock-host:mock-session' });
      emitUiTrace(telemetry, {
        kind: 'chat_open_paint',
        correlationId: 'chat-open:1',
        stream_id: 'mock-host:mock-session',
        phase: 'first-authoritative-row-mount',
        monotonicMs: 1,
        wallTimeMs: 1,
      });
      telemetry.logTelemetry(TELEMETRY_EVENTS.HARNESS_TRANSCRIPT_READY_SETTLED, {
        stream_id: 'mock-host:mock-session',
      });
    }) };

    await actions.runCompositeChatLoadProbe(deps({
      router,
      waitForSessionMount: undefined,
      mountTimeoutMs: 2000,
    }));

    const settled = seen.filter(
      (payload) => String(payload.message) === 'harness:ui_trace' && payload.data.kind === 'composite_open_settled',
    );
    expect(settled).toHaveLength(1);
    expect(settled[0].data).toMatchObject({ mounted: true, painted: true, transcript_settled: true });
  });
});

// ---------------------------------------------------------------------------
// retry_failed_send
// ---------------------------------------------------------------------------

describe('retry_failed_send', () => {
  test('waits for failed optimistic send, invokes retry, and emits sent telemetry', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const retryOptimisticSend = jest.fn((optimisticId: string) => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RETRY, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: optimisticId,
      });
    });

    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_FAILED, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'optimistic_mock_attachment_1',
      });
    }, 10);

    await actions.runRetryFailedSend({
      streamId: 'mock-host:mock-session',
      optimisticId: 'optimistic_mock_attachment_1',
      timeoutMs: 1000,
      retryOptimisticSend,
    });

    expect(retryOptimisticSend).toHaveBeenCalledWith('optimistic_mock_attachment_1');
    expect(seen.find((p) => p.message === 'harness:retry_failed_send_sent')?.data)
      .toMatchObject({
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'optimistic_mock_attachment_1',
        status: 'ok',
      });
  });

  test('retries when the failed optimistic send is only observed through rendered row state', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const retryOptimisticSend = jest.fn((optimisticId: string) => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_RETRY, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: optimisticId,
      });
    });

    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_EVENT_RENDERED, {
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'optimistic_mock_attachment_1',
        send_state: 'failed',
      });
    }, 10);

    await actions.runRetryFailedSend({
      streamId: 'mock-host:mock-session',
      optimisticId: 'optimistic_mock_attachment_1',
      timeoutMs: 1000,
      retryOptimisticSend,
    });

    expect(retryOptimisticSend).toHaveBeenCalledWith('optimistic_mock_attachment_1');
    expect(seen.find((p) => p.message === 'harness:retry_failed_send_sent')?.data)
      .toMatchObject({
        stream_id: 'mock-host:mock-session',
        optimistic_id: 'optimistic_mock_attachment_1',
        status: 'ok',
      });
  });

  test('skips when no failed send is observed', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const retryOptimisticSend = jest.fn();

    await actions.runRetryFailedSend({
      streamId: 'mock-host:mock-session',
      timeoutMs: 10,
      retryOptimisticSend,
    });

    expect(retryOptimisticSend).not.toHaveBeenCalled();
    expect(seen.find((p) => p.message === 'harness:retry_failed_send_skipped')?.data)
      .toMatchObject({ reason: 'failed_timeout' });
  });
});

// ---------------------------------------------------------------------------
// disconnect_after_send
// ---------------------------------------------------------------------------

describe('disconnect_after_send', () => {
  test('happy path: optimistic_insert observed → forceCloseWs called → _closed telemetry', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const forceCloseWs = jest.fn(() => true);

    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:dx',
        optimistic_id: 'optimistic_dx_1',
      });
    }, 10);

    await actions.runDisconnectAfterSend({
      forceCloseWs,
      streamId: 'hostc:codex:dx',
      optimisticWaitMs: 1000,
    });

    expect(forceCloseWs).toHaveBeenCalledWith('harness_forced');
    const closed = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED,
    );
    expect(closed?.data).toMatchObject({
      stream_id: 'hostc:codex:dx',
      optimistic_id: 'optimistic_dx_1',
    });
    const aborted = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED,
    );
    expect(aborted).toBeUndefined();
  });

  test('uses the optimistic_insert payload to close while the send is still pending', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const forceCloseWs = jest.fn(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_WS_CLOSE, { reason: 'harness_forced' });
      return true;
    });

    setTimeout(() => {
      telemetry.logTelemetry(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT, {
        stream_id: 'hostc:codex:pending-drop',
        optimistic_id: 'optimistic_pending_drop_1',
      });
    }, 10);
    await actions.runDisconnectAfterSend({
      forceCloseWs,
      optimisticWaitMs: 1000,
    });

    const messages = seen.map((p) => p.message);
    const insertIdx = messages.indexOf(TELEMETRY_EVENTS.CHAT_COMPOSE_OPTIMISTIC_INSERT);
    const closedIdx = messages.indexOf(TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED);
    const partnerSentIdx = messages.indexOf(TELEMETRY_EVENTS.HARNESS_OPEN_CHAT_THEN_SEND_SENT);

    expect(forceCloseWs).toHaveBeenCalledWith('harness_forced');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(closedIdx).toBeGreaterThan(insertIdx);
    expect(partnerSentIdx).toBe(-1);
    expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_CLOSED)?.data)
      .toMatchObject({
        stream_id: 'hostc:codex:pending-drop',
        optimistic_id: 'optimistic_pending_drop_1',
      });
  });

  test('aborted: no optimistic_insert within window → _aborted{reason=optimistic_not_observed}', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const forceCloseWs = jest.fn(() => true);

    await actions.runDisconnectAfterSend({
      forceCloseWs,
      streamId: 'hostc:codex:dx-abort',
      optimisticWaitMs: 30,
    });

    expect(forceCloseWs).not.toHaveBeenCalled();
    const aborted = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_DISCONNECT_AFTER_SEND_ABORTED,
    );
    expect(aborted?.data).toMatchObject({
      reason: 'optimistic_not_observed',
      stream_id: 'hostc:codex:dx-abort',
    });
  });
});

// ---------------------------------------------------------------------------
// open_settings_then_toggle
// ---------------------------------------------------------------------------

describe('open_settings_then_toggle', () => {
  test('inverts current showToolActions and emits typed boolean from/to in _done', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const router = { push: jest.fn() };
    const preferences = {
      getUserPreference: jest.fn(() => false as boolean),
      setUserPreference: jest.fn(async () => undefined),
    };

    await actions.runOpenSettingsThenToggle({ router, preferences });

    expect(router.push).toHaveBeenNthCalledWith(1, '/(tabs)/settings');
    expect(preferences.getUserPreference).toHaveBeenCalledWith('showToolActions');
    expect(preferences.setUserPreference).toHaveBeenCalledWith('showToolActions', true);
    expect(router.push).toHaveBeenNthCalledWith(2, '/(tabs)/chats');

    const done = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE,
    );
    expect(done?.data).toEqual({ key: 'showToolActions', from_value: false, to_value: true });
    expect(typeof done?.data.from_value).toBe('boolean');
    expect(typeof done?.data.to_value).toBe('boolean');
  });

  test('inverts true → false correctly', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const preferences = {
      getUserPreference: jest.fn(() => true as boolean),
      setUserPreference: jest.fn(async () => undefined),
    };
    await actions.runOpenSettingsThenToggle({ router: { push: jest.fn() }, preferences });

    expect(preferences.setUserPreference).toHaveBeenCalledWith('showToolActions', false);
    const done = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE,
    );
    expect(done?.data).toMatchObject({ from_value: true, to_value: false });
  });

  test('accepts showTurnDuration as a toggle key', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const preferences = {
      getUserPreference: jest.fn(() => false as boolean),
      setUserPreference: jest.fn(async () => undefined),
    };
    await actions.runOpenSettingsThenToggle({
      router: { push: jest.fn() },
      preferences,
      key: 'showTurnDuration',
    });

    expect(preferences.getUserPreference).toHaveBeenCalledWith('showTurnDuration');
    expect(preferences.setUserPreference).toHaveBeenCalledWith('showTurnDuration', true);
    expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_OPEN_SETTINGS_THEN_TOGGLE_DONE)?.data)
      .toMatchObject({ key: 'showTurnDuration', from_value: false, to_value: true });
  });
});

// ---------------------------------------------------------------------------
// write_user_preference
// ---------------------------------------------------------------------------

describe('write_user_preference', () => {
  test('coerces "true" → boolean true and calls setUserPreference', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));

    const preferences = {
      getUserPreference: jest.fn(),
      setUserPreference: jest.fn(async () => undefined),
    };

    await actions.runWriteUserPreference({
      pref: 'showToolActions',
      value: 'true',
      preferences,
    });

    expect(preferences.setUserPreference).toHaveBeenCalledWith('showToolActions', true);
    const scheduled = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_SCHEDULED,
    );
    expect(scheduled?.data).toEqual({ key: 'showToolActions', value: true });
    expect(typeof scheduled?.data.value).toBe('boolean');

    const done = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_DONE,
    );
    expect(done?.data).toEqual({ key: 'showToolActions', value: true });
    expect(typeof done?.data.value).toBe('boolean');
  });

  test('coerces "false" → boolean false', async () => {
    const { actions } = loadFreshModules();
    const preferences = {
      getUserPreference: jest.fn(),
      setUserPreference: jest.fn(async () => undefined),
    };
    await actions.runWriteUserPreference({
      pref: 'showToolActions',
      value: 'false',
      preferences,
    });
    expect(preferences.setUserPreference).toHaveBeenCalledWith('showToolActions', false);
  });

  test('writes showTurnDuration as an allowed boolean preference', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const preferences = {
      getUserPreference: jest.fn(),
      setUserPreference: jest.fn(async () => undefined),
    };

    await actions.runWriteUserPreference({
      pref: 'showTurnDuration',
      value: 'true',
      preferences,
    });

    expect(preferences.setUserPreference).toHaveBeenCalledWith('showTurnDuration', true);
    expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_DONE)?.data)
      .toEqual({ key: 'showTurnDuration', value: true });
  });

  test('skips unknown preference keys with a warning', async () => {
    const { actions, telemetry } = loadFreshModules();
    const seen: TelemetryPayload[] = [];
    telemetry.setTelemetrySink((payload) => seen.push(payload));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const preferences = {
      getUserPreference: jest.fn(),
      setUserPreference: jest.fn(async () => undefined),
    };
    await actions.runWriteUserPreference({
      pref: 'unsupportedKey',
      value: 'true',
      preferences,
    });

    expect(preferences.setUserPreference).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const scheduled = seen.find(
      (p) => p.message === TELEMETRY_EVENTS.HARNESS_WRITE_USER_PREFERENCE_SCHEDULED,
    );
    expect(scheduled).toBeUndefined();

    warnSpy.mockRestore();
  });

  test('skips uncoercible values with a warning', async () => {
    const { actions } = loadFreshModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const preferences = {
      getUserPreference: jest.fn(),
      setUserPreference: jest.fn(async () => undefined),
    };
    await actions.runWriteUserPreference({
      pref: 'showToolActions',
      value: 'maybe',
      preferences,
    });
    expect(preferences.setUserPreference).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// chat_open_paint through the composite probe: the harness open paths must emit
// the paint trace (root-cause regression), and the multi-target seam must drive
// N distinct-stream opens each routed through the shared navigation unit.
// ---------------------------------------------------------------------------
describe('composite probe chat_open_paint + multi-target seam', () => {
  const probeDeps = (overrides: Record<string, unknown> = {}) => ({
    host: 'mock-host',
    provider: 'codex' as const,
    text: '',
    imageBase64: '',
    router: { push: jest.fn(), replace: jest.fn() },
    attemptOpenExistingChat: jest.fn(() => 'mock-host:discovered'),
    getSessionSummary: jest.fn((streamId: string) => ({
      stream_id: streamId, host: 'mock-host', provider: 'codex', session_name: 's',
    })),
    getStreamPhase: jest.fn(() => undefined), // never "working" -> send path returns fast
    repeatCount: 1,
    preOpenWaitMs: 0,
    listDwellMs: 0,
    mountTimeoutMs: 50,
    handlerRegisterTimeoutMs: 0, // no send handler registered -> resolve immediately
    workingWaitTimeoutMs: 0,
    // Simulate the session screen acknowledging the nav intent on mount, so the
    // coordinator clears pending between opens exactly as the real app does.
    waitForSessionMount: jest.fn(async (streamId: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/services/chatOpenNavigationIntent').acknowledgeChatRowNavigationIntent(streamId);
      return true;
    }),
    ...overrides,
  });

  test('single stream_id override open emits the chat_open_paint tap (SLO path)', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    runtime.markHarnessTokenReady(); // so whenHarnessTokenReady resolves immediately
    telemetry.setTelemetrySink(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const paintSignals = require('../src/services/chatOpenPaintSignals');
    const paint: { streamId: string; phase: string }[] = [];
    paintSignals.setChatOpenPaintSink((s: { streamId: string; phase: string }) => paint.push(s));

    await actions.runCompositeChatLoadProbe(probeDeps({ initialStreamId: 'mock-host:slo-00', repeatCount: 1 }));

    expect(paint.some((p) => p.streamId === 'mock-host:slo-00' && p.phase === 'tap')).toBe(true);
    paintSignals.setChatOpenPaintSink(null);
  });

  test('multi-target seam drives N distinct-stream opens, each through the shared unit', async () => {
    const { runtime, actions, telemetry } = loadFreshModules();
    runtime.markHarnessTokenReady(); // so whenHarnessTokenReady resolves immediately
    telemetry.setTelemetrySink(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const paintSignals = require('../src/services/chatOpenPaintSignals');
    const paint: { streamId: string; phase: string }[] = [];
    paintSignals.setChatOpenPaintSink((s: { streamId: string; phase: string }) => paint.push(s));

    const targets = ['mock-host:c00', 'mock-host:c01', 'mock-host:c02'];
    await actions.runCompositeChatLoadProbe(probeDeps({
      openTargetStreamIds: targets,
      repeatCount: targets.length,
    }));

    const tappedStreams = paint.filter((p) => p.phase === 'tap').map((p) => p.streamId);
    expect(tappedStreams).toEqual(targets); // one cold open per distinct target, in order
    paintSignals.setChatOpenPaintSink(null);
  });
});
