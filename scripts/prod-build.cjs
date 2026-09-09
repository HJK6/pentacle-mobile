#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROD_EXPO_PUBLIC_ALLOWLIST = Object.freeze(['EXPO_PUBLIC_PENTACLE_WS_URL', 'EXPO_PUBLIC_PROJECT_ROOT']);
const PRODUCTION_ENDPOINT_ENV = 'EXPO_PUBLIC_PENTACLE_WS_URL';
const PRODUCTION_BUILD_EVIDENCE_FILENAME = 'pentacle-production-build-evidence.json';

const BASE_ENV_ALLOWLIST = Object.freeze([
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'APPLE_ID',
  'ASC_APP_ID',
  'CI',
  'DEVELOPER_DIR',
  'EAS_BUILD',
  'EAS_BUILD_PLATFORM',
  'EAS_BUILD_PROFILE',
  'EAS_BUILD_RUNNER',
  'EAS_LOCAL_BUILD_SKIP_CLEANUP',
  'EAS_LOCAL_BUILD_WORKINGDIR',
  'EAS_NO_VCS',
  'EAS_PROJECT_ROOT',
  'EAS_UPDATE_CHANNEL',
  'EXPO_NO_CACHE',
  'EXPO_TOKEN',
  'FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD',
  'FASTLANE_SESSION',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_ENV',
  'NODE_OPTIONS',
  'PATH',
  'PENTACLE_DEVICE_UDID',
  'PENTACLE_IOS_RELEASE_EXPORT_DIR',
  'PENTACLE_PROD_BUILD',
  'PENTACLE_VERSION_BUMP',
  'PWD',
  'RCT_NO_LAUNCH_PACKAGER',
  'SDKROOT',
  'SHELL',
  'SSH_AUTH_SOCK',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'XCODE_XCCONFIG_FILE',
]);

const BASE_ENV_PREFIX_ALLOWLIST = Object.freeze([
  'EAS_',
  'EXPO_APPLE_',
  'EXPO_ASC_',
  'EXPO_NO_',
  'FASTLANE_',
  'npm_config_',
  'npm_lifecycle_',
  'npm_node_execpath',
  'npm_package_',
]);

const PROD_TEST_FINGERPRINTS = Object.freeze([
  'EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK',
  'EXPO_PUBLIC_HARNESS',
  'EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX',
  'EXPO_PUBLIC_HARNESS_TOKEN',
  'EXPO_PUBLIC_SCREENSHOT_HARNESS',
  'EXPO_PUBLIC_SCREENSHOT_HARNESS_DEFAULT',
  'harness-fixture-token',
  // The simulator-enrollment credential-injection param. Its handling is
  // behind the EXPO_PUBLIC_HARNESS gate, so a prod bundle carrying this string
  // would prove the harness credential path leaked into production.
  'install_device_token',
]);

function isAllowedPublicEnvKey(key) {
  return PROD_EXPO_PUBLIC_ALLOWLIST.includes(key);
}

function findDisallowedExpoPublicEnv(env = process.env) {
  return Object.keys(env)
    .filter((key) => key.startsWith('EXPO_PUBLIC_') && !isAllowedPublicEnvKey(key))
    .sort();
}

function guardProductionExpoPublicEnv(env = process.env, label = 'production build') {
  const disallowed = findDisallowedExpoPublicEnv(env);
  if (disallowed.length) {
    throw new Error(
      `[prod-env-guard] Refusing ${label}: non-allowlisted Expo public env present: ${disallowed.join(', ')}`,
    );
  }
}

function endpointSourceLabel(source) {
  return source && source.name ? source.name : 'control-plane configuration';
}

function productionEndpointError(source, reason) {
  return new Error(
    `[prod-endpoint-guard] Invalid production endpoint from ${endpointSourceLabel(source)}: ${reason}`,
  );
}

function ipv4Bytes(hostname) {
  if (net.isIP(hostname) !== 4) return null;
  const parts = hostname.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function ipv6Bytes(hostname) {
  if (net.isIP(hostname) !== 6) return null;
  let value = hostname.toLowerCase();
  const lastColon = value.lastIndexOf(':');
  const embeddedIpv4 = value.slice(lastColon + 1);
  if (embeddedIpv4.includes('.') && net.isIP(embeddedIpv4) === 4) {
    const bytes = ipv4Bytes(embeddedIpv4);
    value = `${value.slice(0, lastColon + 1)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const validPart = (part) => /^[0-9a-f]{1,4}$/.test(part);
  if (!left.every(validPart) || !right.every(validPart)) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    .map((part) => Number.parseInt(part, 16))
    .flatMap((part) => [(part >> 8) & 0xff, part & 0xff]);
}

function isTestNetIpv4(bytes) {
  return (bytes[0] === 192 && bytes[1] === 0 && bytes[2] === 2)
    || (bytes[0] === 198 && bytes[1] === 51 && bytes[2] === 100)
    || (bytes[0] === 203 && bytes[1] === 0 && bytes[2] === 113);
}

function isLoopbackOrUnspecifiedHost(hostname, ipv4, ipv6) {
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return 'loopback hostname';
  if (ipv4) {
    if (ipv4[0] === 127) return 'loopback address';
    if (ipv4.every((part) => part === 0)) return 'unspecified address';
    if (isTestNetIpv4(ipv4)) return 'TEST-NET address';
  }
  if (ipv6) {
    if (ipv6.slice(0, 15).every((part) => part === 0) && ipv6[15] === 1) return 'loopback address';
    if (ipv6.every((part) => part === 0)) return 'unspecified address';
    const mappedIpv4 = ipv6.slice(0, 10).every((part) => part === 0)
      && ipv6[10] === 255
      && ipv6[11] === 255
      ? ipv6.slice(12)
      : null;
    if (mappedIpv4 && mappedIpv4[0] === 127) return 'loopback address';
    if (mappedIpv4 && isTestNetIpv4(mappedIpv4)) return 'TEST-NET address';
    if (ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x0d && ipv6[3] === 0xb8) {
      return 'TEST-NET documentation address';
    }
  }
  return null;
}

function isReservedExampleHostname(hostname) {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  const labels = normalized.split('.');
  return labels.some((label) => label === 'example' || label === 'invalid' || label === 'test')
    || normalized === 'localhost'
    || normalized.endsWith('.localhost');
}

function validateProductionEndpoint(value, source = { kind: 'unknown', name: 'control-plane configuration' }) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) throw productionEndpointError(source, 'value is missing');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw productionEndpointError(source, 'value is not a valid URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw productionEndpointError(source, 'scheme must be ws or wss');
  }
  if (!parsed.hostname) throw productionEndpointError(source, 'hostname is missing');
  if (parsed.username || parsed.password) {
    throw productionEndpointError(source, 'credentials are not allowed');
  }
  if (parsed.hash) throw productionEndpointError(source, 'fragments are not allowed');
  if (parsed.port === '0') throw productionEndpointError(source, 'port 0 is not a production endpoint');

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = ipv4Bytes(hostname);
  const ipv6 = ipv6Bytes(hostname);
  const addressReason = isLoopbackOrUnspecifiedHost(hostname, ipv4, ipv6);
  if (addressReason) throw productionEndpointError(source, addressReason);
  if (!ipv4 && !ipv6 && isReservedExampleHostname(hostname)) {
    throw productionEndpointError(source, 'example/reserved hostname is not production-valid');
  }

  return {
    endpoint: raw,
    sanitizedEndpoint: `${parsed.protocol}//${parsed.host}`,
    endpointSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    source: { kind: source.kind, name: source.name },
  };
}

function readLocalPentacleConfig(projectRoot = process.cwd()) {
  const configPath = path.resolve(projectRoot, 'pentacle.config.local.ts');
  try {
    require('sucrase/register/ts');
    const moduleValue = require(configPath);
    return moduleValue && moduleValue.default ? moduleValue.default : moduleValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[prod-endpoint-guard] Unable to load pentacle.config.local.ts: ${detail}`);
  }
}

function resolveProductionEndpoint(options = {}) {
  const env = options.env || process.env;
  const projectRoot = options.cwd || process.cwd();
  const envValue = env[PRODUCTION_ENDPOINT_ENV];
  if (envValue !== undefined && envValue !== '') {
    return validateProductionEndpoint(envValue, {
      kind: 'environment',
      name: PRODUCTION_ENDPOINT_ENV,
    });
  }

  const readConfig = options.readConfig || readLocalPentacleConfig;
  const config = readConfig(projectRoot);
  return validateProductionEndpoint(config && config.backend && config.backend.wsUrl, {
    kind: 'local-config',
    name: 'pentacle.config.local.ts:backend.wsUrl',
  });
}

function shouldRunProductionGuard(env = process.env) {
  return env.PENTACLE_PROD_BUILD === '1' || env.EAS_BUILD_PROFILE === 'production';
}

function isAllowedBaseEnvKey(key) {
  return BASE_ENV_ALLOWLIST.includes(key) || BASE_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix));
}

function buildCleanProductionEnv(env = process.env, overrides = {}) {
  guardProductionExpoPublicEnv(env);
  const clean = {};
  for (const key of Object.keys(env).sort()) {
    if (isAllowedBaseEnvKey(key) || isAllowedPublicEnvKey(key)) {
      clean[key] = env[key];
    }
  }
  return {
    ...clean,
    EXPO_NO_CACHE: '1',
    LANG: clean.LANG || 'en_US.UTF-8',
    LC_ALL: clean.LC_ALL || 'en_US.UTF-8',
    PENTACLE_PROD_BUILD: '1',
    ...overrides,
  };
}

function findBundleArtifacts(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];
  const results = [];
  const stack = [targetPath];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (/\.(bundle|hbc|jsbundle|js|map)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function verifyProdBundleFingerprints(targetPaths, fingerprints = PROD_TEST_FINGERPRINTS) {
  const files = targetPaths.flatMap(findBundleArtifacts);
  if (!files.length) {
    throw new Error(`[prod-env-guard] No JS/Hermes bundle artifacts found under: ${targetPaths.join(', ')}`);
  }
  const hits = [];
  for (const file of files) {
    const data = fs.readFileSync(file);
    for (const fingerprint of fingerprints) {
      if (data.includes(Buffer.from(fingerprint))) {
        hits.push(`${file}: ${fingerprint}`);
      }
    }
  }
  if (hits.length) {
    throw new Error(`[prod-env-guard] Production bundle contains test-flag fingerprints:\n${hits.join('\n')}`);
  }
  return files;
}

function verifyProdBundleEndpoint(targetPaths, endpoint) {
  const files = targetPaths.flatMap(findBundleArtifacts);
  if (!files.length) {
    throw new Error(`[prod-endpoint-guard] No JS/Hermes bundle artifacts found under: ${targetPaths.join(', ')}`);
  }
  const needle = Buffer.from(String(endpoint));
  const matches = files.filter((file) => fs.readFileSync(file).includes(needle));
  if (!matches.length) {
    let sanitized = '<unavailable>';
    try {
      sanitized = validateProductionEndpoint(endpoint).sanitizedEndpoint;
    } catch (error) {
      // The source preflight reports invalid values; keep this post-build error free of raw config.
    }
    throw new Error(
      `[prod-endpoint-guard] Baked control-plane endpoint does not match the preflight endpoint (${sanitized})`,
    );
  }
  return files;
}

function writeProductionBuildEvidence(evidencePath, resolvedEndpoint, bundleFiles) {
  const evidence = {
    schema_version: 1,
    sanitized_endpoint: resolvedEndpoint.sanitizedEndpoint,
    endpoint_sha256: resolvedEndpoint.endpointSha256,
    config_source: {
      kind: resolvedEndpoint.source.kind,
      name: resolvedEndpoint.source.name,
    },
    bundle: {
      endpoint_match: true,
      artifact_count: bundleFiles.length,
    },
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

function runCommand(argv, options = {}) {
  if (!argv.length) throw new Error('[prod-env-guard] Missing command to run');
  const sourceEnv = options.processEnv || process.env;
  guardProductionExpoPublicEnv(sourceEnv, options.label || 'production build');
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd || process.cwd(),
    env: buildCleanProductionEnv(sourceEnv, options.env),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

function exportAndVerifyIosBundle(label, options = {}) {
  const sourceEnv = options.processEnv || process.env;
  const projectRoot = options.cwd || process.cwd();
  const resolvedEndpoint = options.resolvedEndpoint || resolveProductionEndpoint({
    env: sourceEnv,
    cwd: projectRoot,
    readConfig: options.readConfig,
  });
  const command = options.runCommand || runCommand;
  const exportDir = options.exportDir
    || sourceEnv.PENTACLE_IOS_RELEASE_EXPORT_DIR
    || path.join(os.tmpdir(), 'pentacle-mobile-prod-ios-export');
  fs.rmSync(exportDir, { force: true, recursive: true });
  const commandEnv = { [PRODUCTION_ENDPOINT_ENV]: resolvedEndpoint.endpoint };
  const status = command(['expo', 'export', '--platform', 'ios', '--output-dir', exportDir], {
    label,
    cwd: projectRoot,
    processEnv: sourceEnv,
    env: commandEnv,
  });
  if (status !== 0) return status;
  const bundleFiles = verifyProdBundleFingerprints([exportDir]);
  verifyProdBundleEndpoint([exportDir], resolvedEndpoint.endpoint);
  writeProductionBuildEvidence(
    path.join(exportDir, PRODUCTION_BUILD_EVIDENCE_FILENAME),
    resolvedEndpoint,
    bundleFiles,
  );
  return 0;
}

function runIosRelease(options = {}) {
  const sourceEnv = options.env || process.env;
  const projectRoot = options.cwd || process.cwd();
  const resolvedEndpoint = resolveProductionEndpoint({
    env: sourceEnv,
    cwd: projectRoot,
    readConfig: options.readConfig,
  });
  const exportStatus = exportAndVerifyIosBundle('ios:release', {
    ...options,
    processEnv: sourceEnv,
    cwd: projectRoot,
    resolvedEndpoint,
  });
  if (exportStatus !== 0) return exportStatus;
  const command = options.runCommand || runCommand;
  return command(['expo', 'run:ios', '--configuration', 'Release'], {
    label: 'ios:release native build',
    cwd: projectRoot,
    processEnv: sourceEnv,
    env: { [PRODUCTION_ENDPOINT_ENV]: resolvedEndpoint.endpoint },
  });
}

function runIosDevice(options = {}) {
  const sourceEnv = options.env || process.env;
  const projectRoot = options.cwd || process.cwd();
  const resolvedEndpoint = resolveProductionEndpoint({
    env: sourceEnv,
    cwd: projectRoot,
    readConfig: options.readConfig,
  });
  const exportStatus = exportAndVerifyIosBundle('ios:device', {
    ...options,
    processEnv: sourceEnv,
    cwd: projectRoot,
    resolvedEndpoint,
  });
  if (exportStatus !== 0) return exportStatus;
  const argv = ['expo', 'run:ios', '--configuration', 'Release'];
  if (sourceEnv.PENTACLE_DEVICE_UDID) argv.push('--device', sourceEnv.PENTACLE_DEVICE_UDID);
  const command = options.runCommand || runCommand;
  return command(argv, {
    label: 'ios:device',
    cwd: projectRoot,
    processEnv: sourceEnv,
    env: { [PRODUCTION_ENDPOINT_ENV]: resolvedEndpoint.endpoint },
  });
}

function main(argv) {
  const command = argv[2];
  if (command === 'run-ios-release') return runIosRelease();
  if (command === 'run-ios-device') return runIosDevice();
  if (command === 'verify-fingerprints') {
    verifyProdBundleFingerprints(argv.slice(3));
    return 0;
  }
  if (command === 'guard') {
    guardProductionExpoPublicEnv(process.env);
    return 0;
  }
  if (command === 'run') {
    return runCommand(argv.slice(3));
  }
  throw new Error(`[prod-env-guard] Unknown command: ${command || '<missing>'}`);
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  BASE_ENV_ALLOWLIST,
  BASE_ENV_PREFIX_ALLOWLIST,
  PROD_EXPO_PUBLIC_ALLOWLIST,
  PROD_TEST_FINGERPRINTS,
  buildCleanProductionEnv,
  findBundleArtifacts,
  findDisallowedExpoPublicEnv,
  guardProductionExpoPublicEnv,
  readLocalPentacleConfig,
  resolveProductionEndpoint,
  shouldRunProductionGuard,
  validateProductionEndpoint,
  verifyProdBundleEndpoint,
  verifyProdBundleFingerprints,
  writeProductionBuildEvidence,
  runIosDevice,
  runIosRelease,
};
