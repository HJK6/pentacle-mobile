'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { runOwnedSync: spawnSync } = require('./owned-process.cjs');
const { requireEvidenceProvenance, requireMatchingGateCodeProvenance, requirePushedCommit } = require('./gate-code-provenance.cjs');
const { requireJanitorHealthy } = require('./storage-janitor-health.cjs');
const gateCodeSnapshots = require('./gate-code-snapshot.cjs');
const mutationCapability = require('./storage-capability.cjs').claim();
const { CERTIFIED_COMPONENTS, fixedLayout, generatedToken } = require('./storage-authority.cjs');
const containers = require('./storage-containers.cjs');
const { createImage, detachAndDiscard, detachRetain } = containers.bind(mutationCapability);
const { createCapacityGuard, enforceImageBacking, imagePath, resolveMounted } = containers;
const state = require('./storage-state.cjs');
const { createRecord, transitionRun } = state.bind(mutationCapability);
const { readRecord, validateInstalledAuthority } = state;
const { supervise } = require('./storage-supervisor.cjs').bind(mutationCapability);
const { sandboxed } = require('./storage-sandbox.cjs').bind(mutationCapability);
const { hostTemporaryRoot, idbRoot } = require('./storage-sandbox.cjs');
const { reapStaleSimulatorSubstrate } = require('./sim-substrate.cjs');
const buildCache = require('./storage-build-cache.cjs');
const cacheStore = buildCache.bind(mutationCapability);
const surfaceTrigger = require('./storage-surface-trigger.cjs');
const { createCaseCompletionTrigger } = surfaceTrigger;
const { terminateOwnedSurface } = surfaceTrigger.bind(mutationCapability);

function fsyncDirectory(directory) { const descriptor = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function atomicJson(target, value) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  fsyncDirectory(directory);
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function verifyCertified(root = path.resolve(__dirname, '..')) {
  for (const [relative, expected] of Object.entries(CERTIFIED_COMPONENTS)) {
    if (sha256(path.join(root, relative)) !== expected) throw new Error(`CERTIFIED_COMPONENT_DRIFT:${relative}`);
  }
  return true;
}

function reapHostSimulatorSubstrate() {
  return { scope: 'runner-owned-only', foreign_resources_untouched: true };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function validateHostLock(value) {
  const keys = value?.claimed === true ? ['claimed', 'claimed_at', 'created_at', 'generation', 'host', 'pid', 'schema', 'token', 'uid'] : ['claimed', 'created_at', 'generation', 'host', 'pid', 'schema', 'token', 'uid'];
  const exactClock = (clock) => typeof clock === 'string' && Number.isFinite(Date.parse(clock)) && new Date(clock).toISOString() === clock;
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()) || value.schema !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.generation) || typeof value.host !== 'string' || !Number.isInteger(value.uid) || !Number.isInteger(value.pid) || value.pid <= 0 || !/^[0-9a-f]{64}$/.test(value.token) || !exactClock(value.created_at) || (value.claimed === true && !exactClock(value.claimed_at)) || ![true, false].includes(value.claimed)) throw new Error('HOST_LOCK_SCHEMA_INVALID');
  return value;
}

// The custom simulator device set lives INSIDE the child's own home, which is itself inside the
// capped scratch image. This is the one placement that is self-consistent for every consumer:
// the certified gate admits only os.homedir()/Library/Developer/{CoreSimulator,PentacleCoreSimulator}
// /Devices (full-gate.cjs), and the child's HOME is <scratch>/home, so this path IS the admitted
// PentacleCoreSimulator constant as the CHILD computes it. The device set stays wholly within the
// 12 GiB cap, so invariant 6 is unchanged, and because it is a real directory rather than a symlink
// into scratch there is no proof-then-use window between validating it and the child resolving it.
function scratchDeviceSetRoot(scratchMount) {
  return path.join(scratchMount, 'home', 'Library', 'Developer', 'PentacleCoreSimulator', 'Devices');
}

function acquireHostLock(authority) {
  const target = path.join(fixedLayout().state, 'gate.lock');
  const token = generatedToken();
  const value = { schema: 1, generation: authority.generation, host: authority.host, uid: authority.uid, pid: process.pid, token, claimed: false, created_at: new Date().toISOString() };
  try { fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = validateHostLock(JSON.parse(fs.readFileSync(target, 'utf8')));
    if (existing.generation !== authority.generation || existing.host !== authority.host || existing.uid !== authority.uid || !processAlive(existing.pid)) throw new Error('HOST_LOCK_UNREADABLE_OR_STALE');
    throw new Error('HOST_GATE_ALREADY_RUNNING');
  }
  fsyncDirectory(path.dirname(target));
  return { token, target };
}

function claimHostLock(run, token, priorPid) {
  const target = path.join(fixedLayout().state, 'gate.lock');
  const value = validateHostLock(JSON.parse(fs.readFileSync(target, 'utf8')));
  if (value.token !== token || value.claimed !== false || run.lock_token_digest !== crypto.createHash('sha256').update(token).digest('hex') || value.pid !== priorPid || run.owner.pid !== process.pid || value.generation !== run.generation) throw new Error('HOST_LOCK_IDENTITY_INVALID');
  const claimed = { ...value, claimed: true, pid: process.pid, claimed_at: new Date().toISOString() };
  atomicJson(target, claimed);
  return claimed;
}

function releaseHostLock(run, token) {
  const target = path.join(fixedLayout().state, 'gate.lock');
  const value = validateHostLock(JSON.parse(fs.readFileSync(target, 'utf8')));
  if (value.token !== token || value.claimed !== true || value.pid !== run.owner.pid || run.lock_token_digest !== crypto.createHash('sha256').update(token).digest('hex')) throw new Error('HOST_LOCK_RELEASE_MISMATCH');
  fs.unlinkSync(target);
  fsyncDirectory(path.dirname(target));
}

function recoverDeadHostLock(runId) {
  const run = readRecord('runs', runId);
  const target = path.join(fixedLayout().state, 'gate.lock');
  if (!fs.existsSync(target)) return false;
  const value = validateHostLock(JSON.parse(fs.readFileSync(target, 'utf8')));
  const preHandoff = ['reserved', 'allocated'].includes(run.state);
  const adopted = value.claimed === true && value.pid === run.owner.pid;
  const interruptedAdoption = value.claimed === false && value.pid === run.handoff_from_pid && (run.state === 'running' || run.owner.pid === run.handoff_from_pid);
  if (processAlive(value.pid) || (preHandoff && (value.pid !== run.owner.pid || value.claimed !== false)) || (!preHandoff && !adopted && !interruptedAdoption) || value.host !== run.owner.host || value.uid !== run.owner.uid || crypto.createHash('sha256').update(value.token).digest('hex') !== run.lock_token_digest || value.generation !== run.generation) throw new Error('HOST_LOCK_RECOVERY_MISMATCH');
  fs.unlinkSync(target);
  fsyncDirectory(path.dirname(target));
  return true;
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`GATE_COMMAND_FAILED:${path.basename(binary)}:${result.status}:${String(result.stderr || result.error || '').trim()}`);
  return String(result.stdout || '').trim();
}

function preparedOwnership(runId, token, allowMissingLock = false) {
  const authority = validateInstalledAuthority();
  const run = readRecord('runs', runId);
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  if (run.generation !== authority.generation || run.owner.uid !== authority.uid || run.owner.host !== authority.host
      || run.lock_token_digest !== digest) throw new Error('PREPARED_RUN_AUTHORITY_INVALID');
  const target = path.join(fixedLayout().state, 'gate.lock');
  if (allowMissingLock && !fs.existsSync(target)) return { run, target, raw: null };
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== authority.uid) throw new Error('PREPARED_LOCK_AUTHORITY_INVALID');
  const raw = fs.readFileSync(target, 'utf8');
  const lock = validateHostLock(JSON.parse(raw));
  const matchingPid = lock.pid === run.owner.pid || (!lock.claimed && lock.pid === run.handoff_from_pid);
  if (lock.token !== token || lock.generation !== run.generation || lock.uid !== run.owner.uid || lock.host !== run.owner.host
      || !matchingPid || (lock.pid !== process.pid && processAlive(lock.pid))) throw new Error('PREPARED_LOCK_AUTHORITY_INVALID');
  return { run, target, raw };
}

function releasePreparedAllocation(runId, token, dependencies = {}) {
  // Bind the retained allocation before observing fixed mount points; a replacement lock is foreign.
  const { run, target, raw } = preparedOwnership(runId, token, true);
  const detach = dependencies.detachRetain || detachRetain;
  const checks = [];
  for (const kind of ['scratch', 'evidence']) {
    try {
      let mounted;
      try { mounted = resolveMounted(kind, runId); }
      catch (error) {
        if (!String(error.message).startsWith('CONTAINER_MOUNT_ABSENT:')) throw error;
        checks.push({ name: kind, status: 'passed', already_detached: true });
        continue;
      }
      detach(kind, runId, run[`${kind}_seal`] || mounted.seal);
      checks.push({ name: kind, status: 'passed' });
    } catch (error) { checks.push({ name: kind, status: 'failed', error: String(error.message || error) }); }
  }
  try {
    if (raw !== null) {
      const current = preparedOwnership(runId, token);
      if (current.raw !== raw) throw new Error('PREPARED_LOCK_AUTHORITY_CHANGED');
      fs.unlinkSync(target); fsyncDirectory(path.dirname(target));
    }
    checks.push({ name: 'lock', status: 'passed', already_released: raw === null });
  } catch (error) { checks.push({ name: 'lock', status: 'failed', error: String(error.message || error) }); }
  const receipt = { run_id: runId, checks, retained: true };
  if (checks.some(check => check.status === 'failed')) throw new Error(`PREPARED_ALLOCATION_CLEANUP:${JSON.stringify(receipt)}`);
  return receipt;
}

async function withPreparedAllocation(runId, token, operation, dependencies = {}) {
  preparedOwnership(runId, token);
  let failure;
  try { return await operation(); }
  catch (error) { failure = error; throw error; }
  finally {
    try {
      const receipt = releasePreparedAllocation(runId, token, dependencies);
      process.stderr.write(`PREPARED_ALLOCATION_CLEANUP:${JSON.stringify(receipt)}\n`);
    } catch (error) {
      if (!failure) throw error;
      failure.message = `${failure.message} [prepared-cleanup=${String(error.message || error)}]`;
    }
  }
}

async function prepareNativeRoot(candidateRef, gateBootstrap) {
  verifyCertified();
  const gateCodeRoot = path.resolve(__dirname, '..');
  if (!gateBootstrap || gateBootstrap.snapshotRoot !== gateCodeRoot || gateBootstrap.runId === undefined
      || gateBootstrap.gateCodeSha === undefined || gateBootstrap.invokingRepository === undefined) {
    throw new Error('GATE_BOOTSTRAP_REQUIRED');
  }
  const id = gateBootstrap.runId;
  const repository = gateBootstrap.invokingRepository;
  const gateCodeProvenance = requireMatchingGateCodeProvenance(repository, {
    gate_code_sha: gateBootstrap.gateCodeSha,
    gate_code_tree_clean: true,
  });
  gateCodeSnapshots.requireSnapshot(id, gateCodeProvenance.gate_code_sha);
  const authority = validateInstalledAuthority();
  requireJanitorHealthy();
  // gate:native-root and gate:full are separate processes, so their guard objects cannot span the
  // phase boundary. Within this phase one guard deliberately brackets both the start reading and the
  // five-second supervisor poll; a second guard would capture a post-swap device and agree with it.
  const capacityGuard = createCapacityGuard();
  const lock = acquireHostLock(authority);
  try { capacityGuard.requireCapacity('start'); }
  catch (error) { fs.unlinkSync(lock.target); fsyncDirectory(path.dirname(lock.target)); throw error; }
  let candidateSha;
  try {
    const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    candidateSha = command('/usr/bin/git', ['-C', repository, 'rev-parse', `${candidateRef}^{commit}`], { env: gitEnvironment });
    requirePushedCommit(repository, candidateSha);
  } catch (error) {
    fs.unlinkSync(lock.target);
    fsyncDirectory(path.dirname(lock.target));
    throw error;
  }
  const now = new Date().toISOString();
  let run;
  try {
    run = createRecord('runs', {
    schema: 1,
    id,
    revision: 0,
    state: 'reserved',
    generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: process.pid },
    candidate_ref: candidateSha,
    ...gateCodeProvenance,
    scratch_image: `${id}.sparsebundle`,
    evidence_image: `${id}.sparsebundle`,
    lock_token_digest: crypto.createHash('sha256').update(lock.token).digest('hex'),
    reserved_at: now,
    first_dead_at: null,
    });
    const scratch = createImage('scratch', id);
    const evidence = createImage('evidence', id);
    const scratchMount = resolveMounted('scratch', id).mount;
    for (const directory of ['home', 'tmp', 'cache', 'config', 'derived-data', 'native']) fs.mkdirSync(path.join(scratchMount, directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(scratchDeviceSetRoot(scratchMount), { recursive: true, mode: 0o700 });
    run = transitionRun(id, run.revision, 'allocated', { scratch_seal: scratch.seal, evidence_seal: evidence.seal, device_set_identity: require('./storage-state.cjs').canonicalIdentity(scratchDeviceSetRoot(scratchMount)), allocated_at: new Date().toISOString() });
    verifyCertified(gateCodeRoot);
    const build = await supervise(sandboxed([process.execPath, path.join(gateCodeRoot, 'scripts', 'storage-builder-worker.cjs'), id]), {
      env: {
        ...process.env,
        PENTACLE_STORAGE_SANDBOXED: '1',
        PENTACLE_GATE_REPOSITORY_ROOT: repository,
        PENTACLE_GATE_CODE_SHA: gateCodeProvenance.gate_code_sha,
        PENTACLE_GATE_CODE_TREE_CLEAN: String(gateCodeProvenance.gate_code_tree_clean),
      },
      cwd: gateCodeRoot,
      capacity: () => { capacityGuard.requireCapacity('running'); enforceImageBacking('scratch', id); enforceImageBacking('evidence', id); },
    });
    if (build.status !== 0) { const failure = new Error(`NATIVE_BUILD_FAILED:${build.status}`); failure.exitCode = build.status; throw failure; }
    const nativeEntries = fs.readdirSync(path.join(scratchMount, 'native'));
    if (nativeEntries.length !== 1) throw new Error('NATIVE_ROOT_CARDINALITY');
    const candidateConfig = path.join(scratchMount, 'native', nativeEntries[0], 'pentacle.config.local.ts');
    if (!fs.lstatSync(candidateConfig).isFile() || fs.statSync(candidateConfig).size > require('./storage-containers.cjs').LIMITS.config) throw new Error('CONTAINER_CAP_EXCEEDED');
    return { run_id: id, lock_token: lock.token };
  } catch (error) {
    try { gateCodeSnapshots.discardSnapshot(id); }
    catch (snapshotError) { error = new Error(`${String(error.message || error)} [gate-code-snapshot=${String(snapshotError.message || snapshotError)}]`); }
    if (!run) {
      const held = JSON.parse(fs.readFileSync(lock.target, 'utf8'));
      if (held.token === lock.token) { fs.unlinkSync(lock.target); fsyncDirectory(path.dirname(lock.target)); }
      throw error;
    }
    try { releasePreparedAllocation(id, lock.token); }
    catch (cleanupError) { error.message = `${error.message} [prepared-cleanup=${String(cleanupError.message || cleanupError)}]`; }
    let current = readRecord('runs', id);
    if (current.state === 'allocated') current = transitionRun(id, current.revision, 'running', { failure: String(error.message || error), handoff_from_pid: current.owner.pid, running_at: new Date().toISOString() });
    if (current.state === 'running') current = transitionRun(id, current.revision, 'sealing', { gate_status: 17, failure: String(error.message || error), sealing_at: new Date().toISOString() });
    if (current.state === 'sealing') transitionRun(id, current.revision, 'blocked_unclassified', { classification_error: String(error.message || error) });
    throw error;
  }
}

// macOS auto-creates these on any mounted APFS/HFS volume (fsevents daemon,
// Trash, Spotlight, Finder). They are never part of the gate's evidence and must
// be ignored, otherwise the evidence enumeration fails (EVIDENCE_UNKNOWN_DIRECTORY)
// on any host with those subsystems active.
// Top-level directories a CERTIFIED STAGE is entitled to create on the evidence image. ios-export is not
// a concession: full-gate.cjs exports into path.join(artifactDir, 'ios-export'), so the validator refusing
// it was always a mismatch between the wrapper's expectations and the gate's own contract - it was simply
// unreachable while the old ios-export indirection made cleanup throw BEFORE sealing was ever attempted.
// Its contents enter the manifest and digest like every other evidence file, deliberately: measured at run
// example-03 the export is 59 files / 11 MB / zero symlinks, and hashing all of it costs 81 ms. Excluding a
// directory would instead punch a hole in the digest where content could change undetected.
//
// STATED ASSUMPTION, not a proven invariant: expo export emits NO SYMLINKS. That was measured once, on one
// version of a third-party tool, and admitting ios-export makes it LOAD-BEARING FOR SEALING - enumerateEvidence
// refuses symlinks outright, so a single symlinked file anywhere under the export fails the whole run at the
// seal. If a future expo version or asset pipeline starts emitting one, the failure to expect is
// EVIDENCE_SYMLINK_FORBIDDEN naming a path under ios-export/, and it means "expo emitted a symlink", NOT
// "the evidence image is corrupt". The correct response is to re-measure expo's output and decide
// deliberately - not to relax the symlink rule, which is fail-closed for a good reason.
// The wrapper's OWN copy of the certified nine-case plan, and like the stage list it may be a copy but
// never disagree. The middle six are the keys of the SENTINELS object literal in report-viewer-sim-e2e.cjs
// IN INSERTION ORDER, because certified scenarioPlan() builds them with Object.entries(SENTINELS). That is
// the stage-list defect one layer over: reorder or add a sentinel in a certified revision and this throws
// EVIDENCE_CASE_PLAN at the SEAL, after a full run, invisibly. Drift is caught at test time instead by
// 'the wrapper case plan stays derived-equal to the certified scenario plan'.
const REPORT_VIEWER_CASE_PLAN = [
  ['report_viewer_horizontal_scroll', null, 'PASS'], ['report_viewer_runtime_sentinel', 'clean', 'PASS'],
  ...['console_error', 'unhandled_rejection', 'fatal', 'delayed_post_return', 'crash_only', 'liveness_loss'].map((sentinel) => ['report_viewer_runtime_sentinel', sentinel, 'FAIL']),
  ['report_viewer_comments_keyboard', null, 'PASS'],
];
function reportViewerResultsBeforeKeyboard() {
  const matches = REPORT_VIEWER_CASE_PLAN
    .map(([scenario], index) => scenario === 'report_viewer_comments_keyboard' ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1 || matches[0] !== REPORT_VIEWER_CASE_PLAN.length - 1) throw new Error('GATE_SURFACE_TRIGGER_CASE_PLAN');
  return matches[0];
}
const EVIDENCE_DIRECTORIES = new Set(['report-viewer-sim-e2e', 'ios-export', 'launch-diagnosis']);
const MACOS_VOLUME_METADATA = new Set([
  '.fseventsd', '.Trashes', '.Spotlight-V100', '.DS_Store', '.TemporaryItems', '.DocumentRevisions-V100',
]);

function enumerateEvidence(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    const current = path.join(root, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (MACOS_VOLUME_METADATA.has(entry.name)) continue;
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(root, childRelative);
      const stat = fs.lstatSync(child);
      // Names the offending path. Refusing symlinks is correct and stays fail-closed - one could point
      // outside the image and make the digest meaningless - but with 59+ export files a bare error tells a
      // future lead nothing about where to look, which is the exact failure mode defect C existed to end.
      if (stat.isSymbolicLink()) throw new Error(`EVIDENCE_SYMLINK_FORBIDDEN:${childRelative}`);
      if (stat.isDirectory()) {
        if (!relative && !EVIDENCE_DIRECTORIES.has(entry.name)) throw new Error(`EVIDENCE_UNKNOWN_DIRECTORY:${entry.name}`);
        stack.push(childRelative);
      } else if (stat.isFile()) files.push({ relative: childRelative, size: stat.size, mtime_ms: stat.mtimeMs, sha256: sha256(child) });
      else throw new Error('EVIDENCE_OBJECT_FORBIDDEN');
    }
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function validateSurfaceTriggerEvidence(root, runId, gateStatus) {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'storage-surface-trigger.json'), 'utf8'));
  const exact = (value, keys) => value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  if (!exact(record, ['schema', 'run_id', 'status', 'reason', 'observed_results', 'required_results', 'launch', 'cleanup', 'completed_at']) || record.schema !== 1 || record.run_id !== runId || !['fired', 'skipped'].includes(record.status) || typeof record.reason !== 'string' || !Number.isInteger(record.observed_results) || record.observed_results < 0 || record.required_results !== reportViewerResultsBeforeKeyboard() || !Number.isFinite(Date.parse(record.completed_at))) throw new Error('EVIDENCE_SURFACE_TRIGGER_INVALID');
  if (!exact(record.launch, ['status', 'error', 'pids']) || !['launched', 'failed', 'not-attempted'].includes(record.launch.status) || !(record.launch.error === null || typeof record.launch.error === 'string') || !Array.isArray(record.launch.pids) || record.launch.pids.some((pid) => !Number.isInteger(pid) || pid <= 1) || new Set(record.launch.pids).size !== record.launch.pids.length) throw new Error('EVIDENCE_SURFACE_TRIGGER_LAUNCH');
  if ((record.launch.status === 'launched' && (record.launch.error !== null || record.launch.pids.length !== 1)) || (record.launch.status === 'failed' && typeof record.launch.error !== 'string') || (record.launch.status === 'not-attempted' && (record.launch.error !== null || record.launch.pids.length))) throw new Error('EVIDENCE_SURFACE_TRIGGER_LAUNCH');
  if (!exact(record.cleanup, ['status', 'error', 'outcomes']) || !['verified', 'not-required'].includes(record.cleanup.status) || record.cleanup.error !== null || !Array.isArray(record.cleanup.outcomes) || record.cleanup.outcomes.some((entry) => !exact(entry, ['pid', 'outcome']) || !record.launch.pids.includes(entry.pid) || !['terminated', 'already-exited'].includes(entry.outcome))) throw new Error('EVIDENCE_SURFACE_TRIGGER_CLEANUP');
  if (record.status === 'fired') {
    if (record.observed_results < record.required_results || record.launch.status === 'not-attempted') throw new Error('EVIDENCE_SURFACE_TRIGGER_FIRED');
  } else if (record.observed_results >= record.required_results || record.launch.status !== 'not-attempted' || record.launch.pids.length || record.cleanup.status !== 'not-required') throw new Error('EVIDENCE_SURFACE_TRIGGER_SKIPPED');
  if (record.launch.pids.length ? record.cleanup.status !== 'verified' || record.cleanup.outcomes.length !== record.launch.pids.length : record.cleanup.status !== 'not-required' || record.cleanup.outcomes.length) throw new Error('EVIDENCE_SURFACE_TRIGGER_OWNERSHIP');
  if (gateStatus === 0 && (record.status !== 'fired' || record.reason !== 'case-results-complete' || record.launch.status !== 'launched' || record.cleanup.status !== 'verified')) throw new Error('EVIDENCE_SURFACE_TRIGGER_REQUIRED');
  return record;
}

// `gateStatus` is the WRAPPER'S OWN observation - the child's real exit code, recorded in our journal -
// and it is REQUIRED, with no default. It used to be summary.status, read from run.json INSIDE the evidence
// image, i.e. the audited artifact selecting its own audit strictness. That is the stage-list defect one
// layer further out and sitting on the SEAL: the lane byte-pins full-gate.cjs precisely because it does not
// trust that file not to drift, and then trusted the same file's self-report to decide how hard to check
// it. Those two positions cannot both be held, and certified bytes have been re-pinned three times here, so
// the precondition is not hypothetical. Publication was already classified from run.gate_status, so a run
// could be AUDITED as failed and CLASSIFIED as passed.
//
// The disagreement is itself a signal, so this does not merely switch source: the child's self-report must
// AGREE with our observation, and a mismatch fails closed rather than passing quietly.
function validateEvidence(root, runId, phase, gateStatus) {
  const files = enumerateEvidence(root);
  const { collectChecks, requireChecks } = require('./gate-checks.cjs');
  let checks = [];
  const check = (name, run, dependsOn = []) => { checks = collectChecks([{ name, run, dependsOn }], checks); return checks.at(-1).value; };
  const top = new Set(files.filter((entry) => !entry.relative.includes('/')).map((entry) => entry.relative));
  check('required-files', () => { const missing = [];
  for (const required of ['.pentacle-container.json', 'run.json', 'native-root.json', 'storage-surface-trigger.json']) if (!top.has(required)) missing.push(`EVIDENCE_REQUIRED_MISSING:${required}`);
  if (missing.length) throw new Error(missing.join(';')); });
  const stageFiles = new Set(['focused-jest', 'serial-jest', 'typecheck', 'ios-export', 'release-sim-bootstatus', 'release-sim-build', 'release-sim-reset', 'release-sim-install', 'release-sim-launch', 'release-sim-settle', 'release-sim-liveness', 'sim-e2e'].flatMap((name) => [`${name}.json`, `${name}.log`]));
  for (const file of ['release-sim-readiness.json', 'host-health-build.json', 'host-health-start.json', 'host-health-start.json.samples.jsonl', 'build-cache.json']) stageFiles.add(file);
  check('allowed-files', () => { const unknown = [];
  for (const name of top) {
    if (!['.pentacle-container.json', 'run.json', 'native-root.json', 'storage-surface-trigger.json', 'testtime.jsonl', 'cleanup.json', 'manifest-v1.json'].includes(name) && !stageFiles.has(name)) unknown.push(`EVIDENCE_UNKNOWN_FILE:${name}`);
  }
  if (unknown.length) throw new Error(unknown.join(';')); });
  check('surface-trigger', () => validateSurfaceTriggerEvidence(root, runId, gateStatus));
  const native = check('native-json', () => JSON.parse(fs.readFileSync(path.join(root, 'native-root.json'), 'utf8')));
  check('launch-binding', () => require('./storage-launch-evidence.cjs').validateLaunchEvidence(root, runId, native.candidate_sha), ['native-json']);
  const summary = check('summary-json', () => JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8')));
  const outcome = gateStatus === 0 ? 'passed' : 'failed';
  check('outcome-binding', () => {
  if (!Number.isInteger(gateStatus)) throw new Error('EVIDENCE_OUTCOME_UNAUTHORITATIVE');
  if (!['passed', 'failed'].includes(summary.status) || !Array.isArray(summary.gates)) throw new Error('EVIDENCE_RUN_INVALID');
  if (summary.status !== outcome) throw new Error(`EVIDENCE_OUTCOME_PROVENANCE_MISMATCH:${summary.status}:${outcome}`);
  }, ['summary-json']);
  check('certified-stages', () => validateCertifiedStages(root, summary, outcome), ['summary-json']);
  if ([1, 2, 3, 4, 5].includes(summary?.hardening_version) && outcome === 'passed') {
    check('owned-groups', () => { if (summary.gates.some((stage) => stage.ownership?.group_alive_after !== false || !Number.isInteger(stage.owned_process_group))) throw new Error('EVIDENCE_OWNED_GROUP_DRAIN_INVALID'); });
    check('app-ready-binding', () => {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'release-sim-readiness.json'), 'utf8'));
    if (ready.ready !== true || ready.nonce !== summary.release_target?.launch_nonce || ready.pid !== summary.release_target?.live_pid
      || ready.native_receipt?.pid !== ready.pid || ready.native_receipt?.nonce !== ready.nonce
      || ready.native_receipt?.bundle_id !== summary.release_target?.bundleId) throw new Error('EVIDENCE_APP_READY_BINDING_INVALID'); });
    const admissionErrors = require('./gate-host-health.cjs').admissionReceiptErrors;
    if (summary.hardening_version >= 2) check('baseline-hostadmission', () => {
      const errors = admissionErrors(summary.host_health_baseline);
      if (errors.length) throw new Error(`EVIDENCE_BASELINE_ADMISSION_INVALID:${errors.join('; ')}`);
    });
    check('build-hostadmission', () => {
      const health = JSON.parse(fs.readFileSync(path.join(root, 'host-health-build.json'), 'utf8'));
      const errors = admissionErrors(health, { external: summary.hardening_version >= 2 });
      if (errors.length) throw new Error(`EVIDENCE_HOST_ADMISSION_INVALID:${errors.join('; ')}`);
    });
    if (summary.hardening_version >= 3) check('start-hostadmission', () => {
      const health = JSON.parse(fs.readFileSync(path.join(root, 'host-health-start.json'), 'utf8'));
      const errors = admissionErrors(health, { external: true });
      if (errors.length) throw new Error(`EVIDENCE_START_ADMISSION_INVALID:${errors.join('; ')}`);
    });
  }
  if (summary?.hardening_version >= 4 && outcome === 'passed') {
    check('preparation-raw-samples', () => {
      const health = JSON.parse(fs.readFileSync(path.join(root, 'host-health-start.json'), 'utf8'));
      const errors = require('./gate-host-health.cjs').preparationSampleErrors(health, root, { bootStartedMs: summary.owned_boot_started_monotonic_ms });
      if (!Number.isFinite(summary.owned_boot_started_monotonic_ms)) errors.push('original owned boot anchor missing');
      if (errors.length) throw new Error(`EVIDENCE_PREPARATION_SAMPLES_INVALID:${errors.join('; ')}`);
    });
    check('cache-input-receipts', () => {
      const cache = JSON.parse(fs.readFileSync(path.join(root, 'build-cache.json'), 'utf8'));
      const errors = require('./storage-build-cache.cjs').receiptErrors(cache, { requireHeadroom: summary.hardening_version >= 5 });
      if (errors.length) throw new Error(`EVIDENCE_CACHE_INPUTS_INVALID:${errors.join('; ')}`);
    });
  }
  check('scenario-evidence', () => { if (fs.existsSync(path.join(root, 'report-viewer-sim-e2e'))) validateReportViewer(root, files, outcome);
  else if (outcome === 'passed') throw new Error('EVIDENCE_CASE_MANIFEST_MISSING'); });
  if (phase === 'final') check('cleanup', () => {
    const cleanup = JSON.parse(fs.readFileSync(path.join(root, 'cleanup.json'), 'utf8'));
    if (JSON.stringify(Object.keys(cleanup).sort()) !== JSON.stringify(['completed_at', 'indirections_removed', 'queue_released', 'run_id', 'schema', 'scratch_discarded', 'simulator_deleted', 'status'].sort()) || cleanup.schema !== 1 || cleanup.run_id !== runId || cleanup.status !== 'passed' || cleanup.scratch_discarded !== true || cleanup.simulator_deleted !== true || cleanup.indirections_removed !== true || cleanup.queue_released !== true || !Number.isFinite(Date.parse(cleanup.completed_at))) throw new Error('EVIDENCE_CLEANUP_INVALID');
  });
  requireChecks(checks);
  Object.defineProperty(files, 'checks', { value: checks, enumerable: false });
  return files;
}

function validateCertifiedStages(root, summary, outcome = 'passed') {
  // This list and stageFiles above are the wrapper's OWN copy of the certified gate's stage sequence, and
  // they are allowed to be a copy - but never to disagree with it. release-sim-reset was added to
  // full-gate.cjs by Lead 1 and neither copy learned, so a fully green twelve-stage run would have thrown
  // EVIDENCE_STAGE_ORDER here and EVIDENCE_UNKNOWN_FILE above, at the seal, after a 25-40 minute run. It
  // stayed invisible because the gate had never reached the seal. Drift is now caught at test time by
  // 'wrapper stage lists stay derived-equal to the certified gate call sites', which reads the runGate
  // sites out of full-gate.cjs rather than trusting either copy.
  // A failed stage is intentionally absent from summary.gates: full-gate.cjs writes its companion JSON
  // and log, then runGate throws before main can push the returned entry. Failed summaries therefore
  // contain only the completed zero-status prefix; enumerateEvidence preserves the N+1th file pair.
  const stages = ['focused-jest', 'serial-jest', 'typecheck', 'ios-export', 'release-sim-bootstatus', 'release-sim-build', 'release-sim-reset', 'release-sim-install', 'release-sim-launch', 'release-sim-settle', 'release-sim-liveness', 'sim-e2e'];
  const names = summary.gates.map((entry) => entry?.name);
  const batchedFailure = summary.hardening_version >= 3 && outcome === 'failed';
  const orderedSubset = names.every((name, index) => stages.includes(name) && (index === 0 || stages.indexOf(names[index - 1]) < stages.indexOf(name)));
  if (outcome === 'passed' ? JSON.stringify(names) !== JSON.stringify(stages) : batchedFailure ? !orderedSubset : JSON.stringify(names) !== JSON.stringify(stages.slice(0, names.length))) throw new Error('EVIDENCE_STAGE_ORDER');
  if (summary.hardening_version >= 3) {
    const expected = ['scenario-configuration', 'hostadmission-and-signal', ...stages];
    if (!Array.isArray(summary.checks) || JSON.stringify(summary.checks.map((row) => row.name)) !== JSON.stringify(expected)) throw new Error('EVIDENCE_CHECK_INVENTORY_INVALID');
    for (const row of summary.checks) {
      if (!['passed', 'failed', 'unreachable'].includes(row.status) || !Array.isArray(row.dependencies)
          || (row.status === 'unreachable' ? row.dependencies.length === 0 : row.dependencies.length !== 0)
          || (outcome === 'passed' && row.status !== 'passed')) throw new Error('EVIDENCE_CHECK_STATUS_INVALID');
      if (stages.includes(row.name) && row.status !== 'unreachable') {
        const stage = JSON.parse(fs.readFileSync(path.join(root, `${row.name}.json`), 'utf8'));
        if (!Number.isInteger(stage.status) || (stage.status === 0) !== (row.status === 'passed')) throw new Error('EVIDENCE_CHECK_COMPANION_INVALID');
      }
      if (stages.includes(row.name) && row.status === 'unreachable' && fs.existsSync(path.join(root, `${row.name}.json`))) throw new Error('EVIDENCE_CHECK_UNREACHABLE_HAS_RECEIPT');
      if (names.includes(row.name) && row.status !== 'passed') throw new Error('EVIDENCE_CHECK_SUMMARY_MISMATCH');
    }
  }
  for (const [index, gate] of summary.gates.entries()) {
    const stageName = batchedFailure ? gate.name : stages[index];
    if (!gate || gate.status !== 0 || gate.log !== `${stageName}.log` || typeof gate.command !== 'string' || !Date.parse(gate.started_at) || !Date.parse(gate.finished_at) || Date.parse(gate.started_at) > Date.parse(gate.finished_at)) throw new Error('EVIDENCE_STAGE_FIELDS');
    const companion = JSON.parse(fs.readFileSync(path.join(root, `${stageName}.json`), 'utf8'));
    for (const field of ['name', 'command', 'status', 'started_at', 'finished_at', 'log']) if (companion[field] !== gate[field]) throw new Error('EVIDENCE_STAGE_COMPANION');
    const log = fs.lstatSync(path.join(root, gate.log));
    if (!log.isFile() || log.isSymbolicLink()) throw new Error('EVIDENCE_STAGE_LOG');
  }
  const native = JSON.parse(fs.readFileSync(path.join(root, 'native-root.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(native.candidate_sha) || !/^[0-9a-f]{40}$/.test(native.derived_sha) || native.parent_sha !== native.candidate_sha || !Array.isArray(native.derived_paths)) throw new Error('EVIDENCE_NATIVE_ROOT');
}

// `outcome` defaults to 'passed' so every existing strict caller keeps its exact behaviour.
//
// LAYER 8: this used to demand manifest.status === 'passed' AND exactly 9 cases whenever the directory
// merely EXISTED - including for a FAILED run, which by definition cannot satisfy either. The consequence
// was not one bad run: NO failed run could ever seal. Every failure landed blocked_unclassified with a
// classification_error describing the MANIFEST instead of the real cause, permanently destroying failure
// diagnosability - the property this program ranks highest. validateCertifiedStages was already
// failure-aware and compares a PREFIX for a failed run; this is now symmetric with it. Nothing is
// weakened on the passed path: strict still means 9 cases, single attempt, manifest passed. On a failed
// run every case that IS present is still fully validated - plan position, digests, video binding,
// sidecars, unknown-file rejection - because a partial run's evidence must still be trustworthy.
function validateReportViewer(root, files, outcome = 'passed') {
  const runs = path.join(root, 'report-viewer-sim-e2e');
  const manifestFile = path.join(runs, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const strict = outcome === 'passed';
  if (manifest.attempts_per_case !== 1 || !Array.isArray(manifest.cases)) throw new Error('EVIDENCE_CASE_MANIFEST_INVALID');
  if (strict && (manifest.status !== 'passed' || manifest.cases.length !== 9)) throw new Error('EVIDENCE_CASE_MANIFEST_INVALID');
  if (!strict && manifest.cases.length > 9) throw new Error('EVIDENCE_CASE_MANIFEST_INVALID');
  // A failed run may have died BEFORE the recorder preflight ran at all - measured at run example-13, where
  // recorder_preflight was null and cases was 0. Requiring it there would re-create exactly the layer-8
  // trap one field over.
  if (strict && (manifest.recorder_preflight?.setup_verdict !== 'PASS' || !['clear', 'remediated'].includes(manifest.recorder_preflight?.outcome))) throw new Error('EVIDENCE_RECORDER_PREFLIGHT_INVALID');
  if (!strict && manifest.recorder_preflight != null && manifest.recorder_preflight.setup_verdict !== undefined && typeof manifest.recorder_preflight.setup_verdict !== 'string') throw new Error('EVIDENCE_RECORDER_PREFLIGHT_INVALID');
  const results = new Set();
  const videos = new Set();
  const allowed = new Set(['report-viewer-sim-e2e/manifest.json']);
  const indexed = new Map(files.map((entry) => [entry.relative, entry]));
  const plan = REPORT_VIEWER_CASE_PLAN;
  for (const [caseIndex, item] of manifest.cases.entries()) {
    const expectedCase = plan[caseIndex];
    if (item.scenario !== expectedCase[0] || (item.sentinel || null) !== expectedCase[1] || item.expected !== expectedCase[2]) throw new Error('EVIDENCE_CASE_PLAN');
    if (typeof item.scenario !== 'string' || typeof item.run_id !== 'string' || !['PASS', 'FAIL'].includes(item.expected)) throw new Error('EVIDENCE_CASE_SCHEMA_INVALID');
    if (results.has(item.result) || !/^[A-Za-z0-9_.-]+\.json$/.test(item.result)) throw new Error('EVIDENCE_CASE_RESULT_IDENTITY');
    results.add(item.result);
    const resultRelative = `report-viewer-sim-e2e/${item.result}`;
    allowed.add(resultRelative);
    const resultEntry = indexed.get(resultRelative);
    if (!resultEntry || resultEntry.sha256 !== item.sha256) throw new Error('EVIDENCE_CASE_RESULT_DIGEST');
    const payload = JSON.parse(fs.readFileSync(path.join(runs, item.result), 'utf8'));
    if (payload.scenario !== item.scenario || (item.expected === 'PASS' ? item.status !== 0 || payload.verdict !== 'PASS' : item.status !== 1)) throw new Error('EVIDENCE_CASE_VERDICT');
    const video = payload.artifacts?.video;
    const capture = payload.extras?.screen_capture;
    if (typeof video !== 'string' || videos.has(video) || !/^[A-Za-z0-9_.-]+\.mp4$/.test(video)) throw new Error('EVIDENCE_CASE_VIDEO_IDENTITY');
    videos.add(video);
    const videoEntry = indexed.get(`report-viewer-sim-e2e/${video}`);
    allowed.add(`report-viewer-sim-e2e/${video}`);
    if (!videoEntry || videoEntry.size <= 0 || !/^[0-9a-f]{64}$/.test(videoEntry.sha256)) throw new Error('EVIDENCE_CASE_VIDEO_DIGEST');
    if (capture?.video_ready !== true || capture.video_returncode !== 0 || capture.video_finalized !== true || capture.video_forced_kill !== false || capture.video_alive_after_teardown !== false) throw new Error('EVIDENCE_CASE_VIDEO_RECORDER');
    const started = Number(capture.video_started_at) * 1000;
    const finished = Number(capture.video_finished_at) * 1000;
    if (!Number.isFinite(started) || !Number.isFinite(finished) || started > finished || videoEntry.mtime_ms < started - 2000 || videoEntry.mtime_ms > finished + 2000) throw new Error('EVIDENCE_CASE_VIDEO_TIME_BINDING');
    const teardown = payload.owned_session_teardown_sidecar;
    if (teardown !== undefined && teardown !== null) {
      if (typeof teardown !== 'string' || path.basename(teardown) !== teardown
        || teardown !== item.result.replace(/\.json$/, '.teardown.json')) throw new Error('EVIDENCE_CASE_TEARDOWN_IDENTITY');
      const relative = `report-viewer-sim-e2e/${teardown}`;
      if (!indexed.has(relative)) throw new Error('EVIDENCE_CASE_TEARDOWN_MISSING');
      let proof;
      try { proof = JSON.parse(fs.readFileSync(path.join(runs, teardown), 'utf8')); }
      catch { throw new Error('EVIDENCE_CASE_TEARDOWN_INVALID'); }
      if (!proof || Object.keys(proof).sort().join(',') !== 'attempted,closed,closed_count,orphan_count,orphans'
        || !Number.isSafeInteger(proof.attempted) || proof.attempted < 0
        || !Array.isArray(proof.closed) || !proof.closed.every((id) => typeof id === 'string' && id.length > 0)
        || new Set(proof.closed).size !== proof.closed.length || proof.closed_count !== proof.closed.length
        || !Array.isArray(proof.orphans) || proof.orphan_count !== 0 || proof.orphans.length !== 0
        || proof.attempted !== proof.closed_count + proof.orphan_count) throw new Error('EVIDENCE_CASE_TEARDOWN_INVALID');
      allowed.add(relative);
    }
    for (const sidecar of [payload.raw_log_sidecar, payload.ui_trace_sidecar, ...(payload.artifacts?.screenshots || []), payload.extras?.mock_chat_streamd?.log_path, payload.extras?.wire_contract?.log_path].filter(Boolean)) {
      // Two UNRELATED causes, two names, each carrying the offending value. They were ONE name until
      // 2026-07-22, which made triage actively misleading: a screenshot label containing a separator and a
      // capture that never landed reported identically, so a stated rule of "read the error name" sent you
      // hunting the wrong end of the chain. Same conditions, same fail-closed behaviour - only the
      // diagnosis is split. NAME_INVALID means the DECLARATION is malformed - nothing wrong with the
      // capture; MISSING means a well-formed declaration whose file is absent, the failed-capture
      // direction. With UNKNOWN_NESTED_FILE for present-but-undeclared, the sidecar chain now has three
      // mutually exclusive self-diagnosing outcomes and triage by NAME alone is sufficient.
      // NOTE the basename equality is a PATH-TRAVERSAL guard, not cosmetics: it is what stops a declared
      // sidecar escaping the evidence directory. Do not relax it into a warning.
      if (typeof sidecar !== 'string' || path.basename(sidecar) !== sidecar) throw new Error(`EVIDENCE_CASE_SIDECAR_NAME_INVALID:${sidecar}`);
      if (!indexed.has(`report-viewer-sim-e2e/${sidecar}`)) throw new Error(`EVIDENCE_CASE_SIDECAR_MISSING:${sidecar}`);
      allowed.add(`report-viewer-sim-e2e/${sidecar}`);
    }
  }
  for (const entry of files.filter((item) => item.relative.startsWith('report-viewer-sim-e2e/'))) if (!allowed.has(entry.relative)) throw new Error(`EVIDENCE_UNKNOWN_NESTED_FILE:${entry.relative}`);
}

function writeManifest(root, runId, outcome, files) {
  const target = path.join(root, 'manifest-v1.json');
  if (fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (existing.schema !== 1 || existing.run_id !== runId || existing.outcome !== outcome || JSON.stringify(existing.files) !== JSON.stringify(files)) throw new Error('EVIDENCE_MANIFEST_COLLISION');
    return crypto.createHash('sha256').update(JSON.stringify(existing)).digest('hex');
  }
  const value = { schema: 1, run_id: runId, outcome, generated_at: new Date().toISOString(), files };
  atomicJson(target, value);
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function preliminaryEvidenceDigest(root, runId, gateStatus = readRecord('runs', runId).gate_status) {
  const files = validateEvidence(root, runId, 'pre-cleanup', gateStatus).filter((entry) => !['cleanup.json', 'manifest-v1.json'].includes(entry.relative));
  return crypto.createHash('sha256').update(JSON.stringify({ schema: 1, run_id: runId, files })).digest('hex');
}

function verifyPreliminaryEvidence(run) {
  const resolved = resolveMounted('evidence', run.id);
  require('./storage-containers.cjs').requireSeal(resolved.seal, run.evidence_seal);
  requireEvidenceProvenance(resolved.mount, run);
  if (preliminaryEvidenceDigest(resolved.mount, run.id) !== run.preliminary_evidence_digest) throw new Error('EVIDENCE_PRELIMINARY_DIGEST_DRIFT');
  return true;
}

function finalizeScratchDiscard(runId, now = Date.now()) {
  let run = readRecord('runs', runId);
  if (run.state !== 'scratch_discarding' || !run.published_at || !Number.isInteger(run.gate_status)) throw new Error('EVIDENCE_FINALIZE_STATE');
  if (fs.existsSync(imagePath('scratch', runId))) throw new Error('EVIDENCE_SCRATCH_STILL_PRESENT');
  verifyPreliminaryEvidence(run);
  const resolved = resolveMounted('evidence', runId);
  const cleanup = path.join(resolved.mount, 'cleanup.json');
  if (!fs.existsSync(cleanup)) atomicJson(cleanup, { schema: 1, run_id: runId, status: 'passed', simulator_deleted: true, indirections_removed: true, queue_released: true, scratch_discarded: true, completed_at: new Date(now).toISOString() });
  const files = validateEvidence(resolved.mount, runId, 'final', run.gate_status).filter((entry) => entry.relative !== 'manifest-v1.json');
  const digest = writeManifest(resolved.mount, runId, run.gate_status === 0 ? 'passed' : 'failed', files);
  run = transitionRun(runId, run.revision, 'scratch_discarded', { evidence_digest: digest, scratch_discarded_at: new Date(now).toISOString() });
  return run;
}

// Seal the evidence of a run that will NEVER be published, so its disposition has something to verify.
//
// It deliberately does NOT call validateEvidence. That function asserts a COMPLETE gate result -
// run.json, native-root.json and the rest are REQUIRED (:280) - and this class by definition never
// produced one: a run that died in `allocated` may have written nothing at all. Demanding gate shape
// here would refuse to seal exactly the images that need sealing, so the manifest records WHAT IS
// THERE rather than asserting what ought to be.
//
// WHAT THIS DOES AND DOES NOT PROVE, stated because the distinction is the whole honesty of the
// disposition authority. On the published path, evidence_digest is computed at scratch-discard time and
// verified at evidence-discard time, so the check spans the retention window and proves the evidence
// was not altered while it was being kept. Here there is no earlier honest moment to seal from - the
// evidence was never audited - so this digest proves only that nothing changed between the operator's
// AUTHORISATION and the DESTRUCTION. That window is narrow but real, and it is a genuine check, not a
// ceremony: a concurrent modification between the two phases fails the disposal closed. What it is NOT
// is evidence that the contents were ever valid, and no caller may read it that way.
//
// `failed` is the honest outcome, not a default: gate_status is absent for this whole class (it is only
// set from `sealing` onward), so the outcome cannot be derived from it, and a run that died before
// reaching `sealing` did not pass. Idempotent - writeManifest returns the existing digest when the
// manifest already matches, and throws EVIDENCE_MANIFEST_COLLISION when it does not.
function sealUnclassifiedEvidence(runId) {
  const resolved = resolveMounted('evidence', runId);
  const files = enumerateEvidence(resolved.mount).filter((entry) => entry.relative !== 'manifest-v1.json');
  return writeManifest(resolved.mount, runId, 'failed', files);
}

function discardPublishedScratch(runId, now = Date.now()) {
  validateInstalledAuthority();
  let run = readRecord('runs', runId);
  if (run.state !== 'published') throw new Error('SCRATCH_DISCARD_NOT_AUTHORIZED');
  verifyPreliminaryEvidence(run);
  run = transitionRun(runId, run.revision, 'scratch_discarding', { scratch_discard_started_at: new Date(now).toISOString() });
  detachAndDiscard('scratch', runId, run.scratch_seal);
  return finalizeScratchDiscard(runId, now);
}

function verifyRetainedEvidence(run, recoveryRoot = null) {
  let root;
  if (recoveryRoot === null) {
    const resolved = resolveMounted('evidence', run.id);
    require('./storage-containers.cjs').requireSeal(resolved.seal, run.evidence_seal);
    root = resolved.mount;
  } else {
    if (path.resolve(recoveryRoot) !== containers.mountPath('evidence')) throw new Error('EVIDENCE_RECOVERY_ROOT');
    root = recoveryRoot;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest-v1.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.run_id !== run.id || !['passed', 'failed'].includes(manifest.outcome) || crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !== run.evidence_digest || !Array.isArray(manifest.files)) throw new Error('EVIDENCE_RETAINED_MANIFEST');
  const current = enumerateEvidence(root).filter((entry) => entry.relative !== 'manifest-v1.json');
  // The recovery contract exists specifically because the container marker can be unusable after the
  // journal authorised deletion. Its original bytes remain committed inside the journal-bound manifest,
  // but recovery compares the retained evidence payload without that control file. Every other byte stays
  // exact, so bypassing a broken marker does not bypass evidence-drift detection.
  const comparable = (entries) => recoveryRoot === null ? entries : entries.filter((entry) => entry.relative !== '.pentacle-container.json');
  if (JSON.stringify(comparable(current)) !== JSON.stringify(comparable(manifest.files))) throw new Error('EVIDENCE_RETAINED_DIGEST_DRIFT');
  // manifest.outcome, NOT the strict default. This line took the default while the very next line was
  // already outcome-aware, so the reclamation path judged a failed run by passed-run rules and threw
  // EVIDENCE_CASE_MANIFEST_INVALID. storage-janitor.cjs:99 gates the evidence DISCARD on this, so failed-run
  // evidence images could never be reclaimed - a resource created and never released, with no failure
  // raised, INSIDE the reclamation path itself. That is this lane's founding defect reappearing in the code
  // written to prevent it, and silently: janitor failures are unobservable by design.
  //
  // It was DEAD CODE until layer 8 made failed runs sealable. Before that no valid failed evidence could
  // exist to retain or discard, so nothing could reach here. Animating a dead path makes the WHOLE path new
  // code, and every consumer of it has to be re-read as though just written - because functionally it was.
  // Three call sites were made outcome-aware and this fourth, the one the janitor runs, was not.
  // Disposition seals WHAT EXISTS; it does not certify that a gate completed or that a partial stage tree
  // is semantically valid (see sealUnclassifiedEvidence). Requiring report-viewer completeness here would
  // make an interrupted/unclassified tree sealable but impossible to dispose. The byte-for-byte manifest,
  // image seal, and journal disposition remain mandatory above. Ordinary retained evidence keeps the full
  // semantic check, so disposition cannot weaken the published retention path.
  if (run.unclassified_disposed_at === undefined) {
    requireEvidenceProvenance(root, run);
    if (fs.existsSync(path.join(root, 'report-viewer-sim-e2e'))) validateReportViewer(root, current, manifest.outcome);
    else if (manifest.outcome === 'passed') throw new Error('EVIDENCE_CASE_MANIFEST_MISSING');
  }
  return true;
}

// The simulator queue serializes the host's single simulator, so its state must stay
// HOST-GLOBAL. Mirror sim-queue's own queue_root() resolution here, in the wrapper's
// real-HOME environment, and pin the child to it: the child's HOME/XDG are redirected
// into the scratch image, which would otherwise resolve to an empty private queue and
// break both the inherited-ticket check and host-wide serialization.
function hostSimQueueRoot() {
  if (process.env.SIM_QUEUE_ROOT) return process.env.SIM_QUEUE_ROOT;
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'sim-queue');
  return path.join(require('node:os').homedir(), '.local', 'share', 'sim-queue');
}

function acquireSimulatorQueue(runId) {
  const guard = new (require('./sim-resource-guard.cjs').SimulatorResourceGuard)({ label: `storage-${runId}` });
  const ticket = guard.enter();
  if (!ticket) throw new Error('SIM_QUEUE_TICKET_MISSING');
  return { guard, ticket };
}

function releaseSimulatorQueue(queue) { queue.guard.close(); }

// The scenario harness's env file is HOST CONFIG, not per-run state, so it is PIN-TO-HOST. Resolved in
// the wrapper's REAL home before the redirect, exactly as hostSimQueueRoot is: run_scenario.py defaults
// --env-file to Path.home()/'.pentacle-test.env', and the container redirects the child's HOME into
// scratch, so the child looked for it at <scratch>/home and every scenario died SETUP_FAIL before it
// touched the app (measured, run example-14, case report_viewer_horizontal_scroll).
//
// This needs NO certified edit and NO containment change, which is why it is one line rather than a
// design call. report-viewer-sim-e2e.cjs already forwards this exact variable as --env-file behind an
// if-set guard - a hook certified code purpose-built for this and the wrapper simply never set. And the
// child reads the REAL file rather than a copy because the sandbox profile already carries a blanket
// (allow file-read*); only writes are capped. So unlike SIM_QUEUE_ROOT, which needed a host-global WRITE
// exemption to go with it, this pin costs nothing.
//
// Checked for existence HERE, in the pre-flight region, and not left to fail inside the scenario: absent,
// it costs a seventeen-minute run to discover something a stat answers now.
function hostScenarioEnvFile() {
  const target = process.env.PENTACLE_GATE_SIM_E2E_ENV_FILE || path.join(require('node:os').homedir(), '.pentacle-test.env');
  if (!fs.existsSync(target)) throw new Error(`GATE_SCENARIO_ENV_FILE_MISSING:${target}`);
  return target;
}

function resolveDeviceSet(runId) {
  const run = readRecord('runs', runId);
  const scratch = resolveMounted('scratch', runId);
  require('./storage-containers.cjs').requireSeal(scratch.seal, run.scratch_seal);
  const expected = require('./storage-state.cjs').canonicalIdentity(scratchDeviceSetRoot(scratch.mount));
  for (const key of ['canonical', 'device', 'inode', 'uid', 'mode']) if (expected[key] !== run.device_set_identity[key]) throw new Error('SIMULATOR_DEVICE_SET_DRIFT');
  // Return the device set itself. It is a REAL DIRECTORY inside the child's own home, so the path
  // the wrapper hands simctl --set is byte-identical to the PentacleCoreSimulator constant the child
  // derives from its own os.homedir(), and both operate on one set. canonicalIdentity above has
  // already refused a symlink, an alias, or any device/inode/uid/mode drift against the identity
  // sealed at allocation. Because nothing is traversed at use time there is no proof-then-use
  // window: the previous real-home symlink indirection is no longer on this path.
  return expected.canonical;
}

// LAYER 14. idb enumerates ONLY the DEFAULT CoreSimulator device set, and this gate creates its
// simulator in a PRIVATE set inside its scratch by design. Two correct decisions that are structurally
// incompatible: the client resolves the target BEFORE it ever touches a socket, so it refuses with
// "Cannot spawn companion for <udid>, no matching target in available udids" and no amount of write
// permission helps. Measured with a control - a device in a custom set is absent from `idb list-targets`
// (count 0) and describe-all against it returns rc=1 naming the available-udids dict.
//
// Same answer as every other layer: perform the operation where the VISIBILITY legitimately lives. The
// wrapper runs outside the sandbox and can see the private set, so it spawns the companion itself with
// --device-set-path and hands the child a direct address, bypassing target resolution entirely.
// `IDB_COMPANION` is idb's own documented env var for exactly this (`--companion` defaults to it), and
// idb parses a colon-free value as a DOMAIN SOCKET path (cli/__init__.py `_parse_address`), so no port
// and no network listener is involved.
//
// Measured end to end against a real PRIVATE-set device: with IDB_COMPANION set, in-container
// describe-all returns rc=0 and a real accessibility tree; WITHOUT it, the identical command under the
// identical profile returns rc=1 with the resolution error. No certified byte moves - the certified
// scenario still runs plain `idb ui describe-all --udid <udid>` and simply inherits the variable - and
// NO new sandbox grant is needed. Layer 13's /private/tmp/idb write exemption remains a PRECONDITION,
// not an alternative: connecting to a unix socket requires write permission on it, and the socket lives
// there. Do not "simplify" that exemption away.
//
// NOT detached. `detached: true` buys exactly one property - survival across wrapper exit - and that is
// precisely the property we must not have: this lane's founding defect is a persistent host surface
// outliving its run. stopIdbCompanion below is a CATCHABLE-path cleanup step, so on SIGKILL, panic or
// OOM it never runs; a detached companion would then be outside the wrapper's process group and the
// supervisor's group-kill could not reap it either, leaving an idb_companion holding a socket in
// /private/tmp/idb forever. Staying in the group means the uncatchable path is covered by the group-kill
// that already exists. `unref()` is kept and is orthogonal: it stops the child handle holding the
// wrapper's event loop open, without removing it from the group.
// The socket EXISTING and idb's client still TREATING it as a socket are DIFFERENT PROPOSITIONS, and only
// the second is what this fix rests on. `IDB_COMPANION` is genuinely documented (cli/main.py reads it and
// names it), but its help text describes the value as HOSTNAME:PORT - the colon-free domain-socket form is
// a deliberate TYPED BRANCH (`_parse_address` returns a first-class DomainSocketAddress) that the help
// does not mention. Intentional API behaviour, undocumented, so an idb upgrade could remove it without
// touching anything that looks load-bearing, and it would surface at minute seventeen inside case one.
//
// So prove the parse, not the file. One companion-REQUIRING command, run OUTSIDE the sandbox where a
// failure is unambiguous, before the child is ever launched. `describe` is chosen because it is the
// cheapest such command that works while the device is still SHUTDOWN, which is when this runs: measured,
// `idb describe --udid <udid>` returns rc=0 against a shutdown private-set device, while `list-apps`
// fails with "Unable to lookup in current state: Shutdown" and would be a false alarm. The negative
// control is equally measured - against a socket with no listener the same command fails with
// "Failed to connect to companion at address DomainSocketAddress(path=...)", which proves in one line
// that the variable is honoured, that it is parsed as a DOMAIN SOCKET, and that the socket must be live.
function requireIdbCompanionUsable(companion, udid) {
  const probe = spawnSync(IDB_BINARY, ['describe', '--udid', udid], {
    encoding: 'utf8',
    env: { ...process.env, IDB_COMPANION: companion.socket },
  });
  if (probe.status !== 0) {
    stopIdbCompanion(companion);
    throw new Error(`GATE_IDB_COMPANION_UNUSABLE:${probe.status}:${String(probe.stderr || probe.stdout || '').trim().slice(0, 200)}`);
  }
  return companion;
}

function idbCompanionSocket(udid) { return path.join(idbRoot(), `${udid}_companion.sock`); }


// LAYER 15. The companion must be spawned on the RIGHT SIDE OF BOOT. Measured with a control: a companion
// spawned while the device is still SHUTDOWN answers describe-all rc=0 but with a DEGENERATE 273-byte
// tree, while one spawned after the device is Booted returns 5837 bytes of real tree - so a pre-boot
// companion is not merely early, it is silently WRONG, which is the worst failure shape this lane has.
//
// The wrapper has no mid-child callback, so this is a concurrent WATCHER: it polls the private device set
// for Booted and spawns exactly once, at the right moment, entirely wrapper-side. No certified edit and
// no new grant.
//
// It does NOT spawn a throwaway companion first and replace it. Killing a pre-boot companion and
// respawning at the same socket path was measured safe (full tree afterwards, nothing wedged), but a
// pre-boot companion buys nothing and every moment it exists is a moment describe-all could be answered
// from the degenerate tree. Not spawning until Booted is strictly simpler and strictly safer.
//
// IDB_COMPANION is handed to the child up front pointing at a socket that does not exist yet. That is
// correct rather than racy: the client resolves the address per invocation, and the first invocation is
// in sim-e2e, many minutes after boot. If the device never boots the socket never appears and the client
// fails loudly at connect - the failure is reported here too, so a watcher that never fired is visible
// rather than silent (R8).
function startIdbCompanionWatcher(udid, deviceSet) {
  const state = { companion: null, failure: null, timer: null, booted: false };
  const booted = () => {
    const listed = spawnSync('/usr/bin/xcrun', ['simctl', '--set', deviceSet, 'list', 'devices', '--json'], { encoding: 'utf8' });
    if (listed.status !== 0) return false;
    try {
      const devices = JSON.parse(listed.stdout || '{}').devices || {};
      return Object.values(devices).flat().some((device) => device && device.udid === udid && device.state === 'Booted');
    } catch { return false; }
  };
  state.timer = setInterval(() => {
    if (state.companion || state.failure) return;
    let ready = false;
    try { ready = booted(); } catch (error) { state.failure = `probe:${String(error.message || error)}`; }
    if (!ready) return;
    state.booted = true;
    try { state.companion = spawnIdbCompanion(udid, deviceSet, (owner) => { state.companion = owner; }); }
    catch (error) { state.failure = String(error.message || error); }
    // LAYER 16 DELIBERATELY DOES **NOT** RIDE THIS EDGE, and the empty space is the point. Launching the
    // Simulator surface here was MEASURED at run example-01 and took the diagnostic from 7/9 to 0/9: the
    // harness has a GUI preflight (`test/e2e/harness/simulator.py:1604`) that fails ANY scenario while a
    // Simulator.app is running, and its exemption at :1590 admits exactly one owned surface and ONLY for
    // `report_viewer_comments_keyboard`, keyed on the ownership env triple that `withSoftwareKeyboard`
    // sets per case. A surface alive for the whole run is therefore correct for case 9 and fatal for the
    // other eight. The surface's lifetime has to match the keyboard case, not the run, and the wrapper
    // has no mid-child callback that marks that window - so the trigger is an open design question, not
    // an oversight. The case-result trigger below launches only after case 8 has written its result.
    clearInterval(state.timer);
    state.timer = null;
  }, IDB_COMPANION_POLL_MS);
  // The wrapper must never be held open by this timer: it exists only for the duration of the child.
  state.timer.unref();
  return state;
}

function stopIdbCompanionWatcher(state) {
  if (!state) return;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  stopIdbCompanion(state.companion);
  // Reported on every run, including when it never fired, because a watcher that silently did nothing is
  // exactly how a degenerate tree would come back undetected.
  const detail = state.failure ? `failed=${state.failure}` : state.companion ? `spawned pid=${state.companion.pid}` : `never-fired booted=${state.booted}`;
  process.stderr.write(`[storage-gate] idb companion watcher: ${detail}\n`);
}

function spawnIdbCompanion(udid, deviceSet, onCreated = () => undefined) {
  const socket = idbCompanionSocket(udid);
  const child = require('node:child_process').spawn(
    IDB_COMPANION_BINARY,
    ['--udid', udid, '--device-set-path', deviceSet, '--grpc-domain-sock', socket],
    { detached: false, stdio: 'ignore' },
  );
  child.unref();
  const owner = { pid: child.pid, socket };
  onCreated(owner);
  // The companion binds its socket asynchronously. Wait for the socket to EXIST rather than sleeping a
  // fixed interval, and fail closed with the pid if it never appears - a silently absent companion would
  // otherwise surface much later as the same resolution error this exists to remove.
  const deadline = Date.now() + IDB_COMPANION_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(socket)) return requireIdbCompanionUsable({ pid: child.pid, socket }, udid);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`GATE_IDB_COMPANION_UNREADY:${child.pid}`);
}

function stopIdbCompanion(companion) {
  if (!companion || !Number.isInteger(companion.pid)) return;
  try { process.kill(companion.pid, 'SIGTERM'); } catch { /* already gone is the desired end state */ }
}

// LAYER 16. The comments case needs a Simulator SURFACE bound to the gate's device - it is what makes the
// software keyboard appear once ConnectHardwareKeyboard is false. The certified code launches one itself
// with `open -g -a Simulator`, and LaunchServices app launch is DENIED inside the sandbox (-54), so that
// launch can never succeed there. The wrapper performs it outside the sandbox, where the authority
// already lives, and the certified code ADOPTS a surface bound to its exact UDID instead of refusing it.
//
// `-DeviceSetPath` IS LOAD-BEARING AND MUST NOT BE "SIMPLIFIED" AWAY. Measured 2026-07-22 with a control:
// WITHOUT it, `open -g -a Simulator --args -CurrentDeviceUDID <private-set-udid>` returns rc=0 and the
// resulting process carries the exact `-CurrentDeviceUDID` pair that the certified guard checks, while
// the named device stays Shutdown and Simulator attaches to a DIFFERENT default-set device (measured:
// default_set_booted 0 -> 1). That is a surface which satisfies the ownership guard BY ARGV while driving
// the wrong simulator - the same class as layer 14, and the reason argv is never treated as an attachment
// proof. WITH it, the named private-set device attaches and no default-set device is touched.
//
// The readiness check applies the certified module's OWN `commandHasExactArgumentPair` rather than a
// local copy, so the wrapper cannot come to disagree with the guard it is satisfying (R6).
function launchSimulatorSurface(udid, deviceSet) {
  const { commandHasExactArgumentPair } = require('./report-viewer-sim-e2e.cjs');
  const preflight = spawnSync('/usr/bin/pgrep', ['-x', 'Simulator'], { encoding: 'utf8' });
  if (preflight.status === 0) throw new Error(`GATE_SIMULATOR_SURFACE_PREEXISTING:${String(preflight.stdout || '').trim()}`);
  if (preflight.status !== 1) throw new Error(`GATE_SIMULATOR_SURFACE_PREFLIGHT:${preflight.status}`);
  const opened = spawnSync('/usr/bin/open', ['-g', '-a', 'Simulator', '--args', '-DeviceSetPath', deviceSet, '-CurrentDeviceUDID', udid], { encoding: 'utf8' });
  if (opened.status !== 0) {
    const failed = new Error(`GATE_SIMULATOR_SURFACE_LAUNCH:${opened.status}:${String(opened.stderr || opened.error || '').trim().slice(0, 200)}`);
    const appeared = spawnSync('/usr/bin/pgrep', ['-x', 'Simulator'], { encoding: 'utf8' });
    if (appeared.status === 0) {
      const pids = String(appeared.stdout || '').trim().split(/\s+/).filter(Boolean);
      try { failed.surfaces = pids.map((pid) => simulatorSurfaceProcessState(Number(pid))).filter((entry) => entry.alive).map((entry) => ({ pid: entry.pid, start: entry.start })); }
      catch { failed.cleanupUnproven = true; }
    } else if (appeared.status !== 1) failed.cleanupUnproven = true;
    throw failed;
  }
  const launched = { surface: null };
  // Fail closed rather than let the child discover the silence: if no surface appears, the certified code
  // falls through to its own denied `open` and reports the DENIAL, which would read as layer 16 unfixed.
  //
  // `ps` is deliberately UNQUALIFIED. Measured: there is no `/usr/bin/ps` on macOS - it is `/bin/ps` - so
  // an absolute path here (written for symmetry with `/usr/bin/xcrun` and `/usr/bin/open`, both of which
  // DO exist) made spawnSync return `status: null` with empty stdout, the identity check silently answer
  // false, and the launch report UNREADY for a surface that had in fact started correctly. Bare `ps` also
  // matches the certified code's own call style, so both sides resolve the same binary.
  const deadline = Date.now() + SIMULATOR_SURFACE_READY_TIMEOUT_MS;
  let sawIdentityMismatch = false;
  while (Date.now() < deadline) {
    const found = spawnSync('/usr/bin/pgrep', ['-x', 'Simulator'], { encoding: 'utf8' });
    if (found.status !== 0 && found.status !== 1) {
      const unreadable = new Error(`GATE_SIMULATOR_SURFACE_PROBE:${found.status}`);
      unreadable.surface = launched.surface;
      unreadable.cleanupUnproven = !launched.surface;
      throw unreadable;
    }
    const pids = found.status === 0 ? String(found.stdout || '').trim().split(/\s+/).filter(Boolean) : [];
    // More than one is fatal here for the same reason it is fatal in the certified guard: ownership of
    // "the" Simulator surface is not decidable, and guessing is how a run drives someone else's.
    if (pids.length > 1) {
      const ambiguous = new Error(`GATE_SIMULATOR_SURFACE_AMBIGUOUS:${pids.join(',')}`);
      try { ambiguous.surfaces = pids.map((pid) => simulatorSurfaceProcessState(Number(pid))).filter((entry) => entry.alive).map((entry) => ({ pid: entry.pid, start: entry.start })); }
      catch { ambiguous.cleanupUnproven = true; }
      throw ambiguous;
    }
    if (pids.length === 1) {
      // Recorded BEFORE the identity check succeeds. A surface that launched but failed readiness still
      // has to be reapable, and attaching the pid only to the success path is what let one outlive its
      // run: the trigger carried no owned identity, so teardown had nothing it could verify and signal.
      let observed;
      try { observed = simulatorSurfaceProcessState(Number(pids[0])); }
      catch (error) { error.cleanupUnproven = true; throw error; }
      if (observed.alive) launched.surface = { pid: observed.pid, start: observed.start };
      const identity = spawnSync('ps', ['-p', pids[0], '-o', 'command='], { encoding: 'utf8' });
      if (identity.status !== 0) {
        const unreadable = new Error(`GATE_SIMULATOR_SURFACE_IDENTITY_READ:${pids[0]}:${identity.status}`);
        unreadable.surface = launched.surface;
        throw unreadable;
      }
      if (identity.status === 0 && commandHasExactArgumentPair(identity.stdout, '-CurrentDeviceUDID', udid)) {
        if (!launched.surface) continue;
        return launched.surface;
      }
      sawIdentityMismatch = true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const unready = new Error(sawIdentityMismatch ? 'GATE_SIMULATOR_SURFACE_IDENTITY_MISMATCH' : 'GATE_SIMULATOR_SURFACE_UNREADY');
  unready.surface = launched.surface;
  throw unready;
}

// SIGTERM, not the certified code's kill: `open -g -a` reparents Simulator to launchd, so the surface is
// outside this wrapper's process group and the supervisor's group-kill cannot reap it either. That also
// makes this the ONLY reliable teardown. A catchable run verifies start identity, signal delivery and
// observed exit; any uncertainty fails cleanup and prevents sealing. The
// backstop for an uncatchable wrapper death (SIGKILL, panic, OOM) is the next run's substrate reap, which
// already reaps Simulator.app by name and reports its count, so a survivor is bounded to one run.
function simulatorSurfaceProcessState(pid) {
  const observed = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  if (observed.status === 1) return { pid, alive: false };
  if (observed.status !== 0) throw new Error(`GATE_SIMULATOR_SURFACE_IDENTITY_READ:${pid}:${observed.status}`);
  const start = String(observed.stdout || '').trim();
  if (!start) throw new Error(`GATE_SIMULATOR_SURFACE_IDENTITY_EMPTY:${pid}`);
  return { pid, alive: true, start };
}

function stopSimulatorSurfaceTrigger(trigger, evidenceRoot, runId) {
  if (trigger) trigger.stop();
  const surfaces = [...new Map((trigger?.surfaces || []).map((surface) => [surface.pid, surface])).values()];
  const cleanupFailures = [];
  const cleanupOutcomes = [];
  if (trigger?.cleanupUnproven) cleanupFailures.push('GATE_SIMULATOR_SURFACE_CLEANUP_UNPROVEN');
  for (const surface of surfaces) {
    try { cleanupOutcomes.push(terminateOwnedSurface(surface, { processState: simulatorSurfaceProcessState })); }
    catch (error) { cleanupFailures.push(String(error.message || error)); }
  }
  const attempted = trigger?.attempted === true;
  const cleanupStatus = cleanupFailures.length ? 'failed' : surfaces.length ? 'verified' : 'not-required';
  const record = {
    schema: 1,
    run_id: runId,
    status: attempted ? 'fired' : 'skipped',
    reason: !trigger ? 'not-armed' : attempted ? (trigger.failure ? 'launch-failed' : 'case-results-complete') : trigger.probeFailure ? 'artifact-probe-failed' : 'case-results-incomplete',
    observed_results: trigger?.observedResults || 0,
    required_results: trigger?.requiredResults || reportViewerResultsBeforeKeyboard(),
    launch: { status: !attempted ? 'not-attempted' : trigger.failure ? 'failed' : 'launched', error: trigger?.failure || null, pids: surfaces.map((surface) => surface.pid) },
    cleanup: { status: cleanupStatus, error: cleanupFailures.length ? cleanupFailures.join('; ') : null, outcomes: cleanupOutcomes },
    completed_at: new Date().toISOString(),
  };
  atomicJson(path.join(evidenceRoot, 'storage-surface-trigger.json'), record);
  const summary = trigger ? trigger.summary() : 'skipped reason=not-armed';
  process.stderr.write(`[storage-gate] simulator surface trigger: ${summary} cleanup=${cleanupStatus}\n`);
  if (cleanupFailures.length) throw new Error(`GATE_SIMULATOR_SURFACE_CLEANUP_FAILED[${cleanupFailures.join('; ')}]`);
}

// Resolve the HOST's python user site-packages. ASKED OF PYTHON rather than assembled from a version
// string: the path embeds the python minor version, so a hardcoded one survives a python upgrade as a
// silently wrong directory - and a silently wrong PYTHONPATH is indistinguishable from no PYTHONPATH,
// which is a 20-second timeout with no cause. Every failure below is named and fatal for that reason:
// there is no useful run without idb, and a nameless empty value is the exact shape this removes.
function hostUserSitePackages() {
  const resolved = spawnSync('python3', ['-c', 'import site;print(site.getusersitepackages())'], { encoding: 'utf8' });
  if (resolved.status !== 0) {
    throw new Error(`GATE_USER_SITE_UNRESOLVED:${resolved.status}:${String(resolved.stderr || '').trim().slice(0, 200)}`);
  }
  const site = String(resolved.stdout || '').trim();
  if (!site) throw new Error('GATE_USER_SITE_EMPTY');
  if (!fs.existsSync(site)) throw new Error(`GATE_USER_SITE_ABSENT:${site}`);
  // Assert the module is actually THERE, not merely that a directory resolved. If idb ever moves to a
  // venv or a system install this must fail loudly here rather than 37 import errors deep inside a poll.
  if (!fs.existsSync(path.join(site, 'idb'))) throw new Error(`GATE_USER_SITE_NO_IDB:${site}`);
  // Never clobber an inherited PYTHONPATH; prepend, so the host's own entries still resolve.
  const inherited = String(process.env.PYTHONPATH || '').trim();
  return inherited ? `${site}:${inherited}` : site;
}

// onCreated fires the INSTANT the device exists and before the boot that can fail with the device
// already created - the ordering class of the disk-hygiene lane's finding 9, where `attached` was
// raised only after attach returned and cleanup then reasoned about a live resource it believed
// absent. Here the direction is a leak rather than a deletion: a failed boot left a real device in
// the private set that no cleanup step knew to delete, because the udid only ever reached the
// caller through the return value it never got.
function createSimulator(runId, onCreated = () => undefined) {
  const runtimes = JSON.parse(command('/usr/bin/xcrun', ['simctl', '--set', resolveDeviceSet(runId), 'list', 'runtimes', '-j'])).runtimes
    .filter((entry) => entry.isAvailable && String(entry.identifier).includes('iOS')).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  const types = JSON.parse(command('/usr/bin/xcrun', ['simctl', '--set', resolveDeviceSet(runId), 'list', 'devicetypes', '-j'])).devicetypes
    .filter((entry) => /iPhone/.test(entry.name));
  if (!runtimes.length || !types.length) throw new Error('SIMULATOR_RUNTIME_OR_TYPE_MISSING');
  const udid = command('/usr/bin/xcrun', ['simctl', '--set', resolveDeviceSet(runId), 'create', `Pentacle Storage ${runId.slice(0, 8)}`, types[0].identifier, runtimes[0].identifier]);
  onCreated(udid);
  command('/usr/bin/xcrun', ['simctl', '--set', resolveDeviceSet(runId), 'boot', udid]);
  return udid;
}

// ENUMERATED, never a glob. Every name the child leaves at the top level of the per-user Darwin
// temporary directory falls in one of these classes, measured at run example-03 and in a controlled probe
// (10x actool + 10x ibtool against a 25-second idle control of zero new entries):
//   com.apple.CoreSimulator.SimDevice.<device-udid>.Standalone.<uuid> - the ONLY class that survives the
//     child, exactly one per actool/ibtool invocation at 0 KB. It is self-identifying: the device udid
//     sits at a fixed position, so reclamation additionally requires the udid to be one THIS RUN created,
//     and a concurrent Xcode or simulator user's entries can never be touched.
//
// actool-sprite-atlas-scratch-<uuid> and ibtoold-<pid> were deliberately REMOVED from this set. They
// cannot be udid-scoped, so they would have been gated only by new-since-snapshot and uid-owned - both of
// which a concurrent same-uid Xcode build satisfies, meaning we could delete a directory belonging to an
// operator building in Xcode at the same time. By our own measurement those classes leave zero residue,
// so reclaiming them bought nothing and cost a real exposure. One fully-scoped class is strictly stronger
// than three with two unscoped. Do not re-add them.
//
// Adding a class means editing this list AND assertClosedHostTemporaryClasses, so it cannot drift silently.
const HOST_TEMPORARY_SIMDEVICE = 'com.apple.CoreSimulator.SimDevice.';
const HOST_TEMPORARY_PREFIXES = [HOST_TEMPORARY_SIMDEVICE];
// ARBITRARY BACKSTOP, not a measured bound - stated plainly so nobody trusts it as derived. In a healthy
// run this counter never increments at all: the ~20 entries a run creates are all udid-matched and all
// reclaimed, so `unreclaimed` only rises for foreign-udid SimDevice entries created by a concurrent
// simulator user, or for an rmSync that fails outright. Both are zero in a healthy run. The number exists
// to stop pathological concurrent activity from being silently ignored, and nothing about 64 is derived
// from the measured 20. If concurrent-simulator activity on this host is ever characterised, replace it.
const HOST_TEMPORARY_UNRECLAIMED_LIMIT = 64;

function assertClosedHostTemporaryClasses(prefixes) {
  const expected = ['com.apple.CoreSimulator.SimDevice.'];
  if (!Array.isArray(prefixes) || prefixes.length !== expected.length || prefixes.some((value, index) => value !== expected[index])) throw new Error('GATE_HOST_TEMPORARY_CLASS_SET');
  return prefixes;
}

function snapshotHostTemporary() {
  return new Set(fs.readdirSync(hostTemporaryRoot()));
}

// full-gate.cjs names the stage it died on in its own run.json, but that file lives on the evidence image,
// which is detached by the time anyone reads the state record. Lifting the one line out means a failed run
// says WHICH stage failed without anyone having to attach an image to find out. Best-effort by design: a
// run that died before writing run.json still records its own error, just without this detail.
function childStageFailure(evidence) {
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(evidence, 'run.json'), 'utf8'));
    return typeof summary.error === 'string' && summary.error ? summary.error : null;
  } catch { return null; }
}

// The `child=` shape had three call sites written one at a time, each added when the previous one was
// found to have stopped short (R1), and R6 says a list copied by hand drifts. One function, so the fourth
// site cannot be the one that forgets, and every record reads the same whichever path produced it.
function withChildStage(evidence, message) {
  const stage = childStageFailure(evidence);
  return stage ? `${message} child=${stage}` : message;
}

// The write exemption for this directory is admitted ONLY because it is paired with this. The directory is
// general-purpose host scratch with a demonstrated unbounded-accumulation history (QA measured 9,024 dirs /
// 567 MB over six days), so a per-run number alone would not bound it. Delete only what is new since the
// snapshot, owned by us, in the one enumerated class, AND created for one of this run's own devices. Every
// conjunct is required: uid-owned alone does not distinguish us from an operator building in Xcode under
// the same uid, which is exactly why the two unscopable classes were removed. Anything left over is
// counted, and enough of it fails the run rather than silently growing the host.
function reclaimHostTemporary(before, ownUdids) {
  if (!before) return;
  const root = hostTemporaryRoot();
  const prefixes = assertClosedHostTemporaryClasses(HOST_TEMPORARY_PREFIXES);
  const uid = process.getuid();
  let unreclaimed = 0;
  for (const name of fs.readdirSync(root)) {
    if (before.has(name)) continue;
    if (!prefixes.some((value) => name.startsWith(value))) continue;
    const target = path.join(root, name);
    try { if (fs.lstatSync(target).uid !== uid) continue; } catch { continue; }
    if (!ownUdids.some((udid) => name.startsWith(`${HOST_TEMPORARY_SIMDEVICE}${udid}.`))) { unreclaimed += 1; continue; }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { unreclaimed += 1; }
  }
  if (unreclaimed > HOST_TEMPORARY_UNRECLAIMED_LIMIT) throw new Error(`GATE_HOST_TEMPORARY_UNRECLAIMED:${unreclaimed}`);
}

// The /private/tmp/idb write exemption is admitted ONLY because it is paired with this, exactly as the
// Darwin temporary root is paired with reclaimHostTemporary above. /tmp/idb/logs is a MEASURED unbounded
// vector, not a theorised one: 520 MB had already accumulated there, and one companion log from a single
// run measured 15.8 MB, so a per-run number alone would not bound it.
//
// TWO enumerated classes, and BOTH are fully udid-scoped - which is what makes this safe. The precedent
// above had to DROP two classes (actool/ibtool scratch) precisely because they could not be udid-scoped
// and so could not be distinguished from an operator's concurrent Xcode build under the same uid. idb
// names both of its artefacts after the target udid, so that problem does not arise here:
//   <root>/<udid>_companion.sock   the companion rendezvous socket (BASE_IDB_FILE_PATH)
//   <root>/logs/<udid>             the companion log (IDB_LOGS_PATH, derived from the same constant)
// `state` is deliberately NOT a class: it is idb's shared cross-run registry, idb prunes it itself, and
// deleting it would break a concurrent idb user. Non-class entries are skipped silently and never
// counted, so `state` cannot inflate the unreclaimed tally.
//
// Adding a class means editing this list AND assertClosedIdbClasses, so it cannot drift silently.
const IDB_COMPANION_SOCKET_SUFFIX = '_companion.sock';
const IDB_LOGS_DIRECTORY = 'logs';
const IDB_CLASSES = [IDB_COMPANION_SOCKET_SUFFIX, IDB_LOGS_DIRECTORY];
// ARBITRARY BACKSTOP, not a measured bound - stated plainly, because this lane has already been burned
// once by a justification that read as measured when it was not. In a healthy run this counter never
// increments at all: a run creates exactly one socket and one log, both udid-matched and both reclaimed,
// so `unreclaimed` only rises for a FOREIGN udid's artefacts created by a concurrent idb user, or for an
// rmSync that fails outright. Both are zero in a healthy run. Nothing about 8 is derived from anything;
// it exists so pathological concurrent activity cannot be silently ignored. If concurrent idb activity on
// this host is ever characterised, replace it with the measured number.
const IDB_UNRECLAIMED_LIMIT = 8;
const IDB_COMPANION_BINARY = '/opt/homebrew/bin/idb_companion';
const IDB_BINARY = '/opt/homebrew/bin/idb';
// Generous because it only bounds a FAILURE: a healthy companion binds its socket in well under a
// second (measured ~1-2s including process start), and this exists so a companion that never binds
// fails the run with its pid instead of hanging it.
const IDB_COMPANION_READY_TIMEOUT_MS = 30000;
const SIMULATOR_SURFACE_READY_TIMEOUT_MS = 30000;
// Boot takes tens of seconds and sim-e2e is many minutes later, so a slow poll costs nothing and keeps
// the wrapper's event loop free while it is awaiting the child.
const IDB_COMPANION_POLL_MS = 3000;

function assertClosedIdbClasses(classes) {
  const expected = ['_companion.sock', 'logs'];
  if (!Array.isArray(classes) || classes.length !== expected.length || classes.some((value, index) => value !== expected[index])) throw new Error('GATE_IDB_CLASS_SET');
  return classes;
}

function snapshotIdbArtifacts() {
  const root = idbRoot();
  const logs = path.join(root, IDB_LOGS_DIRECTORY);
  return {
    sockets: new Set(fs.readdirSync(root)),
    logs: new Set(fs.existsSync(logs) ? fs.readdirSync(logs) : []),
  };
}

// Delete only what is NEW since the snapshot, OWNED by us, in one of the two enumerated classes, AND
// named for one of THIS run's own devices. Every conjunct is required - dropping the udid one would put
// us back where the two removed actool/ibtool classes were.
function reclaimIdbArtifacts(before, ownUdids) {
  if (!before) return { reclaimed: [], unreclaimed: 0, skipped: 'no-snapshot' };
  const root = idbRoot();
  assertClosedIdbClasses(IDB_CLASSES);
  const uid = process.getuid();
  const reclaimed = [];
  let unreclaimed = 0;
  const reclaim = (directory, names, seen, matches) => {
    for (const name of names) {
      if (seen.has(name)) continue;
      if (!matches(name)) continue;
      const target = path.join(directory, name);
      try { if (fs.lstatSync(target).uid !== uid) continue; } catch { continue; }
      if (!ownUdids.some((udid) => name.startsWith(udid))) { unreclaimed += 1; continue; }
      try { fs.rmSync(target, { recursive: true, force: true }); reclaimed.push(path.relative(root, target)); } catch { unreclaimed += 1; }
    }
  };
  reclaim(root, fs.readdirSync(root), before.sockets, (name) => name.endsWith(IDB_COMPANION_SOCKET_SUFFIX));
  const logs = path.join(root, IDB_LOGS_DIRECTORY);
  if (fs.existsSync(logs)) reclaim(logs, fs.readdirSync(logs), before.logs, () => true);
  if (unreclaimed > IDB_UNRECLAIMED_LIMIT) throw new Error(`GATE_IDB_UNRECLAIMED:${unreclaimed}`);
  return { reclaimed, unreclaimed, skipped: null };
}

// Reclamation DELETES the very artefacts that prove whether a companion was ever created, so without
// this line "never created" and "created and cleaned" are indistinguishable to whoever reads the run
// afterwards - a diagnosability cost the reclamation introduced silently. Reported on EVERY run,
// including when it reclaims nothing, because the inaction is the load-bearing observable: it was
// sim_substrate_reap reporting all zeros that ruled out the stale companion as F1's root cause in one
// run instead of three. Same reason, same shape (R8).
function reportIdbReclamation(outcome) {
  if (!outcome) return;
  const detail = outcome.skipped
    ? `skipped=${outcome.skipped}`
    : `reclaimed=${outcome.reclaimed.length}${outcome.reclaimed.length ? ` [${outcome.reclaimed.join(' ')}]` : ''} unreclaimed=${outcome.unreclaimed}`;
  process.stderr.write(`[storage-gate] idb artifact reclamation: ${detail}\n`);
}

// Defect 1 (Luna example-04): `simctl shutdown`/`delete` return BEFORE the simulator's daemons for the
// device exit. On shutdown those daemons reparent to the host launchd - the run's `launchd_sim` plus
// its reparented children (`biomed`, `suggestd`, `identityservicesd`, `com.apple.*`, measured on run
// example-08) - so the supervisor's own child-group reap never reaches them, and they keep OPEN FILE
// HANDLES under the private device set, which lives on the Scratch image. detachRetain then retries
// hdiutil and still fails "Resource busy" (CONTAINER_STILL_MOUNTED). An argv/UDID census does NOT catch
// these holders: only `launchd_sim` carries the device UDID in argv; the reparented children hold the
// mount purely by open FD. So the drain waits for the positive disappearance of every process holding
// an open handle UNDER THE EXACT DEVICE SET PATH (via lsof), escalating SIGTERM -> SIGKILL only to those
// holders. That path scoping is inherently fail-closed and owned: the device set lives inside this run's
// private, nobrowse Scratch mount, so any process with an FD there is a daemon of the device this run
// created - never matched by process name (e.g. UserEventAgent), never a device this run does not own.
// Fail-closed: if handles will not clear within the budget it throws a labelled SIMULATOR_DRAIN_INCOMPLETE
// naming the holders, and detachRetain's own retry plus the error-path retention (blocked_unclassified,
// images kept) remain the backstop.
const SIMULATOR_DRAIN_TOTAL_MS = 60000;
const SIMULATOR_DRAIN_POLL_MS = 500;
const SIMULATOR_DRAIN_TERM_GRACE_MS = 5000;

function simulatorHandleHolders(deviceSetRoot, lsofOutput) {
  const holders = new Set();
  let pid = null;
  for (const line of String(lsofOutput || '').split('\n')) {
    if (line[0] === 'p') { const value = Number(line.slice(1)); pid = Number.isInteger(value) ? value : null; }
    else if (line[0] === 'n' && pid && pid > 1 && pid !== process.pid && line.slice(1).startsWith(deviceSetRoot)) { holders.add(pid); }
  }
  return [...holders];
}

function drainSimulatorHandles(deviceSetRoot, dependencies = {}) {
  if (typeof deviceSetRoot !== 'string' || !path.isAbsolute(deviceSetRoot)) throw new Error('SIMULATOR_DRAIN_DEVICE_SET_INVALID');
  // lsof exits NON-ZERO merely to report "no open files under the path" - that empty result is the
  // DRAINED signal, so a clean run's stdout is authoritative regardless of exit status. But a spawn-level
  // error or a kill by the child timeout (result.error / result.signal) makes the read UNRELIABLE: its
  // empty stdout is absence-of-answer, not absence-of-holders, and must never be read as drained or a
  // still-busy mount slips through (QA reject, 2026-09-08). Signal the unreliable read so the loop keeps
  // it out of the positive-disappearance path and fails closed at the budget. `+D` recurses the device
  // set only (a bounded per-device tree).
  const listHolders = dependencies.lsof || (() => {
    const result = spawnSync('/usr/sbin/lsof', ['-w', '-n', '-Fpn', '+D', deviceSetRoot], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.signal || ![0, 1].includes(result.status) || String(result.stderr || '').trim()) throw new Error(`SIMULATOR_DRAIN_LSOF_UNAVAILABLE:${result.error ? (result.error.code || result.error.message) : result.signal}`);
    return String(result.stdout || '');
  });
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const started = now();
  const killed = false;
  for (;;) {
    let output = null;
    let readError = null;
    try { output = listHolders(); } catch (error) { readError = error; }
    if (output !== null) {
      const holders = simulatorHandleHolders(deviceSetRoot, output);
      if (holders.length === 0) return { drained: true, killed };
      if (now() - started >= SIMULATOR_DRAIN_TOTAL_MS) throw new Error(`SIMULATOR_DRAIN_INCOMPLETE:${JSON.stringify({ deviceSetRoot, holders })}`);
      // An open handle proves contention, never process ownership. Only creating runners signal their children.
    } else if (now() - started >= SIMULATOR_DRAIN_TOTAL_MS) {
      // Never returned drained on an unreliable read; fail closed once the budget is spent.
      throw new Error(`SIMULATOR_DRAIN_INCOMPLETE:${JSON.stringify({ deviceSetRoot, lsof_error: String(readError && (readError.message || readError)) })}`);
    }
    sleep(SIMULATOR_DRAIN_POLL_MS);
  }
}

function deleteSimulator(runId, udid) {
  const set = resolveDeviceSet(runId);
  try { command('/usr/bin/xcrun', ['simctl', '--set', set, 'shutdown', udid]); } catch {}
  drainSimulatorHandles(set);
  command('/usr/bin/xcrun', ['simctl', '--set', resolveDeviceSet(runId), 'delete', udid]);
  // Positive open-handle drain on the exact device set before the caller's detachRetain runs (see the
  // block comment above). `set` is the device set root resolved above; the drain scopes by that path.
  drainSimulatorHandles(set);
}

// `dependencies` is a DEFAULTED, product-owned injection seam, not a test hook: every entry names a
// boundary this function crosses to the host - the supervisor, the disposal operations, the host
// environment preparation, and the evidence classification. The journal and the run state are absent
// from it on purpose. They are what the acceptance criteria assert about, so injecting them would let
// a test prove its own substitute rather than the lifecycle.
//
// EVERY ENTRY IS EXERCISED BY A DEMONSTRATION. Six are substitutable boundaries and two are the
// pre-import bootstrap authority (`gateBootstrap` plus its hermetic snapshot resolver), all visible in
// the destructure immediately below so counting them does not require reading the body. This list also
// carried resolveMounted, requireSeal, enforceImageBacking, createCapacityGuard and verifyCertified,
// which no caller ever supplied - and three of those are the gate's SECURITY checks. An unexercised
// injection point for verifyCertified means the certified-bytes pin, which this lane's premise treats
// as the trust anchor, can be disabled by one argument from any TRUSTED caller with no test to
// notice. An injection point nobody uses is not a smaller seam than one somebody uses; it is a larger
// one, because nothing constrains what it may be replaced with. The same minimality that keeps test
// files out of the capability allowlist applies here. Do not add an entry ahead of a demonstration
// that needs it.
//
// Three entries still carry obligations a substitute could shirk, and each is enforced rather than
// trusted by the mechanism matching its risk:
//   - `supervise` is handed both the host cleanup and the capacity/backing poll. Cleanup happens
//     once per run, so the success path ASSERTS `cleanupAttempted` before it seals. The poll is
//     periodic and a fast child legitimately never triggers it, so it cannot be asserted; instead the
//     gate PERFORMS the integrity half itself after the child - backing-device identity and image
//     backing - and deliberately does not re-impose the free-space floor there. Both are at the
//     `superviseChild` call site, with the reasoning stated in full.
//   - `preliminaryEvidenceDigest` computes the published digest; an injected one that fabricated it
//     is caught downstream by verifyPreliminaryEvidence, which recomputes with the REAL function.
//   - `requireGateCodeSnapshot` exists only so the redirected-HOME lifecycle fixture never needs private
//     remote credentials. It cannot choose arbitrary executable bytes: its result must exactly equal the
//     bootstrap root already bound to the typed journal SHA, and the REAL verifyCertified checks that root
//     before execution and again before publication. `gateBootstrap` is authority data from storage-cli's
//     pre-import path, not a policy substitute; every field is compared to the typed run record here.
// The disposal pair are effects, not checks. `prepareEnvironment` builds host resources and every
// cleanup step is guarded by the field it sets, so a partial preparation is still fully cleanable.
// The wrapper PINS the sim-e2e stage command (report-viewer, set on the child env at :1431); it is
// deliberately NOT caller-overridable (docs/TESTING.md: "Do not add a caller override for
// PENTACLE_GATE_SIM_E2E_CMD"). A caller who set it in the parent env previously had it SILENTLY
// overwritten while gate:full appeared to run their gate and a green was misattributed to a subject
// that never ran. Reject it loudly instead — before any heavy work — and name the supported path
// (repoint the wrapper's fixed command on a branch, the gate:diagnostic pattern). Pure and exported so
// it is unit-testable; runFullGate itself cannot run in-process.
function assertSimE2eCommandNotOverridden(env = process.env) {
  const supplied = env.PENTACLE_GATE_SIM_E2E_CMD;
  if (supplied === undefined || supplied === '') return;
  throw new Error(`GATE_SIM_E2E_CMD_NOT_OVERRIDABLE: the wrapper pins the sim-e2e stage command and ignores a caller-supplied PENTACLE_GATE_SIM_E2E_CMD (${supplied}). It is not caller-overridable; run a different sim-e2e gate by repointing the wrapper's fixed command on a branch (the gate:diagnostic pattern), not via this env var. See docs/TESTING.md.`);
}

async function runFullGate(runId, lockToken, dependencies = {}) {
  // Reject a caller-supplied sim-e2e override up front: it would otherwise be silently clobbered at
  // :1431, and no output would say the requested gate never ran. Fail before the pre-flight/lock/run.
  assertSimE2eCommandNotOverridden();
  const {
    supervise: superviseChild = supervise,
    detachAndDiscard: detachAndDiscardDependency = detachAndDiscard,
    detachRetain: detachRetainDependency = detachRetain,
    preliminaryEvidenceDigest: preliminaryEvidenceDigestDependency = preliminaryEvidenceDigest,
    verifyGateCodeProvenance: verifyGateCodeProvenanceDependency = requireMatchingGateCodeProvenance,
    requireGateCodeSnapshot: requireGateCodeSnapshotDependency = gateCodeSnapshots.requireSnapshot,
    gateBootstrap,
    // Destructured HERE with the rest even though it is consumed far below, next to the default it
    // falls back to. It was previously read straight off `dependencies` at its point of use, which
    // meant the seam was five entries while every place an auditor reads - this comment, the commit
    // message, the spec - said four, because they all counted the destructure. An injection list that
    // is only discoverable by grepping the function body is not a list.
    prepareEnvironment: prepareEnvironmentDependency,
  } = dependencies;
  let capacityGuard;
  // Installed BEFORE any other work. Every step in the pre-flight region below can throw - the
  // capacity probe, the seal checks, native-root cardinality, certified verification - and until
  // this was hoisted those throws happened outside every handler, so the run kept both mounts with
  // no recovery path. A DISK_START_BELOW_60_GIB abort from requireCapacity('start') is exactly how
  // a run stranded in practice. Idempotent, because the handlers further down also call it once
  // they have recorded the failure state.
  //
  // The same ownership-bound cleanup handles unclaimed preparation locks and claimed gate locks.
  // Neither an early refusal nor an invalid caller token may bypass this boundary.
  let hostResourcesReleased = false;
  // Cleanup failures are SWALLOWED so they cannot replace the real verdict, but they are no longer
  // silent: a detach that did not take leaves the fixed mount point occupied, the next run collides
  // on it, and until now nothing in the error or the journal said so - the failure was invisible
  // exactly where docs/TESTING.md promises error-path cleanup detaches both images. The names are
  // carried out and appended to the error the caller is already throwing.
  const releaseFailures = [];
  const releaseHostResources = () => {
    if (hostResourcesReleased) return;
    hostResourcesReleased = true;
    try { releasePreparedAllocation(runId, lockToken, { detachRetain: detachRetainDependency }); }
    catch (failure) { releaseFailures.push(String(failure.message || failure)); }
  };
  const withReleaseFailures = (error) => (releaseFailures.length
    ? new Error(`${String(error.message || error)} [release-incomplete: ${releaseFailures.join('; ')}]`)
    : error);
  let authority; let run; let scratch; let evidence; let nativeRoot; let candidateRoot; let gateCodeRoot; let priorPid; let indirections; let scenarioEnvFile;
  const discardGateCodeSnapshot = () => {
    if (!gateCodeRoot) return;
    gateCodeSnapshots.discardSnapshot(runId);
    gateCodeRoot = null;
  };
  try {
    scenarioEnvFile = hostScenarioEnvFile();
    verifyCertified();
    authority = validateInstalledAuthority();
    run = readRecord('runs', runId);
    if (run.generation !== authority.generation) throw new Error('AUTHORITY_GENERATION_DRIFT');
    if (run.state !== 'allocated' || run.lock_token_digest !== crypto.createHash('sha256').update(lockToken).digest('hex')) throw new Error('RUN_AUTHORITY_INVALID');
    if (!/^[0-9a-f]{40}$/.test(run.gate_code_sha || '') || run.gate_code_tree_clean !== true) throw new Error('RUN_GATE_CODE_PROVENANCE_INVALID');
    if (!gateBootstrap || gateBootstrap.runId !== runId || gateBootstrap.gateCodeSha !== run.gate_code_sha
        || typeof gateBootstrap.invokingRepository !== 'string' || typeof gateBootstrap.snapshotRoot !== 'string') {
      throw new Error('GATE_BOOTSTRAP_REQUIRED');
    }
    gateCodeRoot = requireGateCodeSnapshotDependency(runId, run.gate_code_sha);
    if (gateCodeRoot !== gateBootstrap.snapshotRoot) throw new Error('GATE_CODE_SNAPSHOT_IDENTITY');
    verifyGateCodeProvenanceDependency(gateBootstrap.invokingRepository, run);
    capacityGuard = createCapacityGuard();
    capacityGuard.requireCapacity('start');
    scratch = resolveMounted('scratch', runId).mount;
    containers.requireSeal(resolveMounted('scratch', runId).seal, run.scratch_seal);
    const evidenceResolved = resolveMounted('evidence', runId);
    containers.requireSeal(evidenceResolved.seal, run.evidence_seal);
    evidence = evidenceResolved.mount;
    const nativeParent = path.join(scratch, 'native');
    const nativeEntries = fs.readdirSync(nativeParent);
    if (nativeEntries.length !== 1) throw new Error('NATIVE_ROOT_CARDINALITY');
    nativeRoot = path.join(nativeParent, nativeEntries[0]);
    candidateRoot = path.join(scratch, 'candidate');
    verifyCertified(gateCodeRoot);
    priorPid = run.owner.pid;
    // ios-export is NOT indirected. full-gate.cjs runs `expo export --output-dir <artifacts>/ios-export`,
    // and expo CLEARS its output directory before writing, which unlinks whatever sits there. A symlink
    // is therefore replaced by a real directory on every run: measured at run example-03, <evidence>/ios-export
    // was a real 11 MB directory while <scratch>/ios-export stayed 0 B. Cleanup's GATE_INDIRECTION_REPLACED
    // check then failed EVERY run regardless of gate outcome, and that failure masked the real stage error.
    // A mount point does not survive either - it makes expo's own clear fail (probed: recursive force remove
    // of a mount point fails and the mount survives), converting a silent replacement into a hard stage
    // failure. So the export bills the evidence cap: 11 MB against 2 GiB, which requireCapacity already
    // enforces. Do not "restore" this indirection; the destination is certified code's to choose, and only
    // what sits AT the destination is ours.
    indirections = [
      [path.join(evidence, 'release-sim-derived-data'), path.join(scratch, 'derived-data')],
    ];
  } catch (error) {
    try { discardGateCodeSnapshot(); } catch (failure) { releaseFailures.push(`gate-code-snapshot=${String(failure.message || failure)}`); }
    releaseHostResources();
    throw withReleaseFailures(error);
  }
  // ONE object, declared before anything is created, and every field written the moment the thing it
  // names exists rather than when the step that created it returns. That is what lets cleanup reason
  // about a HALF-PREPARED environment: a preparation that throws part-way still leaves each completed
  // creation recorded, and each cleanup step is guarded by its own field. It is also the whole
  // injection seam - an injected prepareEnvironment that only sets `env` leaves every other field
  // null, so the matching cleanup steps are correctly skipped without any test-only branch.
  const environment = {
    env: null, queue: null, createdIndirections: [], deviceSet: null, simulatorUdid: null,
    hostTemporaryBefore: null, idbBefore: null, idbCompanionWatcher: null, simulatorSurfaceTrigger: null,
  };
  let result;
  let childStatus = null;
  let cleanupAttempted = false;
  const cleanupResources = async () => {
    if (cleanupAttempted) throw new Error('GATE_CLEANUP_DUPLICATE');
    cleanupAttempted = true;
    // Preserve the exact product and private-device logs before any destructive teardown.
    // A capture failure deliberately leaves the capped source images unclassified and retained.
    const retainedLaunch = environment.simulatorUdid && require('./storage-launch-evidence.cjs').bind(mutationCapability).captureLaunchEvidence({
      evidence, scratch, runId, candidateSha: run.candidate_ref, udid: environment.simulatorUdid, deviceSet: environment.deviceSet,
      context: () => ({ gate_code_sha: run.gate_code_sha, native_root: nativeRoot, cwd: candidateRoot,
        sandbox_profile: require('./storage-sandbox.cjs').profileForRun(),
        sandbox_profile_sha256: require('node:crypto').createHash('sha256').update(require('./storage-sandbox.cjs').profileForRun()).digest('hex'),
        environment: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'PENTACLE_GATE_SIMULATOR_UDID', 'PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT'].map((key) => [key, environment.env?.[key] ?? null])),
        launcher_start_time: null, launcher_start_time_reason: 'not observed by the post-run collector; use the independent launch trace' }),
    });
    if (retainedLaunch?.launch && retainedLaunch.launch.status !== 0) throw new Error('LAUNCH_DIAGNOSIS_REQUIRED');
    // Every step is LABELLED and every label survives into the thrown message. Previously the throw was
    // an AggregateError, and String(error.message) on one of those yields the bare word GATE_CLEANUP_FAILED
    // - the individual failures are unreachable. The run record therefore said that some cleanup step had
    // failed but never which, and because a cleanup failure throws, the catch below also stamped 17 over the
    // child's real exit code. At run example-03 one deterministic indirection bug used that to hide a real
    // release-sim-build failure completely: the only surviving copy of the true cause was inside the
    // evidence image. Labels are the fix; keep them, and keep this a plain Error.
    const failures = [];
    const step = (label, action) => { try { action(); } catch (error) { failures.push(`${label}=${String(error.message || error)}`); } };
    step('simulator-surface', () => stopSimulatorSurfaceTrigger(environment.simulatorSurfaceTrigger, evidence, runId));
    step('idb-companion', () => stopIdbCompanionWatcher(environment.idbCompanionWatcher));
    if (environment.simulatorUdid) step('simulator', () => deleteSimulator(runId, environment.simulatorUdid));
    for (const [link, target] of environment.createdIndirections) {
      step(`indirection(${path.basename(link)})`, () => {
        if (!fs.lstatSync(link).isSymbolicLink() || fs.readlinkSync(link) !== target) throw new Error('GATE_INDIRECTION_REPLACED');
        fs.unlinkSync(link);
      });
    }
    step('host-temporary', () => reclaimHostTemporary(environment.hostTemporaryBefore, [environment.simulatorUdid].filter(Boolean)));
    step('idb-artifacts', () => reportIdbReclamation(reclaimIdbArtifacts(environment.idbBefore, [environment.simulatorUdid].filter(Boolean))));
    if (environment.queue) step('sim-queue', () => releaseSimulatorQueue(environment.queue));
    if (failures.length) throw new Error(`GATE_CLEANUP_FAILED[${failures.join('; ')}]`);
  };
  // releaseHostResources is defined at the top of this function so it also covers the pre-flight
  // region. It is a MOUNT/LOCK operation ONLY and deliberately NOT a state transition: the journal
  // keeps exactly the state the failure recorded, detachRetain detaches WITHOUT discarding so every
  // retention clock and deletion authority is untouched (invariant 9), it gains no deletion edge,
  // and every caller ALWAYS rethrows, so error-path cleanup can never convert a failure or a signal
  // into green (invariant 7).
  // The default preparation of every HOST resource the child needs: the indirections, the private
  // device set, the simulator, the idb companion, the surface trigger, the ps shim and the child
  // environment. It is a named, replaceable dependency because the lifecycle it guards - which
  // supervisor outcome discards scratch, which retains evidence, what the journal records when
  // classification fails - cannot otherwise be exercised without mounted images and real simulator
  // tooling, so those acceptance criteria were demonstrable only by inspection. Every field it sets
  // is recorded on `environment` as soon as the thing exists, so a preparation that throws part-way
  // is still fully cleanable. The journal and the run state are deliberately NOT injectable: they
  // are what the tests assert against, and a replaced journal would assert on itself.
  const defaultPrepareEnvironment = async () => {
    environment.deviceSet = resolveDeviceSet(runId);
    for (const [link, target] of indirections) {
      if (fs.existsSync(link)) throw new Error('GATE_INDIRECTION_COLLISION');
      fs.symlinkSync(target, link);
      environment.createdIndirections.push([link, target]);
    }
    // Taken BEFORE createSimulator, so entries our own device creation leaves are reclaimable too. Any
    // wider a window would classify more concurrent host activity as ours; the udid scoping in
    // reclaimHostTemporary is what keeps that from mattering for the class that actually accumulates.
    environment.hostTemporaryBefore = snapshotHostTemporary();
    // Same window and same reasoning as hostTemporaryBefore: taken BEFORE createSimulator so a companion
    // spawned for our own device is reclaimable, and no wider, so a concurrent idb user's artefacts stay
    // outside it. The udid scoping in reclaimIdbArtifacts is what makes the window's width not matter.
    environment.idbBefore = snapshotIdbArtifacts();
    environment.queue = acquireSimulatorQueue(runId);
    createSimulator(runId, (udid) => {
      environment.simulatorUdid = udid;
      environment.ownedBootMonotonicMs = Number(process.hrtime.bigint()) / 1e6;
    });
    // NECESSARY BUT NOT SUFFICIENT - and the "entire fix" claim below was WRONG, corrected here by
    // measurement rather than left to mislead the next reader. Checkbox-8 run example-09 failed the SAME
    // case with the SAME error while sim_substrate_reap was ALL ZEROS: nothing stale existed, this reap
    // correctly did nothing, and the case failed identically. So the stale companion was a CONFOUNDER,
    // not the root cause. Two different states produce one symptom by different paths: with a stale
    // companion idb reads a FOREIGN simulator's tree; with none, idb gets NO tree at all, because it
    // cannot spawn a companion for our own device without writing /tmp/idb. The reap is kept because it
    // is still correct for the first path - it simply cannot make a new companion SPAWNABLE, which is
    // the actual break, and that is fixed by the /tmp/idb exemption plus reclaimIdbArtifacts.
    //
    // HOISTED OUT OF THE SANDBOX. The certified runner reaps the stale
    // idb_companion itself, but it runs INSIDE the container where killing a host process is `target
    // others` and removing /tmp/idb sockets is outside both write roots - so its reap is denied and
    // silently accomplishes nothing. Measured at the all-cases diagnostic: a companion bound to UDID
    // example-07 survived while the run created example-11, so `idb ui describe-all` read a DIFFERENT
    // simulator's accessibility tree and report_viewer_horizontal_scroll failed SETUP_FAIL with
    // "missing accessible scroll viewport".
    //
    // The answer is NOT to give the sandbox host authority. It is to perform the operation where the
    // authority already legitimately lives - the wrapper, outside the sandbox - which is the same shape
    // reclaimHostTemporary uses. No containment change and no privilege widening.
    //
    // boundUdid SPARES this run's own simulator while the host clears stale substrate. The boot watcher
    // then creates this run's companion. The later certified-child idb hygiene is suppressed below:
    // repeating that portion after the watcher fires would destroy the current companion, and the
    // sandboxed client cannot auto-spawn a replacement for the private device set.
    reapHostSimulatorSubstrate(environment);
    // AFTER the reap, which kills stale companions - spawning before it would have this run's own
    // companion reaped by the very sweep meant to clear the previous run's.
    environment.idbCompanionWatcher = startIdbCompanionWatcher(environment.simulatorUdid, environment.deviceSet);
    // The certified denial wait absorbs the race between case 9 entering its keyboard wrapper and this
    // host-side launch. Count the run's own result JSONs under the wrapper-resolved evidence mount: once
    // case 8 completes, launch within the wait window. The diagnostic driver mirrors the same real case
    // results into the scratch path below because its durable output deliberately lives outside evidence.
    // Both roots come from this run's mounted layout; no HOME-derived path crosses this boundary.
    const diagnosticSurfaceTriggerDirectory = path.join(scratch, 'diagnostic-surface-trigger');
    environment.simulatorSurfaceTrigger = createCaseCompletionTrigger({
      resultDirectories: [
        path.join(evidence, 'report-viewer-sim-e2e'),
        diagnosticSurfaceTriggerDirectory,
      ],
      requiredResults: reportViewerResultsBeforeKeyboard(),
      launch: () => launchSimulatorSurface(environment.simulatorUdid, environment.deviceSet),
    });
    // /bin/ps is SETUID ROOT and the kernel refuses to exec a setuid binary under sandbox-exec. Verified
    // here under the REAL rendered profile, not a hand-rolled one: real /bin/ps fails execvp with
    // "Operation not permitted" at rc 71, while a de-setuid, AD-HOC RE-SIGNED copy of the same binary runs
    // at rc 0 and returns byte-identical output for ppid=, command= and lstart=. setuid is only needed to
    // read OTHER uids' processes; this gate only ever asks about its own, so the copy loses nothing it
    // uses and degrades cross-uid command= to (launchd) - failing closed, and strictly LESS privilege than
    // proxying the real setuid binary in from outside the sandbox would have been.
    //
    // On arm64 `cp` strips the code signature and the kernel SIGKILLs the result: measured rc 137, empty
    // output, no stderr. That is loud rather than silent, but a MISSING shim is worse - PATH would fall
    // straight back to /bin/ps and the stage would die with EPERM deep inside a certified file. So the
    // install is proven with a positive control right here instead of being discovered mid-run.
    //
    // LOAD-BEARING, and it lives in a file we cannot edit: this works only because the certified
    // report-viewer stage calls BARE `ps`. QA counted SEVEN such sites - report-viewer-sim-e2e.cjs 514,
    // 515, 549, 562, 575, 589 and 599 - all inside withSoftwareKeyboard, which sets no env override at
    // :469, so a PATH shim reaches all of them. If a future certified revision switches to an absolute
    // path this fix stops being reached and the stage returns to EPERM; check the CALLER first, because it
    // will look like a regression here.
    const shimDirectory = path.join(scratch, 'bin');
    const shimPath = path.join(shimDirectory, 'ps');
    fs.mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
    fs.copyFileSync('/bin/ps', shimPath);
    fs.chmodSync(shimPath, 0o755);
    command('/usr/bin/codesign', ['-s', '-', '-f', shimPath]);
    const shimProof = spawnSync(shimPath, ['-p', String(process.pid), '-o', 'ppid='], { encoding: 'utf8' });
    if (shimProof.status !== 0 || !String(shimProof.stdout || '').trim()) throw new Error(`GATE_PS_SHIM_UNUSABLE:${shimProof.status}`);
    environment.env = {
      ...process.env,
      PATH: `${shimDirectory}:${process.env.PATH || ''}`,
      SIM_QUEUE_OWNER_VERIFIED_PID: String(process.pid),
      PENTACLE_STORAGE_RUN_ID: runId,
      HOME: path.join(scratch, 'home'),
      TMPDIR: path.join(scratch, 'tmp'),
      XDG_CACHE_HOME: path.join(scratch, 'cache'),
      XDG_CONFIG_HOME: path.join(scratch, 'config'),
      PENTACLE_GATE_NATIVE_ROOT: nativeRoot,
      PENTACLE_GATE_CANONICAL_RUNNER: '1',
      PENTACLE_GATE_CANDIDATE_SHA: run.candidate_ref,
      PENTACLE_GATE_CODE_SHA: run.gate_code_sha,
      PENTACLE_GATE_CODE_TREE_CLEAN: String(run.gate_code_tree_clean),
      PENTACLE_GATE_ARTIFACT_DIR: evidence,
      PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT: environment.deviceSet,
      PENTACLE_GATE_SIMULATOR_UDID: environment.simulatorUdid,
      PENTACLE_OWNED_BOOT_MONOTONIC_MS: String(environment.ownedBootMonotonicMs),
      // idb's own documented address override. A colon-free value is parsed as a domain socket, so the
      // in-container client talks straight to the wrapper's device-set-aware companion and never runs
      // the target resolution that cannot see a private device set.
      IDB_COMPANION: idbCompanionSocket(environment.simulatorUdid),
      // LAYER 18, and it is the reason three companion fixes changed nothing observable: `idb` is a
      // pip --user install, so its module lives ONLY in python's USER site-packages, and
      // site.getusersitepackages() is derived from HOME. This wrapper redirects HOME into the scratch,
      // so the sandboxed `idb` died at IMPORT on every invocation - measured 37 of 37 attempts in run
      // example-12, unanimously `ModuleNotFoundError: No module named 'idb'`, which the poll then wore as
      // a 20-second timeout. The companion it was supposed to reach was never contacted at all.
      //
      // Proven by control in BOTH directions before landing: HOME redirected -> import fails, idb --help
      // rc=1; HOME redirected + this PYTHONPATH -> import OK, idb --help rc=0.
      //
      // DERIVED, never hardcoded: resolved by asking the host python OUTSIDE the sandbox, so a python
      // upgrade moves it without silently reintroducing the defect. Read-only, and adds no reach - the
      // profile's pre-existing blanket `file-read*` already lets the child read this path; what was
      // missing was python being TOLD to look there. This is the seventh instance of the HOME/XDG class
      // and the first below the level any tool inventory could reach, since it is python's own path
      // resolution rather than a tool's config lookup.
      PYTHONPATH: hostUserSitePackages(),
      // LAYER 19. The substrate reap kills EVERY idb_companion and deletes their sockets, then relies on
      // "the next `idb ui` auto-spawns a fresh working companion" to recover - which is structurally
      // impossible inside this container, because auto-spawn cannot see a private device set (layer 14).
      // Certified code calls it in-container at report-viewer-sim-e2e.cjs:786 and full-gate.cjs:417, i.e.
      // AFTER this wrapper has already spawned the one companion that can serve the gate's device. So the
      // in-container reap destroys this run's own substrate and removes the only recovery path with it.
      // Measured at run example-10: 15 of 15 poll attempts failed `Failed to connect to companion ...
      // [Errno 2] No such file or directory` against the exact socket the wrapper had created and proved
      // usable moments earlier.
      //
      // Suppress ONLY the repeated idb hygiene that would destroy this run's wrapper-created companion.
      // The certified child still performs its isolated-set Simulator.app and stray-sim cleanup; the host
      // reap intentionally does not replace those actions. The narrow switch reports its skip reason.
      PENTACLE_TEST_DISABLE_IDB_COMPANION_REAP: '1',
      PENTACLE_GATE_SIM_E2E_CMD: `${process.execPath} ${path.join(gateCodeRoot, 'scripts', 'report-viewer-sim-e2e.cjs')}`,
      PENTACLE_GATE_SIM_E2E_ENV_FILE: scenarioEnvFile,
      PENTACLE_GATE_SIM_E2E_STAGE: 'integration',
      PENTACLE_DIAGNOSTIC_SURFACE_TRIGGER_DIR: diagnosticSurfaceTriggerDirectory,
      SIM_QUEUE_TICKET: environment.queue.ticket,
      SIM_QUEUE_ROOT: hostSimQueueRoot(),
    };
  };
  const prepareEnvironment = prepareEnvironmentDependency || defaultPrepareEnvironment;

  try {
    run = transitionRun(runId, run.revision, 'running', { owner: { host: authority.host, uid: authority.uid, pid: process.pid }, handoff_from_pid: priorPid, running_at: new Date().toISOString() });
    claimHostLock(run, lockToken, priorPid);
    await prepareEnvironment(environment, { runId, scratch, evidence, candidateRoot, nativeRoot, indirections, scenarioEnvFile });
    let cacheInputs; let cacheReceipt;
    if (!prepareEnvironmentDependency) {
      cacheInputs = buildCache.inputsFor(nativeRoot, environment.env);
      cacheReceipt = { restore: cacheStore.restore(cacheInputs, scratch, { onReceipt: (restore) => {
        cacheReceipt = { restore };
        atomicJson(path.join(evidence, 'build-cache.json'), cacheReceipt);
      } }) };
      atomicJson(path.join(evidence, 'build-cache.json'), cacheReceipt);
    }
    result = await superviseChild(sandboxed([process.execPath, path.join(gateCodeRoot, 'scripts', 'full-gate.cjs'), '--artifacts', evidence]), {
      cwd: candidateRoot, env: environment.env,
      // The SAME guard the start probe used. A second guard here would capture the identity of
      // whatever volume is backing the support root at this moment and then agree with itself
      // forever, which is exactly the swap the observation exists to catch.
      capacity: () => { capacityGuard.requireCapacity('running'); enforceImageBacking('scratch', runId); enforceImageBacking('evidence', runId); },
      cleanup: cleanupResources,
    });
    // Carry the child's REAL exit code out with us. A cleanup failure throws, and the catch below used to
    // stamp a flat 17 over whatever the gate actually did, so a failing stage plus a failing cleanup came
    // out indistinguishable from a clean run that merely failed to tidy up.
    childStatus = result.status;
    const { collectChecks, requireChecks } = require('./gate-checks.cjs');
    const supervisionChecks = collectChecks([
      { name: 'cleanup-result', run: () => { if (result.cleanup_error) throw new Error(`GATE_CLEANUP_INCOMPLETE:${result.cleanup_error}`); } },
      { name: 'cleanup-executed', run: () => { if (!cleanupAttempted) throw new Error('GATE_SUPERVISOR_CLEANUP_SKIPPED'); } },
      { name: 'capacity-identity', run: () => capacityGuard.freeBytes() },
      { name: 'scratch-backing', run: () => enforceImageBacking('scratch', runId) },
      { name: 'evidence-backing', run: () => enforceImageBacking('evidence', runId) },
    ]);
    if (supervisionChecks.some((row) => row.status !== 'passed')) {
      requireChecks(collectChecks([{ name: 'evidence-audit', dependsOn: ['capacity-identity', 'evidence-backing'], run: () => validateEvidence(evidence, runId, 'pre-cleanup', childStatus) }], supervisionChecks));
    }
    // THE SUPERVISOR IS INJECTABLE, SO ITS OBLIGATIONS ARE VERIFIED HERE RATHER THAN TRUSTED.
    //
    // The two running-phase guarantees this gate depends on - the capacity/backing-drift poll and the
    // host cleanup - are handed INTO the supervisor as callbacks. The real one honours both. An
    // injected one need not, and on the SUCCESS path nothing above notices: `cleanup_error` is a
    // field the injected return supplies about itself, and `cleanupAttempted` was previously read
    // only in the catch below. So `supervise: async () => ({ status: 0 })` would have disabled the
    // image-backing drift check and every cleanup step and still produced a green published run -
    // the same disable-by-argument shape that got verifyCertified removed from this list, surviving
    // one layer further in. The seam stays, because the demonstrations genuinely need it; what does
    // not stay is taking the substitute's word for having done the work.
    //
    // The two obligations need DIFFERENT remedies, and the difference is the whole point.
    //
    // CLEANUP happens exactly once per run, so its occurrence is assertable directly.
    // The POLL is periodic, so its occurrence is NOT assertable: the real supervisor fires `capacity`
    // on a five-second interval, and a child that finishes sooner legitimately never triggers it.
    // Demanding that the poll ran would fail correct fast runs. So the check is not asserted, it is
    // PERFORMED, once, here, by the gate itself, where no substitute can decline it.
    //
    // WHAT IS PERFORMED HERE IS THE INTEGRITY HALF ONLY, AND THE OMISSION IS THE DESIGN.
    //
    // The poll couples two unrelated questions. "Has the backing device changed, or has an image
    // outgrown its cap" is an INTEGRITY question: a yes means the run's own evidence may not be what
    // it claims, so publishing it would be publishing a lie. That must block the seal, and it is
    // exactly what a substitute supervisor could otherwise decline.
    //
    // "Is there less than 40 GiB free" is a RESOURCE question, and it belongs to the running phase
    // only. Enforced here it is actively harmful, in three ways measured on a green run: it stamps
    // the flat 17 fallback over a child that exited 0 (the same defect the comment above fixes for
    // the cleanup case), it leaves a passing run with no digest and its verdict readable only by
    // attaching the image, and - worst - it makes the run RETAIN its 12 GiB scratch instead of
    // discarding it. A gate that stops releasing disk precisely because the disk ran low has the
    // sign inverted. The supervisor already made the opposite and correct choice for this case:
    // storage-supervisor.cjs:151 turns a capacity failure into requestStop('low-disk') and :54 maps
    // it to a first-class exit status, so the run SEALS and its scratch is released. That decision
    // stands; this line must not override it.
    //
    // freeBytes() rather than requireCapacity() is what draws the line: both re-verify the captured
    // backing-device identity, and only the latter also imposes the floor.
    //
    // `childStatus` is carried out first so that if this check does throw, the catch below records
    // the child's REAL exit code instead of stamping 17 over it.
    childStatus = result.status;
    if (cacheInputs && result.status === 0) {
      try { cacheReceipt.publish = cacheStore.publish(cacheInputs, scratch); }
      catch (error) { cacheReceipt.publish = { stored: false, reason: error.message }; }
      atomicJson(path.join(evidence, 'build-cache.json'), cacheReceipt);
    }
  } catch (error) {
    if (!cleanupAttempted) { try { await cleanupResources(); } catch (cleanupError) { error = new Error(`GATE_STAGE_AND_CLEANUP_FAILED[stage=${String(error.message || error)}; cleanup=${String(cleanupError.message || cleanupError)}]`); } }
    try {
      let failed = readRecord('runs', runId);
      const detail = withChildStage(evidence, String(error.message || error));
      if (failed.state === 'running') failed = transitionRun(runId, failed.revision, 'sealing', { gate_status: Number.isInteger(childStatus) ? childStatus : 17, failure: detail, sealing_at: new Date().toISOString() });
      if (failed.state === 'sealing') transitionRun(runId, failed.revision, 'blocked_unclassified', { classification_error: detail });
    } catch {}
    try { discardGateCodeSnapshot(); } catch (failure) { releaseFailures.push(`gate-code-snapshot=${String(failure.message || failure)}`); }
    releaseHostResources();
    throw withReleaseFailures(error);
  }
  run = readRecord('runs', runId);
  // THIRD instance of fix C, and the THIRD consequence of layer 8. A run that FAILS but seals cleanly
  // takes NEITHER error handler, so nothing populated `failure` or `classification_error` and the state
  // record carried gate_status 1 with no cause at all - the truth was inside the evidence image again,
  // which is exactly what C existed to end (measured at run example-06: failure null, classification_error
  // null, and the only way to learn it died in sim-e2e was to attach the image). This path is not old
  // code that was overlooked: before layer 8 a failed run could not seal, so it did not exist to apply C
  // to. R3 - animating a dead path makes the WHOLE path new code.
  //
  // `failure` is set, `classification_error` is NOT: classification SUCCEEDED here. The run is a
  // correctly sealed, correctly classified failure, and stamping a classification error on it would
  // misreport the one thing this path proves works.
  const sealed = { gate_status: result.status, sealing_at: new Date().toISOString() };
  if (result.status !== 0) sealed.failure = withChildStage(evidence, `GATE_STATUS_NONZERO:${result.status}`);
  run = transitionRun(runId, run.revision, 'sealing', sealed);
  try {
    verifyGateCodeProvenanceDependency(gateBootstrap.invokingRepository, run);
    verifyCertified();
    requireGateCodeSnapshotDependency(runId, run.gate_code_sha);
    verifyCertified(gateCodeRoot);
    requireEvidenceProvenance(evidence, run);
    const preliminary = preliminaryEvidenceDigestDependency(evidence, runId);
    run = transitionRun(runId, run.revision, 'published', { preliminary_audit_at: new Date().toISOString(), preliminary_evidence_digest: preliminary, published_at: new Date().toISOString() });
    // Published, with the scratch still mounted and still holding its 12 GiB. A run that dies here
    // is the class the janitor's dead-owner recovery exists for, and until now that could only be
    // reasoned about.
    require('./storage-crash-points.cjs').crashPoint('publication');
    discardGateCodeSnapshot();
    run = transitionRun(runId, run.revision, 'scratch_discarding', { scratch_discard_started_at: new Date().toISOString() });
    detachAndDiscardDependency('scratch', runId, run.scratch_seal);
    run = finalizeScratchDiscard(runId);
    const digest = run.evidence_digest;
    detachRetainDependency('evidence', runId, run.evidence_seal);
    releaseHostLock(run, lockToken);
    return { run_id: runId, status: result.status, evidence_digest: digest, candidate_sha: run.candidate_ref, gate_code_sha: run.gate_code_sha };
  } catch (error) {
    try { discardGateCodeSnapshot(); } catch (failure) { releaseFailures.push(`gate-code-snapshot=${String(failure.message || failure)}`); }
    // Guard the state work exactly as the primary handler does. Unguarded, a throw from readRecord
    // or transitionRun here would both skip the release AND replace the original error with a
    // bookkeeping failure, losing the real verdict.
    try {
      const current = readRecord('runs', runId);
      // Same lift as the error path. C originally covered only the cleanup path, so a SEAL failure recorded
      // the seal's own complaint and nothing about the stage that actually failed - measured at run
      // example-13, where the record said EVIDENCE_CASE_MANIFEST_INVALID and the truth (sim-e2e) was
      // recoverable only by attaching the evidence image, which is precisely what C existed to avoid. The
      // correction had stopped at the place the question first looked answered.
      const detail = withChildStage(evidence, String(error.message || error));
      if (current.state === 'sealing') transitionRun(runId, current.revision, 'blocked_unclassified', { classification_error: detail });
    } catch {}
    releaseHostResources();
    throw withReleaseFailures(error);
  }
}

// reclaimHostTemporary is capability-bound, not plainly exported: it DELETES inside a shared host
// directory, which makes it a mutation entry point in exactly the sense the banned list exists for.
module.exports = { REPORT_VIEWER_CASE_PLAN, assertClosedHostTemporaryClasses, assertClosedIdbClasses, assertSimE2eCommandNotOverridden, bind: (token) => require('./storage-capability.cjs').bind(token, { discardPublishedScratch, drainSimulatorHandles, finalizeScratchDiscard, prepareNativeRoot, reapHostSimulatorSubstrate, reclaimHostTemporary, reclaimIdbArtifacts, recoverDeadHostLock, releasePreparedAllocation, withPreparedAllocation, runFullGate, sealUnclassifiedEvidence }), enumerateEvidence, preliminaryEvidenceDigest, reportViewerResultsBeforeKeyboard, resolveDeviceSet, snapshotHostTemporary, snapshotIdbArtifacts, validateCertifiedStages, validateEvidence, validateReportViewer, verifyCertified, verifyPreliminaryEvidence, verifyRetainedEvidence, withChildStage };
