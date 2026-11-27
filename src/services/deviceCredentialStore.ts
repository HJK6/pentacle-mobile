import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const PENTACLE_DEVICE_TOKEN_KEY = 'pentacle-stream-token';
// Durable copy: no biometry binding, so a Face ID set change cannot invalidate it, and readable after
// first unlock so a background launch does not fail while the phone is locked.
export const PENTACLE_DEVICE_TOKEN_DURABLE_KEY = 'pentacle-stream-token-durable';

let cachedDeviceToken: string | null | undefined;
let pendingRead: Promise<string | null> | null = null;

function durableOptions(): SecureStore.SecureStoreOptions {
  return {
    keychainService: PENTACLE_DEVICE_TOKEN_DURABLE_KEY,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
}

// The pre-heal item is biometry-bound (Face ID), so it is only read to migrate and to clean up.
function legacyOptions(): SecureStore.SecureStoreOptions {
  return {
    keychainService: PENTACLE_DEVICE_TOKEN_KEY,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: process.env.EXPO_PUBLIC_HARNESS !== '1' && Platform.OS !== 'web',
  };
}

async function readDeviceToken(): Promise<string | null> {
  let durableError: unknown = null;
  const durable = await SecureStore.getItemAsync(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, durableOptions())
    .catch((error) => { durableError = error; return null; });
  if (durable) return durable;
  const legacy = await SecureStore.getItemAsync(PENTACLE_DEVICE_TOKEN_KEY, legacyOptions());
  if (legacy) {
    // Migration is best effort: a failed write must not discard a credential that was just read.
    const migrated = await SecureStore.setItemAsync(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, legacy, durableOptions())
      .then(() => true, () => false);
    if (migrated) await SecureStore.deleteItemAsync(PENTACLE_DEVICE_TOKEN_KEY, legacyOptions()).catch(() => undefined);
    return legacy;
  }
  // A failed durable read is not "no credential": surface it so it is retried and never cached as null.
  if (durableError) throw durableError;
  return null;
}

export function getPentacleDeviceToken(force = false) {
  if (!force && cachedDeviceToken !== undefined) return Promise.resolve(cachedDeviceToken);
  if (!force && pendingRead) return pendingRead;
  const read = readDeviceToken()
    .then((token) => {
      cachedDeviceToken = token;
      return token;
    })
    .finally(() => {
      if (pendingRead === read) pendingRead = null;
    });
  pendingRead = read;
  return read;
}

export async function setPentacleDeviceToken(token: string) {
  await SecureStore.setItemAsync(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, token, durableOptions());
  cachedDeviceToken = token;
  await SecureStore.deleteItemAsync(PENTACLE_DEVICE_TOKEN_KEY, legacyOptions()).catch(() => undefined);
}

export async function deletePentacleDeviceToken() {
  await SecureStore.deleteItemAsync(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, durableOptions());
  await SecureStore.deleteItemAsync(PENTACLE_DEVICE_TOKEN_KEY, legacyOptions()).catch(() => undefined);
  cachedDeviceToken = null;
}
