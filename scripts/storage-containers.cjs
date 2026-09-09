'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixedLayout } = require('./storage-authority.cjs');
const { canonicalIdentity, exactSeal } = require('./storage-state.cjs');
const { crashPoint } = require('./storage-crash-points.cjs');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_FREE_BYTES = (1n << 64n) - 1n;
const LIMITS = Object.freeze({ state: 64 * MiB, scratch: 12 * GiB, evidence: 2 * GiB, config: MiB, overhead: 256 * MiB });

// NOTHING HERE MAY BLOCK FOREVER. Measured 2026-07-22 while chasing an intermittent suite stall:
// the mount probe's `plutil -convert json` child sat unresponsive reading its stdin for 50 s and
// counting, under concurrent hdiutil load, and spawnSync without a timeout waits for it forever.
// In the suite that surfaced as a test cap; in a real gate the wrapper would hang inside a
// read-only probe with the host lock held and both images mounted, which no janitor backstop
// clears while the owner is still alive. A bounded wait converts an unbounded hang into a named,
// retryable failure. The default is generous because it is a backstop, never a performance budget;
// probes that should be sub-second pass their own much smaller bound.
const COMMAND_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 20000;

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, ...options });
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) throw new Error(`CONTAINER_COMMAND_TIMEOUT:${path.basename(binary)}:${options.timeout ?? COMMAND_TIMEOUT_MS}`);
  if (result.error || result.status !== 0) throw new Error(`CONTAINER_COMMAND_FAILED:${path.basename(binary)}:${result.status}:${String(result.stderr || result.error || '').trim()}`);
  return String(result.stdout || '').trim();
}

// This asks about ONE mount point we own, but answers out of a MACHINE-WIDE enumeration we do not: any
// hdiutil activity anywhere on the host - including a gate run's own repeated attach/detach - shares this
// list. The mount-point filter is exactly scoped, so a foreign mount can never produce a false MATCH; what
// it can produce is a false ABSENCE. `enumerated` and `foreign` are carried out so a caller can say which
// happened instead of guessing. Not exported: the pinned module surface stays as it was.
function attachedInventory(mount, expectedImage = null) {
  const plist = command('/usr/bin/hdiutil', ['info', '-plist'], { timeout: PROBE_TIMEOUT_MS });
  const parsed = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist, timeout: PROBE_TIMEOUT_MS }));
  const images = parsed.images || [];
  const points = images.flatMap((image) => (image['system-entities'] || []).map((entity) => entity['mount-point']).filter(Boolean));
  const matches = images.filter((image) => (image['system-entities'] || []).some((entity) => entity['mount-point'] === mount));
  if (matches.length > 1) throw new Error('CONTAINER_MOUNT_AMBIGUOUS');
  const expected = expectedImage === null ? [] : images.filter((image) => {
    try { return fs.realpathSync(image['image-path']) === fs.realpathSync(expectedImage); }
    catch { return false; }
  });
  if (expected.length > 1) throw new Error('CONTAINER_IMAGE_ATTACHMENT_AMBIGUOUS');
  const expectedEntities = expected[0]?.['system-entities'] || [];
  const expectedDevices = expectedEntities.map((entity) => entity['dev-entry']).filter(Boolean);
  const expectedDevice = expectedDevices.find((entry) => /^\/dev\/disk\d+$/.test(entry)) || expectedDevices[0] || null;
  if (expected.length && !expectedDevice) throw new Error('CONTAINER_IMAGE_ATTACHMENT_DEVICE_MISSING');
  return {
    attached: matches.length ? matches[0]['image-path'] : null,
    expectedAttachment: expected.length ? { image: expected[0]['image-path'], device: expectedDevice } : null,
    enumerated: images.length,
    foreign: points.filter((point) => point !== mount && point.includes('PentacleMobileStorage')).length,
  };
}

function attachedImageAt(mount) { return attachedInventory(mount).attached; }

// These are two DIFFERENT failures and used to be one indistinguishable string. Nothing-attached means the
// global enumeration did not list our mount - which a concurrent attach/detach elsewhere on the host can
// cause, and which is therefore not necessarily our defect at all. A realpath mismatch means some OTHER
// image is mounted where ours should be, which always is. The discriminating fact was already computed
// here and then thrown away, so the only way to tell them apart was to re-run and see whether it went
// away - the habit that turns a real signal into assumed flake. `foreign` counts other PentacleMobileStorage
// mounts in the same enumeration, which is the concurrent-run tell; it is used in preference to a gate.lock
// probe because a lock keyed on fixedLayout() is blind from a redirected HOME, which is exactly where this
// symptom was first seen. Named for the same reason assertClosedOutcomeContract embeds {declared,
// reachable} (storage-cli.cjs): a guard that fails without saying why is itself the defect.
// ABSENCE IS RE-ASKED, DRIFT IS NOT. The comment above already reasons that a false absence is
// possible because the enumeration is machine-wide; measured 2026-07-22, that is not theoretical.
// Concurrent hdiutil activity elsewhere on the host makes `hdiutil info -plist` intermittently omit
// a mount that is genuinely attached: the storage suite failed 3 of 13 runs with
// CONTAINER_MOUNT_ABSENT and foreign=3 while the mount in question was live, and the identical
// suite one image-lifecycle lighter passed 9 of 9. So a single snapshot is not evidence of absence.
//
// The retry re-asks the SAME question and weakens nothing: a MISMATCH still fails on the first
// answer (some other image is mounted where ours should be is always our defect), and a genuine
// absence still fails - it just costs ATTEMPTS snapshots first. The attempt count travels in the
// error so a future reader can tell a stubborn absence from a one-frame flicker.
const MOUNT_INVENTORY_ATTEMPTS = 3;
const MOUNT_INVENTORY_PAUSE_MS = 250;

function pause(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }

// Every place absence CHANGES A DECISION goes through here, not through a single snapshot. That is
// requireMountedImage below and recoverOrCreate, where a false absence is destructive: it routes to
// attachExisting, whose attach then fails precisely BECAUSE the volume really is mounted, and the
// failure handler trashes the image and builds a replacement. One flickering probe would discard a
// live run's backing store. The `inventory` seam exists so those decisions can be tested against
// scripted answers - the OS race itself cannot be scheduled, but the semantics can.
function confirmedInventory(mount, inventory = attachedInventory, expectedImage = null) {
  let observed = null;
  for (let attempt = 1; attempt <= MOUNT_INVENTORY_ATTEMPTS; attempt += 1) {
    // A probe that TIMED OUT is the same evidence as a probe that came back empty - no answer, not a
    // negative answer - so it is retried on identical terms and only the last attempt is believed.
    try { observed = inventory(mount, expectedImage); }
    catch (error) { if (attempt === MOUNT_INVENTORY_ATTEMPTS || !String(error.message).startsWith('CONTAINER_COMMAND_TIMEOUT')) throw error; }
    if (observed?.attached) break;
    if (attempt < MOUNT_INVENTORY_ATTEMPTS) pause(MOUNT_INVENTORY_PAUSE_MS);
  }
  return observed;
}

function requireMountedImage(mount, image, inventory = attachedInventory) {
  const observed = confirmedInventory(mount, inventory, image);
  const { attached, enumerated, foreign } = observed;
  if (!attached) throw new Error(`CONTAINER_MOUNT_ABSENT:${JSON.stringify({ mount, expected: image, enumerated, foreign, attempts: MOUNT_INVENTORY_ATTEMPTS })}`);
  if (fs.realpathSync(attached) !== fs.realpathSync(image)) throw new Error(`CONTAINER_MOUNT_SOURCE_DRIFT:${JSON.stringify({ mount, expected: image, found: attached })}`);
  return observed;
}

function imagePath(kind, runId) {
  const layout = fixedLayout();
  const parent = kind === 'scratch' ? layout.scratchImages : kind === 'evidence' ? layout.evidenceImages : null;
  if (!parent || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('CONTAINER_ID_INVALID');
  return path.join(parent, `${runId}.sparsebundle`);
}

function mountPath(kind) {
  const layout = fixedLayout();
  if (kind === 'scratch') return layout.scratchMount;
  if (kind === 'evidence') return layout.evidenceMount;
  throw new Error('CONTAINER_KIND_INVALID');
}

// LABELLED PLAIN ERROR, never a bare AggregateError, for the reason storage-gate.cjs already
// records at its own cleanup site: String(error.message) on an AggregateError yields only the
// wrapper name, so every individual failure is unreachable from the janitor report and from CLI
// stderr - which is exactly where an operator meets it. A cleanup that fails must name BOTH what
// went wrong first and what could not be tidied up, at the top level.
function cleanupFailure(label, primary, cleanup) {
  const detail = [`primary=${String(primary?.message || primary)}`, `cleanup=${String(cleanup?.message || cleanup)}`].join('; ');
  const error = new Error(`${label}[${detail}]`);
  error.errors = [primary, cleanup];
  return error;
}

function createImage(kind, runId, execute = command) {
  const image = imagePath(kind, runId);
  const mount = mountPath(kind);
  if (fs.existsSync(image)) throw new Error('CONTAINER_COLLISION');
  fs.mkdirSync(path.dirname(image), { recursive: true, mode: 0o700 });
  fs.mkdirSync(mount, { recursive: true, mode: 0o700 });
  const size = kind === 'scratch' ? '12g' : '2g';
  execute('/usr/bin/hdiutil', ['create', '-quiet', '-type', 'SPARSEBUNDLE', '-fs', 'APFS', '-size', size, '-volname', `Pentacle-${kind}-${runId}`, image]);
  // The image now EXISTS and nothing has recorded it.
  crashPoint('container-create');
  // ATTEMPTED, not succeeded. The flag is raised BEFORE the attach runs, because an attach that
  // throws or times out can still have mounted the volume - the failure tells us the command did not
  // report success, never that nothing happened. Reading it as "not attached" let cleanup skip the
  // detach and unlink the backing store of a live mount.
  let attachAttempted = false;
  try {
    attachAttempted = true;
    execute('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mount, image]);
    // The volume is MOUNTED and the caller has been told nothing.
    crashPoint('container-attach');
    if (execute === command) requireMountedImage(mount, image);
    fs.chmodSync(mount, 0o700);
    const seal = { object_id: require('node:crypto').randomUUID(), image: canonicalIdentity(image) };
    fs.writeFileSync(path.join(mount, '.pentacle-container.json'), `${JSON.stringify({ schema: 1, kind, run_id: runId, limit: kind === 'scratch' ? LIMITS.scratch : LIMITS.evidence, seal })}\n`, { flag: 'wx', mode: 0o600 });
    // The marker is on the volume; the seal has not yet reached the caller or the journal.
    crashPoint('seal');
    return { kind, image_basename: path.basename(image), seal };
  } catch (error) {
    const failures = [error];
    // Prove the mount is gone BEFORE disposing of what backs it. If the detach fails, or the volume
    // is still enumerated afterwards, the image stays: a partially-created container left on disk is
    // recoverable, a mounted volume whose backing was unlinked is not.
    let detached = !attachAttempted;
    if (attachAttempted) {
      const attempted = execute === command ? null : { image, device: mount };
      try { releaseImageAttachment(mount, image, execute, attachedInventory, attempted); detached = true; }
      catch (cleanup) { failures.push(cleanup); }
    }
    if (detached && fs.existsSync(image)) { try { execute('/usr/bin/trash', [image]); } catch (cleanup) { failures.push(cleanup); } }
    // Same rule for the create path: the reader is the operator, not a debugger holding the object.
    if (failures.length === 1) throw error;
    const detail = failures.map((failure, index) => `${index === 0 ? 'primary' : `cleanup${index}`}=${String(failure?.message || failure)}`).join('; ');
    const aggregate = new Error(`CONTAINER_CREATE_CLEANUP_FAILED[${detail}]`);
    aggregate.errors = failures;
    throw aggregate;
  }
}

function ensureStateImage(execute = command) {
  const layout = fixedLayout();
  fs.mkdirSync(layout.support, { recursive: true, mode: 0o700 });
  if (fs.existsSync(layout.stateImage) || fs.existsSync(path.join(layout.state, 'authority.json'))) throw new Error('STATE_IMAGE_ALREADY_EXISTS');
  fs.mkdirSync(layout.state, { recursive: true, mode: 0o700 });
  execute('/usr/bin/hdiutil', ['create', '-quiet', '-type', 'SPARSEBUNDLE', '-fs', 'APFS', '-size', '64m', '-volname', 'Pentacle-State', layout.stateImage]);
  try { execute('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', layout.state, layout.stateImage]); }
  catch (error) {
    // A failed attach may still have left the volume up, so ATTEMPT the detach rather than proving
    // one nobody performed; a detach of a mount point that is already clear fails harmlessly and the
    // proof below is what actually gates the discard. Third site of the same operator-visibility
    // rule: if the tidy-up ALSO fails, the install path (storage-scheduler.cjs) must still be told
    // what went wrong first, not just that cleanup broke.
    try {
      const attempted = execute === command ? null : { image: layout.stateImage, device: layout.state };
      releaseImageAttachment(layout.state, layout.stateImage, execute, attachedInventory, attempted);
      execute('/usr/bin/trash', [layout.stateImage]);
    } catch (cleanup) { throw cleanupFailure('CONTAINER_STATE_IMAGE_CLEANUP_FAILED', error, cleanup); }
    throw error;
  }
  fs.chmodSync(layout.state, 0o700);
  return canonicalIdentity(layout.stateImage);
}

function resolveMounted(kind, runId, inventory = attachedInventory) {
  const mount = mountPath(kind);
  const image = imagePath(kind, runId);
  const observed = requireMountedImage(mount, image, inventory);
  canonicalIdentity(mount);
  const marker = path.join(mount, '.pentacle-container.json');
  // EVERY unusable-marker state reports as CONTAINER_SEAL_INVALID, including the ones the runtime
  // raises in its own vocabulary: a missing marker is ENOENT, a truncated one is a SyntaxError from
  // JSON.parse, and a marker whose `seal` is absent is a TypeError. Those are exactly as much proof
  // that this container is unusable as an explicit seal check failing, but under their raw names
  // they fall outside the replaceable set - so recovery would refuse to replace a genuinely broken
  // container, `recover-reserved` would raise before `first_dead_at` ever advanced, and every
  // later sweep would retry the same run forever. Normalised here rather than at each caller so
  // there is one vocabulary for "the mount is there and it is not ours to use".
  // ONLY the forms that prove the CONTENT is unusable normalise to SEAL_INVALID: the marker is
  // absent, it does not parse, or it parses to the wrong shape. Everything else - EACCES, EIO,
  // EMFILE, any authority or host failure - says the marker could not be READ, which is not
  // evidence about the container at all, and must never enter the replaceable set: a permissions
  // blip would otherwise authorize detaching and trashing a perfectly good image.
  let value;
  try {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('CONTAINER_SEAL_INVALID');
    value = JSON.parse(fs.readFileSync(marker, 'utf8'));
    // Every shape check the identity comparison depends on lives HERE, inside the classifier, so a
    // broken marker can never escape as an unnamed TypeError. `typeof null === 'object'` is the trap
    // that did: seal.image = null passed the old guard and then threw "Cannot read properties of
    // null" out of the identity loop, which is outside the replaceable set - so recovery refused to
    // replace a marker that is plainly broken, recreating the wedge this vocabulary exists to close.
    const plain = (candidate) => Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate);
    if (!plain(value) || !plain(value.seal) || !plain(value.seal.image)) throw new Error('CONTAINER_SEAL_INVALID:shape');
    // Defer to the SAME predicate that writes seals (scripts/storage-state.cjs exactSeal): exact
    // {object_id, image} keys, a real v4 UUID, and the exact identity shape. A local re-implementation
    // was looser than the contract twice over - it took any 36 characters of [0-9a-f-] as a UUID and
    // never checked the image key set - so a malformed seal and an image with an extra field both
    // resolved as healthy. One contract, one validator.
    if (!exactSeal(value.seal)) throw new Error('CONTAINER_SEAL_INVALID:seal-contract');
  } catch (error) {
    if (String(error?.message || '').startsWith('CONTAINER_SEAL_INVALID')) throw error;
    if (error?.code === 'ENOENT') throw new Error('CONTAINER_SEAL_INVALID:ENOENT');
    if (error instanceof SyntaxError) throw new Error(`CONTAINER_SEAL_INVALID:unparseable:${String(error.message).slice(0, 80)}`);
    throw new Error(`CONTAINER_SEAL_UNREADABLE:${error?.code || String(error?.message || error).slice(0, 80)}`);
  }
  if (value.schema !== 1 || value.kind !== kind || value.run_id !== runId || value.limit !== (kind === 'scratch' ? LIMITS.scratch : LIMITS.evidence)) throw new Error('CONTAINER_SEAL_MISMATCH');
  const identity = canonicalIdentity(image);
  for (const key of ['canonical', 'device', 'inode', 'uid', 'mode']) if (value.seal.image[key] !== identity[key]) throw new Error('CONTAINER_IDENTITY_DRIFT');
  const attachment = expectedAttachment(observed, mount, image);
  return { mount, image, seal: value.seal, attachment: attachment ? { ...attachment, trusted: true } : null };
}

function requireSeal(actual, expected) {
  if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('CONTAINER_JOURNAL_SEAL_MISMATCH');
}

// Scratch is UNLINKED, evidence is TRASHED, and the asymmetry is deliberate.
//
// Reaching here at all requires the journal-recorded seal to match the mounted image
// (requireSeal above), so the discard is already authorized by the durable record - the Trash
// copy adds no authorization and no recoverable information. What it does add is a second copy
// of the discarded bytes that survives on the same volume until a human empties the Trash. For
// scratch that is up to 12 GiB of reproducible build cache per run (measured 2026-07-22: a green
// certification parked ~8.5 GiB in Trash, and the next run then failed the 60 GiB start floor),
// so consecutive runs walk the volume toward the floor while reporting their scratch reclaimed.
// Scratch is regenerable from the candidate SHA; nothing is lost by unlinking it.
//
// Evidence is the opposite trade and keeps /usr/bin/trash: it is the failure artifact this lane
// treats as the most valuable object on the host, it is capped at 2 GiB, and its own retention
// clock (7 d green / 30 d failed) already bounds it. A wrong evidence discard is unrecoverable,
// so the second copy is worth its bytes there and is not worth them here.
function discardImage(kind, image, execute) {
  if (kind === 'scratch') execute('/bin/rm', ['-rf', '--', image]);
  else execute('/usr/bin/trash', [image]);
}

function detachAndDiscard(kind, runId, expectedSeal, execute = command, inventory = attachedInventory) {
  const resolved = resolveMounted(kind, runId, inventory);
  try { requireSeal(resolved.seal, expectedSeal); }
  catch (error) {
    try { detachAndProve(resolved.mount, resolved.image, execute, inventory, resolved.attachment); }
    catch (cleanup) { throw cleanupFailure('CONTAINER_DISCARD_REFUSAL_CLEANUP_FAILED', error, cleanup); }
    throw error;
  }
  detachAndProve(resolved.mount, resolved.image, execute, inventory, resolved.attachment);
  // Detached and PROVEN detached; the backing store is still there and the journal still says mounted.
  crashPoint('detach');
  if (!fs.existsSync(resolved.image)) throw new Error('CONTAINER_IMAGE_MISSING');
  discardImage(kind, resolved.image, execute);
  // The bytes are gone and no state transition has recorded it.
  crashPoint('discard');
  return { discarded: kind, run_id: runId };
}

// Recovery reaches this path only after the journal has durably entered a discarding state. The
// container marker may be the artifact that made the interrupted discard unrecoverable, so it cannot
// be consulted again. The journal seal still has to identify the backing image itself, and deletion
// remains gated by the same positive detach proof as the ordinary path.
function recoverDiscarding(kind, runId, expectedSeal, verify = null, execute = command, inventory = attachedInventory) {
  const image = imagePath(kind, runId);
  const mount = mountPath(kind);
  if (!fs.existsSync(image)) throw new Error('CONTAINER_IMAGE_MISSING');
  if (!exactSeal(expectedSeal)) throw new Error('CONTAINER_JOURNAL_SEAL_MISMATCH');
  const identity = canonicalIdentity(image);
  for (const key of ['canonical', 'device', 'inode', 'uid', 'mode']) {
    if (expectedSeal.image[key] !== identity[key]) throw new Error('CONTAINER_JOURNAL_IMAGE_IDENTITY_MISMATCH');
  }
  let observed;
  try { observed = confirmedInventory(mount, inventory, image); }
  catch (error) { throw new Error(`CONTAINER_MOUNT_INVENTORY:${error.message}`); }
  if (observed?.attached && !sameImage(observed.attached, image)) throw new Error('CONTAINER_MOUNT_SOURCE_DRIFT');
  let attachment = expectedAttachment(observed, mount, image);
  if (verify !== null && typeof verify !== 'function') throw new Error('CONTAINER_RECOVERY_VERIFY_INVALID');
  if (verify && !observed?.attached) {
    if (attachment) detachAndProve(mount, image, execute, inventory, { ...attachment, trusted: true });
    let attachAttempted = false;
    try {
      attachAttempted = true;
      execute('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mount, image]);
      observed = requireMountedImage(mount, image, inventory);
      attachment = expectedAttachment(observed, mount, image);
    } catch (primary) {
      try {
        const attempted = attachAttempted && execute !== command ? { image, device: mount } : null;
        detachAndProve(mount, image, execute, inventory, attempted);
      } catch (cleanup) { throw cleanupFailure('CONTAINER_RECOVERY_ATTACH_CLEANUP_FAILED', primary, cleanup); }
      throw primary;
    }
  }
  let verificationFailure = null;
  if (verify) {
    try { verify(mount); }
    catch (error) { verificationFailure = error; }
  }
  try {
    detachAndProve(mount, image, execute, inventory, attachment ? { ...attachment, trusted: true } : null);
  } catch (cleanup) {
    if (verificationFailure) throw cleanupFailure('CONTAINER_RECOVERY_VERIFY_CLEANUP_FAILED', verificationFailure, cleanup);
    throw cleanup;
  }
  if (verificationFailure) throw verificationFailure;
  crashPoint('detach');
  if (!fs.existsSync(image)) throw new Error('CONTAINER_IMAGE_MISSING');
  discardImage(kind, image, execute);
  crashPoint('discard');
  return { discarded: kind, run_id: runId };
}

function detachRetain(kind, runId, expectedSeal, execute = command, inventory = attachedInventory) {
  const resolved = resolveMounted(kind, runId, inventory);
  requireSeal(resolved.seal, expectedSeal);
  // Retaining the image does not make an unproven detach safe: the fixed mount point stays occupied,
  // the next run collides on it, and the caller reported success. Same proof as the discard path -
  // the only difference is what happens to the backing store afterwards.
  detachAndProve(resolved.mount, resolved.image, execute, inventory, resolved.attachment);
  return { retained: kind, run_id: runId };
}

function assertImageDetached(kind, runId) {
  requireImageDetached(mountPath(kind), imagePath(kind, runId), attachedInventory);
}

function forceDiscardFailedScratch(runId, expectedSeal, expectedDevice, revalidate, execute = command, inventory = attachedInventory) {
  const resolved = resolveMounted('scratch', runId, inventory);
  requireSeal(resolved.seal, expectedSeal);
  if (resolved.attachment.device !== expectedDevice || typeof revalidate !== 'function' || revalidate() !== true) throw new Error('SYSTEM_SCRATCH_FORCE_AUTHORITY');
  execute('/usr/bin/hdiutil', ['detach', '-force', expectedDevice]);
  requireImageDetached(resolved.mount, resolved.image, inventory);
  discardImage('scratch', resolved.image, execute);
  return { discarded: 'scratch', run_id: runId };
}

function attachExisting(kind, runId, execute = command, inventory = attachedInventory) {
  const image = imagePath(kind, runId);
  const mount = mountPath(kind);
  if (!fs.existsSync(image)) throw new Error('CONTAINER_IMAGE_MISSING');
  fs.mkdirSync(mount, { recursive: true, mode: 0o700 });
  let attachAttempted = false;
  try {
    attachAttempted = true;
    execute('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mount, image]);
    return resolveMounted(kind, runId, inventory);
  }
  catch (error) {
    // Releasing no bytes does not exempt this path from the no-mount-leak guarantee: a detach that
    // returns success without taking leaves the FIXED mount point occupied, the caller rethrows the
    // original error, and nothing anywhere says the mount is still there. Proven like every other.
    const attempted = attachAttempted && execute !== command ? { image, device: mount } : null;
    try { releaseImageAttachment(mount, image, execute, inventory, attempted); } catch (cleanup) { throw cleanupFailure('CONTAINER_ATTACH_CLEANUP_FAILED', error, cleanup); }
    throw error;
  }
}

// The ONLY failures that authorize discarding an existing image and building a replacement: the
// image is demonstrably there and demonstrably not usable as this run's container. Everything else -
// absence, a probe that never answered, another image mounted where ours should be, an attach the
// OS refused - says nothing about whether OUR image is intact, and replacing it on that evidence is
// data loss. Fail closed: an unrecognised failure is not replaceable either.
const REPLACEABLE = ['CONTAINER_SEAL_INVALID', 'CONTAINER_SEAL_MISMATCH', 'CONTAINER_IDENTITY_DRIFT'];
function replaceable(error) { return REPLACEABLE.includes(String(error?.message || '').split(':')[0]); }

// A REFUSED ATTACH IS NOT PROOF OF CORRUPTION, and treating it as such was the sharpest remaining
// hole: hdiutil refuses an attach precisely when the volume is ALREADY MOUNTED, so three false
// absence frames followed by a busy refusal would have trashed the backing image of a live,
// currently-mounted volume - and without detaching it first, leaving a mounted volume with no
// backing, the state this lane's history records needing `umount -f` plus `diskutil eject`. The
// same generic code also covers probe failures raised inside attachExisting. None of them say
// anything about OUR image, so none of them authorize replacing it; the only proof that survives
// is an unusable marker on a mount we can see, which resolveMounted now reports uniformly.

// LAST GATE BEFORE THE BYTES GO. Removing the backing store of a volume that is still mounted is
// the one outcome worse than either failure it is reached from, so nothing is discarded until the
// mount point is positively observed empty - not assumed empty because a detach returned, and not
// assumed empty because a probe once said absent. A detach that silently failed therefore raises
// here instead of stranding a mounted volume with no backing.
// ONE absent frame is not proof of detachment, for exactly the reason one absent frame is not proof
// of absence anywhere else in this module: the enumeration is machine-wide and measurably drops a
// live mount under concurrent hdiutil activity. Releasing a backing store is the irreversible
// direction, so it demands the STRONGER evidence - absence has to hold across consecutive
// observations. The cost is real and deliberate: a few extra probes on the green discard path, and
// in the worst case a bounded wait. If the proof cannot be obtained the discard does not happen and
// the run lands in a recoverable janitor state, which is the correct direction to fail.
const DETACH_CONFIRMATIONS = 3;
const DETACH_ATTEMPTS = 5;

function sameImage(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch { return false; }
}

function expectedAttachment(observed, mount, image) {
  if (observed?.expectedAttachment) return observed.expectedAttachment;
  if (observed?.attached && sameImage(observed.attached, image)) return { image: observed.attached, device: mount };
  return null;
}

function requireImageDetached(mount, image, inventory = attachedInventory) {
  let confirmations = 0;
  let attempts = 0;
  while (confirmations < DETACH_CONFIRMATIONS) {
    attempts += 1;
    try {
      const observed = inventory(mount, image);
      const attachment = expectedAttachment(observed, mount, image);
      if (observed?.attached && sameImage(observed.attached, image)) throw new Error(`CONTAINER_STILL_MOUNTED:${JSON.stringify({ mount, attached: observed.attached, confirmations })}`);
      if (attachment) throw new Error(`CONTAINER_IMAGE_STILL_ATTACHED:${JSON.stringify({ image, device: attachment.device, confirmations })}`);
      confirmations += 1;
    } catch (error) {
      if (!String(error.message).startsWith('CONTAINER_COMMAND_TIMEOUT')) throw error;
      if (attempts >= DETACH_CONFIRMATIONS + MOUNT_INVENTORY_ATTEMPTS) throw error;
    }
    if (confirmations < DETACH_CONFIRMATIONS) pause(MOUNT_INVENTORY_PAUSE_MS);
  }
}

function requireDetached(mount, inventory = attachedInventory, image = null) {
  let confirmations = 0;
  let attempts = 0;
  // A timed-out probe is NO ANSWER, here as everywhere else, and must not be terminal: measured
  // 2026-07-23, a plutil probe timing out under host load turned an otherwise green run into an
  // error after scratch_discarding. Only REAL absences count toward the proof; a no-answer costs an
  // attempt and is re-asked, and the attempt budget is what stops this from waiting forever.
  while (confirmations < DETACH_CONFIRMATIONS) {
    attempts += 1;
    try {
      const observed = inventory(mount, image);
      if (observed?.attached) throw new Error(`CONTAINER_STILL_MOUNTED:${JSON.stringify({ mount, attached: observed.attached, confirmations })}`);
      if (image) {
        const attachment = expectedAttachment(observed, mount, image);
        if (attachment) throw new Error(`CONTAINER_IMAGE_STILL_ATTACHED:${JSON.stringify({ image, device: attachment.device, confirmations })}`);
      }
      confirmations += 1;
    } catch (error) {
      if (!String(error.message).startsWith('CONTAINER_COMMAND_TIMEOUT')) throw error;
      if (attempts >= DETACH_CONFIRMATIONS + MOUNT_INVENTORY_ATTEMPTS) throw error;
    }
    if (confirmations < DETACH_CONFIRMATIONS) pause(MOUNT_INVENTORY_PAUSE_MS);
  }
}

function releaseImageAttachment(mount, image, execute, inventory = attachedInventory, initialAttachment = null) {
  let primary = null;
  let cleanup = null;
  for (let attempt = 1; attempt <= DETACH_ATTEMPTS; attempt += 1) {
    const trusted = attempt === 1 && initialAttachment?.trusted;
    let observed = null;
    if (!trusted) {
      try { observed = inventory(mount, image); }
      catch (error) {
        if (!String(error.message).startsWith('CONTAINER_COMMAND_TIMEOUT')) throw error;
        const priorNoAnswerExhausted = String(cleanup?.message || '').startsWith('CONTAINER_COMMAND_TIMEOUT');
        cleanup = error;
        if (!priorNoAnswerExhausted && attempt < DETACH_ATTEMPTS) { pause(MOUNT_INVENTORY_PAUSE_MS); continue; }
        if (primary) throw cleanupFailure('CONTAINER_DETACH_FAILED', primary, cleanup);
        throw error;
      }
    }
    const attachment = trusted ? initialAttachment : expectedAttachment(observed, mount, image)
      || (attempt === 1 && initialAttachment && !observed?.attached ? initialAttachment : null);
    if (!attachment) {
      try { requireImageDetached(mount, image, inventory); return; }
      catch (error) { cleanup = error; }
      if (attempt < DETACH_ATTEMPTS) { pause(MOUNT_INVENTORY_PAUSE_MS); continue; }
      throw cleanup;
    }
    try { execute('/usr/bin/hdiutil', ['detach', attachment.device]); }
    catch (error) { primary = error; }
    try { requireImageDetached(mount, image, inventory); return; }
    catch (error) { cleanup = error; }
    if (attempt < DETACH_ATTEMPTS) pause(MOUNT_INVENTORY_PAUSE_MS);
  }
  if (primary) throw cleanupFailure('CONTAINER_DETACH_FAILED', primary, cleanup);
  throw cleanup;
}

// The ONE way a backing store is ever released. Detaching and discarding used to be two independent
// statements at five call sites, and a detach that failed - or that returned success while the
// volume stayed up - let the very next line unlink the backing of a live mount. Every discard now
// goes through here, so the proof is not something a caller can forget: detach, observe the mount
// point empty, and only then hand back to the caller to discard.
function detachAndProve(mount, image, execute, inventory = attachedInventory, initialAttachment = null) {
  releaseImageAttachment(mount, image, execute, inventory, initialAttachment);
  requireDetached(mount, inventory, image);
}

function recoverOrCreate(kind, runId, execute = command, inventory = attachedInventory) {
  const image = imagePath(kind, runId);
  if (!fs.existsSync(image)) return createImage(kind, runId, execute);
  let observed;
  try { observed = confirmedInventory(mountPath(kind), inventory); } catch (error) { throw new Error(`CONTAINER_MOUNT_INVENTORY:${error.message}`); }
  const attached = observed?.attached ?? null;
  if (attached) {
    if (fs.realpathSync(attached) !== fs.realpathSync(image)) throw new Error('CONTAINER_MOUNT_SOURCE_DRIFT');
    try { return resolveMounted(kind, runId, inventory); }
    catch (error) {
      // A POSITIVE observation may not be overturned by a later negative one. resolveMounted probes
      // again, so without this test a three-frame false absence AFTER the mount was just confirmed
      // present would fall into detach + trash + recreate and destroy a live run's backing store -
      // the same defect as the one-shot probe, one layer further in. Only proof that the image is
      // there and UNUSABLE authorizes replacing it.
      if (!replaceable(error)) throw error;
      const attachment = expectedAttachment(observed, mountPath(kind), image);
      detachAndProve(mountPath(kind), image, execute, inventory, attachment ? { ...attachment, trusted: true } : null);
      execute('/usr/bin/trash', [image]);
      return createImage(kind, runId, execute);
    }
  }
  try { return attachExisting(kind, runId, execute, inventory); }
  catch (error) {
    if (!replaceable(error)) throw error;
    requireDetached(mountPath(kind), inventory, image);
    if (fs.existsSync(image)) execute('/usr/bin/trash', [image]);
    return createImage(kind, runId, execute);
  }
}

function freeBytes(target = fixedLayout().support, statfs = fs.statfsSync) {
  let stat;
  try { stat = statfs(target, { bigint: true }); }
  catch (cause) { throw namedDiskStatError('DiskStatSourceError', cause); }
  if (stat === null || typeof stat !== 'object') throw namedDiskStatError('DiskStatResultTypeError');
  for (const field of ['bavail', 'bsize']) {
    if (!Object.prototype.hasOwnProperty.call(stat, field)) throw namedDiskStatError('DiskStatFieldMissingError');
    if (typeof stat[field] === 'number' && !Number.isFinite(stat[field])) throw namedDiskStatError('DiskStatFieldNonFiniteError');
    if (typeof stat[field] !== 'bigint') throw namedDiskStatError('DiskStatFieldTypeError');
  }
  const available = stat.bavail * stat.bsize;
  if (available < 0n) throw namedDiskStatError('DiskStatProductNegativeError');
  if (stat.bsize === 0n || stat.bavail < 0n || stat.bsize < 0n) throw namedDiskStatError('DiskStatFieldRangeError');
  if (available > MAX_FREE_BYTES) throw namedDiskStatError('DiskStatProductRangeError');
  return available;
}

function namedDiskStatError(name, cause) {
  const error = new Error(name);
  error.name = name;
  if (cause !== undefined) error.cause = cause;
  return error;
}

// The identity of the volume the readings come from. fs.statfsSync returns exactly type, bsize,
// blocks, bfree, bavail, files, ffree - NO device id - so a statfs reading cannot say which volume
// it measured. Without this, a backing device swapped underneath the support root mid-run is
// unobservable: the numbers keep arriving, they simply describe a different volume, and the
// low-disk supervisor stop is then armed by a stranger's free space. Normalized to BigInt because
// the two shapes must never compare unequal for being differently typed.
function readDeviceIdentity(target, stat) {
  let result;
  try { result = stat(target); }
  catch (cause) { throw namedDiskStatError('DiskDeviceStatSourceError', cause); }
  if (result === null || typeof result !== 'object') throw namedDiskStatError('DiskDeviceResultTypeError');
  if (!Object.prototype.hasOwnProperty.call(result, 'dev')) throw namedDiskStatError('DiskDeviceFieldMissingError');
  const device = result.dev;
  if (typeof device === 'bigint') return device;
  if (typeof device !== 'number' || !Number.isSafeInteger(device)) throw namedDiskStatError('DiskDeviceFieldTypeError');
  return BigInt(device);
}

// Captured ONCE at initialization and re-verified before every reading. The start probe and the
// supervisor's running poll must share ONE guard - two guards each capturing their own identity
// would agree with themselves across a swap that happened between them, which is precisely the
// window the observation exists to close.
function createCapacityGuard({ target = fixedLayout().support, statfs = fs.statfsSync, stat = fs.statSync } = {}) {
  const device = readDeviceIdentity(target, stat);
  const verify = () => {
    if (readDeviceIdentity(target, stat) !== device) throw namedDiskStatError('DiskBackingDeviceChangedError');
  };
  return Object.freeze({
    device,
    freeBytes: () => { verify(); return freeBytes(target, statfs); },
    requireCapacity: (phase) => { verify(); return requireCapacity(phase, statfs, target); },
  });
}

function requireCapacity(phase, statfs = fs.statfsSync, target = fixedLayout().support) {
  const available = freeBytes(target, statfs);
  const threshold = phase === 'start' ? 60n * BigInt(GiB) : phase === 'running' ? 40n * BigInt(GiB) : null;
  if (threshold === null) throw new Error('CAPACITY_PHASE_INVALID');
  if (available < threshold) throw new Error(phase === 'start' ? 'DISK_START_BELOW_60_GIB' : 'DISK_RUNNING_BELOW_40_GIB');
  return available;
}

const MACOS_VOLUME_METADATA = new Set(['.fseventsd', '.Trashes', '.Spotlight-V100', '.DS_Store', '.TemporaryItems', '.DocumentRevisions-V100']);

function exactDirectoryBytes(root, { ignoreVolumeMetadata = false } = {}) {
  let total = 0;
  const origin = path.resolve(root);
  const stack = [origin];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignoreVolumeMetadata && current === origin && MACOS_VOLUME_METADATA.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error('CONTAINER_SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) stack.push(child);
      else if (stat.isFile()) total += stat.size;
      else throw new Error('CONTAINER_OBJECT_INVALID');
    }
  }
  return total;
}

function enforceCap(kind, root) {
  const limit = kind === 'scratch' ? LIMITS.scratch : kind === 'evidence' ? LIMITS.evidence : kind === 'config' ? LIMITS.config : null;
  const ignoreVolumeMetadata = kind === 'scratch' || kind === 'evidence';
  if (limit === null || exactDirectoryBytes(root, { ignoreVolumeMetadata }) > limit) throw new Error('CONTAINER_CAP_EXCEEDED');
}

function withinCap(kind, bytes) {
  const limit = kind === 'scratch' ? LIMITS.scratch : kind === 'evidence' ? LIMITS.evidence : kind === 'config' ? LIMITS.config : kind === 'state' ? LIMITS.state : null;
  if (limit === null || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('CONTAINER_SIZE_INVALID');
  return bytes <= limit;
}

function enforceImageBacking(kind, runId) {
  const logical = kind === 'scratch' ? LIMITS.scratch : kind === 'evidence' ? LIMITS.evidence : null;
  if (logical === null || exactDirectoryBytes(imagePath(kind, runId)) > logical + LIMITS.overhead) throw new Error('CONTAINER_BACKING_OVERHEAD');
  return true;
}

module.exports = { GiB, LIMITS, MiB, assertImageDetached, attachedImageAt, bind: (token) => require('./storage-capability.cjs').bind(token, { attachExisting, createImage, detachAndDiscard, detachRetain, ensureStateImage, forceDiscardFailedScratch, recoverDiscarding, recoverOrCreate }), createCapacityGuard, enforceCap, enforceImageBacking, exactDirectoryBytes, freeBytes, imagePath, mountPath, requireCapacity, requireSeal, resolveMounted, withinCap };
