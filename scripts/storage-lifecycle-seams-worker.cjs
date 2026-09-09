'use strict';

// Drives the REAL runFullGate through each supervisor outcome and through a classifier failure, under
// an isolated HOME, in a real child process.
//
// WHAT IS FAKE, AND WHY IT IS ONLY THIS MUCH:
//   - the child process at the far end of the supervisor. The injected `supervise` DELEGATES to the
//     real supervise with a scripted spawnChild/signalGroup/groupAlive, so the real state machine,
//     the real signal handling, and the real exitStatus mapping all run. Substituting the supervisor
//     itself would let the test assert against its own state machine.
//   - the host environment preparation (simulator, device set, idb companion, indirections), which is
//     what made these items undemonstrable in the first place - it needs mounted images and real
//     simulator tooling.
//   - the hdiutil ATTACH TABLE, and nothing else about containers: resolveMounted is wrapped with a
//     scripted `inventory`, its own already-injectable parameter, so every seal contract, marker
//     shape check, and image identity comparison inside it still runs for real against real
//     directories.
//   - the disposal calls, replaced by RECORDERS that still verify the journal seal before acting.
//     They are the oracle for which operation ran; recording them is the point.
//   - fs.statfsSync, overridden process-wide, for the reason argued at its definition below. The capacity guard's
//     CODE is real and runs unmodified; the NUMBERS it reads are fabricated. Listed here rather than
//     left implicit so no reader concludes these demonstrations prove anything about real free space.
//
// WHAT IS REAL: the journal, the run state machine, the host lock, the certified verification, the
// capacity guard's logic, the sandbox profile, evidence validation, manifest writing, and
// retained-evidence verification. Those are what the acceptance criteria assert about, so injecting
// any of them would prove nothing - which is also why runFullGate's dependency list does not offer
// them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

// FIRST, before anything is computed from the layout. This worker creates, publishes and DISCARDS
// containers at paths fixedLayout() derives from HOME; run with the operator's real HOME it would
// operate inside the live store. userInfo().homedir is the real account home and is unaffected by the
// HOME redirection every caller performs, which is what makes it usable as the thing to compare
// against.
if (fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir)) throw new Error('LIFECYCLE_SEAMS_REAL_HOME_REFUSED');

// The four crash points that need a real journal, a real evidence tree, and a real published run live
// here rather than in storage-crash-matrix-worker.cjs, which owns the five container crossings. This
// rig already builds exactly that state; a second copy of it could drift from this one and then the
// two workers would be demonstrating different lifecycles.
const SCENARIOS = new Set([
  'prepared-refusal', 'prepared-exception', 'prepared-invalid-token', 'prepared-foreign-lock', 'prepared-detach-failure',
  'supervisor-success', 'supervisor-failure', 'supervisor-sigint', 'supervisor-sigterm', 'classifier-failure',
  'supervisor-skips-cleanup', 'supervisor-skips-poll', 'supervisor-low-disk-at-end', 'supervisor-reported-cleanup-error',
  'supervisor-low-disk-during', 'supervisor-start-low-disk',
  'integrity-unreadable-at-end',
  'crash-publication', 'crash-journal-durability', 'crash-retention', 'crash-tombstone',
  'unclassified-stranded-dispose', 'unclassified-stranded-refuse',
  'unclassified-partial-report-dispose',
  'unclassified-seal-failure-release', 'unclassified-manifest-collision-release', 'unclassified-journal-failure-release',
  'unclassified-never-dispose', 'unclassified-never-refuse',
  'unclassified-never-running-dispose', 'unclassified-never-running-refuse',
  'unclassified-never-sealing-dispose', 'unclassified-never-sealing-refuse',
  'unclassified-owner-live', 'unclassified-death-unobserved', 'unclassified-resume-authorized',
  'unclassified-janitor-detached-recovery', 'unclassified-janitor-detach-failure',
  'unclassified-cold-classb-allocated', 'unclassified-cold-classb-scratch-discarding',
  'unclassified-cold-classb-scratch-discarding-drift',
  'unclassified-cold-classb-scratch-discarded', 'unclassified-cold-classb-evidence-discarding',
  'unclassified-cold-classb-evidence-discarding-drift',
  'unclassified-cold-classa-scratch-discarded', 'unclassified-cold-classa-evidence-discarding',
]);
const scenario = process.argv[2];
if (!SCENARIOS.has(scenario)) throw new Error('LIFECYCLE_SEAMS_ARGUMENT');

// Ample and CONSTANT for the support root; SMALL for the state volume. Both halves are load-bearing
// and they model the real box rather than merely satisfying two checks: on a real host the support
// root is the machine's big data volume, and State is a capped sparsebundle whose total size the
// authority refuses to prepare above STATE_LIMIT. A real statfs here would instead make this run's
// verdict depend on the host's free space, which is the one thing a capacity demonstration must not
// do - it would go red on exactly the loaded box where it matters most.
const AMPLE_BLOCKS = 64n * 1024n * 1024n * 1024n / 4096n;
const CAPPED_STATE_BLOCKS = 4096n;
// Flipped by supervisor-low-disk-at-end once the child has run, so the support root falls under the
// 40 GiB running floor exactly as it would on an ordinary loaded box. It starts false and only that
// scenario writes it, so every other scenario sees a constant ample volume.
let supportExhausted = false;
// Flipped by integrity-unreadable-at-end once the child has run: the support root stops being
// READABLE rather than stopping being large, so freeBytes raises DiskStatSourceError. A failing statfs
// is chosen over a malformed one deliberately - freeBytes calls statfs with {bigint:true}, under which
// real Node always returns BigInts, so a bad-SHAPE reading is unreachable in production at this call
// site and would be the fixture modelling something the product cannot meet. A statfs that fails is
// physically ordinary. This is the integrity half failing where low-disk is the resource half, and it
// is deliberately the ONLY post-child trigger that leaves fs.statSync alone - the authority roots
// still validate, so unlike a real device drift the journal CAN be written, which is what makes the
// recorded gate_status observable at all.
let supportUnreadable = false;
fs.statfsSync = (target) => {
  const isState = String(target).includes(`${path.sep}State`);
  if (!isState && supportUnreadable) throw new Error('ENOENT: statfs failed');
  const blocks = isState ? CAPPED_STATE_BLOCKS : AMPLE_BLOCKS;
  const available = !isState && supportExhausted ? 1n : AMPLE_BLOCKS;
  return { bavail: available, bsize: 4096n, blocks, bfree: blocks };
};

// The BACKING DEVICE, drifted on demand and NARROWLY: only readings of the support root move, because
// canonicalIdentity stats images and mounts through this same function and a wholesale override would
// break the seal checks rather than model a swap. Flipped by supervisor-skips-poll after the child.
let backingDeviceDrifted = false;
const realStatSync = fs.statSync;
fs.statSync = (target, ...rest) => {
  const observed = realStatSync(target, ...rest);
  if (!backingDeviceDrifted || String(target) !== layoutSupportRoot) return observed;
  return new Proxy(observed, { get: (o, k) => (k === 'dev' ? o.dev + 1 : o[k]) });
};

const mutationCapability = require('./storage-capability.cjs').claim();
const { CERTIFIED_COMPONENTS, fixedLayout, generatedId, generatedToken } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const containers = require('./storage-containers.cjs');
const { writeEvidenceTree } = require('./storage-evidence-fixture.cjs');

const layout = fixedLayout();
const layoutSupportRoot = layout.support;
const repository = path.resolve(__dirname, '..');
const gateCodeSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(gateCodeSha)) throw new Error('LIFECYCLE_SEAMS_GATE_CODE_SHA');
const runId = generatedId();
// `integrity-unreadable-at-end` is deliberately NONZERO. Its property is that the journal records the
// child's REAL exit code, and a child exiting 0 cannot demonstrate that: `childStatus = 0` would then
// be indistinguishable from carrying the real value out of the supervisor result. 1 discriminates.
const GATE_STATUS_BY_SCENARIO = { 'supervisor-success': 0, 'supervisor-failure': 1, 'supervisor-sigint': 130, 'supervisor-sigterm': 143, 'supervisor-low-disk-during': 17, 'classifier-failure': 0, 'integrity-unreadable-at-end': 1 };
// A crash scenario runs the SAME green flow as supervisor-success and dies inside it. Reaching the
// later crossings any other way would mean reaching them from a state the product never produces.
const gateStatus = GATE_STATUS_BY_SCENARIO[scenario] ?? 0;
const crashPointName = scenario.startsWith('crash-') ? scenario.slice('crash-'.length) : null;

for (const target of [layout.support, layout.stateImage, layout.state, layout.scratchImages, layout.evidenceImages, layout.worktrees, layout.memory, ...Object.values(layout.repositories), path.dirname(layout.launchAgent)]) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
// hostScenarioEnvFile() stats this in the pre-flight region and refuses the run without it. Creating
// it here is fixture setup for the isolated HOME, not a relaxation: the check still runs for real.
fs.writeFileSync(path.join(os.homedir(), '.pentacle-test.env'), 'PENTACLE_DEVICE_UDID=fixture\n', { mode: 0o600 });

const authority = stateMutations.createInstalledAuthority();
fs.mkdirSync(path.join(layout.state, 'reports'), { recursive: true, mode: 0o700 });

// The images and the mounts are REAL DIRECTORIES at the paths the product computes for them, so
// canonicalIdentity, exactSeal, the marker shape checks, and the identity-drift comparison inside
// resolveMounted all run against real inodes. Only the hdiutil enumeration is scripted.
function buildContainer(kind) {
  const image = containers.imagePath(kind, runId);
  const mount = containers.mountPath(kind);
  fs.mkdirSync(image, { recursive: true, mode: 0o700 });
  fs.mkdirSync(mount, { recursive: true, mode: 0o700 });
  const seal = { object_id: crypto.randomUUID(), image: state.canonicalIdentity(image) };
  fs.writeFileSync(path.join(mount, '.pentacle-container.json'), `${JSON.stringify({
    schema: 1, kind, run_id: runId, limit: kind === 'scratch' ? containers.LIMITS.scratch : containers.LIMITS.evidence, seal,
  })}\n`, { flag: 'wx', mode: 0o600 });
  return { image, mount, seal };
}
const scratch = buildContainer('scratch');
const evidence = buildContainer('evidence');

// The candidate tree carries the REAL certified components, copied byte-for-byte out of the
// repository, so verifyCertified(candidateRoot) is a genuine digest comparison rather than an
// injected pass. The wrapper verifies the candidate twice - before the child and again at the seal -
// and both are left real.
const candidateRoot = path.join(scratch.mount, 'candidate');
for (const relative of Object.keys(CERTIFIED_COMPONENTS)) {
  const destination = path.join(candidateRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(repository, relative), destination);
}
fs.mkdirSync(path.join(scratch.mount, 'native', 'derived-root'), { recursive: true, mode: 0o700 });

// resolveMounted's OWN inventory parameter, given a scripted answer. Everything else in it is real -
// this replaces the hdiutil enumeration and nothing more. Patched on the exports object BEFORE
// storage-gate.cjs is required, because the gate destructures it at load time.
const realResolveMounted = containers.resolveMounted;
const attachedKinds = new Set(['scratch', 'evidence']);
const scriptedInventory = (mount) => ({
  attached: mount === scratch.mount && attachedKinds.has('scratch') ? scratch.image
    : mount === evidence.mount && attachedKinds.has('evidence') ? evidence.image : null,
  enumerated: 2,
  foreign: 0,
});
containers.resolveMounted = (kind, id, inventory = scriptedInventory) => realResolveMounted(kind, id, inventory);

const gate = require('./storage-gate.cjs');
const gateMutations = gate.bind(mutationCapability);

// The host lock, in the exact pre-handoff shape claimHostLock demands: unclaimed, owned by this pid,
// carrying a token whose sha256 is what the run record commits to. claimHostLock then runs for real
// and refuses any of those that do not line up.
const lockToken = generatedToken();
fs.writeFileSync(path.join(layout.state, 'gate.lock'), `${JSON.stringify({
  schema: 1, generation: authority.generation, host: authority.host, uid: authority.uid,
  pid: process.pid, token: lockToken, claimed: false, created_at: new Date().toISOString(),
})}\n`, { flag: 'wx', mode: 0o600 });

let run = stateMutations.createRecord('runs', {
  schema: 1, id: runId, revision: 0, state: 'reserved', generation: authority.generation,
  owner: { host: authority.host, uid: authority.uid, pid: process.pid },
  candidate_ref: 'a'.repeat(40), gate_code_sha: gateCodeSha, gate_code_tree_clean: true,
  scratch_image: `${runId}.sparsebundle`, evidence_image: `${runId}.sparsebundle`,
  lock_token_digest: crypto.createHash('sha256').update(lockToken).digest('hex'),
  reserved_at: new Date().toISOString(), first_dead_at: null,
});
run = stateMutations.transitionRun(runId, run.revision, 'allocated', {
  scratch_seal: scratch.seal, evidence_seal: evidence.seal,
  device_set_identity: state.canonicalIdentity(path.join(scratch.mount, 'native')),
  allocated_at: new Date().toISOString(),
});

function runUnclassifiedScenario() {
  const base = Date.now() + 1000;
  const at = (offset) => new Date(base + offset).toISOString();
  const deadOwner = { host: authority.host, uid: authority.uid, pid: 2147483646 };
  const stranded = scenario.startsWith('unclassified-stranded-');
  const retentionRefused = scenario.endsWith('-refuse');
  const ownerLive = scenario === 'unclassified-owner-live';
  const deathUnobserved = scenario === 'unclassified-death-unobserved';
  const janitorDetachedRecovery = ['unclassified-janitor-detached-recovery', 'unclassified-janitor-detach-failure'].includes(scenario);
  const janitorDetachFailure = scenario === 'unclassified-janitor-detach-failure';
  const resumeAuthorized = scenario === 'unclassified-resume-authorized';
  const neverState = scenario.includes('-never-running-') ? 'running'
    : scenario.includes('-never-sealing-') ? 'sealing' : 'allocated';
  const cold = /^unclassified-cold-(class[ab])-(allocated|scratch-discarding|scratch-discarded|evidence-discarding)(-drift)?$/.exec(scenario);

  if (!ownerLive) {
    run = stateMutations.replaceRecord('runs', runId, run.revision, {
      ...run, revision: run.revision + 1, owner: deadOwner, first_dead_at: deathUnobserved || janitorDetachedRecovery ? null : at(0),
    });
  }
  if (janitorDetachedRecovery) {
    run = stateMutations.transitionRun(runId, run.revision, 'running', { handoff_from_pid: deadOwner.pid, running_at: at(1000) });
    run = stateMutations.transitionRun(runId, run.revision, 'sealing', { gate_status: 17, failure: 'fixture gate failure', sealing_at: at(2000) });
    run = stateMutations.transitionRun(runId, run.revision, 'blocked_unclassified', { classification_error: 'fixture unclassified' });
  }
  if (!stranded && !cold && neverState !== 'allocated') {
    run = stateMutations.transitionRun(runId, run.revision, 'running', { handoff_from_pid: deadOwner.pid, running_at: at(1000) });
    if (neverState === 'sealing') run = stateMutations.transitionRun(runId, run.revision, 'sealing', { gate_status: 1, failure: 'fixture gate failure', sealing_at: at(2000) });
  }
  if (cold?.[1] === 'classa') {
    run = stateMutations.transitionRun(runId, run.revision, 'running', { handoff_from_pid: deadOwner.pid, running_at: at(1000) });
    run = stateMutations.transitionRun(runId, run.revision, 'sealing', { gate_status: 1, failure: 'fixture gate failure', sealing_at: at(2000) });
    run = stateMutations.transitionRun(runId, run.revision, 'blocked_unclassified', { classification_error: 'fixture unclassified' });
    run = stateMutations.transitionRun(runId, run.revision, 'scratch_discarding', { scratch_discard_started_at: at(3000) });
    run = stateMutations.transitionRun(runId, run.revision, 'scratch_discarded', { scratch_discarded_at: at(4000) });
    attachedKinds.delete('scratch');
    fs.rmSync(scratch.image, { recursive: true, force: true });
  }
  if (stranded) {
    run = stateMutations.transitionRun(runId, run.revision, 'running', { handoff_from_pid: deadOwner.pid, running_at: at(1000) });
    run = stateMutations.transitionRun(runId, run.revision, 'sealing', { gate_status: 1, failure: 'fixture gate failure', sealing_at: at(2000) });
    if (retentionRefused) {
      run = stateMutations.transitionRun(runId, run.revision, 'published', {
        preliminary_audit_at: at(3000), preliminary_evidence_digest: 'c'.repeat(64), published_at: at(4000),
      });
    } else {
      run = stateMutations.transitionRun(runId, run.revision, 'blocked_unclassified', { classification_error: 'fixture unclassified' });
    }
    run = stateMutations.transitionRun(runId, run.revision, 'scratch_discarding', { scratch_discard_started_at: at(5000) });
    run = stateMutations.transitionRun(runId, run.revision, 'scratch_discarded', {
      scratch_discarded_at: at(6000), ...(retentionRefused ? { evidence_digest: 'd'.repeat(64) } : {}),
    });
    attachedKinds.delete('scratch');
    fs.rmSync(scratch.image, { recursive: true, force: true });
  }

  fs.rmSync(path.join(layout.state, 'gate.lock'));
  if (scenario === 'unclassified-partial-report-dispose') {
    const partial = path.join(evidence.mount, 'report-viewer-sim-e2e');
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'interrupted-case.json'), '{"status":"interrupted"}\n');
  }
  if (scenario === 'unclassified-seal-failure-release') fs.symlinkSync('/forbidden/outside-evidence', path.join(evidence.mount, 'forbidden-link'));
  if (scenario === 'unclassified-manifest-collision-release') fs.writeFileSync(path.join(evidence.mount, 'manifest-v1.json'), `${JSON.stringify({ schema: 1, run_id: runId, outcome: 'passed', generated_at: at(1000), files: [] })}\n`);
  if (cold) {
    const digest = gateMutations.sealUnclassifiedEvidence(runId);
    run = stateMutations.replaceRecord('runs', runId, run.revision, {
      ...run, revision: run.revision + 1, evidence_digest: digest,
      unclassified_disposed_at: at(5000), disposition_reason: 'operator reviewed unclassified evidence',
    });
    if (cold[1] === 'classb' && cold[2] !== 'allocated') {
      run = stateMutations.transitionRun(runId, run.revision, 'scratch_discarding', { scratch_discard_started_at: at(6000) });
      if (cold[2] !== 'scratch-discarding') {
        attachedKinds.delete('scratch');
        fs.rmSync(scratch.image, { recursive: true, force: true });
        run = stateMutations.transitionRun(runId, run.revision, 'scratch_discarded', { scratch_discarded_at: at(7000) });
      }
    }
    if (cold[2] === 'evidence-discarding') run = stateMutations.transitionRun(runId, run.revision, 'evidence_discarding', { evidence_discard_started_at: at(8000) });
    if (cold[3]) fs.writeFileSync(path.join(evidence.mount, 'post-authorization-drift.json'), '{}\n');
    const resumed = spawnSync(process.execPath, [path.join(__dirname, 'storage-unclassified-resume-worker.cjs'), runId, String(base + 25 * 3600000)], {
      cwd: repository, env: process.env, encoding: 'utf8', timeout: 60000,
    });
    if (resumed.error || resumed.status !== 0) throw new Error(`UNCLASSIFIED_COLD_RESUME:${resumed.status}:${String(resumed.stderr || '').trim()}`);
    process.stdout.write(resumed.stdout);
    process.exit(0);
  }
  const originalBind = containers.bind;
  containers.bind = (token) => ({
    ...originalBind(token),
    attachExisting: (kind, id) => { attachedKinds.add(kind); return containers.resolveMounted(kind, id); },
    detachAndDiscard: (kind, id, expectedSeal) => {
      const resolved = containers.resolveMounted(kind, id);
      containers.requireSeal(resolved.seal, expectedSeal);
      attachedKinds.delete(kind);
      fs.rmSync(resolved.image, { recursive: true });
      return { discarded: kind, run_id: id };
    },
    detachRetain: (kind, id, expectedSeal) => {
      const resolved = containers.resolveMounted(kind, id);
      containers.requireSeal(resolved.seal, expectedSeal);
      if (janitorDetachFailure && kind === 'scratch') throw new Error('DETACH_RETAIN_FORCED');
      attachedKinds.delete(kind);
      return { retained: kind, run_id: id };
    },
  });
  if (scenario === 'unclassified-journal-failure-release') {
    const originalStateBind = state.bind;
    state.bind = (token) => {
      const bound = originalStateBind(token);
      return { ...bound, replaceRecord: () => { throw new Error('UNCLASSIFIED_JOURNAL_WRITE_FORCED'); } };
    };
  }
  const { disposeUnclassified } = require('./storage-janitor.cjs').bind(mutationCapability);
  if (janitorDetachedRecovery) {
    attachedKinds.delete('scratch');
    attachedKinds.delete('evidence');
    fs.writeFileSync(path.join(layout.state, 'gate.lock'), `${JSON.stringify({
      schema: 1, generation: authority.generation, host: authority.host, uid: authority.uid,
      pid: deadOwner.pid, token: lockToken, claimed: false, created_at: at(0),
    })}\n`, { flag: 'wx', mode: 0o600 });
    const report = require('./storage-janitor.cjs').bind(mutationCapability).runJanitor('apply', base);
    process.stdout.write(`${JSON.stringify({
      errors: report.errors,
      lock_present: fs.existsSync(path.join(layout.state, 'gate.lock')),
      scratch_attached: attachedKinds.has('scratch'),
      evidence_attached: attachedKinds.has('evidence'),
      scratch_image_present: fs.existsSync(scratch.image),
      evidence_image_present: fs.existsSync(evidence.image),
    })}\n`);
    process.exit(0);
  }
  const endpointNow = base + (retentionRefused ? 3600000 : 25 * 3600000);
  let reasonError = null;
  if (resumeAuthorized) {
    const digest = gateMutations.sealUnclassifiedEvidence(runId);
    run = stateMutations.replaceRecord('runs', runId, run.revision, {
      ...run, revision: run.revision + 1, evidence_digest: digest,
      unclassified_disposed_at: at(1000), disposition_reason: 'operator reviewed unclassified evidence',
    });
    try { disposeUnclassified(runId, 'different reason', endpointNow); }
    catch (thrown) { reasonError = String(thrown.message || thrown); }
  }
  let error = null;
  try { disposeUnclassified(runId, 'operator reviewed unclassified evidence', endpointNow); }
  catch (thrown) { error = String(thrown.message || thrown); }
  const final = state.readRecord('runs', runId);
  process.stdout.write(`${JSON.stringify({
    error,
    reason_error: reasonError,
    run: {
      state: final.state,
      disposition_reason: final.disposition_reason ?? null,
      unclassified_disposed_at: final.unclassified_disposed_at ?? null,
    },
    scratch_image_present: fs.existsSync(scratch.image),
    evidence_image_present: fs.existsSync(evidence.image),
    evidence_attached: attachedKinds.has('evidence'),
  })}\n`);
  process.exit(0);
}

if (scenario.startsWith('unclassified-')) runUnclassifiedScenario();

// ---------------------------------------------------------------------------
// The scripted child, and the real supervisor around it.
// ---------------------------------------------------------------------------

const operations = [];
const signals = [];
let supervisorCause = null;

// A surface trigger that reports a FIRED launch with exactly one owned pid. Only a passed run needs
// it: validateEvidence demands a fired, launched, cleanup-verified trigger record when gate_status is
// 0, and cleanup writes that record from this object. The pid is deliberately one that no longer
// exists, so terminateOwnedSurface takes its real already-exited branch through a real `ps` probe -
// the ownership proof runs, it simply finds the process gone.
const DEAD_PID = 2147483646;
function firedSurfaceTrigger() {
  const required = gate.reportViewerResultsBeforeKeyboard();
  return {
    stop() {},
    summary: () => 'fixture fired',
    surfaces: [{ pid: DEAD_PID, start: 'fixture-start' }],
    attempted: true, failure: null, probeFailure: false, cleanupUnproven: false,
    observedResults: required, requiredResults: required,
  };
}

let currentChild = null;
function scriptedChild() {
  const child = new EventEmitter();
  currentChild = child;
  child.pid = process.pid;
  // The evidence the child would have produced, written at the moment the child would have produced
  // it: before it exits, and therefore before cleanup, the seal, and publication ever look at it.
  writeEvidenceTree(evidence.mount, {
    gateStatus, casePlan: gate.REPORT_VIEWER_CASE_PLAN,
    candidateSha: 'a'.repeat(40), gateCodeSha,
  });
  if (scenario === 'supervisor-low-disk-during') {
    setTimeout(() => { supportExhausted = true; }, 5);
  } else if (scenario === 'supervisor-sigint' || scenario === 'supervisor-sigterm') {
    // Raised HERE because supervise installs its signal handlers before it spawns: this models the
    // signal arriving while the child is running, which is the case the outcome mapping exists for.
    process.emit(scenario === 'supervisor-sigint' ? 'SIGINT' : 'SIGTERM');
  } else {
    setImmediate(() => child.emit('close', gateStatus, null));
  }
  return child;
}

const superviseInjected = (argv, options) => {
  if (!Array.isArray(argv) || !argv.length) throw new Error('LIFECYCLE_SEAMS_ARGV');
  return require('./storage-supervisor.cjs').bind(mutationCapability).supervise(argv, {
    ...options,
    spawnChild: scriptedChild,
    signalGroup: (pid, signalName) => {
      signals.push(signalName);
      // The scripted child answers the real SIGTERM the way a well-behaved one does: it closes,
      // carrying the signal name, which is what drives exitStatus to 130 or 143.
      if (signalName === 'SIGTERM') setImmediate(() => currentChild.emit('close', null, 'SIGTERM'));
    },
    groupAlive: () => false,
    graceMs: 50, reapMs: 50, pollMs: 20,
  }).then((result) => { supervisorCause = result.machine.shutdownCause || null; return result; });
};

// ---------------------------------------------------------------------------

function disposal(label, real) {
  return (kind, id, seal) => {
    // The seal is verified before the recorder records anything, so a recorder can never claim an
    // operation the product would have refused to perform.
    containers.requireSeal(containers.resolveMounted(kind, id).seal, seal);
    operations.push(`${label}:${kind}`);
    if (real) real(kind, id);
  };
}

const dependencies = {
  gateBootstrap: Object.freeze({
    runId,
    snapshotRoot: repository,
    invokingRepository: repository,
    gateCodeSha,
  }),
  requireGateCodeSnapshot: (id, sha) => {
    if (id !== runId || sha !== gateCodeSha) throw new Error('LIFECYCLE_SEAMS_GATE_CODE_SNAPSHOT');
    return repository;
  },
  supervise: superviseInjected,
  verifyGateCodeProvenance: (_root, recorded) => {
    if (recorded.gate_code_sha !== gateCodeSha || recorded.gate_code_tree_clean !== true) {
      throw new Error('LIFECYCLE_SEAMS_GATE_CODE_PROVENANCE');
    }
    return { gate_code_sha: gateCodeSha, gate_code_tree_clean: true };
  },
  detachAndDiscard: disposal('discard', (kind) => {
    const target = kind === 'scratch' ? scratch : evidence;
    fs.rmSync(target.mount, { recursive: true, force: true });
    fs.rmSync(target.image, { recursive: true, force: true });
  }),
  detachRetain: disposal('retain'),
  // Preparation is reduced to the child environment and, for a passed run, the surface trigger. Every
  // other field of `environment` stays null, which is exactly what makes each cleanup step skip
  // itself without a test-only branch anywhere in the product.
  prepareEnvironment: async (environment) => {
    environment.env = { ...process.env, PENTACLE_STORAGE_SANDBOXED: '1' };
    if (gateStatus === 0) environment.simulatorSurfaceTrigger = firedSurfaceTrigger();
  },
};

// A substitute supervisor that reports a clean green run WITHOUT running the capacity/backing poll or
// the cleanup it was handed. This is the disable-by-argument shape the reduced dependency list still
// admits, and the gate must refuse it rather than seal a run on the substitute's own say-so.
if (scenario === 'supervisor-skips-cleanup') {
  dependencies.supervise = async () => ({ status: 0, machine: {}, cleanup_error: null });
}
if (scenario === 'supervisor-reported-cleanup-error') {
  const scriptedSupervise = dependencies.supervise;
  dependencies.supervise = async (argv, options) => ({ ...await scriptedSupervise(argv, options), cleanup_error: 'CONTROL_CLEANUP_ERROR' });
}

// The SAME substitute, against a support volume that fell under the running floor while the child
// ran. It runs the cleanup - so the cleanup assertion is satisfied and cannot be what catches this -
// but never calls the `capacity` callback it was handed. That is LEGITIMATE for a fast child, since
// the real supervisor polls on a five-second interval, which is exactly why the poll cannot simply be
// asserted. The gate's own post-child check is the only thing left to catch it, and it must.
if (scenario === 'supervisor-skips-poll') {
  dependencies.supervise = async (argv, options) => {
    await options.cleanup();
    backingDeviceDrifted = true;
    return { status: 0, machine: {}, cleanup_error: null };
  };
}

// A LEGITIMATE green run on a loaded box: the real supervisor, the real scripted child exiting 0, a
// real evidence tree, and a support volume that fell under the 40 GiB running floor by the time the
// child finished. Nothing here is a substitute - this is the ordinary case, and it must still seal,
// publish, and RELEASE its scratch. A gate that refused here would stop releasing disk precisely
// because the disk ran low.
if (scenario === 'supervisor-low-disk-at-end') {
  const scriptedSupervise = dependencies.supervise;
  dependencies.supervise = async (argv, options) => {
    const result = await scriptedSupervise(argv, options);
    supportExhausted = true;
    return result;
  };
}

if (scenario === 'supervisor-start-low-disk') supportExhausted = true;

// The post-child INTEGRITY check failing on a child that exited 0. Real supervisor, real scripted
// child, real cleanup; only the support root's statfs reading stops being trustworthy once the child
// is done. This is the case that reads `childStatus` in the catch, and the only one that can: a real
// backing-device drift moves the authority roots too, so the journal cannot be written and there is
// no record to inspect (see supervisor-skips-poll). Here the journal is healthy, so what the gate
// recorded is observable - and it must be the child's own 1, neither the 17 fallback nor a 0.
if (scenario === 'integrity-unreadable-at-end') {
  const scriptedSupervise = dependencies.supervise;
  dependencies.supervise = async (argv, options) => {
    const result = await scriptedSupervise(argv, options);
    supportUnreadable = true;
    return result;
  };
}

if (scenario === 'classifier-failure') {
  dependencies.preliminaryEvidenceDigest = () => { throw new Error('LIFECYCLE_CLASSIFIER_FORCED'); };
}

const { armCrashPoint } = require('./storage-crash-points.cjs').bind(mutationCapability);

// The retention sweep and the tombstone sit AFTER a run is fully published and its scratch discarded,
// so the green flow has to complete first, unarmed. Arming earlier would kill the process building
// the very state the crossing needs.
async function crashInJanitor() {
  await gateMutations.runFullGate(runId, lockToken, dependencies);
  const published = state.readRecord('runs', runId);
  // The janitor's own container operations become recorders, on the same terms as the gate's: this is
  // the hdiutil boundary again, not the journal. Patched BEFORE the janitor is required, because it
  // binds them at load.
  containers.bind = () => ({
    attachExisting: () => ({ mount: evidence.mount, seal: evidence.seal }),
    createImage: () => {},
    detachAndDiscard: disposal('discard', () => {
      fs.rmSync(evidence.mount, { recursive: true, force: true });
      fs.rmSync(evidence.image, { recursive: true, force: true });
    }),
    detachRetain: disposal('retain'),
    ensureStateImage: () => {},
    recoverOrCreate: () => ({ mount: evidence.mount, seal: evidence.seal }),
  });
  const janitor = require('./storage-janitor.cjs').bind(mutationCapability);
  armCrashPoint(crashPointName);
  // Eight days past publication, so a gate_status 0 run is past its seven-day retention and the
  // decision is genuinely discard-evidence. The clock is REAL; only the clock READING is supplied.
  janitor.discardEvidence(runId, Date.parse(published.published_at) + 8 * 86400000);
  throw new Error(`LIFECYCLE_SEAMS_CRASH_NOT_REACHED:${crashPointName}`);
}

// The durability crossing sits between the temp file's fsync and its rename, which every journal
// write goes through - so any real transition reaches it. The run is already `allocated` here, and
// the transition it dies inside is the one runFullGate itself performs first.
function crashInJournal() {
  armCrashPoint('journal-durability');
  stateMutations.transitionRun(runId, run.revision, 'running', {
    owner: { host: authority.host, uid: authority.uid, pid: process.pid },
    handoff_from_pid: process.pid, running_at: new Date().toISOString(),
  });
  throw new Error('LIFECYCLE_SEAMS_CRASH_NOT_REACHED:journal-durability');
}

async function main() {
  if (scenario.startsWith('prepared-')) {
    const lockPath = path.join(layout.state, 'gate.lock');
    let reached = false; let threw = null;
    const before = JSON.stringify(state.readRecord('runs', runId));
    try {
      await gateMutations.withPreparedAllocation(runId, scenario === 'prepared-invalid-token' ? 'f'.repeat(64) : lockToken, async () => {
        reached = true;
        if (scenario === 'prepared-foreign-lock') {
          const lock = JSON.parse(fs.readFileSync(lockPath));
          fs.writeFileSync(lockPath, JSON.stringify({ ...lock, token: 'f'.repeat(64) }));
        }
        throw new Error(scenario === 'prepared-refusal' ? 'HOST_HEALTH_REFUSED:Syncthing needBytes=3523229008' : 'BOOTSTRAP_EXCEPTION');
      }, { detachRetain: (kind, id, seal) => {
        if (scenario === 'prepared-detach-failure' && kind === 'scratch') throw new Error('SCRATCH_DETACH_REFUSED');
        disposal('retain', () => attachedKinds.delete(kind))(kind, id, seal);
      } });
    } catch (error) { threw = String(error.message || error); }
    process.stdout.write(`${JSON.stringify({ reached, threw, operations, attached: [...attachedKinds], lock_present: fs.existsSync(lockPath),
      foreign_lock_preserved: fs.existsSync(lockPath) && JSON.parse(fs.readFileSync(lockPath)).token === 'f'.repeat(64),
      journal_unchanged: JSON.stringify(state.readRecord('runs', runId)) === before,
      images_retained: fs.existsSync(scratch.image) && fs.existsSync(evidence.image) })}\n`);
    return;
  }
  if (crashPointName === 'journal-durability') return crashInJournal();
  if (crashPointName === 'retention' || crashPointName === 'tombstone') return crashInJanitor();
  if (crashPointName === 'publication') armCrashPoint('publication');

  let threw = null;
  let status = null;
  try {
    const result = await gateMutations.runFullGate(runId, lockToken, dependencies);
    status = result.status;
  } catch (error) { threw = String(error.message || error); }
  if (crashPointName) throw new Error(`LIFECYCLE_SEAMS_CRASH_NOT_REACHED:${crashPointName}:status=${status}:error=${threw}`);

  const final = state.readRecord('runs', runId);
  const manifestFile = path.join(evidence.mount, 'manifest-v1.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  let retainedVerified = false;
  try { retainedVerified = gate.verifyRetainedEvidence(final) === true; } catch {}
  process.stdout.write(`${JSON.stringify({
    status,
    threw,
    supervisor_cause: supervisorCause,
    signals,
    operations,
    run: {
      id: final.id, state: final.state, gate_status: final.gate_status ?? null,
      failure: final.failure ?? null, classification_error: final.classification_error ?? null,
      evidence_digest: final.evidence_digest,
    },
    scratch_image_present: fs.existsSync(scratch.image),
    evidence_image_present: fs.existsSync(evidence.image),
    manifest: manifest && { run_id: manifest.run_id, outcome: manifest.outcome, files: manifest.files.length },
    retained_evidence_verified: retainedVerified,
  })}\n`);
}

main().catch((error) => { process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; });
