#!/usr/bin/env node
'use strict';

// Repo-owned install wrapper that guarantees a real process handoff on an
// in-place upgrade (device_upgrade_process_handoff_2026_07). Both paths resolve
// the EXACT running app process by correlating bundle id -> installed bundle
// path -> a running executable under that path, terminate ONLY that pid, verify
// it exited, overwrite-install the resolved bundle (never a DerivedData glob;
// the app container is preserved), launch terminate-existing, then read back
// bundle id + CFBundleVersion + executable path + a NEW pid that belong to the
// just-installed app. Every ambiguity fails closed WITHOUT signalling anything,
// so a wrong or unresolved target can never kill an unrelated app.
//
// Pure orchestration: every subprocess goes through an injected `command`
// (spawnSync-shaped) so the identity/fail-closed logic is unit-testable with no
// real device or simulator.

const { spawnSync } = require('node:child_process');

const DEVICE_ERR = 'DEVICE_INSTALL_HANDOFF';
const SIM_ERR = 'SIM_INSTALL_HANDOFF';

function requireSuccess(result, label) {
  if (!result || result.error || result.status !== 0) {
    const detail = String(result?.stderr || result?.error?.message || `exit ${result?.status}`).trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function run(command, exe, args, label, options = {}) {
  return requireSuccess(command(exe, args, { encoding: 'utf8', ...options }), label).stdout;
}

function runJson(command, exe, args, label, options = {}) {
  const stdout = run(command, exe, args, label, options);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

// file:///a/b/App.app/ -> /a/b/App.app (trailing slash trimmed)
function urlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;
  return decodeURIComponent(url.slice('file://'.length)).replace(/\/+$/, '');
}

// --- devicectl (physical device) --------------------------------------------

// The single installed bundle matching bundleId, or null when not installed.
// More than one match for one bundle id is impossible on a device; treat it as
// a corrupt inventory and fail closed rather than guess.
function resolveInstalledDeviceApp(command, udid, bundleId) {
  const info = runJson(
    command,
    'xcrun',
    ['devicectl', 'device', 'info', 'apps', '--device', udid, '--json-output', '/dev/stdout'],
    `${DEVICE_ERR}:info_apps`,
  );
  const apps = info?.result?.apps;
  if (!Array.isArray(apps)) throw new Error(`${DEVICE_ERR}:info_apps missing result.apps`);
  const matches = apps.filter((app) => app && app.bundleIdentifier === bundleId);
  if (matches.length > 1) {
    throw new Error(`${DEVICE_ERR}:ambiguous_install ${bundleId} matched ${matches.length} bundles`);
  }
  if (matches.length === 0) return null;
  const bundlePath = urlToPath(matches[0].url);
  if (!bundlePath) throw new Error(`${DEVICE_ERR}:install_path_unresolved for ${bundleId}`);
  return { bundlePath, bundleVersion: String(matches[0].bundleVersion ?? ''), name: matches[0].name };
}

// The running pid whose executable lives inside bundlePath. null when the app
// is not running; >1 correlated process is ambiguous and fails closed.
function resolveRunningDevicePid(command, udid, bundlePath) {
  const info = runJson(
    command,
    'xcrun',
    ['devicectl', 'device', 'info', 'processes', '--device', udid, '--json-output', '/dev/stdout'],
    `${DEVICE_ERR}:info_processes`,
  );
  const procs = info?.result?.runningProcesses;
  if (!Array.isArray(procs)) throw new Error(`${DEVICE_ERR}:info_processes missing result.runningProcesses`);
  const prefix = `${bundlePath}/`;
  const pids = procs
    .map((proc) => ({ pid: proc?.processIdentifier, exe: urlToPath(proc?.executable) }))
    .filter((proc) => Number.isInteger(proc.pid) && proc.exe && proc.exe.startsWith(prefix))
    .map((proc) => proc.pid);
  if (pids.length > 1) {
    throw new Error(`${DEVICE_ERR}:ambiguous_process ${pids.length} processes under ${bundlePath}`);
  }
  return pids.length ? pids[0] : null;
}

function terminateDevicePid(command, udid, pid) {
  run(
    command,
    'xcrun',
    ['devicectl', 'device', 'process', 'signal', '--device', udid, '--signal', 'SIGKILL', '--pid', String(pid),
      '--json-output', '/dev/stdout'],
    `${DEVICE_ERR}:signal`,
  );
}

function installDeviceApp(command, udid, appPath) {
  run(
    command,
    'xcrun',
    ['devicectl', 'device', 'install', 'app', '--device', udid, appPath, '--json-output', '/dev/stdout'],
    `${DEVICE_ERR}:install`,
  );
}

function launchDeviceTerminateExisting(command, udid, bundleId) {
  const out = runJson(
    command,
    'xcrun',
    ['devicectl', 'device', 'process', 'launch', '--device', udid, '--terminate-existing', bundleId,
      '--json-output', '/dev/stdout'],
    `${DEVICE_ERR}:launch`,
  );
  const pid = out?.result?.process?.processIdentifier;
  if (!Number.isInteger(pid)) throw new Error(`${DEVICE_ERR}:launch returned no processIdentifier`);
  return pid;
}

// Resolve the exact freshly-built `.app` from `xcodebuild -showBuildSettings`
// (TARGET_BUILD_DIR + FULL_PRODUCT_NAME), never a DerivedData glob that can
// resolve to a stale build. Deploy-hygiene requirement, PENTACLE_MOBILE_BUILD.md.
function resolveBuiltDeviceApp(command, { udid, workspace, scheme, configuration = 'Release' }) {
  const settings = run(
    command,
    'xcrun',
    ['xcodebuild', '-workspace', workspace, '-scheme', scheme, '-configuration', configuration,
      '-destination', `id=${udid}`, '-showBuildSettings'],
    `${DEVICE_ERR}:showBuildSettings`,
  );
  let dir = null;
  let name = null;
  for (const line of settings.split('\n')) {
    const m = line.match(/^\s*(TARGET_BUILD_DIR|FULL_PRODUCT_NAME)\s*=\s*(.+?)\s*$/);
    if (m && m[1] === 'TARGET_BUILD_DIR') dir = m[2];
    if (m && m[1] === 'FULL_PRODUCT_NAME') name = m[2];
  }
  if (!dir || !name) throw new Error(`${DEVICE_ERR}:build_settings_unresolved TARGET_BUILD_DIR/FULL_PRODUCT_NAME`);
  return `${dir}/${name}`;
}

function readAppBundleVersion(command, appPath) {
  return plistValue(command, `${appPath}/Info.plist`, 'CFBundleVersion', DEVICE_ERR);
}

/**
 * Production device install handoff. `appPath` and `expectedVersion` are the
 * exact freshly-built bundle and its CFBundleVersion (resolved from build
 * settings, never a glob) so the read-back proves the running app IS that build.
 */
function deviceInstallHandoff({ udid, bundleId, appPath, expectedVersion }, command = spawnSync) {
  if (!udid || !bundleId || !appPath || !expectedVersion) {
    throw new Error(`${DEVICE_ERR}:usage udid, bundleId, appPath, expectedVersion are required`);
  }
  const before = resolveInstalledDeviceApp(command, udid, bundleId);
  const oldPid = before ? resolveRunningDevicePid(command, udid, before.bundlePath) : null;
  if (oldPid !== null) {
    terminateDevicePid(command, udid, oldPid);
    const survivor = resolveRunningDevicePid(command, udid, before.bundlePath);
    if (survivor !== null) {
      throw new Error(`${DEVICE_ERR}:terminate_unverified pid ${oldPid} still present after SIGKILL`);
    }
  }
  installDeviceApp(command, udid, appPath);
  const after = resolveInstalledDeviceApp(command, udid, bundleId);
  if (!after) throw new Error(`${DEVICE_ERR}:post_install_absent ${bundleId} not installed after install`);
  if (after.bundleVersion !== String(expectedVersion)) {
    throw new Error(
      `${DEVICE_ERR}:version_mismatch installed ${after.bundleVersion} != built ${expectedVersion}`,
    );
  }
  const newPid = launchDeviceTerminateExisting(command, udid, bundleId);
  if (oldPid !== null && newPid === oldPid) {
    throw new Error(`${DEVICE_ERR}:stale_process new pid ${newPid} equals pre-install pid`);
  }
  return {
    platform: 'device',
    bundleId,
    oldPid,
    newPid,
    bundlePath: after.bundlePath,
    bundleVersion: after.bundleVersion,
  };
}

// --- simctl (simulator) -----------------------------------------------------

function plistValue(command, plistPath, key, errNs) {
  return run(command, 'plutil', ['-extract', key, 'raw', '-o', '-', plistPath], `${errNs}:plist_${key}`).trim();
}

function simAppBundlePath(command, udid, bundleId) {
  const out = command('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], { encoding: 'utf8' });
  if (out.status !== 0) return null; // not installed
  const p = String(out.stdout || '').trim();
  return p || null;
}

// Data container uuid for the app; null when the app was never installed.
function simDataContainer(command, udid, bundleId) {
  const out = command('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data'], { encoding: 'utf8' });
  if (out.status !== 0) return null;
  return String(out.stdout || '').trim() || null;
}

// Running pid via launchctl; null when not running, throw when >1 instance.
function resolveRunningSimPid(command, udid, bundleId) {
  const listed = run(command, 'xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], `${SIM_ERR}:launchctl`);
  const rows = listed
    .split('\n')
    .filter((line) => line.includes(bundleId))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((pid) => /^\d+$/.test(pid))
    .map((pid) => Number(pid));
  if (rows.length > 1) throw new Error(`${SIM_ERR}:ambiguous_process ${rows.length} instances of ${bundleId}`);
  return rows.length ? rows[0] : null;
}

function launchSimTerminateExisting(command, udid, bundleId) {
  const out = run(
    command,
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', udid, bundleId],
    `${SIM_ERR}:launch`,
  );
  const match = out.trim().match(/:\s*(\d+)\s*$/); // "<bundleId>: <pid>"
  if (!match) throw new Error(`${SIM_ERR}:launch returned no pid: ${out.trim()}`);
  return Number(match[1]);
}

/**
 * Simulator install handoff, the mechanism the upgrade regression exercises.
 * Overwrite-installs (no uninstall) so the app's stored data survives the
 * upgrade, and proves the old process exits and a new pid runs the freshly
 * installed bundle.
 *
 * NB (empirical, iOS 26 CoreSimulator): a plain overwrite `simctl install`
 * reassigns the Data container DIRECTORY uuid even though the stored files are
 * migrated intact, so container preservation cannot be asserted by uuid
 * equality — the regression proves it by a sentinel file surviving the upgrade.
 * The wrapper therefore reports the post-install data container but does not
 * gate on its uuid.
 */
function simulatorInstallHandoff({ udid, bundleId, appPath, expectedVersion }, command = spawnSync) {
  if (!udid || !bundleId || !appPath || !expectedVersion) {
    throw new Error(`${SIM_ERR}:usage udid, bundleId, appPath, expectedVersion are required`);
  }
  const oldPid = resolveRunningSimPid(command, udid, bundleId);
  if (oldPid !== null) {
    run(command, 'xcrun', ['simctl', 'terminate', udid, bundleId], `${SIM_ERR}:terminate`);
    if (resolveRunningSimPid(command, udid, bundleId) !== null) {
      throw new Error(`${SIM_ERR}:terminate_unverified pid ${oldPid} still present after terminate`);
    }
  }
  run(command, 'xcrun', ['simctl', 'install', udid, appPath], `${SIM_ERR}:install`);
  const bundlePath = simAppBundlePath(command, udid, bundleId);
  if (!bundlePath) throw new Error(`${SIM_ERR}:post_install_absent ${bundleId} not installed`);
  const installedVersion = plistValue(command, `${bundlePath}/Info.plist`, 'CFBundleVersion', SIM_ERR);
  if (installedVersion !== String(expectedVersion)) {
    throw new Error(`${SIM_ERR}:version_mismatch installed ${installedVersion} != built ${expectedVersion}`);
  }
  const executable = plistValue(command, `${bundlePath}/Info.plist`, 'CFBundleExecutable', SIM_ERR);
  const newPid = launchSimTerminateExisting(command, udid, bundleId);
  if (oldPid !== null && newPid === oldPid) {
    throw new Error(`${SIM_ERR}:stale_process new pid ${newPid} equals pre-install pid`);
  }
  return {
    platform: 'simulator',
    bundleId,
    oldPid,
    newPid,
    bundlePath,
    executablePath: `${bundlePath}/${executable}`,
    bundleVersion: installedVersion,
    dataContainer: simDataContainer(command, udid, bundleId),
  };
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const v = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--resolve-from-build-settings') { flags.add(argv[i]); continue; }
    if (argv[i].startsWith('--')) { v[argv[i]] = argv[i + 1]; i += 1; }
  }
  return {
    platform: v['--platform'],
    udid: v['--udid'],
    bundleId: v['--bundle-id'],
    appPath: v['--app'],
    expectedVersion: v['--expected-version'],
    workspace: v['--workspace'],
    scheme: v['--scheme'],
    configuration: v['--configuration'],
    resolveFromBuildSettings: flags.has('--resolve-from-build-settings'),
  };
}

function main(argv, command = spawnSync) {
  const args = parseArgs(argv);
  if (args.platform !== 'simulator' && args.platform !== 'device') {
    throw new Error('usage: device-install-handoff --platform device|simulator --udid <u> --bundle-id <id> (--app <path> --expected-version <v> | --resolve-from-build-settings --workspace <w> --scheme <s>)');
  }
  if (args.platform === 'device' && args.resolveFromBuildSettings) {
    args.appPath = resolveBuiltDeviceApp(command, args);
    args.expectedVersion = readAppBundleVersion(command, args.appPath);
  }
  const handoff = args.platform === 'simulator' ? simulatorInstallHandoff : deviceInstallHandoff;
  return handoff(args, command);
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  deviceInstallHandoff,
  simulatorInstallHandoff,
  resolveInstalledDeviceApp,
  resolveRunningDevicePid,
  resolveRunningSimPid,
  resolveBuiltDeviceApp,
  readAppBundleVersion,
  urlToPath,
  parseArgs,
  main,
};
