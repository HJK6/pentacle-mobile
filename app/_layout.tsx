import { LogBox, Linking } from 'react-native';

// Suppress harmless Expo native module warnings that fire on startup
LogBox.ignoreLogs([
  'Cannot find native module',
  'Calling getExpoPushTokenAsync',
]);

import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { setHostConfigProvider } from 'pentacle-chat-core';
import { getHostOrder, getHostTheme } from '../src/config/local';
import { Stack } from 'expo-router';

// Feed the platform-neutral chat-core package its hostconfig data source.
// pentacle-chat-core's chat-model selectors (getHostOrder/getHostTheme) delegate
// to this provider; config/local owns the Expo-sourced host order + themes and
// stays out of the package. Wired once at app startup, before any selector runs.
setHostConfigProvider({ getHostOrder, getHostTheme });
import { useEffect } from 'react';
import { AppState, View, StyleSheet, Text, TouchableOpacity, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Updates from 'expo-updates';
import { useFonts } from 'expo-font';
import useBiometricLock from '../src/hooks/useBiometricLock';
import usePushNotifications from '../src/hooks/usePushNotifications';
import { getNativeNotifications } from '../src/services/nativeNotifications';
import { Colors, Fonts } from '@/constants/Colors';


export { ErrorBoundary } from 'expo-router';

// Screenshot-harness-only: install the offline stream + window.__pentacleHarness
// seam at module scope, before RootLayout mounts, so the first paint is seeded.
// Strictly gated on EXPO_PUBLIC_SCREENSHOT_HARNESS so production dead-codes it.
// Spec: example-mobile mock screenshot harness.
if (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === '1') {
  require('../src/harness/screenshotHarness').installScreenshotHarness();
}

// Harness-only: parse the launch URL and arm the runtime scenario state
// BEFORE any auto-action hook (useBiometricLock, usePushNotifications)
// is evaluated by RootLayout. Production builds (no EXPO_PUBLIC_HARNESS)
// carry zero handler code — env var is replaced with `undefined` at
// bundle time and the conditional is dead-coded.
// Spec: public_behavior_contract
if (process.env.EXPO_PUBLIC_HARNESS === '1') {
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
  const pentacleStream = require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
  const harnessDiagnostics = require('../src/services/harnessDiagnostics') as typeof import('../src/services/harnessDiagnostics');
  const harnessOpenExistingChat = require('../src/services/harnessOpenExistingChat') as typeof import('../src/services/harnessOpenExistingChat');
  const harnessAwaitNewStream = require('../src/services/harnessAwaitNewStream') as typeof import('../src/services/harnessAwaitNewStream');
  const harnessActions = require('../src/services/harnessActions') as typeof import('../src/services/harnessActions');
  const chatOpenPaintSignals = require('../src/services/chatOpenPaintSignals') as typeof import('../src/services/chatOpenPaintSignals');
  const bucketCostSampleSignals = require('../src/services/bucketCostSampleSignals') as typeof import('../src/services/bucketCostSampleSignals');
  const bucketCostSampleForwarding = require('../src/services/bucketCostSampleForwarding') as typeof import('../src/services/bucketCostSampleForwarding');
  const processMemory = require('../src/services/processMemory') as typeof import('../src/services/processMemory');
  const pentacleAssets = require('../src/services/pentacleAssets') as typeof import('../src/services/pentacleAssets');
  const pentacleToken = require('../src/hooks/usePentacleToken') as typeof import('../src/hooks/usePentacleToken');
  const userPreferences = require('../src/services/userPreferences') as typeof import('../src/services/userPreferences');
  const expoRouter = require('expo-router') as typeof import('expo-router');
  telemetry.setTelemetrySink((payload) => {
    const line = `[TELEMETRY] ${JSON.stringify(payload)}`;
    const nativeLoggingHook = (globalThis as unknown as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook;
    if (typeof nativeLoggingHook === 'function') {
      nativeLoggingHook(line, 2);
    } else {
      console.log(line);
    }
  });
  chatOpenPaintSignals.setChatOpenPaintSink((signal) => {
    telemetry.logTelemetry('harness:ui_trace' as Parameters<typeof telemetry.logTelemetry>[0], {
      kind: 'chat_open_paint',
      correlationId: signal.correlationId,
      stream_id: signal.streamId,
      phase: signal.phase,
      monotonicMs: signal.monotonicMs,
      wallTimeMs: signal.wallTimeMs,
    });
  });
  // bucket_cost_sample: the retained weighted event cost across ALL buckets (G5
  // deterministic accessor `retainedPentacleEventCost`) plus process RSS,
  // forwarded through the same `harness:ui_trace` telemetry path as the paint
  // signals. Sampled at each open-settle and at ~1Hz over the corpus-load
  // window. Production never calls this, so the sampler stays inert there.
  bucketCostSampleSignals.configureBucketCostSampling({
    sink: bucketCostSampleForwarding.createBucketCostSampleTelemetrySink(
      (name, data) => telemetry.logTelemetry(name, data),
    ),
    getWeightedCost: () => telemetry.retainedPentacleEventCost(pentacleStream.getPentacleStreamState()),
    getRssBytes: () => processMemory.readProcessRssBytes(),
  });
  const runtimeErrorCollector = require('../src/harness/runtimeErrorCollector') as typeof import('../src/harness/runtimeErrorCollector');
  const rejectionTracking = require('promise/setimmediate/rejection-tracking') as { enable: (options: Record<string, unknown>) => void };
  const rejectionOptionsModule = require('react-native/Libraries/promiseRejectionTrackingOptions') as { default?: Record<string, unknown> } | Record<string, unknown>;
  runtimeErrorCollector.installHarnessRuntimeErrorCollector({
    log: (payload) => telemetry.logTelemetry(
      'harness:runtime_error' as Parameters<typeof telemetry.logTelemetry>[0],
      payload,
    ),
    runId: () => harnessRuntime.getParam('scenario_run_id') || '',
    rejectionTracking,
    hermesInternal: (globalThis as unknown as { HermesInternal?: { enablePromiseRejectionTracker?: (options: Record<string, unknown>) => void } }).HermesInternal,
    rejectionOptions: (('default' in rejectionOptionsModule
      ? rejectionOptionsModule.default
      : rejectionOptionsModule) || {}) as Record<string, unknown>,
  });
  const applyHarnessURL = (url: string | null) => {
    const applied = harnessRuntime.applyURL(url);
    if (applied) {
      const streamIdOverride = harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override');
      if (streamIdOverride) {
        harnessRuntime.markStreamHarnessActive(streamIdOverride);
      }
      const activeStreamIds = harnessRuntime.getParam('active_stream_ids');
      if (activeStreamIds) {
        activeStreamIds
          .split(',')
          .map((item) => decodeURIComponent(item).trim())
          .filter(Boolean)
          .forEach((streamId) => harnessRuntime.markStreamHarnessActive(streamId));
      }
      const harnessWsUrl = harnessRuntime.getParam('ws_url');
      if (harnessWsUrl) {
        pentacleStream.setPentacleWsUrl(harnessWsUrl);
      }
      harnessRuntime.beginHarnessTokenReload();
      void pentacleToken.reloadPentacleToken().finally(() => {
        harnessRuntime.markHarnessTokenReady();
      });
    }
  };
  let sessionStateDumpSubscribed = false;
  let sessionStateDumpComplete = false;
  let openExistingChatSubscribed = false;
  let openExistingChatComplete = false;
  let openExistingChatDelayStarted = false;
  let openExistingChatDelayElapsed = false;
  let awaitNewStreamSubscribed = false;
  let reportViewerE2eDispatched = false;
  let runtimeSentinelReadyDispatched = false;
  let runtimeSentinelFailureDispatched = false;
  let runtimeSentinelReleaseRequestDispatched = false;
  const subscribeSessionStateDump = () => {
    if (sessionStateDumpSubscribed || !harnessRuntime.hasAction('dump_session_state')) return;
    sessionStateDumpSubscribed = true;
    let unsubscribe: (() => void) | null = null;
    const maybeDump = () => {
      if (sessionStateDumpComplete) return;
      const state = pentacleStream.getPentacleStreamState();
      if (!state.hasHydrated) return;
      sessionStateDumpComplete = true;
      unsubscribe?.();
      harnessDiagnostics.dumpSessionState(state);
    };
    unsubscribe = pentacleStream.subscribePentacleStream(maybeDump);
    maybeDump();
  };
  const subscribeOpenExistingChat = () => {
    if (openExistingChatSubscribed || !harnessRuntime.hasAction('open_existing_chat')) return;
    openExistingChatSubscribed = true;
    let unsubscribe: (() => void) | null = null;
    const maybeOpen = () => {
      if (openExistingChatComplete) return;
      const state = pentacleStream.getPentacleStreamState();
      const streamIdOverride = harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override');
      if (!state?.hasHydrated && !streamIdOverride) return;
      const preOpenWaitMs = Number(harnessRuntime.getParam('pre_open_wait_ms') || 0);
      if (!openExistingChatDelayStarted) {
        openExistingChatDelayStarted = true;
        const routeSettleMs = Number.isFinite(preOpenWaitMs) && preOpenWaitMs > 0
          ? preOpenWaitMs
          : 250;
        setTimeout(() => {
          openExistingChatDelayElapsed = true;
          maybeOpen();
        }, routeSettleMs);
        return;
      }
      if (!openExistingChatDelayElapsed) return;
      const providerParam = harnessRuntime.getParam('provider');
      const provider =
        providerParam === 'claude' || providerParam === 'codex' ? providerParam : undefined;
      const opened = streamIdOverride
        ? harnessOpenExistingChat.attemptOpenExistingChat(
          state,
          harnessRuntime.getParam('host'),
          expoRouter.router,
          provider,
          streamIdOverride,
        )
        : harnessOpenExistingChat.attemptOpenExistingChat(
          state,
          harnessRuntime.getParam('host'),
          expoRouter.router,
          provider,
        );
      if (!opened) return;
      openExistingChatComplete = true;
      unsubscribe?.();
    };
    unsubscribe = pentacleStream.subscribePentacleStream(maybeOpen);
    maybeOpen();
  };
  let writeUserPreferenceDone = false;
  const subscribeWriteUserPreference = () => {
    // write_user_preference fires synchronously off URL arming — no need to
    // wait for stream hydration. Run once per scenario boot to guard against
    // duplicate apply calls (e.g. the cold-launch URL Promise + linking
    // event both landing).
    if (writeUserPreferenceDone || !harnessRuntime.hasAction('write_user_preference')) return;
    writeUserPreferenceDone = true;
    const pref = harnessRuntime.getParam('pref');
    const value = harnessRuntime.getParam('value');
    if (!pref || value === undefined) return;
    void harnessActions.runWriteUserPreference({
      pref,
      value,
      preferences: {
        getUserPreference: userPreferences.getUserPreference,
        setUserPreference: userPreferences.setUserPreference,
      },
    });
  };

  const composeFlowDispatched = new Set<string>();
  let lastHarnessActionRunKey = '';
  const resetHarnessActionDispatchStateIfNeeded = () => {
    const runKey = [
      harnessRuntime.getParam('scenario_run_id') || '',
      harnessRuntime.getParam('scenario') || '',
    ].join(':');
    if (!runKey || runKey === lastHarnessActionRunKey) return;
    lastHarnessActionRunKey = runKey;
    composeFlowDispatched.clear();
    sessionStateDumpSubscribed = false;
    sessionStateDumpComplete = false;
    openExistingChatSubscribed = false;
    openExistingChatComplete = false;
    openExistingChatDelayStarted = false;
    openExistingChatDelayElapsed = false;
    awaitNewStreamSubscribed = false;
    reportViewerE2eDispatched = false;
    runtimeSentinelReadyDispatched = false;
    runtimeSentinelFailureDispatched = false;
    runtimeSentinelReleaseRequestDispatched = false;
  };
  const dispatchSpawnChatThenSend = () => {
    if (composeFlowDispatched.has('spawn_chat_then_send')) return;
    if (!harnessRuntime.hasAction('spawn_chat_then_send')) return;
    composeFlowDispatched.add('spawn_chat_then_send');
    const host = harnessRuntime.getParam('host') || '';
    const providerParam = harnessRuntime.getParam('provider');
    const provider =
      providerParam === 'claude' || providerParam === 'codex' ? providerParam : 'codex';
    const text = harnessRuntime.getParam('text');
    void harnessActions.runSpawnChatThenSend({
      host,
      provider,
      text,
      forceCloseBeforeSend: harnessRuntime.hasAction('disconnect_before_send'),
      forceCloseWs: pentacleStream.harnessForceCloseWs,
      router: expoRouter.router,
      streamActions: {
        sendMessage: pentacleStream.sendPentacleMessage,
        appendOptimisticUserMessage: pentacleStream.appendOptimisticUserMessage,
        getSpawnCatalog: pentacleStream.getSpawnCatalog,
        spawnSessionV2: pentacleStream.spawnPentacleSessionV2,
        renameSession: pentacleStream.renamePentacleSession,
      },
    });
  };
  const dispatchOpenChatThenSend = () => {
    if (composeFlowDispatched.has('open_chat_then_send')) return;
    if (!harnessRuntime.hasAction('open_chat_then_send')) return;
    composeFlowDispatched.add('open_chat_then_send');
    const host = harnessRuntime.getParam('host') || '';
    const providerParam = harnessRuntime.getParam('provider');
    const provider =
      providerParam === 'claude' || providerParam === 'codex' ? providerParam : undefined;
    const text = harnessRuntime.getParam('text');
    void harnessActions.runOpenChatThenSend({
      host,
      provider,
      text,
      forceCloseBeforeSend: harnessRuntime.hasAction('disconnect_before_send'),
      forceCloseWs: pentacleStream.harnessForceCloseWs,
      attemptOpenExistingChat: (h, p) =>
        (harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override'))
          ? harnessOpenExistingChat.attemptOpenExistingChat(
            pentacleStream.getPentacleStreamState(),
            h,
            expoRouter.router,
            p,
            harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override'),
          )
          : harnessOpenExistingChat.attemptOpenExistingChat(
            pentacleStream.getPentacleStreamState(),
            h,
            expoRouter.router,
            p,
          ),
    });
  };
  const dispatchSendFixtureImage = () => {
    if (composeFlowDispatched.has('send_fixture_image')) return;
    if (!harnessRuntime.hasAction('send_fixture_image')) return;
    composeFlowDispatched.add('send_fixture_image');
    const host = harnessRuntime.getParam('host') || '';
    const providerParam = harnessRuntime.getParam('provider');
    const provider =
      providerParam === 'claude' || providerParam === 'codex' ? providerParam : undefined;
    const imageMimeParam = harnessRuntime.getParam('image_mime');
    const imageMimeType = imageMimeParam === 'image/jpeg' || imageMimeParam === 'image/png'
      ? imageMimeParam
      : undefined;
    const imageWidth = Number(harnessRuntime.getParam('image_width') || 0) || undefined;
    const imageHeight = Number(harnessRuntime.getParam('image_height') || 0) || undefined;
    const imageBytes = Number(harnessRuntime.getParam('image_bytes') || 0) || undefined;
    void harnessActions.runSendFixtureImage({
      host,
      provider,
      text: harnessRuntime.getParam('text') || '',
      imageBase64: harnessRuntime.getParam('image_base64') || '',
      imageMimeType,
      imageName: harnessRuntime.getParam('image_name') || undefined,
      imageWidth,
      imageHeight,
      imageBytes,
      attemptOpenExistingChat: (h, p) =>
        (harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override'))
          ? harnessOpenExistingChat.attemptOpenExistingChat(
            pentacleStream.getPentacleStreamState(),
            h,
            expoRouter.router,
            p,
            harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override'),
          )
          : harnessOpenExistingChat.attemptOpenExistingChat(
            pentacleStream.getPentacleStreamState(),
            h,
            expoRouter.router,
            p,
          ),
    });
  };
  const dispatchCompositeChatLoadProbe = () => {
    if (composeFlowDispatched.has('composite_list_probe')) return;
    if (!harnessRuntime.hasAction('composite_list_probe')) return;
    composeFlowDispatched.add('composite_list_probe');
    const host = harnessRuntime.getParam('host') || '';
    const providerParam = harnessRuntime.getParam('provider');
    const provider =
      providerParam === 'claude' || providerParam === 'codex' ? providerParam : undefined;
    const imageMimeParam = harnessRuntime.getParam('image_mime');
    const imageMimeType = imageMimeParam === 'image/jpeg' || imageMimeParam === 'image/png'
      ? imageMimeParam
      : undefined;
    const imageWidth = Number(harnessRuntime.getParam('image_width') || 0) || undefined;
    const imageHeight = Number(harnessRuntime.getParam('image_height') || 0) || undefined;
    const imageBytes = Number(harnessRuntime.getParam('image_bytes') || 0) || undefined;
    const numberParam = (name: string) => {
      const value = Number(harnessRuntime.getParam(name) || 0);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const streamIdOverride = harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override');
    // Multi-target open seam: a comma-separated ordered list of stream_ids the
    // probe opens one-per-iteration (distinct-stream cold opens). Absent -> the
    // probe keeps repeating the single stream_id override. `stream_ids` is the
    // driver contract (chat_open_slo passes the 20 distinct cold-open targets
    // there); `open_target_stream_ids` is accepted as an explicit alias.
    const openTargetsParam = harnessRuntime.getParam('stream_ids')
      || harnessRuntime.getParam('open_target_stream_ids')
      || '';
    const openTargetStreamIds = openTargetsParam
      ? openTargetsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    // The composite probe drives the corpus load + the repeated opens, so its
    // lifetime is the bucket_cost_sample interval window (~1Hz `interval`
    // samples; per-open `open_settle` samples fire from the session screen).
    bucketCostSampleSignals.startBucketCostIntervalSampling();
    void harnessActions.runCompositeChatLoadProbe({
      host,
      provider,
      initialStreamId: streamIdOverride || undefined,
      openTargetStreamIds,
      text: harnessRuntime.getParam('text') || '',
      imageBase64: harnessRuntime.getParam('image_base64') || '',
      imageMimeType,
      imageName: harnessRuntime.getParam('image_name') || undefined,
      imageWidth,
      imageHeight,
      imageBytes,
      router: expoRouter.router,
      preOpenWaitMs: numberParam('pre_open_wait_ms'),
      repeatCount: numberParam('repeat_count'),
      sendCount: numberParam('send_count'),
      listDwellMs: numberParam('list_dwell_ms'),
      mountTimeoutMs: numberParam('mount_timeout_ms'),
      workingWaitTimeoutMs: numberParam('working_wait_timeout_ms'),
      jsProbeIntervalMs: numberParam('js_probe_interval_ms'),
      createDeleteStreamId: harnessRuntime.getParam('create_delete_stream_id') || undefined,
      createDeleteSessionName: harnessRuntime.getParam('create_delete_session_name') || undefined,
      createDeleteStartDelayMs: numberParam('create_delete_start_delay_ms'),
      createDeleteTimeoutMs: numberParam('create_delete_timeout_ms'),
      createDeleteDwellMs: numberParam('create_delete_dwell_ms'),
      getStreamPhase: (streamId) =>
        pentacleStream.getPentacleStreamState().workingByStream?.[streamId]?.phase,
      getSessionSummary: (streamId) =>
        pentacleStream.getPentacleStreamState().sessions.find((session) => session.stream_id === streamId) || null,
      streamActions: {
        closeSession: pentacleStream.closePentacleSession,
        forcePendingClose: pentacleStream.forcePendingSessionClose,
      },
      attemptOpenExistingChat: (h, p, override) =>
        harnessOpenExistingChat.attemptOpenExistingChat(
          pentacleStream.getPentacleStreamState(),
          h,
          expoRouter.router,
          p,
          override || streamIdOverride || undefined,
        ),
    }).finally(() => {
      bucketCostSampleSignals.stopBucketCostIntervalSampling();
    });
  };
  const dispatchOpenChatWhileWsDown = () => {
    if (composeFlowDispatched.has('open_chat_while_ws_down')) return;
    if (!harnessRuntime.hasAction('open_chat_while_ws_down')) return;
    composeFlowDispatched.add('open_chat_while_ws_down');
    const host = harnessRuntime.getParam('host') || '';
    const providerParam = harnessRuntime.getParam('provider');
    const provider =
      providerParam === 'claude' || providerParam === 'codex' ? providerParam : undefined;
    void harnessActions.runOpenChatWhileWsDown({
      host,
      provider,
      router: expoRouter.router,
      forceCloseWs: pentacleStream.harnessForceCloseWs,
      attemptOpenExistingChat: (h, p) =>
        (harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override'))
          ? harnessOpenExistingChat.attemptOpenExistingChat(
            pentacleStream.getPentacleStreamState(),
            h,
            expoRouter.router,
            p,
            harnessRuntime.getParam('stream_id') || harnessRuntime.getParam('stream_id_override'),
          )
          : harnessOpenExistingChat.attemptOpenExistingChat(
            pentacleStream.getPentacleStreamState(),
            h,
            expoRouter.router,
            p,
          ),
    });
  };
  const dispatchSendAgain = () => {
    if (composeFlowDispatched.has('send_again')) return;
    if (!harnessRuntime.hasAction('send_again')) return;
    composeFlowDispatched.add('send_again');
    const text = harnessRuntime.getParam('next_text') || harnessRuntime.getParam('text');
    const countRaw = harnessRuntime.getParam('count');
    const count = countRaw ? Math.max(1, Number(countRaw) || 1) : 1;
    const timeoutRaw = harnessRuntime.getParam('timeout_ms');
    const timeoutMs = timeoutRaw ? Math.max(1, Number(timeoutRaw) || 0) : undefined;
    void harnessActions.runSendAgain({
      text,
      count,
      timeoutMs,
      waitForSettingsToggle: harnessRuntime.getParam('send_again_after_toggle') === 'true',
      getStreamPhase: (streamId) =>
        pentacleStream.getPentacleStreamState().workingByStream?.[streamId]?.phase,
    });
  };
  const dispatchRetryFailedSend = () => {
    if (composeFlowDispatched.has('retry_failed_send')) return;
    if (!harnessRuntime.hasAction('retry_failed_send')) return;
    composeFlowDispatched.add('retry_failed_send');
    const timeoutRaw = harnessRuntime.getParam('retry_timeout_ms') || harnessRuntime.getParam('timeout_ms');
    const timeoutMs = timeoutRaw ? Math.max(1, Number(timeoutRaw) || 0) : undefined;
    void harnessActions.runRetryFailedSend({
      timeoutMs,
      streamId: harnessRuntime.getParam('stream_id') || undefined,
      optimisticId: harnessRuntime.getParam('optimistic_id') || undefined,
      retryOptimisticSend: pentacleStream.retryOptimisticSend,
    });
  };
  const dispatchCopyChatSample = () => {
    if (composeFlowDispatched.has('copy_chat_sample')) return;
    if (!harnessRuntime.hasAction('copy_chat_sample')) return;
    composeFlowDispatched.add('copy_chat_sample');
    const delayRaw = harnessRuntime.getParam('copy_delay_ms');
    const delayMs = delayRaw ? Math.max(0, Number(delayRaw) || 0) : undefined;
    void harnessActions.runCopyChatSample({
      messageText: harnessRuntime.getParam('message_text') || harnessRuntime.getParam('text') || '',
      codeText: harnessRuntime.getParam('code_text') || '',
      delayMs,
    });
  };
  const dispatchDisconnectAfterSend = () => {
    if (composeFlowDispatched.has('disconnect_after_send')) return;
    if (!harnessRuntime.hasAction('disconnect_after_send')) return;
    composeFlowDispatched.add('disconnect_after_send');
    void harnessActions.runDisconnectAfterSend({
      forceCloseWs: pentacleStream.harnessForceCloseWs,
    });
  };
  const dispatchSilentHalfOpen = () => {
    if (composeFlowDispatched.has('silent_half_open')) return;
    if (!harnessRuntime.hasAction('silent_half_open')) return;
    composeFlowDispatched.add('silent_half_open');
    const delayMs = Math.max(0, Number(harnessRuntime.getParam('half_open_delay_ms') || 0) || 0);
    setTimeout(() => {
      pentacleStream.harnessActivateSilentHalfOpen();
    }, delayMs);
  };
  const dispatchFocusedLivenessProbe = () => {
    if (composeFlowDispatched.has('focused_liveness_probe')) return;
    if (!harnessRuntime.hasAction('focused_liveness_probe')) return;
    composeFlowDispatched.add('focused_liveness_probe');
    const delayMs = Math.max(0, Number(harnessRuntime.getParam('focused_probe_delay_ms') || 0) || 0);
    setTimeout(() => {
      pentacleStream.requestFocusedPentacleLivenessProbe('interaction');
    }, delayMs);
  };
  const dispatchOpenSettingsThenToggle = () => {
    if (composeFlowDispatched.has('open_settings_then_toggle')) return;
    if (!harnessRuntime.hasAction('open_settings_then_toggle')) return;
    composeFlowDispatched.add('open_settings_then_toggle');
    const keyParam = harnessRuntime.getParam('key');
    const key =
      keyParam === 'showToolActions' || keyParam === 'showTurnDuration' ? keyParam : undefined;
    void harnessActions.runOpenSettingsThenToggle({
      router: expoRouter.router,
      preferences: {
        getUserPreference: userPreferences.getUserPreference,
        setUserPreference: userPreferences.setUserPreference,
      },
      key,
      waitForActiveStreamIdle: harnessRuntime.getParam('toggle_after_turn_idle') === 'true',
      getStreamPhase: (streamId) =>
        pentacleStream.getPentacleStreamState().workingByStream?.[streamId]?.phase,
    });
  };

  const dispatchOpenUpdates = () => {
    if (composeFlowDispatched.has('open_updates')) return;
    if (!harnessRuntime.hasAction('open_updates')) return;
    composeFlowDispatched.add('open_updates');
    void harnessActions.runOpenUpdates({ router: expoRouter.router });
  };
  const dispatchTabNavigation = () => {
    if (composeFlowDispatched.has('tab_navigation')) return;
    if (!harnessRuntime.hasAction('tab_navigation')) return;
    composeFlowDispatched.add('tab_navigation');
    void harnessActions.runTabNavigation({ router: expoRouter.router });
  };
  const dispatchAllChatsRegression = () => {
    if (composeFlowDispatched.has('list_fixture')) return;
    if (!harnessRuntime.hasAction('list_fixture')) return;
    composeFlowDispatched.add('list_fixture');
    const fixtureStreamId = harnessRuntime.getParam('stream_id') || 'fixture-host:freeze-00';
    const reportCount = Number(harnessRuntime.getParam('all_chats_report_count') || 16);
    const questionCount = Number(harnessRuntime.getParam('all_chats_question_count') || 16);
    const assetHarness = require('../src/services/pentacleAssets') as typeof import('../src/services/pentacleAssets');
    const fixtureNotification = (index: number, state: 'open' | 'resolved') => ({
      notification_id: `all-chats-question-${index}`,
      producer: 'agent_question.v1',
      severity: 'info',
      title: `All Chats question ${index}`,
      body: 'Choose a fixture response.',
      state,
      created_at: `2026-07-12T12:00:${String(index).padStart(2, '0')}.000Z`,
      actions: [{ kind: 'ack', action_id: `ack-${index}`, label: 'Acknowledge', value: 'ack' }],
      question: {
        schema_version: 1,
        question_id: `all-chats-question-${index}`,
        title: `All Chats question ${index}`,
        body: 'Choose a fixture response.',
        dedup_key: `all-chats-question-${index}`,
        producer_stream_id: fixtureStreamId,
        producer_provider: 'codex',
        response_mode: 'single_choice',
        options: [{ label: 'Acknowledge', value: 'ack' }],
        state,
        ttl_seconds: 3600,
      },
    });
    const fixtureReportFrame = (index: number, read: boolean) => ({
      type: 'asset.update',
      stream_id: fixtureStreamId,
      asset_id: `all-chats-report-${index}`,
      title: `All Chats report ${index}`,
      content_type: 'report',
      read,
      read_at: read ? `2026-07-12T12:01:${String(index).padStart(2, '0')}.000Z` : null,
      created_at: `2026-07-12T12:00:${String(index).padStart(2, '0')}.000Z`,
      updated_at: `2026-07-12T12:01:${String(index).padStart(2, '0')}.000Z`,
    });
    const waitForRenderCommit = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const waitForDaemonSeq = (expectedDaemonSeq: number, timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        let unsubscribe: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        const finish = (matched: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe?.();
          resolve(matched);
        };
        // Applied-through-seq ack (not "store contains >= N"): once N has reached
        // the ingestion path, force-drain the live-apply batch and resolve only when
        // an applied cursor has reached N with no received live row still queued.
        // Missing global sequence numbers are not treated as loss. Without this, burst 1 releases
        // while a setup-tail straggler is still batched, and its frames coalesce with
        // that straggler into one apply whose first_seq is a setup seq — the
        // "burst 1 gap after sequence N" / "missing fixture applied" race. Deterministic
        // (a synchronous drain), no wall-clock sleep. The pre-N flood never drains here
        // because the harness receive admission inside the drain gates the flush, so
        // coalescing under load is preserved even when applied rows were retained away.
        const settle = () => {
          const drained = pentacleStream.__drainLiveApplyThroughForHarness(expectedDaemonSeq);
          if (
            drained.maxSeq >= expectedDaemonSeq &&
            drained.pending === 0 &&
            drained.cohortComplete !== false
          ) {
            finish(true);
            return true;
          }
          return false;
        };
        if (settle()) return;
        unsubscribe = pentacleStream.subscribePentacleStream(() => {
          settle();
        });
        timer = setTimeout(() => finish(false), timeoutMs);
        settle();
      });
    // The embedded harness shell can start outside the tab navigator. Mount
    // the real Chats screen before waiting for its focus/ready seam; this is
    // harness/action gated and does not synthesize readiness or alter product
    // navigation.
    const allChatsRegression = harnessActions.runAllChatsRegression({
      timeoutMs: Number(harnessRuntime.getParam('all_chats_event_timeout_ms') || 90_000),
      isReady: () => {
        const chatsModule = require('./(tabs)/chats') as {
          isAllChatsHarnessScreenReady?: () => boolean;
        };
        return chatsModule.isAllChatsHarnessScreenReady?.() === true;
      },
      streamId: harnessRuntime.getParam('stream_id') || undefined,
      setupEventCount: Number(harnessRuntime.getParam('all_chats_setup_event_count') || 1120),
      burstSize: Number(harnessRuntime.getParam('all_chats_burst_size') || 16),
      waitForDaemonSeq,
      seedFixtureState: async () => {
        for (let index = 0; index < reportCount; index += 1) {
          assetHarness.__handlePentacleAssetFrameForTests(fixtureReportFrame(index, false));
        }
        for (let index = 0; index < questionCount; index += 1) {
          pentacleStream.__handlePentacleStreamMessageForTests({
            type: 'notification',
            notification: fixtureNotification(index, 'open'),
          });
        }
        await waitForRenderCommit();
      },
      applyFixtureState: async (burst) => {
        const index = burst - 1;
        assetHarness.__handlePentacleAssetFrameForTests(fixtureReportFrame(index, true));
        for (let questionIndex = 0; questionIndex < questionCount; questionIndex += 1) {
          pentacleStream.__handlePentacleStreamMessageForTests({
            type: 'notification',
            notification: fixtureNotification(questionIndex, questionIndex < burst ? 'resolved' : 'open'),
          });
        }
        await waitForRenderCommit();
      },
      getFixtureState: () => {
        const streamState = pentacleStream.getPentacleStreamState();
        const events = streamState.events;
        const retainedByStream = new Map<string, number>();
        for (const event of events) {
          retainedByStream.set(event.stream_id, (retainedByStream.get(event.stream_id) || 0) + 1);
        }
        return {
          eventCount: events.length,
          maxDaemonSeq: events.reduce((max, event) => Math.max(max, Number(event.daemon_seq || 0)), 0),
          unreadCount: assetHarness.reportUnreadCount(fixtureStreamId),
          openQuestionCount: pentacleStream.getPentacleStreamState().notifications.filter(
            (notification) => notification.state === 'open' &&
              notification.question?.producer_stream_id === fixtureStreamId,
          ).length,
          sessionSummaryCount: streamState.sessions.filter(
            (session) => session.stream_id.startsWith('fixture-host:freeze-'),
          ).length,
          perStreamRetainedMax: Math.max(0, ...retainedByStream.values()),
        };
      },
      returnToAllChats: () => new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          expoRouter.router.back();
          requestAnimationFrame(() => resolve());
        });
      }),
      dispatch: async (request) => {
        try {
          const chatsModule = require('./(tabs)/chats') as {
            dispatchAllChatsHarnessAction?: (
              action: typeof request,
            ) => Promise<{ status: string }>;
          };
          if (!chatsModule.dispatchAllChatsHarnessAction) return { status: 'no_handler' };
          return chatsModule.dispatchAllChatsHarnessAction(request);
        } catch {
          return { status: 'no_handler' };
        }
      },
    });
    harnessActions.mountAllChatsRegressionScreen(expoRouter.router);
    void allChatsRegression;
  };
  const dispatchResolveNotification = () => {
    if (composeFlowDispatched.has('resolve_notification')) return;
    if (!harnessRuntime.hasAction('resolve_notification')) return;
    composeFlowDispatched.add('resolve_notification');
    const actionKindParam = harnessRuntime.getParam('action_kind');
    if (
      actionKindParam !== 'ack' &&
      actionKindParam !== 'yes_no' &&
      actionKindParam !== 'spawn_worker'
    ) {
      return;
    }
    const choiceParam = harnessRuntime.getParam('choice');
    const choice =
      choiceParam === 'true' ? true : choiceParam === 'false' ? false : undefined;
    const selectionsParam = harnessRuntime.getParam('selections') || harnessRuntime.getParam('selection');
    const selections = selectionsParam
      ? selectionsParam.split(',').map((item) => item.trim()).filter(Boolean)
      : undefined;
    const text = harnessRuntime.getParam('text');
    void harnessActions.runResolveNotification({
      action_kind: actionKindParam,
      choice,
      selections,
      text,
      note: harnessRuntime.getParam('note') || undefined,
      delayMs: Number(harnessRuntime.getParam('resolve_delay_ms') || 0) || undefined,
      marker: harnessRuntime.getParam('marker'),
      waitForQuestionRender: harnessRuntime.getParam('resolve_after_question_rendered') === 'true',
      questionStreamId: harnessRuntime.getParam('stream_id') || undefined,
      questionRenderTimeoutMs: Number(harnessRuntime.getParam('question_render_timeout_ms') || 0) || undefined,
      getNotifications: () => pentacleStream.getPentacleStreamState().notifications,
      subscribe: pentacleStream.subscribePentacleStream,
      resolveNotification: pentacleStream.resolveNotification,
      answerPrompt: pentacleStream.answerDaemonPrompt,
    });
  };
  const dispatchDismissQuestion = () => {
    if (composeFlowDispatched.has('dismiss_question')) return;
    if (!harnessRuntime.hasAction('dismiss_question')) return;
    composeFlowDispatched.add('dismiss_question');
    const optionParam = harnessRuntime.getParam('option');
    const dismissAnswersParam = harnessRuntime.getParam('dismiss_answers');
    const prepared = harnessActions.prepareDismissQuestionHarnessParams({
      optionParam,
      dismissAnswersParam,
    });
    if (!prepared.shouldRun) return;
    void harnessActions.runDismissQuestion({
      option: prepared.option,
      answers: prepared.answers,
      getSessions: () => pentacleStream.getPentacleStreamState().sessions,
      subscribe: pentacleStream.subscribePentacleStream,
      dismissQuestion: pentacleStream.dismissQuestion,
    });
  };
  const dispatchReportViewerE2e = () => {
    if (reportViewerE2eDispatched || !harnessRuntime.hasAction('open_report_viewer')) return;
    reportViewerE2eDispatched = true;
    const scenarioRunId = harnessRuntime.getParam('scenario_run_id') || '';
    const streamId = `fixture:report-viewer:${scenarioRunId}`;
    const tableBlockId = `wide-matrix--${scenarioRunId}`;
    const commentBlockId = `comment-target--${scenarioRunId}`;
    pentacleAssets.enableReportViewerHarnessMode();
    pentacleAssets.harnessSeedReports(streamId, [{
      asset_id: 'harness-report-wide-table',
      title: 'Wide report matrix',
      content_type: 'report',
      producer: 'example-source',
      read: false,
      updated_at: '2026-07-14T00:00:00.000Z',
      body: {
        schema_version: 1,
        title: 'Wide report matrix',
        sections: [{
          id: 'matrix-section',
          title: 'Evidence matrix',
          status: 'reference',
          blocks: [{
            id: tableBlockId,
            type: 'table',
            columns: ['Item', 'Reviewer', 'Validation', 'Disposition', 'Evidence'],
            rows: [[['Horizontal scroll interaction'], ['Mobile Checks'], ['Scroll offset asserted'], ['Verified'], ['right-side columns']]],
          }, {
            id: commentBlockId,
            type: 'para',
            runs: ['Comment round-trip target'],
          }],
        }],
      },
    }]);
    expoRouter.router.push({
      pathname: '/pentacle/session/[streamId]',
      params: { streamId, reportHarness: '1' },
    } as never);
    telemetry.logTelemetry('harness:report_viewer_ready' as Parameters<typeof telemetry.logTelemetry>[0], {
      stream_id: streamId,
      scenario_run_id: scenarioRunId,
      block_id: tableBlockId,
    });
  };
  const dispatchRuntimeSentinel = () => {
    if (!harnessRuntime.hasAction('runtime_error_check')) return;
    const sentinel = harnessRuntime.getParam('runtime_sentinel') || 'clean';
    const scenarioRunId = harnessRuntime.getParam('scenario_run_id') || '';
    if (!runtimeSentinelReadyDispatched) {
      runtimeSentinelReadyDispatched = true;
      telemetry.logTelemetry('harness:runtime_sentinel_ready' as Parameters<typeof telemetry.logTelemetry>[0], {
        sentinel,
        scenario_run_id: scenarioRunId,
      });
    }
    if (sentinel === 'clean') return;
    const failure = () => new Error(`runtime sentinel ${sentinel}`);
    const dispatchFatalFailure = () => {
      if (runtimeSentinelFailureDispatched) return;
      runtimeSentinelFailureDispatched = true;
      const errorUtils = (globalThis as unknown as { ErrorUtils?: { getGlobalHandler?: () => (error: unknown, fatal?: boolean) => void } }).ErrorUtils;
      telemetry.logTelemetry('harness:runtime_sentinel_released' as Parameters<typeof telemetry.logTelemetry>[0], {
        sentinel,
        scenario_run_id: scenarioRunId,
      });
      errorUtils?.getGlobalHandler?.()(failure(), true);
    };
    if (sentinel === 'fatal') {
      const releaseUrl = harnessRuntime.getParam('runtime_sentinel_release_url');
      if (!releaseUrl || runtimeSentinelReleaseRequestDispatched) return;
      runtimeSentinelReleaseRequestDispatched = true;
      void fetch(releaseUrl)
        .then((response) => {
          if (!response.ok) return;
          if (harnessRuntime.getParam('scenario_run_id') !== scenarioRunId) return;
          if (harnessRuntime.getParam('runtime_sentinel') !== sentinel) return;
          dispatchFatalFailure();
        })
        .catch(() => undefined);
      return;
    }
    if (runtimeSentinelFailureDispatched) return;
    runtimeSentinelFailureDispatched = true;
    if (sentinel === 'console_error') console.error(failure());
    else if (sentinel === 'unhandled_rejection') void Promise.reject(failure());
    else if (sentinel === 'delayed_post_return') {
      setTimeout(() => console.error(failure()), 500);
    }
  };

  const subscribeHarnessHydrationActions = () => {
    resetHarnessActionDispatchStateIfNeeded();
    subscribeWriteUserPreference();
    subscribeSessionStateDump();
    // Navigation-driving harness actions must wait until the expo-router root
    // navigator has mounted. On a cold launch the harness bootstrap (and the
    // initial-URL promise) can run before RootLayout mounts; calling
    // router.push() then throws "Attempted to navigate before mounting the
    // Root Layout component", which the action layer swallows — silently
    // aborting the flow so harness:session_screen_mount never fires.
    // whenNavigationReady() resolves immediately on the warm path and after
    // RootLayout's post-mount markNavigationReady() on the cold path. The
    // dispatchers are idempotent (composeFlowDispatched / awaitNewStreamSubscribed).
    void harnessRuntime.whenNavigationReady().then(() => {
      subscribeOpenExistingChat();
      if (!awaitNewStreamSubscribed && harnessRuntime.hasAction('await_and_open_new_stream')) {
        awaitNewStreamSubscribed = true;
        harnessAwaitNewStream.subscribeAndOpenNewStream(
          pentacleStream,
          harnessRuntime.getParam('marker'),
          harnessRuntime.getParam('host_filter'),
          expoRouter.router,
        );
      }
      // Compose-driving actions (public_behavior_spec)
      dispatchSpawnChatThenSend();
      dispatchOpenChatThenSend();
      dispatchSendFixtureImage();
      dispatchCompositeChatLoadProbe();
      dispatchOpenChatWhileWsDown();
      dispatchRetryFailedSend();
      dispatchSendAgain();
      dispatchCopyChatSample();
    dispatchDisconnectAfterSend();
    dispatchSilentHalfOpen();
    dispatchFocusedLivenessProbe();
    dispatchOpenSettingsThenToggle();
      // Notifications L3 (public_behavior_spec).
      dispatchOpenUpdates();
      dispatchTabNavigation();
      dispatchAllChatsRegression();
      dispatchResolveNotification();
      // Agent-question L3 (public_behavior_spec).
      dispatchDismissQuestion();
      dispatchReportViewerE2e();
      dispatchRuntimeSentinel();
    });
  };
  Linking.getInitialURL()
    .then((url) => {
      try {
        applyHarnessURL(url);
        subscribeHarnessHydrationActions();
      } finally {
        harnessRuntime.markBootResolved();
      }
    })
    .catch(() => {
      harnessRuntime.markBootResolved();
    });
  Linking.addEventListener('url', (event) => {
    applyHarnessURL(event.url);
    subscribeHarnessHydrationActions();
  });
}

const DISABLE_LOCAL_AUTH_FOR_TESTING = process.env.EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK === '1';

const AppTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Colors.primary,
    background: Colors.background,
    card: Colors.surface,
    text: Colors.text,
    border: Colors.border,
  },
};

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    [Fonts.rajdhani.medium]: require('../assets/fonts/Rajdhani_500Medium.ttf'),
    [Fonts.rajdhani.semiBold]: require('../assets/fonts/Rajdhani_600SemiBold.ttf'),
    [Fonts.rajdhani.bold]: require('../assets/fonts/Rajdhani_700Bold.ttf'),
    [Fonts.jetBrainsMono.regular]: require('../assets/fonts/JetBrainsMono_400Regular.ttf'),
    [Fonts.jetBrainsMono.medium]: require('../assets/fonts/JetBrainsMono_500Medium.ttf'),
    [Fonts.jetBrainsMono.bold]: require('../assets/fonts/JetBrainsMono_700Bold.ttf'),
    [Fonts.cinzel.medium]: require('../assets/fonts/Cinzel_500Medium.ttf'),
    [Fonts.cinzel.semiBold]: require('../assets/fonts/Cinzel_600SemiBold.ttf'),
    [Fonts.cinzel.bold]: require('../assets/fonts/Cinzel_700Bold.ttf'),
    [Fonts.report.displayMedium]: require('@expo-google-fonts/space-grotesk/500Medium/SpaceGrotesk_500Medium.ttf'),
    [Fonts.report.displaySemiBold]: require('@expo-google-fonts/space-grotesk/600SemiBold/SpaceGrotesk_600SemiBold.ttf'),
    [Fonts.report.displayBold]: require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf'),
    [Fonts.report.bodyRegular]: require('@expo-google-fonts/ibm-plex-sans/400Regular/IBMPlexSans_400Regular.ttf'),
    [Fonts.report.bodyMedium]: require('@expo-google-fonts/ibm-plex-sans/500Medium/IBMPlexSans_500Medium.ttf'),
    [Fonts.report.bodyBold]: require('@expo-google-fonts/ibm-plex-sans/700Bold/IBMPlexSans_700Bold.ttf'),
  });
  const fontsReady = fontsLoaded || process.env.NODE_ENV === 'test';
  const navigatorRendered = fontsReady || process.env.EXPO_PUBLIC_HARNESS === '1';
  const { locked, authenticate } = useBiometricLock('Pentacle');
  usePushNotifications({ locked: !DISABLE_LOCAL_AUTH_FOR_TESTING && locked });

  // Check for OTA updates on launch and when app comes to foreground
  useEffect(() => {
    if (DISABLE_LOCAL_AUTH_FOR_TESTING) {
      return;
    }
    async function checkForUpdate() {
      if (__DEV__) return; // Skip in dev mode
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch (e) {
        // Silently fail — will retry next launch
      }
    }
    checkForUpdate();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkForUpdate();
    });
    return () => sub.remove();
  }, []);

  // Clear badge and dismiss notifications when app comes to foreground
  useEffect(() => {
    const clearBadge = () => {
      const Notifications = getNativeNotifications();
      // expo-notifications badge/dismiss APIs throw synchronously on web
      // (no native module). There is no app badge on web, so skip entirely —
      // otherwise the throw escapes this effect and redboxes every screen
      // under the react-native-web screenshot harness.
      if (Platform.OS === 'web' || !Notifications) return;
      Notifications.setBadgeCountAsync(0);
      Notifications.dismissAllNotificationsAsync();
    };
    clearBadge();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') clearBadge();
    });
    return () => sub.remove();
  }, []);

  // Signal the harness that the root navigator has mounted, so cold-launch
  // navigation-driving actions (gated on harnessRuntime.whenNavigationReady())
  // only push routes once expo-router can accept them. No-op outside harness.
  useEffect(() => {
    if (navigatorRendered && process.env.EXPO_PUBLIC_HARNESS === '1') {
      const hr = require('../src/utils/harnessRuntime') as typeof import('../src/utils/harnessRuntime');
      hr.markNavigationReady();
    }
  }, [navigatorRendered]);

  const lockScreen = (
    <View style={lockStyles.overlay}>
      <Text style={lockStyles.icon}>🔒</Text>
      <Text style={lockStyles.title}>Pentacle</Text>
      <TouchableOpacity style={lockStyles.button} onPress={authenticate}>
        <Text style={lockStyles.buttonText}>Unlock with Face ID</Text>
      </TouchableOpacity>
    </View>
  );

  if (!navigatorRendered) {
    return null;
  }

  return (
    <GestureHandlerRootView style={lockStyles.root}>
      <ThemeProvider value={AppTheme}>
        {!DISABLE_LOCAL_AUTH_FOR_TESTING && locked ? (
          lockScreen
        ) : (
          // headerShown:false MUST be the stack default. With the native-stack default
          // (headerShown:true), react-native-screens (v4) lays out header machinery that
          // renders a transparent native view over the nested bottom-tab bar's footprint,
          // swallowing every tab tap (UPDATES/SETTINGS/CHATS unresponsive). Defaulting the
          // header off and enabling it only where it's actually used (enroll) removes that
          // intercepting layer. See public_behavior_spec.
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="enroll"
              options={{
                headerShown: true,
                title: 'Enroll Device',
                headerStyle: { backgroundColor: Colors.surface },
                headerTintColor: Colors.text,
              }}
            />
            <Stack.Screen name="pentacle/session/[streamId]" options={{ headerShown: false }} />
          </Stack>
        )}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const lockStyles = StyleSheet.create({
  root: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: Colors.text,
    marginBottom: 32,
  },
  button: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

