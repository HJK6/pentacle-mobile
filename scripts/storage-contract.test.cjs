'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EXPECTED_ENDPOINTS = Object.freeze({
  'storage:install': [],
  'storage:update': [],
  'gate:native-root': ['candidate_ref'],
  'gate:full': ['run_id', 'lock_token'],
  'storage:recover-run': ['run_id'],
  'storage:recover-system-scratch': ['run_id', 'proof_file'],
  'storage:discard-scratch': ['run_id'],
  'storage:reclaim-failed-scratch': ['run_id'],
  'storage:discard-evidence': ['run_id'],
  'storage:dispose-unclassified': ['run_id', 'reason'],
  'storage:dispose-absent-backing': ['run_id', 'reason'],
  'storage:register-worktree': ['main_repo_id', 'spec_id', 'lane_id'],
  'storage:retire-worktree': ['ticket_id'],
  'storage:janitor': ['mode'],
  'storage:restore': [],
  'storage:uninstall': [],
});

test('path-valued storage and gate environment authority is rejected', () => {
  const { rejectEnvironmentAuthority } = require('./storage-authority.cjs');
  assert.equal(rejectEnvironmentAuthority({ PATH: '/usr/bin', HOME: '/Users/test' }), true);
  for (const name of ['PENTACLE_STORAGE_STATE_ROOT', 'PENTACLE_STORAGE_REPORT_DIR', 'PENTACLE_GATE_ARTIFACT_DIR', 'PENTACLE_GATE_NATIVE_ROOT', 'PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT']) {
    assert.throws(() => rejectEnvironmentAuthority({ [name]: '/tmp/escape' }), /FORBIDDEN_AUTHORITY/);
  }
});

test('native preparation preserves the single outer sandbox boundary', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const block = source.slice(source.indexOf("storage-builder-worker.cjs"), source.indexOf("NATIVE_BUILD_FAILED"));
  assert.equal((block.match(/\benv\s*:/g) || []).length, 1);
  assert.match(block, /PENTACLE_STORAGE_SANDBOXED:\s*'1'/);
});

test('worktree tickets cannot contain a resolved path or caller override', () => {
  const { validateRecord } = require('./storage-state.cjs');
  const ticket = { schema: 1, id: '00000000-0000-4000-8000-000000000000', revision: 0, state: 'registered', generation: '00000000-0000-4000-8000-000000000001', main_repo_id: 'pentacle-mobile', spec_id: 'spec_x', lane_id: 'lane', branch: 'fix/lane', upstream: 'origin/fix/lane', head: 'a'.repeat(40), source_digest: 'b'.repeat(64), basename: 'lane', device: '1', inode: '2', registered_at: '2026-07-17T00:00:00.000Z', creator: { host: 'hosta', uid: 501, pid: 42 } };
  assert.equal(validateRecord('tickets', ticket), true);
  for (const field of ['path', 'root', 'resolved_path', 'authorityRoot']) assert.throws(() => validateRecord('tickets', { ...ticket, [field]: '/tmp/tree' }), /UNKNOWN_FIELD/);
});

const EXPECTED_STATES = Object.freeze({
  installed: ['absent', 'prepared', 'installed', 'updating', 'restoring'],
  run: ['reserved', 'allocated', 'running', 'sealing', 'published', 'scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded', 'blocked_unclassified', 'backing_absent'],
  supervisor: ['initial', 'spawned', 'stopping', 'reaping', 'cleaning', 'complete'],
  ticket: ['registered', 'eligible', 'removing', 'removed', 'blocked'],
  scheduler: ['absent', 'prepared', 'candidate_installed', 'smoke_verified', 'committed', 'rolling_back', 'restored'],
});

test('public mutation surface and state models are closed', () => {
  const contract = require('./storage-authority.cjs').CONTRACT;
  assert.deepEqual(contract.endpoints, EXPECTED_ENDPOINTS);
  assert.deepEqual(contract.states, EXPECTED_STATES);
});

test('actual CommonJS and package surfaces expose no unbound mutation helper', () => {
  const expected = {
    'storage-state.cjs': ['RECORD_LIMIT', 'SCHEMA', 'STATE_LIMIT', 'bind', 'canonicalIdentity', 'directoryBytes', 'exactSeal', 'listRecords', 'readAuthorityState', 'readRecord', 'validateAuthorityShape', 'validateInstalledAuthority', 'validateRecord', 'validateStateLayout'],
    'storage-containers.cjs': ['GiB', 'LIMITS', 'MiB', 'assertImageDetached', 'attachedImageAt', 'bind', 'createCapacityGuard', 'enforceCap', 'enforceImageBacking', 'exactDirectoryBytes', 'freeBytes', 'imagePath', 'mountPath', 'requireCapacity', 'requireSeal', 'resolveMounted', 'withinCap'],
    'storage-system-scratch.cjs': ['bind', 'buildOwnership', 'evaluateRecovery'],
    'storage-crash-points.cjs': ['CRASH_EXIT_STATUS', 'CRASH_POINTS', 'armedCrashPoint', 'bind', 'crashPoint'],
    'storage-gate.cjs': ['REPORT_VIEWER_CASE_PLAN', 'assertClosedHostTemporaryClasses', 'assertClosedIdbClasses', 'assertSimE2eCommandNotOverridden', 'bind', 'enumerateEvidence', 'preliminaryEvidenceDigest', 'reportViewerResultsBeforeKeyboard', 'resolveDeviceSet', 'snapshotHostTemporary', 'snapshotIdbArtifacts', 'validateCertifiedStages', 'validateEvidence', 'validateReportViewer', 'verifyCertified', 'verifyPreliminaryEvidence', 'verifyRetainedEvidence', 'withChildStage'],
    'storage-janitor.cjs': ['DAY', 'bind', 'inclusiveElapsed', 'runDecision'],
    'storage-worktrees.cjs': ['DAY', 'STATUSES', 'bind', 'creatorAlive', 'fetchRemote', 'parseFrontmatter', 'parseWorktrees', 'snapshot', 'sourceDigest', 'sourceFolders', 'validateGitFacts'],
    'storage-scheduler.cjs': ['LABEL', 'bind', 'plistOwned', 'renderPlist', 'smokeReport', 'validateSmokeReport'],
    'storage-supervisor.cjs': ['SupervisorMachine', 'bind', 'exitStatus', 'processGroupAlive'],
    'storage-sandbox.cjs': ['bind', 'hostTemporaryRoot', 'idbRoot', 'profileForRun', 'renderProfile'],
    'storage-surface-trigger.cjs': ['bind', 'createCaseCompletionTrigger', 'reportViewerResultCount'],
  };
  const banned = {
    'storage-state.cjs': ['createPreparedAuthority', 'createInstalledAuthority', 'createRecord', 'replaceRecord', 'rotateTerminal', 'recoverAtomicTemps', 'transitionRun', 'transitionInstalledAuthority'],
    'storage-containers.cjs': ['attachExisting', 'createImage', 'detachAndDiscard', 'detachRetain', 'ensureStateImage', 'forceDiscardFailedScratch', 'recoverDiscarding', 'recoverOrCreate'],
    'storage-system-scratch.cjs': ['recover'],
    // Arming a crash point terminates the process at the next crossing, so it belongs to the bound
    // surface for the same reason every other destructive helper does: reachable only from a file the
    // capability allowlist names, never from an ambient caller.
    'storage-crash-points.cjs': ['armCrashPoint'],
    'storage-gate.cjs': ['discardPublishedScratch', 'finalizeScratchDiscard', 'prepareNativeRoot', 'reapHostSimulatorSubstrate', 'reclaimHostTemporary', 'recoverDeadHostLock', 'releasePreparedAllocation', 'withPreparedAllocation', 'runFullGate'],
    'storage-janitor.cjs': ['discardEvidence', 'disposeAbsentBacking', 'reclaimFailedScratch', 'recoverRun', 'runJanitor'],
    'storage-worktrees.cjs': ['registerWorktree', 'retireWorktree', 'retireWorktreeHeld'],
    'storage-scheduler.cjs': ['installOrUpdate', 'recoverCommitted', 'uninstall'],
    'storage-supervisor.cjs': ['supervise'],
    'storage-sandbox.cjs': ['sandboxed'],
    'storage-surface-trigger.cjs': ['mirrorDiagnosticCaseResult', 'terminateOwnedSurface'],
  };
  for (const [file, names] of Object.entries(banned)) {
    const surface = require(`./${file}`);
    for (const name of names) assert.equal(Object.hasOwn(surface, name), false, `${file}:${name}`);
    assert.deepEqual(Object.keys(surface).sort(), expected[file], file);
    assert.throws(() => surface.bind({}), /MUTATION_CAPABILITY_DENIED/, `${file}:bind`);
  }
  const capability = require('./storage-capability.cjs');
  assert.deepEqual(Object.keys(capability).sort(), ['bind', 'claim']);
  assert.throws(() => capability.claim(), /MUTATION_CAPABILITY_DENIED/);
  assert.throws(() => capability.bind({}, {}), /MUTATION_CAPABILITY_DENIED/);
  assert.deepEqual(Object.keys(require('./storage-cli.cjs')).sort(), ['assertClosedOutcomeContract', 'dispatch', 'exitCodeFor', 'inputFor']);
  const scripts = require('../package.json').scripts;
  assert.deepEqual(Object.keys(scripts).filter((name) => name.startsWith('storage:')).sort(), Object.keys(EXPECTED_ENDPOINTS).filter((name) => name.startsWith('storage:')).sort());
});

test('every public endpoint rejects path-shaped and extra authority', () => {
  const { parseEndpoint } = require('./storage-authority.cjs');
  const values = {
    candidate_ref: 'fix/storage-cleanup',
    run_id: '00000000-0000-4000-8000-000000000000',
    ticket_id: '00000000-0000-4000-8000-000000000000',
    lock_token: 'a'.repeat(64),
    main_repo_id: 'pentacle-mobile',
    spec_id: 'spec_storage_cleanup',
    lane_id: 'pentacle-mobile__storage-cleanup',
    mode: 'dry-run',
    reason: 'operator review complete',
    proof_file: '/tmp/owned-recovery-proof.json',
  };
  for (const [endpoint, fields] of Object.entries(EXPECTED_ENDPOINTS)) {
    const accepted = Object.fromEntries(fields.map((field) => [field, values[field]]));
    assert.deepEqual(parseEndpoint(endpoint, accepted), accepted);
    for (const key of ['path', 'root', 'artifact_dir', 'native_root', 'device_set', 'authorityRoot']) {
      assert.throws(() => parseEndpoint(endpoint, { ...accepted, [key]: '/tmp/escape' }), /FORBIDDEN_AUTHORITY/);
    }
    assert.throws(() => parseEndpoint(endpoint, { ...accepted, extra: 'value' }), /FORBIDDEN_AUTHORITY/);
  }
});
