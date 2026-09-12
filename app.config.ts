import type { ConfigContext, ExpoConfig } from 'expo/config';
import type { PentacleConfig } from './pentacle.config.example';

declare const require: (path: string) => unknown;

const APP_VERSION_BASE = '1.0.0';

function productionBuild(): boolean {
  return process.env.PENTACLE_PROD_BUILD === '1' || process.env.EAS_BUILD_PROFILE === 'production';
}

function requireString(value: unknown, path: string): string {
  const result = String(value || '').trim();
  if (!result) {
    throw new Error(`pentacle.config.local.ts must define ${path}.`);
  }
  return result;
}

function validateConfig(config: PentacleConfig): PentacleConfig {
  const suppliedApple = config.apple || {};
  const normalized = {
    ...config,
    apple: {
      ...suppliedApple,
      bundleId: suppliedApple.bundleId ?? 'com.example.pentacle',
      androidPackage: suppliedApple.androidPackage ?? 'com.example.pentacle',
    },
  } as PentacleConfig;
  requireString(normalized.backend?.wsUrl, 'backend.wsUrl');
  if (!normalized.hosts || typeof normalized.hosts !== 'object' || Array.isArray(normalized.hosts)) {
    throw new Error('pentacle.config.local.ts must define hosts.');
  }
  if (productionBuild()) {
    requireString(suppliedApple.bundleId, 'apple.bundleId');
    requireString(suppliedApple.androidPackage, 'apple.androidPackage');
  }
  return normalized;
}

export type VersionBumpLevel = 'major' | 'minor' | 'patch';

export function normalizeVersionBumpLevel(value: string | undefined): VersionBumpLevel {
  const normalized = String(value || 'minor').trim().toLowerCase();
  if (normalized === 'major' || normalized === 'minor' || normalized === 'patch') {
    return normalized;
  }
  throw new Error('PENTACLE_VERSION_BUMP must be "major", "minor", or "patch".');
}

export function computeBuildNumber(): string {
  const configured = String(process.env.PENTACLE_BUILD_NUMBER || '').trim();
  if (!configured) {
    if (productionBuild()) {
      throw new Error('PENTACLE_BUILD_NUMBER is required for a production build.');
    }
    return '1';
  }
  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw new Error('PENTACLE_BUILD_NUMBER must be a positive integer.');
  }
  return configured;
}

export function computeAppVersion(buildNumber: string, bumpLevel = normalizeVersionBumpLevel(process.env.PENTACLE_VERSION_BUMP)): string {
  const build = Number(buildNumber);
  if (!Number.isInteger(build) || build < 1) {
    throw new Error('Cannot compute an app version from an invalid build number.');
  }
  const [major, minor, patch] = APP_VERSION_BASE.split('.').map(Number);
  if (bumpLevel === 'major') return `${major + build - 1}.0.0`;
  if (bumpLevel === 'patch') return `${major}.${minor}.${patch + build - 1}`;
  return `${major}.${minor + build - 1}.0`;
}

function loadLocalConfig(): PentacleConfig {
  try {
    require('sucrase/register/ts');
    const loaded = require('./pentacle.config.local.ts') as PentacleConfig | { default?: PentacleConfig };
    return 'default' in loaded && loaded.default ? loaded.default : (loaded as PentacleConfig);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing readable pentacle.config.local.ts: ${detail}`);
  }
}

export function buildExpoExtra(config: PentacleConfig, wsUrl: string) {
  return {
    router: {},
    wsUrl,
    dashboardHubUrl: config.dashboardHub?.url,
    hosts: config.hosts,
    hostOrder: config.hostOrder || [],
    ...(config.features ? { features: config.features } : {}),
    eas: { projectId: config.apple.easProjectId },
  };
}

export default function defineConfig(_context: ConfigContext): ExpoConfig {
  const prodBuild = require('./scripts/prod-build.cjs') as {
    guardProductionExpoPublicEnv: (env: Record<string, string | undefined>, label?: string) => void;
    shouldRunProductionGuard: (env: Record<string, string | undefined>) => boolean;
  };
  if (prodBuild.shouldRunProductionGuard(process.env)) {
    prodBuild.guardProductionExpoPublicEnv(process.env, 'Expo config production profile');
  }
  const config = validateConfig(loadLocalConfig());
  const buildNumber = computeBuildNumber();
  const harnessBuild = process.env.EXPO_PUBLIC_HARNESS === '1';
  const effectiveWsUrl = process.env.EXPO_PUBLIC_PENTACLE_WS_URL || config.backend.wsUrl;
  return {
    name: harnessBuild ? 'Pentacle Harness' : 'Pentacle',
    slug: 'pentacle-mobile',
    version: computeAppVersion(buildNumber),
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'pentacle',
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    splash: {
      image: './assets/images/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0f0f23',
    },
    runtimeVersion: { policy: 'appVersion' },
    ios: {
      supportsTablet: true,
      bundleIdentifier: harnessBuild ? `${config.apple.bundleId}.harness` : config.apple.bundleId,
      buildNumber,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSFaceIDUsageDescription: 'Pentacle uses Face ID to secure access to live machine sessions.',
        NSCameraUsageDescription: 'Pentacle uses the camera so you can take a photo to attach to a chat message.',
        NSPhotoLibraryUsageDescription: 'Pentacle uses your photo library so you can attach photos to a chat message.',
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
          NSAllowsLocalNetworking: true,
          NSAllowsArbitraryLoadsInWebContent: true,
        },
      },
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      './plugins/withHermesBuildState',
      './plugins/withNativeCompilerPolicy',
      './plugins/withHarnessLaunchUrl',
      'expo-router',
      'expo-updates',
      ['expo-secure-store', { configureAndroidBackup: true }],
      ['expo-local-authentication', { faceIDPermission: 'Pentacle uses Face ID to secure access to live machine sessions.' }],
      ['expo-notifications', { icon: './assets/images/icon.png', color: '#2d7a61' }],
      ['expo-image-picker', {
        photosPermission: 'Pentacle uses your photo library so you can attach photos to a chat message.',
        cameraPermission: 'Pentacle uses the camera so you can take a photo to attach photos to a chat message.',
      }],
    ],
    extra: buildExpoExtra(config, effectiveWsUrl),
    experiments: { typedRoutes: true },
    android: {
      permissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ],
      package: config.apple.androidPackage,
    },
    owner: config.apple.expoOwner,
  };
}
