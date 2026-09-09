'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, test } = require('node:test');
const mutationCapability = require('./storage-capability.cjs').claim();

const FIXTURE_TIMEOUT_MS = 60000;
function cacheFixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-cache-control-'));
  const home = process.env.HOME; const statfs = fs.statfsSync;
  process.env.HOME = root;
  fs.mkdirSync(path.join(root, 'Library/PentacleMobileStorage'), { recursive: true });
  fs.statfsSync = () => ({ bavail: 100 * 1024 ** 3, bsize: 1 });
  try { return action(root, require('./storage-build-cache.cjs').bind(mutationCapability)); }
  finally { fs.statfsSync = statfs; if (home === undefined) delete process.env.HOME; else process.env.HOME = home; fs.rmSync(root, { recursive: true, force: true }); }
}

test('cache hit restores validated bytes; mismatched or corrupt inputs cannot seed a build', () => cacheFixture((root, cache) => {
  const scratch = path.join(root, 'scratch'); const derived = path.join(scratch, 'derived-data');
  fs.mkdirSync(derived, { recursive: true }); fs.writeFileSync(path.join(derived, 'object.o'), 'compiled');
  assert.equal(cache.publish({ bundleId: 'one' }, scratch).stored, true);
  const second = path.join(root, 'second'); fs.mkdirSync(second);
  assert.equal(cache.restore({ bundleId: 'one' }, second).hit, true);
  assert.equal(fs.readFileSync(path.join(second, 'derived-data/object.o'), 'utf8'), 'compiled');
  const third = path.join(root, 'third'); fs.mkdirSync(third);
  assert.equal(cache.restore({ bundleId: 'two' }, third).hit, false);
  assert.deepEqual(fs.readdirSync(third), []);
  fs.writeFileSync(path.join(root, 'Library/PentacleMobileStorage/BuildCache/entry/payload/derived-data/object.o'), 'corrupt');
  assert.throws(() => cache.restore({ bundleId: 'one' }, third), /CACHE_ADMISSION_REFUSED:CACHE_CONTENT_DRIFT/);
  assert.deepEqual(fs.readdirSync(third), []);
}));

test('cache rejects symlinked entries, competing writers and insufficient staging headroom', () => cacheFixture((root, cache) => {
  const scratch = path.join(root, 'scratch'); fs.mkdirSync(path.join(scratch, 'derived-data'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'derived-data/object.o'), 'compiled');
  assert.equal(cache.publish({ source: 'one' }, scratch).stored, true);
  const cacheRoot = path.join(root, 'Library/PentacleMobileStorage/BuildCache');
  const external = path.join(root, 'foreign'); fs.renameSync(path.join(cacheRoot, 'entry'), external);
  fs.symlinkSync(external, path.join(cacheRoot, 'entry'));
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  assert.throws(() => cache.restore({ source: 'one' }, target), /CACHE_ADMISSION_REFUSED:CACHE_SYMLINK_ESCAPE/);
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(path.join(cacheRoot, 'entry'));
  fs.writeFileSync(path.join(cacheRoot, 'writer.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => cache.publish({ source: 'one' }, scratch), /CACHE_WRITER_BUSY/);
  fs.unlinkSync(path.join(cacheRoot, 'writer.lock'));
  fs.statfsSync = () => ({ bavail: 60 * 1024 ** 3, bsize: 1 });
  assert.equal(cache.publish({ source: 'one' }, scratch).reason, 'CACHE_STAGING_HEADROOM');
  assert.equal(fs.readFileSync(path.join(external, 'payload/derived-data/object.o'), 'utf8'), 'compiled');
}));

const fixtureRoots = [];
function temporary(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  fixtureRoots.push(root);
  return root;
}
after(() => {
  const { disposeIsolatedHome, mountedUnder } = require('./storage-test-teardown.cjs');
  const failures = [];
  for (const root of fixtureRoots.splice(0)) {
    try {
      if (!fs.existsSync(root)) {
        const mounts = mountedUnder(root);
        if (mounts.length) throw new Error(`TEST_TEARDOWN_MOUNT_LEAKED_AFTER_REMOVAL:${JSON.stringify(mounts)}`);
        continue;
      }
      disposeIsolatedHome(root);
    } catch (error) { failures.push(String(error.message || error)); }
  }
  if (failures.length) throw new Error(`FIXTURE_ROOTS_LEAKED:${failures.join('; ')}`);
});
function withHome(home, action) { const prior = process.env.HOME; process.env.HOME = home; try { return action(home); } finally { process.env.HOME = prior; fs.rmSync(home, { recursive: true, force: true }); } }
const identity = (canonical) => ({ canonical, device: '1', inode: '2', uid: process.getuid(), mode: 0o700 });
const seal = (suffix) => ({ object_id: `00000000-0000-4000-8000-00000000000${suffix}`, image: identity(`/fixed/${suffix}`) });

test('listed journal content id must equal its opaque filename before any decision', () => withHome(temporary('storage-cross-id'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const { listRecords } = require('./storage-state.cjs');
  const directory = path.join(fixedLayout().state, 'runs');
  fs.mkdirSync(directory, { recursive: true });
  const filenameId = '00000000-0000-4000-8000-000000000010';
  const contentId = '00000000-0000-4000-8000-000000000011';
  const record = { schema: 1, id: contentId, revision: 0, state: 'reserved', generation: '00000000-0000-4000-8000-000000000001', owner: { host: 'hosta', uid: process.getuid(), pid: 42 }, candidate_ref: 'a'.repeat(40), scratch_image: `${contentId}.sparsebundle`, evidence_image: `${contentId}.sparsebundle`, lock_token_digest: 'b'.repeat(64), reserved_at: '2026-07-17T00:00:00.000Z', first_dead_at: null };
  fs.writeFileSync(path.join(directory, `${filenameId}.json`), JSON.stringify(record));
  assert.throws(() => listRecords('runs'), /AUTHORITY_RECORD_ID_MISMATCH/);
}));

test('post-attach seal failure detaches and recoverably disposes the incomplete image', () => withHome(temporary('storage-attach-failure'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const containerModule = require('./storage-containers.cjs');
  const { createImage } = containerModule.bind(mutationCapability);
  const { imagePath } = containerModule;
  const id = '00000000-0000-4000-8000-000000000020';
  const calls = [];
  const execute = (binary, args) => {
    calls.push([binary, args[0]]);
    if (binary.endsWith('hdiutil') && args[0] === 'create') fs.mkdirSync(imagePath('scratch', id), { recursive: true });
    if (binary.endsWith('hdiutil') && args[0] === 'attach') fs.mkdirSync(path.join(fixedLayout().scratchMount, '.pentacle-container.json'));
    if (binary === '/usr/bin/trash') fs.rmSync(args[0], { recursive: true });
    return '';
  };
  assert.throws(() => createImage('scratch', id, execute));
  assert.equal(fs.existsSync(imagePath('scratch', id)), false);
  assert.ok(calls.some(([binary, action]) => binary.endsWith('hdiutil') && action === 'detach'));
  assert.ok(calls.some(([binary]) => binary === '/usr/bin/trash'));
}));

test('logical image caps exclude only top-level macOS volume metadata', () => withHome(temporary('storage-volume-metadata'), () => {
  const containers = require('./storage-containers.cjs');
  const root = path.join(os.homedir(), 'mounted-scratch');
  const topMetadata = path.join(root, '.Trashes');
  const nestedMetadata = path.join(root, 'payload', '.Trashes');
  fs.mkdirSync(topMetadata, { recursive: true, mode: 0o700 });
  fs.mkdirSync(nestedMetadata, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'payload', 'kept.txt'), 'payload\n');
  fs.chmodSync(topMetadata, 0o000);
  fs.chmodSync(nestedMetadata, 0o000);
  try {
    assert.throws(() => containers.exactDirectoryBytes(root), /EACCES/);
    assert.throws(() => containers.enforceCap('scratch', root), /EACCES/);
    fs.chmodSync(nestedMetadata, 0o700);
    assert.doesNotThrow(() => containers.enforceCap('scratch', root));
  } finally {
    fs.chmodSync(topMetadata, 0o700);
    fs.chmodSync(nestedMetadata, 0o700);
  }
}));

test('installed authority executes the exact adjacent lifecycle on one fsynced record', () => withHome(temporary('storage-installed-model'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const stateModule = require('./storage-state.cjs');
  const { transitionInstalledAuthority } = stateModule.bind(mutationCapability);
  const { canonicalIdentity } = stateModule;
  const layout = fixedLayout();
  for (const directory of [layout.state, layout.scratchImages, layout.evidenceImages, layout.worktrees, layout.repositories['pentacle-mobile']]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const authority = { schema: 1, generation: '00000000-0000-4000-8000-000000000001', host: os.hostname(), uid: process.getuid(), state: 'prepared', created_at: '2026-07-17T00:00:00.000Z', roots: { scratch_images: canonicalIdentity(layout.scratchImages), evidence_images: canonicalIdentity(layout.evidenceImages), worktrees: canonicalIdentity(layout.worktrees), repositories: { 'pentacle-mobile': canonicalIdentity(layout.repositories['pentacle-mobile']) } } };
  fs.writeFileSync(path.join(layout.state, 'authority.json'), `${JSON.stringify(authority)}\n`);
  assert.equal(transitionInstalledAuthority('prepared', 'installed').state, 'installed');
  assert.equal(transitionInstalledAuthority('installed', 'updating').state, 'updating');
  assert.equal(transitionInstalledAuthority('updating', 'installed').state, 'installed');
  assert.equal(transitionInstalledAuthority('installed', 'restoring').state, 'restoring');
  assert.equal(transitionInstalledAuthority('restoring', 'absent').state, 'absent');
  assert.throws(() => transitionInstalledAuthority('absent', 'installed'), /FORBIDDEN_TRANSITION/);
}));

test('simulator mutators accept only run ids and re-resolve the capped device set for every simctl call', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  // The second parameter is the created-udid report, defaulted so the production call site is
  // unchanged in shape; it carries NO device set and no path, so the arity property this test exists
  // for - simulator mutators accept run ids and re-resolve the capped set themselves - is unweakened.
  assert.match(source, /function createSimulator\(runId, onCreated = \(\) => undefined\)/);
  // The udid must reach the caller BEFORE the boot that can fail with the device already created.
  const created = source.indexOf('onCreated(udid);');
  assert.ok(created > 0 && created < source.indexOf("'boot', udid"), 'the created udid must be reported before the boot');
  assert.match(source, /function deleteSimulator\(runId, udid\)/);
  const create = source.slice(source.indexOf('function createSimulator'), source.indexOf('function deleteSimulator'));
  const remove = source.slice(source.indexOf('function deleteSimulator'), source.indexOf('async function runFullGate'));
  assert.equal((create.match(/resolveDeviceSet\(runId\)/g) || []).length, 4);
  assert.equal((remove.match(/resolveDeviceSet\(runId\)/g) || []).length, 2);
  assert.doesNotMatch(create + remove, /deviceSet\s*,/);
});

// Defect 1 (Luna example-04): teardown must drain the reparented CoreSimulator daemons that hold the
// Scratch mount before detach. Only launchd_sim carries the UDID in argv; its reparented children
// (biomed/suggestd/identityservicesd/com.apple.*) hold the mount purely by open FD, so the drain scopes
// by OPEN HANDLES under the exact device set path (lsof), escalates SIGTERM -> SIGKILL, and is
// fail-closed. Clock/lsof/signal are injected so the state machine is exercised offline. lsof `-Fpn`
// output is `p<pid>` records followed by `n<path>` records.
const DRAIN_DEVICE_SET = '/Users/x/Library/PentacleMobileStorage/Scratch/home/Library/Developer/PentacleCoreSimulator/Devices';

test('drainSimulatorHandles waits for open handles under the device set to disappear, then returns', () => {
  const { drainSimulatorHandles } = require('./storage-gate.cjs').bind(mutationCapability);
  let clock = 0;
  let poll = 0;
  const signals = [];
  const lsofSeq = [
    `p4242\nn${DRAIN_DEVICE_SET}/ABC/data/Library/Biome/x\n`,
    `p4242\nn${DRAIN_DEVICE_SET}/ABC/data/Library/Biome/x\n`,
    '',
  ];
  const result = drainSimulatorHandles(DRAIN_DEVICE_SET, {
    lsof: () => lsofSeq[Math.min(poll, lsofSeq.length - 1)],
    signal: (pid, name) => signals.push(`${name}:${pid}`),
    now: () => clock,
    sleep: (ms) => { clock += ms; poll += 1; },
  });
  assert.deepEqual(result, { drained: true, killed: false });
  assert.deepEqual(signals, []);
});

test('handle census never grants signal authority over an unrelated reader', () => {
  const { drainSimulatorHandles } = require('./storage-gate.cjs').bind(mutationCapability);
  const signals = []; let clock = 0; let reads = 0;
  drainSimulatorHandles(DRAIN_DEVICE_SET, {
    lsof: () => reads++ ? '' : `p4242\nn${DRAIN_DEVICE_SET}/ABC/data/reader\n`,
    signal: (...args) => signals.push(args), now: () => clock, sleep: (ms) => { clock += ms; },
  });
  assert.deepEqual(signals, []);
});

test('drainSimulatorHandles preserves an unrelated stuck holder and fails closed', () => {
  const { drainSimulatorHandles } = require('./storage-gate.cjs').bind(mutationCapability);
  let clock = 0;
  const signals = [];
  assert.throws(() => drainSimulatorHandles(DRAIN_DEVICE_SET, {
    lsof: () => `p4242\nn${DRAIN_DEVICE_SET}/ABC/data/var/run/launchd_bootstrap.plist\n`,
    signal: (pid, name) => signals.push(`${name}:${pid}`),
    now: () => clock,
    sleep: (ms) => { clock += ms; },
  }), /SIMULATOR_DRAIN_INCOMPLETE/);
  assert.deepEqual(signals, []);
});

test('drainSimulatorHandles ignores handles outside the device set and the wrapper itself, rejects a relative path', () => {
  const { drainSimulatorHandles } = require('./storage-gate.cjs').bind(mutationCapability);
  const signals = [];
  const result = drainSimulatorHandles(DRAIN_DEVICE_SET, {
    // pid 9999 holds a file OUTSIDE the device set; the wrapper (self) holds one inside — neither is a target.
    lsof: () => `p9999\nn/private/tmp/other/file\np${process.pid}\nn${DRAIN_DEVICE_SET}/ABC/data/self\n`,
    signal: (pid, name) => signals.push(`${name}:${pid}`),
    now: () => 0,
    sleep: () => {},
  });
  assert.deepEqual(result, { drained: true, killed: false });
  assert.deepEqual(signals, []);
  assert.throws(() => drainSimulatorHandles('relative/devices', { lsof: () => '', signal: () => {}, now: () => 0, sleep: () => {} }), /SIMULATOR_DRAIN_DEVICE_SET_INVALID/);
});

test('drainSimulatorHandles treats an lsof timeout/error as a failed read, never a clean drain', () => {
  // QA reject 2026-09-08: a lsof child timeout returns empty stdout; that absence-of-answer must not be
  // read as absence-of-holders. An unreliable read never returns drained and fails closed at the budget.
  const { drainSimulatorHandles } = require('./storage-gate.cjs').bind(mutationCapability);
  let clock = 0;
  const signals = [];
  assert.throws(() => drainSimulatorHandles(DRAIN_DEVICE_SET, {
    lsof: () => { const error = new Error('spawnSync lsof ETIMEDOUT'); error.code = 'ETIMEDOUT'; throw error; },
    signal: (pid, name) => signals.push(`${name}:${pid}`),
    now: () => clock,
    sleep: (ms) => { clock += ms; },
  }), /SIMULATOR_DRAIN_INCOMPLETE/);
  assert.deepEqual(signals, [], 'an unreadable poll signals nobody');
});

test('drainSimulatorHandles recovers when lsof succeeds after a transient failure', () => {
  const { drainSimulatorHandles } = require('./storage-gate.cjs').bind(mutationCapability);
  let clock = 0;
  let poll = 0;
  const result = drainSimulatorHandles(DRAIN_DEVICE_SET, {
    lsof: () => { poll += 1; if (poll === 1) { throw new Error('spawnSync lsof ETIMEDOUT'); } return ''; },
    signal: () => {},
    now: () => clock,
    sleep: (ms) => { clock += ms; },
  });
  assert.deepEqual(result, { drained: true, killed: false });
});

test('worktree source digest binds lifecycle, sidecar, and ticket authority', () => {
  const { sourceDigest } = require('./storage-worktrees.cjs');
  const identity = (canonical, inode) => ({ canonical, device: '1', inode, uid: process.getuid(), mode: 0o700 });
  const base = { folder_name: 'pentacle-mobile__x', status: 'completed', folder_identity: identity('/memory/x', '1'), spec: { id: 'spec_x', owner: 'lead', branch: 'fix/x' }, summary: { id: 'work_x', owner: 'lead', branch: 'fix/x' }, spec_source: { digest: 'a'.repeat(64), identity: identity('/memory/x/spec.md', '2'), size: 10 }, summary_source: { digest: 'b'.repeat(64), identity: identity('/memory/x/summary.md', '3'), size: 10 } };
  const authority = { main_repo_id: 'pentacle-mobile', spec_id: 'spec_x', lane_id: 'pentacle-mobile__x', branch: 'fix/x', upstream: 'origin/fix/x', head: 'c'.repeat(40), generation: '00000000-0000-4000-8000-000000000001', creator: { host: 'hosta', uid: process.getuid(), pid: 42 }, device: '4', inode: '5' };
  const digest = sourceDigest(base, authority);
  assert.notEqual(digest, sourceDigest({ ...base, status: 'deprecated' }, authority));
  assert.notEqual(digest, sourceDigest({ ...base, spec_source: { ...base.spec_source, digest: 'd'.repeat(64) } }, authority));
  assert.throws(() => sourceDigest(base, { ...authority, branch: 'fix/other' }), /SOURCE_TICKET_BINDING/);
});

test('delete and publication authority is re-read and cleanup failure cannot publish', () => {
  const janitor = fs.readFileSync(path.join(__dirname, 'storage-janitor.cjs'), 'utf8');
  const gate = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  assert.match(janitor, /const currentDecision = runDecision\(run, now, manual\)/);
  assert.match(janitor, /JANITOR_AUTHORIZATION_DRIFT/);
  // The lifecycle suite proves a reported cleanup error blocks otherwise valid publication.
  // Cleanup failure must still block publication, but it must no longer erase WHY. The aggregate carries a
  // labelled step per failure, and the child's real exit code survives instead of a flat 17 - run example-03
  // showed one deterministic cleanup bug hiding a real release-sim-build failure behind exactly that 17.
  assert.match(gate, /throw new Error\(`GATE_CLEANUP_FAILED\[\$\{failures\.join\('; '\)\}\]`\)/);
  assert.match(gate, /gate_status: Number\.isInteger\(childStatus\) \? childStatus : 17/);
  assert.doesNotMatch(gate, /new AggregateError\(/);
  assert.equal((gate.match(/cleanup: cleanupResources/g) || []).length, 1);
});

test('manual failed-scratch reclamation cannot widen its own authority or skip the journal', () => {
  const janitor = fs.readFileSync(path.join(__dirname, 'storage-janitor.cjs'), 'utf8');
  // The protected set is derived from the journal inside the verb, never accepted from the caller.
  assert.match(janitor, /const manual = \{ kind: 'reclaim-scratch', run_id: runId, protected: protectedFailures\(\) \}/);
  // Scoped to failures, and routed through applyRun so the discard is a recorded state transition
  // rather than an unlink. An image is only ever removed by the shared discard-scratch body.
  assert.match(janitor, /if \(run\.state !== 'blocked_unclassified'\) throw new Error\('FAILED_SCRATCH_RECLAMATION_NOT_AUTHORIZED'\)/);
  assert.match(janitor, /return applyRun\(runId, decision, now, manual\)/);
  // No unlink anywhere in the janitor targets an image. Both container discard primitives share the
  // positive detach proof, and recovery is reachable only after the discarding transition is recorded.
  for (const line of janitor.split('\n').filter((entry) => entry.includes('unlinkSync'))) assert.doesNotMatch(line, /imagePath/);
  // The override is the sole consumer of the manual context, and it substitutes for exactly one term.
  assert.equal((janitor.match(/manualReclaimAuthorized/g) || []).length, 2);
  assert.match(janitor, /if \(manualOverride && !manualReclaimAuthorized\(run, manual\)\) return \{ action: 'retain', reason: 'dead-under-24h' \}/);
});

test('worktree removing and scheduler mutation have durable forward recovery and singleton generation binding', () => {
  const worktrees = fs.readFileSync(path.join(__dirname, 'storage-worktrees.cjs'), 'utf8');
  const scheduler = fs.readFileSync(path.join(__dirname, 'storage-scheduler.cjs'), 'utf8');
  assert.match(worktrees, /\['registered', 'removing'\]\.includes\(ticket\.state\)/);
  assert.match(worktrees, /if \(!registered\.length\).*WORKTREE_REMOVAL_AMBIGUOUS/s);
  assert.match(scheduler, /flag: 'wx'/);
  assert.match(scheduler, /SCHEDULER_SINGLETON_HELD/);
  assert.match(scheduler, /transaction\.generation !== authority\.generation/);
  assert.match(scheduler, /transitionInstalledAuthority\('installed', 'updating'\)/);
  assert.match(scheduler, /transitionInstalledAuthority\('installed', 'restoring'\)/);
});

test('failed first scheduler install recovery returns installed authority to absent', () => withHome(temporary('storage-install-rollback'), (home) => {
  const result = execFileSync(process.execPath, [path.join(__dirname, 'storage-scheduler-recovery-worker.cjs')], { cwd: __dirname, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS });
  assert.equal(result, 'absent');
}));

test('cross-device backing is compared for every image root against the support device', () => {
  // SOURCE-LEVEL AND KEPT ALONGSIDE the behavioural test below, not instead of it. The behavioural
  // version attaches a real second filesystem per image root and lives 30-odd lines down in this file;
  // read it before concluding no behavioural coverage exists. (This comment previously said the
  // behavioural version needed a subprocess worker and a storage-capability.cjs TRUSTED widening and was
  // "deferred to a decision". Both halves are wrong: withHome plus the call-time HOME read builds an
  // isolated installed authority in-process, no allowlist widening is required, and the test was written.
  // The estimate was retracted at the time and this comment was not - R1, a correction stopping where the
  // question first looked answered.)
  //
  // The two tests fail DIFFERENTLY and that is why both stay. This one pins that all three image roots
  // are compared against the SUPPORT device rather than against each other - comparing them only pairwise
  // would pass while every one of them sat on the wrong volume, which no mount-based test detects.
  const state = fs.readFileSync(path.join(__dirname, 'storage-state.cjs'), 'utf8');
  const guard = state.split('\n').find((line) => line.includes('AUTHORITY_CROSS_DEVICE_BACKING'));
  assert.ok(guard, 'the cross-device guard must exist');
  assert.match(state, /const backingDevice = canonicalIdentity\(layout\.support\)\.device;/);
  for (const root of ['scratchImages', 'evidenceImages', 'stateImage']) {
    assert.ok(guard.includes(`canonicalIdentity(layout.${root}).device !== backingDevice`), `${root} must be compared against the support device`);
  }
});

// Behavioural cross-device test, ALL THREE image roots. Attaches a REAL second filesystem per root,
// because that is the only way to make two paths differ by st_dev. A source-shape assertion is kept
// ALONGSIDE this rather than replaced by it: that one pins that the three are compared against the SUPPORT
// device rather than pairwise, and pairwise would pass with all three on the wrong volume - a failure this
// behavioural test cannot catch, because behaviourally all three would agree with each other.
//
// Three disciplines, and the second and third exist because this lane's founding defect is leaked mounts
// (backlog pentacle-mobile__storage_suite_teardown_leak_2026_07). A test that attaches and leaks would
// instantiate the very defect it was written under.
//   - PER-ROOT positive control BEFORE each assertion: mount count at baseline+1 AND the root's device
//     actually differing from support. One control for the set would let attach 2 or 3 fail silently, see
//     one filesystem, never trigger the guard, and pass while proving nothing.
//   - PER-ROOT detach in a finally, so a throw still releases.
//   - Baseline re-asserted AFTER EACH root. An end-only check says something leaked; a per-root check says
//     WHICH, and on a three-attach test that difference is the whole diagnosis.
test('installed authority rejects each image root backed by a different filesystem', () => {
  // Asserts on THIS test's own mount path, not on a global mount COUNT. node --test runs files in
  // parallel, so a count is racy - measured: baseline 14, expected 15, actual 16, because a concurrent
  // file had an image attached at that instant. A per-path check is also strictly more precise, since a
  // count can tell you something leaked but never whose.
  const isMounted = (target) => execFileSync('/sbin/mount', { encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS }).split('\n').some((line) => line.includes(` on ${target} `));
  for (const rootKey of ['scratchImages', 'evidenceImages', 'stateImage']) {
    const image = path.join(temporary(`storage-xdev-${rootKey}`), 'second.sparsebundle');
    execFileSync('/usr/bin/hdiutil', ['create', '-size', '10m', '-fs', 'APFS', '-volname', 'xdev', '-type', 'SPARSEBUNDLE', image], { stdio: 'ignore', timeout: FIXTURE_TIMEOUT_MS });
    let attached = null;
    let mountedPath = null;
    try {
      withHome(temporary(`storage-xdev-home-${rootKey}`), () => {
        const { fixedLayout } = require('./storage-authority.cjs');
        const stateModule = require('./storage-state.cjs');
        const { canonicalIdentity, validateInstalledAuthority } = stateModule;
        const layout = fixedLayout();
        for (const directory of [layout.state, layout.scratchImages, layout.evidenceImages, layout.worktrees, layout.stateImage, layout.repositories['pentacle-mobile']]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

        execFileSync('/usr/bin/hdiutil', ['attach', image, '-nobrowse', '-mountpoint', layout[rootKey]], { stdio: 'ignore', timeout: FIXTURE_TIMEOUT_MS });
        attached = layout[rootKey];
        mountedPath = fs.realpathSync(layout[rootKey]);
        // Detach INSIDE withHome. Its own finally removes the home tree, and that runs BEFORE any outer
        // finally - so detaching outside leaves the mount up while the tree is being removed and the real
        // assertion is lost behind an ENOTEMPTY. Measured, not theorised.
        try {
          assert.ok(isMounted(fs.realpathSync(layout[rootKey])), `${rootKey}: the second filesystem must actually be attached`);
          assert.notEqual(canonicalIdentity(layout[rootKey]).device, canonicalIdentity(layout.support).device, `${rootKey}: must be cross-device or this assertion proves nothing`);

          const authority = { schema: 1, generation: '00000000-0000-4000-8000-000000000001', host: os.hostname(), uid: process.getuid(), state: 'installed', created_at: '2026-07-17T00:00:00.000Z', roots: { scratch_images: canonicalIdentity(layout.scratchImages), evidence_images: canonicalIdentity(layout.evidenceImages), worktrees: canonicalIdentity(layout.worktrees), repositories: { 'pentacle-mobile': canonicalIdentity(layout.repositories['pentacle-mobile']) } } };
          fs.writeFileSync(path.join(layout.state, 'authority.json'), `${JSON.stringify(authority)}\n`);

          assert.throws(() => validateInstalledAuthority(), /AUTHORITY_CROSS_DEVICE_BACKING/, `${rootKey}: cross-device backing must be rejected`);
        } finally {
          execFileSync('/usr/bin/hdiutil', ['detach', attached, '-force'], { stdio: 'ignore', timeout: FIXTURE_TIMEOUT_MS });
          attached = null;
        }
      });
    } finally {
      if (attached) execFileSync('/usr/bin/hdiutil', ['detach', attached, '-force'], { stdio: 'ignore', timeout: FIXTURE_TIMEOUT_MS });
    }
    assert.equal(isMounted(mountedPath), false, `${rootKey}: must leave no mount behind`);
  }
});

// LAYER 10 FOLLOW-UP - the QA reject of example-02, reproduced by execution against the real host journal
// before it was upheld. The failure-explained invariant began life inside validateRecord, which readRecord
// and listRecords also call, so a rule written today applied RETROACTIVELY to records written before it
// existed: example-06 and example-13 both carry a non-zero gate_status with no failure, so listRecords('runs')
// threw and the scheduled janitor could not enumerate AT ALL. Not degraded - a total outage of the
// reclamation agent, in the lane built to create it, and indefinite because unclassified non-zero evidence
// is retained forever. R7.
function journalRun(id, extra = {}) {
  return {
    schema: 1, id, revision: 4, state: 'sealing', generation: '00000000-0000-4000-8000-000000000001',
    owner: { host: os.hostname(), uid: process.getuid(), pid: process.pid },
    candidate_ref: 'a'.repeat(40), scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64), reserved_at: '2026-07-22T00:00:00.000Z', first_dead_at: null,
    scratch_seal: seal(2), evidence_seal: seal(3), device_set_identity: identity('/fixed/set'),
    allocated_at: '2026-07-22T00:00:01.000Z', handoff_from_pid: process.pid,
    running_at: '2026-07-22T00:00:02.000Z', sealing_at: '2026-07-22T00:00:03.000Z', ...extra,
  };
}

function newJournalRun(id, extra = {}) {
  return journalRun(id, { gate_code_sha: 'c'.repeat(40), gate_code_tree_clean: true, ...extra });
}

test('a legacy run recorded before the failure-explained rule is still readable and still enumerable', () => withHome(temporary('storage-legacy-run'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const { listRecords, readRecord } = require('./storage-state.cjs');
  const directory = path.join(fixedLayout().state, 'runs');
  fs.mkdirSync(directory, { recursive: true });
  // The exact shape of example-06: gate_status non-zero, failure absent. Written directly, because a
  // journal is an audit record and the point is that it was written before the rule.
  const legacy = '00000000-0000-4000-8000-00000000005f';
  const explained = '00000000-0000-4000-8000-000000000044';
  fs.writeFileSync(path.join(directory, `${legacy}.json`), JSON.stringify(journalRun(legacy, { gate_status: 1 })));
  fs.writeFileSync(path.join(directory, `${explained}.json`), JSON.stringify(journalRun(explained, { gate_status: 17, failure: 'GATE_CLEANUP_INCOMPLETE child=release-sim-build' })));
  assert.equal(readRecord('runs', legacy).gate_status, 1, 'reading a pre-rule record must not throw');
  // THE REGRESSION ITSELF: this call threw before the fix, and storage-janitor.cjs enumerates every run
  // through it. Both records must come back - the sweep may not lose the other one either.
  assert.deepEqual(listRecords('runs').map((record) => record.id).sort(), [explained, legacy].sort());
}));

test('a non-zero gate status without a cause is refused on WRITE, and only on write', () => withHome(temporary('storage-write-invariant'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const stateMutations = require('./storage-state.cjs').bind(mutationCapability);
  const directory = path.join(fixedLayout().state, 'runs');
  fs.mkdirSync(directory, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000070';
  // POSITIVE CONTROL - a failure that states its cause is accepted, so the rejection below cannot pass
  // by the fixture being invalid for some unrelated reason.
  assert.equal(stateMutations.createRecord('runs', newJournalRun(id, { gate_status: 1, failure: 'GATE_STATUS_NONZERO:1 child=sim-e2e failed' })).gate_status, 1);
  const bare = '00000000-0000-4000-8000-000000000071';
  for (const status of [1, 17, 130, 143]) {
    assert.throws(() => stateMutations.createRecord('runs', newJournalRun(bare, { gate_status: status })), /AUTHORITY_RECORD_RUN_FAILURE_UNEXPLAINED/, `create with status ${status}`);
  }
  // A green run still needs no cause.
  assert.equal(stateMutations.createRecord('runs', newJournalRun(bare, { gate_status: 0 })).gate_status, 0);
}));

test('gate-code provenance is admitted as an immutable pair without invalidating legacy runs', () => withHome(temporary('storage-gate-provenance-schema'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const { readRecord } = require('./storage-state.cjs');
  const stateMutations = require('./storage-state.cjs').bind(mutationCapability);
  const legacyId = '00000000-0000-4000-8000-000000000072';
  const directory = path.join(fixedLayout().state, 'runs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${legacyId}.json`), JSON.stringify(journalRun(legacyId, { gate_status: 0 })));
  assert.equal(readRecord('runs', legacyId).id, legacyId);
  assert.throws(() => stateMutations.createRecord('runs', journalRun('00000000-0000-4000-8000-000000000075', { gate_status: 0 })), /AUTHORITY_RECORD_RUN_PROVENANCE_REQUIRED/);

  const id = '00000000-0000-4000-8000-000000000073';
  const gateCodeSha = 'c'.repeat(40);
  const created = stateMutations.createRecord('runs', newJournalRun(id, {
    gate_status: 0,
    gate_code_sha: gateCodeSha,
  }));
  assert.equal(created.gate_code_sha, gateCodeSha);
  assert.throws(() => stateMutations.createRecord('runs', journalRun('00000000-0000-4000-8000-000000000074', {
    gate_status: 0,
    gate_code_sha: gateCodeSha,
  })), /AUTHORITY_RECORD_RUN/);
  assert.throws(() => stateMutations.replaceRecord('runs', id, created.revision, {
    ...created,
    revision: created.revision + 1,
    gate_code_sha: 'd'.repeat(40),
  }), /AUTHORITY_IMMUTABLE_FIELD:gate_code_sha/);
}));

test('grandfathering lets a legacy run retire but cannot launder a new failure', () => withHome(temporary('storage-grandfather'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const stateMutations = require('./storage-state.cjs').bind(mutationCapability);
  const directory = path.join(fixedLayout().state, 'runs');
  fs.mkdirSync(directory, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000080';
  const legacy = journalRun(id, { gate_status: 1 });
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(legacy));
  // A legacy record must still be able to move on, or the janitor could never retire it and the change
  // would leak the very images this lane exists to reclaim - the founding defect, one step later.
  const next = { ...legacy, state: 'blocked_unclassified', revision: 5, classification_error: 'recovered' };
  assert.equal(stateMutations.replaceRecord('runs', id, 4, next).state, 'blocked_unclassified');

  // AND THE NEGATIVE HALF, which is what keeps the clause from being a loophole. The path that matters is
  // a record ACQUIRING a non-zero status - every real run does exactly this at the sealing transition -
  // and there the exemption cannot apply, because there is no prior value to match.
  const fresh = '00000000-0000-4000-8000-000000000081';
  const running = journalRun(fresh, { state: 'running' });
  delete running.sealing_at;
  fs.writeFileSync(path.join(directory, `${fresh}.json`), JSON.stringify(running));
  assert.throws(() => stateMutations.replaceRecord('runs', fresh, 4, { ...running, state: 'sealing', revision: 5, gate_status: 1, sealing_at: '2026-07-22T00:00:03.000Z' }), /AUTHORITY_RECORD_RUN_FAILURE_UNEXPLAINED/);
  // POSITIVE CONTROL for that same transition: stating the cause is all it takes.
  assert.equal(stateMutations.replaceRecord('runs', fresh, 4, { ...running, state: 'sealing', revision: 5, gate_status: 1, sealing_at: '2026-07-22T00:00:03.000Z', failure: 'GATE_STATUS_NONZERO:1 child=sim-e2e failed' }).gate_status, 1);

  // Recorded because it changes what the clause is load-bearing FOR, and I got it wrong first: mutating
  // an existing gate_status is already impossible one layer down - it is in IMMUTABLE_FIELDS, so
  // replaceRecord refuses it as AUTHORITY_IMMUTABLE_FIELD regardless of this rule. The exemption
  // therefore cannot be widened by changing a status either, and the two guards are independent.
  assert.throws(() => stateMutations.replaceRecord('runs', id, 5, { ...next, gate_status: 143, revision: 6 }), /AUTHORITY_IMMUTABLE_FIELD:gate_status/);
}));

test('one unreadable record is reported present-but-invalid, never dropped, and never blinds the sweep', () => withHome(temporary('storage-unreadable'), () => {
  const { fixedLayout } = require('./storage-authority.cjs');
  const { listRecords } = require('./storage-state.cjs');
  const directory = path.join(fixedLayout().state, 'runs');
  fs.mkdirSync(directory, { recursive: true });
  const good = '00000000-0000-4000-8000-000000000090';
  const truncated = '00000000-0000-4000-8000-000000000091';
  const malformed = '00000000-0000-4000-8000-000000000092';
  fs.writeFileSync(path.join(directory, `${good}.json`), JSON.stringify(journalRun(good, { gate_status: 0 })));
  fs.writeFileSync(path.join(directory, `${truncated}.json`), '{"schema":1,"id":"000');
  fs.writeFileSync(path.join(directory, `${malformed}.json`), JSON.stringify(journalRun(malformed, { gate_status: 0, state: 'invented' })));
  // POSITIVE CONTROL for the default: with no collector nothing is loosened, so every existing caller
  // keeps failing closed exactly as before.
  assert.throws(() => listRecords('runs'), /AUTHORITY_RECORD|EXACT_JSON|JSON/);
  const seen = [];
  const records = listRecords('runs', (id, error) => seen.push({ id, error }));
  // The valid record survives BOTH bad ones - one corrupt record may not blind the agent to the others.
  assert.deepEqual(records.map((record) => record.id), [good]);
  // Reported, both of them, each naming itself. Silence here would be the rubber stamp.
  assert.deepEqual(seen.map((entry) => entry.id).sort(), [malformed, truncated].sort());
  for (const entry of seen) assert.ok(entry.error.length > 0, `${entry.id} must name why`);
}));

test('the janitor counts an unreadable record as present-but-invalid, not as absent', () => {
  // The distinction the accounting invariant turns on. An OMITTED record makes evidence-images ==
  // journal-runs reconcile against a corpus with a hole in it, so a genuinely leaked image can be masked
  // by the arithmetic working out. Counted-and-named is the only safe shape, and via the layer-10
  // contract it also makes the scheduled janitor exit non-zero for it.
  const janitor = fs.readFileSync(path.join(__dirname, 'storage-janitor.cjs'), 'utf8');
  const collector = janitor.slice(janitor.indexOf('const unreadable ='), janitor.indexOf('for (const run of listRecords'));
  assert.match(collector, /report\.entries\.push/, 'an unreadable record must appear in the enumeration');
  assert.match(collector, /report\.errors\.push/, 'and must be named as an error so the exit code carries it');
  assert.match(collector, /blocked-unreadable/, 'with an action that is explicitly not a decision');
  // It must never reach a path that can delete something.
  assert.equal(janitor.includes('runDecision(unreadable'), false);
});

// Test-side children get the same rule as the product's: a bound, and a status that is READ. A
// synchronous child cannot be interrupted by node:test's timeout, and a cleanup that ignores its
// detach status can unlink a backing image while its volume is still mounted - the one outcome the
// product guard exists to prevent, reintroduced by the fixture that tests it.
function fixtureSpawn(binary, args, options = {}) {
  const result = require('node:child_process').spawnSync(binary, args, { encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS, ...options });
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) throw new Error(`FIXTURE_COMMAND_TIMEOUT:${path.basename(binary)}`);
  return result;
}
// Unlink only what is provably no longer mounted - and "provably" means the same thing here as in
// the product: this module documents and measured false ABSENCE under concurrent hdiutil activity,
// so ONE snapshot reading empty is not proof. Absence must hold across consecutive observations
// before a backing image is unlinked.
function fixtureDiscard(kind, image) {
  const containerModule = require('./storage-containers.cjs');
  const mount = containerModule.mountPath(kind);
  const detach = fixtureSpawn('/usr/bin/hdiutil', ['detach', mount]);
  for (let confirmation = 0; confirmation < 3; confirmation += 1) {
    const attached = containerModule.attachedImageAt(mount);
    if (attached) throw new Error(`FIXTURE_STILL_MOUNTED:${kind}:${detach.status}:${attached}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  fs.rmSync(image, { recursive: true, force: true });
}

test('a journal-authorized scratch discard unlinks the image and leaves no Trash copy', { timeout: 120000 }, () => {
  // The disk-hygiene regression. Discarding scratch by MOVING it to Trash left a second copy of up
  // to 12 GiB of reproducible build cache on the same volume until a human emptied the Trash, so
  // consecutive certified runs walked free space toward the 60 GiB start floor while each reported
  // its scratch reclaimed (measured 2026-07-22). Real image, real mount, real unlink - a recorded
  // fake would only prove which string we passed, not that the bytes are actually gone.
  // The oracle names THIS image, not "nothing new in Trash": the suite runs its files concurrently
  // against one host Trash, and the unauthorized-path cleanups in createImage/recoverOrCreate do
  // still trash images by design, so a whole-directory delta is a cross-test flake, not a finding.
  // The fixture id is FIXED, so a run that fails the branch oracle - the loosened-branch negative
  // control is exactly that - trashes an image under a name this test then reads on its NEXT run.
  // Left uncleaned it poisons the suite: one such artifact turned the following full storage run
  // red at 226/227. So every exit path detaches, unlinks, and clears this one uniquely owned name,
  // and the assertions run inside the try so a failure still cleans up after itself.
  const trashRoot = path.join(os.homedir(), '.Trash');
  const id = '00000000-0000-4000-8000-000000000060';
  withHome(temporary('storage-scratch-discard'), () => {
    const containerModule = require('./storage-containers.cjs');
    const { createImage, detachAndDiscard } = containerModule.bind(mutationCapability);
    const { imagePath } = containerModule;
    const calls = [];
    const recorded = (binary, args, options = {}) => {
      calls.push({ binary, args: [...args] });
      const result = fixtureSpawn(binary, args, options);
      if (result.error || result.status !== 0) throw new Error(`RECORDED_COMMAND_FAILED:${binary}:${result.status}`);
      return String(result.stdout || '').trim();
    };
    const created = createImage('scratch', id);
    assert.equal(fs.existsSync(imagePath('scratch', id)), true);
    try {
      assert.deepEqual(detachAndDiscard('scratch', id, created.seal, recorded), { discarded: 'scratch', run_id: id });
      assert.equal(fs.existsSync(imagePath('scratch', id)), false, 'the backing image must be gone from the volume');
      assert.equal(calls.some(({ binary }) => binary === '/usr/bin/trash'), false, 'an authorized scratch discard must never trash');
      const detaches = calls.slice(0, -1);
      assert.ok(detaches.length >= 1 && detaches.length <= 5, `one to five ordinary detach attempts before unlink, got ${detaches.length}`);
      assert.ok(detaches.every(({ binary, args }) => binary === '/usr/bin/hdiutil' && args[0] === 'detach' && args.length === 2 && /^\/dev\/disk\d+$/.test(args[1]) && !args.includes('-force')));
      assert.deepEqual(calls.at(-1), { binary: '/bin/rm', args: ['-rf', '--', imagePath('scratch', id)] });
      assert.equal(fs.existsSync(path.join(trashRoot, `${id}.sparsebundle`)), false, 'the discarded image must not reappear in the operator Trash');
    } finally {
      fixtureDiscard('scratch', imagePath('scratch', id));
      fs.rmSync(path.join(trashRoot, `${id}.sparsebundle`), { recursive: true, force: true });
    }
  });
});

test('an authorized evidence discard still trashes, so a wrong one stays recoverable', () => withHome(temporary('storage-evidence-discard'), () => {
  // The deliberate asymmetry to scratch. Evidence is the failure artifact this lane treats as the
  // most valuable object on the host and is capped at 2 GiB, so the second copy is worth its bytes.
  // The trash call is intercepted rather than performed: proving the branch selection must not
  // require putting a test image into the operator's real Trash.
  const containerModule = require('./storage-containers.cjs');
  const { createImage, detachAndDiscard } = containerModule.bind(mutationCapability);
  const { imagePath } = containerModule;
  const id = '00000000-0000-4000-8000-000000000061';
  const calls = [];
  const intercepted = (binary, args) => {
    calls.push(binary);
    if (binary === '/usr/bin/trash') { fs.rmSync(args[0], { recursive: true }); return ''; }
    const result = fixtureSpawn(binary, args);
    if (result.error || result.status !== 0) throw new Error(`RECORDED_COMMAND_FAILED:${binary}:${result.status}`);
    return String(result.stdout || '').trim();
  };
  const created = createImage('evidence', id);
  try {
    assert.deepEqual(detachAndDiscard('evidence', id, created.seal, intercepted), { discarded: 'evidence', run_id: id });
  } catch (error) {
    fixtureDiscard('evidence', imagePath('evidence', id));
    throw error;
  }
  assert.deepEqual(calls, ['/usr/bin/hdiutil', '/usr/bin/trash']);
  assert.equal(calls.includes('/bin/rm'), false, 'evidence must not take the unlink branch');
}));

test('every container command carries a bound, and the read-only probe a much smaller one', () => {
  // Runtime oracles above cover the retry DECISIONS. This one covers the property underneath them,
  // which no fixture can observe without spawning a genuinely wedged child: an unbounded spawnSync
  // cannot be retried at all, because it never returns. Measured cause, 2026-07-22: plutil sat on
  // its stdin for 50 s+ under concurrent hdiutil load and the wrapper waited forever.
  const source = fs.readFileSync(path.join(__dirname, 'storage-containers.cjs'), 'utf8');
  assert.match(source, /timeout: COMMAND_TIMEOUT_MS, \.\.\.options/, 'every container command must carry a bound');
  assert.match(source, /CONTAINER_COMMAND_TIMEOUT/, 'and a timeout must be named, not reported as a generic failure');
  assert.equal((source.match(/timeout: PROBE_TIMEOUT_MS/g) || []).length, 2, 'both halves of the read-only probe are bounded');
  assert.ok(/COMMAND_TIMEOUT_MS = 180000/.test(source) && /PROBE_TIMEOUT_MS = 20000/.test(source), 'the bounds are explicit');
});

// Runtime oracles for the absence retry. The OS race cannot be scheduled, but every DECISION it
// feeds can be: the inventory seam is scripted, and each case asserts the outcome AND how many
// times the guard asked. A source-shape assertion alone missed that recoverOrCreate had its own
// one-shot probe, which is exactly the destructive one.
function mountedFixture(unusedHome, id) {
  const { fixedLayout } = require('./storage-authority.cjs');
  const { canonicalIdentity } = require('./storage-state.cjs');
  const containerModule = require('./storage-containers.cjs');
  const layout = fixedLayout();
  const image = containerModule.imagePath('scratch', id);
  fs.mkdirSync(image, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.scratchMount, { recursive: true, mode: 0o700 });
  const seal = { object_id: '00000000-0000-4000-8000-0000000000aa', image: canonicalIdentity(image) };
  fs.writeFileSync(path.join(layout.scratchMount, '.pentacle-container.json'), `${JSON.stringify({ schema: 1, kind: 'scratch', run_id: id, limit: containerModule.LIMITS.scratch, seal })}\n`, { mode: 0o600 });
  return { image, mount: layout.scratchMount, seal };
}

function scriptedInventory(answers) {
  const probes = [];
  const inventory = (mount) => {
    probes.push(mount);
    const answer = answers[Math.min(probes.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { inventory, probes };
}

test('failed Scratch force boundary refuses seal/device/activity drift and proves absence before disposal', () => withHome(temporary('storage-force-scratch'), (home) => {
  const id = '00000000-0000-4000-8000-0000000000a4';
  const fixture = mountedFixture(home, id);
  const foreign = path.join(path.dirname(fixture.image), 'foreign-sentinel');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
  const { forceDiscardFailedScratch } = require('./storage-containers.cjs').bind(mutationCapability);
  let detached = false;
  let remainsAttached = false;
  const calls = [];
  const inventory = () => detached && !remainsAttached
    ? { attached: null, expectedAttachment: null, enumerated: 1, foreign: 1 }
    : { attached: fixture.image, expectedAttachment: { image: fixture.image, device: '/dev/disk91' }, enumerated: 2, foreign: 1 };
  const execute = (binary, args) => {
    calls.push({ binary, args });
    if (binary === '/usr/bin/hdiutil') { assert.deepEqual(args, ['detach', '-force', '/dev/disk91']); detached = true; }
    else { assert.equal(binary, '/bin/rm'); assert.deepEqual(args, ['-rf', '--', fixture.image]); fs.rmSync(fixture.image, { recursive: true }); }
  };
  assert.throws(() => forceDiscardFailedScratch(id, { ...fixture.seal, object_id: 'foreign' }, '/dev/disk91', () => true, execute, inventory), /CONTAINER_JOURNAL_SEAL_MISMATCH/);
  assert.throws(() => forceDiscardFailedScratch(id, fixture.seal, '/dev/disk92', () => true, execute, inventory), /SYSTEM_SCRATCH_FORCE_AUTHORITY/);
  assert.throws(() => forceDiscardFailedScratch(id, fixture.seal, '/dev/disk91', () => false, execute, inventory), /SYSTEM_SCRATCH_FORCE_AUTHORITY/);
  assert.deepEqual(calls, []);
  remainsAttached = true;
  assert.throws(() => forceDiscardFailedScratch(id, fixture.seal, '/dev/disk91', () => true, execute, inventory), /CONTAINER_STILL_MOUNTED/);
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(fixture.image), true);
  detached = false;
  remainsAttached = false;
  assert.deepEqual(forceDiscardFailedScratch(id, fixture.seal, '/dev/disk91', () => true, execute, inventory), { discarded: 'scratch', run_id: id });
  assert.equal(fs.existsSync(fixture.image), false);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
}));

const absent = { attached: null, enumerated: 4, foreign: 3 };
const timedOut = () => new Error('CONTAINER_COMMAND_TIMEOUT:plutil:20000');

test('a flickering absence is re-asked and the mount is resolved, not condemned', () => withHome(temporary('storage-absence-retry'), (home) => {
  const id = '00000000-0000-4000-8000-0000000000a1';
  const fixture = mountedFixture(home, id);
  const present = { attached: fixture.image, enumerated: 4, foreign: 3 };
  const { resolveMounted } = require('./storage-containers.cjs');
  for (const [label, answers, expectedProbes] of [
    ['absence then match', [absent, present], 2],
    ['timeout then match', [timedOut(), present], 2],
    ['two flickers then match', [absent, timedOut(), present], 3],
  ]) {
    const scripted = scriptedInventory(answers);
    assert.equal(resolveMounted('scratch', id, scripted.inventory).image, fixture.image, label);
    assert.equal(scripted.probes.length, expectedProbes, `${label}: probe count`);
  }
}));

test('a stubborn absence and a drifted mount are still believed, on their own terms', () => withHome(temporary('storage-absence-final'), (home) => {
  const id = '00000000-0000-4000-8000-0000000000a2';
  const fixture = mountedFixture(home, id);
  const { resolveMounted } = require('./storage-containers.cjs');
  const stubborn = scriptedInventory([absent]);
  assert.throws(() => resolveMounted('scratch', id, stubborn.inventory), /CONTAINER_MOUNT_ABSENT.*"attempts":3/);
  assert.equal(stubborn.probes.length, 3, 'absence is believed only after the bound');
  // Drift is our defect in every case, so it costs exactly ONE probe - retrying it would turn a
  // real fault into a wait, and the wait would not change the answer.
  const foreign = path.join(path.dirname(fixture.image), 'ffffffff-0000-4000-8000-00000000000f.sparsebundle');
  fs.mkdirSync(foreign, { recursive: true, mode: 0o700 });
  const drifted = scriptedInventory([{ attached: foreign, enumerated: 4, foreign: 1 }]);
  assert.throws(() => resolveMounted('scratch', id, drifted.inventory), /CONTAINER_MOUNT_SOURCE_DRIFT/);
  assert.equal(drifted.probes.length, 1, 'drift must fail on the first answer');
  const timeouts = scriptedInventory([timedOut()]);
  assert.throws(() => resolveMounted('scratch', id, timeouts.inventory), /CONTAINER_COMMAND_TIMEOUT/);
  assert.equal(timeouts.probes.length, 3, 'a probe that never answers is bounded, then raised');
}));

test('recovery does not discard a live image because one probe blinked', () => withHome(temporary('storage-recover-retry'), (home) => {
  const id = '00000000-0000-4000-8000-0000000000a3';
  const fixture = mountedFixture(home, id);
  const present = { attached: fixture.image, enumerated: 4, foreign: 3 };
  const { recoverOrCreate } = require('./storage-containers.cjs').bind(mutationCapability);
  const calls = [];
  const execute = (binary, args) => { calls.push(`${binary} ${args[0]}`); return ''; };
  // THE REGRESSION. Before the retry this took the absent branch: attach (which fails, because the
  // volume really is mounted), then trash the image and create a replacement - destroying the
  // backing store of a live run on the strength of one flickering enumeration.
  const scripted = scriptedInventory([absent, present]);
  assert.equal(recoverOrCreate('scratch', id, execute, scripted.inventory).image, fixture.image);
  assert.deepEqual(calls, [], 'recovery must not attach, trash, or create when the mount is really there');
  assert.equal(fs.existsSync(fixture.image), true, 'and the image must survive');
  // Negative control: a genuine, repeated absence still reaches the recovery path, so the retry
  // narrows the window rather than disabling the behaviour.
  const genuine = scriptedInventory([absent]);
  assert.throws(() => recoverOrCreate('scratch', id, () => { throw new Error('ATTACH_REFUSED'); }, genuine.inventory), /CONTAINER_COMMAND_FAILED|ATTACH_REFUSED|CONTAINER_/);
  assert.ok(genuine.probes.length >= 3, 'the genuine path is only reached after the bound');
}));

test('fixture teardown refuses any root it does not provably own', () => {
  // The helper detaches volumes and deletes a tree recursively, so the argument itself is the
  // dangerous surface. These are the roots it must never accept, each failing before any effect.
  const { disposeIsolatedHome } = require('./storage-test-teardown.cjs');
  assert.throws(() => disposeIsolatedHome(os.homedir()), /TEST_TEARDOWN_ROOT_UNOWNED|TEST_TEARDOWN_ROOT_UNRECOGNISED/);
  const nested = path.join(temporary('storage-teardown-guard'), 'inner');
  fs.mkdirSync(nested, { recursive: true });
  assert.throws(() => disposeIsolatedHome(nested), /TEST_TEARDOWN_ROOT_UNOWNED/, 'only a direct child of TMPDIR is a fixture root');
  const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-fixture-')));
  assert.throws(() => disposeIsolatedHome(foreign), /TEST_TEARDOWN_ROOT_UNRECOGNISED/);
  assert.equal(fs.existsSync(foreign), true, 'a refused root must survive the refusal');
  fs.rmSync(foreign, { recursive: true, force: true });
  // Positive control, so the guard cannot pass by refusing everything.
  const owned = temporary('storage-teardown-owned');
  fs.writeFileSync(path.join(owned, 'file'), 'x');
  assert.deepEqual(disposeIsolatedHome(owned), { detached: [] });
  assert.equal(fs.existsSync(owned), false);
});

test('a confirmed mount cannot be condemned by a later absence, and only unusability replaces it', () => withHome(temporary('storage-recover-positive'), () => {
  // THE ROUND-3 REGRESSION. recoverOrCreate confirms the mount, then resolveMounted probes AGAIN.
  // A false absence in that second probe used to reach detach + trash + recreate, so a positive
  // observation was overturned by a negative one and a live run lost its backing store.
  const id = '00000000-0000-4000-8000-0000000000a4';
  const fixture = mountedFixture(null, id);
  const present = { attached: fixture.image, enumerated: 4, foreign: 3 };
  const containerModule = require('./storage-containers.cjs');
  const { recoverOrCreate } = containerModule.bind(mutationCapability);
  const calls = [];
  const execute = (binary, args) => { calls.push(`${binary} ${args[0]}`); return ''; };
  // First probe positive, then a three-frame absence for the inner resolution.
  const scripted = scriptedInventory([present, absent, absent, absent]);
  assert.throws(() => recoverOrCreate('scratch', id, execute, scripted.inventory), /CONTAINER_MOUNT_ABSENT/);
  assert.deepEqual(calls, [], 'no detach, no trash, no replacement');
  assert.equal(fs.existsSync(fixture.image), true, 'the image survives an absence that follows a positive');
  // Positive control: an image that IS there and IS unusable is still replaced, so the guard did not
  // simply disable recovery. A seal mismatch is that proof.
  fs.writeFileSync(path.join(containerModule.mountPath('scratch'), '.pentacle-container.json'), `${JSON.stringify({ schema: 1, kind: 'scratch', run_id: id, limit: 1 })}\n`);
  // present (confirm) -> present (resolve, which finds the bad marker) -> absent (the detach is
  // PROVEN before anything is discarded).
  const unusable = scriptedInventory([present, present, absent]);
  const replacing = [];
  const replacer = (binary, args) => {
    replacing.push(`${binary} ${args[0]}`);
    if (binary.endsWith('hdiutil') && args[0] === 'create') fs.mkdirSync(fixture.image, { recursive: true });
    if (binary === '/usr/bin/trash') fs.rmSync(args[0], { recursive: true, force: true });
    return '';
  };
  // The replacement's own createImage then fails on the stale marker this fixture cannot detach for
  // real; irrelevant to the property under test, which is that the DECISION to replace was reached.
  try { recoverOrCreate('scratch', id, replacer, unusable.inventory); } catch {}
  assert.ok(replacing.some((call) => call.startsWith('/usr/bin/trash')), 'an unusable image is still replaced');
  assert.ok(replacing.includes('/usr/bin/hdiutil detach'), 'and the stale mount is detached first');
}));

test('a refused attach never authorizes discarding the image, and nothing is discarded while mounted', () => withHome(temporary('storage-attach-refusal'), () => {
  // THE ROUND-4 REGRESSION, and the worst of the family. hdiutil refuses an attach precisely when
  // the volume is ALREADY mounted, so "absence x3, then a busy refusal" is the exact shape a false
  // absence takes on a live run - and treating that refusal as proof of corruption would have
  // trashed the backing image of a mounted volume, without detaching it first.
  const id = '00000000-0000-4000-8000-0000000000a5';
  const fixture = mountedFixture(null, id);
  const { recoverOrCreate } = require('./storage-containers.cjs').bind(mutationCapability);
  const calls = [];
  const refusingAttach = (binary, args) => {
    calls.push(`${binary} ${args[0]}`);
    if (args[0] === 'attach') throw new Error('CONTAINER_COMMAND_FAILED:hdiutil:1:Resource temporarily unavailable');
    return '';
  };
  const scripted = scriptedInventory([absent]);
  assert.throws(() => recoverOrCreate('scratch', id, refusingAttach, scripted.inventory), /CONTAINER_COMMAND_FAILED/);
  assert.equal(calls.filter((call) => call.startsWith('/usr/bin/trash')).length, 0, 'a busy refusal must not discard anything');
  assert.equal(fs.existsSync(fixture.image), true, 'the backing image survives');
  // And the last gate independently: even a replaceable failure may not discard while the mount
  // point still shows something attached.
  const present = { attached: fixture.image, enumerated: 4, foreign: 3 };
  fs.writeFileSync(path.join(require('./storage-containers.cjs').mountPath('scratch'), '.pentacle-container.json'), `${JSON.stringify({ schema: 1, kind: 'scratch', run_id: id, limit: 1 })}\n`);
  const stuck = scriptedInventory([present]);
  assert.throws(() => recoverOrCreate('scratch', id, () => '', stuck.inventory), /CONTAINER_STILL_MOUNTED/);
  assert.equal(fs.existsSync(fixture.image), true, 'a detach that did not take must stop the discard');
}));

test('an unusable marker in any form is recognised as unusable, not as an unknown failure', () => withHome(temporary('storage-marker-forms'), () => {
  // recover-reserved raises before first_dead_at advances, so a marker state the whitelist does not
  // recognise makes every later sweep retry the same run forever. ENOENT, a truncated file, and a
  // marker with no seal are all as much proof of unusability as an explicit seal check failing.
  const containerModule = require('./storage-containers.cjs');
  const id = '00000000-0000-4000-8000-0000000000a6';
  const fixture = mountedFixture(null, id);
  const marker = path.join(containerModule.mountPath('scratch'), '.pentacle-container.json');
  const present = { attached: fixture.image, enumerated: 1, foreign: 0 };
  for (const [label, prepare] of [
    ['missing', () => fs.rmSync(marker, { force: true })],
    ['truncated', () => fs.writeFileSync(marker, '{"schema":1,')],
    ['no seal', () => fs.writeFileSync(marker, JSON.stringify({ schema: 1, kind: 'scratch', run_id: id, limit: containerModule.LIMITS.scratch }))],
  ]) {
    prepare();
    assert.throws(() => containerModule.resolveMounted('scratch', id, () => present), /CONTAINER_SEAL_INVALID/, label);
  }
}));

test('a marker that cannot be READ is never mistaken for a marker that is unusable', () => withHome(temporary('storage-marker-unreadable'), () => {
  // The difference decides whether an image is trashed. Unusable CONTENT (absent, unparseable,
  // wrong shape) is proof about the container. An EACCES/EIO/EMFILE says only that this process
  // could not read it, which is a fact about the host - and admitting it to the replaceable set
  // would let a permissions blip authorize detaching and discarding a perfectly good image.
  const containerModule = require('./storage-containers.cjs');
  const id = '00000000-0000-4000-8000-0000000000a7';
  const fixture = mountedFixture(null, id);
  const present = { attached: fixture.image, enumerated: 1, foreign: 0 };
  const marker = path.join(containerModule.mountPath('scratch'), '.pentacle-container.json');
  fs.chmodSync(marker, 0o000);
  try {
    assert.throws(() => containerModule.resolveMounted('scratch', id, () => present), /CONTAINER_SEAL_UNREADABLE:EACCES/);
    // And the recovery path must refuse to replace on that evidence.
    const { recoverOrCreate } = containerModule.bind(mutationCapability);
    const calls = [];
    assert.throws(() => recoverOrCreate('scratch', id, (binary, args) => { calls.push(`${binary} ${args[0]}`); return ''; }, () => present), /CONTAINER_SEAL_UNREADABLE/);
    assert.deepEqual(calls, [], 'an unreadable marker authorizes nothing');
    assert.equal(fs.existsSync(fixture.image), true);
  } finally { fs.chmodSync(marker, 0o600); }
}));

test('every broken marker shape is classified, and none escapes as an unnamed runtime error', () => withHome(temporary('storage-marker-shapes'), () => {
  // typeof null === 'object' is the trap: seal.image = null passed the shape guard and then threw
  // "Cannot read properties of null" out of the identity loop. An unnamed TypeError is outside the
  // replaceable set, so recovery refused to replace a plainly broken marker - the wedge again.
  const containerModule = require('./storage-containers.cjs');
  const id = '00000000-0000-4000-8000-0000000000a8';
  const fixture = mountedFixture(null, id);
  const present = { attached: fixture.image, enumerated: 1, foreign: 0 };
  const marker = path.join(containerModule.mountPath('scratch'), '.pentacle-container.json');
  const base = { schema: 1, kind: 'scratch', run_id: id, limit: containerModule.LIMITS.scratch };
  for (const [label, value] of [
    ['null seal', { ...base, seal: null }],
    ['null seal.image', { ...base, seal: { object_id: 'x', image: null } }],
    ['array seal.image', { ...base, seal: { object_id: 'x', image: [] } }],
    ['missing identity field', { ...base, seal: { object_id: 'x', image: { canonical: '/x', device: '1', inode: '2', uid: 0 } } }],
    ['array marker', []],
  ]) {
    fs.writeFileSync(marker, `${JSON.stringify(value)}\n`);
    assert.throws(() => containerModule.resolveMounted('scratch', id, () => present), /CONTAINER_SEAL_INVALID/, label);
  }
}));

test('an attach that fails after mounting still proves the mount gone before discarding', () => withHome(temporary('storage-attach-attempted'), () => {
  // The flag used to be raised only AFTER hdiutil attach returned, so an attach that threw - having
  // actually mounted the volume - looked like "never attached", and cleanup unlinked the backing
  // store of a live mount with no detach and no proof.
  const containerModule = require('./storage-containers.cjs');
  const { createImage } = containerModule.bind(mutationCapability);
  const { imagePath } = containerModule;
  const id = '00000000-0000-4000-8000-0000000000a9';
  const calls = [];
  const execute = (binary, args) => {
    calls.push(`${binary} ${args[0]}`);
    if (binary.endsWith('hdiutil') && args[0] === 'create') fs.mkdirSync(imagePath('scratch', id), { recursive: true });
    if (binary.endsWith('hdiutil') && args[0] === 'attach') throw new Error('CONTAINER_COMMAND_FAILED:hdiutil:1:attach reported failure');
    return '';
  };
  assert.throws(() => createImage('scratch', id, execute));
  assert.ok(calls.some((call) => call === '/usr/bin/hdiutil detach'), 'a failed attach must still be followed by a detach attempt');
  const detachIndex = calls.indexOf('/usr/bin/hdiutil detach');
  const trashIndex = calls.findIndex((call) => call.startsWith('/usr/bin/trash'));
  assert.ok(trashIndex === -1 || detachIndex < trashIndex, 'nothing may be discarded before the detach attempt');
}));

test('a seal that does not match the authoritative contract is classified, not accepted', () => withHome(temporary('storage-seal-contract'), () => {
  // storage-state.cjs defines the seal as EXACTLY {object_id, image} with a UUID object_id. Checking
  // only the image fields accepted a seal with no object_id, which then compared equal on identity
  // and was treated as a healthy container.
  const containerModule = require('./storage-containers.cjs');
  const id = '00000000-0000-4000-8000-0000000000b1';
  const fixture = mountedFixture(null, id);
  const present = { attached: fixture.image, enumerated: 1, foreign: 0 };
  const marker = path.join(containerModule.mountPath('scratch'), '.pentacle-container.json');
  const good = JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const [label, seal] of [
    ['no object_id', { image: good.seal.image }],
    ['non-uuid object_id', { object_id: 'not-a-uuid', image: good.seal.image }],
    ['extra field', { ...good.seal, extra: 1 }],
  ]) {
    fs.writeFileSync(marker, `${JSON.stringify({ ...good, seal })}\n`);
    assert.throws(() => containerModule.resolveMounted('scratch', id, () => present), /CONTAINER_SEAL_INVALID/, label);
  }
  // Positive control: the untouched marker still resolves, so the contract check is not just refusing.
  fs.writeFileSync(marker, `${JSON.stringify(good)}\n`);
  assert.equal(containerModule.resolveMounted('scratch', id, () => present).image, fixture.image);
}));

test('a probe that never answers cannot fail a detachment that did take', () => withHome(temporary('storage-detach-timeout'), () => {
  // Measured 2026-07-23: a plutil probe timing out under host load turned an otherwise green run
  // into an error AFTER scratch_discarding, because one no-answer was treated as terminal. A
  // no-answer is not a negative answer here either - it costs an attempt and is re-asked, while only
  // REAL absences count toward the proof. Driven through detachRetain, which is the shipped path.
  const containerModule = require('./storage-containers.cjs');
  const { detachRetain } = containerModule.bind(mutationCapability);
  const id = '00000000-0000-4000-8000-0000000000b2';
  const fixture = mountedFixture(null, id);
  const present = { attached: fixture.image, enumerated: 1, foreign: 0 };
  const timeout = () => { throw new Error('CONTAINER_COMMAND_TIMEOUT:plutil:20000'); };
  const script = (answers) => {
    let index = 0;
    const probes = () => index;
    return { inventory: () => { const answer = answers[Math.min(index++, answers.length - 1)]; return typeof answer === 'function' ? answer() : answer; }, probes };
  };
  // resolve (present) -> proof: no-answer, absence, no-answer, absence, absence.
  const flaky = script([present, timeout, absent, timeout, absent, absent]);
  const calls = [];
  assert.deepEqual(detachRetain('scratch', id, fixture.seal, (binary, args) => { calls.push(`${binary} ${args[0]}`); return ''; }, flaky.inventory), { retained: 'scratch', run_id: id });
  assert.deepEqual(calls, ['/usr/bin/hdiutil detach'], 'the detach happened and the flaky proof did not undo it');
  // A probe that NEVER answers must still terminate rather than hang, and must not claim success.
  const dead = script([present, timeout]);
  assert.throws(() => detachRetain('scratch', id, fixture.seal, () => '', dead.inventory), /CONTAINER_COMMAND_TIMEOUT/);
  assert.ok(dead.probes() <= 8, `bounded attempts, got ${dead.probes()}`);
}));

test('a cleanup detach that silently did not take is not reported as clean', () => withHome(temporary('storage-attach-cleanup'), () => {
  // attachExisting releases no bytes, which is exactly why its cleanup detach went unproven for so
  // long - but an unproven detach leaves the FIXED mount point occupied while the caller rethrows
  // the original error, so the next run collides and nothing ever named the cause.
  const containerModule = require('./storage-containers.cjs');
  const { attachExisting } = containerModule.bind(mutationCapability);
  const id = '00000000-0000-4000-8000-0000000000b3';
  const fixture = mountedFixture(null, id);
  // Marker is unusable, so resolveMounted fails and cleanup runs; the mount stays visible, modelling
  // a detach that returned success without taking.
  fs.writeFileSync(path.join(containerModule.mountPath('scratch'), '.pentacle-container.json'), '{"schema":1,');
  const stuck = { attached: fixture.image, enumerated: 1, foreign: 0 };
  assert.throws(() => attachExisting('scratch', id, () => '', () => stuck), (thrown) => {
    // Asserted on the OPERATOR-VISIBLE string, not the nested array: the janitor report and CLI
    // stderr carry String(error.message) and nothing else, so a detail reachable only by walking
    // .errors is a detail nobody will ever see.
    const visible = String(thrown.message);
    assert.match(visible, /CONTAINER_ATTACH_CLEANUP_FAILED/);
    assert.match(visible, /CONTAINER_STILL_MOUNTED/, 'the surviving mount must survive into the top-level message');
    assert.ok(visible.includes(containerModule.mountPath('scratch')), 'and name which mount');
    assert.match(visible, /CONTAINER_SEAL_INVALID/, 'the primary failure must not be lost either');
    return true;
  });
}));
