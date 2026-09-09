import { getAppIdentity } from '../src/config/appIdentity';

test('uses native app metadata when available', () => {
  expect(getAppIdentity({
    nativeAppVersion: '2.1.0',
    nativeBuildVersion: '391',
    expoConfig: { version: '2.0.0', ios: { buildNumber: '390' } },
  })).toEqual({ version: '2.1.0', buildNumber: '391' });
});

test('falls back to Expo config metadata', () => {
  expect(getAppIdentity({
    expoConfig: { version: '2.2.0', ios: { buildNumber: 392 } },
  })).toEqual({ version: '2.2.0', buildNumber: '392' });
});

test('falls back to Android version code when native build is absent', () => {
  expect(getAppIdentity({
    expoConfig: { version: '2.3.0', android: { versionCode: 393 } },
  })).toEqual({ version: '2.3.0', buildNumber: '393' });
});
