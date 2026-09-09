'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { after } = require('node:test');
const mutationCapability = require('./storage-capability.cjs').claim();
const retentionRun = '00000000-0000-4000-8000-000000000000';
test('wrapper retention reaches its manifest and holds a failed device before destructive cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const start = source.indexOf('    // Preserve the exact product');
  const end = source.indexOf('    // Every step is LABELLED', start);
  assert.ok(start > 0 && end > start);
  const sandbox = require('./storage-sandbox.cjs');
  const profile = '(version 1)\n(deny default)';
  const realRequire = (name) => name === './storage-sandbox.cjs' ? { profileForRun: () => profile } : require(name);
  for (const status of [0, 124]) {
    let context; let reachedCleanup = false;
    const execute = new Function('require', 'environment', 'mutationCapability', 'sandboxed', 'reachedCleanup',
      `const evidence='', scratch='', runId='', run={candidate_ref:'a',gate_code_sha:'b'}, nativeRoot='', candidateRoot='';\n${source.slice(start, end)}\nreachedCleanup();`);
    const run = () => execute((name) => name === './storage-launch-evidence.cjs' ? {
      bind: () => ({ captureLaunchEvidence: (options) => { context = options.context(); return { launch: { status } }; } }),
    } : realRequire(name), { simulatorUdid: 'owned-device', env: {} }, mutationCapability,
    sandbox.bind(mutationCapability).sandboxed, () => { reachedCleanup = true; });
    if (status === 0) assert.doesNotThrow(run);
    else assert.throws(run, /LAUNCH_DIAGNOSIS_REQUIRED/);
    assert.equal(context.sandbox_profile, profile);
    assert.equal(context.sandbox_profile_sha256, crypto.createHash('sha256').update(context.sandbox_profile).digest('hex'));
    assert.equal(reachedCleanup, status === 0);
  }
});
test('launch evidence preserves exact product bytes before teardown and rejects incomplete retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-retention-'));
  const scratch = path.join(root, 'scratch');
  const evidence = path.join(root, 'evidence');
  const app = path.join(scratch, 'derived-data/Build/Products/Release-iphonesimulator/PentacleHarness.app');
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(evidence);
  for (const file of ['PentacleHarness', 'main.jsbundle', 'Info.plist']) fs.writeFileSync(path.join(app, file), `exact-${file}`);
  fs.writeFileSync(path.join(evidence, 'release-sim-build.json'), '{"status":0}');
  fs.writeFileSync(path.join(evidence, 'release-sim-launch.json'), JSON.stringify({ status: 124, command: 'exact launch', started_at: '2026-09-08T14:43:03.284Z', finished_at: '2026-09-08T14:43:33.284Z' }));
  const api = require('./storage-launch-evidence.cjs');
  const capture = api.bind(mutationCapability).captureLaunchEvidence;
  const options = { evidence, scratch, runId: retentionRun, candidateSha: 'a'.repeat(40), udid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', deviceSet: path.join(scratch, 'devices') };
  options.context = { gate_code_sha: 'a'.repeat(40), native_root: '/native', cwd: '/candidate', sandbox_profile: '(version 1)',
    sandbox_profile_sha256: crypto.createHash('sha256').update('(version 1)').digest('hex'),
    environment: { PENTACLE_GATE_SIMULATOR_UDID: options.udid, PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT: options.deviceSet },
    launcher_start_time: null, launcher_start_time_reason: 'unknown in post-run capture' };
  fs.writeFileSync(path.join(evidence, 'run.json'), JSON.stringify({ candidate_sha: options.candidateSha, gate_code_sha: options.candidateSha,
    release_target: { udid: options.udid, deviceSetRoot: options.deviceSet, appPath: app } }));
  fs.writeFileSync(path.join(evidence, 'native-root.json'), JSON.stringify({ candidate_sha: options.candidateSha, native_root: '/native' }));
  const collectContext = () => ({ device: { udid: options.udid, state: 'Booted' }, runtime: { identifier: 'runtime', version: '26.5', buildversion: 'test-build' } });
  try {
    assert.throws(() => api.validateLaunchEvidence(evidence, retentionRun, 'a'.repeat(40)), /EVIDENCE_LAUNCH_RETENTION_REQUIRED/);
    assert.throws(() => capture(options, { collectContext: () => ({}), collectLogs: () => { throw new Error('capture unavailable'); } }), /capture unavailable/);
    assert.equal(fs.readFileSync(path.join(app, 'PentacleHarness'), 'utf8'), 'exact-PentacleHarness');
    // Failed capture cannot leave an apparently complete or reusable evidence packet.
    assert.equal(fs.existsSync(path.join(evidence, 'launch-diagnosis/manifest.json')), false);
    capture(options, { collectContext, collectLogs: ({ logWindow }) => {
      assert.deepEqual(logWindow, { start: 1788878578, end: 1788878619, basis: 'launch' });
      return Buffer.from('[{"eventMessage":"launch failure"}]');
    } });
    fs.rmSync(app, { recursive: true });
    assert.equal(fs.readFileSync(path.join(evidence, 'launch-diagnosis/product/PentacleHarness.app/PentacleHarness'), 'utf8'), 'exact-PentacleHarness');
    assert.doesNotThrow(() => api.validateLaunchEvidence(evidence, retentionRun, 'a'.repeat(40)));
    const manifestFile = path.join(evidence, 'launch-diagnosis/manifest.json');
    const originalManifest = fs.readFileSync(manifestFile, 'utf8');
    const forged = JSON.parse(originalManifest); forged.context.sandbox_profile_sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestFile, JSON.stringify(forged));
    assert.throws(() => api.validateLaunchEvidence(evidence, retentionRun, 'a'.repeat(40)), /EVIDENCE_LAUNCH_RETENTION/);
    fs.writeFileSync(manifestFile, originalManifest);
    const extra = path.join(evidence, 'launch-diagnosis/unknown'); fs.writeFileSync(extra, 'x');
    assert.throws(() => api.validateLaunchEvidence(evidence, retentionRun, 'a'.repeat(40)), /EVIDENCE_LAUNCH_RETENTION/); fs.unlinkSync(extra);
    const member = path.join(evidence, 'launch-diagnosis/product/PentacleHarness.app/main.jsbundle'); fs.writeFileSync(member, 'tampered');
    assert.throws(() => api.validateLaunchEvidence(evidence, retentionRun, 'a'.repeat(40)), /EVIDENCE_LAUNCH_RETENTION/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('launch retention rejects oversized and linked products without deleting source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-retention-bounds-'));
  const app = path.join(root, 'scratch/derived-data/Build/Products/Release-iphonesimulator/A.app');
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(evidence, 'release-sim-build.json'), '{"status":0}');
  const api = require('./storage-launch-evidence.cjs').bind(mutationCapability);
  const options = { evidence, scratch: path.join(root, 'scratch'), runId: retentionRun, candidateSha: 'a'.repeat(40), udid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', deviceSet: path.join(root, 'scratch/devices'), context: {} };
  try {
    fs.symlinkSync('/etc/hosts', path.join(app, 'linked'));
    assert.throws(() => api.captureLaunchEvidence(options), /LAUNCH_RETENTION_OBJECT/);
    fs.unlinkSync(path.join(app, 'linked'));
    const large = path.join(app, 'large'); fs.closeSync(fs.openSync(large, 'w')); fs.truncateSync(large, 128 * 1024 * 1024 + 1);
    assert.throws(() => api.captureLaunchEvidence(options), /LAUNCH_RETENTION_CAP/);
    assert.equal(fs.statSync(large).size, 128 * 1024 * 1024 + 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
const { mirrorDiagnosticCaseResult, terminateOwnedSurface } = require('./storage-surface-trigger.cjs').bind(mutationCapability);
const { reapStaleSimulatorSubstrate } = require('./sim-substrate.cjs');

// NOT os.tmpdir(). The sandbox profile now admits the per-user Darwin temporary directory as a host-global
// write root, and renderProfile requires every supplied root to be pairwise disjoint - so a capped root
// synthesized under os.tmpdir() lands INSIDE that host-global root and is correctly rejected with
// SANDBOX_ROOT_IDENTITY. Production roots live under ~/Library, never under the temp dir; only tests can
// hit this. /private/tmp is outside it, and storage-model-oracle.test.cjs already uses that base.
const fixtureRoots = [];
function temporary(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), `${label}-`)));
  fixtureRoots.push(root);
  return root;
}

function syntheticCompanion({ orphan = false } = {}) {
  const root = temporary('storage-host-reap-companion');
  const executable = path.join(root, 'idb_companion');
  fs.copyFileSync('/bin/sleep', executable);
  fs.chmodSync(executable, 0o700);
  // A copied Apple signature retains launch constraints: AMFI can kill it after ps sees exec.
  // Use the same ad-hoc signing as the ps shim so this fixture tests sandbox policy, not AMFI.
  const signed = spawnSync('/usr/bin/codesign', ['-s', '-', '-f', executable], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  // A stale companion outlives its old runner. Model that parentage for the
  // sandbox boundary test instead of making the target the probe's sibling.
  const launcher = "const child=require('node:child_process').spawn(process.argv[1],['30'],{detached:true,stdio:'ignore'});child.unref();process.stdout.write(String(child.pid));";
  const launched = orphan ? spawnSync(process.execPath, ['-e', launcher, executable], { encoding: 'utf8' }) : null;
  if (launched) assert.equal(launched.status, 0);
  const child = orphan ? { pid: Number(launched.stdout), orphan: true }
    : require('node:child_process').spawn(executable, ['30'], { stdio: 'ignore' });
  assert.ok(Number.isInteger(child.pid) && child.pid > 1);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'comm='], { encoding: 'utf8' });
    const parent = orphan ? spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'ppid='], { encoding: 'utf8' }) : null;
    if (observed.status === 0 && path.basename(String(observed.stdout).trim()) === 'idb_companion'
      && (!orphan || (parent.status === 0 && Number(parent.stdout.trim()) === 1))) return child;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  stopSyntheticCompanion(child).catch(() => {});
  throw new Error('synthetic companion did not reach exec');
}

function childAlive(child) {
  try { process.kill(child.pid, 0); return true; } catch { return false; }
}

async function stopSyntheticCompanion(child) {
  if (!childAlive(child)) return;
  if (child.orphan) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { return; }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!childAlive(child)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('synthetic companion cleanup timed out');
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { process.kill(child.pid, 'SIGKILL'); } catch { return; }
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('synthetic companion cleanup timed out')), 1000))]);
}

// The teardown is scoped to the bound UDID, so the synthetic host must answer BOTH probes the way a
// real companion does: an exact-name `idb_companion` process that ALSO carries the UDID on its
// command line. Answering only the name probe would model a companion belonging to another lane,
// which the reap is now required to leave alone.
function scopedSyntheticReap(child, socket, udid) {
  const command = (name, args, options) => {
    if (name === 'pgrep' && args[1] === 'idb_companion') return { status: 0, stdout: `${child.pid}\n`, stderr: '' };
    if (name === 'pgrep' && args[0] === '-f' && args[1] === udid) return { status: 0, stdout: `${child.pid}\n`, stderr: '' };
    if (name === 'kill') return spawnSync('/bin/kill', args, options);
    if (name === 'idb') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const fsModule = {
    readdirSync: () => [path.basename(socket)],
    rmSync: (target) => {
      assert.equal(path.basename(target), path.basename(socket));
      assert.equal(fs.realpathSync(path.dirname(target)), fs.realpathSync(path.dirname(socket)));
      fs.rmSync(socket);
    },
  };
  return (options) => reapStaleSimulatorSubstrate({ ...options, command, environment: {}, fsModule });
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeSurfaceTriggerEvidence(root, runId, overrides = {}) {
  const record = {
    schema: 1, run_id: runId, status: 'fired', reason: 'case-results-complete', observed_results: 8, required_results: 8,
    launch: { status: 'launched', error: null, pids: [8123] }, cleanup: { status: 'verified', error: null, outcomes: [{ pid: 8123, outcome: 'terminated' }] },
    completed_at: '2026-07-17T00:00:02.000Z', ...overrides,
  };
  fs.writeFileSync(path.join(root, 'storage-surface-trigger.json'), `${JSON.stringify(record)}\n`);
}

// DERIVED, never a third copy. Two production arrays are bound to the certified runGate call sites by the
// derivation test below; a hardcoded list in a TEST is not a defect today but it is the exact duplication
// shape that produced the stage-list layer - a copy of a certified-derived list with nothing detecting
// drift, staying green while encoding the defect. Having paid for that twice, a third copy is not left in
// place. deriveCertifiedStages reads the wrapper array and refuses to return anything that is not 12
// entries including both trap names, so an under-matching derivation cannot quietly shrink the fixtures.
function certifiedStages() { return require('./storage-certify.cjs').deriveCertifiedStages(); }

// EVERY fixture root this file creates is registered and removed when the file's tests finish.
// Measured 2026-07-23: one full-gate run added 11 roots and 4,623 had accumulated (~397 MiB) - the
// suite leaking its own scratch is the defect class this lane exists to remove, and nine separate
// call sites is exactly why the ownership belongs to the fixture, not to each caller.
after(() => {
  const { disposeIsolatedHome } = require('./storage-test-teardown.cjs');
  const failures = [];
  for (const root of fixtureRoots.splice(0)) {
    if (!fs.existsSync(root)) continue;
    try { disposeIsolatedHome(root); } catch (error) { failures.push(String(error.message || error)); }
  }
  if (failures.length) throw new Error(`FIXTURE_ROOTS_LEAKED:${failures.join('; ')}`);
});

function reportViewerFixture() {
  const root = temporary('storage-evidence');
  const runs = path.join(root, 'report-viewer-sim-e2e');
  fs.mkdirSync(runs);
  const now = Date.now();
  const cases = [];
  const plan = [
    ['report_viewer_horizontal_scroll', null, 'PASS'], ['report_viewer_runtime_sentinel', 'clean', 'PASS'],
    ...['console_error', 'unhandled_rejection', 'fatal', 'delayed_post_return', 'crash_only', 'liveness_loss'].map((sentinel) => ['report_viewer_runtime_sentinel', sentinel, 'FAIL']),
    ['report_viewer_comments_keyboard', null, 'PASS'],
  ];
  for (let index = 0; index < 9; index += 1) {
    const [scenario, sentinel, expected] = plan[index];
    const passing = expected === 'PASS';
    const result = `case-${index}.json`;
    const video = `case-${index}.mp4`;
    fs.writeFileSync(path.join(runs, video), `video-${index}`);
    fs.utimesSync(path.join(runs, video), new Date(now), new Date(now));
    fs.writeFileSync(path.join(runs, result), `${JSON.stringify({
      scenario,
      verdict: passing ? 'PASS' : 'FAIL',
      artifacts: { video },
      extras: { screen_capture: { video_ready: true, video_returncode: 0, video_finalized: true, video_forced_kill: false, video_alive_after_teardown: false, video_started_at: (now - 1000) / 1000, video_finished_at: (now + 1000) / 1000 } },
    })}\n`);
    cases.push({ scenario, ...(sentinel ? { sentinel } : {}), run_id: `run-${index}`, expected, status: passing ? 0 : 1, result, sha256: digest(path.join(runs, result)) });
  }
  fs.writeFileSync(path.join(runs, 'manifest.json'), `${JSON.stringify({ status: 'passed', attempts_per_case: 1, recorder_preflight: { setup_verdict: 'PASS', outcome: 'clear' }, cases })}\n`);
  return { root, runs, cases };
}

test('nine single-attempt report-viewer results bind status, result digest, video digest, and time', () => {
  const fixture = reportViewerFixture();
  const files = require('./storage-gate.cjs').enumerateEvidence(fixture.root);
  assert.doesNotThrow(() => require('./storage-gate.cjs').validateReportViewer(fixture.root, files));
});

function fixtureWithTeardown(mutation = 'valid') {
  const fixture = reportViewerFixture();
  const name = 'case-0.teardown.json';
  const proof = { attempted: 0, closed: [], closed_count: 0, orphans: [], orphan_count: 0 };
  if (mutation === 'orphan') Object.assign(proof, { attempted: 1, orphan_count: 1, orphans: [{ stream_id: 'owned' }] });
  if (mutation === 'count') proof.attempted = 1;
  if (mutation !== 'missing') fs.writeFileSync(path.join(fixture.runs, name), mutation === 'malformed' ? '{bad' : JSON.stringify(proof));
  const resultPath = path.join(fixture.runs, 'case-0.json');
  const payload = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (mutation !== 'undeclared') payload.owned_session_teardown_sidecar = mutation === 'escape' ? `../${name}` : name;
  fs.writeFileSync(resultPath, JSON.stringify(payload));
  fixture.cases[0].sha256 = digest(resultPath);
  const manifestPath = path.join(fixture.runs, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.cases = fixture.cases;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return fixture;
}

test('report-viewer sealing admits declared zero-orphan teardown proof', () => {
  const fixture = fixtureWithTeardown();
  const gate = require('./storage-gate.cjs');
  assert.doesNotThrow(() => gate.validateReportViewer(fixture.root, gate.enumerateEvidence(fixture.root)));
});

for (const mutation of ['orphan', 'count', 'malformed', 'missing', 'escape', 'undeclared']) {
  test(`report-viewer sealing rejects teardown ${mutation}`, () => {
    const fixture = fixtureWithTeardown(mutation);
    const gate = require('./storage-gate.cjs');
    assert.throws(() => gate.validateReportViewer(fixture.root, gate.enumerateEvidence(fixture.root)),
      mutation === 'undeclared' ? /EVIDENCE_UNKNOWN_NESTED_FILE/ : /EVIDENCE_CASE_TEARDOWN/);
  });
}

test('report-viewer evidence rejects every accepted-boundary mutation independently', () => {
  for (const mutation of ['attempts', 'count', 'result-digest', 'video-missing', 'video-empty', 'video-time', 'unknown-nested', 'recorder', 'status']) {
    const fixture = reportViewerFixture();
    const manifestFile = path.join(fixture.runs, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (mutation === 'attempts') manifest.attempts_per_case = 2;
    if (mutation === 'count') manifest.cases.pop();
    if (mutation === 'result-digest') manifest.cases[0].sha256 = '0'.repeat(64);
    if (mutation === 'recorder') manifest.recorder_preflight.outcome = 'failed';
    if (mutation === 'status') manifest.cases[0].status = 1;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`);
    if (mutation === 'video-missing') fs.unlinkSync(path.join(fixture.runs, 'case-0.mp4'));
    if (mutation === 'video-empty') fs.writeFileSync(path.join(fixture.runs, 'case-0.mp4'), '');
    if (mutation === 'video-time') fs.utimesSync(path.join(fixture.runs, 'case-0.mp4'), new Date(0), new Date(0));
    if (mutation === 'unknown-nested') fs.writeFileSync(path.join(fixture.runs, 'unknown.bin'), 'unknown');
    const files = require('./storage-gate.cjs').enumerateEvidence(fixture.root);
    assert.throws(() => require('./storage-gate.cjs').validateReportViewer(fixture.root, files), /EVIDENCE_/);
  }
});

// Name deliberately carries no stage count. The previous name hardcoded 11, which is a number expected to
// change whenever a stage is added, and it read as authoritative while being stale.
test('passed evidence requires every certified stage in order with companion fields', () => {
  const fixture = reportViewerFixture();
  const stages = certifiedStages();
  const gates = stages.map((name, index) => ({ name, command: `command-${index}`, status: 0, started_at: '2026-07-17T00:00:00Z', finished_at: '2026-07-17T00:00:01Z', log: `${name}.log` }));
  fs.writeFileSync(path.join(fixture.root, '.pentacle-container.json'), '{}\n');
  fs.writeFileSync(path.join(fixture.root, 'run.json'), `${JSON.stringify({ status: 'passed', gates })}\n`);
  fs.writeFileSync(path.join(fixture.root, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: ['ios/a'] })}\n`);
  writeSurfaceTriggerEvidence(fixture.root, '00000000-0000-4000-8000-000000000000');
  for (const gate of gates) {
    fs.writeFileSync(path.join(fixture.root, `${gate.name}.json`), `${JSON.stringify(gate)}\n`);
    fs.writeFileSync(path.join(fixture.root, gate.log), 'log\n');
  }
  assert.doesNotThrow(() => require('./storage-gate.cjs').validateEvidence(fixture.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup', 0));
  const cleanupFile = path.join(fixture.root, 'cleanup.json');
  const cleanup = { schema: 1, run_id: '00000000-0000-4000-8000-000000000000', status: 'passed', simulator_deleted: true, indirections_removed: true, queue_released: true, scratch_discarded: true, completed_at: '2026-07-17T00:00:02.000Z' };
  fs.writeFileSync(cleanupFile, `${JSON.stringify(cleanup)}\n`);
  assert.doesNotThrow(() => require('./storage-gate.cjs').validateEvidence(fixture.root, cleanup.run_id, 'final', 0));
  fs.writeFileSync(cleanupFile, `${JSON.stringify({ ...cleanup, queue_released: false })}\n`);
  assert.throws(() => require('./storage-gate.cjs').validateEvidence(fixture.root, cleanup.run_id, 'final', 0), /EVIDENCE_CLEANUP_INVALID/);
  fs.writeFileSync(cleanupFile, `${JSON.stringify(cleanup)}\n`);
  const triggerFile = path.join(fixture.root, 'storage-surface-trigger.json');
  const triggerRecord = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
  fs.writeFileSync(triggerFile, `${JSON.stringify({ ...triggerRecord, status: 'skipped', reason: 'case-results-incomplete', observed_results: 0, launch: { status: 'not-attempted', error: null, pids: [] }, cleanup: { status: 'not-required', error: null, outcomes: [] } })}\n`);
  assert.throws(() => require('./storage-gate.cjs').validateEvidence(fixture.root, cleanup.run_id, 'pre-cleanup', 0), /EVIDENCE_SURFACE_TRIGGER_REQUIRED/);
  fs.writeFileSync(triggerFile, `${JSON.stringify({ ...triggerRecord, reason: 'launch-failed', launch: { status: 'failed', error: 'open failed', pids: [] }, cleanup: { status: 'not-required', error: null, outcomes: [] } })}\n`);
  assert.throws(() => require('./storage-gate.cjs').validateEvidence(fixture.root, cleanup.run_id, 'pre-cleanup', 0), /EVIDENCE_SURFACE_TRIGGER_REQUIRED/);
  fs.writeFileSync(triggerFile, `${JSON.stringify(triggerRecord)}\n`);
  fs.writeFileSync(triggerFile, `${JSON.stringify({ ...triggerRecord, cleanup: { status: 'failed', error: 'survivor', outcomes: [] } })}\n`);
  assert.throws(() => require('./storage-gate.cjs').validateEvidence(fixture.root, cleanup.run_id, 'pre-cleanup', 0), /EVIDENCE_SURFACE_TRIGGER_CLEANUP/);
  fs.writeFileSync(triggerFile, `${JSON.stringify(triggerRecord)}\n`);
  fs.unlinkSync(triggerFile);
  assert.throws(() => require('./storage-gate.cjs').validateEvidence(fixture.root, cleanup.run_id, 'pre-cleanup', 0), /EVIDENCE_REQUIRED_MISSING:storage-surface-trigger.json/);
  fs.writeFileSync(triggerFile, `${JSON.stringify(triggerRecord)}\n`);
  const runFile = path.join(fixture.root, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run.gates.reverse();
  fs.writeFileSync(runFile, `${JSON.stringify(run)}\n`);
  assert.throws(() => require('./storage-gate.cjs').validateEvidence(fixture.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup', 0), /EVIDENCE_STAGE_ORDER/);
});

test('frontmatter parser requires exact delimiters, required keys, and unique top-level fields', () => {
  const { parseFrontmatter } = require('./storage-worktrees.cjs');
  const root = temporary('storage-frontmatter');
  const file = path.join(root, 'spec.md');
  const header = '---\nid: spec_x\ntitle: X\ntype: spec\nstatus: completed\ncanonical: false\ncreated_at: 2026-07-01\nupdated_at: 2026-07-17\nsource_path: work/completed/x/spec.md\nmachine: hosta\nowner: codex\ntags:\n- storage\nsummary: X\nrelated: []\n';
  fs.writeFileSync(file, `${header}---\nbody status: in_progress\n`);
  assert.equal(parseFrontmatter(file).status, 'completed');
  for (const content of ['id: spec_x\nstatus: completed\n', '---\nid: spec_x\n---\n', '---\nid: spec_x\nid: spec_y\nstatus: completed\n---\n', '---\nid spec_x\nstatus: completed\n---\n']) {
    fs.writeFileSync(file, content);
    assert.throws(() => parseFrontmatter(file), /SOURCE_/);
  }
});

test('delete-time Git proof accepts clean behind-contained and rejects every unsafe product', () => {
  const { validateGitFacts } = require('./storage-worktrees.cjs');
  const ticket = { branch: 'fix/lane', head: 'a'.repeat(40), upstream: 'origin/fix/lane', device: '1', inode: '2' };
  const valid = { branch: ticket.branch, head: ticket.head, upstream: ticket.upstream, counts: [0, 3], device: '1', inode: '2', dirty: '', remotely_contained: true };
  assert.equal(validateGitFacts(ticket, valid), true);
  for (const [label, mutation] of [
    ['tracked dirty', { dirty: ' M tracked' }], ['staged', { dirty: 'M  staged' }], ['untracked', { dirty: '?? untracked' }], ['submodule', { dirty: ' M submodule' }],
    ['branch drift', { branch: 'other' }], ['head drift', { head: 'b'.repeat(40) }], ['upstream drift', { upstream: 'origin/other' }],
    ['ahead', { counts: [1, 0] }], ['diverged', { counts: [1, 1] }], ['not contained', { remotely_contained: false }],
    ['device drift', { device: '9' }], ['inode drift', { inode: '9' }],
  ]) assert.throws(() => validateGitFacts(ticket, { ...valid, ...mutation }), /WORKTREE_/, label);
});

test('a remote fetch error leaves retirement registered and cannot reach removal', () => {
  const { retireWorktreeHeld } = require('./storage-worktrees.cjs').bind(mutationCapability);
  const events = [];
  const ticket = { generation: 'generation', state: 'registered', registered_at: '2026-07-01T00:00:00.000Z', revision: 1 };
  assert.throws(
    () => retireWorktreeHeld('ticket', Date.parse('2026-07-03T00:00:00.000Z'), { generation: 'generation' }, 'token', {
      readRecord: () => ticket,
      creatorAlive: () => false,
      snapshot: () => { events.push('snapshot'); return { fingerprint: 'fingerprint', resolved: { repository: '/fixture/repository' } }; },
      sourceProof: () => events.push('source-proof'),
      fetchRemote: () => { events.push('fetch'); throw new Error('FETCH_FORCED'); },
      transition: () => events.push('transition'),
      replaceRecord: () => { events.push('replace'); return { ...ticket, state: 'removing' }; },
      invokeLockedRemoval: () => events.push('remove'),
    }),
    /FETCH_FORCED/,
  );
  assert.equal(ticket.state, 'registered');
  assert.deepEqual(events, ['snapshot', 'source-proof', 'fetch']);
});

test('pre-published scratch discard requires dead owner, immutable +24h, and evidence commitment', () => {
  const { DAY, runDecision } = require('./storage-janitor.cjs');
  const now = Date.parse('2026-07-17T00:00:00Z');
  const dead = { host: os.hostname(), uid: process.getuid(), pid: 2147483647 };
  const base = { state: 'running', owner: dead, first_dead_at: new Date(now - DAY).toISOString(), preliminary_audit_at: new Date(now - DAY).toISOString(), preliminary_evidence_digest: 'a'.repeat(64) };
  assert.equal(runDecision(base, now).action, 'discard-scratch');
  assert.equal(runDecision({ ...base, first_dead_at: new Date(now - DAY + 1).toISOString() }, now).action, 'retain');
  assert.equal(runDecision({ ...base, first_dead_at: null }, now).action, 'observe-dead');
  assert.equal(runDecision({ ...base, preliminary_audit_at: null }, now).action, 'retain');
  assert.equal(runDecision({ ...base, state: 'reserved', first_dead_at: null }, now).action, 'recover-reserved');
  assert.deepEqual(runDecision({ ...base, state: 'reserved' }, now), { action: 'retain', reason: 'reserved-artifacts-disposed' });
  assert.equal(runDecision({ ...base, state: 'blocked_unclassified', preliminary_audit_at: null }, now).action, 'discard-scratch');
});

test('manual failed-scratch reclamation replaces the 24-hour term and no other term', () => {
  const { DAY, runDecision } = require('./storage-janitor.cjs');
  const now = Date.parse('2026-07-17T00:00:00Z');
  const dead = { host: os.hostname(), uid: process.getuid(), pid: 2147483647 };
  const live = { host: os.hostname(), uid: process.getuid(), pid: process.pid };
  // A failure whose death a prior sweep observed one minute ago: deep inside the 24-hour wait.
  const failed = { id: 'r1', state: 'blocked_unclassified', owner: dead, first_dead_at: new Date(now - 60000).toISOString() };
  const authorized = { kind: 'reclaim-scratch', run_id: 'r1', protected: [] };
  assert.deepEqual(runDecision(failed, now), { action: 'retain', reason: 'dead-under-24h' });
  assert.deepEqual(runDecision(failed, now, authorized), { action: 'discard-scratch', reason: 'manual-failed-reclamation' });

  // Fail-closed on every term the override does NOT replace.
  assert.equal(runDecision({ ...failed, id: 'other' }, now, authorized).reason, 'dead-under-24h');
  assert.equal(runDecision(failed, now, { kind: 'reclaim-scratch', run_id: 'r1', protected: ['r1'] }).reason, 'dead-under-24h');
  assert.equal(runDecision({ ...failed, owner: live }, now, authorized).reason, 'owner-live');
  assert.equal(runDecision({ ...failed, first_dead_at: null }, now, authorized).action, 'observe-dead');
  assert.equal(runDecision({ ...failed, state: 'allocated' }, now, authorized).reason, 'dead-under-24h');

  // The automatic path is untouched: past 24 hours it still authorises on its own, with no manual reason.
  assert.deepEqual(runDecision({ ...failed, first_dead_at: new Date(now - DAY).toISOString() }, now), { action: 'discard-scratch' });
});

test('ordinary child close preserves 0, 2, and 17 with exactly-once cleanup', async () => {
  const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
  for (const code of [0, 2, 17]) {
    const child = new EventEmitter();
    child.pid = 12345;
    let cleanups = 0;
    const promise = supervise(['fake'], { spawnChild: () => child, groupAlive: () => false, cleanup: async () => { cleanups += 1; }, pollMs: 100000 });
    process.nextTick(() => child.emit('close', code, null));
    const result = await promise;
    assert.equal(result.status, code);
    assert.equal(cleanups, 1);
    assert.equal(result.machine.cleanupCount, 1);
  }
});

test('cleanup failure never turns a successful child green', async () => {
  const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
  const child = new EventEmitter();
  child.pid = 12345;
  const promise = supervise(['fake'], { spawnChild: () => child, groupAlive: () => false, cleanup: async () => { throw new Error('cleanup'); }, pollMs: 100000 });
  process.nextTick(() => child.emit('close', 0, null));
  assert.equal((await promise).status, 17);
});

test('a process-group survivor is fatal even after TERM and KILL', async () => {
  const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
  const child = new EventEmitter();
  child.pid = 12345;
  const promise = supervise(['fake'], {
    spawnChild: () => child,
    groupAlive: () => true,
    signalGroup: () => undefined,
    graceMs: 1,
    reapMs: 1,
    pollMs: 100000,
  });
  process.nextTick(() => child.emit('close', 0, null));
  const result = await promise;
  assert.equal(result.status, 17);
  assert.equal(result.machine.shutdownCause, 'survivor');
  assert.equal(result.machine.termCount, 1);
  assert.equal(result.machine.killCount, 1);
  assert.equal(result.machine.cleanupCount, 1);
});

test('graceful descendant exit preserves child status without a KILL edge', async () => {
  const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
  const child = new EventEmitter();
  child.pid = 12345;
  let probes = 0;
  const promise = supervise(['fake'], { spawnChild: () => child, groupAlive: () => probes++ === 0, signalGroup: () => undefined, cleanup: async () => undefined, graceMs: 1, reapMs: 1, pollMs: 100000 });
  process.nextTick(() => child.emit('close', 2, null));
  const result = await promise;
  assert.equal(result.status, 2);
  assert.equal(result.machine.termCount, 1);
  assert.equal(result.machine.killCount, 0);
  assert.equal(result.machine.cleanupCount, 1);
});

test('signal arriving after handlers but before spawn is preserved and exits 130', async () => {
  const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
  const child = new EventEmitter();
  child.pid = 12345;
  const result = await supervise(['fake'], {
    spawnChild() { process.emit('SIGINT'); return child; },
    signalGroup() { process.nextTick(() => child.emit('close', 0, null)); },
    groupAlive: () => false,
    cleanup: async () => undefined,
    graceMs: 5,
    pollMs: 100000,
  });
  assert.equal(result.status, 130);
  assert.deepEqual([result.machine.termCount, result.machine.killCount, result.machine.cleanupCount], [1, 0, 1]);
});

test('CLI argument mapping admits only exact endpoint arity and never path flags', () => {
  const { inputFor } = require('./storage-cli.cjs');
  assert.deepEqual(inputFor('storage:janitor', ['apply']), { mode: 'apply' });
  assert.throws(() => inputFor('storage:janitor', ['apply', '--path', '/tmp']), /FORBIDDEN_AUTHORITY/);
  assert.throws(() => inputFor('storage:install', ['/tmp']), /FORBIDDEN_AUTHORITY/);
  assert.throws(() => inputFor('storage:retire-worktree', ['/tmp/tree']), /FORBIDDEN_AUTHORITY/);
});

test('scheduler ownership requires explicit authority and rejects malformed smoke evidence', () => {
  const scheduler = require('./storage-scheduler.cjs');
  const root = temporary('storage-scheduler');
  const plist = path.join(root, 'janitor.plist');
  fs.writeFileSync(plist, '<plist>foreign</plist>');
  assert.throws(() => scheduler.plistOwned(plist), /SCHEDULER_EXPECTED_DIGEST_REQUIRED/);
  assert.equal(scheduler.plistOwned(plist, '0'.repeat(64)), false);
  fs.writeFileSync(plist, scheduler.renderPlist());
  const digest = crypto.createHash('sha256').update(scheduler.renderPlist()).digest('hex');
  const state = require('./storage-state.cjs');
  const originalListRecords = state.listRecords;
  let ambientReads = 0;
  state.listRecords = () => { ambientReads += 1; return [{ state: 'committed', candidate_digest: 'f'.repeat(64) }]; };
  try { assert.equal(scheduler.plistOwned(plist, digest), true); }
  finally { state.listRecords = originalListRecords; }
  assert.equal(ambientReads, 0, 'explicit ownership authority must not consult seeded host state');
  const expected = { transaction_id: '00000000-0000-4000-8000-000000000001', generation: '00000000-0000-4000-8000-000000000002', candidate_digest: 'a'.repeat(64) };
  const report = { schema: 1, report_id: '00000000-0000-4000-8000-000000000000', mode: 'dry-run', entries: [], errors: [], completed_at: '2026-07-17T00:00:01Z', ...expected };
  assert.equal(scheduler.validateSmokeReport(report, `${report.report_id}.json`, Date.parse('2026-07-17T00:00:00Z'), expected), true);
  for (const mutation of [{ completed_at: '2026-07-16T23:59:59Z' }, { errors: [{ error: 'failed' }] }, { mode: 'apply' }, { extra: true }]) {
    assert.throws(() => scheduler.validateSmokeReport({ ...report, ...mutation }, `${report.report_id}.json`, Date.parse('2026-07-17T00:00:00Z'), expected), /SCHEDULER_SMOKE/);
  }
  assert.throws(() => scheduler.validateSmokeReport(report, 'mtime-only.json', Date.parse('2026-07-17T00:00:00Z'), expected), /SCHEDULER_SMOKE/);
});

test('scheduler argv must exist and resolve outside the janitor-retirable worktrees root', () => {
  // renderPlist() derives ProgramArguments from __dirname, so whichever checkout runs the install is
  // baked into the LaunchAgent. fixedLayout().worktrees is the very root this janitor is authorized
  // to retire, so a plist installed from a worktree names a script the janitor may later delete -
  // after which the agent keeps firing on its interval against a missing file and fails INVISIBLY,
  // because /dev/null streams are invariant 10 by design. This is not hypothetical: the plist that
  // actually existed on this host had argv pointing inside ~/agent-workspace/worktrees.
  // The guard is two POSITIVE assertions against authority we already hold - argv must resolve
  // inside a known main repository from the installed root map, and must not resolve inside the
  // retirable worktrees root - rather than a heuristic about which directories feel permanent.
  const { assertSchedulerArgvDurable } = require('./storage-authority.cjs');
  const root = temporary('storage-scheduler-argv');
  const repository = path.join(root, 'repository');
  const worktrees = path.join(root, 'worktrees');
  const outside = path.join(root, 'outside');
  const interpreter = path.join(root, 'node');
  const layout = { repositories: { 'pentacle-mobile': repository }, worktrees };
  for (const scripts of [path.join(repository, 'scripts'), path.join(worktrees, 'lane', 'scripts'), path.join(outside, 'scripts')]) {
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'storage-cli.cjs'), '#!/usr/bin/env node\n');
  }
  fs.writeFileSync(interpreter, '#!/bin/sh\n');
  fs.chmodSync(interpreter, 0o755);
  try {
    assert.doesNotThrow(() => assertSchedulerArgvDurable(layout, path.join(repository, 'scripts'), [repository], interpreter));
    assert.throws(() => assertSchedulerArgvDurable(layout, path.join(worktrees, 'lane', 'scripts'), [repository], interpreter), /SCHEDULER_ARGV_INSIDE_WORKTREES/);
    assert.throws(() => assertSchedulerArgvDurable(layout, path.join(outside, 'scripts'), [repository], interpreter), /SCHEDULER_ARGV_OUTSIDE_KNOWN_REPOSITORY/);
    assert.throws(() => assertSchedulerArgvDurable(layout, path.join(root, 'missing-scripts'), [repository], interpreter), /SCHEDULER_ARGV_PATH_MISSING/);
    assert.throws(() => assertSchedulerArgvDurable(layout, path.join(repository, 'scripts'), [repository], path.join(root, 'missing-node')), /SCHEDULER_ARGV_PATH_MISSING/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('first install rejects an unowned existing LaunchAgent label or plist', () => {
  // The LaunchAgent label is the ONE identity that cannot be moved under the installed root, because
  // launchd's label namespace is host-global. That makes it the only place where two installed roots
  // could collide, and its collision rule is this rejection: a plist belonging to a different root
  // must never be silently adopted, or the adopting install would drive that other root on the
  // janitor cadence while believing it owns it.
  //
  // This is the falsifiable proof that the guard is load-bearing rather than assumed - loosen the
  // ownership check and this test fails. The condition is SYNTHESIZED rather than read from host
  // state: a test that passes only because of what happens to be lying around on this machine has
  // the same hermeticity defect as the scheduler-digest default above.
  const previousHome = process.env.HOME;
  const home = temporary('storage-unowned-label');
  process.env.HOME = home;
  try {
    const { fixedLayout } = require('./storage-authority.cjs');
    const { installOrUpdate } = require('./storage-scheduler.cjs').bind(mutationCapability);
    const launchAgent = fixedLayout().launchAgent;
    assert.ok(launchAgent.startsWith(home), 'fixture must resolve the LaunchAgent inside the isolated home');
    fs.mkdirSync(path.dirname(launchAgent), { recursive: true, mode: 0o700 });
    fs.writeFileSync(launchAgent, '<plist>owned by a different installed root</plist>');
    assert.throws(() => installOrUpdate('install'), /SCHEDULER_EXISTING_LABEL_OR_PLIST/);
  } finally {
    process.env.HOME = previousHome;
  }
});

test('macOS sandbox permits capped roots and rejects a sibling write escape', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const root = temporary('storage-sandbox-live');
  const roots = ['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return fs.realpathSync(target); });
  const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
  const allowed = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', path.join(roots[0], 'allowed')]);
  assert.equal(allowed.status, 0);
  const readable = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/ls', roots[2]]);
  assert.equal(readable.status, 0);
  const stateWrite = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', path.join(roots[2], 'forbidden')]);
  assert.notEqual(stateWrite.status, 0);
  assert.equal(fs.existsSync(path.join(roots[2], 'forbidden')), false);
  const escaped = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', path.join(root, 'escape')]);
  assert.notEqual(escaped.status, 0);
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);
});

// BEHAVIOURAL, never a source-shape assertion. A test that greps the rendered profile for "signal" passes
// whether or not the sandbox actually permits anything - the exact vacuous shape this lane has paid for
// repeatedly - so this runs a real sandboxed process signalling a real child under the REAL rendered
// profile. The negative half is a PLACEBO CONTROL, not an extra case: it re-renders with (target self)
// substituted for (target same-sandbox) and requires the SAME probe to be denied. Without it, a future change
// that made the signal succeed for an unrelated reason would leave this green while the profile line had
// silently stopped mattering, and nobody would learn that until a gate run died at the recorder preflight
// again. Positive control first, per 11.5. The probe deliberately sends SIGINT to a DIRECT child, which is
// the precise operation the certified ScreenCapture.__exit__ performs on its simctl child.
const SANDBOX_SIGNAL_PROBE = [
  "const { spawn } = require('node:child_process');",
  // unref'd, and short: under the placebo the SIGKILL is denied too, so an attached handle would hold
  // node's loop open for the child's full lifetime and turn a control into a multi-second stall.
  "const child = spawn('/bin/sleep', ['2'], { stdio: 'ignore' });",
  "child.unref();",
  "try { process.kill(child.pid, 'SIGINT'); console.log('signalled'); }",
  "catch (error) { console.log(error.code || String(error)); }",
  "finally { try { process.kill(child.pid, 'SIGKILL'); } catch { /* denied too under the placebo */ } }",
].join('');

test('macOS sandbox permits signalling own direct children, and the grant is what permits it', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const root = temporary('storage-sandbox-signal');
  const roots = ['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return fs.realpathSync(target); });
  const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
  const probe = (rendered) => spawnSync('/usr/bin/sandbox-exec', ['-p', rendered, process.execPath, '-e', SANDBOX_SIGNAL_PROBE], { encoding: 'utf8' });

  const permitted = probe(profile);
  assert.equal(permitted.status, 0);
  assert.equal(String(permitted.stdout).trim(), 'signalled');

  // Narrowing the target to `self` must NOT be enough. If this substitution ever stops biting the rendered
  // profile the assertion below fails loudly rather than degrading into a second copy of the positive case.
  const narrowed = profile.replace('(allow signal (target same-sandbox))', '(allow signal (target self))');
  assert.notEqual(narrowed, profile);
  const denied = probe(narrowed);
  assert.equal(denied.status, 0);
  assert.equal(String(denied.stdout).trim(), 'EPERM');
});

test('A: the sandbox cannot signal a synthetic stale companion', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, async () => {
  const child = syntheticCompanion({ orphan: true });
  const socket = path.join('/private/tmp/idb', `h1-negative-${process.pid}.sock`);
  try {
    fs.writeFileSync(socket, 'synthetic');
    const root = temporary('storage-host-reap-sandbox');
    const roots = ['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return target; });
    const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
    const probe = "const fs=require('node:fs');const pid=Number(process.argv[1]);const socket=process.argv[2];let signal='sent';try{process.kill(pid,'SIGTERM')}catch(error){signal=error.code}let socketRemoved=true;try{fs.rmSync(socket)}catch{socketRemoved=false}process.stdout.write(JSON.stringify({signal,socketRemoved}))";
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', probe, String(child.pid), socket], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { signal: 'EPERM', socketRemoved: true });
    assert.equal(childAlive(child), true);
  } finally {
    fs.rmSync(socket, { force: true });
    await stopSyntheticCompanion(child);
  }
});

test('D: the rendered sandbox profile cannot signal a non-child host process', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const root = temporary('storage-host-reap-privilege');
  const roots = ['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return target; });
  const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
  // `process.pid` belongs to the host test process; the sandboxed probe is its grandchild, never its child.
  // Signal 0 exercises the sandbox signal permission without risking a live host-process mutation.
  const probe = "try{process.kill(Number(process.argv[1]),0);process.stdout.write('sent')}catch(error){process.stdout.write(error.code)}";
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', probe, String(process.pid)], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'EPERM');
});

// Host preference access. Tested against a THROWAWAY domain so nothing of the operator's is touched,
// and every status is read from spawnSync directly - never through a pipe, where `$?` would be the
// last stage's and would report success for a failed `defaults`.
//
// The read half needs a control the signal test did not: its failure mode is not a denial but a
// FABRICATED "does not exist" for a key that is present on the host, so a positive-only test would
// pass just as happily against a profile whose grant had silently stopped matching. The two negative
// controls below are what stop that, and they are why the shm name being uid-derived is load-bearing
// rather than cosmetic - on a machine where it stopped matching, this test goes red instead of the
// gate silently deleting the operator's preferences.
test('macOS sandbox reads host preferences truthfully and writes only the two guarded domains', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const root = temporary('storage-sandbox-preferences');
  const roots = ['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return fs.realpathSync(target); });
  const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
  const domain = `com.pentacle.storagegate.test-${crypto.randomUUID()}`;
  const defaultsIn = (rendered, ...args) => spawnSync('/usr/bin/sandbox-exec', ['-p', rendered, '/usr/bin/defaults', ...args], { encoding: 'utf8' });
  const hostDefaults = (...args) => spawnSync('/usr/bin/defaults', args, { encoding: 'utf8' });

  try {
    assert.equal(hostDefaults('write', domain, 'probeKey', '-bool', 'true').status, 0);

    // Positive: the container reads the TRUE host value, not an empty volatile store.
    const read = defaultsIn(profile, 'read', domain, 'probeKey');
    assert.equal(read.status, 0);
    assert.equal(String(read.stdout).trim(), '1');

    // Control 1 - the shm lines are load-bearing. Removing them must NOT merely deny the read: it
    // must produce the fabricated-absent answer, which is the specific hazard being guarded.
    const withoutShm = profile.split('\n').filter((line) => !line.startsWith('(allow ipc-posix-shm')).join('\n');
    assert.notEqual(withoutShm, profile);
    const unmapped = defaultsIn(withoutShm, 'read', domain, 'probeKey');
    assert.notEqual(unmapped.status, 0);
    assert.match(String(unmapped.stderr), /does not exist/);

    // Control 2 - the grant must match the region EXACTLY. One altered character and the read
    // silently degrades again, so a stale hardcoded uid cannot pass this test.
    const wrongName = profile.replace(/apple\.cfprefs\.\d+v1/g, 'apple.cfprefs.0v1');
    assert.notEqual(wrongName, profile);
    const mismatched = defaultsIn(wrongName, 'read', domain, 'probeKey');
    assert.notEqual(mismatched.status, 0);
    assert.match(String(mismatched.stderr), /does not exist/);

    // Privilege cost, to the layer-11 standard: a NON-granted domain is denied, and the host value
    // it would have changed is untouched.
    const refused = defaultsIn(profile, 'write', domain, 'probeKey', '-bool', 'false');
    assert.notEqual(refused.status, 0);
    assert.match(String(refused.stderr), /Could not write domain/);
    assert.equal(String(hostDefaults('read', domain, 'probeKey').stdout).trim(), '1');

    // ...and the `user-preference-write` line is what permits the granted ones. Substituting the
    // throwaway domain into a real grant proves the FORM permits the write, without this test ever
    // mutating com.apple.iphonesimulator or com.apple.CrashReporter on the operator's machine.
    const granted = profile.replace('(allow user-preference-write (preference-domain "com.apple.iphonesimulator"))', `(allow user-preference-write (preference-domain "${domain}"))`);
    assert.notEqual(granted, profile);
    const permitted = defaultsIn(granted, 'write', domain, 'probeKey', '-bool', 'false');
    assert.equal(permitted.status, 0);
    assert.equal(String(hostDefaults('read', domain, 'probeKey').stdout).trim(), '0');

    // The write grant is a CLOSED set: exactly these two domains, and no third line can appear
    // without this assertion failing.
    const writeLines = profile.split('\n').filter((line) => line.startsWith('(allow user-preference-write'));
    assert.deepEqual(writeLines, [
      '(allow user-preference-write (preference-domain "com.apple.iphonesimulator"))',
      '(allow user-preference-write (preference-domain "com.apple.CrashReporter"))',
    ]);
  } finally {
    // `defaults delete` empties the domain but leaves an EMPTY plist registered, so cleaning up
    // with it alone litters one file per run in the operator's ~/Library/Preferences - measured,
    // and precisely the unreclaimed-host-state pattern this whole item exists to end. Unlink the
    // backing file too, and assert the cleanup worked rather than trusting it.
    hostDefaults('delete', domain);
    const plist = path.join(os.homedir(), 'Library', 'Preferences', `${domain}.plist`);
    fs.rmSync(plist, { force: true });
    assert.equal(fs.existsSync(plist), false);
  }
});

// ---------------------------------------------------------------------------------------------------
// Host-temporary reclamation. This is DELETION AUTHORITY in a shared host directory, so it is tested the
// way the install-time ownership guard was: synthesized, not hostdependent, with a positive control that
// proves deletion actually happens (so the negative controls cannot pass vacuously) and one control per
// conjunct. Entries are created under this run's real per-user temporary directory because that is the
// only place the function operates; every name carries a test-unique udid so a concurrent build cannot
// collide, and the finally block removes whatever survived.
const hostTemporaryRoot = require('./storage-sandbox.cjs').hostTemporaryRoot;
const { assertClosedHostTemporaryClasses, assertClosedIdbClasses, snapshotHostTemporary, snapshotIdbArtifacts } = require('./storage-gate.cjs');
const { reapHostSimulatorSubstrate, reclaimHostTemporary, reclaimIdbArtifacts } = require('./storage-gate.cjs').bind(mutationCapability);
const { idbRoot } = require('./storage-sandbox.cjs');

function simDeviceEntry(udid) { return `com.apple.CoreSimulator.SimDevice.${udid}.Standalone.${crypto.randomUUID()}`; }

test('host temporary reclamation deletes this run own devices and nothing else', () => {
  const root = hostTemporaryRoot();
  const ownUdid = crypto.randomUUID();
  const foreignUdid = crypto.randomUUID();
  const preexisting = path.join(root, simDeviceEntry(ownUdid));
  fs.mkdirSync(preexisting);
  const created = [preexisting];
  try {
    const before = snapshotHostTemporary();
    const own = path.join(root, simDeviceEntry(ownUdid));
    const foreign = path.join(root, simDeviceEntry(foreignUdid));
    const unrelated = path.join(root, `pentacle-behavior-unrelated-${crypto.randomUUID()}`);
    for (const target of [own, foreign, unrelated]) { fs.mkdirSync(target); created.push(target); }
    // Non-empty, so a positive result also proves recursive removal rather than an empty-dir rmdir.
    fs.writeFileSync(path.join(own, 'payload'), 'x');

    reclaimHostTemporary(before, [ownUdid]);

    assert.equal(fs.existsSync(own), false, 'own-udid entry created after the snapshot must be reclaimed');
    assert.equal(fs.existsSync(foreign), true, 'a concurrent simulator user device must never be touched');
    assert.equal(fs.existsSync(unrelated), true, 'a name outside the enumerated class must never be touched');
    assert.equal(fs.existsSync(preexisting), true, 'an entry older than the snapshot must never be touched');
  } finally {
    for (const target of created) fs.rmSync(target, { recursive: true, force: true });
  }
});

// idb artefact reclamation. This is the OTHER half of the /private/tmp/idb write exemption - the
// exemption is admitted only because this bounds it - so it is tested to the same standard as the host
// temporary root above: synthesized rather than hostdependent, a positive control so the negative
// assertions cannot pass vacuously, and one control per conjunct. Every name carries a test-unique udid
// so a concurrent gate cannot collide, and the finally block removes whatever survived.
test('idb artifact reclamation deletes this run own companion socket and log and nothing else', () => {
  const root = idbRoot();
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const ownUdid = crypto.randomUUID();
  const foreignUdid = crypto.randomUUID();
  const preexistingSocket = path.join(root, `${ownUdid}_companion.sock`);
  const preexistingLog = path.join(logs, ownUdid);
  fs.writeFileSync(preexistingSocket, '');
  fs.writeFileSync(preexistingLog, 'older than the snapshot');
  const created = [preexistingSocket, preexistingLog];
  try {
    const before = snapshotIdbArtifacts();
    // Re-created AFTER the snapshot under a second udid, which is what a real run does.
    const runUdid = crypto.randomUUID();
    const ownSocket = path.join(root, `${runUdid}_companion.sock`);
    const ownLog = path.join(logs, runUdid);
    const foreignSocket = path.join(root, `${foreignUdid}_companion.sock`);
    const foreignLog = path.join(logs, foreignUdid);
    const unrelated = path.join(root, `pentacle-behavior-unrelated-${crypto.randomUUID()}`);
    const registry = path.join(root, 'state');
    const registryExisted = fs.existsSync(registry);
    if (!registryExisted) fs.writeFileSync(registry, '[]');
    for (const target of [ownSocket, ownLog, foreignSocket, foreignLog, unrelated]) { fs.writeFileSync(target, 'x'); created.push(target); }
    if (!registryExisted) created.push(registry);

    const outcome = reclaimIdbArtifacts(before, [runUdid]);

    // The outcome is REPORTED on every run, so it must name what it removed and count what it left.
    // Without this the reclamation deletes the only evidence of whether a companion ever existed.
    assert.deepEqual(outcome.reclaimed.sort(), [`${runUdid}_companion.sock`, path.join('logs', runUdid)].sort());
    assert.equal(outcome.unreclaimed, 2, 'the two foreign-udid artifacts must be COUNTED, not deleted');
    assert.equal(outcome.skipped, null);

    assert.equal(fs.existsSync(ownSocket), false, 'this run own companion socket must be reclaimed');
    assert.equal(fs.existsSync(ownLog), false, 'this run own companion log must be reclaimed - it is the measured unbounded vector');
    assert.equal(fs.existsSync(foreignSocket), true, 'a concurrent idb user socket must never be touched');
    assert.equal(fs.existsSync(foreignLog), true, 'a concurrent idb user log must never be touched');
    assert.equal(fs.existsSync(unrelated), true, 'a name outside the enumerated classes must never be touched');
    assert.equal(fs.existsSync(preexistingSocket), true, 'a socket older than the snapshot must never be touched');
    assert.equal(fs.existsSync(preexistingLog), true, 'a log older than the snapshot must never be touched');
    assert.equal(fs.existsSync(registry), true, 'idb shared cross-run registry `state` must never be reclaimed');
  } finally {
    for (const target of created) fs.rmSync(target, { recursive: true, force: true });
  }
});

test('idb reclamation fails the run when too much is left unreclaimed, and the class set is closed', () => {
  const root = idbRoot();
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const created = [];
  try {
    const before = snapshotIdbArtifacts();
    // Foreign-udid sockets are counted, never deleted. One over the backstop must fail the run rather
    // than let pathological concurrent activity grow the host silently.
    for (let index = 0; index <= 8; index += 1) {
      const target = path.join(root, `${crypto.randomUUID()}_companion.sock`);
      fs.writeFileSync(target, 'x');
      created.push(target);
    }
    assert.throws(() => reclaimIdbArtifacts(before, [crypto.randomUUID()]), /GATE_IDB_UNRECLAIMED:9/);
    for (const target of created) assert.equal(fs.existsSync(target), true, 'counting must never imply deleting');
  } finally {
    for (const target of created) fs.rmSync(target, { recursive: true, force: true });
  }

  assert.deepEqual(assertClosedIdbClasses(['_companion.sock', 'logs']), ['_companion.sock', 'logs']);
  assert.throws(() => assertClosedIdbClasses(['_companion.sock']), /GATE_IDB_CLASS_SET/);
  assert.throws(() => assertClosedIdbClasses(['_companion.sock', 'logs', 'state']), /GATE_IDB_CLASS_SET/);
});

test('the sandbox profile admits the idb root, and a missing snapshot reclaims nothing', () => {
  const profile = require('./storage-sandbox.cjs').profileForRun();
  assert.match(profile, /\(allow file-write\* \(subpath "\/private\/tmp\/idb"\)\)/);
  // NOT the /tmp symlink form: a rule written against it does not match, the same trap the Darwin
  // temporary root documents for /var.
  assert.equal(profile.includes('(allow file-write* (subpath "/tmp/idb"))'), false);
  // A run that died before taking its snapshot must reclaim nothing rather than treat every artefact
  // on the host as new - and must SAY it skipped, so a reader can tell that from "ran and found nothing".
  assert.deepEqual(reclaimIdbArtifacts(null, []), { reclaimed: [], unreclaimed: 0, skipped: 'no-snapshot' });
});

test('host temporary reclamation is inert without a snapshot and fails loudly past the backstop', () => {
  const root = hostTemporaryRoot();
  const ownUdid = crypto.randomUUID();
  const survivor = path.join(root, simDeviceEntry(ownUdid));
  fs.mkdirSync(survivor);
  const created = [survivor];
  try {
    // No snapshot means we cannot tell new from pre-existing, so the function must delete nothing at all.
    reclaimHostTemporary(null, [ownUdid]);
    assert.equal(fs.existsSync(survivor), true);

    const before = snapshotHostTemporary();
    const foreignUdid = crypto.randomUUID();
    for (let index = 0; index <= 64; index += 1) {
      const target = path.join(root, simDeviceEntry(foreignUdid));
      fs.mkdirSync(target);
      created.push(target);
    }
    assert.throws(() => reclaimHostTemporary(before, [ownUdid]), /GATE_HOST_TEMPORARY_UNRECLAIMED:65/);
  } finally {
    for (const target of created) fs.rmSync(target, { recursive: true, force: true });
  }
});

test('the reclaimed host temporary class set is closed and order-sensitive', () => {
  assert.deepEqual(assertClosedHostTemporaryClasses(['com.apple.CoreSimulator.SimDevice.']), ['com.apple.CoreSimulator.SimDevice.']);
  // The two classes removed for being unscopable must not come back by accident.
  assert.throws(() => assertClosedHostTemporaryClasses(['com.apple.CoreSimulator.SimDevice.', 'ibtoold-']), /GATE_HOST_TEMPORARY_CLASS_SET/);
  assert.throws(() => assertClosedHostTemporaryClasses(['actool-sprite-atlas-scratch-']), /GATE_HOST_TEMPORARY_CLASS_SET/);
  assert.throws(() => assertClosedHostTemporaryClasses([]), /GATE_HOST_TEMPORARY_CLASS_SET/);
  assert.throws(() => assertClosedHostTemporaryClasses('com.apple.CoreSimulator.SimDevice.'), /GATE_HOST_TEMPORARY_CLASS_SET/);
});

test('a capped root nested inside the host global temporary root is rejected', () => {
  // Admitting the per-user temporary directory as a host-global write root means a capped root placed
  // under it would inherit a blanket write grant on the cap's own parent. renderProfile's disjointness
  // check is what prevents that, and this is the case that had no coverage before the exemption existed.
  const root = hostTemporaryRoot();
  const writable = fs.mkdtempSync(path.join(root, 'storage-nested-cap-'));
  const sibling = temporary('storage-nested-sibling');
  const state = temporary('storage-nested-state');
  try {
    const { renderProfile } = require('./storage-sandbox.cjs');
    assert.throws(() => renderProfile({ writeRoots: [writable, sibling], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
    assert.throws(() => renderProfile({ writeRoots: [sibling, writable], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
    assert.throws(() => renderProfile({ writeRoots: [sibling, temporary('storage-nested-other')], readOnlyRoots: [writable] }), /SANDBOX_ROOT_IDENTITY/);
    // Control: the same shape entirely outside the host-global root renders fine, so the rejection above
    // is caused by the nesting and not by the roots being synthesized.
    assert.match(renderProfile({ writeRoots: [sibling, temporary('storage-nested-ok')], readOnlyRoots: [state] }), /\(deny default\)/);
  } finally {
    for (const target of [writable, sibling, state]) fs.rmSync(target, { recursive: true, force: true });
  }
});

test('evidence admits the certified export directory and still rejects unknown top-level directories', () => {
  // The blocking defect QA found: with the ios-export indirection removed, expo leaves a real directory at
  // the evidence root, and the validator admitted only report-viewer-sim-e2e - so a fully green gate still
  // threw EVIDENCE_UNKNOWN_DIRECTORY at sealing. It was unreachable before only because cleanup threw first.
  const root = temporary('storage-evidence-dirs');
  try {
    fs.mkdirSync(path.join(root, 'ios-export', '_expo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ios-export', '_expo', 'bundle.js'), 'bundle');
    fs.mkdirSync(path.join(root, 'report-viewer-sim-e2e'));
    const { enumerateEvidence } = require('./storage-gate.cjs');
    const files = enumerateEvidence(root);
    assert.ok(files.some((entry) => entry.relative === 'ios-export/_expo/bundle.js'), 'export files must enter the manifest and digest, not sit in a hole');
    fs.mkdirSync(path.join(root, 'not-a-stage'));
    assert.throws(() => enumerateEvidence(root), /EVIDENCE_UNKNOWN_DIRECTORY:not-a-stage/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('names outside the enumerated class are ignored entirely and never counted against the backstop', () => {
  // The enumerated-class conjunct is load-bearing for the COUNTER, not just for deletion: a name outside
  // the class already fails the udid check, but without the class filter it would fall through to the
  // unreclaimed tally, so unrelated host activity could trip the backstop and fail an otherwise healthy
  // run. Enough noise to exceed the limit proves the filter runs before the tally.
  const root = hostTemporaryRoot();
  const created = [];
  try {
    const before = snapshotHostTemporary();
    for (let index = 0; index <= 64; index += 1) {
      const target = path.join(root, `pentacle-behavior-noise-${crypto.randomUUID()}`);
      fs.mkdirSync(target);
      created.push(target);
    }
    assert.doesNotThrow(() => reclaimHostTemporary(before, [crypto.randomUUID()]));
    for (const target of created) assert.equal(fs.existsSync(target), true, 'unrelated names must survive untouched');
  } finally {
    for (const target of created) fs.rmSync(target, { recursive: true, force: true });
  }
});

test('wrapper stage lists stay derived-equal to the certified gate execution order', () => {
  // THE point of this test: the wrapper keeps its own copy of the certified gate's stage sequence, and
  // nothing detected drift between them. release-sim-reset was added to full-gate.cjs and neither wrapper
  // copy learned, so a green twelve-stage run would have died at the seal - and the old suite stayed green
  // because its test ENCODED the stale eleven instead of checking them. A copy is fine; disagreeing is not.
  //
  // SOURCE ORDER IS NOT EXECUTION ORDER, and asserting against source order would be actively harmful: the
  // seven release-sim stages are defined in a helper EARLIER in the file than focused-jest/serial-jest/
  // typecheck/ios-export, but the helper is CALLED after them. A file-order scan yields the release block
  // first, which would fail against a correct wrapper array and tempt someone into "fixing" the wrapper to
  // match - producing EVIDENCE_STAGE_ORDER at the seal, because validateCertifiedStages compares against
  // the order the gate actually RAN. So the derivation expands the helper AT ITS CALL SITE.
  const gateSource = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const certifiedSource = fs.readFileSync(path.join(__dirname, 'full-gate.cjs'), 'utf8');
  const quotedNames = (line) => [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]);

  // Every pattern below matches ANY quoted name. A character class like [a-z-] silently misses sim-e2e on
  // the digit, and an under-matching pattern would pass by seeing fewer stages on BOTH sides.
  const NAME = /runGate\(\s*'([^']+)'/;
  const helperNames = [...certifiedSource.matchAll(/evidence\.push\(runGate\(\s*'([^']+)'/g)].map((match) => match[1]);
  const derived = [];
  for (const [, argument] of certifiedSource.matchAll(/summary\.gates\.push\(([^;]*)\);/g)) {
    const direct = argument.match(NAME);
    if (direct) { derived.push(direct[1]); continue; }
    if (/\.\.\.\w+\.evidence/.test(argument)) { derived.push(...helperNames); continue; }
    const variable = argument.trim().match(/^(\w+)$/);
    const bound = variable && certifiedSource.match(new RegExp(`const\\s+${variable[1]}\\s*=\\s*runGate\\(\\s*'([^']+)'`));
    // Fail loudly rather than skip. An unresolvable push means the derivation has gone stale against the
    // certified gate, which is precisely the condition this test exists to surface.
    assert.ok(bound, `unresolvable gate push, derivation is stale: ${argument.trim()}`);
    derived.push(bound[1]);
  }

  // Anti-under-match cross-check: the ordered derivation must have exactly the same membership as a flat
  // scan of every runGate call site. If the push-site walk missed a site, or the helper expansion dropped
  // one, these sets diverge - so the test cannot pass by seeing fewer stages on both sides.
  const flat = [...certifiedSource.matchAll(new RegExp(NAME.source, 'g'))].map((match) => match[1]);
  assert.deepEqual([...derived].sort(), [...flat].sort(), 'ordered derivation must cover every runGate call site');
  assert.equal(derived.length, 12, `expected 12 certified stages, derived ${derived.length}: ${derived.join(',')}`);
  assert.equal(new Set(derived).size, derived.length, 'certified stage names must be unique');
  for (const trap of ['sim-e2e', 'release-sim-reset']) assert.ok(derived.includes(trap), `derivation missed ${trap}`);

  const lines = gateSource.split('\n');
  const stages = quotedNames(lines.find((line) => line.includes('const stages = [')));
  const stageFiles = quotedNames(lines.find((line) => line.includes('const stageFiles = new Set([')));

  assert.deepEqual(stages, stageFiles, 'the wrapper two stage copies must not disagree with each other');
  // ORDER-SENSITIVE across all twelve, not a set compare. A set compare would catch a missing stage but
  // silently drop the ordering property that EVIDENCE_STAGE_ORDER enforces at the seal.
  assert.deepEqual(stages, derived, 'wrapper stage list must equal the certified gate execution order exactly');
});

test('SIGTERM shutdown is preserved and exits 143 by both the cause and the signal path', async () => {
  // AC2 names 0/nonzero/130/143. exitStatus has implemented 143 at storage-supervisor.cjs:53 and :56
  // since it was written, but NO test anywhere named 143 - the audit found zero occurrences across every
  // test file. "Implemented and unproven" is exactly how the stage-list defect survived four review
  // rounds, so the guarantee is asserted here rather than assumed.
  const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
  const { exitStatus } = require('./storage-supervisor.cjs');

  // Both routes to 143 independently: an operator-initiated shutdown cause, and a child reaped on the
  // signal with no cause recorded. SIGINT's 130 is asserted alongside so a blanket return cannot pass.
  assert.equal(exitStatus(null, null, 'SIGTERM'), 143);
  assert.equal(exitStatus(null, 'SIGTERM', undefined), 143);
  assert.equal(exitStatus(null, null, 'SIGINT'), 130);
  assert.notEqual(exitStatus(0, null, undefined), 143);

  const child = new EventEmitter();
  child.pid = 12346;
  const result = await supervise(['fake'], {
    spawnChild() { process.emit('SIGTERM'); return child; },
    signalGroup() { process.nextTick(() => child.emit('close', 0, null)); },
    groupAlive: () => false,
    cleanup: async () => undefined,
    graceMs: 5,
    pollMs: 100000,
  });
  assert.equal(result.status, 143, 'a SIGTERM shutdown must not be reported as a clean 0');
});

test('inherited sim-queue ancestry uses the wrapper verdict and fails closed on mismatch', () => {
  // Instance one. The verdict is resolved outside the sandbox by the process that acquired the ticket and
  // spawned the child, which is strictly more authoritative than a ppid walk. It must never become a
  // default-yes: an inherited ticket accepted on presentation alone is the antipattern this check exists
  // for. Independent of the broker on purpose, so a broker failure cannot degrade a security control.
  const { ownerIsAncestor } = require('./sim-resource-guard.cjs');
  const processObject = { pid: 4242, ppid: 4241 };
  const refuse = () => { throw new Error('ps must not be consulted when a verdict was supplied'); };
  assert.equal(ownerIsAncestor(99, processObject, refuse, { SIM_QUEUE_OWNER_VERIFIED_PID: '99' }), true);
  assert.equal(ownerIsAncestor(99, processObject, refuse, { SIM_QUEUE_OWNER_VERIFIED_PID: '100' }), false, 'a mismatched verdict must not pass');
  assert.equal(ownerIsAncestor(99, processObject, refuse, { SIM_QUEUE_OWNER_VERIFIED_PID: '' }), false, 'an empty verdict must not pass');
  assert.equal(ownerIsAncestor(99, processObject, refuse, { SIM_QUEUE_OWNER_VERIFIED_PID: 'yes' }), false, 'a non-numeric verdict must not pass');
});


test('a failed run seals with partial report-viewer evidence while a passed run stays strict', () => {
  // LAYER 8. validateReportViewer used to demand manifest.status passed AND exactly 9 cases whenever the
  // directory merely existed, so NO failed run could ever seal - every failure landed blocked_unclassified
  // with a classification_error describing the MANIFEST instead of the real cause. Measured at run
  // example-a: sim-e2e died with 0 cases and recorder_preflight null, and the record said
  // EVIDENCE_CASE_MANIFEST_INVALID. Now symmetric with validateCertifiedStages, which already compared a
  // prefix for a failed run.
  const fixture = reportViewerFixture();
  const files = require('./storage-gate.cjs').enumerateEvidence(fixture.root);
  const manifestFile = path.join(fixture.runs, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // The exact shape the real failed run produced: died before any case, no preflight recorded.
  // A run that died before any case produced no case artifacts either - leaving the fixture's files on
  // disk while removing them from the manifest is a DIFFERENT failure (undeclared files), which the
  // unknown-nested-file check correctly rejects and which must stay rejected.
  for (const stale of fs.readdirSync(fixture.runs)) if (stale !== 'manifest.json') fs.rmSync(path.join(fixture.runs, stale), { force: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, status: 'failed', cases: [], recorder_preflight: null })}\n`);
  const partial = require('./storage-gate.cjs').enumerateEvidence(fixture.root);
  assert.doesNotThrow(() => require('./storage-gate.cjs').validateReportViewer(fixture.root, partial, 'failed'), 'a failed run must be able to seal');
  assert.throws(() => require('./storage-gate.cjs').validateReportViewer(fixture.root, partial, 'passed'), /EVIDENCE_CASE_MANIFEST_INVALID/, 'a passed run must still be strict');

  // A partial run is not an unchecked run: cases that ARE present stay fully validated, and the default
  // stays strict so every existing caller is unchanged.
  const rebuilt = reportViewerFixture();
  const rebuiltManifest = path.join(rebuilt.runs, 'manifest.json');
  const base = JSON.parse(fs.readFileSync(rebuiltManifest, 'utf8'));
  for (const entry of base.cases.slice(2)) { fs.rmSync(path.join(rebuilt.runs, entry.result), { force: true }); fs.rmSync(path.join(rebuilt.runs, `case-${base.cases.indexOf(entry)}.mp4`), { force: true }); }
  fs.writeFileSync(rebuiltManifest, `${JSON.stringify({ ...base, status: 'failed', cases: base.cases.slice(0, 2).map((entry, index) => (index === 0 ? { ...entry, sha256: '0'.repeat(64) } : entry)) })}\n`);
  const tampered = require('./storage-gate.cjs').enumerateEvidence(rebuilt.root);
  assert.throws(() => require('./storage-gate.cjs').validateReportViewer(rebuilt.root, tampered, 'failed'), /EVIDENCE_CASE_RESULT_DIGEST/, 'a failed run still binds the digests of the cases it did run');
  assert.throws(() => require('./storage-gate.cjs').validateReportViewer(rebuilt.root, tampered), /EVIDENCE_CASE_/, 'the default must remain strict');
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(rebuilt.root, { recursive: true, force: true });
});

test('the failing child stage is lifted into the journal on every path that records a failure', () => {
  // Fix C arrived in three instalments, each found only when the previous one was seen to have stopped
  // short (R1): the cleanup path, then the seal-FAILURE path, then the seal-SUCCEEDED-but-gate-FAILED
  // path measured at run example-b. The lift is now ONE function with three call sites rather than three
  // hand-copied expressions, so the fourth site cannot be the one that forgets (R6).
  const { withChildStage } = require('./storage-gate.cjs');
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'child-stage-'));
  try {
    // POSITIVE CONTROL first: without it every assertion below could pass on a function that always
    // returns its input unchanged.
    fs.writeFileSync(path.join(evidence, 'run.json'), `${JSON.stringify({ status: 'failed', error: 'sim-e2e failed', gates: [] })}\n`);
    assert.equal(withChildStage(evidence, 'GATE_STATUS_NONZERO:1'), 'GATE_STATUS_NONZERO:1 child=sim-e2e failed');
    // BEST-EFFORT BY DESIGN, in three directions - a run that died before writing run.json, one that
    // wrote it without an error, and an unreadable image - must each degrade to the bare message rather
    // than throw. A throw here lands inside a catch on the error path and would erase the real cause.
    fs.writeFileSync(path.join(evidence, 'run.json'), `${JSON.stringify({ status: 'failed', gates: [] })}\n`);
    assert.equal(withChildStage(evidence, 'GATE_STATUS_NONZERO:1'), 'GATE_STATUS_NONZERO:1');
    fs.writeFileSync(path.join(evidence, 'run.json'), 'not json\n');
    assert.equal(withChildStage(evidence, 'X'), 'X');
    fs.rmSync(path.join(evidence, 'run.json'));
    assert.equal(withChildStage(evidence, 'X'), 'X');
    assert.equal(withChildStage(undefined, 'X'), 'X');
  } finally { fs.rmSync(evidence, { recursive: true, force: true }); }
  // The call sites themselves are source-checked, and this assertion is honest about what it does NOT
  // prove: that the three sites are the RIGHT three. runFullGate cannot be exercised in-process - it
  // needs sandbox-exec, simctl and two mounted images - so the property that a failed run's record
  // actually carries a cause is pinned where it CAN be observed: as a record invariant in
  // storage-state.cjs, tested below, which no code path can write around.
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  // The lookbehind excludes the DEFINITION, which otherwise inflates the count by one and would let a
  // deleted call site read as present - the same trap the previous version of this check called out.
  assert.equal((gate.match(/(?<!function )withChildStage\(evidence, /g) || []).length, 3, 'cleanup path, seal-failure path and seal-succeeded-but-gate-failed path must all lift the child stage');
  assert.equal((gate.match(/(?<!function )childStageFailure\(evidence\)/g) || []).length, 1, 'exactly one place computes the lift');
});

test('a run cannot record a non-zero gate status without recording why', () => {
  // Run example-b's journal: gate_status 1, failure null, classification_error null, because the run
  // sealed successfully AS A FAILED RUN and took neither error handler. The cause was recoverable only
  // by re-attaching the evidence image.
  //
  // Enforced ON WRITE, never on read. The first version of this lived in validateRecord, which readRecord
  // and listRecords also call, so it applied retroactively to a corpus that already existed and took the
  // janitor's enumeration out entirely. R7. The write-path behaviour is pinned in
  // storage-qa-regressions.test.cjs, where the capability to write records is available; what this test
  // pins is the OTHER half - that READING those records is untouched.
  const { validateRecord } = require('./storage-state.cjs');
  const base = {
    schema: 1, id: '11111111-1111-4111-8111-111111111111', revision: 5, state: 'sealing',
    generation: '33333333-3333-4333-8333-333333333333',
    owner: { host: os.hostname(), uid: process.getuid(), pid: process.pid },
    candidate_ref: 'a'.repeat(40), scratch_image: '11111111-1111-4111-8111-111111111111.sparsebundle',
    evidence_image: '11111111-1111-4111-8111-111111111111.sparsebundle', lock_token_digest: 'b'.repeat(64),
    reserved_at: '2026-07-01T00:00:00.000Z', first_dead_at: null,
    scratch_seal: { image: { canonical: '/tmp/scratch.sparsebundle', device: '1', inode: '2', uid: process.getuid(), mode: 0o40700 }, object_id: '44444444-4444-4444-8444-444444444444' },
    evidence_seal: { image: { canonical: '/tmp/evidence.sparsebundle', device: '1', inode: '3', uid: process.getuid(), mode: 0o40700 }, object_id: '55555555-5555-4555-8555-555555555555' },
    device_set_identity: { canonical: '/tmp/set', device: '1', inode: '9', uid: process.getuid(), mode: 0o40700 },
    allocated_at: '2026-07-01T00:00:01.000Z', handoff_from_pid: process.pid, running_at: '2026-07-01T00:00:02.000Z',
    sealing_at: '2026-07-01T00:00:03.000Z',
  };
  assert.equal(validateRecord('runs', { ...base, gate_status: 0 }), true);
  assert.equal(validateRecord('runs', { ...base, gate_status: 1, failure: 'GATE_STATUS_NONZERO:1 child=sim-e2e failed' }), true);
  // THE REGRESSION. Every one of these is the shape of a record ALREADY ON DISK on this host, written
  // before the rule existed. validateRecord is called by readRecord and listRecords, so a throw here is
  // a total outage of the janitor's enumeration, not a strict validator.
  for (const status of [1, 17, 130, 143]) {
    assert.equal(validateRecord('runs', { ...base, gate_status: status }), true, `reading gate_status ${status} must not throw`);
  }
  assert.equal(validateRecord('runs', {
    ...base, state: 'published', gate_status: 1, preliminary_audit_at: '2026-07-01T00:00:04.000Z',
    preliminary_evidence_digest: 'c'.repeat(64), published_at: '2026-07-01T00:00:05.000Z',
  }), true);
});


test('a de-setuid re-signed ps copy runs under the real gate profile where the setuid original cannot', () => {
  // Reproduced against the REAL rendered profile, not a hand-rolled approximation. A hand-rolled profile
  // previously aborted the shim for missing allowances and was mistaken for evidence the approach failed,
  // so the negative control below is part of the test rather than a note: it proves the sandbox genuinely
  // refuses the setuid original, which is what makes the positive result mean anything.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), 'shim-'));
  try {
    for (const name of ['w1', 'w2', 'state', 'bin']) fs.mkdirSync(path.join(directory, name));
    const profile = require('./storage-sandbox.cjs').renderProfile({
      writeRoots: [path.join(directory, 'w1'), path.join(directory, 'w2')],
      readOnlyRoots: [path.join(directory, 'state')],
    });
    const shim = path.join(directory, 'bin', 'ps');

    // NEGATIVE CONTROL: the real setuid binary must be refused, or the positive result proves nothing.
    const original = spawnSync('/usr/bin/sandbox-exec', ['-f', '/dev/stdin', '/bin/ps', '-p', String(process.pid), '-o', 'ppid='], { encoding: 'utf8', input: profile });
    assert.notEqual(original.status, 0, 'setuid /bin/ps must be refused under the gate profile');

    // Unsigned: cp strips the signature on arm64 and the kernel SIGKILLs it. Loud, and asserted so nobody
    // "simplifies" the re-sign away on the theory that a plain copy is enough.
    fs.copyFileSync('/bin/ps', shim);
    fs.chmodSync(shim, 0o755);
    const unsigned = spawnSync(shim, ['-p', String(process.pid), '-o', 'ppid='], { encoding: 'utf8' });
    assert.notEqual(unsigned.status, 0, 'an unsigned copy must not be usable');

    require('node:child_process').execFileSync('/usr/bin/codesign', ['-s', '-', '-f', shim]);
    for (const format of ['ppid=', 'command=', 'lstart=']) {
      const sandboxed = spawnSync('/usr/bin/sandbox-exec', ['-f', '/dev/stdin', shim, '-p', String(process.pid), '-o', format], { encoding: 'utf8', input: profile });
      assert.equal(sandboxed.status, 0, `${format} must succeed under the real profile`);
      assert.equal(sandboxed.stdout, spawnSync('/bin/ps', ['-p', String(process.pid), '-o', format], { encoding: 'utf8' }).stdout, `${format} must be byte-identical to /bin/ps`);
      assert.notEqual(sandboxed.stdout.trim(), '', `${format} must not be empty`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the gate proves its ps shim at install time rather than discovering it mid-run', () => {
  // A missing or unusable shim would let PATH fall back to setuid /bin/ps and kill the stage with EPERM
  // deep inside a certified file. The install carries its own positive control so that failure is named
  // where it happens.
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  assert.match(gate, /command\('\/usr\/bin\/codesign', \['-s', '-', '-f', shimPath\]\)/);
  assert.match(gate, /GATE_PS_SHIM_UNUSABLE/);
  assert.match(gate, /PATH: `\$\{shimDirectory\}:/);
  // No broker survives the reversal - socket, daemon and teardown obligations are gone, not merely unused.
  assert.doesNotMatch(gate, /PENTACLE_PS_BROKER_SOCKET|psBroker/);
  assert.equal(fs.existsSync(path.join(__dirname, 'storage-ps-broker.cjs')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'storage-ps-shim.cjs')), false);
});

test('the wrapper case plan stays derived-equal to the certified scenario plan', () => {
  // Layer-nine finding, same class as the stage-list drift and closed the same way. The wrapper's
  // REPORT_VIEWER_CASE_PLAN duplicates certified scenarioPlan(), whose middle six entries come from
  // Object.entries(SENTINELS) - i.e. the KEY INSERTION ORDER of an object literal in a file we cannot edit.
  // Reorder or add a sentinel there and validateReportViewer throws EVIDENCE_CASE_PLAN at the SEAL, after a
  // full 25-40 minute run, invisibly. A copy is fine; disagreeing is not.
  const certified = fs.readFileSync(path.join(__dirname, 'report-viewer-sim-e2e.cjs'), 'utf8');

  const sentinelStart = certified.indexOf('const SENTINELS = Object.freeze({');
  assert.notEqual(sentinelStart, -1, 'SENTINELS literal must be locatable');
  const sentinels = [...certified.slice(sentinelStart, certified.indexOf('});', sentinelStart)).matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]);

  const planStart = certified.indexOf('function scenarioPlan()');
  assert.notEqual(planStart, -1, 'scenarioPlan must be locatable');
  const derived = [];
  for (const line of certified.slice(planStart, certified.indexOf('\n}', planStart)).split('\n')) {
    const literal = line.match(/\{ scenario: '([^']+)'(?:, sentinel: '([^']+)')?, expected: '([^']+)' \}/);
    if (literal) { derived.push([literal[1], literal[2] || null, literal[3]]); continue; }
    if (line.includes('...Object.entries(SENTINELS).map(')) derived.push(...sentinels.map((sentinel) => ['report_viewer_runtime_sentinel', sentinel, 'FAIL']));
  }

  // BY CONTENT, not by passing. An under-matching derivation would see fewer entries on BOTH sides and pass
  // while proving nothing - the vacuous shape caught by mutation inside the stage-list test. So the count
  // and the specific boundary entries are named explicitly.
  assert.equal(sentinels.length, 6, `expected 6 sentinels, derived ${sentinels.length}: ${sentinels.join(',')}`);
  assert.equal(derived.length, 9, `expected 9 cases, derived ${derived.length}`);
  assert.deepEqual(derived[0], ['report_viewer_horizontal_scroll', null, 'PASS']);
  assert.deepEqual(derived[1], ['report_viewer_runtime_sentinel', 'clean', 'PASS']);
  assert.deepEqual(derived[8], ['report_viewer_comments_keyboard', null, 'PASS']);
  for (const required of ['console_error', 'liveness_loss']) assert.ok(sentinels.includes(required), `derivation missed ${required}`);

  assert.deepEqual(require('./storage-gate.cjs').REPORT_VIEWER_CASE_PLAN, derived, 'wrapper case plan must equal the certified scenario plan in order');
  assert.equal(require('./storage-gate.cjs').reportViewerResultsBeforeKeyboard(), derived.length - 1, 'the live trigger threshold is the exact number of cases before keyboard');
});

test('audit strictness comes from the wrapper observation, not the audited artifact self-report', () => {
  // QA's find, and the sharpest of the session. Strictness used to key off summary.status, read from
  // run.json INSIDE the evidence image - so the artifact under audit chose how hard it was audited, while
  // publication was classified from run.gate_status, the wrapper's own value. A run could be AUDITED as
  // failed and CLASSIFIED as passed. Not live today only because a correct full-gate.cjs sets both in one
  // catch; but this lane byte-pins that file precisely because it does not trust it not to drift, and it
  // has been re-pinned three times.
  const gate = require('./storage-gate.cjs');
  const build = (status, gateCount) => {
    const fixture = reportViewerFixture();
    const stages = certifiedStages().slice(0, gateCount);
    const gates = stages.map((name, index) => ({ name, command: `command-${index}`, status: 0, started_at: '2026-07-17T00:00:00Z', finished_at: '2026-07-17T00:00:01Z', log: `${name}.log` }));
    fs.writeFileSync(path.join(fixture.root, '.pentacle-container.json'), '{}\n');
    fs.writeFileSync(path.join(fixture.root, 'run.json'), `${JSON.stringify({ status, gates })}\n`);
    fs.writeFileSync(path.join(fixture.root, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: ['ios/a'] })}\n`);
    writeSurfaceTriggerEvidence(fixture.root, '00000000-0000-4000-8000-000000000000');
    for (const entry of gates) {
      fs.writeFileSync(path.join(fixture.root, `${entry.name}.json`), `${JSON.stringify(entry)}\n`);
      fs.writeFileSync(path.join(fixture.root, entry.log), 'log\n');
    }
    return fixture;
  };

  // The differential: identical trees, only the child's self-report differs. Under the old code the first
  // was ACCEPTED as sealable and the second REJECTED - the self-report alone decided.
  const claimsFailed = build('failed', 4);
  const claimsPassed = build('passed', 4);
  try {
    // The wrapper observed a GREEN run (gate_status 0). A child claiming 'failed' must not be able to
    // downgrade its own audit, and the disagreement itself must be the error.
    assert.throws(() => gate.validateEvidence(claimsFailed.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup', 0), /EVIDENCE_OUTCOME_PROVENANCE_MISMATCH:failed:passed/);
    // POSITIVE CONTROL: with the self-report agreeing, the strict path still governs and still rejects a
    // 4-of-12 tree - so the assertion above is not passing for an unrelated reason.
    assert.throws(() => gate.validateEvidence(claimsPassed.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup', 0), /EVIDENCE_STAGE_ORDER/);
    // And the mirror: a child claiming success on a run the wrapper observed as failed.
    assert.throws(() => gate.validateEvidence(claimsPassed.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup', 1), /EVIDENCE_OUTCOME_PROVENANCE_MISMATCH:passed:failed/);
    // Absence of the wrapper's observation is never a pass.
    assert.throws(() => gate.validateEvidence(claimsPassed.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup'), /EVIDENCE_OUTCOME_UNAUTHORITATIVE/);
    assert.throws(() => gate.validateEvidence(claimsPassed.root, '00000000-0000-4000-8000-000000000000', 'pre-cleanup', 'passed'), /EVIDENCE_OUTCOME_UNAUTHORITATIVE/);
  } finally {
    fs.rmSync(claimsFailed.root, { recursive: true, force: true });
    fs.rmSync(claimsPassed.root, { recursive: true, force: true });
  }
});

test('certified stage strictness is governed by the supplied outcome, not the summary self-report', () => {
  // Reached by mutation, not review: with the provenance agreement assertion in place, outcome and
  // summary.status can never differ THROUGH validateEvidence, so reverting this one to the self-report was
  // unobservable there. validateCertifiedStages is exported and takes the outcome directly, which is where
  // the parameter has to be pinned - otherwise a future caller passing an outcome would be silently ignored
  // and the self-report would quietly govern again.
  const fixture = reportViewerFixture();
  try {
    const stages = certifiedStages().slice(0, 4);
    const gates = stages.map((name, index) => ({ name, command: `command-${index}`, status: 0, started_at: '2026-07-17T00:00:00Z', finished_at: '2026-07-17T00:00:01Z', log: `${name}.log` }));
    for (const entry of gates) {
      fs.writeFileSync(path.join(fixture.root, `${entry.name}.json`), `${JSON.stringify(entry)}\n`);
      fs.writeFileSync(path.join(fixture.root, entry.log), 'log\n');
    }
    fs.writeFileSync(path.join(fixture.root, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: ['ios/a'] })}\n`);
    // The summary CLAIMS passed; the supplied outcome says failed. A 4-of-12 prefix must be accepted on the
    // supplied outcome's authority, and the claim must not be able to force strictness either way.
    const claimsPassed = { status: 'passed', gates };
    const { validateCertifiedStages } = require('./storage-gate.cjs');
    assert.doesNotThrow(() => validateCertifiedStages(fixture.root, claimsPassed, 'failed'), 'the supplied outcome governs, not the self-report');
    assert.throws(() => validateCertifiedStages(fixture.root, claimsPassed, 'passed'), /EVIDENCE_STAGE_ORDER/);
    assert.throws(() => validateCertifiedStages(fixture.root, { status: 'failed', gates }, 'passed'), /EVIDENCE_STAGE_ORDER/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('batched failed evidence preserves later independent successes and rejects false unreachable claims', () => {
  const fixture = reportViewerFixture();
  try {
    const stages = certifiedStages();
    const gates = stages.slice(0, 3).map((name, index) => ({ name, command: `command-${index}`, status: index === 0 ? 1 : 0,
      started_at: '2026-07-17T00:00:00Z', finished_at: '2026-07-17T00:00:01Z', log: `${name}.log` }));
    for (const entry of gates) {
      fs.writeFileSync(path.join(fixture.root, `${entry.name}.json`), JSON.stringify(entry));
      fs.writeFileSync(path.join(fixture.root, entry.log), 'log\n');
    }
    fs.writeFileSync(path.join(fixture.root, 'native-root.json'), JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: ['ios/a'] }));
    const checks = ['scenario-configuration', 'hostadmission-and-signal', ...stages].map((name, index) => ({ name,
      status: index === 2 ? 'failed' : index > 4 ? 'unreachable' : 'passed', dependencies: index > 4 ? ['focused-jest'] : [] }));
    const summary = { hardening_version: 3, status: 'failed', gates: gates.slice(1), checks };
    const { validateCertifiedStages } = require('./storage-gate.cjs');
    assert.doesNotThrow(() => validateCertifiedStages(fixture.root, summary, 'failed'));
    assert.throws(() => validateCertifiedStages(fixture.root, summary, 'passed'), /EVIDENCE_STAGE_ORDER/);
    checks[3] = { name: 'serial-jest', status: 'unreachable', dependencies: ['focused-jest'] };
    assert.throws(() => validateCertifiedStages(fixture.root, summary, 'failed'), /EVIDENCE_CHECK_UNREACHABLE_HAS_RECEIPT|EVIDENCE_CHECK_SUMMARY_MISMATCH/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('retained evidence is judged by its recorded outcome, not by strict default', () => {
  // QA's find. verifyRetainedEvidence took validateReportViewer's STRICT default while the very next line
  // was already outcome-aware, so a failed run's retained evidence was judged by passed-run rules.
  // storage-janitor.cjs:99 gates the evidence DISCARD on this, so failed-run images could never be
  // reclaimed - a resource created and never released, with no failure raised, inside the reclamation path
  // itself, and silent because janitor failures are unobservable by design.
  //
  // It was DEAD CODE until layer 8 made failed runs sealable, which is the sharp part: my own fix animated
  // it. Making a dead path live makes the WHOLE path new code, and every consumer must be re-read as though
  // just written. Three call sites were made outcome-aware; this fourth, the one the janitor runs, was not.
  const gate = require('./storage-gate.cjs');
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const retained = source.slice(source.indexOf('function verifyRetainedEvidence'), source.indexOf('\n}', source.indexOf('function verifyRetainedEvidence')));
  assert.match(retained, /if \(run\.unclassified_disposed_at === undefined\)/, 'only a recorded disposition may skip semantic gate validation');
  assert.match(retained, /validateReportViewer\(root, current, manifest\.outcome\)/, 'the retention path must pass the recorded outcome');
  assert.doesNotMatch(retained, /validateReportViewer\(root, current\)/, 'the strict default must not be taken here');

  // Behavioural: the same tree the seal accepts as a failed run must also be accepted by the retention
  // path. A partial manifest is exactly what a failed run leaves behind.
  const fixture = reportViewerFixture();
  try {
    for (const stale of fs.readdirSync(fixture.runs)) if (stale !== 'manifest.json') fs.rmSync(path.join(fixture.runs, stale), { force: true });
    const manifestFile = path.join(fixture.runs, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, status: 'failed', cases: [], recorder_preflight: null })}\n`);
    const files = gate.enumerateEvidence(fixture.root);
    assert.doesNotThrow(() => gate.validateReportViewer(fixture.root, files, 'failed'), 'the seal accepts this tree');
    assert.throws(() => gate.validateReportViewer(fixture.root, files), /EVIDENCE_CASE_MANIFEST_INVALID/, 'and the strict default is what rejected it');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('the scenario harness env file is pinned to the real host home, not the redirected one', () => {
  // INSTANCE SIX of the HOME/XDG containment class, and the first found in OUR OWN harness rather than a
  // third-party tool. run_scenario.py defaults --env-file to Path.home()/'.pentacle-test.env'; the
  // container redirects the child's HOME into scratch, so every scenario died SETUP_FAIL before touching
  // the app - measured at run example-c, eleven of twelve stages green and seventeen minutes spent to
  // learn it. The pin costs no certified edit and no containment change: report-viewer-sim-e2e.cjs
  // already forwards this variable as --env-file behind an if-set guard, and the sandbox profile already
  // allows file-read* everywhere, so the child reads the real file rather than a copy.
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const child = gate.slice(gate.indexOf('environment.env = {'), gate.indexOf('result = await supervise'));
  assert.match(child, /PENTACLE_GATE_SIM_E2E_ENV_FILE: scenarioEnvFile,/, 'the child env must carry the pinned env file');
  // It must be resolved BEFORE the HOME redirect, or it would resolve into scratch and change nothing.
  // Both are in this same block, so order is the property that matters.
  assert.ok(child.indexOf('PENTACLE_GATE_SIM_E2E_ENV_FILE') > 0 && gate.indexOf('scenarioEnvFile = hostScenarioEnvFile()') < gate.indexOf('environment.env = {'));

  // The certified hook this depends on. If a future certified revision drops it, the pin silently stops
  // reaching the harness and the scenario is back to Path.home() - so bind to it rather than assume it.
  const certified = fs.readFileSync(path.join(__dirname, 'report-viewer-sim-e2e.cjs'), 'utf8');
  assert.match(certified, /process\.env\.PENTACLE_GATE_SIM_E2E_ENV_FILE/, 'the certified caller must still forward this variable');
  assert.match(certified, /args\.push\('--env-file', process\.env\.PENTACLE_GATE_SIM_E2E_ENV_FILE\)/);

  // And the harness default this exists to override, so the test fails if that default ever moves.
  const scenario = fs.readFileSync(path.join(__dirname, '..', 'test', 'e2e', 'run_scenario.py'), 'utf8');
  assert.match(scenario, /--env-file[\s\S]{0,80}Path\.home\(\) \/ "\.pentacle-test\.env"/);
});

test('a missing scenario env file is refused up front, not seventeen minutes in', () => {
  // Fail-fast, and it is not gold-plating: absent, this costs a full gate run to discover something a
  // stat answers immediately. Named, per fix C - a guard on the gate's start path may not fail silently.
  const { withChildStage } = require('./storage-gate.cjs');
  assert.equal(typeof withChildStage, 'function');
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  assert.match(gate, /GATE_SCENARIO_ENV_FILE_MISSING:\$\{target\}/, 'the refusal must name the path it looked for');
  // Resolved from the wrapper's own homedir, NOT from the child's redirected HOME.
  assert.match(gate, /function hostScenarioEnvFile\(\)[\s\S]{0,300}require\('node:os'\)\.homedir\(\)/);
  // And it runs in the PRE-FLIGHT region, before the simulator, the queue and the sandbox are set up.
  assert.ok(gate.indexOf('scenarioEnvFile = hostScenarioEnvFile()') < gate.indexOf('queue = acquireSimulatorQueue(runId)'));
});

test('the stale simulator substrate is reaped by the WRAPPER, outside the sandbox', () => {
  // The wrapper must clear stale host substrate before its watcher creates this run's companion. The
  // later certified-child idb hygiene is suppressed because repeating that portion would destroy the
  // current companion, while the sandboxed client cannot auto-spawn a replacement for the private device
  // set. Host-side hygiene restores the missing authority without granting any to the sandbox.
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  assert.match(gate, /reapHostSimulatorSubstrate\(environment\)/);
  // ORDER IS THE PROPERTY. It must run AFTER our own simulator exists - so boundUdid can spare it - and
  // BEFORE the child is supervised, or the child still races a stale companion.
  const create = gate.indexOf('createSimulator(runId, (udid) => {');
  const reap = gate.indexOf('reapHostSimulatorSubstrate(environment)', create);
  const supervise = gate.indexOf('result = await superviseChild(');
  assert.ok(create > 0 && reap > create && supervise > reap, 'host reap must sit between simulator creation and supervise');
  // It runs in the WRAPPER, so it must not be inside the child env block that the sandbox receives.
  const childEnv = gate.slice(gate.indexOf('environment.env = {'), gate.indexOf('result = await supervise'));
  assert.equal(childEnv.includes('reapStaleSimulatorSubstrate'), false);
  assert.equal(gate.includes("require(path.join(candidateRoot, 'scripts', 'sim-substrate.cjs'))"), false);
  assert.equal(gate.includes('GATE_SUBSTRATE_REAP_FAILED'), false, 'best-effort host hygiene cannot fail the gate');
});

test('a caller-supplied PENTACLE_GATE_SIM_E2E_CMD is rejected loudly, never silently substituted', () => {
  // The wrapper pins the sim-e2e command; a caller value was previously spread into the child env and
  // then clobbered at :1431, so gate:full reported on a subject the caller never selected. The fix is a
  // loud rejection, not a silent overwrite. Guard is pure/exported because runFullGate cannot run in-process.
  const { assertSimE2eCommandNotOverridden } = require('./storage-gate.cjs');
  assert.throws(
    () => assertSimE2eCommandNotOverridden({ PENTACLE_GATE_SIM_E2E_CMD: 'npm run gate:wire-contract-sim-e2e' }),
    /GATE_SIM_E2E_CMD_NOT_OVERRIDABLE/,
    'a caller-supplied sim-e2e command must raise, not be ignored',
  );
  assert.doesNotThrow(() => assertSimE2eCommandNotOverridden({}), 'the fixed-command path (var unset) must proceed');
  assert.doesNotThrow(() => assertSimE2eCommandNotOverridden({ PENTACLE_GATE_SIM_E2E_CMD: '' }), 'empty is treated as unset');
  // The guard must fire in preflight, before the lock/heavy work, or a misdirected caller pays for a full run.
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const run = gate.slice(gate.indexOf('async function runFullGate'));
  const guardCall = run.indexOf('assertSimE2eCommandNotOverridden(');
  assert.ok(guardCall > 0, 'runFullGate must invoke the override guard');
  assert.ok(guardCall < run.indexOf('claimHostLock('), 'the guard must run before the host lock is claimed');
});

test('the canonical simulator-substrate is certified without comparing historical candidate bytes', () => {
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const pin = require('./storage-authority.cjs').CERTIFIED_COMPONENTS['scripts/sim-substrate.cjs'];
  assert.match(pin, /^[0-9a-f]{64}$/);
  assert.equal(gate.includes('verifySimulatorSubstrateDigest'), false);
  assert.equal(gate.includes('SIM_SUBSTRATE_DIGEST_DRIFT'), false);
});

test('B: host preparation preserves a foreign companion and socket', async () => {
  const child = syntheticCompanion();
  const socket = path.join('/private/tmp/idb', `SYNTHETIC-${process.pid}_companion.sock`);
  try {
    fs.writeFileSync(socket, 'synthetic');
    const summary = reapHostSimulatorSubstrate({ simulatorUdid: 'SYNTHETIC' }, () => { throw new Error('foreign reaper called'); });
    assert.deepEqual(summary, { scope: 'runner-owned-only', foreign_resources_untouched: true });
    assert.equal(fs.existsSync(socket), true);
    process.kill(child.pid, 0);
  } finally { child.kill(); fs.rmSync(socket, { force: true }); }
});

// The asymmetry guard. Two IDENTICAL calls to recoverDeadHostLock lived in the janitor's record sweep,
// one fatal and one skippable, and the fatal one meant a stale lock owned by ANY single run disabled ALL
// janitor reclamation - measured, in the component this lane exists to build, and it wedged the gate on
// disk with no verb able to recover. This is the THIRD instance of the shape (layer 8's three-of-four
// call sites; the two `defaults` guards where one threw and one shrugged), so it is pinned structurally
// rather than left to review: every sweep call must route through the one helper that classifies
// mismatch-versus-real-error, and a regression to a bare call fails here.
//
// Structural rather than behavioural, and that is a KNOWN LIMITATION stated plainly: fixedLayout() has
// no authority-root override, so a behavioural janitor test needs a spawned worker under a redirected
// HOME (the seam storage-synthetic-gate.test.cjs uses). That test is filed in
// spec_example_2026_01, not written here. What this fix DOES
// have is end-to-end evidence against the real defect: before it, `storage:janitor dry-run` aborted with
// HOST_LOCK_RECOVERY_MISMATCH and enumerated nothing; after it, dry-run and apply both enumerated all
// seven runs with errors [], and apply recovered the stale lock the gate was blocked on.
test('every janitor sweep lock-recovery call routes through the classifying helper', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-janitor.cjs'), 'utf8');
  const sweep = source.slice(source.indexOf('function runJanitor'));
  assert.equal(sweep.includes('tryRecoverDeadHostLock'), true, 'the sweep must use the classifying helper');
  assert.equal(/gateMutations\.recoverDeadHostLock\s*\(/.test(sweep), false, 'no bare recoverDeadHostLock call may remain in the sweep');
  // The helper must RECORD anything that is not a mismatch rather than swallow it - the R7 corollary:
  // an enumeration the reclaimer depends on must never die on one record, and silent skipping is not
  // the fix either. A bare `catch {}` satisfies the first half and fails the second.
  const helper = source.slice(source.indexOf('function tryRecoverDeadHostLock'), source.indexOf('function runJanitor'));
  assert.match(helper, /HOST_LOCK_RECOVERY_MISMATCH/);
  assert.match(helper, /report\.errors\.push/);
  assert.equal(/catch\s*\{\s*\}/.test(helper), false, 'the helper must not swallow non-mismatch errors');
  // The discard transaction's own call is deliberately NOT routed through the helper: there the run
  // provably owns the lock and a failure must abort the discard, so it stays fatal.
  const applyHeld = source.slice(source.indexOf('function applyRunHeld'), source.indexOf('function acquireJanitor'));
  assert.match(applyHeld, /gateMutations\.recoverDeadHostLock\(id\)/);
});

// The companion must not outlive its run, and the socket must be PROVEN USABLE rather than merely
// present. Both are pinned structurally, and the limitation is stated rather than hidden: spawning a
// real idb_companion in a unit test needs a real simulator and a real device set, so these assert the
// two properties that a refactor could silently drop. The behavioural evidence is in the spec and was
// taken against a real private-set device: `idb describe --udid <udid>` returns rc=0 through the
// pre-spawned socket while the device is still shutdown, and against a socket with no listener the same
// command fails naming DomainSocketAddress(path=...).
test('the idb companion stays in the process group and its socket is proven usable, not merely present', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const spawn = source.slice(source.indexOf('function spawnIdbCompanion'), source.indexOf('function stopIdbCompanion('));
  // detached:true would buy survival across wrapper exit - the one property this lane exists to prevent -
  // and would put the companion outside the group-kill that covers the uncatchable path.
  assert.match(spawn, /detached:\s*false/);
  assert.equal(/detached:\s*true/.test(spawn), false, 'a detached companion escapes the supervisor group-kill');
  // Socket existence alone does not prove idb still parses a colon-free IDB_COMPANION as a domain socket.
  assert.match(spawn, /requireIdbCompanionUsable\(/);
  const probe = source.slice(source.indexOf('function requireIdbCompanionUsable'), source.indexOf('function spawnIdbCompanion'));
  assert.match(probe, /IDB_COMPANION: companion\.socket/);
  assert.match(probe, /'describe', '--udid', udid/);
  // A failed probe must not leave the companion it just proved unusable running.
  assert.match(probe, /stopIdbCompanion\(companion\)/);
  assert.match(probe, /GATE_IDB_COMPANION_UNUSABLE/);
});

// LAYER 15 — the companion must be spawned on the RIGHT SIDE OF BOOT. A pre-boot companion is not merely
// early: measured, it answers describe-all rc=0 with a DEGENERATE 273-byte tree, while a post-boot one
// returns 5837 bytes of real tree. So an eager spawn is silently WRONG, and a regression to one would put
// the gate back to failing case one with a full 20-second poll and no error to read.
test('the idb companion is spawned by a boot watcher, never eagerly at simulator creation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const run = source.slice(source.indexOf('async function runFullGate'));
  // The run must start the WATCHER, and must not spawn a companion directly at any point.
  assert.match(run, /startIdbCompanionWatcher\(environment\.simulatorUdid, environment\.deviceSet\)/);
  assert.equal(/=\s*spawnIdbCompanion\(/.test(run), false, 'the run must never spawn a companion eagerly');
  // The child's address is derived from the udid, NOT from a spawn result, so it can be handed over
  // before the socket exists.
  assert.match(run, /IDB_COMPANION: idbCompanionSocket\(environment\.simulatorUdid\)/);
  const watcher = source.slice(source.indexOf('function startIdbCompanionWatcher'), source.indexOf('function stopIdbCompanionWatcher'));
  assert.match(watcher, /state === 'Booted'|device\.state === 'Booted'/);
  assert.match(watcher, /\.unref\(\)/);
  // A watcher that never fired must SAY so rather than leave a silent absence behind it.
  const stop = source.slice(source.indexOf('function stopIdbCompanionWatcher'), source.indexOf('function spawnIdbCompanion'));
  assert.match(stop, /never-fired/);
});

// LAYER 19. The substrate reap kills EVERY idb_companion and deletes their sockets, then recovers by
// letting the next `idb ui` auto-spawn one - which cannot work in-container, because auto-spawn cannot see
// a private device set. Certified code calls that reap IN-CONTAINER, after the wrapper has spawned the one
// companion that can serve the gate's device, so it destroys this run's own substrate. The wrapper already
// performed every one of those actions on the host immediately BEFORE spawning the companion, which is the
// only moment any of it is hygiene rather than self-destruction. That ordering is the whole argument, so it
// is asserted here rather than left to a comment.
test('in-container idb hygiene is disabled while simulator cleanup remains, and the wrapper reaps first', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  assert.match(source, /PENTACLE_TEST_DISABLE_IDB_COMPANION_REAP: '1'/);
  assert.equal(source.includes("PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP: '1'"), false);
  const reapAt = source.indexOf('reapHostSimulatorSubstrate(environment)');
  const spawnAt = source.indexOf('startIdbCompanionWatcher(environment.simulatorUdid');
  assert.ok(reapAt > 0 && spawnAt > 0, 'both the reap and the companion spawn must be present');
  // Reap FIRST, companion SECOND. Reversed, the wrapper would kill the companion it just created - the
  // very defect being disabled in-container, reintroduced host-side.
  assert.ok(reapAt < spawnAt, 'the host reap must run BEFORE the companion is spawned');
});

// LAYER 18. `idb` is a pip --user install, so its module lives only in python's USER site-packages, and
// site.getusersitepackages() follows HOME - which this wrapper redirects into the scratch. The sandboxed
// client therefore died at IMPORT on every call (measured 37/37 in run example-d) and the poll wore it as
// a 20-second timeout. These assertions keep the path DERIVED and the failures NAMED, because a silently
// wrong PYTHONPATH is indistinguishable from none and puts us straight back to a causeless timeout.
test('the child is given a derived host PYTHONPATH so sandboxed idb can import', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  assert.match(source, /PYTHONPATH: hostUserSitePackages\(\)/);
  const resolver = source.slice(source.indexOf('function hostUserSitePackages'), source.indexOf('function createSimulator'));
  // Asked of python, never assembled from a version string that a python upgrade would silently invalidate.
  assert.match(resolver, /import site;print\(site\.getusersitepackages\(\)\)/);
  assert.equal(/Library\/Python\/3\.\d+/.test(resolver), false, 'the site-packages path must not be hardcoded');
  // Every failure branch is named and fatal - no nameless empty value may reach the child.
  for (const code of ['GATE_USER_SITE_UNRESOLVED', 'GATE_USER_SITE_EMPTY', 'GATE_USER_SITE_ABSENT', 'GATE_USER_SITE_NO_IDB']) {
    assert.match(resolver, new RegExp(code));
  }
  // Presence of the directory is not enough; the module itself must be there.
  assert.match(resolver, /path\.join\(site, 'idb'\)/);
  // An inherited PYTHONPATH is preserved rather than clobbered.
  assert.match(resolver, /process\.env\.PYTHONPATH/);
});

// LAYER 16. `-DeviceSetPath` is the entire difference between a surface that ATTACHES to the gate's
// device and one that merely carries the right argv while driving a default-set device it found instead
// (measured: without the flag the named private-set device stayed Shutdown and a foreign device booted).
// The certified ownership guard cannot catch that, because argv is exactly what it inspects — so the
// protection has to live here, in a test that fails if the flag is ever dropped as redundant.
test('the wrapper launches the Simulator surface bound to the gate device set, and reaps it', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const launch = source.slice(source.indexOf('function launchSimulatorSurface'), source.indexOf('function simulatorSurfaceProcessState'));
  assert.match(launch, /'-DeviceSetPath', deviceSet/);
  assert.match(launch, /'-CurrentDeviceUDID', udid/);
  assert.match(launch, /spawnSync\('\/usr\/bin\/open', \['-g', '-a', 'Simulator', '--args', '-DeviceSetPath', deviceSet, '-CurrentDeviceUDID', udid\], \{ encoding: 'utf8' \}\)/, 'the post---args sequence is exact; no third pair is admitted');
  // The readiness predicate is the certified module's own, so the wrapper cannot drift away from the
  // guard it exists to satisfy.
  // The CALL, not merely the identifier: mutation-found that asserting the bare name is satisfied by
  // the `require` destructuring alone, so replacing the call with `true` left this green.
  assert.match(launch, /commandHasExactArgumentPair\(identity\.stdout, '-CurrentDeviceUDID', udid\)/);
  assert.match(launch, /require\('\.\/report-viewer-sim-e2e\.cjs'\)/);
  assert.ok(launch.indexOf("require('./report-viewer-sim-e2e.cjs')") < launch.indexOf("spawnSync('/usr/bin/open'"), 'every dependency resolves before the first post-open escape');
  // Fails closed on absence and on ambiguity, exactly as the certified guard does.
  assert.match(launch, /GATE_SIMULATOR_SURFACE_UNREADY/);
  assert.match(launch, /GATE_SIMULATOR_SURFACE_AMBIGUOUS/);
  assert.match(launch, /GATE_SIMULATOR_SURFACE_PROBE/);
  assert.match(launch, /GATE_SIMULATOR_SURFACE_IDENTITY_MISMATCH/);
  assert.match(launch, /catch \(error\) \{ error\.cleanupUnproven = true; throw error; \}/);
  // `ps` unqualified: /usr/bin/ps does not exist on macOS (it is /bin/ps), and the absolute form made
  // spawnSync return status null with empty stdout, so readiness failed for a surface that had started.
  assert.equal(/'\/usr\/bin\/ps'/.test(launch), false, 'ps must not be called by an absolute path');
  assert.match(launch, /spawnSync\('ps',/);
  // A surface that launched but failed readiness must still be reapable, or it outlives its run.
  assert.match(launch, /launched\.surface = \{ pid: observed\.pid, start: observed\.start \}/);
  assert.ok(launch.indexOf("['-x', 'Simulator']") < launch.indexOf("['-g', '-a', 'Simulator'"), 'pre-existing surfaces are refused before open');

  // THE SURFACE MUST NOT BE ALIVE FOR THE WHOLE RUN. Measured at run example-e: launching it on the boot
  // edge took the all-cases diagnostic from 7/9 to 0/9, because the harness GUI preflight fails every
  // scenario while a Simulator.app runs and exempts exactly one owned surface for the keyboard case
  // alone. This asserts the absence, so re-wiring it to the boot edge cannot happen quietly.
  const watcher = source.slice(source.indexOf('function startIdbCompanionWatcher'), source.indexOf('function stopIdbCompanionWatcher'));
  assert.equal(/=\s*launchSimulatorSurface\(/.test(watcher), false, 'the surface must not be launched on the boot edge');
  const run = source.slice(source.indexOf('async function runFullGate'));
  assert.equal(/=\s*launchSimulatorSurface\(/.test(run), false, 'the run must never launch a surface eagerly');
  // The trigger reads the wrapper-resolved evidence mount, derives the number of predecessor cases from
  // the plan, and launches through the already-measured exact-device-set helper.
  assert.match(run, /path\.join\(evidence, 'report-viewer-sim-e2e'\)/);
  assert.match(run, /path\.join\(scratch, 'diagnostic-surface-trigger'\)/);
  assert.match(run, /PENTACLE_DIAGNOSTIC_SURFACE_TRIGGER_DIR: diagnosticSurfaceTriggerDirectory/);
  assert.match(run, /requiredResults: reportViewerResultsBeforeKeyboard\(\)/);
  assert.match(run, /launch: \(\) => launchSimulatorSurface\(environment\.simulatorUdid, environment\.deviceSet\)/);
  // Teardown stops the trigger before deleting the simulator and reports action or reasoned inaction.
  const cleanup = run.slice(run.indexOf('const cleanupResources'), run.indexOf('releaseHostResources is defined'));
  assert.ok(cleanup.indexOf("step('simulator-surface'") < cleanup.indexOf("step('simulator'"));
  const stopTrigger = source.slice(source.indexOf('function stopSimulatorSurfaceTrigger'), source.indexOf('function hostUserSitePackages'));
  assert.match(stopTrigger, /terminateOwnedSurface\(surface, \{ processState: simulatorSurfaceProcessState \}\)/);
  assert.match(stopTrigger, /storage-surface-trigger\.json/);
  assert.match(stopTrigger, /GATE_SIMULATOR_SURFACE_CLEANUP_FAILED/);
  assert.match(stopTrigger, /simulator surface trigger/);
});

test('the diagnostic consumer mirrors each real result only to the wrapper-provided scratch root', () => {
  const root = temporary('storage-diagnostic-trigger');
  const source = path.join(root, 'case-8.json');
  const targetRoot = path.join(root, 'scratch-trigger');
  fs.writeFileSync(source, '{"scenario":"report_viewer_runtime_sentinel"}\n');
  const target = mirrorDiagnosticCaseResult(source, { PENTACLE_DIAGNOSTIC_SURFACE_TRIGGER_DIR: targetRoot });
  assert.equal(target, path.join(targetRoot, 'case-8.json'));
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.throws(() => mirrorDiagnosticCaseResult(source, {}), /TRIGGER_DIR_INVALID/);
  assert.throws(() => mirrorDiagnosticCaseResult(source, { PENTACLE_DIAGNOSTIC_SURFACE_TRIGGER_DIR: 'relative' }), /TRIGGER_DIR_INVALID/);
  assert.throws(() => mirrorDiagnosticCaseResult(source, { PENTACLE_DIAGNOSTIC_SURFACE_TRIGGER_DIR: targetRoot }), /EEXIST/);
});

test('owned-surface cleanup verifies identity and observed exit', () => {
  const surface = { pid: 8125, start: 'START-1' };
  const observations = [{ alive: true, start: 'START-1' }, { alive: false }];
  const signals = [];
  const result = terminateOwnedSurface(surface, { processState: () => observations.shift(), signal: (...args) => signals.push(args), pause: () => undefined });
  assert.deepEqual(signals, [[8125, 'SIGTERM']]);
  assert.deepEqual(result, { pid: 8125, outcome: 'terminated' });
});

test('owned-surface cleanup distinguishes absence, signal failure, identity drift, and survival', () => {
  const surface = { pid: 8126, start: 'START-1' };
  assert.deepEqual(terminateOwnedSurface(surface, { processState: () => ({ alive: false }), signal: () => assert.fail('dead process must not be signalled') }), { pid: 8126, outcome: 'already-exited' });
  assert.throws(() => terminateOwnedSurface(surface, { processState: () => ({ alive: true, start: 'START-1' }), signal: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; } }), /CLEANUP_SIGNAL:8126:EPERM/);
  assert.throws(() => terminateOwnedSurface(surface, { processState: () => ({ alive: true, start: 'START-2' }), signal: () => assert.fail('drifted pid must not be signalled') }), /CLEANUP_IDENTITY_DRIFT:8126/);
  assert.throws(() => terminateOwnedSurface(surface, { processState: () => ({ alive: true, start: 'START-1' }), signal: () => undefined, pause: () => undefined, attempts: 2 }), /CLEANUP_SURVIVOR:8126/);
});


test('macOS sandbox denies a live foreign process and group without harming the sentinel', { skip: process.platform !== 'darwin' }, async () => {
  const sentinel = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => sentinel.once('exit', resolve));
  try {
    assert.ok(sentinel.pid > 1);
    process.kill(sentinel.pid, 0);
    const root = temporary('storage-sandbox-foreign-signal');
    const roots = ['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return fs.realpathSync(target); });
    const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
    const program = `const rows=[];for(const pid of [${sentinel.pid},-${sentinel.pid}])for(const signal of [0,'SIGTERM']){try{process.kill(pid,signal);rows.push(0)}catch(e){rows.push(Math.abs(e.errno))}}console.log(JSON.stringify(rows))`;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', program], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [1, 1, 1, 1]);
    process.kill(sentinel.pid, 0);
  } finally {
    sentinel.kill('SIGKILL');
    await exited;
  }
});
