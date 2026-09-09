import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const PENTACLE_DEVICE_TOKEN_KEY = 'pentacle-stream-token';

let cachedDeviceToken: string | null | undefined;
let pendingRead: Promise<string | null> | null = null;

function deviceTokenOptions(): SecureStore.SecureStoreOptions {
  return {
    keychainService: PENTACLE_DEVICE_TOKEN_KEY,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: process.env.EXPO_PUBLIC_HARNESS !== '1' && Platform.OS !== 'web',
  };
}

export function getPentacleDeviceToken(force = false) {
  if (!force && cachedDeviceToken !== undefined) return Promise.resolve(cachedDeviceToken);
  if (!force && pendingRead) return pendingRead;
  const read = SecureStore.getItemAsync(PENTACLE_DEVICE_TOKEN_KEY, deviceTokenOptions())
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
  await SecureStore.setItemAsync(PENTACLE_DEVICE_TOKEN_KEY, token, deviceTokenOptions());
  cachedDeviceToken = token;
}

export async function deletePentacleDeviceToken() {
  await SecureStore.deleteItemAsync(PENTACLE_DEVICE_TOKEN_KEY, deviceTokenOptions());
  cachedDeviceToken = null;
}
