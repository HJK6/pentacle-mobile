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
const janitor = require('./storage-janitor.cjs').bind(mutationCapability);
const gateMutations = require('./storage-gate.cjs').bind(mutationCapability);

const layout = fixedLayout();
const DEAD_PID = 2147483647;
const NOW = Date.parse('2026-06-05T00:00:00.000Z');

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`DISCARD_RECOVERY_COMMAND:${path.basename(binary)}:${result.status}:${String(result.stderr || result.error || '').trim()}`);
  return String(result.stdout || '').trim();
}

function detachOrdinary(kind) {
  const mount = containers.mountPath(kind);
  command('/usr/bin/hdiutil', ['detach', mount]);
  if (containers.attachedImageAt(mount)) throw new Error(`DISCARD_RECOVERY_DETACH_REFUSED:${kind}`);
}

function seedDiscarding(authority, kind, mounted, identityMismatch = false) {
  const id = crypto.randomUUID();
  const clock = '2026-06-01T00:00:00.000Z';
  let run = stateMutations.createRecord('runs', {
    schema: 1, id, revision: 0, state: 'reserved', generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: DEAD_PID }, candidate_ref: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64), reserved_at: clock, first_dead_at: clock,
  });
  const scratch = containerMutations.createImage('scratch', id);
  const evidence = containerMutations.createImage('evidence', id);
  if (kind === 'evidence') {
    fs.writeFileSync(path.join(layout.evidenceMount, 'run.json'), `${JSON.stringify({
      sha: 'a'.repeat(40), candidate_sha: 'a'.repeat(40), gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    })}\n`);
    fs.writeFileSync(path.join(layout.evidenceMount, 'native-root.json'), `${JSON.stringify({ candidate_sha: 'a'.repeat(40) })}\n`);
  }
  const evidenceDigest = kind === 'evidence' ? gateMutations.sealUnclassifiedEvidence(id) : null;
  const deviceSet = path.join(layout.scratchMount, 'device-set');
  fs.mkdirSync(deviceSet, { recursive: true, mode: 0o700 });
  const targetSeal = kind === 'scratch' ? scratch.seal : evidence.seal;
  const mismatched = { ...targetSeal, image: { ...targetSeal.image, inode: `${targetSeal.image.inode}1` } };
  run = stateMutations.transitionRun(id, run.revision, 'allocated', {
    scratch_seal: kind === 'scratch' && identityMismatch ? mismatched : scratch.seal,
    evidence_seal: kind === 'evidence' && identityMismatch ? mismatched : evidence.seal,
    device_set_identity: state.canonicalIdentity(deviceSet), allocated_at: clock,
  });
  run = stateMutations.transitionRun(id, run.revision, 'running', { handoff_from_pid: DEAD_PID, running_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'sealing', { gate_status: 17, failure: 'GATE_STATUS_NONZERO:17 child=discard-recovery', sealing_at: clock });
  if (kind === 'evidence') run = stateMutations.transitionRun(id, run.revision, 'published', {
    preliminary_audit_at: clock, preliminary_evidence_digest: 'c'.repeat(64), published_at: clock,
  });
  run = stateMutations.transitionRun(id, run.revision, 'scratch_discarding', { scratch_discard_started_at: clock });
  if (kind === 'evidence') {
    containerMutations.detachAndDiscard('scratch', id, scratch.seal);
    run = stateMutations.transitionRun(id, run.revision, 'scratch_discarded', { scratch_discarded_at: clock });
    run = stateMutations.transitionRun(id, run.revision, 'evidence_discarding', { evidence_digest: evidenceDigest, evidence_discard_started_at: clock });
  }
  fs.unlinkSync(path.join(containers.mountPath(kind), '.pentacle-container.json'));
  if (!mounted) detachOrdinary(kind);
  return { id, image: containers.imagePath(kind, id), seal: kind === 'scratch' ? run.scratch_seal : run.evidence_seal };
}

function recoverMatrix(authority) {
  const recovered = [];
  for (const kind of ['scratch', 'evidence']) {
    for (const variant of ['mounted', 'unmounted']) {
      const seeded = seedDiscarding(authority, kind, variant === 'mounted');
      const run = janitor.recoverRun(seeded.id, NOW);
      const expected = kind === 'scratch' ? 'scratch_discarded' : 'evidence_discarded';
      if (run.state !== expected || fs.existsSync(seeded.image)) throw new Error(`DISCARD_RECOVERY_MATRIX:${kind}:${variant}:${run.state}`);
      recovered.push(`${kind}:${variant}:${run.state}`);
    }
  }
  return recovered;
}

function proveIdentityRefusal(authority) {
  const seeded = seedDiscarding(authority, 'scratch', false, true);
  let failure = null;
  try { janitor.recoverRun(seeded.id, NOW); }
  catch (error) { failure = String(error.message || error); }
  return { failure, kept: fs.existsSync(seeded.image) };
}

function proveDetachRefusal(authority) {
  const seeded = seedDiscarding(authority, 'scratch', true);
  let detaches = 0;
  let discards = 0;
  const inventory = (mount, expectedImage) => {
    const attached = containers.attachedImageAt(mount);
    return {
      attached,
      expectedAttachment: attached && fs.realpathSync(attached) === fs.realpathSync(expectedImage) ? { image: attached, device: mount } : null,
      enumerated: attached ? 1 : 0,
      foreign: 0,
    };
  };
  const execute = (binary, args) => {
    if (binary === '/usr/bin/hdiutil' && args[0] === 'detach') detaches += 1;
    if (binary === '/bin/rm' || binary === '/usr/bin/trash') discards += 1;
  };
  let refused = false;
  try { containerMutations.recoverDiscarding('scratch', seeded.id, seeded.seal, null, execute, inventory); }
  catch (error) { refused = /CONTAINER_(STILL_MOUNTED|IMAGE_STILL_ATTACHED|DETACH_FAILED)/.test(String(error.message || error)); }
  if (!fs.existsSync(seeded.image)) throw new Error('DISCARD_RECOVERY_UNPROVEN_DELETED');
  detachOrdinary('scratch');
  containerMutations.detachRetain('evidence', seeded.id, state.readRecord('runs', seeded.id).evidence_seal);
  return { refused, detaches, discards };
}

function main() {
  fs.mkdirSync(layout.support, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.worktrees, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.repositories['pentacle-mobile'], { recursive: true, mode: 0o700 });
  containerMutations.ensureStateImage();
  const authority = stateMutations.createInstalledAuthority();
  fs.mkdirSync(path.join(layout.state, 'reports'), { recursive: true, mode: 0o700 });
  const recovered = recoverMatrix(authority);
  const identity = proveIdentityRefusal(authority);
  const detach = proveDetachRefusal(authority);
  process.stdout.write(`${JSON.stringify({
    recovered,
    identity_refusal: identity.failure,
    identity_image_kept: identity.kept,
    detach_refusal: detach.refused,
    detach_attempts: detach.detaches,
    detach_discards: detach.discards,
  })}\n`);
}

main();
