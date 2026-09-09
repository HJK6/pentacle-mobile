import { MOBILE_TELEMETRY_EVENTS, type MobileTelemetryEvent } from './mobileTelemetryEvents';

export function logMobileTabsTelemetry(
  message: MobileTelemetryEvent,
  data: Record<string, unknown> = {},
) {
  const subsystem = String(message).split(':', 1)[0] || 'tabs';
  const line = `[TELEMETRY] ${JSON.stringify({ subsystem, message, data })}`;
  const nativeLoggingHook = (globalThis as unknown as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook;
  if (typeof nativeLoggingHook === 'function') {
    nativeLoggingHook(line, 2);
  } else {
    console.log(line);
  }
}

type MobileTabName = 'unified' | 'chats' | 'dashboards' | 'updates' | 'settings';

export function logFocusedTab(tab: MobileTabName) {
  logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.TABS_SCREEN_FOCUSED, { tab });
}

// Tab-bar press, distinct from screen focus. Focus only fires when navigation
// succeeds; a press that never produces a focus (e.g. the native-stack overlay
// regression that this telemetry was added to surface) is otherwise invisible.
export function logTabPressed(tab: MobileTabName) {
  logMobileTabsTelemetry(MOBILE_TELEMETRY_EVENTS.TABS_TAB_PRESSED, { tab });
}

