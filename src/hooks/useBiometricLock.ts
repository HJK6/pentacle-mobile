import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { logTelemetry } from 'pentacle-chat-core';
import { TELEMETRY_EVENTS } from 'pentacle-chat-core';
import * as harnessRuntime from '../utils/harnessRuntime';

const BIOMETRIC_DISABLED = process.env.EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK === '1';

// Module-level latch — survives StrictMode-style double-invocation of the
// mount effect that would otherwise emit the biometric prompt lifecycle
// twice on app cold start. The harness fast-path is synchronous and idempotent
// state-wise, but the duplicate telemetry breaks F1/F5/F8's `count=1`
// strict-cursor assertion on the biometric group. Cleared on AppState
// background→active transitions so foreground re-auth still emits.
let harnessMountLatch = false;

// True when this is a harness build whose launch URL armed `autoaccept_biometric`.
// The synthetic biometric lifecycle must fire in this mode regardless of
// EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK (harness builds set it to 1). Production
// builds never set EXPO_PUBLIC_HARNESS==='1', so this is always false there.
function harnessAutoAcceptArmed(): boolean {
  return (
    process.env.EXPO_PUBLIC_HARNESS === '1' &&
    harnessRuntime.isArmed() &&
    harnessRuntime.hasAction('autoaccept_biometric')
  );
}

export default function useBiometricLock(appName: string = 'Pentacle') {
  const [locked, setLocked] = useState(BIOMETRIC_DISABLED ? false : true);
  const appState = useRef(AppState.currentState);
  const authenticating = useRef(false);
  const biometricDisabled = BIOMETRIC_DISABLED;

  const authenticate = useCallback(async (trigger = 'manual') => {
    // Harness autoaccept fast-path — MUST run before the web/disabled/in-flight
    // early-return below. Harness builds set EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK=1
    // (so `biometricDisabled` is true), which used to short-circuit here and
    // shadow this block — leaving scenarios that assert the biometric lifecycle
    // (F1/F2/F3 spawn/open/settings, F5, F8, biometric_lock_resume) with no
    // `auth:biometric_prompt_scheduled` to match. Emit the canonical lifecycle
    // synthetically (harness:true); it never touches expo-local-authentication,
    // so no OS Face ID prompt fires on fresh installs. Production builds set
    // EXPO_PUBLIC_HARNESS!=='1', so this branch is inert there (unchanged UX).
    if (harnessAutoAcceptArmed()) {
      if (trigger === 'mount' && harnessMountLatch) {
        // RootLayout's mount effect can fire twice on cold start under
        // React 19 concurrent rendering; only emit the lifecycle once.
        setLocked(false);
        return;
      }
      if (trigger === 'mount') {
        harnessMountLatch = true;
      }
      logTelemetry(TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_SCHEDULED, {
        trigger,
        platform: Platform.OS,
        harness: true,
      });
      logTelemetry(TELEMETRY_EVENTS.HARNESS_AUTOACCEPT_BIOMETRIC_SCHEDULED, {
        trigger,
        platform: Platform.OS,
      });
      setLocked(false);
      logTelemetry(TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_RESOLVED, {
        trigger,
        outcome: 'success',
        platform: Platform.OS,
        harness: true,
      });
      return;
    }

    if (Platform.OS === 'web' || biometricDisabled || authenticating.current) {
      if (Platform.OS === 'web' || biometricDisabled) setLocked(false);
      logTelemetry(TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_RESOLVED, {
        trigger,
        outcome: Platform.OS === 'web'
          ? 'web_unsupported'
          : biometricDisabled
            ? 'disabled_by_env'
            : 'already_authenticating',
        platform: Platform.OS,
      });
      return;
    }

    authenticating.current = true;
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        setLocked(false);
        logTelemetry(TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_RESOLVED, {
          trigger,
          outcome: hasHardware ? 'not_enrolled' : 'hardware_unavailable',
          platform: Platform.OS,
          has_hardware: hasHardware,
          is_enrolled: isEnrolled,
        });
        return;
      }

      logTelemetry(TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_SCHEDULED, {
        trigger,
        platform: Platform.OS,
        has_hardware: hasHardware,
        is_enrolled: isEnrolled,
      });
      // (Harness bypass moved above hasHardwareAsync/isEnrolledAsync to
      // ensure NO expo-local-authentication API call fires on harness builds —
      // even info-only calls may surface as the "Pentacle wants to use Face ID"
      // OS permission prompt on first install, breaking unattended sweeps.)
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Unlock ${appName}`,
        fallbackLabel: 'Use Passcode',
        disableDeviceFallback: false,
      });

      if (result.success) {
        setLocked(false);
      }
      const failure = result.success ? {} : {
        warning: result.warning,
        error: result.error,
      };
      logTelemetry(TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_RESOLVED, {
        trigger,
        outcome: result.success ? 'success' : 'denied',
        platform: Platform.OS,
        ...failure,
      });
    } finally {
      authenticating.current = false;
    }
  }, [appName, biometricDisabled]);

  // Authenticate on mount
  useEffect(() => {
    authenticate('mount');
  }, [authenticate]);

  // Re-lock when app goes to background, re-authenticate on foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      // Ignore state changes while Face ID prompt is showing
      if (authenticating.current) {
        appState.current = nextState;
        return;
      }

      // On harness builds biometric is disabled by env, but when the launch URL
      // armed autoaccept_biometric the foreground re-auth lifecycle must still
      // fire so biometric_lock_resume (background→foreground) can assert it.
      const reauthEnabled = !biometricDisabled || harnessAutoAcceptArmed();
      if (reauthEnabled && appState.current === 'active' && nextState === 'background') {
        setLocked(true);
      }
      if (reauthEnabled && appState.current === 'background' && nextState === 'active') {
        harnessMountLatch = false;
        authenticate('foreground');
      }
      appState.current = nextState;
    });
    return () => sub.remove();
  }, [authenticate, biometricDisabled]);

  const authenticateManually = useCallback(() => authenticate('manual'), [authenticate]);

  return { locked, authenticate: authenticateManually };
}
