'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir)) throw new Error('RECLAIM_REPEATABILITY_REAL_HOME_REFUSED');

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
const RECLAIM_AT = Date.parse('2026-06-05T00:00:00.000Z');

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60000, ...options });
  if (result.error || result.status !== 0) throw new Error(`RECLAIM_REPEATABILITY_COMMAND:${path.basename(binary)}:${result.status}:${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

function hdiutilImages() {
  const plist = command('/usr/bin/hdiutil', ['info', '-plist']);
  const parsed = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist }));
  return parsed.images || [];
}

function imageAttachments(ids) {
  return hdiutilImages().filter((image) => ids.some((id) => String(image['image-path'] || '').includes(id)));
}

function homeAttachments() {
  const home = `${path.resolve(os.homedir())}${path.sep}`;
  return hdiutilImages().filter((image) => `${path.resolve(String(image['image-path'] || ''))}${path.sep}`.startsWith(home));
}

function helpersHolding(needles) {
  const listed = spawnSync('/usr/bin/pgrep', ['-x', 'diskimages-helper'], { encoding: 'utf8', timeout: 10000 });
  if (listed.status === 1) return [];
  if (listed.error || listed.signal || listed.status !== 0) throw new Error('RECLAIM_REPEATABILITY_PGREP');
  return String(listed.stdout || '').trim().split(/\s+/).filter(Boolean).filter((pid) => {
    const open = spawnSync('/usr/sbin/lsof', ['-Fn', '-p', pid], { encoding: 'utf8', timeout: 10000 });
    if (open.error || open.signal) throw new Error(`RECLAIM_REPEATABILITY_LSOF:${pid}`);
    if (open.status !== 0) {
      if (open.status === 1) {
        try { process.kill(Number(pid), 0); }
        catch (error) { if (error?.code === 'ESRCH') return false; throw new Error(`RECLAIM_REPEATABILITY_LSOF:${pid}`); }
      }
      throw new Error(`RECLAIM_REPEATABILITY_LSOF:${pid}`);
    }
    return needles.some((needle) => String(open.stdout || '').includes(needle));
  });
}

function rootDevice(image) {
  const devices = (image['system-entities'] || []).map((entity) => entity['dev-entry']).filter(Boolean);
  return devices.find((device) => /^\/dev\/disk\d+$/.test(device)) || devices[0] || null;
}

function cleanupOwnedHost() {
  let remaining = [];
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    remaining = homeAttachments();
    if (!remaining.length) break;
    for (const attachment of remaining) {
      const device = rootDevice(attachment);
      if (!device) throw new Error('RECLAIM_REPEATABILITY_CLEANUP_DEVICE_MISSING');
      spawnSync('/usr/bin/hdiutil', ['detach', device], { encoding: 'utf8', timeout: 60000 });
    }
    if (attempt < 10) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (homeAttachments().length) throw new Error('RECLAIM_REPEATABILITY_CLEANUP_ATTACHED');
  const ownedMounts = new Set([layout.scratchMount, layout.evidenceMount, layout.state]);
  const mounted = hdiutilImages().some((image) => (image['system-entities'] || []).some((entity) => ownedMounts.has(entity['mount-point'])));
  if (mounted) throw new Error('RECLAIM_REPEATABILITY_CLEANUP_MOUNTED');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (!helpersHolding([os.homedir()]).length) return;
    if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('RECLAIM_REPEATABILITY_CLEANUP_HELPER');
}

function assertHostClean(ids, label) {
  const attachments = imageAttachments(ids);
  const helpers = helpersHolding(ids);
  if (attachments.length || helpers.length) throw new Error(`RECLAIM_REPEATABILITY_HOST_DIRTY:${label}:attachments=${attachments.length}:helpers=${helpers.length}`);
}

function proveBusyDetachRetry() {
  const id = crypto.randomUUID();
  const image = containers.imagePath('evidence', id);
  const mount = containers.mountPath('evidence');
  fs.mkdirSync(image, { recursive: true, mode: 0o700 });
  fs.mkdirSync(mount, { recursive: true, mode: 0o700 });
  const seal = { object_id: crypto.randomUUID(), image: state.canonicalIdentity(image) };
  fs.writeFileSync(path.join(mount, '.pentacle-container.json'), `${JSON.stringify({ schema: 1, kind: 'evidence', run_id: id, limit: containers.LIMITS.evidence, seal })}\n`);
  let atMount = true;
  let attached = true;
  let inventoryCalls = 0;
  const targets = [];
  const inventory = () => {
    inventoryCalls += 1;
    if (inventoryCalls === 3) throw new Error('CONTAINER_COMMAND_TIMEOUT:plutil:20000');
    return {
      attached: atMount ? image : null,
      expectedAttachment: attached ? { image, device: '/dev/disk999' } : null,
      enumerated: attached ? 1 : 0,
      foreign: 0,
    };
  };
  const execute = (_binary, args) => {
    targets.push(args[1]);
    if (targets.length === 1) {
      atMount = false;
      throw new Error('CONTAINER_COMMAND_FAILED:hdiutil:16:Resource busy');
    }
    attached = false;
  };
  try { containerMutations.detachRetain('evidence', id, seal, execute, inventory); }
  finally {
    fs.rmSync(image, { recursive: true, force: true });
    fs.rmSync(mount, { recursive: true, force: true });
  }
  if (JSON.stringify(targets) !== JSON.stringify(['/dev/disk999', '/dev/disk999'])) throw new Error(`RECLAIM_REPEATABILITY_DETACH_RETRY:${JSON.stringify(targets)}`);
  return { targets, inventory_timeout_recovered: inventoryCalls >= 9 };
}

function failureOf(action) {
  try { action(); }
  catch (error) { return String(error.message || error); }
  throw new Error('RECLAIM_REPEATABILITY_EXPECTED_FAILURE');
}

function withSyntheticEvidence(action) {
  const id = crypto.randomUUID();
  const image = containers.imagePath('evidence', id);
  const mount = containers.mountPath('evidence');
  fs.mkdirSync(image, { recursive: true, mode: 0o700 });
  fs.mkdirSync(mount, { recursive: true, mode: 0o700 });
  const seal = { object_id: crypto.randomUUID(), image: state.canonicalIdentity(image) };
  fs.writeFileSync(path.join(mount, '.pentacle-container.json'), `${JSON.stringify({ schema: 1, kind: 'evidence', run_id: id, limit: containers.LIMITS.evidence, seal })}\n`);
  try { return action({ id, image, mount, seal }); }
  finally {
    fs.rmSync(image, { recursive: true, force: true });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}

function proveFailurePaths() {
  const proven = [];
  withSyntheticEvidence(({ id, image, mount }) => {
    let attached = true;
    const detaches = [];
    let discards = 0;
    const inventory = () => ({ attached: attached ? image : null, expectedAttachment: attached ? { image, device: '/dev/disk998' } : null, enumerated: attached ? 1 : 0, foreign: 0 });
    const execute = (binary, args) => {
      if (binary === '/usr/bin/trash' || binary === '/bin/rm') discards += 1;
      if (args[0] === 'attach') throw new Error('RECLAIM_REPEATABILITY_ATTACH_AFTER_EFFECT');
      if (args[0] === 'detach') { detaches.push(args[1]); attached = false; }
    };
    const failure = failureOf(() => containerMutations.attachExisting('evidence', id, execute, inventory));
    if (!failure.includes('ATTACH_AFTER_EFFECT') || JSON.stringify(detaches) !== JSON.stringify(['/dev/disk998']) || discards || !fs.existsSync(image)) throw new Error('RECLAIM_REPEATABILITY_ATTACH_CLEANUP');
    proven.push('attach-throw-after-effect');

    const foreign = path.join(layout.support, `${crypto.randomUUID()}.sparsebundle`);
    fs.mkdirSync(foreign, { recursive: true, mode: 0o700 });
    const foreignDetaches = [];
    try {
      const foreignInventory = () => ({ attached: foreign, expectedAttachment: null, enumerated: 1, foreign: 1 });
      const refusing = (_binary, args) => {
        if (args[0] === 'attach') throw new Error('RECLAIM_REPEATABILITY_FOREIGN_REFUSAL');
        if (args[0] === 'detach') foreignDetaches.push(args[1]);
      };
      failureOf(() => containerMutations.attachExisting('evidence', id, refusing, foreignInventory));
      if (foreignDetaches.length || !fs.existsSync(foreign) || !fs.existsSync(image)) throw new Error('RECLAIM_REPEATABILITY_FOREIGN_TOUCHED');
    } finally { fs.rmSync(foreign, { recursive: true, force: true }); }
    proven.push('foreign-preserved');
  });

  withSyntheticEvidence(({ id, image, mount, seal }) => {
    const foreign = path.join(layout.support, `${crypto.randomUUID()}.sparsebundle`);
    fs.mkdirSync(foreign, { recursive: true, mode: 0o700 });
    try {
      const drift = failureOf(() => containers.resolveMounted('evidence', id, () => ({ attached: foreign, expectedAttachment: null, enumerated: 1, foreign: 1 })));
      const mountAmbiguous = failureOf(() => containers.resolveMounted('evidence', id, () => { throw new Error('CONTAINER_MOUNT_AMBIGUOUS'); }));
      const imageAmbiguous = failureOf(() => containerMutations.detachRetain('evidence', id, seal, () => { throw new Error('RECLAIM_REPEATABILITY_MUTATION'); }, () => { throw new Error('CONTAINER_IMAGE_ATTACHMENT_AMBIGUOUS'); }));
      if (!drift.startsWith('CONTAINER_MOUNT_SOURCE_DRIFT') || mountAmbiguous !== 'CONTAINER_MOUNT_AMBIGUOUS' || imageAmbiguous !== 'CONTAINER_IMAGE_ATTACHMENT_AMBIGUOUS' || !fs.existsSync(image)) throw new Error('RECLAIM_REPEATABILITY_AMBIGUITY');
    } finally { fs.rmSync(foreign, { recursive: true, force: true }); }
    proven.push('source-drift', 'mount-ambiguity', 'image-ambiguity');

    for (const [label, throws] of [['silent-cleanup', false], ['retry-exhaustion', true]]) {
      let detachAttempts = 0;
      let discards = 0;
      const inventory = () => ({ attached: image, expectedAttachment: { image, device: '/dev/disk997' }, enumerated: 1, foreign: 0 });
      const execute = (binary, args) => {
        if (binary === '/usr/bin/trash' || binary === '/bin/rm') discards += 1;
        if (args[0] === 'detach') { detachAttempts += 1; if (throws) throw new Error('CONTAINER_COMMAND_FAILED:hdiutil:16:Resource busy'); }
      };
      const failure = failureOf(() => containerMutations.detachRetain('evidence', id, seal, execute, inventory));
      if (detachAttempts !== 5 || discards || !fs.existsSync(image) || (!failure.includes('CONTAINER_STILL_MOUNTED') && !failure.includes('CONTAINER_DETACH_FAILED'))) throw new Error(`RECLAIM_REPEATABILITY_${label.toUpperCase()}`);
      proven.push(label);
    }
  });
  return proven;
}

function seedBlockedRun(authority, ordinal, corruptEvidenceSeal = false, corruptScratchSeal = false, options = {}) {
  const id = options.id || crypto.randomUUID();
  const clock = `2026-06-01T00:${String(ordinal).padStart(2, '0')}:00.000Z`;
  let run = stateMutations.createRecord('runs', {
    schema: 1, id, revision: 0, state: 'reserved', generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: DEAD_PID }, candidate_ref: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
    lock_token_digest: options.lockToken
      ? crypto.createHash('sha256').update(options.lockToken).digest('hex') : 'b'.repeat(64),
    reserved_at: clock, first_dead_at: DEAD_AT,
  });
  const scratch = containerMutations.createImage('scratch', id);
  const evidence = containerMutations.createImage('evidence', id);
  const deviceSet = path.join(layout.scratchMount, 'device-set');
  fs.mkdirSync(deviceSet, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(layout.scratchMount, `failed-${ordinal}.txt`), 'scratch\n', { flag: 'wx' });
  fs.writeFileSync(path.join(layout.evidenceMount, 'run.json'), `${JSON.stringify({ status: 'failed', gates: [] })}\n`, { flag: 'wx' });
  const recordedScratchSeal = corruptScratchSeal ? { ...scratch.seal, object_id: crypto.randomUUID() } : scratch.seal;
  const recordedEvidenceSeal = corruptEvidenceSeal ? { ...evidence.seal, object_id: crypto.randomUUID() } : evidence.seal;
  run = stateMutations.transitionRun(id, run.revision, 'allocated', {
    scratch_seal: recordedScratchSeal, evidence_seal: recordedEvidenceSeal,
    device_set_identity: state.canonicalIdentity(deviceSet), allocated_at: clock,
  });
  run = stateMutations.transitionRun(id, run.revision, 'running', { handoff_from_pid: DEAD_PID, running_at: clock });
  run = stateMutations.transitionRun(id, run.revision, 'sealing', { gate_status: 17, failure: 'GATE_STATUS_NONZERO:17 child=repeatability', sealing_at: clock });
  stateMutations.transitionRun(id, run.revision, 'blocked_unclassified', { classification_error: 'RECLAIM_REPEATABILITY_UNCLASSIFIED' });
  if (!options.retainMounted) {
    containerMutations.detachRetain('scratch', id, scratch.seal);
    containerMutations.detachRetain('evidence', id, evidence.seal);
  }
  return id;
}

function writeClaimedDeadHostLock(authority, id, token) {
  const run = state.readRecord('runs', id);
  fs.writeFileSync(path.join(layout.state, 'gate.lock'), `${JSON.stringify({
    schema: 1, generation: authority.generation, host: authority.host, uid: authority.uid,
    pid: run.owner.pid, token, claimed: true, created_at: DEAD_AT, claimed_at: DEAD_AT,
  })}\n`, { flag: 'wx', mode: 0o600 });
}

function proveAccounting(ids) {
  const evidence = new Set(fs.readdirSync(layout.evidenceImages).filter((name) => name.endsWith('.sparsebundle')));
  if (evidence.size !== ids.length) throw new Error(`RECLAIM_REPEATABILITY_EVIDENCE_COUNT:${evidence.size}/${ids.length}`);
  for (const id of ids) {
    const run = state.readRecord('runs', id);
    const evidenceName = `${id}.sparsebundle`;
    if (!evidence.has(evidenceName)) throw new Error(`RECLAIM_REPEATABILITY_EVIDENCE_MISSING:${id}`);
    const scratchExists = fs.existsSync(containers.imagePath('scratch', id));
    const scratchDiscarded = ['scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(run.state);
    if (scratchExists === scratchDiscarded) throw new Error(`RECLAIM_REPEATABILITY_ACCOUNTING:${id}:${run.state}`);
  }
  return true;
}

function stateOf(id) { return state.readRecord('runs', id).state; }

function reclaimInChild(id) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-cli.cjs'), 'storage:reclaim-failed-scratch', id], {
    cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 120000,
  });
  if (result.error || result.status !== 0) throw new Error(`RECLAIM_REPEATABILITY_CHILD:${result.status}:${String(result.stderr || '').trim()}`);
}

function main() {
  fs.mkdirSync(layout.support, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.worktrees, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.repositories['pentacle-mobile'], { recursive: true, mode: 0o700 });
  const failurePaths = proveFailurePaths();
  const detachRetry = proveBusyDetachRetry();
  containerMutations.ensureStateImage();
  const authority = stateMutations.createInstalledAuthority();
  fs.mkdirSync(path.join(layout.state, 'reports'), { recursive: true, mode: 0o700 });
  const all = [];
  let primary = null;
  try {
    const direct = [seedBlockedRun(authority, 1), seedBlockedRun(authority, 2)];
    all.push(...direct);
    for (const id of direct) janitor.reclaimFailedScratch(id, RECLAIM_AT);
    assertHostClean(direct, 'direct');

    const separate = [seedBlockedRun(authority, 3), seedBlockedRun(authority, 4)];
    all.push(...separate);
    for (const id of separate) reclaimInChild(id);
    assertHostClean(separate, 'separate-processes');

    const swept = [seedBlockedRun(authority, 5), seedBlockedRun(authority, 6)];
    all.push(...swept);
    janitor.runJanitor('apply', RECLAIM_AT);
    assertHostClean(swept, 'janitor-sweep');

    // The lexically first terminal run must see the later run's stale lock as an ordinary mismatch,
    // continue the sweep, and let the actual owner recover it and reclaim its scratch.
    const foreignWitness = seedBlockedRun(authority, 9, false, false, { id: '00000000-0000-4000-8000-0000000000a1' });
    all.push(foreignWitness);
    janitor.reclaimFailedScratch(foreignWitness, RECLAIM_AT);
    const foreignToken = 'c'.repeat(64);
    const foreignOwner = seedBlockedRun(authority, 10, false, false, {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff1', lockToken: foreignToken, retainMounted: true,
    });
    all.push(foreignOwner);
    writeClaimedDeadHostLock(authority, foreignOwner, foreignToken);
    const foreignReport = janitor.runJanitor('apply', RECLAIM_AT);
    const accounting = proveAccounting(all);
    if (foreignReport.errors.length || fs.existsSync(path.join(layout.state, 'gate.lock'))
      || stateOf(foreignOwner) !== 'scratch_discarded' || fs.existsSync(containers.imagePath('scratch', foreignOwner))) {
      throw new Error(`RECLAIM_REPEATABILITY_FOREIGN_LOCK:${JSON.stringify(foreignReport.errors)}`);
    }
    assertHostClean([foreignWitness, foreignOwner], 'foreign-lock-sweep');

    // A real helper failure is not a mismatch: it must be reported while enumeration continues. The
    // liveness detach deliberately trusts the mounted marker's exact seal, so a stale journal seal must
    // not strand the mount; the later deletion-authority check still reports that journal mismatch.
    const diagnostic = seedBlockedRun(authority, 11, true, false, {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', retainMounted: true,
    });
    all.push(diagnostic);
    fs.writeFileSync(path.join(layout.state, 'gate.lock'), '{}\n', { flag: 'wx', mode: 0o600 });
    const diagnosticReport = janitor.runJanitor('apply', RECLAIM_AT);
    const nonMismatchRecorded = diagnosticReport.errors.some((entry) => entry.error.includes('HOST_LOCK_RECOVERY:HOST_LOCK_SCHEMA_INVALID'));
    const journalMismatchRecorded = diagnosticReport.errors.some((entry) => entry.id === diagnostic && entry.error === 'CONTAINER_JOURNAL_SEAL_MISMATCH');
    const falseLivenessFailure = diagnosticReport.errors.some((entry) => entry.id === diagnostic && entry.error.includes('mount-recovery-evidence:'));
    if (!diagnosticReport.completed_at || !nonMismatchRecorded || !journalMismatchRecorded || falseLivenessFailure) throw new Error(`RECLAIM_REPEATABILITY_DIAGNOSTICS:${JSON.stringify(diagnosticReport.errors)}`);
    fs.unlinkSync(path.join(layout.state, 'gate.lock'));
    assertHostClean([diagnostic], 'diagnostic-sweep');

    const refused = seedBlockedRun(authority, 7, true);
    all.push(refused);
    let refusal = null;
    try { janitor.reclaimFailedScratch(refused, RECLAIM_AT); }
    catch (error) { refusal = String(error.message || error); }
    assertHostClean([refused], 'seal-refusal');
    if (refusal !== 'CONTAINER_JOURNAL_SEAL_MISMATCH') throw new Error(`RECLAIM_REPEATABILITY_REFUSAL:${refusal}`);

    const bodyThrow = seedBlockedRun(authority, 8, false, true);
    all.push(bodyThrow);
    let bodyFailure = null;
    try { janitor.reclaimFailedScratch(bodyThrow, RECLAIM_AT); }
    catch (error) { bodyFailure = String(error.message || error); }
    assertHostClean([bodyThrow], 'operation-throw');
    if (bodyFailure !== 'CONTAINER_JOURNAL_SEAL_MISMATCH' || stateOf(bodyThrow) !== 'scratch_discarding' || !fs.existsSync(containers.imagePath('scratch', bodyThrow))) throw new Error(`RECLAIM_REPEATABILITY_OPERATION_THROW:${bodyFailure}`);

    process.stdout.write(`${JSON.stringify({
      direct: direct.map(stateOf), separate: separate.map(stateOf), swept: swept.map(stateOf),
      refusal, refused_state: stateOf(refused), refused_scratch_kept: fs.existsSync(containers.imagePath('scratch', refused)),
      body_failure: bodyFailure, body_failure_state: stateOf(bodyThrow), body_failure_scratch_kept: fs.existsSync(containers.imagePath('scratch', bodyThrow)),
      attachments: imageAttachments(all).length, helpers: helpersHolding(all).length,
      detach_retry_targets: detachRetry.targets,
      detach_retry_inventory_timeout_recovered: detachRetry.inventory_timeout_recovered,
      failure_paths: [...failurePaths, 'operation-throw'],
      foreign_lock_sweep: {
        state: stateOf(foreignOwner), scratch_kept: fs.existsSync(containers.imagePath('scratch', foreignOwner)),
        lock_present: fs.existsSync(path.join(layout.state, 'gate.lock')), errors: foreignReport.errors.length, accounting,
      },
      diagnostic_sweep: { non_mismatch_recorded: nonMismatchRecorded, journal_mismatch_recorded: journalMismatchRecorded, liveness_detach_false_failure: falseLivenessFailure },
    })}\n`);
  } catch (error) { primary = error; }
  try { cleanupOwnedHost(); }
  catch (cleanup) {
    if (!primary) throw cleanup;
    const error = new Error(`RECLAIM_REPEATABILITY_CLEANUP_FAILED[primary=${String(primary.message || primary)}; cleanup=${String(cleanup.message || cleanup)}]`);
    error.errors = [primary, cleanup];
    throw error;
  }
  if (primary) throw primary;
}

if (require.main === module) {
  try { if (process.argv[2] === '--cleanup') cleanupOwnedHost(); else main(); }
  catch (error) { process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; }
}
