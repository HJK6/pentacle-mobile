import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
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
  // Never retain native error messages or codes, which may include private data.
  error: 'token_read_failed' | null;
};

let snapshot: Snapshot = {
  token: null,
  wsUrl: '',
  isReady: false,
  error: null,
};

let loadPromise: Promise<void> | null = null;
let harnessLoadGeneration = 0;
let tokenReadBackgrounded = false;
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
          error: null,
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
          error: null,
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
          error: null,
        });
        return;
      }
    }
  }
  try {
    const tokenValue = await getPentacleDeviceToken(force);
    // An ancillary endpoint read must not discard a successfully read token.
    const storedWsUrl = await SecureStore.getItemAsync(WS_URL_KEY, WS_URL_STORE_OPTIONS).catch(() => null);
    if (harnessGeneration !== null && harnessGeneration !== harnessLoadGeneration) return;
    const wsUrl = harnessWsUrl || storedWsUrl?.trim() || defaultWsUrl;
    setPentacleAuthToken(tokenValue);
    setPentacleWsUrl(wsUrl);
    updateSnapshot({
      token: tokenValue,
      wsUrl: getPentacleWsUrl() as string,
      isReady: true,
      error: null,
    });
  } catch {
    if (harnessGeneration !== null && harnessGeneration !== harnessLoadGeneration) return;
    setPentacleAuthToken(null);
    setPentacleWsUrl(defaultOrHarnessWsUrl);
    updateSnapshot({
      token: null,
      wsUrl: getPentacleWsUrl() as string,
      isReady: true,
      error: 'token_read_failed',
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
    // The local biometric lock can unmount every token consumer in background.
    // Preserve that transition until a consumer mounts after the normal unlock.
    const foregroundRetry = AppState.currentState === 'active'
      && tokenReadBackgrounded && snapshot.error === 'token_read_failed';
    if (AppState.currentState === 'active') tokenReadBackgrounded = false;
    if (AppState.currentState === 'background') tokenReadBackgrounded = true;
    void ensureLoaded(foregroundRetry && !loadPromise);

    const foregroundSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') tokenReadBackgrounded = true;
      const foreground = nextState === 'active' && tokenReadBackgrounded;
      if (nextState === 'active') tokenReadBackgrounded = false;
      // Face ID inactivity is not a background return. Shared load ownership
      // also prevents multiple consumers from starting additional reads.
      if (foreground && snapshot.error === 'token_read_failed' && !loadPromise) {
        void ensureLoaded(true);
      }
    });

    return () => {
      listeners.delete(sync);
      foregroundSub.remove();
    };
  }, []);

  const reload = useCallback(async () => {
    await ensureLoaded(true);
  }, []);

  const setToken = useCallback(async (value: string) => {
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      if (tokenHarness?.shouldDisablePentacleAuth()) {
        setPentacleAuthToken(null);
        updateSnapshot({ token: tokenHarness.pentacleAuthDisabledToken(), isReady: true, error: null });
        return;
      }
    }
    await setPentacleDeviceToken(value);
    setPentacleAuthToken(value);
    updateSnapshot({ token: value, isReady: true, error: null });
  }, []);

  const clearToken = useCallback(async () => {
    if (process.env.EXPO_PUBLIC_HARNESS === '1') {
      if (tokenHarness?.shouldDisablePentacleAuth()) {
        setPentacleAuthToken(null);
        updateSnapshot({ token: tokenHarness.pentacleAuthDisabledToken(), isReady: true, error: null });
        return;
      }
    }
    await deletePentacleDeviceToken();
    setPentacleAuthToken(null);
    updateSnapshot({ token: null, isReady: true, error: null });
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
    error: state.error,
    reload,
    setToken,
    clearToken,
    setWsUrl,
  };
}
