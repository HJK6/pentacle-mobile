import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import {
  applyURL,
  hasAction,
  getParam,
  getScenario,
  isArmed,
  markBootResolved,
  reset,
  waitArmed,
  markNavigationReady,
  whenNavigationReady,
  isNavigationReady,
  beginHarnessTokenReload,
  markHarnessTokenReady,
  whenHarnessTokenReady,
  markStreamHarnessActive,
  isStreamHarnessActive,
  clearHarnessActiveStreams,
  __getHarnessActiveStreamsForTests,
  registerSendHandler,
  dispatchSend,
} from '../../src/utils/harnessRuntime';
import { setTelemetrySink, type TelemetryPayload } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';

const captureTelemetry = (): TelemetryPayload[] => {
  const log: TelemetryPayload[] = [];
  setTelemetrySink((p) => log.push(p));
  return log;
};

describe('harnessRuntime', () => {
  beforeEach(() => {
    reset();
    setTelemetrySink(null);
  });

  describe('applyURL', () => {
    it('parses a valid pentacle://harness URL into actions, params, and scenario', () => {
      const log = captureTelemetry();
      const ok = applyURL('pentacle://harness?actions=force_ws_reconnect,autoaccept_biometric&scenario=test&owner_id=42');

      expect(ok).toBe(true);
      expect(isArmed()).toBe(true);
      expect(hasAction('force_ws_reconnect')).toBe(true);
      expect(hasAction('autoaccept_biometric')).toBe(true);
      expect(hasAction('not_in_set')).toBe(false);
      expect(getScenario()).toBe('test');
      expect(getParam('owner_id')).toBe('42');
      expect(getParam('missing')).toBeUndefined();

      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      expect(armed).toHaveLength(1);
      expect(armed[0].data).toMatchObject({
        scenario: 'test',
        actions: ['force_ws_reconnect', 'autoaccept_biometric'],
        paramNames: ['owner_id'],
      });
    });

    it('handles empty actions= as a valid arming (still fires harness_armed)', () => {
      const log = captureTelemetry();
      const ok = applyURL('pentacle://harness?actions=&scenario=smoke');

      expect(ok).toBe(true);
      expect(isArmed()).toBe(true);
      expect(hasAction('force_ws_reconnect')).toBe(false);
      expect(getScenario()).toBe('smoke');
      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      expect(armed).toHaveLength(1);
      expect(armed[0].data).toMatchObject({ actions: [], scenario: 'smoke', paramNames: [] });
    });

    it('binds scenario_run_id as a data value so the runner arming gate can match', () => {
      const log = captureTelemetry();
      applyURL('pentacle://harness?actions=&scenario=chat_open_slo&scenario_run_id=run-123');

      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      // `run_scenario` asserts EventSpec(..., where={'scenario_run_id': <run id>}),
      // which reads data.scenario_run_id — a paramNames entry is a key, not a value.
      expect(armed[0].data).toMatchObject({ scenario_run_id: 'run-123' });
    });

    it('reports a null scenario_run_id when the harness URL carries none', () => {
      const log = captureTelemetry();
      applyURL('pentacle://harness?actions=&scenario=smoke');

      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      expect(armed[0].data).toMatchObject({ scenario_run_id: null });
    });

    it('keeps the armed payload under the os_log cap for a chat_open_slo-sized URL', () => {
      // The real 2026-08-29 chat_open_slo param set. Enumerating these names
      // pushed the syslog line past os_log's ~1024-byte truncation point, which
      // left invalid JSON and cost the runner the arming event entirely.
      const params = [
        'PENTACLE_EVENT_REPLAY_COMMAND', 'active_stream_ids', 'chat_open_slo_events_per_stream',
        'chat_open_slo_incomplete_sample_policy', 'chat_open_slo_open_completion_boundary',
        'chat_open_slo_open_probe', 'chat_open_slo_open_serialization',
        'chat_open_slo_per_open_timeout_ms', 'chat_open_slo_sampling_semantics',
        'chat_open_slo_stream_count', 'chat_open_slo_warm_reopen_probe', 'corpus_kind',
        'events_per_stream', 'history_event_count', 'host', 'list_dwell_ms', 'mock_fixture_path',
        'mount_timeout_ms', 'pentacle_token', 'pre_open_wait_ms', 'provider', 'repeat_count',
        'scripted_daemon_entry_path', 'scripted_daemon_fixture_path', 'scripted_daemon_log_path',
        'scripted_daemon_python_shim_dir', 'scripted_daemon_replay_tool_path',
        'scripted_daemon_server_log_path', 'slo_wait_timeout_s',
      ];
      const query = params.map((name) => `${name}=v`).join('&');
      const log = captureTelemetry();
      applyURL(
        `pentacle://harness?actions=autoaccept_biometric,composite_chat_load_probe` +
          `&scenario=chat_open_slo&scenario_run_id=chat-open-slo-8caa7d99-20260829T213400Z&${query}`,
      );

      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      expect(armed).toHaveLength(1);
      // The correlation fields survive; the unbounded name list is what gives way.
      expect(armed[0].data).toMatchObject({
        scenario: 'chat_open_slo',
        scenario_run_id: 'chat-open-slo-8caa7d99-20260829T213400Z',
        paramCount: params.length + 1,
      });
      expect(armed[0].data).not.toHaveProperty('paramNames');
      // Full relayed line = envelope + payload; os_log truncates the message at ~1024 bytes.
      expect(JSON.stringify(armed[0]).length).toBeLessThan(900);
    });

    it('returns false and leaves state untouched for non-harness URLs', () => {
      const log = captureTelemetry();
      const ok = applyURL('pentacle://session/abc');

      expect(ok).toBe(false);
      expect(isArmed()).toBe(false);
      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      expect(armed).toHaveLength(0);
    });

    it('returns false for null URL', () => {
      const ok = applyURL(null);
      expect(ok).toBe(false);
      expect(isArmed()).toBe(false);
    });

    it('atomically replaces state when called twice', () => {
      applyURL('pentacle://harness?actions=force_ws_reconnect');
      expect(hasAction('force_ws_reconnect')).toBe(true);
      expect(hasAction('autoaccept_biometric')).toBe(false);

      applyURL('pentacle://harness?actions=autoaccept_biometric');
      expect(hasAction('force_ws_reconnect')).toBe(false);
      expect(hasAction('autoaccept_biometric')).toBe(true);
    });

    it('treats action tokens as case-sensitive', () => {
      applyURL('pentacle://harness?actions=Force_WS_Reconnect');
      expect(hasAction('force_ws_reconnect')).toBe(false);
      expect(hasAction('Force_WS_Reconnect')).toBe(true);
    });
  });

  it('dispatchSend passes a fixture image request to the registered composer handler', async () => {
    process.env.EXPO_PUBLIC_HARNESS = '1';
    applyURL('pentacle://harness?actions=send_fixture_image');
    const handler = jest.fn(async () => undefined);
    registerSendHandler('stream:fixture', handler);

    const request = {
      text: 'caption',
      fixtureImage: {
        base64: 'aW1n',
        mimeType: 'image/png' as const,
        width: 1,
        height: 1,
        bytes: 3,
      },
    };
    const result = await dispatchSend('stream:fixture', request);

    expect(result.status).toBe('ok');
    expect(handler).toHaveBeenCalledWith(request);
  });

  describe('markBootResolved', () => {
    it('flips armed=true without firing harness_armed', () => {
      const log = captureTelemetry();

      expect(isArmed()).toBe(false);
      markBootResolved();
      expect(isArmed()).toBe(true);

      const armed = log.filter((p) => p.message === TELEMETRY_EVENTS.HARNESS_HARNESS_ARMED);
      expect(armed).toHaveLength(0);
    });

    it('is a no-op when already armed', () => {
      applyURL('pentacle://harness?actions=force_ws_reconnect');
      expect(isArmed()).toBe(true);

      const log = captureTelemetry();
      markBootResolved();

      // Action set is preserved (markBootResolved did not clear it).
      expect(hasAction('force_ws_reconnect')).toBe(true);
      // No additional telemetry.
      expect(log).toHaveLength(0);
    });
  });

  describe('waitArmed', () => {
    it('resolves immediately when already armed', async () => {
      applyURL('pentacle://harness?actions=');
      const result = await waitArmed(50);
      expect(result).toBe(true);
    });

    it('resolves true when armed flips before timeout', async () => {
      const promise = waitArmed(100);
      // Flip armed asynchronously after a microtask tick.
      Promise.resolve().then(() => markBootResolved());
      const result = await promise;
      expect(result).toBe(true);
    });

    it('resolves false when timeout elapses without arming', async () => {
      jest.useFakeTimers();
      try {
        const promise = waitArmed(100);
        jest.advanceTimersByTime(150);
        const result = await promise;
        expect(result).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('reset', () => {
    it('clears state for tests', () => {
      applyURL('pentacle://harness?actions=force_ws_reconnect&scenario=test&owner_id=42');
      expect(isArmed()).toBe(true);

      reset();

      expect(isArmed()).toBe(false);
      expect(hasAction('force_ws_reconnect')).toBe(false);
      expect(getScenario()).toBeNull();
      expect(getParam('owner_id')).toBeUndefined();
    });
  });

  describe('navigation-ready gate', () => {
    it('starts not-ready after reset', () => {
      expect(isNavigationReady()).toBe(false);
    });

    it('whenNavigationReady resolves immediately once markNavigationReady fired (warm path)', async () => {
      markNavigationReady();
      expect(isNavigationReady()).toBe(true);
      await expect(whenNavigationReady(50)).resolves.toBe(true);
    });

    it('whenNavigationReady waits for a later markNavigationReady (cold path)', async () => {
      const pending = whenNavigationReady(1000);
      let resolved = false;
      void pending.then(() => {
        resolved = true;
      });
      // Not resolved until the navigator mounts.
      await Promise.resolve();
      expect(resolved).toBe(false);
      markNavigationReady();
      await expect(pending).resolves.toBe(true);
    });

    it('whenNavigationReady resolves false on timeout when navigation never readies', async () => {
      await expect(whenNavigationReady(1)).resolves.toBe(false);
    });

    it('markNavigationReady is idempotent', () => {
      markNavigationReady();
      markNavigationReady();
      expect(isNavigationReady()).toBe(true);
    });
  });

  describe('harness-token-ready gate', () => {
    it('resolves immediately when no harness token reload is pending', async () => {
      await expect(whenHarnessTokenReady(50)).resolves.toBe(true);
    });

    it('waits until a pending harness token reload is marked ready', async () => {
      beginHarnessTokenReload();
      const pending = whenHarnessTokenReady(1000);
      let resolved = false;
      void pending.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      markHarnessTokenReady();
      await expect(pending).resolves.toBe(true);
    });

    it('resolves false on timeout when token reload never readies', async () => {
      beginHarnessTokenReload();
      await expect(whenHarnessTokenReady(1)).resolves.toBe(false);
    });
  });

  describe('harness-active-stream tracker (mirror gate)', () => {
    it('starts empty after reset', () => {
      expect(__getHarnessActiveStreamsForTests().size).toBe(0);
      expect(isStreamHarnessActive('hostc:claude-foo')).toBe(false);
    });

    it('markStreamHarnessActive admits a stream into the active set', () => {
      markStreamHarnessActive('hostc:claude-foo');
      expect(isStreamHarnessActive('hostc:claude-foo')).toBe(true);
      expect(isStreamHarnessActive('hostc:claude-bar')).toBe(false);
    });

    it('mark is idempotent and supports multiple streams', () => {
      markStreamHarnessActive('a');
      markStreamHarnessActive('a');
      markStreamHarnessActive('b');
      expect(__getHarnessActiveStreamsForTests().size).toBe(2);
      expect(isStreamHarnessActive('a')).toBe(true);
      expect(isStreamHarnessActive('b')).toBe(true);
    });

    it('empty/undefined streamId is a no-op', () => {
      markStreamHarnessActive('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markStreamHarnessActive(undefined as any);
      expect(__getHarnessActiveStreamsForTests().size).toBe(0);
    });

    it('clearHarnessActiveStreams empties the set', () => {
      markStreamHarnessActive('a');
      markStreamHarnessActive('b');
      clearHarnessActiveStreams();
      expect(__getHarnessActiveStreamsForTests().size).toBe(0);
      expect(isStreamHarnessActive('a')).toBe(false);
    });

    it('reset() also clears the active set', () => {
      markStreamHarnessActive('a');
      reset();
      expect(__getHarnessActiveStreamsForTests().size).toBe(0);
    });
  });
});

