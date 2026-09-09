'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fixedLayout, isResolvedAncestor } = require('./storage-authority.cjs');

function quote(value) { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }

function profileForRun() {
  const layout = fixedLayout();
  return renderProfile({ writeRoots: [layout.scratchMount, layout.evidenceMount].map((root) => fs.realpathSync(root)), readOnlyRoots: [fs.realpathSync(layout.state)] });
}

// CLOSED, individually-justified set of host-global rendezvous paths. Every child write must
// land inside the two capped mounts EXCEPT these: they broker access to the ONE host simulator,
// so making them private to the container does not isolate them, it breaks them. This set is
// enumerated, not pattern-matched. Adding a path requires editing BOTH the list below and the
// independently-written expectation in assertClosedHostGlobalSet(), so it can never drift
// silently and always lands in front of QA.
//
//   ~/.local/share/sim-queue
//     sim-queue's main() appends an audit record to log.jsonl on EVERY command, including the
//     read-only `status` the certified sim-resource-guard uses to validate its inherited ticket.
//     Without write access the guard cannot even read queue state. Measured growth: 4 records
//     x ~127 B = ~0.5 KB per gate run, so this is not a host-fill vector.
//
//   /private/tmp/idb   (idbRoot below)
//     idb hardcodes BASE_IDB_FILE_PATH='/tmp/idb' (idb/common/constants.py:25) for
//     <udid>_companion.sock and DERIVES IDB_LOGS_PATH from the same constant, with no client-side
//     override. The gate REQUIRES it - that is now measured, not predicted: checkbox-8 run example-09
//     failed report_viewer_horizontal_scroll SETUP_FAIL because no companion could be spawned for the
//     run's own simulator. Under the real rendered profile WITHOUT this entry, `touch /private/tmp/idb`
//     and `touch /private/tmp/idb/logs` both return "Operation not permitted" while the directory is
//     mode 777, so the denial is the sandbox and not filesystem permissions; and no companion log
//     existed for that run's UDID while /tmp/idb held zero sockets.
//     Socket-only is CLOSED, not open for re-litigation: companion_spawner.py:61 performs an unguarded
//     open(log_file_path, 'a') and passes the handle as the spawned companion's stderr, so a
//     non-writable log directory fails the spawn hard - the log is load-bearing, not a nicety.
//     Like the Darwin temporary root, this is admitted ONLY because it is paired with reclamation:
//     /tmp/idb/logs is a measured unbounded vector (520 MB already accumulated, and a single companion
//     log from one run measured 15.8 MB), so see reclaimIdbArtifacts in storage-gate.cjs. Exempting
//     without bounding would import a new unbounded host-growth vector, which is the founding defect
//     this entire lane exists to remove.
//   <per-user Darwin temporary directory>   (hostTemporaryRoot below)
//     actool and ibtool are Foundation tools and write their scratch here, NOT into $TMPDIR. Without
//     it release-sim-build cannot compile an asset catalog or a storyboard at all: measured, actool
//     exits 1 with "You don't have permission to save the file ... in the folder T" and ibtool does not
//     even report - it ABORTS with rc 134 and zero diagnostics, which is the whole reason the gate log
//     showed a bare "Command CompileStoryboard failed with a nonzero exit code".
//     This is a GENERAL-PURPOSE host directory, so unlike sim-queue its size is not self-bounding: QA
//     measured 9,024 leftover directories / 567 MB accumulated there over six days by the toolchain at
//     large. It is admitted only because it is paired with reclamation - see reclaimHostTemporary in
//     storage-gate.cjs, which deletes what this run added and fails the run if growth outlives it.
//     Attributable growth is ENTRY COUNT, not bytes: measured against a 25-second idle control of zero,
//     10x actool + 10x ibtool left exactly 20 entries at 0 KB, one per invocation.
function assertClosedHostGlobalSet(roots) {
  const expected = [path.join(require('node:os').homedir(), '.local', 'share', 'sim-queue'), idbRoot(), hostTemporaryRoot()];
  if (!Array.isArray(roots) || roots.length !== expected.length || roots.some((root, index) => root !== expected[index])) throw new Error('SANDBOX_HOST_GLOBAL_SET');
}

// ALWAYS the realpath form, and NOT the literal '/tmp/idb'. /tmp is a symlink to /private/tmp, and a
// sandbox rule written against the symlink form does NOT match - the identical trap hostTemporaryRoot
// documents below for /var -> /private/var, which cost a measured actool failure there. The directory is
// created if absent because idb creates it lazily and renderProfile must be able to resolve it on a host
// that has never run idb.
function idbRoot() {
  fs.mkdirSync('/private/tmp/idb', { recursive: true });
  return fs.realpathSync.native('/private/tmp/idb');
}

// ALWAYS resolved through getconf and then realpath. Two traps, both measured:
//   - It is NOT $TMPDIR. Foundation's NSTemporaryDirectory() ignores TMPDIR and returns
//     confstr(_CS_DARWIN_USER_TEMP_DIR): under TMPDIR=/private/tmp/zzz-probe it still returned
//     /var/folders/<xx>/<yy>/T. This is the same defect class as watchman's getpwuid escape - state
//     located by uid via libc, immune to the environment - and it is root-independent, so relocating
//     the storage root neither caused it nor can fix it.
//   - The realpath form is REQUIRED. /var is a symlink to /private/var, and a sandbox rule written
//     against "/var/folders/.../T" does NOT match: measured, actool still failed under that form and
//     succeeded only under "/private/var/folders/.../T". Do not "simplify" this to the getconf output.
function hostTemporaryRoot() {
  const raw = require('node:child_process').execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('SANDBOX_HOST_TEMPORARY_ROOT');
  return fs.realpathSync.native(raw);
}

// CLOSED, individually-justified set of host preference domains the container may WRITE. Both are
// snapshot-and-restored by the very guard that writes them, and both live in scripts/report-viewer-
// sim-e2e.cjs, which is CERTIFIED - so neither can be redirected, skipped, or hoisted out of the
// sandbox. Adding a domain requires editing BOTH the list below and the independently-written
// expectation in assertClosedPreferenceDomainSet(), so it can never drift silently.
//
//   com.apple.iphonesimulator / ConnectHardwareKeyboard
//     withSoftwareKeyboard must present the SOFTWARE keyboard for the comments case. It performs
//     the `defaults write` itself, checks its status, and throws on failure, and - unlike
//     suppressCrashReporterDialogs - exposes NO skip hook, so pre-setting the preference from the
//     wrapper changes nothing: the certified code still writes, still fails, still throws. A
//     wrapper-side hoist is therefore unavailable, which is the measured reason this is a profile
//     line and not a hoist like the layer-12 substrate reap.
//   com.apple.CrashReporter / DialogType
//     suppressCrashReporterDialogs forces `server` so the deliberately-crashed simulator app does
//     not pop a "quit unexpectedly" dialog on the operator's host. It is best-effort BY DESIGN
//     (`suppressed = applied.status === 0`, and restore() returns early when that is false), so
//     under the denial it did not throw - it silently did nothing, on every run. Two guards, one
//     denial, opposite visibility: the keyboard guard failed the gate, this one shrugged.
function assertClosedPreferenceDomainSet(domains) {
  const expected = ['com.apple.iphonesimulator', 'com.apple.CrashReporter'];
  if (!Array.isArray(domains) || domains.length !== expected.length || domains.some((domain, index) => domain !== expected[index])) throw new Error('SANDBOX_PREFERENCE_DOMAIN_SET');
}

function preferenceWriteDomains() {
  const domains = ['com.apple.iphonesimulator', 'com.apple.CrashReporter'];
  assertClosedPreferenceDomainSet(domains);
  return domains;
}

// ALWAYS derived from the REAL uid. The region is named per-user, so a hardcoded 501 would silently
// stop matching for any other operator and degrade reads back to the fabricated-absent behaviour
// described on the profile line below - the exact silent failure this grant exists to end.
function preferenceCacheShmName() { return `apple.cfprefs.${process.getuid()}v1`; }

function hostGlobalWriteRoots() {
  const roots = [path.join(require('node:os').homedir(), '.local', 'share', 'sim-queue'), idbRoot(), hostTemporaryRoot()];
  assertClosedHostGlobalSet(roots);
  return roots;
}

function resolvedRootRecords(roots) {
  try {
    for (const root of roots) fs.mkdirSync(root, { recursive: true });
    return roots.map((root) => {
      const resolved = fs.realpathSync.native(root);
      const stat = fs.statSync(resolved);
      return { resolved, device: stat.dev, inode: stat.ino };
    });
  } catch {
    throw new Error("SANDBOX_ROOT_IDENTITY");
  }
}

function renderProfile(authority) {
  if (!authority || JSON.stringify(Object.keys(authority).sort()) !== JSON.stringify(['readOnlyRoots', 'writeRoots']) || !Array.isArray(authority.writeRoots) || authority.writeRoots.length !== 2 || !Array.isArray(authority.readOnlyRoots) || authority.readOnlyRoots.length !== 1) throw new Error('SANDBOX_ROOT_IDENTITY');
  const hostGlobalRoots = hostGlobalWriteRoots();
  const suppliedRoots = [...authority.writeRoots, ...authority.readOnlyRoots, ...hostGlobalRoots];
  if (suppliedRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("SANDBOX_ROOT_IDENTITY");
  const records = resolvedRootRecords(suppliedRoots);
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const left = records[leftIndex];
      const right = records[rightIndex];
      const sameIdentity = left.device === right.device && left.inode === right.inode;
      if (sameIdentity || isResolvedAncestor(left.resolved, right.resolved) || isResolvedAncestor(right.resolved, left.resolved)) {
        throw new Error("SANDBOX_ROOT_IDENTITY");
      }
    }
  }
  authority = {
    writeRoots: records.slice(0, 2).map(({ resolved }) => resolved),
    readOnlyRoots: records.slice(2, 3).map(({ resolved }) => resolved),
    hostGlobalRoots: records.slice(3).map(({ resolved }) => resolved),
  };
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    // Guardians must signal inherited sandbox descendants, including orphaned process groups.
    // Direct-children permission denies grandchildren with EPERM and leaves scratch mounted.
    // The same-sandbox boundary excludes host processes; real positive/negative controls test it.
    '(allow signal (target same-sandbox))',
    // `defaults` is TWO mechanisms with two different denials, which is why one row of the
    // containment audit was wrong in BOTH directions - it was reasoned, not measured, and the
    // failing half was silent.
    //   READ goes through a POSIX shared-memory map of the user preference cache. Denied, CFPrefs
    //     does NOT fail: it logs "going volatile, because unable to obtain shmem entry" and serves
    //     an EMPTY store, so `defaults read` answers "does not exist" for a key that IS present on
    //     the host. That is worse than a denial - it FABRICATES a wrong answer. Both host-preference
    //     guards read-then-restore, so each would "restore" by DELETING the operator's real key.
    //     Measured: with these lines the container reads the true host value; with the shm name
    //     altered by one character, or with the lines removed, the read reports absent.
    //   WRITE goes to cfprefsd over mach and is gated by `user-preference-write`, a SEPARATE
    //     top-level operation - exactly like `signal` in layer 11, and not implied by mach-lookup.
    // The read half grants NO new reach: the blanket `(allow file-read*)` below already lets the
    // container read every preference plist on disk (measured directly against
    // com.apple.iphonesimulator.plist under the base profile). It restores the FIDELITY of a read
    // the container already has, nothing more, and READ-ONLY shm operations are sufficient
    // (measured), so the container cannot write into the shared cache.
    // The write half is the only actual privilege increase, and it is bounded to the two enumerated
    // domains above. Privilege cost measured to the layer-11 standard: a granted domain writes,
    // ANY other domain is denied and its host value is left untouched.
    `(allow ipc-posix-shm-read-data (ipc-posix-name "${quote(preferenceCacheShmName())}"))`,
    `(allow ipc-posix-shm-read-metadata (ipc-posix-name "${quote(preferenceCacheShmName())}"))`,
    ...preferenceWriteDomains().map((domain) => `(allow user-preference-write (preference-domain "${quote(domain)}"))`),
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow network*)',
    '(allow file-read*)',
    ...authority.readOnlyRoots.map((root) => `(deny file-write* (subpath "${quote(root)}"))`),
    ...authority.writeRoots.map((root) => `(allow file-write* (subpath "${quote(root)}"))`),
    ...authority.hostGlobalRoots.map((root) => `(allow file-write* (subpath "${quote(root)}"))`),
    '(allow file-write* (literal "/dev/null"))',
  ].join('\n');
}

function sandboxed(argv) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('SANDBOX_ARGV_INVALID');
  return ['/usr/bin/sandbox-exec', '-p', profileForRun(), ...argv];
}

module.exports = { bind: (token) => require('./storage-capability.cjs').bind(token, { sandboxed }), hostTemporaryRoot, idbRoot, profileForRun, renderProfile };
