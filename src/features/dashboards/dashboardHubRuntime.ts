import Constants from 'expo-constants';
import { getBackendWsUrl } from '../../config/local';
import { getPentacleDeviceToken, setPentacleDeviceToken } from '../../services/deviceCredentialStore';
import { getParam } from '../../utils/harnessRuntime';
import type { DashboardHubClientConfig } from './types';

export type DashboardHubRuntime = DashboardHubClientConfig & {
  controlUrl: string;
};

function extra(): Record<string, unknown> {
  return (Constants.expoConfig?.extra || {}) as Record<string, unknown>;
}

function asHubUrl(value: string) {
  return value.trim().replace(/\/$/, '');
}

function defaultHubUrl() {
  try {
    const backend = new URL(getBackendWsUrl());
    backend.port = '7781';
    backend.pathname = '';
    backend.search = '';
    backend.hash = '';
    return asHubUrl(backend.toString());
  } catch {
    return '';
  }
}

function harnessValue(name: string) {
  return process.env.EXPO_PUBLIC_HARNESS === '1' ? String(getParam(name) || '').trim() : '';
}

export async function loadDashboardHubRuntime(): Promise<DashboardHubRuntime> {
  const values = extra();
  const url = asHubUrl(harnessValue('dashboard_hub_url') || String(values.dashboardHubUrl || '') || defaultHubUrl());
  const deviceToken = harnessValue('dashboard_hub_device_token')
    || String(await getPentacleDeviceToken() || '').trim();
  const controlUrl = asHubUrl(
    harnessValue('dashboard_hub_control_url')
      || String(values.dashboardHubControlUrl || '')
      || url.replace(/^ws/, 'http'),
  );
  return { url, controlUrl, deviceToken };
}

export async function saveDashboardHubDeviceToken(deviceToken: string) {
  await setPentacleDeviceToken(deviceToken.trim());
}
