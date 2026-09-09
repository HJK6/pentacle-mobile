'use strict';

// Drives the real absent-backing lifecycle in a separate process under an isolated HOME: a dead-owner
// blocked_unclassified run whose scratch AND evidence images were lost out of band is dispositioned to the
// terminal `backing_absent` state without deleting anything, the liveness sweep tolerates the absence
// instead of erroring, and every negative control (present image, partial absence, empty reason, wrong
// state) is refused with a named error and touches no bytes. The .test.cjs spawns this and asserts on the
// emitted JSON and on-disk state; it never needs the mutation capability itself.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir)) throw new Error('ABSENT_BACKING_REAL_HOME_REFUSED');

const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const containers = require('./storage-containers.cjs');
const containerMutations = containers.bind(mutationCapability);
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const janitor = require('./storage-janitor.cjs').bind(mutationCapability);

const layout = fixedLayout();
const DEAD_PID = 2147483647;
const DEAD_AT = '2026-06-02T00:00:00.000Z';
const UNDER_24H = Date.parse('2026-06-02T01:00:00.000Z'); // 1h after death: under the 24h window
const REASON = 'test: 2026-07-22 out-of-band backing purge';

function hdiutilImages() {
  const plist = spawnSync('/usr/bin/hdiutil', ['info', '-plist'], { encoding: 'utf8', timeout: 60000 });
  if (plist.status !== 0) throw new Error(`ABSENT_BACKING_HDIUTIL:${plist.status}:${String(plist.stderr || '').trim()}`);
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist.stdout, encoding: 'utf8', timeout: 60000 });
  return (JSON.parse(parsed.stdout).images || []);
}

function homeAttachments() {
  const home = `${path.resolve(os.homedir())}${path.sep}`;
  return hdiutilImages().filter((image) => `${path.resolve(String(image['image-path'] || ''))}${path.sep}`.startsWith(home));
}

function rootDevice(image) {
  const devices = (image['system-entities'] || []).map((entity) => entity['dev-entry']).filter(Boolean);
  return devices.find((device) => /^\/dev\/disk\d+$/.test(device)) || devices[0] || null;
}

function cleanupOwnedHost() {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const remaining = homeAttachments();
    if (!remaining.length) return;
    for (const attachment of remaining) {
      const device = rootDevice(attachment);
      if (device) spawnSync('/usr/bin/hdiutil', ['detach', device], { encoding: 'utf8', timeout: 60000 });
    }
    if (attempt < 10) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (homeAttachments().length) throw new Error('ABSENT_BACKING_CLEANUP_ATTACHED');
}

// A dead-owner blocked_unclassified run with real, retained (detached) scratch + evidence images.
function seedBlockedRun(authority, ordinal) {
  const id = crypto.randomUUID();
  const clock = `2026-06-01T00:${String(ordinal).padStart(2, '0')}:00.000Z`;
  let run = stateMutations.createRecord('runs', {
    schema: 1, id, revision: 0, state: 'reserved', generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: DEAD_PID }, candidate_ref: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64), reserved_at: clock, first_dead_at: DEAD_AT,
  });
  const scratch = containerMutations.createImage('scratch', id);
  const evidence = containerMutations.createImage('evidence', id);
  const deviceSet = path.join(layout.scratchMount, 'device-set');
  fs.mkdirSync(deviceSet, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.scratchMount, `failed-${ordinal}.txt`), 'scratch\n', { flag: 'wx' });
  fs.writeFileSync(path.join(layout.evidenceMount, 'run.json'), `${JSON.stringify({ status: 'failed', gates: [] })}\n`, { flag: 'wx' });
  run = stateMutations.transitionRun(id, run.revision, 'allocated', {
    scratch_seal: scratch.seal, evidence_seal: evidence.seal,
    device_set_identity: state.canonicalIdentity(deviceSet), allocated_at: clock,
  });
  run = stateMutations.transitionRun(id, run.revision, 'running', { handoff_from_pid: DEAD_PID, running_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'sealing', { gate_status: 17, failure: 'GATE_STATUS_NONZERO:17 child=absent-backing', sealing_at: clock });
  stateMutations.transitionRun(id, run.revision, 'blocked_unclassified', { classification_error: 'ABSENT_BACKING_UNCLASSIFIED' });
  containerMutations.detachRetain('scratch', id, scratch.seal);
  containerMutations.detachRetain('evidence', id, evidence.seal);
  return id;
}

function removeImage(kind, id) {
  const image = containers.imagePath(kind, id);
  fs.rmSync(image, { recursive: true, force: true });
  if (fs.existsSync(image)) throw new Error(`ABSENT_BACKING_SEED_REMOVE:${kind}`);
}

function imageExists(kind, id) { return fs.existsSync(containers.imagePath(kind, id)); }
function stateOf(id) { return state.readRecord('runs', id).state; }
function recordOf(id) { return state.readRecord('runs', id); }

function failureOf(action) {
  try { action(); } catch (error) { return String(error.message || error); }
  throw new Error('ABSENT_BACKING_EXPECTED_FAILURE');
}

function runErrorFor(report, id) {
  return report.errors.filter((entry) => entry.id === id).map((entry) => entry.error);
}

function consistencyEntry(report) {
  return report.entries.find((entry) => entry.kind === 'consistency');
}

function main() {
  fs.mkdirSync(layout.support, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.worktrees, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.repositories['pentacle-mobile'], { recursive: true, mode: 0o700 });
  containerMutations.ensureStateImage();
  const authority = stateMutations.createInstalledAuthority();
  fs.mkdirSync(path.join(layout.state, 'reports'), { recursive: true, mode: 0o700 });

  let primary = null;
  let out = null;
  try {
    // --- Scenario A: both images provably absent -------------------------------------------------
    const absent = seedBlockedRun(authority, 1);
    removeImage('scratch', absent);
    removeImage('evidence', absent);

    // 1) Under-24h sweep: the liveness backstop tolerates the absent backing instead of erroring.
    const sweepBefore = janitor.runJanitor('apply', UNDER_24H);
    const sweepBeforeErrors = runErrorFor(sweepBefore, absent);
    const stayedBlocked = stateOf(absent) === 'blocked_unclassified';

    // 2) Disposition completes the journal to the terminal backing_absent record - no bytes touched.
    const disposed = janitor.disposeAbsentBacking(absent, REASON, UNDER_24H);
    const disposedRecord = recordOf(absent);
    const disposedShape = disposedRecord.state === 'backing_absent'
      && disposedRecord.backing_absent_at === new Date(UNDER_24H).toISOString()
      && disposedRecord.backing_absent_reason === REASON
      && disposedRecord.deleted_at === undefined
      && disposedRecord.evidence_digest === undefined
      && !imageExists('scratch', absent) && !imageExists('evidence', absent);

    // Immutability: a terminal record cannot be re-dispositioned.
    const secondDispose = failureOf(() => janitor.disposeAbsentBacking(absent, REASON, UNDER_24H));

    // 3) Post-disposition sweep is clean: no error, and the absence reconciles (record accounts for it).
    const sweepAfter = janitor.runJanitor('apply', UNDER_24H);
    const sweepAfterErrors = sweepAfter.errors.length;
    const consistency = consistencyEntry(sweepAfter);
    const reconciledAbsent = !consistency.missing_evidence.includes(absent) && !consistency.missing_scratch.includes(absent);

    // --- Scenario B: image present -> verb refuses, deletes nothing (attach path unchanged) --------
    const present = seedBlockedRun(authority, 2);
    const presentRefusal = failureOf(() => janitor.disposeAbsentBacking(present, REASON, UNDER_24H));
    const presentKept = imageExists('scratch', present) && imageExists('evidence', present) && stateOf(present) === 'blocked_unclassified';

    // --- Scenario C: partial absence (scratch gone, evidence present) -> refuses, evidence untouched -
    const partial = seedBlockedRun(authority, 3);
    removeImage('scratch', partial);
    const partialRefusal = failureOf(() => janitor.disposeAbsentBacking(partial, REASON, UNDER_24H));
    const partialEvidenceKept = imageExists('evidence', partial) && stateOf(partial) === 'blocked_unclassified';

    // --- Scenario D: empty reason is refused before any state is read -----------------------------
    const reasonRefusal = failureOf(() => janitor.disposeAbsentBacking(present, '   ', UNDER_24H));

    out = {
      sweep_before_errors: sweepBeforeErrors,
      stayed_blocked: stayedBlocked,
      disposed_state: disposed.state,
      disposed_shape_ok: disposedShape,
      second_dispose: secondDispose,
      sweep_after_error_count: sweepAfterErrors,
      reconciled_absent: reconciledAbsent,
      present_refusal: presentRefusal,
      present_kept: presentKept,
      partial_refusal: partialRefusal,
      partial_evidence_kept: partialEvidenceKept,
      reason_refusal: reasonRefusal,
    };
  } catch (error) { primary = error; }

  try { cleanupOwnedHost(); }
  catch (cleanup) {
    if (!primary) throw cleanup;
    const error = new Error(`ABSENT_BACKING_CLEANUP_FAILED[primary=${String(primary.message || primary)}; cleanup=${String(cleanup.message || cleanup)}]`);
    error.errors = [primary, cleanup];
    throw error;
  }
  if (primary) throw primary;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (require.main === module) {
  try { if (process.argv[2] === '--cleanup') cleanupOwnedHost(); else main(); }
  catch (error) { process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; }
}
