'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const containers = require('./storage-containers.cjs');
const containerMutations = containers.bind(mutationCapability);
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const gate = require('./storage-gate.cjs');
const { dispatch } = require('./storage-cli.cjs');

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`SYNTHETIC_COMMAND:${path.basename(binary)}:${result.status}`);
  return String(result.stdout || '').trim();
}

// Both disposal binaries are redirected, not just trash: scratch is unlinked with /bin/rm and
// evidence is trashed, and this worker's contract is that a synthetic invocation disposes of
// nothing irrecoverably. Redirecting only one of them would also make the synthetic loop pay a
// real recursive delete of two sparsebundles per run (measured +12 s), which pushed the q5 slice
// past its cap under full-suite concurrency.
function recoverableExecute(binary, args, options) {
  if (binary !== '/usr/bin/trash' && binary !== '/bin/rm') return command(binary, args, options);
  const target = args[args.length - 1];
  const destination = path.join(fixedLayout().support, 'RecoverableTrash');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  let recoverablePath = path.join(destination, path.basename(target));
  if (fs.existsSync(recoverablePath)) {
    recoverablePath = path.join(destination, `${path.basename(target)}-${crypto.randomUUID()}`);
  }
  fs.renameSync(target, recoverablePath);
  return '';
}

function detachIfMounted(target) { try { command('/usr/bin/hdiutil', ['detach', target]); } catch {} }

async function invokeWrapper(invocation, authority) {
  const id = crypto.randomUUID();
  const clock = '2026-06-01T00:00:00.000Z';
  let run = stateMutations.createRecord('runs', {
    schema: 1, id, revision: 0, state: 'reserved', generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: process.pid }, candidate_ref: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64), reserved_at: clock, first_dead_at: null,
  });
  const scratch = containerMutations.createImage('scratch', id, recoverableExecute);
  const evidence = containerMutations.createImage('evidence', id, recoverableExecute);
  fs.mkdirSync(path.join(fixedLayout().scratchMount, 'device-set'), { mode: 0o700 });
  fs.writeFileSync(path.join(fixedLayout().scratchMount, `invocation-${invocation}.txt`), 'scratch\n', { flag: 'wx' });
  fs.writeFileSync(path.join(fixedLayout().evidenceMount, 'run.json'), `${JSON.stringify({
    status: 'failed', gates: [], sha: run.candidate_ref, candidate_sha: run.candidate_ref,
    gate_code_sha: run.gate_code_sha, gate_code_tree_clean: run.gate_code_tree_clean,
  })}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(fixedLayout().evidenceMount, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: [] })}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(fixedLayout().evidenceMount, 'storage-surface-trigger.json'), `${JSON.stringify({ schema: 1, run_id: id, status: 'skipped', reason: 'case-results-incomplete', observed_results: 0, required_results: gate.reportViewerResultsBeforeKeyboard(), launch: { status: 'not-attempted', error: null, pids: [] }, cleanup: { status: 'not-required', error: null, outcomes: [] }, completed_at: clock })}\n`, { flag: 'wx' });
  containers.enforceCap('scratch', fixedLayout().scratchMount);
  containers.enforceCap('evidence', fixedLayout().evidenceMount);
  run = stateMutations.transitionRun(id, run.revision, 'allocated', { scratch_seal: scratch.seal, evidence_seal: evidence.seal, device_set_identity: state.canonicalIdentity(path.join(fixedLayout().scratchMount, 'device-set')), allocated_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'running', { handoff_from_pid: process.pid, running_at: clock });
  // Carries a `failure`: this fixture models a run whose gate FAILED and still sealed, and a non-zero
  // gate_status with no stated cause is now an unrepresentable record (storage-state.cjs).
  run = stateMutations.transitionRun(id, run.revision, 'sealing', { gate_status: 1, failure: 'GATE_STATUS_NONZERO:1 child=synthetic', sealing_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'published', { preliminary_audit_at: clock, preliminary_evidence_digest: gate.preliminaryEvidenceDigest(fixedLayout().evidenceMount, id), published_at: clock });
  run = await dispatch('storage:discard-scratch', [id]);
  run = await dispatch('storage:discard-evidence', [id]);
  if (run.state !== 'evidence_discarded') throw new Error('SYNTHETIC_NOT_TERMINAL');
  stateMutations.rotateTerminal('runs', Date.now() + 31 * 86400000);
  return { run, bounded: true };
}

// A run that FAILED: sealed with a non-zero status, classified blocked_unclassified, owner dead. This is
// the shape that accumulates on disk and that discardPublishedScratch can never touch, because it never
// reaches 'published'. Both images are left on disk but detached, as they are after a real failure.
const DEAD_PID = 2147483647;

async function synthesizeFailedRun(authority, ordinal) {
  const id = crypto.randomUUID();
  const clock = `2026-06-02T00:0${ordinal}:00.000Z`;
  let run = stateMutations.createRecord('runs', {
    schema: 1, id, revision: 0, state: 'reserved', generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: DEAD_PID }, candidate_ref: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64), reserved_at: clock, first_dead_at: null,
  });
  const scratch = containerMutations.createImage('scratch', id, recoverableExecute);
  const evidence = containerMutations.createImage('evidence', id, recoverableExecute);
  fs.mkdirSync(path.join(fixedLayout().scratchMount, 'device-set'), { mode: 0o700 });
  fs.writeFileSync(path.join(fixedLayout().scratchMount, `failed-${ordinal}.txt`), 'scratch\n', { flag: 'wx' });
  fs.writeFileSync(path.join(fixedLayout().evidenceMount, 'run.json'), `${JSON.stringify({
    status: 'failed', gates: [], sha: run.candidate_ref, candidate_sha: run.candidate_ref,
    gate_code_sha: run.gate_code_sha, gate_code_tree_clean: run.gate_code_tree_clean,
  })}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(fixedLayout().evidenceMount, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40), derived_sha: 'b'.repeat(40), parent_sha: 'a'.repeat(40), derived_paths: [] })}\n`, { flag: 'wx' });
  containers.enforceCap('scratch', fixedLayout().scratchMount);
  containers.enforceCap('evidence', fixedLayout().evidenceMount);
  run = stateMutations.transitionRun(id, run.revision, 'allocated', { scratch_seal: scratch.seal, evidence_seal: evidence.seal, device_set_identity: state.canonicalIdentity(path.join(fixedLayout().scratchMount, 'device-set')), allocated_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'running', { handoff_from_pid: DEAD_PID, running_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'sealing', { gate_status: 17, failure: 'GATE_STATUS_NONZERO:17 child=synthetic', sealing_at: clock });
  stateMutations.transitionRun(id, run.revision, 'blocked_unclassified', { classification_error: 'SYNTHETIC_UNCLASSIFIED' });
  containerMutations.detachRetain('scratch', id, scratch.seal);
  containerMutations.detachRetain('evidence', id, evidence.seal);
  return { id };
}

// Positive and negative control for the failed-run reclamation edge. The question is not "does it
// delete" but "does it delete ONLY where a record authorises it, and does the record exist afterwards".
async function reclaimControls(authority) {
  const runs = [];
  for (let ordinal = 0; ordinal < 3; ordinal += 1) runs.push(await synthesizeFailedRun(authority, ordinal));
  const oldest = runs[0];
  const newest = runs[runs.length - 1];
  // The janitor writes its report here and does not create the directory; every caller pre-creates it
  // (storage-slice-q6-worker.cjs does the same). Fixture setup, not part of what is under test.
  fs.mkdirSync(path.join(fixedLayout().state, 'reports'), { recursive: true, mode: 0o700 });
  // Death is observed by a real sweep, not by writing first_dead_at directly: the manual edge still
  // requires that immutable prior observation and must not be able to forge it.
  await dispatch('storage:janitor', ['apply']);
  // The wedge itself: a second sweep still refuses every one of them, because 24 hours has not elapsed.
  const sweep = await dispatch('storage:janitor', ['dry-run']);
  const retainedUnder24h = sweep.entries.filter((entry) => entry.kind === 'run' && entry.reason === 'dead-under-24h').length;

  // NEGATIVE CONTROL: the newest failure is retention-protected. It must be refused, and its image must
  // survive the refusal - a verb that throws after unlinking would still have broken 11.2.
  let refused = null;
  try { await dispatch('storage:reclaim-failed-scratch', [newest.id]); }
  catch (error) { refused = String(error.message || error); }

  // POSITIVE CONTROL: the oldest failure is authorised. The image goes, the evidence stays, and the
  // journal carries both halves of the authorisation it was discarded under.
  const reclaimed = await dispatch('storage:reclaim-failed-scratch', [oldest.id]);
  const record = state.readRecord('runs', oldest.id);
  return {
    reclaim_retained_under_24h: retainedUnder24h,
    reclaim_refused: refused,
    reclaim_protected_image_intact: fs.existsSync(containers.imagePath('scratch', newest.id)),
    reclaim_state: reclaimed.state,
    reclaim_scratch_image_gone: !fs.existsSync(containers.imagePath('scratch', oldest.id)),
    reclaim_evidence_image_kept: fs.existsSync(containers.imagePath('evidence', oldest.id)),
    reclaim_record_authorised: Boolean(record.scratch_discard_started_at && record.scratch_discarded_at),
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('SYNTHETIC_ARGUMENT_FORBIDDEN');
  const layout = fixedLayout();
  fs.mkdirSync(layout.support, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.worktrees, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.repositories['pentacle-mobile'], { recursive: true, mode: 0o700 });
  containerMutations.ensureStateImage();
  // This synthetic lifecycle fixture exercises sparse, isolated images only; its capacity input
  // must not make the deterministic journal contract depend on unrelated host occupancy. The
  // production gate continues to call requireCapacity with the real filesystem statfs, and the
  // boundary tests cover the 60/40 GiB policy independently.
  containers.requireCapacity('start', () => ({ bavail: 60n * BigInt(containers.GiB), bsize: 1n }));
  const authority = stateMutations.createInstalledAuthority();
  const terminal = [];
  try {
    for (let invocation = 0; invocation < 2; invocation += 1) {
      terminal.push(await invokeWrapper(invocation, authority));
      if (invocation === 0) var stateBefore = containers.exactDirectoryBytes(layout.stateImage);
    }
    const stateAfter = containers.exactDirectoryBytes(layout.stateImage);
    const result = {
      invocations: 2,
      wrapper_invocations: terminal.length,
      terminal_journals: terminal.filter(({ run }) => run.state === 'evidence_discarded').length,
      live_scratch: fs.existsSync(layout.scratchMount) ? fs.readdirSync(layout.scratchMount).length : 0,
      scratch_images: fs.existsSync(layout.scratchImages) ? fs.readdirSync(layout.scratchImages).length : 0,
      evidence_images: fs.existsSync(layout.evidenceImages) ? fs.readdirSync(layout.evidenceImages).length : 0,
      evidence_bounded: terminal.every(({ bounded }) => bounded),
      state_before: stateBefore,
      state_after: stateAfter,
    };
    // Runs last, and strictly after the image counts and state bytes above are read, so the failure
    // fixtures it leaves behind cannot perturb the boundedness assertions of the two live invocations.
    Object.assign(result, await reclaimControls(authority));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { detachIfMounted(layout.scratchMount); detachIfMounted(layout.evidenceMount); detachIfMounted(layout.state); }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; });
