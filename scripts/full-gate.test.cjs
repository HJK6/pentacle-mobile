const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const {
  RELEASE_HARNESS_ENV,
  gateEnvironment,
  installedBundleId,
  LOCAL_CONFIG,
  LOCAL_CONFIG_EXAMPLE,
  SIMULATOR_STAGE_TIMEOUT_MS,
  productionIosExportOptions,
  provisionCandidateLocalConfig,
  releaseSmoke,
  releaseSimulatorBuildOptions,
  runGate,
  scenarioGateOptions,
  waitForLaunchReadiness,
} = require('./full-gate.cjs');

function readinessFixture(idleFractions, processes = [], loadavg = [190, 80, 50]) {
  let elapsed = 0;
  let previous = 0;
  let idle = 1000;
  let reads = 0;
  return { now: () => elapsed, sleep: (ms) => { elapsed += ms; },
    read: () => {
      idle += (elapsed - previous) * 10 * idleFractions[Math.min(Math.max(0, reads++ - 1), idleFractions.length - 1)];
      previous = elapsed;
      return { ncpu: 10, loadavg, processes, cpu: { idle, total: 2000 + elapsed * 10 } };
    },
  };
}

test('launch readiness uses a five-second CPU delta despite high historical load', () => {
  const result = waitForLaunchReadiness(123, readinessFixture([0.5]));
  assert.equal(result.elapsed_ms, 5000);
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples.at(-1).idle_ratio, 0.5);
  assert.deepEqual(result.samples.at(-1).loadavg, [190, 80, 50]);
  assert.equal(result.bound_ms, 120000);
  assert.equal(SIMULATOR_STAGE_TIMEOUT_MS['release-sim-launch'], 135000);
});

test('launch readiness waits for current CPU contention to settle', () => {
  const result = waitForLaunchReadiness(123, readinessFixture([0.1, 0.49, 0.5]));
  assert.equal(result.elapsed_ms, 15000);
  assert.deepEqual(result.samples.map((sample) => sample.idle_ratio), [null, 0.1, 0.49, 0.5]);
});

test('launch readiness rejects busy CPUs even when historical load is low', () => {
  assert.throws(() => waitForLaunchReadiness(123, readinessFixture([0.49], [], [0, 0, 0])), (error) => {
    assert.equal(error.code, 'HOST_LAUNCH_NOT_READY');
    assert.equal(error.readiness.elapsed_ms, 120000);
    assert.equal(error.readiness.samples.at(-1).idle_ratio, 0.49);
    assert.deepEqual(error.readiness.census, []);
    return true;
  });
});

test('launch readiness waits for owned build children, preserving unrelated processes', () => {
  const owned = [{ pid: 124, ppid: 1, pgid: 123, cpu: 0, command: 'clang' }];
  assert.throws(() => waitForLaunchReadiness(123, readinessFixture([1], owned)), /HOST_LAUNCH_NOT_READY/);
  const unrelated = [{ ...owned[0], pgid: 999 }];
  assert.deepEqual(waitForLaunchReadiness(123, readinessFixture([1], unrelated)).census, unrelated);
});

test('launch readiness fails closed on missing owner and malformed observations', () => {
  for (const owner of [undefined, 0, -1, NaN]) assert.throws(() => waitForLaunchReadiness(owner, readinessFixture([1])), /HOST_BUILD_OWNER_MISSING/);
  const valid = { ncpu: 10, loadavg: [0, 0, 0], processes: [], cpu: { idle: 1000, total: 2000 } };
  for (const observation of [null, { ...valid, ncpu: 0 }, { ...valid, loadavg: [NaN, 0, 0] }, { ...valid, cpu: null }, { ...valid, cpu: { idle: 2, total: 1 } }, { ...valid, processes: [{}] }]) {
    assert.throws(() => waitForLaunchReadiness(123, { ...readinessFixture([1]), read: () => observation }), /HOST_LAUNCH_READINESS_UNAVAILABLE/);
  }
});

test('launch readiness rejects non-advancing or reset CPU counters', () => {
  for (const [totalDelta, idleDelta] of [[0, 0], [-1, 0], [100, -1], [100, 101]]) {
    let reads = 0;
    const fixture = readinessFixture([1]);
    fixture.read = () => {
      const index = reads++;
      return { ncpu: 10, loadavg: [0, 0, 0], processes: [], cpu: { idle: 1000 + index * idleDelta, total: 2000 + index * totalDelta } };
    };
    assert.throws(() => waitForLaunchReadiness(123, fixture), /HOST_LAUNCH_READINESS_UNAVAILABLE/);
  }
});

test('launch readiness retains the underlying read exception', () => {
  const failure = Object.assign(new Error('census fixture denied'), { code: 'EACCES' });
  assert.throws(() => waitForLaunchReadiness(123, { ...readinessFixture([1]), read: () => { throw failure; } }), (error) => {
    assert.equal(error.code, 'HOST_LAUNCH_READINESS_UNAVAILABLE');
    assert.equal(error.readiness.failure.message, failure.message);
    assert.equal(error.readiness.failure.code, 'EACCES');
    assert.equal(error.readiness.samples.length, 1);
    return true;
  });
});

function censusTimeout(fixture, remaining) {
  const duration = Math.min(2000, remaining);
  fixture.sleep(duration);
  return Object.assign(new Error('process census unavailable'), { census: {
    kind: 'ps_spawn', spawn_ms: duration, timeout_ms: duration, status: null, signal: 'SIGTERM',
    spawn_error: { code: 'ETIMEDOUT' }, rows: 0, stderr: '',
  } });
}

test('launch readiness treats a ps timeout as not ready and starts a fresh CPU window', () => {
  const fixture = readinessFixture([1]);
  const read = fixture.read;
  let calls = 0;
  fixture.read = (remaining) => { if (++calls === 2) throw censusTimeout(fixture, remaining); return read(); };
  const result = waitForLaunchReadiness(123, fixture);
  assert.equal(result.elapsed_ms, 17000);
  assert.equal(result.samples[1].failure.census.spawn_error.code, 'ETIMEDOUT');
  assert.equal(result.samples[2].sample_ms, 0);
  assert.equal(result.samples[2].idle_ratio, null);
  assert.equal(result.samples[3].sample_ms, 5000);
  assert.equal(result.failure, undefined);
});

test('launch readiness bounds repeated ps timeouts and retains every failed sample', () => {
  const fixture = readinessFixture([1]);
  let calls = 0;
  fixture.read = (remaining) => { calls++; throw censusTimeout(fixture, remaining); };
  assert.throws(() => waitForLaunchReadiness(123, fixture), (error) => {
    assert.equal(error.code, 'HOST_LAUNCH_NOT_READY');
    assert.equal(error.readiness.elapsed_ms, 120000);
    assert.equal(error.readiness.samples.length, calls);
    assert.ok(calls > 1);
    for (const sample of error.readiness.samples) {
      assert.equal(sample.failure.census.spawn_error.code, 'ETIMEDOUT');
      assert.ok(sample.failure.census.timeout_ms <= 2000);
      assert.equal(sample.failure.census.rows, 0);
    }
    return true;
  });
});

test('launch readiness seals real ps exit and parse failures without retry', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-ps-'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}:${originalPath}`;
    for (const [program, expectedStatus, expectedKind] of [
      ["console.error('census fixture denied'); process.exit(73);", 73, 'ps_spawn'],
      ["console.log('malformed census fixture');", 0, 'ps_parse'],
    ]) {
      fs.writeFileSync(path.join(directory, 'ps'), `#!${process.execPath}\n${program}\n`, { mode: 0o700 });
      assert.throws(() => waitForLaunchReadiness(123), (error) => {
        assert.equal(error.code, 'HOST_LAUNCH_READINESS_UNAVAILABLE');
        const census = error.readiness.failure.census;
        assert.equal(census.kind, expectedKind);
        assert.equal(census.status, expectedStatus);
        assert.equal(census.timeout_ms, 2000);
        assert.ok(census.spawn_ms >= 0);
        assert.equal(error.readiness.samples.length, 1);
        if (expectedStatus) assert.match(census.stderr, /census fixture denied/);
        else assert.equal(census.invalid_row, 'malformed census fixture');
        return true;
      });
    }
    fs.writeFileSync(path.join(directory, 'ps'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    let ticks = 0;
    assert.throws(() => waitForLaunchReadiness(123, { now: () => [0, 119999, 120000][Math.min(ticks++, 2)] }), (error) => {
      assert.equal(error.code, 'HOST_LAUNCH_NOT_READY');
      const census = error.readiness.samples[0].failure.census;
      assert.equal(census.spawn_error.code, 'ETIMEDOUT');
      assert.equal(census.timeout_ms, 1);
      assert.equal(census.status, null);
      assert.equal(error.readiness.elapsed_ms, 120000);
      return true;
    });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('production export stays clean while Release-sim receives the harness flag', () => {
  assert.deepEqual(RELEASE_HARNESS_ENV, { EXPO_PUBLIC_HARNESS: '1' });
  const globallyExported = { EXPO_PUBLIC_HARNESS: '1', PATH: process.env.PATH };
  assert.equal(gateEnvironment('/tmp/gate-artifacts', {}, globallyExported).EXPO_PUBLIC_HARNESS, undefined);
  assert.deepEqual(productionIosExportOptions(), {});
  assert.equal(gateEnvironment('/tmp/gate-artifacts', productionIosExportOptions(), globallyExported).EXPO_PUBLIC_HARNESS, undefined);
  assert.equal(gateEnvironment('/tmp/gate-artifacts', releaseSimulatorBuildOptions(), globallyExported).EXPO_PUBLIC_HARNESS, '1');
});

test('release-sim launches the identifier embedded in the built app', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-bundle-id-'));
  const appPath = path.join(tempRoot, 'Pentacle.app');
  fs.mkdirSync(appPath);
  fs.writeFileSync(path.join(appPath, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>quest.pentacle.mobile</string></dict></plist>');
  const inherited = process.env.PENTACLE_BUNDLE_ID;
  process.env.PENTACLE_BUNDLE_ID = 'quest.pentacle.mobile.harness';
  try {
    assert.equal(installedBundleId(appPath), 'quest.pentacle.mobile');
  } finally {
    if (inherited === undefined) delete process.env.PENTACLE_BUNDLE_ID;
    else process.env.PENTACLE_BUNDLE_ID = inherited;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('release smoke polls native readiness for the built override and preserves stage identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-release-ready-'));
  const appPath = path.join(root, 'release-sim-derived-data/Build/Products/Release-iphonesimulator/PentacleHarness.app');
  fs.mkdirSync(appPath, { recursive: true });
  const prior = { ...process.env }; const calls = []; const targets = [];
  Object.assign(process.env, { PENTACLE_GATE_SIMULATOR_UDID: 'SIMULATOR-1', PENTACLE_BUNDLE_ID: 'quest.pentacle.mobile' });
  try {
    const release = releaseSmoke(root, { nativeRoot: root, workspace: path.join(root, 'ios/Pentacle.xcworkspace') }, {
      hostHealth: () => ({ ok: true }), installedBundleId: () => 'quest.pentacle.mobile',
      settle: () => ({ bound_ms: 120000, elapsed_ms: 0 }), onTarget: (target) => targets.push(target),
      runGate: (name, args, directory, options) => {
        calls.push({ name, args });
        if (name === 'release-sim-build') {
          assert.ok(args.includes('PRODUCT_BUNDLE_IDENTIFIER=quest.pentacle.mobile'));
          assert.ok(args.includes('ONLY_ACTIVE_ARCH=YES'));
        }
        if (name === 'release-sim-launch') {
          const input = JSON.parse(args.at(-1));
          assert.equal(input.target.bundleId, 'quest.pentacle.mobile');
          assert.match(input.nonce, /^[0-9a-f-]{36}$/);
          fs.writeFileSync(input.receiptFile, JSON.stringify({ ready: true, pid: 1234, nonce: input.nonce }));
        }
        return { name, status: 0, owned_process_group: 1234, readiness: options?.readiness };
      },
    });
    assert.deepEqual(calls.map((call) => call.name), ['release-sim-bootstatus', 'release-sim-build', 'release-sim-reset', 'release-sim-install', 'release-sim-launch', 'release-sim-settle', 'release-sim-liveness']);
    assert.equal(release.target.live_pid, 1234);
    assert.equal(release.target.phase, 'ready');
    assert.equal(targets[0].bundleId, null);
    assert.equal(targets[0].phase, 'allocated');
  } finally { for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior); fs.rmSync(root, { recursive: true, force: true }); }
});

test('release target persists known and null identities before every failing assertion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-release-binding-'));
  const appPath = path.join(root, 'release-sim-derived-data/Build/Products/Release-iphonesimulator/PentacleHarness.app');
  fs.mkdirSync(appPath, { recursive: true });
  const prior = process.env.PENTACLE_GATE_SIMULATOR_UDID;
  process.env.PENTACLE_GATE_SIMULATOR_UDID = 'SIMULATOR-1';
  try {
    for (const phase of ['bootstatus', 'build', 'reset', 'install', 'launch']) {
      let target;
      assert.throws(() => releaseSmoke(root, { nativeRoot: root, workspace: '/native/workspace' }, {
        hostHealth: () => ({ ok: true }), installedBundleId: () => 'test.bundle', settle: () => ({}),
        onTarget: (snapshot) => { target = snapshot; },
        runGate: (name) => { if (name === `release-sim-${phase}`) throw new Error(`injected-${phase}`); return { owned_process_group: 123 }; },
      }), new RegExp(`injected-${phase}`));
      assert.equal(target.udid, 'SIMULATOR-1');
      assert.equal(target.phase, phase === 'bootstatus' ? 'boot' : phase);
      assert.equal(target.bundleId, ['bootstatus', 'build'].includes(phase) ? null : 'test.bundle');
    }
  } finally { if (prior === undefined) delete process.env.PENTACLE_GATE_SIMULATOR_UDID; else process.env.PENTACLE_GATE_SIMULATOR_UDID = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test('sim-E2E inherits the exact Release target identity', () => {
  const target = { deviceSetRoot: '/canonical/Devices', udid: 'SIM-EXACT', bundleId: 'quest.pentacle.mobile' };
  assert.deepEqual(scenarioGateOptions(target).env, {
    PENTACLE_SCENARIO_DEVICE_SET_ROOT: '/canonical/Devices',
    PENTACLE_SIMULATOR_UDID: 'SIM-EXACT',
    PENTACLE_BUNDLE_ID: 'quest.pentacle.mobile',
    PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT',
    PENTACLE_GATE_BOUND_BUNDLE_ID: 'quest.pentacle.mobile',
  });
});

function preflight(nativeRoot, artifactDir, candidateRoot = ROOT, environment = {}) {
  return spawnSync(process.execPath, ['scripts/full-gate.cjs', '--preflight', '--artifacts', artifactDir], {
    cwd: candidateRoot,
    env: { ...process.env, ...environment, PENTACLE_GATE_NATIVE_ROOT: nativeRoot },
    encoding: 'utf8',
  });
}

function fullGate(nativeRoot, artifactDir, candidateRoot = ROOT, environment = {}) {
  return spawnSync(process.execPath, ['scripts/full-gate.cjs', '--artifacts', artifactDir], {
    cwd: candidateRoot,
    env: {
      ...process.env,
      PENTACLE_GATE_TEST_MODE: '1',
      PENTACLE_TEST_DISABLE_SIM_RESOURCE_GUARD: '1',
      PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP: '1',
      TESTTIME_BIN: path.join(ROOT, 'test/fixtures/testtime-stub.cjs'),
      ...environment,
      PENTACLE_GATE_NATIVE_ROOT: nativeRoot,
    },
    encoding: 'utf8',
  });
}

test('runGate records stages under one shared testtime run id', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-testtime-stage-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  fs.mkdirSync(artifactDir);
  const env = {
    TESTTIME_BIN: path.join(ROOT, 'test/fixtures/testtime-stub.cjs'),
    TESTTIME_REPO: 'pentacle-mobile',
    TESTTIME_RUN_ID: 'shared-run',
    TESTTIME_SHA: 'abc123',
    TESTTIME_OUT: path.join(artifactDir, 'testtime.jsonl'),
  };
  runGate('first', [process.execPath, '-e', 'process.exit(0)'], artifactDir, { env });
  runGate('second', [process.execPath, '-e', 'process.exit(0)'], artifactDir, { env });
  const records = fs.readFileSync(env.TESTTIME_OUT, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((record) => record.stage), ['first', 'second']);
  assert.deepEqual(new Set(records.map((record) => record.run_id)), new Set(['shared-run']));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('runGate executes the original command when testtime is unavailable', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-testtime-absent-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  fs.mkdirSync(artifactDir);
  const evidence = runGate(
    'without-testtime',
    [process.execPath, '-e', "process.stdout.write('original-command-ran')"],
    artifactDir,
    { env: { PATH: tempRoot, TESTTIME_BIN: undefined } },
  );
  assert.equal(evidence.status, 0);
  assert.match(fs.readFileSync(path.join(artifactDir, 'without-testtime.log'), 'utf8'), /original-command-ran/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('simulator stage bounds are explicit and a hanging owned group fails closed', () => {
  assert.deepEqual(SIMULATOR_STAGE_TIMEOUT_MS, {
    'release-sim-bootstatus': 180_000,
    'release-sim-build': 1_800_000,
    'release-sim-reset': 60_000,
    'release-sim-install': 120_000,
    'release-sim-launch': 135_000,
    'release-sim-settle': 10_000,
    'release-sim-liveness': 30_000,
    'sim-e2e': 2_700_000,
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-stage-timeout-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const descendantPidPath = path.join(tempRoot, 'descendant.pid');
  fs.mkdirSync(artifactDir);
  const started = Date.now();
  assert.throws(() => runGate(
    'synthetic-simctl-launch',
    [process.execPath, '-e', `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));setInterval(()=>{},1000)`],
    artifactDir,
    { timeoutMs: 100, env: { TESTTIME_BIN: path.join(tempRoot, 'missing-testtime') } },
  ), /timed out after 100ms; owned child (terminated|killed)/);
  assert.ok(Date.now() - started < 3_000);
  const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'synthetic-simctl-launch.json'), 'utf8'));
  assert.equal(evidence.status, 124);
  assert.equal(evidence.failure_class, 'setup_tooling_timeout');
  assert.equal(evidence.timeout.bound_ms, 100);
  assert.equal(evidence.timeout.term_sent, true);
  assert.equal(evidence.timeout.group_alive_after, false);
  const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
  assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === 'ESRCH');
  assert.equal(fs.existsSync(path.join(artifactDir, '.synthetic-simctl-launch.timeout.json')), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a bounded nonzero stage preserves the child status without misclassifying a timeout', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-stage-nonzero-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  fs.mkdirSync(artifactDir);
  assert.throws(() => runGate(
    'synthetic-simctl-nonzero',
    [process.execPath, '-e', 'process.exit(23)'],
    artifactDir,
    { timeoutMs: 1_000, env: { TESTTIME_BIN: path.join(tempRoot, 'missing-testtime') } },
  ), /failed/);
  const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'synthetic-simctl-nonzero.json'), 'utf8'));
  assert.equal(evidence.status, 23);
  assert.equal(evidence.failure_class, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('Jest reporter is a no-op when the shared reporter is unavailable', () => {
  const modulePath = require.resolve('../test/testtime-jest-reporter.cjs');
  const previous = process.env.TESTTIME_JEST_REPORTER;
  process.env.TESTTIME_JEST_REPORTER = path.join(os.tmpdir(), 'missing-testtime-reporter.cjs');
  delete require.cache[modulePath];
  try {
    const Reporter = require(modulePath);
    assert.doesNotThrow(() => new Reporter());
  } finally {
    delete require.cache[modulePath];
    if (previous === undefined) delete process.env.TESTTIME_JEST_REPORTER;
    else process.env.TESTTIME_JEST_REPORTER = previous;
  }
});

function candidateOrigin(candidateRoot) {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: candidateRoot, encoding: 'utf8' }).trim();
}

function cleanCandidateClone(tempRoot) {
  const candidateRoot = path.join(tempRoot, 'candidate');
  const submoduleRemote = execFileSync('git', ['config', '-f', path.join(ROOT, '.gitmodules'), '--get', 'submodule.pentacle-chat-core.url'], { encoding: 'utf8' }).trim();
  const submoduleLocal = fs.realpathSync(path.join(ROOT, 'pentacle-chat-core'));
  execFileSync('git', [
    '-c', `url.${submoduleLocal}.insteadOf=${submoduleRemote}`,
    '-c', 'protocol.file.allow=always',
    'clone', '--quiet', '--recurse-submodules', ROOT, candidateRoot,
  ], { stdio: 'ignore', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'full-gate.cjs'), path.join(candidateRoot, 'scripts', 'full-gate.cjs'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'gate-code-provenance.cjs'), path.join(candidateRoot, 'scripts', 'gate-code-provenance.cjs'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'sim-resource-guard.cjs'), path.join(candidateRoot, 'scripts', 'sim-resource-guard.cjs'));
  fs.copyFileSync(path.join(ROOT, 'plugins', 'withHarnessLaunchUrl.js'), path.join(candidateRoot, 'plugins', 'withHarnessLaunchUrl.js'));
  const helpers = ['owned-process.cjs', 'gate-host-health.cjs', 'gate-cpu-accounting.cjs', 'gate-process-cpu.py', 'gate-checks.cjs', 'gate-build-policy.cjs', 'gate-app-ready.cjs'];
  for (const name of helpers) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(candidateRoot, 'scripts', name));
  execFileSync('git', ['add', 'scripts/full-gate.cjs', 'scripts/gate-code-provenance.cjs', 'scripts/sim-resource-guard.cjs', 'plugins/withHarnessLaunchUrl.js', ...helpers.map((name) => `scripts/${name}`)], { cwd: candidateRoot });
  if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: candidateRoot }).status !== 0) {
    execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'gate preflight'], { cwd: candidateRoot });
  }
  const origin = path.join(tempRoot, 'candidate-origin.git');
  execFileSync('git', ['init', '--bare', '--quiet', origin]);
  execFileSync('git', ['push', '--quiet', origin, 'HEAD:refs/heads/gate'], { cwd: candidateRoot });
  execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: candidateRoot });
  return candidateRoot;
}

function derivedClone(tempRoot, candidateRoot, { matchingOrigin = true, nonIos = false, largeIosDiff = false, externalNodeModules = false, externalLocalConfig = false, initializeSubmodules = true, narrowLaunch = false, appDelegateMutation = false, projectMutation = false } = {}) {
  const nativeRoot = path.join(tempRoot, 'native');
  const cloneArgs = ['clone', '--quiet'];
  if (initializeSubmodules) cloneArgs.push('--recurse-submodules');
  cloneArgs.push(candidateRoot, nativeRoot);
  execFileSync('git', cloneArgs, { stdio: 'ignore' });
  if (matchingOrigin) execFileSync('git', ['remote', 'set-url', 'origin', candidateOrigin(candidateRoot)], { cwd: nativeRoot });
  const workspace = path.join(nativeRoot, 'ios', 'Pentacle.xcworkspace');
  const modulemap = path.join(nativeRoot, 'ios', 'Pods', 'ReachabilitySwift', 'Reachability.modulemap');
  const nodeModules = path.join(nativeRoot, 'node_modules');
  if (externalNodeModules) {
    const sharedNodeModules = path.join(tempRoot, 'shared-node-modules');
    fs.mkdirSync(sharedNodeModules, { recursive: true });
    fs.symlinkSync(sharedNodeModules, nodeModules);
  } else {
    fs.mkdirSync(nodeModules, { recursive: true });
  }
  const localConfig = path.join(nativeRoot, 'pentacle.config.local.ts');
  if (externalLocalConfig) {
    const sharedConfig = path.join(tempRoot, 'shared-pentacle.config.local.ts');
    fs.writeFileSync(sharedConfig, 'export default {};\n');
    fs.symlinkSync(sharedConfig, localConfig);
  } else {
    fs.writeFileSync(localConfig, 'export default {};\n');
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'contents.xcworkspacedata'), '<Workspace/>\n');
  fs.mkdirSync(path.dirname(modulemap), { recursive: true });
  fs.writeFileSync(modulemap, 'module ReachabilitySwift {}\n');
  const appDelegate = path.join(nativeRoot, 'ios', 'Pentacle', 'AppDelegate.swift');
  const project = path.join(nativeRoot, 'ios', 'Pentacle.xcodeproj', 'project.pbxproj');
  if (narrowLaunch) {
    const { patchAppDelegate } = require(path.join(nativeRoot, 'plugins', 'withHarnessLaunchUrl.js'));
    fs.writeFileSync(appDelegate, patchAppDelegate(fs.readFileSync(appDelegate, 'utf8')));
    const projectSource = fs.readFileSync(project, 'utf8');
    fs.writeFileSync(project, projectSource
      .replaceAll('PRODUCT_BUNDLE_IDENTIFIER = quest.pentacle.mobile;', 'PRODUCT_BUNDLE_IDENTIFIER = com.example.pentacle.harness;')
      .replaceAll('PRODUCT_NAME = "Pentacle";', 'PRODUCT_NAME = "PentacleHarness";'));
  }
  if (appDelegateMutation) fs.appendFileSync(appDelegate, '\n// unrelated native regeneration\n');
  if (projectMutation) fs.appendFileSync(project, '\n// unrelated project regeneration\n');
  if (largeIosDiff) {
    const generated = path.join(nativeRoot, 'ios', 'generated');
    fs.mkdirSync(generated, { recursive: true });
    for (let index = 0; index < 5000; index += 1) {
      fs.writeFileSync(path.join(generated, `${'x'.repeat(220)}-${index}`), 'generated\n');
    }
  }
  if (nonIos) fs.appendFileSync(path.join(nativeRoot, 'package.json'), '\n');
  execFileSync('git', ['add', '-f', 'ios'], { cwd: nativeRoot });
  if (nonIos) execFileSync('git', ['add', 'package.json'], { cwd: nativeRoot });
  execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'generated ios'], { cwd: nativeRoot });
  return nativeRoot;
}

function makeTreeReadOnly(root) {
  const permissions = [];
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    permissions.push([entry, stat.mode & 0o777]);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
    }
    fs.chmodSync(entry, stat.mode & ~0o222);
  };
  visit(root);
  return () => {
    for (const [entry, mode] of permissions) fs.chmodSync(entry, mode);
  };
}

test('preflight rejects the active checkout before creating artifacts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-test-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const result = preflight(ROOT, artifactDir);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /disposable root/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('full gate rejects the active checkout before artifacts or gate children', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-normal-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const result = fullGate(ROOT, artifactDir);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /disposable root/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight resolves aliases before rejecting the active checkout', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-alias-'));
  const alias = path.join(tempRoot, 'candidate-alias');
  const artifactDir = path.join(tempRoot, 'artifacts');
  fs.symlinkSync(ROOT, alias);
  const result = preflight(alias, artifactDir);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /disposable root/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight accepts a clean derived clone with ios-only changes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-dirty-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(artifactDir), false);
  assert.equal(fs.existsSync(path.join(candidateRoot, LOCAL_CONFIG)), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight accepts only the semantic-minimal launch native delta', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-narrow-native-'));
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { narrowLaunch: true });
  const result = preflight(nativeRoot, path.join(tempRoot, 'artifacts'), candidateRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects unrelated AppDelegate and project regeneration', () => {
  for (const mutation of [{ appDelegateMutation: true }, { projectMutation: true }]) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-native-semantics-'));
    const candidateRoot = cleanCandidateClone(tempRoot);
    const nativeRoot = derivedClone(tempRoot, candidateRoot, { narrowLaunch: true, ...mutation });
    const result = preflight(nativeRoot, path.join(tempRoot, 'artifacts'), candidateRoot);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /semantic-minimal launch identity/);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('preflight accepts a content-clean clone with stale index stat metadata', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-read-only-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const trackedFile = path.join(nativeRoot, 'ios', 'Pentacle.xcworkspace', 'contents.xcworkspacedata');
  execFileSync('git', ['status', '--porcelain'], { cwd: nativeRoot, encoding: 'utf8' });
  const stale = new Date(Date.now() + 60_000);
  fs.utimesSync(trackedFile, stale, stale);
  const restorePermissions = makeTreeReadOnly(path.join(nativeRoot, '.git'));
  try {
    assert.equal(spawnSync('git', ['diff-index', '--quiet', 'HEAD', '--'], { cwd: nativeRoot }).status, 1);
    assert.equal(spawnSync('git', ['diff', '--quiet', '--'], { cwd: nativeRoot }).status, 0);
    assert.equal(spawnSync('git', ['diff', '--cached', '--quiet', '--'], { cwd: nativeRoot }).status, 0);
    const result = preflight(nativeRoot, artifactDir, candidateRoot);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(artifactDir), false);
  } finally {
    restorePermissions();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('preflight rejects a content-clean native root whose copied modulemap is 0444', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-modulemap-mode-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const modulemap = path.join(nativeRoot, 'ios', 'Pods', 'ReachabilitySwift', 'Reachability.modulemap');
  fs.chmodSync(modulemap, 0o444);
  assert.equal(fs.statSync(modulemap).mode & 0o777, 0o444);
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: nativeRoot, encoding: 'utf8' }), '');
  assert.equal(spawnSync('git', ['diff', '--quiet', '--'], { cwd: nativeRoot }).status, 0);
  assert.equal(spawnSync('git', ['diff', '--cached', '--quiet', '--'], { cwd: nativeRoot }).status, 0);
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /build-compatible.*owner-writable.*Reachability\.modulemap/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('normal gate provisions the missing candidate config before focused Jest without parent pollution', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-config-provision-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const fakeBin = path.join(tempRoot, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'npx'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(fakeBin, 'npx'), 0o755);
  assert.equal(fs.existsSync(path.join(candidateRoot, LOCAL_CONFIG)), false);
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateRoot, encoding: 'utf8' }).trim();
  const gateCodeSha = 'c'.repeat(40);
  const result = fullGate(nativeRoot, artifactDir, candidateRoot, {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    PENTACLE_GATE_CANDIDATE_SHA: candidateSha,
    PENTACLE_GATE_CODE_SHA: gateCodeSha,
    PENTACLE_GATE_CODE_TREE_CLEAN: 'true',
  });
  assert.notEqual(result.status, 0);
  const candidateConfig = path.join(candidateRoot, LOCAL_CONFIG);
  assert.equal(fs.lstatSync(candidateConfig).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(candidateConfig), fs.readFileSync(path.join(candidateRoot, LOCAL_CONFIG_EXAMPLE)));
  assert.equal(fs.existsSync(path.join(tempRoot, LOCAL_CONFIG)), false);
  assert.equal(fs.existsSync(path.join(artifactDir, 'focused-jest.json')), false);
  assert.equal(fs.existsSync(path.join(artifactDir, 'serial-jest.json')), false);
  const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, 'run.json'), 'utf8'));
  assert.equal(summary.checks.find((row) => row.name === 'hostadmission-and-signal').status, 'failed');
  for (const name of ['focused-jest', 'serial-jest', 'typecheck']) assert.deepEqual(summary.checks.find((row) => row.name === name).dependencies, ['hostadmission-and-signal']);
  assert.equal(summary.candidate_sha, candidateSha);
  assert.equal(summary.gate_code_sha, gateCodeSha);
  assert.equal(summary.gate_code_tree_clean, true);
  assert.match(result.stdout, new RegExp(`candidate=${candidateSha} gate-code=${gateCodeSha}`));
  const nativeEvidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'native-root.json'), 'utf8'));
  assert.deepEqual(nativeEvidence.permission_contract, { scope: 'ios/**/*.modulemap', modulemap_files: 1, owner_writable_required: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('candidate config provisioning rejects external or non-deterministic local config', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-candidate-config-'));
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const localConfig = path.join(candidateRoot, LOCAL_CONFIG);
  const sharedConfig = path.join(tempRoot, 'shared-pentacle.config.local.ts');
  fs.writeFileSync(sharedConfig, fs.readFileSync(path.join(candidateRoot, LOCAL_CONFIG_EXAMPLE)));
  fs.symlinkSync(sharedConfig, localConfig);
  const externalResult = fullGate(nativeRoot, path.join(tempRoot, 'external-artifacts'), candidateRoot);
  assert.notEqual(externalResult.status, 0);
  assert.match(`${externalResult.stdout}\n${externalResult.stderr}`, /regular root-local file/);
  assert.equal(fs.existsSync(path.join(tempRoot, 'external-artifacts')), false);
  fs.unlinkSync(localConfig);
  fs.writeFileSync(localConfig, 'export default {};\n');
  assert.throws(() => provisionCandidateLocalConfig(candidateRoot), /must match tracked/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight accepts a generated ios diff larger than the child-process default buffer', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-large-diff-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { largeIosDiff: true });
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects a dirty derived clone before workspace checks', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-dirty-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  fs.appendFileSync(path.join(nativeRoot, 'ios', 'Pentacle.xcworkspace', 'contents.xcworkspacedata'), '<!-- dirty -->\n');
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be clean/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects staged native content before workspace checks', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-staged-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  fs.appendFileSync(path.join(nativeRoot, 'ios', 'Pentacle.xcworkspace', 'contents.xcworkspacedata'), '<!-- staged -->\n');
  execFileSync('git', ['add', '-f', 'ios'], { cwd: nativeRoot });
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be clean/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight fails closed when a content-diff command errors', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-git-error-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const fakeBin = path.join(tempRoot, 'bin');
  const fakeGit = path.join(fakeBin, 'git');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakeGit, '#!/bin/sh\nif [ "$1" = "diff" ]; then exit 2; fi\nexec "$FULL_GATE_REAL_GIT" "$@"\n');
  fs.chmodSync(fakeGit, 0o755);
  const result = preflight(nativeRoot, artifactDir, candidateRoot, {
    FULL_GATE_REAL_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /git diff .* failed/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects a derived root with external node_modules', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-node-modules-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { externalNodeModules: true });
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /own node_modules/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects a derived root with external local config', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-config-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { externalLocalConfig: true });
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /root-local pentacle\.config\.local\.ts/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects a derived root with an uninitialized submodule', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-submodule-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { initializeSubmodules: false });
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /initialize all tracked submodules/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects untracked content in either root', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-untracked-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  fs.writeFileSync(path.join(candidateRoot, 'unknown-input.txt'), 'candidate\n');
  let result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /candidate checkout must be clean/);
  fs.rmSync(path.join(candidateRoot, 'unknown-input.txt'));
  fs.writeFileSync(path.join(nativeRoot, 'unknown-input.txt'), 'native\n');
  result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PENTACLE_GATE_NATIVE_ROOT must be clean/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects an unpushed gate checkout', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-unpushed-'));
  const candidateRoot = cleanCandidateClone(tempRoot);
  fs.appendFileSync(path.join(candidateRoot, 'README.md'), '\nlocal gate code\n');
  execFileSync('git', ['add', 'README.md'], { cwd: candidateRoot });
  execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'unpushed gate code'], { cwd: candidateRoot });
  const nativeRoot = derivedClone(tempRoot, candidateRoot);
  const result = preflight(nativeRoot, path.join(tempRoot, 'artifacts'), candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /gate checkout must be pushed/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('canonical gate code preflights a pushed historical candidate without current gate modules', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-historical-'));
  const candidateRoot = cleanCandidateClone(tempRoot);
  const gateModules = [
    'scripts/full-gate.cjs',
    'scripts/gate-code-provenance.cjs',
    'scripts/report-viewer-sim-e2e.cjs',
    'scripts/sim-resource-guard.cjs',
    'scripts/sim-substrate.cjs',
  ];
  for (const relative of gateModules) fs.rmSync(path.join(candidateRoot, relative));
  execFileSync('git', ['add', '-u', ...gateModules], { cwd: candidateRoot });
  execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'historical candidate'], { cwd: candidateRoot });
  execFileSync('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/gate'], { cwd: candidateRoot });
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateRoot, encoding: 'utf8' }).trim();
  const gateCodeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { narrowLaunch: true });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'full-gate.cjs'), '--preflight'], {
    cwd: candidateRoot,
    env: {
      ...process.env,
      PENTACLE_GATE_NATIVE_ROOT: nativeRoot,
      PENTACLE_GATE_CANONICAL_RUNNER: '1',
      PENTACLE_GATE_CANDIDATE_SHA: candidateSha,
      PENTACLE_GATE_CODE_SHA: gateCodeSha,
      PENTACLE_GATE_CODE_TREE_CLEAN: 'true',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`candidate=${candidateSha} gate-code=${gateCodeSha}`));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects wrong-parent and non-ios derived commits', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-derived-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const wrongParent = derivedClone(path.join(tempRoot, 'wrong-parent'), candidateRoot);
  fs.appendFileSync(path.join(wrongParent, 'ios', 'Pentacle.xcworkspace', 'contents.xcworkspacedata'), '<!-- second -->\n');
  execFileSync('git', ['add', '-f', 'ios'], { cwd: wrongParent });
  execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'second generated ios'], { cwd: wrongParent });
  let result = preflight(wrongParent, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /parent is the candidate SHA/);
  const nonIos = derivedClone(path.join(tempRoot, 'non-ios'), candidateRoot, { nonIos: true });
  result = preflight(nonIos, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /only generated ios paths/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('preflight rejects a clone with a mismatched origin', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-full-gate-origin-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const candidateRoot = cleanCandidateClone(tempRoot);
  const nativeRoot = derivedClone(tempRoot, candidateRoot, { matchingOrigin: false });
  const result = preflight(nativeRoot, artifactDir, candidateRoot);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /repository origin/);
  assert.equal(fs.existsSync(artifactDir), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
