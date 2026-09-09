'use strict';

// Teardown for fixtures that run the real storage stack under an isolated HOME.
//
// Two defects this exists to prevent, both measured on this host:
//
// 1. Fixtures disposed of their temporary HOME with /usr/bin/trash, so every run parked its whole
//    root - 133 MiB for one q5 invocation - in the operator's Trash, where it stays on the same
//    volume until a human empties it. Thirteen such roots had accumulated. A suite written to prove
//    the gate reclaims its own storage must not itself accumulate storage.
// 2. A fixture that attached an image and then removed its HOME left the volume MOUNTED with no
//    backing path, and those mounts are the ones this lane's history records needing `umount -f`
//    plus `diskutil eject`. Removal alone does not detach.
//
// So: detach first, delete second, and PROVE both - a teardown that silently tolerates a leak is
// the exact defect class the lane exists to remove. Deletion is a plain recursive unlink because
// the target is a fixture root this process created moments earlier, not user data.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Same rule as the product side: a synchronous child with no bound cannot be interrupted by a test
// runner timeout either, so a wedged `mount` or `hdiutil detach` would hang the whole suite process
// exactly the way the unbounded mount probe did.
const TEARDOWN_TIMEOUT_MS = 60000;

function bounded(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: TEARDOWN_TIMEOUT_MS });
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) throw new Error(`TEST_TEARDOWN_TIMEOUT:${path.basename(binary)}:${TEARDOWN_TIMEOUT_MS}`);
  return result;
}

function mountedUnder(root) {
  const listed = bounded('/sbin/mount', []);
  if (listed.status !== 0) throw new Error(`TEST_TEARDOWN_MOUNT_UNREADABLE:${listed.status}`);
  return String(listed.stdout || '').split('\n')
    .map((line) => /^\S+ on (.+?) \(/.exec(line)?.[1])
    .filter((point) => point && (point === root || point.startsWith(`${root}/`)));
}

// FAIL CLOSED ON THE ARGUMENT ITSELF. This detaches volumes and recursively deletes a tree, so it
// must never be reachable with a wrong root - a caller that passed `os.homedir()` by accident would
// be catastrophic and there is no undo. The three conditions together admit exactly the fixture
// roots this helper exists for: created by mkdtemp directly inside the process temp directory, and
// named with the storage-fixture prefix. Canonical paths are compared, so a symlinked argument
// cannot smuggle a target in from elsewhere.
function requireFixtureRoot(root) {
  const canonical = fs.realpathSync(root);
  // Fixtures in this suite use BOTH process temp roots: os.tmpdir() (per-user, /var/folders/...) and
  // a realpath'd /tmp. Admitting exactly these two keeps the guard as tight as it was while covering
  // every fixture family; anything else is still refused.
  const parents = [os.tmpdir(), '/tmp'].map((candidate) => { try { return fs.realpathSync(candidate); } catch { return null; } }).filter(Boolean);
  if (!parents.includes(path.dirname(canonical))) throw new Error(`TEST_TEARDOWN_ROOT_UNOWNED:${canonical}`);
  if (!/^(pentacle-)?storage-/.test(path.basename(canonical))) throw new Error(`TEST_TEARDOWN_ROOT_UNRECOGNISED:${canonical}`);
  if (!fs.lstatSync(canonical).isDirectory()) throw new Error(`TEST_TEARDOWN_ROOT_NOT_A_DIRECTORY:${canonical}`);
  return canonical;
}

// Deepest-first, because a nested mount cannot be detached through its parent.
function disposeIsolatedHome(target) {
  const root = requireFixtureRoot(target);
  const detached = [];
  for (const point of mountedUnder(root).sort((a, b) => b.length - a.length)) {
    const result = bounded('/usr/bin/hdiutil', ['detach', point]);
    if (result.status !== 0) throw new Error(`TEST_TEARDOWN_DETACH_FAILED:${point}:${String(result.stderr || '').trim()}`);
    detached.push(point);
  }
  // BEFORE the delete, not after: checking once the tree is already gone reports a leak that the
  // delete itself may have caused, and by then the backing store is unrecoverable. Absence has to
  // hold across consecutive observations for the same reason it does in the product - the mount
  // enumeration drops live entries under concurrent hdiutil activity.
  for (let confirmation = 0; confirmation < 3; confirmation += 1) {
    const remaining = mountedUnder(root);
    if (remaining.length) throw new Error(`TEST_TEARDOWN_MOUNT_LEAKED:${JSON.stringify(remaining)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  fs.rmSync(root, { recursive: true, force: true });
  const survivors = mountedUnder(root);
  if (survivors.length) throw new Error(`TEST_TEARDOWN_MOUNT_LEAKED_AFTER_REMOVAL:${JSON.stringify(survivors)}`);
  if (fs.existsSync(root)) throw new Error(`TEST_TEARDOWN_ROOT_LEAKED:${root}`);
  // userInfo().homedir, not homedir(): a fixture that redirects HOME must still be checked against
  // the operator's REAL Trash, which is the volume that actually fills.
  const trashed = path.join(os.userInfo().homedir, '.Trash', path.basename(root));
  if (fs.existsSync(trashed)) throw new Error(`TEST_TEARDOWN_TRASH_RESIDUE:${trashed}`);
  return { detached };
}

module.exports = { disposeIsolatedHome, mountedUnder };
