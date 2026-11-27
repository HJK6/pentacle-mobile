import * as SecureStore from 'expo-secure-store';
import {
  deletePentacleDeviceToken,
  getPentacleDeviceToken,
  PENTACLE_DEVICE_TOKEN_DURABLE_KEY,
  PENTACLE_DEVICE_TOKEN_KEY,
  setPentacleDeviceToken,
} from '../../src/services/deviceCredentialStore';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const setItem = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;
const deleteItem = SecureStore.deleteItemAsync as jest.MockedFunction<typeof SecureStore.deleteItemAsync>;

// Stand-in keychain keyed by service so reads see what earlier writes stored.
let keychain: Record<string, string | undefined>;
beforeEach(() => {
  jest.resetAllMocks();
  keychain = {};
  getItem.mockImplementation(async (key) => keychain[key] ?? null);
  setItem.mockImplementation(async (key, value) => { keychain[key] = value; });
  deleteItem.mockImplementation(async (key) => { delete keychain[key]; });
});

test('shares one device credential read across stream and dashboard clients', async () => {
  keychain[PENTACLE_DEVICE_TOKEN_DURABLE_KEY] = 'device-token';
  await expect(getPentacleDeviceToken(true)).resolves.toBe('device-token');
  getItem.mockClear();
  await expect(getPentacleDeviceToken()).resolves.toBe('device-token');
  expect(getItem).not.toHaveBeenCalled();

  await getPentacleDeviceToken(true);
  expect(getItem).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, expect.any(Object));
  await setPentacleDeviceToken('rotated-token');
  await expect(getPentacleDeviceToken()).resolves.toBe('rotated-token');

  await deletePentacleDeviceToken();
  await expect(getPentacleDeviceToken()).resolves.toBeNull();
  expect(deleteItem).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, expect.any(Object));
  expect(deleteItem).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_KEY, expect.any(Object));
});

test('stores the credential without biometry binding and readable after first unlock', async () => {
  await setPentacleDeviceToken('new-token');
  expect(setItem).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_DURABLE_KEY, 'new-token', expect.objectContaining({
    keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    requireAuthentication: false,
  }));
  expect(keychain[PENTACLE_DEVICE_TOKEN_KEY]).toBeUndefined();
});

test('migrates a credential held only in the old biometry-bound item', async () => {
  keychain[PENTACLE_DEVICE_TOKEN_KEY] = 'old-token';
  await expect(getPentacleDeviceToken(true)).resolves.toBe('old-token');
  expect(keychain[PENTACLE_DEVICE_TOKEN_DURABLE_KEY]).toBe('old-token');
});

test('keeps a credential read from the old item when the migration write fails', async () => {
  keychain[PENTACLE_DEVICE_TOKEN_KEY] = 'old-token';
  setItem.mockRejectedValueOnce(new Error('write failed'));
  await expect(getPentacleDeviceToken(true)).resolves.toBe('old-token');
});

test('reads the durable copy even when the old item is unreadable', async () => {
  keychain[PENTACLE_DEVICE_TOKEN_DURABLE_KEY] = 'kept-token';
  getItem.mockImplementation(async (key) => {
    if (key === PENTACLE_DEVICE_TOKEN_KEY) throw new Error('invalidated');
    return keychain[key] ?? null;
  });
  await expect(getPentacleDeviceToken(true)).resolves.toBe('kept-token');
});

test('surfaces a failed old-item read instead of reporting no credential', async () => {
  getItem.mockImplementation(async (key) => {
    if (key === PENTACLE_DEVICE_TOKEN_KEY) throw new Error('auth cancelled');
    return null;
  });
  await expect(getPentacleDeviceToken(true)).rejects.toThrow('auth cancelled');
});
