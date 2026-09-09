const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deviceInstallHandoff,
  simulatorInstallHandoff,
  resolveBuiltDeviceApp,
  main,
} = require('./device-install-handoff.cjs');

const OK = (stdout) => ({ status: 0, stdout, stderr: '' });
const FAIL = (stderr) => ({ status: 1, stdout: '', stderr });
const P = '/tmp/example-app/APP_UUID/Pentacle.app';

function appsJson(apps) {
  return OK(JSON.stringify({ result: { apps } }));
}
function procsJson(procs) {
  return OK(JSON.stringify({ result: { runningProcesses: procs } }));
}

// Stateful devicectl mock covering the whole handoff sequence.
function deviceMock({
  before = { bundleIdentifier: 'com.example.pentacle.mobile', bundleVersion: '1', url: `file://${P}/`, name: 'Pentacle' },
  after = { bundleIdentifier: 'com.example.pentacle.mobile', bundleVersion: '2', url: `file://${P}/`, name: 'Pentacle' },
  procsBefore = [{ processIdentifier: 111, executable: `file://${P}/Pentacle` }],
  terminateRemoves = true,
  extraProcs = [],
  launchPid = 222,
} = {}) {
  const state = { installed: before, procs: [...procsBefore, ...extraProcs] };
  const calls = [];
  const command = (exe, args) => {
    calls.push(args.join(' '));
    const has = (s) => args.includes(s);
    if (has('info') && has('apps')) return appsJson(state.installed ? [state.installed] : []);
    if (has('info') && has('processes')) return procsJson(state.procs);
    if (has('signal')) {
      const pid = Number(args[args.indexOf('--pid') + 1]);
      if (terminateRemoves) state.procs = state.procs.filter((p) => p.processIdentifier !== pid);
      return OK('{}');
    }
    if (has('install') && has('app')) {
      state.installed = after;
      return OK('{}');
    }
    if (has('launch')) {
      state.procs.push({ processIdentifier: launchPid, executable: `file://${P}/Pentacle` });
      return OK(JSON.stringify({ result: { process: { processIdentifier: launchPid } } }));
    }
    return OK('{}');
  };
  return { command, calls };
}

const args = { udid: 'DEV-1', bundleId: 'com.example.pentacle.mobile', appPath: `${P}`, expectedVersion: '2' };

test('device: terminates only the correlated pid, installs, launches a new pid, reads back the built version', () => {
  const mock = deviceMock();
  const result = deviceInstallHandoff(args, mock.command);
  assert.deepEqual(
    { oldPid: result.oldPid, newPid: result.newPid, bundleVersion: result.bundleVersion },
    { oldPid: 111, newPid: 222, bundleVersion: '2' },
  );
  const signals = mock.calls.filter((c) => c.includes('signal'));
  assert.equal(signals.length, 1);
  assert.match(signals[0], /--pid 111\b/);
});

test('device: fresh install (nothing running) skips terminate and still verifies the new bundle', () => {
  const mock = deviceMock({ before: null, procsBefore: [] });
  const result = deviceInstallHandoff(args, mock.command);
  assert.equal(result.oldPid, null);
  assert.equal(result.newPid, 222);
  assert.equal(mock.calls.some((c) => c.includes('signal')), false);
});

test('device: two processes under the bundle path fail closed without signalling', () => {
  const mock = deviceMock({
    extraProcs: [{ processIdentifier: 999, executable: `file://${P}/Pentacle` }],
  });
  assert.throws(() => deviceInstallHandoff(args, mock.command), /ambiguous_process/);
  assert.equal(mock.calls.some((c) => c.includes('signal')), false);
});

test('device: a surviving pid after SIGKILL fails closed before install', () => {
  const mock = deviceMock({ terminateRemoves: false });
  assert.throws(() => deviceInstallHandoff(args, mock.command), /terminate_unverified/);
  assert.equal(mock.calls.some((c) => c.includes('install') && c.includes('app')), false);
});

test('device: installed version not matching the built version fails closed', () => {
  const mock = deviceMock({
    after: { bundleIdentifier: 'com.example.pentacle.mobile', bundleVersion: '1', url: `file://${P}/` },
  });
  assert.throws(() => deviceInstallHandoff(args, mock.command), /version_mismatch/);
});

test('device: two installed bundles for one id fail closed as a corrupt inventory', () => {
  const command = (exe, a) => {
    if (a.includes('info') && a.includes('apps')) {
      return appsJson([
        { bundleIdentifier: 'com.example.pentacle.mobile', bundleVersion: '1', url: `file://${P}/` },
        { bundleIdentifier: 'com.example.pentacle.mobile', bundleVersion: '2', url: `file://${P}2/` },
      ]);
    }
    return OK('{}');
  };
  assert.throws(() => deviceInstallHandoff(args, command), /ambiguous_install/);
});

test('device: resolves the built app from build settings, never a glob', () => {
  const settings = [
    '    OTHER = x',
    '    TARGET_BUILD_DIR = /tmp/build/mobile-app-abc/Build/Products/Release-iphoneos',
    '    FULL_PRODUCT_NAME = Pentacle.app',
  ].join('\n');
  const command = (exe, a) => {
    if (a.includes('-showBuildSettings')) return OK(settings);
    return OK('');
  };
  assert.equal(
    resolveBuiltDeviceApp(command, { udid: 'DEV-1', workspace: 'ios/Pentacle.xcworkspace', scheme: 'Pentacle' }),
    '/tmp/build/mobile-app-abc/Build/Products/Release-iphoneos/Pentacle.app',
  );
});

test('device: --resolve-from-build-settings feeds the read-back version into the handoff', () => {
  const appDir = '/tmp/build/mobile-app-abc/Build/Products/Release-iphoneos/Pentacle.app';
  const settings = `TARGET_BUILD_DIR = /tmp/build/mobile-app-abc/Build/Products/Release-iphoneos\nFULL_PRODUCT_NAME = Pentacle.app`;
  const state = deviceMock(); // reuse the stateful device mock (installs v2, version 2)
  const command = (exe, a) => {
    if (a.includes('-showBuildSettings')) return OK(settings);
    if (a.includes('-extract')) return OK('2\n'); // built app CFBundleVersion
    return state.command(exe, a);
  };
  const result = main(
    ['--platform', 'device', '--udid', 'DEV-1', '--bundle-id', 'com.example.pentacle.mobile',
      '--resolve-from-build-settings', '--workspace', 'ios/Pentacle.xcworkspace', '--scheme', 'Pentacle'],
    command,
  );
  assert.equal(result.bundleVersion, '2');
  assert.equal(result.newPid, 222);
  void appDir;
});

// --- simulator --------------------------------------------------------------

const SIM_BUNDLE = '/tmp/simulator/Containers/Bundle/App/APP_UUID/Pentacle.app';
const SIM_DATA = '/tmp/simulator/Containers/Data/App/DATA_UUID';

function simMock({
  dataBefore = SIM_DATA,
  dataAfter = SIM_DATA,
  versionAfter = '2',
  runningBefore = 111,
  terminateRemoves = true,
  ambiguous = false,
  launchPid = 222,
} = {}) {
  // `overwritten` flips on the install call so the pre/post data-container reads
  // return the right value across the one overwrite install.
  const state = { installed: true, overwritten: false, running: runningBefore };
  const calls = [];
  const command = (exe, a) => {
    calls.push(a.join(' '));
    const has = (s) => a.includes(s);
    if (has('get_app_container') && has('data')) {
      if (!state.installed) return FAIL('No such app');
      return OK(`${state.overwritten ? dataAfter : dataBefore}\n`);
    }
    if (has('get_app_container') && has('app')) return state.installed ? OK(`${SIM_BUNDLE}\n`) : FAIL('No such app');
    if (has('launchctl') && has('list')) {
      const lines = ['PID\tStatus\tLabel'];
      if (state.running !== null) lines.push(`${state.running}\t0\tUIKitApplication:com.example.pentacle.mobile[0x1][rb]`);
      if (ambiguous && state.running !== null) lines.push(`888\t0\tUIKitApplication:com.example.pentacle.mobile[0x2][rb]`);
      return OK(lines.join('\n'));
    }
    if (has('terminate') && !has('--terminate-running-process')) {
      if (terminateRemoves) state.running = null;
      return OK('');
    }
    if (has('install')) { state.installed = true; state.overwritten = true; return OK(''); }
    if (has('-extract')) {
      const key = a[a.indexOf('-extract') + 1];
      return OK(key === 'CFBundleVersion' ? `${versionAfter}\n` : 'Pentacle\n');
    }
    if (has('launch')) return OK(`com.example.pentacle.mobile: ${launchPid}\n`);
    return OK('');
  };
  return { command, calls };
}

const simArgs = { udid: 'SIM-1', bundleId: 'com.example.pentacle.mobile', appPath: `${SIM_BUNDLE}`, expectedVersion: '2' };

test('simulator: overwrite upgrade exits the old pid and launches a new pid on the fresh bundle', () => {
  const mock = simMock();
  const result = simulatorInstallHandoff(simArgs, mock.command);
  assert.equal(result.oldPid, 111);
  assert.equal(result.newPid, 222);
  assert.equal(result.bundleVersion, '2');
  assert.equal(result.executablePath, `${SIM_BUNDLE}/Pentacle`);
  // overwrite install: no uninstall issued (stored data must survive)
  assert.equal(mock.calls.some((c) => c.includes('uninstall')), false);
});

test('simulator: two running instances fail closed without terminate', () => {
  const mock = simMock({ ambiguous: true });
  assert.throws(() => simulatorInstallHandoff(simArgs, mock.command), /ambiguous_process/);
  assert.equal(mock.calls.some((c) => c.includes('terminate') && !c.includes('--terminate-running-process')), false);
});

test('simulator: installed version not matching the built version fails closed', () => {
  const mock = simMock({ versionAfter: '1' });
  assert.throws(() => simulatorInstallHandoff(simArgs, mock.command), /version_mismatch/);
});
