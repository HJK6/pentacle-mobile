'use strict';

// The five AC coverage items waived at the 2026-07-22 bulletproof-testing close, demonstrated.
//
// Each was waived because a test-only patch could not show it honestly: the supervisor lifecycle and
// the classifier sit inside runFullGate, the nine evidence crossings sit inside hdiutil and private
// atomic helpers, and freeBytes had no device observation at all. The product seams that removed
// those obstructions landed first; this file is what they were for.
//
// The oracles are INDEPENDENT of the code under test wherever the code could otherwise agree with
// itself: the disposal recorders in the worker are the oracle for WHICH container operation ran, the
// REAL journal on disk is the oracle for what was recorded, and the exit status is the oracle for
// where a crash landed. Nothing here asserts a value the wrapper computed against the same wrapper's
// restatement of it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { after } = require('node:test');
const { createCapacityGuard } = require('./storage-containers.cjs');
const { CRASH_EXIT_STATUS, CRASH_POINTS } = require('./storage-crash-points.cjs');

const LIFECYCLE_WORKER = path.join(__dirname, 'storage-lifecycle-seams-worker.cjs');
const CRASH_WORKER = path.join(__dirname, 'storage-crash-matrix-worker.cjs');
const LEGACY_RETIREMENT_WORKER = path.join(__dirname, 'storage-legacy-retirement-worker.cjs');

// Owned by the fixture, not by each caller: the suite's own scratch is the leak class this program
// spent a lane removing, and nine call sites disposing individually is how it came back.
const fixtureRoots = [];
after(() => {
  const { disposeIsolatedHome } = require('./storage-test-teardown.cjs');
  const failures = [];
  for (const root of fixtureRoots.splice(0)) {
    if (!fs.existsSync(root)) continue;
    try { disposeIsolatedHome(root); } catch (error) { failures.push(String(error.message || error)); }
  }
  if (failures.length) throw new Error(`FIXTURE_ROOTS_LEAKED:${failures.join('; ')}`);
});

function isolatedHome(label) {
  // BOTH the parent and the prefix are load-bearing, and neither is cosmetic.
  //
  // The PREFIX is what storage-test-teardown.cjs admits: that guard fails closed on its argument
  // because it detaches volumes and recursively deletes, so the fixture is named to satisfy it rather
  // than the guard widened to admit the fixture.
  //
  // The PARENT is realpath('/tmp'), not os.tmpdir(). Under os.tmpdir() - the per-user
  // DARWIN_USER_TEMP_DIR - the gate's host-global write roots (the idb root, the host temporary root,
  // the sim-queue root) resolve INSIDE the redirected HOME, so renderProfile's ancestor rule refuses
  // the profile and the run dies for a reason that has nothing to do with the lifecycle under test.
  // Under /tmp there is no such nesting. That choice is what lets `sandboxed` stay OUT of
  // runFullGate's dependency list: making the last host boundary the gate crosses permanently
  // overridable, so that the certified child can be launched with no sandbox-exec at all, is far too
  // high a price for a fixture-root convenience. storage-test-teardown.cjs already admits /tmp as a
  // fixture parent, so nothing else has to move.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), `storage-seams-${label}-`)));
  fixtureRoots.push(home);
  return home;
}

function runWorker(worker, home, scenario, args = []) {
  return spawnSync(process.execPath, [worker, scenario, ...args], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60000,
  });
}

test('the hermetic snapshot resolver cannot substitute unbound gate code', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const run = source.slice(source.indexOf('async function runFullGate'));
  assert.match(run, /gateBootstrap\.gateCodeSha !== run\.gate_code_sha/);
  assert.match(run, /gateCodeRoot !== gateBootstrap\.snapshotRoot/);
  assert.ok(run.indexOf('verifyCertified(gateCodeRoot)') > run.indexOf('gateCodeRoot !== gateBootstrap.snapshotRoot'));
  assert.equal((run.match(/verifyGateCodeProvenanceDependency\(gateBootstrap\.invokingRepository, run\)/g) || []).length, 2);
});

function lifecycle(scenario) {
  const home = isolatedHome(scenario);
  const result = runWorker(LIFECYCLE_WORKER, home, scenario);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { home, ...JSON.parse(result.stdout) };
}

for (const scenario of ['prepared-refusal', 'prepared-exception']) {
  test(`${scenario} releases both mounted images and the unclaimed lock without changing retention`, () => {
    const result = lifecycle(scenario);
    assert.equal(result.reached, true);
    assert.match(result.threw, /HOST_HEALTH_REFUSED|BOOTSTRAP_EXCEPTION/);
    assert.deepEqual(result.attached, []);
    assert.equal(result.lock_present, false);
    assert.equal(result.journal_unchanged, true);
    assert.equal(result.images_retained, true);
  });
}
test('prepared cleanup refuses an invalid token and preserves a replaced foreign lock', () => {
  for (const scenario of ['prepared-invalid-token', 'prepared-foreign-lock']) {
    const result = lifecycle(scenario);
    assert.deepEqual(result.operations, []);
    assert.deepEqual(result.attached, ['scratch', 'evidence']);
    assert.equal(result.lock_present, true);
    assert.equal(result.reached, scenario === 'prepared-foreign-lock');
    if (scenario === 'prepared-foreign-lock') assert.equal(result.foreign_lock_preserved, true);
    assert.match(result.threw, /PREPARED_.*AUTHORITY/);
  }
});
test('prepared cleanup collects a failed scratch detach while releasing evidence and lock', () => {
  const result = lifecycle('prepared-detach-failure');
  assert.match(result.threw, /BOOTSTRAP_EXCEPTION/);
  assert.match(result.threw, /SCRATCH_DETACH_REFUSED/);
  assert.deepEqual(result.operations, ['retain:evidence']);
  assert.deepEqual(result.attached, ['scratch']);
  assert.equal(result.lock_present, false);
  assert.equal(result.journal_unchanged, true);
});

// ---------------------------------------------------------------------------
// AC3 item 5 - changed backing device drift.
//
// fs.statfsSync exposes no device identity at all (verified pre-dev: it returns exactly type, bsize,
// blocks, bfree, bavail, files, ffree), so the identity has to come from statSync().dev, be captured
// once, and be re-verified on every reading. These run in-process because the guard takes its `stat`
// and `statfs` sources as named parameters - there is no host behaviour to reach for.
// ---------------------------------------------------------------------------

const AMPLE = 64n * 1024n * 1024n * 1024n / 4096n;
const statfsOk = () => ({ bavail: AMPLE, bsize: 4096n });

function deviceSource(sequence) {
  let call = 0;
  return () => {
    const value = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    if (value instanceof Error) throw value;
    return value;
  };
}

test('a guard on an unchanged backing device admits every reading', () => {
  const guard = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: deviceSource([{ dev: 42 }]) });
  assert.equal(guard.device, 42n);
  assert.equal(guard.freeBytes(), AMPLE * 4096n);
  assert.equal(guard.requireCapacity('start'), AMPLE * 4096n);
  assert.equal(guard.requireCapacity('running'), AMPLE * 4096n);
});

// The identity is normalised to BigInt at capture AND at every re-reading, so the two shapes
// fs.statSync can return for one device (number under the default, BigInt under {bigint:true}) cannot
// compare unequal for being differently typed. Without this the guard would report a device change on
// every run whose stat source happened to differ in shape - a false positive on the fail-closed side,
// which is the expensive direction here: it aborts a 25-minute gate.
test('one device reported in both stat shapes is one device', () => {
  const guard = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: deviceSource([{ dev: 42 }, { dev: 42n }]) });
  assert.doesNotThrow(() => guard.freeBytes());
});

test('a changed backing device is refused by name at the start probe and at the running poll', () => {
  for (const phase of ['start', 'running']) {
    const guard = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: deviceSource([{ dev: 42 }, { dev: 43 }]) });
    assert.throws(() => guard.requireCapacity(phase), (error) => error.name === 'DiskBackingDeviceChangedError');
  }
  const guard = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: deviceSource([{ dev: 42 }, { dev: 43 }]) });
  assert.throws(() => guard.freeBytes(), (error) => error.name === 'DiskBackingDeviceChangedError');
});

// THE REGRESSION THIS SEAM EXISTS FOR, stated as an executable difference rather than a comment. One
// guard shared by the start probe and the supervisor's 5-second poll observes a swap that happened
// between them; two guards each capture their own identity after the swap and agree with themselves
// forever. If runFullGate ever goes back to building a second guard for the poll, the first assertion
// below keeps passing and the second starts failing - which is the whole point of asserting both.
test('one shared guard observes a swap between the probes that two guards cannot', () => {
  const swap = deviceSource([{ dev: 42 }, { dev: 42 }, { dev: 43 }]);
  const shared = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: swap });
  assert.equal(shared.requireCapacity('start'), AMPLE * 4096n);
  assert.throws(() => shared.requireCapacity('running'), (error) => error.name === 'DiskBackingDeviceChangedError');

  const twoGuardSwap = deviceSource([{ dev: 42 }, { dev: 42 }, { dev: 43 }, { dev: 43 }]);
  const first = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: twoGuardSwap });
  assert.equal(first.requireCapacity('start'), AMPLE * 4096n);
  const second = createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: twoGuardSwap });
  assert.equal(second.requireCapacity('running'), AMPLE * 4096n, 'a second guard captures the POST-swap identity and cannot see the swap');
});

test('prepareNativeRoot brackets its start probe and five-second poll with one capacity guard', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const prepare = source.slice(source.indexOf('async function prepareNativeRoot'), source.indexOf('function reportViewerResultsBeforeKeyboard'));
  assert.equal((prepare.match(/createCapacityGuard\(/g) || []).length, 1);
  assert.match(prepare, /capacityGuard\.requireCapacity\('start'\)/);
  assert.match(prepare, /capacity:\s*\(\) => \{ capacityGuard\.requireCapacity\('running'\)/);
  assert.equal(/\brequireCapacity\('(?:start|running)'\)/.test(prepare.replaceAll('capacityGuard.requireCapacity', 'guarded')), false);
});

test('every unusable device reading fails closed under its own name', () => {
  const cases = [
    [[{}], 'DiskDeviceFieldMissingError'],
    [[{ dev: 1.5 }], 'DiskDeviceFieldTypeError'],
    [[{ dev: '42' }], 'DiskDeviceFieldTypeError'],
    [[null], 'DiskDeviceResultTypeError'],
    [[new Error('ENOENT')], 'DiskDeviceStatSourceError'],
  ];
  for (const [sequence, name] of cases) {
    assert.throws(
      () => createCapacityGuard({ target: __dirname, statfs: statfsOk, stat: deviceSource(sequence) }),
      (error) => error.name === name,
      name,
    );
  }
});

// ---------------------------------------------------------------------------
// AC2 items 1 and 2 - supervisor outcome bound to scratch disposal and evidence preservation.
//
// The injected supervisor DELEGATES to the real one with a scripted child: the real state machine,
// the real signal handling, and the real exitStatus mapping all run, and only the process at the far
// end is fake. A hand-written substitute would assert against itself.
// ---------------------------------------------------------------------------

for (const [scenario, expectedStatus, cause] of [
  ['supervisor-success', 0, null],
  ['supervisor-failure', 1, null],
  ['supervisor-sigint', 130, 'SIGINT'],
  ['supervisor-sigterm', 143, 'SIGTERM'],
]) test(`a ${scenario.replace('supervisor-', '')} outcome discards scratch, retains evidence, and says so in the real journal`, () => {
  const outcome = lifecycle(scenario);
  assert.equal(outcome.status, expectedStatus);
  assert.equal(outcome.supervisor_cause, cause);
  // The disposal oracle: exactly one scratch discard, exactly one evidence retain, and no retain of
  // the scratch it was supposed to destroy. Order matters - a retain of evidence before the scratch
  // discard would mean the evidence image was released while the run could still fail into it.
  assert.deepEqual(outcome.operations, ['discard:scratch', 'retain:evidence']);
  // The journal oracle, read back off disk after the run: the terminal state, the child's REAL exit
  // code, and a stated cause for every non-zero one.
  assert.equal(outcome.run.state, 'scratch_discarded');
  assert.equal(outcome.run.gate_status, expectedStatus);
  assert.equal(outcome.run.classification_error, null, 'classification succeeded, so no classification error may be stamped');
  if (expectedStatus === 0) assert.equal(outcome.run.failure, null);
  else assert.match(outcome.run.failure, new RegExp(`GATE_STATUS_NONZERO:${expectedStatus}`));
  // The preservation oracle: the scratch bytes are gone, the evidence bytes are still there, and the
  // manifest that binds them was written over the real tree.
  assert.equal(outcome.scratch_image_present, false);
  assert.equal(outcome.evidence_image_present, true);
  assert.equal(outcome.manifest.outcome, expectedStatus === 0 ? 'passed' : 'failed');
  assert.equal(outcome.manifest.run_id, outcome.run.id);
  assert.equal(outcome.retained_evidence_verified, true);
  assert.match(outcome.run.evidence_digest, /^[0-9a-f]{64}$/);
});

// The seam's own hazard, demonstrated rather than argued. `supervise` is handed the running-phase
// capacity/backing-drift poll and the host cleanup as callbacks, so a substitute that simply reports
// success without running either would - before this guard - have produced a green PUBLISHED run with
// the drift check and every cleanup step silently skipped. That is the same disable-by-argument shape
// that got verifyCertified removed from the dependency list, surviving one layer deeper. The seam has
// to stay, because the demonstrations need it; what must not stay is trusting the substitute's report
// of its own obligations.
function reportedCheck(outcome, name) {
  assert.match(outcome.threw, /^GATE_CHECKS_FAILED:/);
  return JSON.parse(outcome.threw.slice('GATE_CHECKS_FAILED:'.length).split(' [release-incomplete: ')[0]).find((row) => row.name === name);
}

test('a supervisor that reports success without running the cleanup it was handed is refused', () => {
  const outcome = lifecycle('supervisor-skips-cleanup');
  assert.equal(reportedCheck(outcome, 'cleanup-executed').error, 'GATE_SUPERVISOR_CLEANUP_SKIPPED');
  assert.equal(reportedCheck(outcome, 'evidence-audit').status, 'failed', 'safe independent evidence is still audited');
  assert.equal(outcome.status, null, 'no status is returned to the caller');
  // And it fails CLOSED: nothing was discarded, and the run never reached published.
  assert.equal(outcome.operations.includes('discard:scratch'), false);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
  assert.notEqual(outcome.run.state, 'scratch_discarded');
});

// The supervisor's OTHER obligation, and the reason it needed a different remedy. The poll is
// periodic, so a fast child legitimately never triggers it and "assert the poll ran" would fail
// correct runs. The gate therefore performs the INTEGRITY half itself after the child, where no
// substitute can decline it. Here the substitute runs the cleanup - so the cleanup assertion is
// satisfied and cannot be what catches this - and the backing device drifts while the child runs.
test('a reported cleanup error cannot publish otherwise valid passing evidence', () => {
  const outcome = lifecycle('supervisor-reported-cleanup-error');
  assert.equal(reportedCheck(outcome, 'cleanup-result').error, 'GATE_CLEANUP_INCOMPLETE:CONTROL_CLEANUP_ERROR');
  assert.equal(outcome.status, null);
  assert.equal(outcome.run.gate_status, 0, 'the real passing child status is preserved');
  assert.equal(outcome.run.state, 'blocked_unclassified');
  assert.equal(outcome.operations.includes('discard:scratch'), false);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
  assert.equal(outcome.run.evidence_digest, undefined);
});

test('a supervisor that never polls cannot publish a run whose backing device drifted', () => {
  const outcome = lifecycle('supervisor-skips-poll');
  assert.equal(reportedCheck(outcome, 'capacity-identity').error, 'DiskBackingDeviceChangedError');
  assert.deepEqual(reportedCheck(outcome, 'evidence-audit').dependencies, ['capacity-identity']);
  assert.equal(reportedCheck(outcome, 'evidence-audit').status, 'unreachable');
  assert.equal(outcome.status, null);
  // Fails closed BEFORE publication: nothing discarded, no digest, and the run never reached terminal.
  assert.equal(outcome.operations.includes('discard:scratch'), false);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
  assert.notEqual(outcome.run.state, 'scratch_discarded');
  assert.equal(outcome.run.evidence_digest, undefined);
  // The run stays at `running` and records NOTHING - and that is correct rather than a gap. A backing
  // device that really changed also moves the authority roots, so validateInstalledAuthority refuses
  // and the journal cannot be written at all. There is no honest seal to record when the volume the
  // journal lives on is no longer the volume it was validated against; the record stays at the last
  // state that was true. The child's-exit-code property is asserted by `integrity-unreadable-at-end`
  // below - the one post-child refusal that leaves the authority roots alone, so the journal is
  // healthy and a record CAN be written.
  assert.equal(outcome.run.state, 'running');
  assert.equal(outcome.run.gate_status, null);
});

// THE OTHER HALF OF THAT DECISION, and the regression this pair exists to prevent. The integrity
// check performed after the child deliberately does NOT re-impose the free-space floor. This is an
// ordinary green run on a loaded box - real supervisor, real child exiting 0, volume under the 40 GiB
// running floor by the time it finished - and it must still seal, publish and RELEASE its scratch.
// An earlier revision refused here, which stamped 17 over a passing child, left the verdict readable
// only by attaching the image, and made the run RETAIN its 12 GiB exactly when the disk was scarce.
// A gate that stops releasing disk because the disk ran low has the sign inverted.
test('a green run whose volume fell under the floor at the end still publishes and releases its scratch', () => {
  const outcome = lifecycle('supervisor-low-disk-at-end');
  assert.equal(outcome.threw, null);
  assert.equal(outcome.status, 0);
  assert.equal(outcome.run.state, 'scratch_discarded');
  assert.equal(outcome.run.gate_status, 0);
  assert.equal(outcome.run.failure, null);
  assert.deepEqual(outcome.operations, ['discard:scratch', 'retain:evidence']);
  assert.equal(outcome.scratch_image_present, false, 'the scratch is RELEASED, not held');
  assert.match(outcome.run.evidence_digest, /^[0-9a-f]{64}$/);
});

test('a running-phase low-disk poll stops the child, seals status 17, and releases scratch', () => {
  const outcome = lifecycle('supervisor-low-disk-during');
  assert.equal(outcome.threw, null);
  assert.equal(outcome.supervisor_cause, 'low-disk');
  assert.equal(outcome.status, 17);
  assert.equal(outcome.run.state, 'scratch_discarded');
  assert.equal(outcome.run.gate_status, 17);
  assert.deepEqual(outcome.operations, ['discard:scratch', 'retain:evidence']);
  assert.equal(outcome.scratch_image_present, false);
});

test('the start capacity probe refuses below 60 GiB before supervision begins', () => {
  const outcome = lifecycle('supervisor-start-low-disk');
  assert.match(outcome.threw, /^DISK_START_BELOW_60_GIB/);
  assert.equal(outcome.supervisor_cause, null);
  assert.equal(outcome.status, null);
});

test('janitor normalizes an already-detached dead run and clears its identity-matched lock', () => {
  const outcome = lifecycle('unclassified-janitor-detached-recovery');
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.lock_present, false);
  assert.equal(outcome.scratch_attached, false);
  assert.equal(outcome.evidence_attached, false);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
});

test('janitor leaves the host lock when a retained image cannot be detached', () => {
  const outcome = lifecycle('unclassified-janitor-detach-failure');
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0].error, /mount-recovery-scratch: DETACH_RETAIN_FORCED/);
  assert.equal(outcome.lock_present, true);
  assert.equal(outcome.scratch_attached, true);
  assert.equal(outcome.evidence_attached, false);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
});

// THE THIRD CLAIM OF THAT SAME CORRECTION, which the two tests above cannot reach. When the post-child
// integrity check throws, the catch must record the child's REAL exit code rather than the flat 17
// fallback - which is why `childStatus` is carried out of the supervisor result BEFORE the check runs
// (storage-gate.cjs:1395). Neither test above locks it: the drift case cannot write a journal at all,
// and the low-disk case never throws. This scenario is the one that can - the support root's statfs
// reading turns untrustworthy after the child while fs.statSync is left alone, so the authority still
// validates and the record is written. A child that exited 0 must be recorded as 0.
test('a refusal after the child records the child\'s real exit code, not the 17 fallback', () => {
  const outcome = lifecycle('integrity-unreadable-at-end');
  assert.equal(reportedCheck(outcome, 'capacity-identity').error, 'DiskStatSourceError');
  assert.equal(outcome.status, null);
  // The property under test, and the child exits 1 rather than 0 so that it can actually be tested:
  // against a green child, a hardcoded `childStatus = 0` would pass this line while carrying nothing
  // out of the supervisor result. 1 is the child's own code, and 1 is what the journal must say.
  assert.equal(outcome.run.gate_status, 1);
  // And it fails closed, on the same terms as every other integrity refusal: nothing published,
  // nothing discarded, both images kept for whoever has to work out what the reading meant.
  assert.equal(outcome.run.state, 'blocked_unclassified');
  assert.match(outcome.run.failure, /DiskStatSourceError/);
  assert.equal(outcome.operations.includes('discard:scratch'), false);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
  assert.equal(outcome.run.evidence_digest, undefined);
});

// ---------------------------------------------------------------------------
// AC2 item 3 - classification fails closed through the real gate.
//
// The classifier is injected to fail by a NAMED error; everything downstream of it - the journal, the
// run state, the disposal decisions - is real. What is asserted is that the failure is recorded
// rather than swallowed, that the evidence survives it, and that the scratch is NOT discarded, since
// a run nobody could classify is exactly the one whose inputs must be kept.
// ---------------------------------------------------------------------------

test('a named classifier failure blocks the run unclassified and preserves both images', () => {
  const outcome = lifecycle('classifier-failure');
  assert.equal(outcome.threw, 'LIFECYCLE_CLASSIFIER_FORCED');
  assert.equal(outcome.run.state, 'blocked_unclassified');
  assert.match(outcome.run.classification_error, /LIFECYCLE_CLASSIFIER_FORCED/);
  // Sealed with the child's real status BEFORE classification was attempted. The child PASSED, so the
  // run is a correctly sealed PASSING run that nobody could classify - and `failure` must stay null,
  // because nothing about the gate failed. Asserting that is not decoration: without it, a regression
  // that stamped a spurious failure on a green run's record would pass this test unchanged.
  assert.equal(outcome.run.gate_status, 0);
  assert.equal(outcome.run.failure, null);
  // Nothing was discarded. Both images were released by detachRetain, which detaches WITHOUT
  // discarding, so every retention clock and deletion authority is untouched.
  assert.deepEqual(outcome.operations, ['retain:scratch', 'retain:evidence']);
  assert.equal(outcome.scratch_image_present, true);
  assert.equal(outcome.evidence_image_present, true);
  assert.equal(outcome.run.evidence_digest, undefined);
});

test('operator disposition records authority and removes stranded unclassified evidence', () => {
  const outcome = lifecycle('unclassified-stranded-dispose');
  assert.equal(outcome.error, null);
  assert.equal(outcome.run.state, 'evidence_discarded');
  assert.equal(outcome.run.disposition_reason, 'operator reviewed unclassified evidence');
  assert.ok(outcome.run.unclassified_disposed_at);
  assert.equal(outcome.scratch_image_present, false);
  assert.equal(outcome.evidence_image_present, false);
});

test('operator disposition removes byte-sealed partial report evidence without certifying it as a completed gate', () => {
  const outcome = lifecycle('unclassified-partial-report-dispose');
  assert.equal(outcome.error, null);
  assert.equal(outcome.run.state, 'evidence_discarded');
  assert.equal(outcome.run.disposition_reason, 'operator reviewed unclassified evidence');
  assert.equal(outcome.scratch_image_present, false);
  assert.equal(outcome.evidence_image_present, false);
});

for (const [scenario, failure] of [
  ['unclassified-seal-failure-release', /EVIDENCE_SYMLINK_FORBIDDEN/],
  ['unclassified-manifest-collision-release', /EVIDENCE_MANIFEST_COLLISION/],
  ['unclassified-journal-failure-release', /UNCLASSIFIED_JOURNAL_WRITE_FORCED/],
]) {
  test(`${scenario} releases the fixed evidence mount without recording authority or deleting the image`, () => {
    const outcome = lifecycle(scenario);
    assert.match(outcome.error, failure);
    assert.equal(outcome.run.unclassified_disposed_at, null);
    assert.equal(outcome.evidence_attached, false);
    assert.equal(outcome.evidence_image_present, true);
  });
}

for (const state of ['scratch-discarding', 'evidence-discarding']) {
  test(`a cold ${state} disposition refuses evidence drift before further deletion and releases the mount`, () => {
    const outcome = lifecycle(`unclassified-cold-classb-${state}-drift`);
    assert.match(outcome.error, /EVIDENCE_RETAINED_DIGEST_DRIFT/);
    assert.equal(outcome.run.state, state.replace('-', '_'));
    assert.equal(outcome.evidence_attached, false);
    assert.equal(outcome.evidence_image_present, true);
    if (state === 'scratch-discarding') assert.equal(outcome.scratch_image_present, true);
  });
}

test('operator disposition does not preempt published evidence retention', () => {
  const outcome = lifecycle('unclassified-stranded-refuse');
  assert.match(outcome.error, /UNCLASSIFIED_DISPOSITION_NOT_AUTHORIZED:retain\/evidence-retention/);
  assert.equal(outcome.run.state, 'scratch_discarded');
  assert.equal(outcome.run.unclassified_disposed_at, null);
  assert.equal(outcome.evidence_image_present, true);
});

for (const [state, suffix] of [['allocated', ''], ['running', '-running'], ['sealing', '-sealing']]) {
  test(`operator disposition closes never-classified ${state} scratch and evidence in one journal chain`, () => {
    const outcome = lifecycle(`unclassified-never${suffix}-dispose`);
    assert.equal(outcome.error, null);
    assert.equal(outcome.run.state, 'evidence_discarded');
    assert.equal(outcome.run.disposition_reason, 'operator reviewed unclassified evidence');
    assert.equal(outcome.scratch_image_present, false);
    assert.equal(outcome.evidence_image_present, false);
  });

  test(`operator disposition refuses never-classified ${state} scratch inside the observation window`, () => {
    const outcome = lifecycle(`unclassified-never${suffix}-refuse`);
    assert.match(outcome.error, /UNCLASSIFIED_DISPOSITION_NOT_AUTHORIZED:retain\/dead-under-24h/);
    assert.equal(outcome.run.state, state);
    assert.equal(outcome.run.unclassified_disposed_at, null);
    assert.equal(outcome.scratch_image_present, true);
    assert.equal(outcome.evidence_image_present, true);
  });
}

test('operator disposition refuses a live owner and a death not yet observed', () => {
  const live = lifecycle('unclassified-owner-live');
  assert.match(live.error, /UNCLASSIFIED_DISPOSITION_NOT_AUTHORIZED:retain\/owner-live/);
  assert.equal(live.run.state, 'allocated');
  assert.equal(live.scratch_image_present, true);
  assert.equal(live.evidence_image_present, true);

  const unobserved = lifecycle('unclassified-death-unobserved');
  assert.match(unobserved.error, /UNCLASSIFIED_DISPOSITION_NOT_AUTHORIZED:observe-dead\/none/);
  assert.equal(unobserved.run.state, 'allocated');
  assert.equal(unobserved.scratch_image_present, true);
  assert.equal(unobserved.evidence_image_present, true);
});

test('a recorded disposition is reason-immutable and resumes after an authorization-only crash', () => {
  const outcome = lifecycle('unclassified-resume-authorized');
  assert.match(outcome.reason_error, /UNCLASSIFIED_DISPOSITION_REASON_DRIFT/);
  assert.equal(outcome.error, null);
  assert.equal(outcome.run.state, 'evidence_discarded');
  assert.equal(outcome.run.disposition_reason, 'operator reviewed unclassified evidence');
  assert.equal(outcome.scratch_image_present, false);
  assert.equal(outcome.evidence_image_present, false);
});

for (const [journalClass, states] of Object.entries({
  classa: ['scratch-discarded', 'evidence-discarding'],
  classb: ['allocated', 'scratch-discarding', 'scratch-discarded', 'evidence-discarding'],
})) {
  for (const state of states) {
    test(`a cold process resumes ${journalClass} disposition from ${state}`, () => {
      const outcome = lifecycle(`unclassified-cold-${journalClass}-${state}`);
      assert.equal(outcome.run.state, 'evidence_discarded');
      assert.equal(outcome.run.disposition_reason, 'operator reviewed unclassified evidence');
      assert.equal(outcome.scratch_image_present, false);
      assert.equal(outcome.evidence_image_present, false);
    });
  }
}

// ---------------------------------------------------------------------------
// AC5 item 4 - the nine-class evidence crash matrix.
//
// The seam is landed and this is the oracle for its shape; the per-point demonstrations follow in the
// same lane. Every point is exercised where it actually sits, by a real child that arms it in-process
// and dies at the crossing, because arming is capability-bound and deliberately not an environment
// variable.
// ---------------------------------------------------------------------------

test('the crash matrix names exactly the nine crossings and nothing else', () => {
  assert.deepEqual([...CRASH_POINTS], [
    'container-create', 'container-attach', 'journal-durability', 'seal',
    'publication', 'detach', 'discard', 'retention', 'tombstone',
  ]);
  assert.equal(CRASH_EXIT_STATUS, 23);
});

// Read off DISK, after the process that made it is gone. A crashed process reports nothing, which is
// the point - every assertion below is about what survived, never about what the dead process said.
function support(home) { return path.join(home, 'Library', 'PentacleMobileStorage'); }
function onlyRun(home) {
  const directory = path.join(support(home), 'State', 'runs');
  const records = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.equal(records.length, 1, 'the fixture builds exactly one run');
  return JSON.parse(fs.readFileSync(path.join(directory, records[0]), 'utf8'));
}
function entries(home, kind) {
  const directory = path.join(support(home), kind);
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}
function crash(worker, point) {
  const home = isolatedHome(`crash-${point}`);
  const result = runWorker(worker, home, `${worker === CRASH_WORKER ? '' : 'crash-'}${point}`);
  assert.equal(result.status, CRASH_EXIT_STATUS, result.stderr || result.stdout);
  return home;
}

// The five container crossings. Each pair of assertions is the same question in two halves: did the
// EFFECT the crash sits after really happen, and is there any RECORD claiming more than that.
const MOUNT = (home) => path.join(support(home), 'Scratch');
const IMAGES = (home) => path.join(support(home), 'ScratchImages');

test('a crash after container creation leaves an image and nothing that says it was attached', () => {
  const home = crash(CRASH_WORKER, 'container-create');
  assert.equal(fs.readdirSync(IMAGES(home)).length, 1, 'the image exists');
  assert.equal(fs.existsSync(path.join(MOUNT(home), '.attached')), false, 'nothing was attached');
  assert.equal(fs.existsSync(path.join(MOUNT(home), '.pentacle-container.json')), false, 'no seal was recorded');
});

test('a crash after container attach leaves a mounted volume with no seal on it', () => {
  const home = crash(CRASH_WORKER, 'container-attach');
  assert.equal(fs.existsSync(path.join(MOUNT(home), '.attached')), true, 'the volume is mounted');
  assert.equal(fs.existsSync(path.join(MOUNT(home), '.pentacle-container.json')), false, 'the seal had not been written');
});

test('a crash after the seal is written leaves it on the volume and nowhere else', () => {
  const home = crash(CRASH_WORKER, 'seal');
  const marker = JSON.parse(fs.readFileSync(path.join(MOUNT(home), '.pentacle-container.json'), 'utf8'));
  assert.match(marker.seal.object_id, /^[0-9a-f-]{36}$/, 'the marker carries a real seal');
  // The seal never reached a caller or a journal: there is no run record at all to carry it.
  assert.equal(fs.existsSync(path.join(support(home), 'State', 'runs')), false);
});

test('a crash after detach leaves the image intact and the volume released', () => {
  const home = crash(CRASH_WORKER, 'detach');
  assert.equal(fs.existsSync(path.join(MOUNT(home), '.attached')), false, 'the detach was proven before the crash');
  assert.equal(fs.readdirSync(IMAGES(home)).length, 1, 'the backing store is still recoverable');
});

test('a crash after discard leaves no bytes and no record claiming they went', () => {
  const home = crash(CRASH_WORKER, 'discard');
  assert.equal(fs.readdirSync(IMAGES(home)).length, 0, 'the bytes are gone');
  assert.equal(fs.existsSync(path.join(support(home), 'State', 'runs')), false, 'and no transition recorded it');
});

// The four crossings that need a real journal and a real published run.

test('a crash between the journal fsync and its rename leaves the record unchanged and the payload durable', () => {
  const home = crash(LIFECYCLE_WORKER, 'journal-durability');
  // The transition the process died inside is INVISIBLE: the record still reads what it read before.
  assert.equal(onlyRun(home).state, 'allocated');
  const directory = path.join(support(home), 'State', 'runs');
  // FILES only. The transition's first journal write is its mutation CLAIM, so that is the crossing
  // this run actually dies inside, and beside the claim's payload sits a `.claim.guard.<uuid>.tmp`
  // that is a lock DIRECTORY, not a payload - asserting JSON over it would be asserting the wrong
  // contract against the wrong object.
  const temporaries = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.tmp') && fs.lstatSync(path.join(directory, name)).isFile());
  assert.equal(temporaries.length, 1, 'exactly one fsynced payload survived, under a name no reader looks for');
  // Durable AND complete - that is what the fsync bought, and it is the whole reason the crossing sits
  // between the fsync and the rename rather than around the pair. A crash one syscall later would have
  // been indistinguishable from success; a crash one earlier would have left a torn file.
  assert.doesNotThrow(
    () => JSON.parse(fs.readFileSync(path.join(directory, temporaries[0]), 'utf8')),
    `${temporaries[0]} must be complete JSON`,
  );
});

test('a crash at publication leaves the run published with its scratch still held', () => {
  const home = crash(LIFECYCLE_WORKER, 'publication');
  const run = onlyRun(home);
  assert.equal(run.state, 'published');
  assert.ok(run.published_at, 'publication is durable before the discard is attempted');
  assert.equal(run.scratch_discard_started_at, undefined, 'no discard had been authorised');
  // The 12 GiB the dead-owner recovery path exists to reclaim, still on disk and still accounted for.
  assert.equal(entries(home, 'ScratchImages').length, 1);
});

test('jointly legacy published evidence can discard scratch and later retire evidence', () => {
  const publishedHome = crash(LIFECYCLE_WORKER, 'publication');
  const scratch = runWorker(LEGACY_RETIREMENT_WORKER, publishedHome, 'scratch');
  assert.equal(scratch.status, 0, scratch.stderr || scratch.stdout);
  assert.deepEqual(JSON.parse(scratch.stdout), { state: 'scratch_discarded', scratch: false, evidence: true });

  const retained = lifecycle('supervisor-success');
  const evidence = runWorker(LEGACY_RETIREMENT_WORKER, retained.home, 'evidence');
  assert.equal(evidence.status, 0, evidence.stderr || evidence.stdout);
  assert.deepEqual(JSON.parse(evidence.stdout), { state: 'evidence_discarded', scratch: false, evidence: false });
});

test('a crash at the retention decision moves nothing', () => {
  const home = crash(LIFECYCLE_WORKER, 'retention');
  const run = onlyRun(home);
  assert.equal(run.state, 'scratch_discarded', 'the decision exists and the record has not moved');
  assert.equal(run.evidence_discard_started_at, undefined);
  assert.equal(entries(home, 'EvidenceImages').length, 1, 'the image the clock expired is intact');
});

test('a crash at the tombstone leaves the evidence gone and the record admitting it was in flight', () => {
  const home = crash(LIFECYCLE_WORKER, 'tombstone');
  const run = onlyRun(home);
  assert.equal(entries(home, 'EvidenceImages').length, 0, 'the bytes are gone');
  // NOT a silent loss: the record says evidence_discarding with a start time, which is exactly the
  // state the janitor's recover-evidence branch resumes from. A tombstone written before the discard
  // would instead have claimed a completion that had not happened.
  assert.equal(run.state, 'evidence_discarding');
  assert.ok(run.evidence_discard_started_at);
  assert.equal(run.evidence_discarded_at, undefined);
  assert.equal(run.deleted_at, undefined);
});
