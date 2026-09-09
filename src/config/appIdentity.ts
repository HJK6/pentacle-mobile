import Constants from 'expo-constants';

type RuntimeConstants = {
  nativeAppVersion?: string | null;
  nativeBuildVersion?: string | null;
  expoConfig?: {
    version?: string | null;
    ios?: { buildNumber?: string | number | null } | null;
    android?: { versionCode?: string | number | null } | null;
  } | null;
};

export type AppIdentity = {
  version: string;
  buildNumber: string;
};

function firstPresent(...values: Array<string | number | null | undefined>) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return 'unknown';
}

export function getAppIdentity(constants: RuntimeConstants = Constants): AppIdentity {
  return {
    version: firstPresent(constants.nativeAppVersion, constants.expoConfig?.version),
    buildNumber: firstPresent(
      constants.nativeBuildVersion,
      constants.expoConfig?.ios?.buildNumber,
      constants.expoConfig?.android?.versionCode,
    ),
  };
}
