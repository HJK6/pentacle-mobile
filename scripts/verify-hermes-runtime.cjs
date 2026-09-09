#!/usr/bin/env node
'use strict';

// Fail-closed guard against shipping the wrong-configuration Hermes engine.
//
// RN's replace_hermes_version.js selects the Debug or Release Hermes engine at
// build time and caches its choice in Pods/.last_build_configuration. If that
// marker goes stale (a `pod install` resets Pods/hermes-engine to the Debug
// default while the marker still records "Release"), a Release build silently
// embeds the DEBUG engine, which crashes on device (EXC_BAD_ACCESS in
// HermesRuntimeImpl on the first JS task). This phase re-verifies, after the
// swap, that the engine currently in Pods matches the per-configuration artifact
// tarball, and fails the build on any mismatch or missing input.
//
// Runs as a Pods build phase (PODS_ROOT / CONFIGURATION provided by Xcode) and
// is also runnable standalone for tests (pass configuration as argv[2] and set
// PODS_ROOT, or run from the repo root with ios/Pods present).

const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const crypto = require('crypto');

const configuration = String(process.argv[2] || process.env.CONFIGURATION || '').replace(/-.*/, '');
if (!['Debug', 'Release'].includes(configuration)) {
  throw new Error(`Unsupported Hermes configuration: ${JSON.stringify(configuration)}`);
}

// Resolve Pods root: Xcode build phases export PODS_ROOT; fall back to
// SRCROOT/Pods (SRCROOT is the ios/ dir) or <repo>/ios/Pods for standalone runs.
const podsRoot =
  process.env.PODS_ROOT ||
  (process.env.SRCROOT ? path.join(process.env.SRCROOT, 'Pods') : path.resolve(__dirname, '..', 'ios', 'Pods'));

const platform = String(process.env.PLATFORM_NAME || process.argv[3] || '');
const slices = {
  iphoneos: 'ios-arm64',
  iphonesimulator: 'ios-arm64_x86_64-simulator',
};
const sliceName = slices[platform];
if (!sliceName) {
  throw new Error(`Unsupported Hermes platform: ${JSON.stringify(platform)}`);
}
const SLICE = `destroot/Library/Frameworks/universal/hermes.xcframework/${sliceName}/hermes.framework/hermes`;
const current = path.join(podsRoot, 'hermes-engine', SLICE);

// The per-configuration artifact tarballs live in Pods/hermes-engine-artifacts.
// Discover the version from the artifact filename so this is not pinned to a
// single RN release.
const artifactsDir = path.join(podsRoot, 'hermes-engine-artifacts');
function findTarball(config) {
  let entries = [];
  try {
    entries = fs.readdirSync(artifactsDir);
  } catch {
    return null;
  }
  const re = new RegExp(`^hermes-ios-.*-${config.toLowerCase()}\\.tar\\.gz$`);
  const match = entries.find((name) => re.test(name));
  return match ? path.join(artifactsDir, match) : null;
}
const tarball = findTarball(configuration);

if (!fs.existsSync(current) || !tarball || !fs.existsSync(tarball)) {
  throw new Error(
    `Hermes identity inputs missing: current=${current} (exists=${fs.existsSync(current)}), ` +
      `tarball=${tarball || `${artifactsDir}/hermes-ios-*-${configuration.toLowerCase()}.tar.gz`} ` +
      `(exists=${tarball ? fs.existsSync(tarball) : false})`,
  );
}

// Extract the same slice from the config's tarball (member path is prefixed with
// "./" inside the archive; bsdtar matches it without the prefix).
// maxBuffer must exceed the engine binary size (~5-7 MB); the default 1 MB
// throws ENOBUFS.
const expected = cp.execFileSync('tar', ['-xOzf', tarball, SLICE], { maxBuffer: 256 * 1024 * 1024 });
const actual = fs.readFileSync(current);
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (hash(actual) !== hash(expected)) {
  throw new Error(
    `Hermes ${configuration} runtime mismatch: embedded ${hash(actual)} (${actual.length} bytes) ` +
      `!= ${configuration} artifact ${hash(expected)} (${expected.length} bytes). ` +
      `A ${configuration} build is carrying the wrong-configuration Hermes engine ` +
      `(stale Pods/.last_build_configuration marker).`,
  );
}
console.log(`Hermes ${configuration} runtime identity OK (${hash(actual)}, ${actual.length} bytes)`);
