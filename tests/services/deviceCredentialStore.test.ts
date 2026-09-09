import * as SecureStore from 'expo-secure-store';
import {
  deletePentacleDeviceToken,
  getPentacleDeviceToken,
  PENTACLE_DEVICE_TOKEN_KEY,
  setPentacleDeviceToken,
} from '../../src/services/deviceCredentialStore';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

test('shares one authenticated device credential read across stream and dashboard clients', async () => {
  const getItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
  getItem.mockResolvedValue('device-token');
  await expect(getPentacleDeviceToken()).resolves.toBe('device-token');
  await expect(getPentacleDeviceToken()).resolves.toBe('device-token');
  expect(getItem).toHaveBeenCalledTimes(1);
  expect(getItem).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_KEY, expect.objectContaining({
    keychainService: PENTACLE_DEVICE_TOKEN_KEY,
    keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  }));

  await getPentacleDeviceToken(true);
  expect(getItem).toHaveBeenCalledTimes(2);
  await setPentacleDeviceToken('rotated-token');
  await expect(getPentacleDeviceToken()).resolves.toBe('rotated-token');
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_KEY, 'rotated-token', expect.any(Object));

  await deletePentacleDeviceToken();
  await expect(getPentacleDeviceToken()).resolves.toBeNull();
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(PENTACLE_DEVICE_TOKEN_KEY, expect.any(Object));
});
