import * as harnessRuntime from '../utils/harnessRuntime';

export function shouldDisablePentacleAuth(): boolean {
  return harnessRuntime.isArmed() && harnessRuntime.hasAction('disable_pentacle_auth');
}

export function pentacleAuthDisabledToken(): string {
  return '__auth_disabled__';
}

export function getBakedHarnessToken(): string | null {
  const baked = process.env.EXPO_PUBLIC_HARNESS_TOKEN;
  return typeof baked === 'string' && baked.length > 0 ? baked : null;
}

export function getHarnessTokenParam(): string | null {
  if (!harnessRuntime.isArmed()) return null;
  const value = harnessRuntime.getParam('pentacle_token');
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/**
 * A daemon-issued device credential the harness installs at launch via the
 * simulator-only, env-gated `-PentacleDeviceToken` launch arg (AppDelegate
 * merges it into the harness URL as `install_device_token`). Unlike
 * `pentacle_token` (an in-memory auth override), this value is persisted
 * through `setPentacleDeviceToken` and then consumed by the normal
 * device-credential connection path — so an enrolled simulator authenticates
 * against the live daemon exactly like a real enrolled phone, and it takes
 * precedence over `disable_pentacle_auth`.
 */
export function getHarnessInstallDeviceToken(): string | null {
  if (!harnessRuntime.isArmed()) return null;
  const value = harnessRuntime.getParam('install_device_token');
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

export function getHarnessWsUrl(): string | null {
  if (!harnessRuntime.isArmed()) return null;
  const value = harnessRuntime.getParam('ws_url');
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}
