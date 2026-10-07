'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const quiet = require('./certified-start-receipt.cjs');
const { canonicalChildEnvironment, probeChildEnvironment } = require('./certified-launch-environment.cjs');
const { runOwnedSync } = require('./owned-process.cjs');

const ROOT = path.resolve(__dirname, '..');
const ENDPOINT_BOUND_MS = 10800000;
const ENDPOINT_GRACE_MS = 120000;
const mutationCapability = require('./storage-capability.cjs').claim();

function git(args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) delete env[name];
  const result = spawnSync('/usr/bin/git', args, { cwd: ROOT, env, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('CERTIFIED_LAUNCH_SOURCE');
  return result.stdout.trim();
}

function readReference(reference) {
  if (!reference || !path.isAbsolute(reference.path || '') || !quiet.DIGEST.test(reference.sha256 || '')) throw new Error('CERTIFIED_LAUNCH_REFERENCE');
  const bytes = quiet.readRegular(reference.path);
  if (quiet.hash(bytes) !== reference.sha256) throw new Error('CERTIFIED_LAUNCH_REFERENCE_DIGEST');
  try { return JSON.parse(bytes); } catch { throw new Error('CERTIFIED_LAUNCH_REFERENCE_JSON'); }
}

function validateAllocation(packet, expected, now = Date.now()) {
  if (!packet || packet.schema !== 1 || packet.fd_go !== true || !quiet.UUID.test(packet.tell_id || '')
      || !quiet.UUID.test(packet.attempt_id || '') || typeof packet.from_stream !== 'string' || !packet.from_stream) throw new Error('CERTIFIED_LAUNCH_ALLOCATION');
  if (packet.host !== expected.host || packet.uid !== expected.uid || packet.candidate_sha !== expected.candidateSha
      || packet.gate_code_sha !== expected.gateCodeSha || packet.policy_revision !== quiet.POLICY.revision) throw new Error('CERTIFIED_LAUNCH_ALLOCATION_BINDING');
  if (!Number.isFinite(packet.not_before_epoch) || !Number.isFinite(packet.expires_epoch)
      || now < packet.not_before_epoch * 1000 || packet.expires_epoch * 1000 - now < quiet.POLICY.combinedClosingBudgetMs + quiet.POLICY.observerBoundMs) throw new Error('CERTIFIED_LAUNCH_WINDOW');
  return packet;
}

function validateReviews(packet, candidateSha) {
  const source = readReference(packet.source_qa);
  const review = source.report || source;
  if (review.qa_verdict !== 'accept' || review.target_sha !== candidateSha || !review.report_id) throw new Error('CERTIFIED_LAUNCH_SOURCE_QA');
  const policy = readReference(packet.policy_qa);
  const policyReview = policy.report || policy;
  if (policyReview.qa_verdict !== 'accept' || policyReview.report_id !== packet.policy_qa.report_id) throw new Error('CERTIFIED_LAUNCH_POLICY_QA');
  const ci = readReference(packet.ci);
  if (ci.head_sha !== candidateSha || ci.conclusion !== 'success') throw new Error('CERTIFIED_LAUNCH_CI');
  return { source_report_id: review.report_id, policy_report_id: policyReview.report_id,
    source_receipt_sha256: packet.source_qa.sha256, policy_receipt_sha256: packet.policy_qa.sha256, ci_receipt_sha256: packet.ci.sha256 };
}

function jsonObjects(output) {
  return String(output || '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function redact(value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[REDACTED_LOCK_TOKEN]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'lock_token' ? '[REDACTED_LOCK_TOKEN]' : redact(item, token)]));
  return value;
}

async function runCertified(candidateRef, allocationFile) {
  let output, admission, token, environment, authority;
  let phase = 'preflight';
  const terminal = { schema: 1, status: 1, disposition: 'REFUSED', candidate_sha: null,
    gate_code_sha: null, phases: [], cleanup: [], certification: 'NOT_CERTIFIED' };
  const persist = () => {
    if (output) fs.writeFileSync(path.join(output, 'terminal.json'), JSON.stringify(redact(terminal, token), null, 2) + '\n', { mode: 0o600 });
  };
  const command = (name, args, timeout, childEnvironment = environment) => {
    const started = new Date().toISOString();
    const result = runOwnedSync(process.execPath, args, { cwd: ROOT, env: childEnvironment,
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, graceMs: name === 'observer' ? 2000 : ENDPOINT_GRACE_MS });
    // Parse opaque handoff only in memory; all persisted/public outputs are redacted.
    if (name === 'native-root' && result.status === 0) {
      const objects = jsonObjects(result.stdout).filter(object => quiet.UUID.test(object.run_id || '') && /^[0-9a-f]{64}$/.test(object.lock_token || ''));
      if (objects.length !== 1) throw new Error('CERTIFIED_LAUNCH_NATIVE_HANDOFF');
      admission = objects[0]; token = admission.lock_token;
    }
    fs.writeFileSync(path.join(output, `${name}.stdout.log`), redact(result.stdout || '', token), { mode: 0o600 });
    fs.writeFileSync(path.join(output, `${name}.stderr.log`), redact(result.stderr || '', token), { mode: 0o600 });
    terminal.phases.push({ name, started_at: started, finished_at: new Date().toISOString(),
      status: result.status, error: result.error?.code || null, ownership: redact(result.ownership, token) }); persist();
    if (result.error || result.status !== 0) {
      const error = new Error(`CERTIFIED_LAUNCH_PHASE:${name}:${result.error?.code || result.status}`);
      error.phaseStatus = result.status; throw error;
    }
    return result;
  };
  try {
    const allocationBytes = quiet.readRegular(allocationFile);
    let packet; try { packet = JSON.parse(allocationBytes); } catch { throw new Error('CERTIFIED_LAUNCH_ALLOCATION_JSON'); }
    authority = require('./storage-state.cjs').validateInstalledAuthority();
    const candidateSha = git(['rev-parse', `${candidateRef}^{commit}`]);
    const gateCodeSha = git(['rev-parse', 'HEAD']);
    terminal.candidate_sha = candidateSha; terminal.gate_code_sha = gateCodeSha;
    validateAllocation(packet, { host: authority.host, uid: authority.uid, candidateSha, gateCodeSha });
    if (git(['remote', 'get-url', 'origin']) !== 'https://github.com/HJK6/pentacle-mobile.git'
        || git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('CERTIFIED_LAUNCH_SOURCE');
    require('./gate-code-provenance.cjs').requirePushedCommit(ROOT, candidateSha);
    require('./gate-code-provenance.cjs').requirePushedCommit(ROOT, gateCodeSha);
    require('./storage-gate.cjs').verifyCertified(ROOT);
    const reviews = validateReviews(packet, candidateSha); terminal.reviews = reviews;
    require('./storage-janitor-health.cjs').requireJanitorHealthy();
    require('./storage-containers.cjs').requireCapacity('start');
    const runs = require('./storage-state.cjs').listRecords('runs');
    if (runs.some(run => run.quiet_start?.attempt_id === packet.attempt_id)) throw new Error('CERTIFIED_LAUNCH_ATTEMPT_USED');
    const lock = path.join(require('./storage-authority.cjs').fixedLayout().state, 'gate.lock');
    if (fs.existsSync(lock)) throw new Error('CERTIFIED_LAUNCH_ALLOCATION_UNRESOLVED');
    output = path.join(ROOT, '_artifacts', 'certified-launch', packet.attempt_id);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (fs.existsSync(output)) throw new Error('CERTIFIED_LAUNCH_ATTEMPT_USED');
    fs.mkdirSync(output, { mode: 0o700 });
    fs.writeFileSync(path.join(output, 'fd-window.json'), allocationBytes, { flag: 'wx', mode: 0o600 });
    terminal.fd_window_sha256 = quiet.hash(allocationBytes); terminal.attempt_id = packet.attempt_id; persist();
    environment = canonicalChildEnvironment(ROOT);
    terminal.environment = probeChildEnvironment(ROOT, environment); persist();
    phase = 'observation';
    const observation = path.join(output, 'observation');
    command('observer', [path.join(ROOT, 'scripts/observe-mobile-quiet.cjs'), path.join(output, 'fd-window.json'), observation], 120000);
    environment.PENTACLE_GATE_QUIET_RECEIPT = path.join(observation, 'receipt.json');
    quiet.inspectNativeStart(ROOT, candidateRef, environment, authority, runs);
    phase = 'native';
    command('native-root', [path.join(ROOT, 'scripts/storage-cli.cjs'), 'gate:native-root', candidateRef], ENDPOINT_BOUND_MS);
    terminal.run_id = admission.run_id; persist();
    phase = 'full';
    quiet.requireAllocatedStart(admission.run_id, ROOT);
    const result = command('full', [path.join(ROOT, 'scripts/storage-cli.cjs'), 'gate:full', admission.run_id, token], ENDPOINT_BOUND_MS,
      { ...environment, PENTACLE_BUILD_NUMBER: '1' });
    const full = jsonObjects(result.stdout).find(object => object.run_id === admission.run_id);
    if (!full || full.status !== 0 || !quiet.DIGEST.test(full.evidence_digest || '')) throw new Error('CERTIFIED_LAUNCH_FULL_RESULT');
    phase = 'verification';
    const run = require('./storage-state.cjs').readRecord('runs', admission.run_id);
    if (run.gate_status !== 0 || run.state !== 'scratch_discarded' || run.evidence_digest !== full.evidence_digest || !run.quiet_start) throw new Error('CERTIFIED_LAUNCH_PUBLICATION');
    const containers = require('./storage-containers.cjs');
    const mounted = containers.bind(mutationCapability).attachExisting('evidence', run.id, run.evidence_seal);
    try {
      require('./storage-gate.cjs').verifyRetainedEvidence(run);
      quiet.validateClaimEvidence(mounted.mount, run);
    } finally {
      containers.bind(mutationCapability).detachRetain('evidence', run.id, run.evidence_seal);
    }
    containers.assertImageDetached('evidence', run.id);
    if (fs.existsSync(lock)) throw new Error('CERTIFIED_LAUNCH_CLEANUP');
    terminal.status = 0; terminal.disposition = 'CERTIFIED'; terminal.certification = 'CERTIFIED';
    terminal.evidence_digest = run.evidence_digest;
    terminal.cleanup.push({ name: 'retained-evidence-verification-and-detach', status: 'passed' });
  } catch (error) {
    terminal.error = String(error.message || error); terminal.failed_phase = phase;
    terminal.disposition = ['preflight', 'observation'].includes(phase) ? 'REFUSED' : 'FAILED';
    if (admission) {
      try {
        await require('./storage-gate.cjs').bind(mutationCapability).withPreparedAllocation(admission.run_id, token, async () => undefined);
        terminal.cleanup.push({ name: 'prepared-allocation', status: 'passed' });
      } catch (cleanupError) {
        terminal.cleanup.push({ name: 'prepared-allocation', status: 'failed', error: String(cleanupError.message || cleanupError) });
        terminal.disposition = 'CLEANUP_INCOMPLETE';
      }
    }
  } finally {
    terminal.finished_at = new Date().toISOString(); persist();
  }
  return redact(terminal, token);
}

module.exports = { validateAllocation, validateReviews, jsonObjects, redact, runCertified, ENDPOINT_BOUND_MS, ENDPOINT_GRACE_MS };
