import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { getBackendWsUrl } from '../config/local';
import { getPentacleWsUrl, setPentacleAuthToken, setPentacleWsUrl } from '../services/pentacleStream';
import { deletePentacleDeviceToken, getPentacleDeviceToken, setPentacleDeviceToken } from '../services/deviceCredentialStore';

const WS_URL_KEY = 'pentacle-stream-ws-url';

let tokenHarness: typeof import('./usePentacleTokenHarness') | null = null;
if (process.env.EXPO_PUBLIC_HARNESS === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  tokenHarness = require('./usePentacleTokenHarness');
}

const WS_URL_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: WS_URL_KEY,
  requireAuthentication: false,
};

type Snapshot = {
  token: string | null;
  wsUrl: string;
  isReady: boolean;
};

let snapshot: Snapshot = {
  token: null,
  wsUrl: '',
  isReady: false,
};

let loadPromise: Promise<void> | null = null;
let harnessLoadGeneration = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function updateSnapshot(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  emit();
}

async function loadFromSecureStore(force = false, harnessGeneration: number | null = null) {
  const defaultWsUrl = getBackendWsUrl();
  const harnessWsUrl =
    process.env.EXPO_PUBLIC_HARNESS === '1' ? tokenHarness?.getHarnessWsUrl() : null;
  const defaultOrHarnessWsUrl = harnessWsUrl || defaultWsUrl;
  if (process.env.EXPO_PUBLIC_HARNESS === '1') {
    // A daemon-issued device credential installed via the -PentacleDeviceToken
    // launch arg is persisted and then consumed by the normal device-credential
    // path below, so an enrolled simulator authenticates against the live daemon
    // exactly like a real phone. It deliberately outranks disable_pentacle_auth:
    // a live-daemon run must present the real credential, not a null token.
    const installDeviceToken = tokenHarness?.getHarnessInstallDeviceToken?.();
    if (installDeviceToken) {
      await setPentacleDeviceToken(installDeviceToken);
      // fall through to the device-credential read below (no early return).
    } else {
      const harnessParamToken = tokenHarness?.getHarnessTokenParam();
      if (harnessParamToken) {
        setPentacleAuthToken(harnessParamToken);
        setPentacleWsUrl(defaultOrHarnessWsUrl);
        updateSnapshot({
          token: harnessParamToken,
          wsUrl: getPentacleWsUrl() as string,
          isReady: true,
        });
        return;
      }
      if (tokenHarness?.shouldDisablePentacleAuth()) {
        setPentacleAuthToken(null);
        setPentacleWsUrl(defaultOrHarnessWsUrl);
        updateSnapshot({
          token: tokenHarness.pentacleAuthDisabledToken(),
          wsUrl: getPentacleWsUrl() as string,
          isReady: true,
        });
        return;
      }
      const harnessToken = tokenHarness?.getBakedHarnessToken();
      if (harnessToken) {
        setPentacleAuthToken(harnessToken);
        setPentacleWsUrl(defaultOrHarnessWsUrl);
        updateSnapshot({
          token: harnessToken,
          wsUrl: getPentacleWsUrl() as string,
          isReady: true,
        });
        return;
      }
    }
  }
  try {
    const tokenValue = await getPentacleDeviceToken(force);
    const storedWsUrl = await SecureStore.getItemAsync(WS_URL_KEY, WS_URL_STORE_OPTIONS);
    if (harnessGeneration !== null && harnessGeneration !== harnessLoadGeneration) return;
    const wsUrl = harnessWsUrl || storedWsUrl?.trim() || defaultWsUrl;
    setPentacleAuthToken(tokenValue);
    setPentacleWsUrl(wsUrl);
    updateSnapshot({
      token: tokenValue,
      wsUrl: getPentacleWsUrl() as string,
      isReady: true,
    });
  } catch {
    if (harnessGeneration !== null && harnessGeneration !== harnessLoadGeneration) return;
    setPentacleAuthToken(null);
    setPentacleWsUrl(defaultOrHarnessWsUrl);
    updateSnapshot({
      token: null,
      wsUrl: getPentacleWsUrl() as string,
      isReady: true,
    });
  }
}

async function ensureLoaded(force = false) {
  if (!force && snapshot.isReady) {
    return;
  }
  if (!force && loadPromise) {
    return loadPromise;
  }
  const harnessGeneration = process.env.EXPO_PUBLIC_HARNESS === '1'
    ? ++harnessLoadGeneration
    : null;
  const pending = loadFromSecureStore(force, harnessGeneration);
  loadPromise = pending;
  return pending.finally(() => {
    if (loadPromise === pending) loadPromise = null;
  });
}

export function reloadPentacleToken() {
  return ensureLoaded(true);
}

export default function usePentacleToken() {
  const [state, setState] = useState(snapshot);

  useEffect(() => {
    const sync = () => setState(snapshot);
    listeners.add(sync);
    setState(snapshot);
    ensureLoaded();

    return () => {
      listeners.delete(sync);
    };
  }, []);

  const reload = useCallback(async () => {
    await ensureLoaded(true);
  }, []);

  const setToken = useCallback(async (value: string) => {
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      if (tokenHarness?.shouldDisablePentacleAuth()) {
        setPentacleAuthToken(null);
        updateSnapshot({ token: tokenHarness.pentacleAuthDisabledToken(), isReady: true });
        return;
      }
    }
    await setPentacleDeviceToken(value);
    setPentacleAuthToken(value);
    updateSnapshot({ token: value, isReady: true });
  }, []);

  const clearToken = useCallback(async () => {
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      if (tokenHarness?.shouldDisablePentacleAuth()) {
        setPentacleAuthToken(null);
        updateSnapshot({ token: tokenHarness.pentacleAuthDisabledToken(), isReady: true });
        return;
      }
    }
    await deletePentacleDeviceToken();
    setPentacleAuthToken(null);
    updateSnapshot({ token: null, isReady: true });
  }, []);

  const setWsUrl = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      const defaultWsUrl = getBackendWsUrl();
      await SecureStore.deleteItemAsync(WS_URL_KEY, WS_URL_STORE_OPTIONS);
      setPentacleWsUrl(defaultWsUrl);
      updateSnapshot({ wsUrl: getPentacleWsUrl() as string, isReady: true });
      return;
    }
    await SecureStore.setItemAsync(WS_URL_KEY, normalized, WS_URL_STORE_OPTIONS);
    setPentacleWsUrl(normalized);
    updateSnapshot({ wsUrl: normalized, isReady: true });
  }, []);

  return {
    token: state.token,
    wsUrl: state.wsUrl,
    isReady: state.isReady,
    reload,
    setToken,
    clearToken,
    setWsUrl,
  };
}
