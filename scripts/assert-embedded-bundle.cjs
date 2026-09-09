#!/usr/bin/env node
// Fails loudly when an embedded-bundle simulator build did not actually embed main.jsbundle.
//
// Why this exists (the embedded-bundle build contract): a Debug harness
// build that skips bundling still succeeds — the breakage only shows up later as a red screen
// ("No script URL provided") when a scenario launches the app, which reads as a harness/app fault
// rather than a build fault. A stale bundle can otherwise be difficult to diagnose. A build that cannot arm should fail
// at build time.
//
// The product path is resolved from `xcodebuild -showBuildSettings` for the SAME argument vector
// that built it — never by globbing DerivedData, which accumulates stale mobile-app-* directories
// and has previously caused a stale .app to be installed and misdiagnosed as a code defect.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`assert-embedded-bundle: ${message}\n`);
  process.exit(1);
}

// --min-mtime <epochSeconds> is REQUIRED and is what makes this a per-build proof. Existence
// alone is not: an incremental build that skips bundling leaves the PREVIOUS main.jsbundle in
// place inside the product, so an existence check passes while nothing was bundled. Automated
// checks cover this false-pass case. The caller stamps the time before invoking xcodebuild.
const argv = process.argv.slice(2);
let minMtimeRaw = null;
const passthrough = [];
let minMtimeCount = 0;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--min-mtime') {
    minMtimeRaw = argv[i + 1];
    minMtimeCount += 1;
    i += 1;
    continue;
  }
  passthrough.push(argv[i]);
}
// Last-wins would let a caller pass a future stamp followed by a permissive one — or simply
// double a flag by accident — and quietly choose the weaker threshold. There is exactly one
// pre-build stamp, so accept exactly one.
if (minMtimeCount > 1) fail(`--min-mtime given ${minMtimeCount} times; pass exactly one pre-build stamp`);
if (passthrough.length === 0) fail('expected the xcodebuild argument vector that produced the build');
// Validate strictly. `Number('')` is 0 and `Number(' ')` is 0, so a shell that expanded an unset
// T0 into an empty argument would otherwise hand us a threshold of 0 — which every bundle on disk
// satisfies, silently turning the freshness proof back into the existence check it replaced.
const minMtimeSeconds = /^[0-9]+$/.test(String(minMtimeRaw ?? '').trim())
  ? Number(String(minMtimeRaw).trim())
  : NaN;
if (!Number.isFinite(minMtimeSeconds) || minMtimeSeconds <= 0) {
  fail('--min-mtime <epochSeconds> is required and must be a positive integer epoch, got '
    + `${JSON.stringify(minMtimeRaw)}: capture it BEFORE the build (T0=$(date +%s)) so a stale `
    + 'bundle left by a skipped bundling phase cannot satisfy this check');
}

const settings = spawnSync('xcodebuild', [...passthrough, '-showBuildSettings', '-json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (settings.status !== 0) {
  fail(`xcodebuild -showBuildSettings exited ${settings.status}: ${String(settings.stderr).trim().slice(0, 400)}`);
}

let parsed;
try {
  parsed = JSON.parse(settings.stdout);
} catch (error) {
  fail(`could not parse -showBuildSettings JSON: ${error.message}`);
}

// Select the .app product explicitly, and refuse ambiguity — taking "the first entry with a
// TARGET_BUILD_DIR" can inspect a Pods or extension target in a multi-target result.
const appTargets = (Array.isArray(parsed) ? parsed : []).filter((entry) => {
  const settings = entry?.buildSettings;
  if (!settings?.TARGET_BUILD_DIR || !settings.FULL_PRODUCT_NAME) return false;
  return String(settings.FULL_PRODUCT_NAME).endsWith('.app');
});
if (appTargets.length === 0) fail('-showBuildSettings returned no .app product target');
if (appTargets.length > 1) {
  const names = appTargets.map((entry) => entry.target || entry.buildSettings.FULL_PRODUCT_NAME);
  fail(`-showBuildSettings returned ${appTargets.length} .app targets (${names.join(', ')}); `
    + 'narrow the argument vector so exactly one product is inspected');
}
const target = appTargets[0];

const { TARGET_BUILD_DIR: buildDir, FULL_PRODUCT_NAME: productName } = target.buildSettings;

const appPath = path.join(buildDir, productName);
// lstat the wrapper too: a symlinked `.app` pointing at some other app directory would let every
// check below inspect a bundle this build never produced, which is the same embedded-vs-reference
// hole as a symlinked main.jsbundle one level down.
const appStat = fs.lstatSync(appPath, { throwIfNoEntry: false });
if (!appStat) fail(`built product is missing: ${appPath}`);
if (appStat.isSymbolicLink()) fail(`built product is a symlink, not a built bundle: ${appPath}`);
if (!appStat.isDirectory()) fail(`built product is not a bundle directory: ${appPath}`);

// A real RN bundle for this app is multiple megabytes; anything under this is not a JS bundle,
// it is a placeholder, a truncated write, or a stray file. Existence and "size > 0" both passed
// a tiny file, which is exactly the kind of false green this guard exists to prevent.
const MIN_PLAUSIBLE_BUNDLE_BYTES = 512 * 1024;

const bundlePath = path.join(appPath, 'main.jsbundle');
// lstat, not existsSync: existsSync follows symlinks, so a symlink pointing at any large file
// outside the product would satisfy every check below while the product embeds nothing.
const bundleStat = fs.lstatSync(bundlePath, { throwIfNoEntry: false });
if (bundleStat && !bundleStat.isFile()) {
  fail(`main.jsbundle is not a regular file (${bundleStat.isSymbolicLink() ? 'symlink' : 'directory or special file'}): `
    + `${bundlePath} — the product must embed the bundle itself, not a reference to one.`);
}
if (!bundleStat) {
  fail(
    `${productName} contains no main.jsbundle — the bundling phase was skipped, so this app will `
    + 'red-screen with "No script URL provided" instead of arming.\n'
    + '  Most likely cause: EXAMPLE_E2E_EMBEDDED_DEBUG did not reach the Xcode script phase.\n'
    + '  Xcode exports BUILD SETTINGS to script phases, not the calling shell\'s environment, so\n'
    + '  the flag must be passed as an xcodebuild argument (EXAMPLE_E2E_EMBEDDED_DEBUG=1), not\n'
    + '  only exported in the surrounding shell.\n'
    + `  Product: ${appPath}`,
  );
}

const { size, mtimeMs } = bundleStat;
if (size < MIN_PLAUSIBLE_BUNDLE_BYTES) {
  fail(`main.jsbundle is implausibly small (${size} bytes, expected at least ${MIN_PLAUSIBLE_BUNDLE_BYTES}): `
    + `${bundlePath} — this is not a built JS bundle.`);
}

// No slack. `date +%s` floors to the second, so a bundle written by THIS build always has
// mtimeMs >= minMtimeSeconds * 1000; any subtraction here is a fail-open window that lets a
// bundle from the previous build satisfy the freshness proof.
const minMtimeMs = minMtimeSeconds * 1000;
if (mtimeMs < minMtimeMs) {
  const age = Math.max(1, Math.round((minMtimeMs - mtimeMs) / 1000));
  fail(
    `main.jsbundle is STALE — it predates this build by ~${age}s, so the bundling phase did not run `
    + 'and the product is carrying a bundle from an earlier build.\n'
    + '  A build that skips bundling still succeeds and leaves the previous main.jsbundle in place,\n'
    + '  which is why existence alone is not proof. Check that the bundling phase actually ran.\n'
    + `  Bundle: ${bundlePath}`,
  );
}

process.stdout.write(
  `assert-embedded-bundle: OK — ${productName} embeds a freshly built main.jsbundle (${size} bytes)\n`,
);
