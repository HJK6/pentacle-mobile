import { loadDashboardHubRuntime } from './dashboardHubRuntime';
import type { DashboardGateMutation, DashboardGateResult } from './types';

export const FORECLOSURE_GATE_CONTROL_PATH = '/control/batch-gate';

export async function mutateForeclosureGate(mutation: DashboardGateMutation): Promise<DashboardGateResult> {
  const runtime = await loadDashboardHubRuntime();
  if (!runtime.controlUrl || !runtime.deviceToken) {
    return { ok: false, error: 'Gate control is not enrolled on this device' };
  }
  try {
    const response = await fetch(`${runtime.controlUrl}${FORECLOSURE_GATE_CONTROL_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtime.deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        batch: mutation.batch,
        gate: mutation.gate,
        ...(mutation.setting ? { setting: mutation.setting } : {}),
      }),
    });
    const payload = await response.json().catch(() => ({})) as Partial<Extract<DashboardGateResult, { ok: true }>> & { error?: string };
    if (!response.ok || payload.ok !== true) {
      return { ok: false, error: payload.error || `Gate control failed (${response.status})` };
    }
    if (
      typeof payload.batch !== 'string'
      || (payload.gate !== 'open' && payload.gate !== 'closed')
      || typeof payload.setting !== 'string'
      || typeof payload.changed !== 'boolean'
      || typeof payload.device_id !== 'string'
      || typeof payload.updated_at !== 'string'
    ) return { ok: false, error: 'Gate control returned an invalid response' };
    return {
      ok: true,
      batch: payload.batch,
      gate: payload.gate,
      setting: payload.setting,
      changed: payload.changed,
      device_id: payload.device_id,
      updated_at: payload.updated_at,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Gate control unavailable' };
  }
}
