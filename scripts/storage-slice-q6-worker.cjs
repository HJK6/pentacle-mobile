'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const [scenario, ...scenarioArgs] = process.argv.slice(2);
const scenarios = new Set([
  'digest-mismatch', 'bound-forward', 'janitor-binding', 'bootout-failure', 'bootout-unverified',
  'janitor-init', 'janitor-seed', 'janitor-once', 'janitor-hold', 'janitor-contender',
  'report-before-rename', 'report-after-rename', 'report-after-directory-fsync',
  'evidence-chain', 'unknown-preserve',
]);
if (!scenarios.has(scenario)) throw new Error('Q6_ARGUMENT');
fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });

let reportDirectory;
let smokeBinding;
childProcess.spawnSync = (binary, args) => {
  const action = args?.[0];
  if (scenario === 'bootout-failure' && action === 'bootout') return { status: 1, stderr: 'forced bootout failure' };
  if (action === 'kickstart') {
    const reportId = crypto.randomUUID();
    fs.writeFileSync(path.join(reportDirectory, `${reportId}.json`), `${JSON.stringify({ schema: 1, report_id: reportId, mode: 'dry-run', entries: [], errors: [], completed_at: new Date().toISOString(), ...smokeBinding })}\n`);
  }
  return { status: 0, stdout: '', stderr: '' };
};

const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const layout = fixedLayout();
for (const target of [layout.support, layout.stateImage, layout.state, layout.worktrees, layout.memory, ...Object.values(layout.repositories), path.dirname(layout.launchAgent)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const authority = fs.existsSync(path.join(layout.state, 'authority.json')) ? state.readAuthorityState() : stateMutations.createInstalledAuthority();

function waitFor(file, timeoutMs = 5000) {
  const delay = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('Q6_WAIT_TIMEOUT');
    Atomics.wait(delay, 0, 0, 10);
  }
}

if (scenario === 'janitor-init') {
  for (const name of ['runs', 'tickets', 'scheduler', 'reports']) fs.mkdirSync(path.join(layout.state, name), { recursive: true, mode: 0o700 });
  process.stdout.write(`${authority.generation}\n`);
  process.exit(0);
}

if (scenario === 'janitor-seed') {
  for (const name of ['runs', 'tickets', 'scheduler', 'reports']) fs.mkdirSync(path.join(layout.state, name), { recursive: true, mode: 0o700 });
  const runId = '11111111-1111-4111-8111-111111111111';
  const ticketId = '22222222-2222-4222-8222-222222222222';
  const createdAt = '2026-07-17T00:00:00.000Z';
  let run = stateMutations.createRecord('runs', {
    schema: 1, id: runId, revision: 0, state: 'reserved', generation: authority.generation,
    owner: { host: require('node:os').hostname(), uid: process.getuid(), pid: process.pid },
    candidate_ref: 'a'.repeat(40), gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${runId}.sparsebundle`, evidence_image: `${runId}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64), reserved_at: createdAt, first_dead_at: null,
  });
  stateMutations.createRecord('tickets', {
    schema: 1, id: ticketId, revision: 0, state: 'registered', generation: authority.generation,
    main_repo_id: 'pentacle-mobile', spec_id: 'spec_ac235', lane_id: 'ac235-lane', branch: 'fix/ac235',
    upstream: 'origin/fix/ac235', head: 'c'.repeat(40), source_digest: 'd'.repeat(64), basename: 'ac235-lane',
    device: '1', inode: '2', registered_at: createdAt,
    creator: { host: require('node:os').hostname(), uid: process.getuid(), pid: process.pid },
  });
  for (const root of [path.join(layout.scratchImages, `${runId}.sparsebundle`), path.join(layout.evidenceImages, `${runId}.sparsebundle`)]) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'band'), 'seeded-apply-owned-bytes\n');
  }
  const scratchRoot = path.join(layout.scratchImages, `${runId}.sparsebundle`);
  const evidenceRoot = path.join(layout.evidenceImages, `${runId}.sparsebundle`);
  const deviceSet = path.join(layout.support, 'fixture-device-set');
  fs.mkdirSync(deviceSet, { recursive: true, mode: 0o700 });
  run = stateMutations.transitionRun(runId, run.revision, 'allocated', {
    scratch_seal: { object_id: crypto.randomUUID(), image: state.canonicalIdentity(scratchRoot) },
    evidence_seal: { object_id: crypto.randomUUID(), image: state.canonicalIdentity(evidenceRoot) },
    device_set_identity: state.canonicalIdentity(deviceSet), allocated_at: createdAt,
  });
  run = stateMutations.transitionRun(runId, run.revision, 'running', { handoff_from_pid: process.pid, running_at: createdAt });
  run = stateMutations.transitionRun(runId, run.revision, 'sealing', { gate_status: 17, failure: 'fixture failure', sealing_at: createdAt });
  stateMutations.transitionRun(runId, run.revision, 'blocked_unclassified', { classification_error: 'fixture unclassified' });
  fs.writeFileSync(path.join(layout.state, 'gate.lock'), 'seeded-gate-lock\n', { mode: 0o600 });
  process.stdout.write(`${runId}\n`);
  process.exit(0);
}

if (['janitor-once', 'janitor-hold', 'janitor-contender', 'report-before-rename', 'report-after-rename', 'report-after-directory-fsync'].includes(scenario)) {
  const reportDirectory = path.join(layout.state, 'reports');
  fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const originalWriteFileSync = fs.writeFileSync;
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalRenameSync = fs.renameSync;
  const descriptors = new Map();
  let reportRenamed = false;

  if (scenario === 'janitor-hold') {
    const [ready, release] = scenarioArgs;
    fs.writeFileSync = (target, ...args) => {
      const result = originalWriteFileSync(target, ...args);
      if (String(target) === path.join(layout.state, 'janitor.lock')) {
        originalWriteFileSync(ready, 'ready');
        waitFor(release);
      }
      return result;
    };
  }
  if (scenario.startsWith('report-')) {
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpenSync(target, ...args);
      descriptors.set(descriptor, String(target));
      return descriptor;
    };
    fs.closeSync = (descriptor, ...args) => {
      const result = originalCloseSync(descriptor, ...args);
      descriptors.delete(descriptor);
      return result;
    };
    fs.renameSync = (source, destination) => {
      const isReport = path.dirname(String(destination)) === reportDirectory && String(destination).endsWith('.json');
      if (isReport && scenario === 'report-before-rename') process.exit(23);
      const result = originalRenameSync(source, destination);
      if (isReport) reportRenamed = true;
      if (isReport && scenario === 'report-after-rename') process.exit(23);
      return result;
    };
    fs.fsyncSync = (descriptor, ...args) => {
      const result = originalFsyncSync(descriptor, ...args);
      if (scenario === 'report-after-directory-fsync' && reportRenamed && descriptors.get(descriptor) === reportDirectory) process.exit(23);
      return result;
    };
  }

  const janitor = require('./storage-janitor.cjs').bind(mutationCapability);
  const now = Date.parse(scenarioArgs.at(-1) || '2026-07-22T00:00:00.000Z');
  if (scenario === 'janitor-contender') {
    try { janitor.runJanitor('dry-run', now); throw new Error('Q6_SINGLETON_CONTENDER_ADMITTED'); }
    catch (error) {
      if (error.message !== 'JANITOR_ALREADY_RUNNING') throw error;
      process.stdout.write('JANITOR_ALREADY_RUNNING\n');
    }
  } else {
    const report = janitor.runJanitor('dry-run', now);
    process.stdout.write(`${report.report_id}\n`);
  }
  process.exit(0);
}

if (['evidence-chain', 'unknown-preserve'].includes(scenario)) {
  const evidence = path.join(layout.support, 'fixture-evidence');
  const scratchImage = path.join(layout.support, 'absent-scratch.sparsebundle');
  fs.mkdirSync(path.join(evidence, 'ios-export'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(evidence, '.pentacle-container.json'), '{}\n');
  fs.writeFileSync(path.join(evidence, 'run.json'), `${JSON.stringify({
    status: 'failed', gates: [], sha: 'a'.repeat(40), candidate_sha: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
  })}\n`);
  fs.writeFileSync(path.join(evidence, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: [] })}\n`);
  const payload = path.join(evidence, 'ios-export', 'payload.bin');
  fs.writeFileSync(payload, 'abc');
  const runId = '33333333-3333-4333-8333-333333333333';
  let attachments = 0;
  let discards = 0;
  let currentRun = {
    id: runId, revision: 7, state: 'scratch_discarding', gate_status: 17,
    candidate_ref: 'a'.repeat(40), gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    published_at: '2026-07-01T00:00:00.000Z', evidence_seal: { fixture: true },
  };
  const containers = require('./storage-containers.cjs');
  containers.imagePath = (kind) => kind === 'scratch' ? scratchImage : evidence;
  containers.requireSeal = () => true;
  containers.resolveMounted = () => { attachments += 1; return { mount: evidence, seal: { fixture: true } }; };
  containers.bind = () => ({
    attachExisting: () => ({ mount: evidence, seal: { fixture: true } }), createImage: () => {},
    detachAndDiscard: () => { discards += 1; }, detachRetain: () => {}, ensureStateImage: () => {}, recoverOrCreate: () => ({ mount: evidence, seal: { fixture: true } }),
  });
  state.readRecord = () => currentRun;
  state.validateInstalledAuthority = () => authority;
  state.bind = () => ({
    createRecord: () => {}, recoverAtomicTemps: () => [], replaceRecord: () => currentRun, rotateTerminal: () => [],
    transitionRun: (_id, revision, nextState, patch = {}) => {
      currentRun = { ...currentRun, ...patch, revision: revision + 1, state: nextState };
      return currentRun;
    },
    withRecordMutation: (_kind, _id, action) => action(),
  });
  delete require.cache[require.resolve('./storage-gate.cjs')];
  const gate = require('./storage-gate.cjs');
  fs.writeFileSync(path.join(evidence, 'storage-surface-trigger.json'), `${JSON.stringify({
    schema: 1, run_id: runId, status: 'skipped', reason: 'case-results-incomplete', observed_results: 0,
    required_results: gate.reportViewerResultsBeforeKeyboard(), launch: { status: 'not-attempted', error: null, pids: [] },
    cleanup: { status: 'not-required', error: null, outcomes: [] }, completed_at: '2026-07-01T00:00:00.000Z',
  })}\n`);
  currentRun.preliminary_evidence_digest = gate.preliminaryEvidenceDigest(evidence, runId, 17);
  if (!gate.verifyPreliminaryEvidence(currentRun)) throw new Error('Q6_PRELIMINARY_NOT_VERIFIED');
  const finalized = gate.bind(mutationCapability).finalizeScratchDiscard(runId, Date.parse('2026-07-01T00:00:01.000Z'));
  const manifest = JSON.parse(fs.readFileSync(path.join(evidence, 'manifest-v1.json'), 'utf8'));
  const payloadEntry = manifest.files.find((entry) => entry.relative === 'ios-export/payload.bin');
  if (payloadEntry?.sha256 !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('Q6_PAYLOAD_DIGEST');
  const manifestDigest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (finalized.evidence_digest !== manifestDigest || !gate.verifyRetainedEvidence(finalized) || attachments < 3) throw new Error('Q6_EVIDENCE_CHAIN');

  if (scenario === 'unknown-preserve') {
    const unknown = path.join(evidence, 'unknown.bin');
    fs.writeFileSync(unknown, 'unknown-preserved-bytes\n');
    const before = { digest: crypto.createHash('sha256').update(fs.readFileSync(unknown)).digest('hex'), inode: String(fs.statSync(unknown).ino) };
    currentRun = finalized;
    delete require.cache[require.resolve('./storage-janitor.cjs')];
    const janitor = require('./storage-janitor.cjs').bind(mutationCapability);
    try { janitor.discardEvidence(runId, Date.parse('2026-08-15T00:00:00.000Z')); throw new Error('Q6_UNKNOWN_DISCARD_ADMITTED'); }
    catch (error) { if (error.message !== 'EVIDENCE_RETAINED_DIGEST_DRIFT') throw error; }
    const after = { digest: crypto.createHash('sha256').update(fs.readFileSync(unknown)).digest('hex'), inode: String(fs.statSync(unknown).ino) };
    if (JSON.stringify(after) !== JSON.stringify(before) || discards !== 0 || !fs.existsSync(evidence)) throw new Error('Q6_UNKNOWN_NOT_PRESERVED');
    process.stdout.write(`${JSON.stringify({ error: 'EVIDENCE_RETAINED_DIGEST_DRIFT', preserved: true })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ payload_sha256: payloadEntry.sha256, evidence_digest: finalized.evidence_digest, state: finalized.state, attachments })}\n`);
  }
  process.exit(0);
}

const scheduler = require('./storage-scheduler.cjs');
const schedulerMutations = scheduler.bind(mutationCapability);
reportDirectory = path.join(layout.state, 'reports');
fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
fs.writeFileSync(layout.launchAgent, scheduler.renderPlist(), { mode: 0o600 });
const transactionId = crypto.randomUUID();
const clock = new Date().toISOString();

if (['digest-mismatch', 'bound-forward', 'janitor-binding'].includes(scenario)) {
  const candidateDigest = scenario === 'digest-mismatch' ? 'a'.repeat(64) : crypto.createHash('sha256').update(scheduler.renderPlist()).digest('hex');
  smokeBinding = { transaction_id: transactionId, generation: authority.generation, candidate_digest: candidateDigest };
  stateMutations.createRecord('scheduler', { schema: 1, id: transactionId, revision: 0, state: 'candidate_installed', generation: authority.generation, action: 'install', prior_owned: false, prior_content: null, prior_loaded: false, created_at: clock, candidate_digest: candidateDigest });
  if (scenario === 'janitor-binding') {
    const report = require('./storage-janitor.cjs').bind(mutationCapability).runJanitor('dry-run');
    for (const [field, value] of Object.entries(smokeBinding)) if (report[field] !== value) throw new Error(`Q6_REPORT_BINDING:${field}`);
    process.stdout.write('janitor-bound\n');
    process.exit(0);
  }
  schedulerMutations.recoverCommitted();
  const current = state.readRecord('scheduler', transactionId);
  if (scenario === 'digest-mismatch' && current.state === 'committed') { process.stderr.write('Q6_UNBOUND_DIGEST_COMMITTED\n'); process.exitCode = 1; }
  else if (scenario === 'bound-forward' && current.state !== 'committed') { process.stderr.write('Q6_BOUND_DIGEST_NOT_COMMITTED\n'); process.exitCode = 1; }
  else process.stdout.write(`${current.state}\n`);
} else {
  stateMutations.transitionInstalledAuthority('installed', 'updating');
  stateMutations.createRecord('scheduler', { schema: 1, id: transactionId, revision: 0, state: 'rolling_back', generation: authority.generation, action: 'update', prior_owned: true, prior_content: '<plist>prior</plist>\n', prior_loaded: true, created_at: clock, candidate_digest: crypto.createHash('sha256').update(scheduler.renderPlist()).digest('hex'), failure: 'forced' });
  try { schedulerMutations.recoverCommitted(); process.stderr.write('Q6_BOOTOUT_FAILURE_SWALLOWED\n'); process.exitCode = 1; }
  catch (error) {
    const expected = scenario === 'bootout-failure' ? /SCHEDULER_COMMAND_FAILED.*launchctl/ : /SCHEDULER_BOOTOUT_UNVERIFIED/;
    if (!expected.test(String(error.message || error))) throw error;
    if (state.readRecord('scheduler', transactionId).state !== 'rolling_back') throw new Error('Q6_ROLLBACK_COMMITTED');
    process.stdout.write('bootout-failed-closed\n');
  }
}
