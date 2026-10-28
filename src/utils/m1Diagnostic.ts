import { logTelemetry } from 'pentacle-chat-core';

/** Diagnostic-only metadata. Never pass user-entered text or credentials. */
export function m1Diagnostic(kind: string, data: Record<string, string | number | boolean | null | undefined>): void {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
  try {
    const runtime = require('./harnessRuntime') as typeof import('./harnessRuntime');
    if (!runtime.isArmed()) return;
    logTelemetry('harness:ui_trace' as Parameters<typeof logTelemetry>[0], {
      kind: `m1_diagnostic_${kind}`,
      timestamp_emitter_wall: Date.now(),
      timestamp_emitter_monotonic: globalThis.performance?.now?.() ?? null,
      ...data,
    });
  } catch { /* Diagnostics must not change the interaction. */ }
}
