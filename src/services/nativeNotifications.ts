type NativeNotifications = typeof import('expo-notifications');

let cached: NativeNotifications | undefined;

export function getNativeNotifications(): NativeNotifications | null {
  if (process.env.EXPO_PUBLIC_HARNESS === '1') return null;
  cached ??= require('expo-notifications') as NativeNotifications;
  return cached;
}
