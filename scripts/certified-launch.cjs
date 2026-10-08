'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const quiet = require('./certified-start-receipt.cjs');
const launchEnvironment = require('./certified-launch-environment.cjs');
const { runOwnedSync } = require('./owned-process.cjs');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_ORIGIN = 'https://github.com/HJK6/pentacle-mobile.git';
const ENDPOINT_BOUND_MS = 10800000;
const ENDPOINT_GRACE_MS = 120000;
const OBSERVER_GRACE_MS = 2000;
const REDACTED = '[REDACTED_LOCK_TOKEN]';
const TOKEN_FIELD = /("lock_token"\s*:\s*)"[^"]*"/g;
const TOKEN = /^[0-9a-f]{64}$/;
// This module never claims the mutation capability. The trusted gate:certified dispatch passes its
// token in options.mutationCapability; without the bound operations no attempt starts, because no
// owned cleanup would be possible.
const MUTATIONS = Object.freeze(['attachExisting', 'detachRetain', 'releasePreparedAllocation']);

function git(args, root = ROOT) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) delete env[name];
  const result = spawnSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('CERTIFIED_LAUNCH_SOURCE');
  return result.stdout.trim();
}

// Review and CI contracts have one home, the common START consumer; these are its exports.
const readReference = reference => quiet.readReference(reference);

// Window time is checked where it matters: before observation (observer + combined closing budget),
// at native start (combined budget, inspectNativeStart) and before full (remaining full budget,
// requireAllocatedStart). No extension or retry.
function requireWindow(packet, budgetMs, now) {
  const start = packet.not_before_epoch * 1000;
  const end = packet.expires_epoch * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || now < start || now >= end || end - now < budgetMs) throw new Error('CERTIFIED_LAUNCH_WINDOW');
}

function validateAllocation(packet, expected, now = Date.now()) {
  if (!packet || packet.schema !== 1 || packet.fd_go !== true || !quiet.UUID.test(packet.tell_id || '')
      || !quiet.UUID.test(packet.attempt_id || '') || typeof packet.from_stream !== 'string' || !packet.from_stream) throw new Error('CERTIFIED_LAUNCH_ALLOCATION');
  if (packet.host !== expected.host || packet.uid !== expected.uid || packet.candidate_sha !== expected.candidateSha
      || packet.gate_code_sha !== expected.gateCodeSha || packet.policy_revision !== quiet.POLICY.revision) throw new Error('CERTIFIED_LAUNCH_ALLOCATION_BINDING');
  requireWindow(packet, quiet.POLICY.combinedClosingBudgetMs + quiet.POLICY.observerBoundMs, now);
  return packet;
}

const validateReviews = (packet, candidateSha, gateCodeSha = candidateSha) => quiet.validateReviews(packet, candidateSha, gateCodeSha);

function jsonObjects(output) {
  return String(output || '').split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; } catch { return []; }
  });
}

// Every persisted or returned value passes through here. Known token values are replaced anywhere;
// any lock_token field is replaced even when its value was never learned (a malformed handoff).
function redact(value, secrets = []) {
  const known = [].concat(secrets).filter(Boolean);
  if (typeof value === 'string') {
    let text = value.replace(TOKEN_FIELD, `$1"${REDACTED}"`);
    for (const secret of known) text = text.split(secret).join(REDACTED);
    return text;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, known));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'lock_token' ? REDACTED : redact(item, known)]));
  return value;
}

const message = error => String(error?.message || error);

function boundMutations(token) {
  if (token === undefined) return null;
  const containers = require('./storage-containers.cjs').bind(token);
  const gate = require('./storage-gate.cjs').bind(token);
  return { attachExisting: containers.attachExisting, detachRetain: containers.detachRetain, releasePreparedAllocation: gate.releasePreparedAllocation };
}

async function runCertified(candidateRef, allocationFile, options = {}) {
  const { mutationCapability, ...boundaries } = options;
  const io = { root: ROOT, now: () => Date.now(), run: runOwnedSync, quiet, environment: launchEnvironment, ...boundaries };
  if (!io.git) io.git = args => git(args, io.root);
  const load = (name, file) => io[name] || (io[name] = require(file));
  const secrets = new Set();
  let output, admission, lock, mutations, packet;
  let phase = 'preflight', nativeStarted = false, fullStarted = false;
  const terminal = { schema: 1, status: 1, disposition: 'REFUSED', candidate_sha: null,
    gate_code_sha: null, phases: [], cleanup: [], certification: 'NOT_CERTIFIED' };
  const sanitize = value => redact(value, [...secrets]);
  const persist = () => {
    if (output) fs.writeFileSync(path.join(output, 'terminal.json'), JSON.stringify(sanitize(terminal), null, 2) + '\n', { mode: 0o600 });
  };
  const write = (name, content) => fs.writeFileSync(path.join(output, name), sanitize(String(content)), { mode: 0o600, flag: 'wx' });
  // A phase record is durable before the child starts, and its outputs are written before any
  // interpretation, so a malformed or failed child still leaves sanitized evidence.
  const command = (name, args, timeout, childEnvironment, graceMs) => {
    const entry = { name, started_at: new Date(io.now()).toISOString(), finished_at: null, status: null };
    terminal.phases.push(entry); persist();
    const result = io.run(process.execPath, args, { cwd: io.root, env: childEnvironment,
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, graceMs });
    for (const object of jsonObjects(result.stdout)) if (typeof object.lock_token === 'string' && object.lock_token) secrets.add(object.lock_token);
    write(`${name}.stdout.log`, result.stdout || '');
    write(`${name}.stderr.log`, result.stderr || '');
    Object.assign(entry, { finished_at: new Date(io.now()).toISOString(), status: result.status ?? null,
      signal: result.signal || null, error: result.error?.code || null, ownership: result.ownership ?? null });
    persist();
    if (result.error || result.status !== 0) throw new Error(`CERTIFIED_LAUNCH_PHASE:${name}:${result.error?.code || result.status}`);
    return result;
  };
  try {
    mutations = io.mutations || boundMutations(mutationCapability);
    if (!mutations || MUTATIONS.some(name => typeof mutations[name] !== 'function')) throw new Error('CERTIFIED_LAUNCH_MUTATION_CAPABILITY');
    const allocationBytes = io.quiet.readRegular(allocationFile);
    try { packet = JSON.parse(allocationBytes); } catch { throw new Error('CERTIFIED_LAUNCH_ALLOCATION_JSON'); }
    const state = load('state', './storage-state.cjs');
    const containers = load('containers', './storage-containers.cjs');
    const gate = load('gate', './storage-gate.cjs');
    const authority = state.validateInstalledAuthority();
    // Resolved once; every later step and child receives the full SHA, never the mutable reference.
    const candidateSha = io.git(['rev-parse', `${candidateRef}^{commit}`]);
    const gateCodeSha = io.git(['rev-parse', 'HEAD']);
    if (!quiet.SHA.test(candidateSha) || !quiet.SHA.test(gateCodeSha)) throw new Error('CERTIFIED_LAUNCH_SOURCE');
    terminal.candidate_sha = candidateSha; terminal.gate_code_sha = gateCodeSha;
    validateAllocation(packet, { host: authority.host, uid: authority.uid, candidateSha, gateCodeSha }, io.now());
    if (io.git(['remote', 'get-url', 'origin']) !== PUBLIC_ORIGIN
        || io.git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('CERTIFIED_LAUNCH_SOURCE');
    const provenance = load('provenance', './gate-code-provenance.cjs');
    provenance.requirePushedCommit(io.root, candidateSha);
    provenance.requirePushedCommit(io.root, gateCodeSha);
    if (!io.attestTrackedTree) io.attestTrackedTree = require('./storage-cli-bootstrap.cjs').attestTrackedTree;
    io.attestTrackedTree(io.root, gateCodeSha);
    gate.verifyCertified(io.root);
    terminal.reviews = validateReviews(packet, candidateSha, gateCodeSha);
    load('janitor', './storage-janitor-health.cjs').requireJanitorHealthy();
    containers.requireCapacity('start');
    if (state.listRecords('runs').some(run => run.quiet_start?.attempt_id === packet.attempt_id)) throw new Error('CERTIFIED_LAUNCH_ATTEMPT_USED');
    lock = io.lockPath || path.join(require('./storage-authority.cjs').fixedLayout().state, 'gate.lock');
    if (fs.existsSync(lock)) throw new Error('CERTIFIED_LAUNCH_ALLOCATION_UNRESOLVED');
    const outputRoot = io.outputRoot || path.join(io.root, '_artifacts', 'certified-launch');
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(path.join(outputRoot, packet.attempt_id), { mode: 0o700 }); }
    catch (error) { throw new Error(error.code === 'EEXIST' ? 'CERTIFIED_LAUNCH_ATTEMPT_USED' : 'CERTIFIED_LAUNCH_OUTPUT'); }
    output = path.join(outputRoot, packet.attempt_id);
    fs.writeFileSync(path.join(output, 'fd-window.json'), allocationBytes, { flag: 'wx', mode: 0o600 });
    terminal.fd_window_sha256 = quiet.hash(allocationBytes); terminal.attempt_id = packet.attempt_id; persist();

    const environment = io.environment.canonicalChildEnvironment(io.root);
    terminal.environment = io.environment.probeChildEnvironment(io.root, environment); persist();

    phase = 'observation';
    requireWindow(packet, quiet.POLICY.combinedClosingBudgetMs + quiet.POLICY.observerBoundMs, io.now());
    const observation = path.join(output, 'observation');
    command('observer', [path.join(io.root, 'scripts/observe-mobile-quiet.cjs'), path.join(output, 'fd-window.json'), observation],
      quiet.POLICY.observerBoundMs, environment, OBSERVER_GRACE_MS);
    const childEnvironment = { ...environment, PENTACLE_GATE_QUIET_RECEIPT: path.join(observation, 'receipt.json') };
    const start = io.quiet.inspectNativeStart(io.root, candidateSha, childEnvironment, authority, state.listRecords('runs'), io.now());
    if (start.claim.attempt_id !== packet.attempt_id || start.windowDigest !== terminal.fd_window_sha256) throw new Error('CERTIFIED_LAUNCH_RECEIPT_BINDING');
    terminal.quiet_start = { receipt_sha256: start.receiptDigest, raw_evidence_digest: start.rawDigest,
      observed_finished_at: start.claim.observed_finished_at }; persist();

    phase = 'native';
    nativeStarted = true;
    const native = command('native-root', [path.join(io.root, 'scripts/storage-cli.cjs'), 'gate:native-root', candidateSha],
      ENDPOINT_BOUND_MS, childEnvironment, ENDPOINT_GRACE_MS);
    const handoff = jsonObjects(native.stdout).filter(object => quiet.UUID.test(object.run_id || '') && TOKEN.test(object.lock_token || ''));
    if (handoff.length !== 1) throw new Error('CERTIFIED_LAUNCH_NATIVE_HANDOFF');
    admission = { run_id: handoff[0].run_id, token: handoff[0].lock_token };
    terminal.run_id = admission.run_id; persist();

    phase = 'full';
    io.quiet.requireAllocatedStart(admission.run_id, io.root, io.now());
    fullStarted = true;
    let fullFailure;
    try {
      command('full', [path.join(io.root, 'scripts/storage-cli.cjs'), 'gate:full', admission.run_id, admission.token],
        ENDPOINT_BOUND_MS, { ...childEnvironment, PENTACLE_BUILD_NUMBER: '1' }, ENDPOINT_GRACE_MS);
    } catch (error) { fullFailure = error; }
    // The full payload is diagnostic whatever the exit status: retain it before judging it.
    const stdout = fs.readFileSync(path.join(output, 'full.stdout.log'), 'utf8');
    const results = jsonObjects(stdout).filter(object => object.run_id === admission.run_id);
    if (results.length) {
      const bytes = JSON.stringify(sanitize(results.at(-1)), null, 2) + '\n';
      write('full-result.json', bytes);
      const value = results.at(-1);
      terminal.full_result = { count: results.length, status: value.status ?? null, evidence_digest: value.evidence_digest ?? null,
        candidate_sha: value.candidate_sha ?? null, gate_code_sha: value.gate_code_sha ?? null, sha256: quiet.hash(bytes) };
      persist();
    }
    if (fullFailure) throw fullFailure;
    const result = results[0];
    if (results.length !== 1 || result.status !== 0 || !quiet.DIGEST.test(result.evidence_digest || '')
        || result.candidate_sha !== candidateSha || result.gate_code_sha !== gateCodeSha) throw new Error('CERTIFIED_LAUNCH_FULL_RESULT');

    phase = 'verification';
    requireWindow(packet, 0, io.now());
    const run = state.readRecord('runs', admission.run_id);
    const journal = JSON.stringify(run);
    if (run.id !== admission.run_id || run.gate_status !== 0 || run.state !== 'scratch_discarded' || run.evidence_digest !== result.evidence_digest
        || run.candidate_ref !== candidateSha || run.gate_code_sha !== gateCodeSha || !run.quiet_start
        || run.quiet_start.attempt_id !== packet.attempt_id || run.quiet_start.fd_window_sha256 !== terminal.fd_window_sha256
        || run.quiet_start.receipt_sha256 !== start.receiptDigest) throw new Error('CERTIFIED_LAUNCH_PUBLICATION');
    // Inspect before attaching: an evidence image already attached is not ours to layer over or detach.
    containers.assertImageDetached('evidence', run.id);
    const mounted = mutations.attachExisting('evidence', run.id);
    let verifyFailure;
    try {
      containers.requireSeal(mounted.seal, run.evidence_seal);
      gate.verifyRetainedEvidence(run);
      io.quiet.validateClaimEvidence(mounted.mount, run);
    } catch (error) { verifyFailure = error; }
    try {
      mutations.detachRetain('evidence', run.id, run.evidence_seal);
      containers.assertImageDetached('evidence', run.id);
      terminal.cleanup.push({ name: 'evidence-detach', status: 'passed' });
    } catch (cleanupError) {
      terminal.cleanup.push({ name: 'evidence-detach', status: 'failed', error: message(cleanupError) });
    }
    if (verifyFailure) throw verifyFailure;
    if (terminal.cleanup.some(check => check.status === 'failed')) throw new Error('CERTIFIED_LAUNCH_CLEANUP');
    // The journal record and the observation receipt must be unchanged by verification.
    if (JSON.stringify(state.readRecord('runs', admission.run_id)) !== journal) throw new Error('CERTIFIED_LAUNCH_JOURNAL_DRIFT');
    if (quiet.hash(io.quiet.readRegular(path.join(observation, 'receipt.json'))) !== run.quiet_start.receipt_sha256) throw new Error('CERTIFIED_LAUNCH_RECEIPT_DRIFT');
    if (fs.existsSync(lock)) throw new Error('CERTIFIED_LAUNCH_CLEANUP');
    terminal.evidence_digest = run.evidence_digest;
  } catch (error) {
    terminal.error = message(error); terminal.failed_phase = phase;
  }
  // Exact cleanup ownership. Before native-root nothing is allocated. A failed native-root owns its
  // own cleanup and gave no token, so an allocation left behind is reported, never released here.
  // After a valid handoff the facade owns the allocation until gate:full, whose wrapper then owns it;
  // only a lock still present afterwards is released here, through the ownership-checked release.
  if (nativeStarted) {
    const present = fs.existsSync(lock);
    if (!admission) {
      terminal.cleanup.push(present
        ? { name: 'native-allocation', status: 'failed', error: 'CERTIFIED_LAUNCH_ALLOCATION_UNOWNED' }
        : { name: 'native-allocation', status: 'passed', owner: 'gate:native-root' });
    } else if (fullStarted && !present) {
      terminal.cleanup.push({ name: 'prepared-allocation', status: 'passed', owner: 'gate:full' });
    } else {
      try {
        const receipt = mutations.releasePreparedAllocation(admission.run_id, admission.token);
        terminal.cleanup.push({ name: 'prepared-allocation', status: 'passed', owner: 'certified-launch', receipt });
      } catch (cleanupError) {
        terminal.cleanup.push({ name: 'prepared-allocation', status: 'failed', owner: 'certified-launch', error: message(cleanupError) });
      }
    }
  }
  const cleanupFailed = terminal.cleanup.some(check => check.status === 'failed');
  if (!terminal.error && packet) {
    try { requireWindow(packet, 0, io.now()); }
    catch (error) { terminal.error = message(error); terminal.failed_phase = 'closing-window'; }
  }
  if (!terminal.error && !cleanupFailed) {
    terminal.status = 0; terminal.disposition = 'CERTIFIED'; terminal.certification = 'CERTIFIED';
  } else {
    if (!terminal.error) { terminal.error = 'CERTIFIED_LAUNCH_CLEANUP'; terminal.failed_phase = phase; }
    terminal.disposition = cleanupFailed ? 'CLEANUP_INCOMPLETE' : nativeStarted ? 'FAILED' : 'REFUSED';
  }
  terminal.finished_at = new Date(io.now()).toISOString();
  try { persist(); } catch (persistError) {
    terminal.status = 1; terminal.disposition = 'CLEANUP_INCOMPLETE'; terminal.certification = 'NOT_CERTIFIED';
    terminal.persist_error = message(persistError);
  }
  return sanitize(terminal);
}

module.exports = { MUTATIONS, readReference, validateAllocation, validateReviews, requireWindow, jsonObjects, redact, runCertified, ENDPOINT_BOUND_MS, ENDPOINT_GRACE_MS, OBSERVER_GRACE_MS };
