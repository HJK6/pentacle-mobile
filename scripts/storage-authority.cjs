'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTRACT = Object.freeze({
  endpoints: Object.freeze({
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
  }),
  states: Object.freeze({
    installed: ['absent', 'prepared', 'installed', 'updating', 'restoring'],
    run: ['reserved', 'allocated', 'running', 'sealing', 'published', 'scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded', 'blocked_unclassified', 'backing_absent'],
    supervisor: ['initial', 'spawned', 'stopping', 'reaping', 'cleaning', 'complete'],
    ticket: ['registered', 'eligible', 'removing', 'removed', 'blocked'],
    scheduler: ['absent', 'prepared', 'candidate_installed', 'smoke_verified', 'committed', 'rolling_back', 'restored'],
  }),
});

// LAYER 16 RE-PIN, 2026-07-22. The two report-viewer digests below MOVED, deliberately and reviewed; the
// other six did not, and a change that moves any of them is a different act needing its own argument.
//
// WHY: `withSoftwareKeyboard` threw on ANY pre-existing Simulator, and launched its own with `open -g -a
// Simulator`. LaunchServices app launch is denied inside the gate sandbox (-54), so the certified code
// could not run there at all, and no sandbox grant narrower than a blanket `(allow lsopen)` exists — that
// was measured and REFUSED. The certified code now TOLERATES a pre-existing surface that is provably
// bound to its exact UDID, so the wrapper can launch it outside the sandbox. Tolerant, not weaker: an
// absent surface, an ambiguous set, an unreadable identity, or one bound to another UDID all still throw,
// and the adoption proof is the identical `commandHasExactArgumentPair` check the launch path applies to
// the surface it creates. Adoption deliberately does NOT set `launched`, so the certified teardown does
// not run against a process it did not create — which is also why the sandbox never needs signal-to-others.
//
// SECOND MOVE, same two files, same day. Adoption alone was not enough: every signal
// `withSoftwareKeyboard` emits — the ownership triple, the preference write — happens AFTER the probe
// that decides whether to adopt, so a launcher watching for any of them arrives too late by
// construction. The DENIAL is now the trigger: when the launch is refused, the function waits briefly
// for a surface and adopts it if it proves the exact UDID. Outside the sandbox the launch succeeds and
// that branch never runs, so the standalone path is unchanged. Still tolerant, not weaker — none, wrong
// UDID, unreadable identity and more-than-one each refuse, with their OWN message so the four causes
// stay distinguishable.
//
// The same move carries the LAYER-17 INSTRUMENTATION, deliberately not deferred: this change is what
// makes adoption succeed for the first time, so shipping the instrument later would leave the one event
// we most need to observe unobserved. `withSoftwareKeyboard` now reports unconditionally which mode ran,
// whether the teardown block ran, and whether a kill was attempted — the two facts the layer-17 argument
// rests on, STATED rather than inferred from the absence of a denial in a kernel log.
//
// These bytes are reviewed source, not merely re-measured bytes. Recompute both digests from the
// artifacts independently rather than checking these numbers against themselves; a re-pin is
// indistinguishable from a silent fork if nobody re-derives it.
// The set is also the complete repository-local require closure of every entry. The closure test
// derives those imports from source, so adding or editing an imported module cannot leave the
// certified program unchanged on paper. The full-gate pins below move for explicit gate-code
// provenance; its helper, plugin and simulator imports enter the set because they execute in that program.
const CERTIFIED_COMPONENTS = Object.freeze({
  'pentacle.config.example.ts': '03be8f39a941a5f937a2ec4ac97e389dba8a744c4b3295cd5c6c53d52c16add4',
  'plugins/withHarnessLaunchUrl.js': '17e0d96c38e95555815f1fad8ef3ab311564b02f6a7d6a833fe31851fca75a08',
  'scripts/full-gate.cjs': '4be06730ac597c57cbba1c7f3e1ec4a6bbe51178487b5eff3ce38c8d8a801145',
  'scripts/full-gate.test.cjs': '48f7115859f40fa9d6c7e9f8daa24785bd2cefcedc3e283ef7ac394153f6e7f4',
  'scripts/gate-app-ready.cjs': 'dca3be9c08dce3c6adae44cbed09a6b4e4834ece24a02c67fe1b9207bded92f5',
  'scripts/gate-build-policy.cjs': 'ee848848b375e79ee37660f1c0e6a4beee0cc99c7be85b8d66762b03de562567',
  'scripts/gate-checks.cjs': '314c7bdb6b6d2ee47ec6e51f0a67af3c9c8bd6ab1579a1b5b1af029545ea1ba8',
  'scripts/gate-code-provenance.cjs': '472d3f0c31c11d12c2c30ad005b1dfb221c23dc0bbbf4506cc53f2fd1ccc1317',
  'scripts/gate-cpu-accounting.cjs': '52f98392780db563dbb1f38425e968b190b84f6f4c57dd8e84594d438e931b58',
  'scripts/gate-host-health.cjs': 'f4b67aba828a67fcffabf9017383ed4ace28f0b2ab61b40239e5ec2748dad212',
  'scripts/gate-process-cpu.py': '0534f53046f14cac963565336673d2e71983f01c061bc7e0e74780e8aff22c4b',
  'scripts/owned-process.cjs': '9f0a45f47395af5b6de954e9b787f339b3067be6a5ebffd634075a03690818db',
  'scripts/prod-build.cjs': '1631cc4c25afd48079e3b2024d056997789dbb791bae73e8cd553552776046bf',
  'scripts/report-viewer-sim-e2e.cjs': '127f255238056c18da13471f77f83fb2c029558bfcded296c18e972325c94b53',
  'scripts/report-viewer-sim-e2e.test.cjs': '8a31418d2e95751253b06f89eb654feb5a0ec5c1ee18911d339b00f57214c884',
  'scripts/reset-simulator-app.cjs': '9b41a6acaba3fe27f319a89f4d7824a4e221c764efd657fa77e33bcb089284f5',
  'scripts/sim-resource-guard.cjs': '5d9c910ba81db1526f5a5cb74db47ff206497979aa280461d1b67b4db7a15b9c',
  'scripts/sim-substrate.cjs': '7d357248c077e9d7833e84d5ff5ea7e7dece7ccff1f0d6014d2c6e57e8396c59',
  'scripts/storage-gate.cjs': '6386b5e33f87d0c2d66dea3de5ecb0c503e8d85d5382aa0b0db5f6041fd3ee48',
  'scripts/wire-contract-sim-e2e.cjs': 'b9f8a46167ec1c9a5a68150faa42f43b14cb9d84566ce361206f3d587c300e94',
  'scripts/wire-contract-sim-e2e.test.cjs': 'c91a665db99c04a0b2d7139d5f9cee10f0dfdaafefbb43843c56eeae87e4b00e',
  'test/e2e/__init__.py': '1948fbbfd7e4223867ed98177e05ea7e4b9a8eacb99b3905f5577fd81e8591c9',
  'test/e2e/harness/__init__.py': 'e50e1ddce7047fb424cd6427b2e38a2ec133604de833aa095ccf3f9a2156b509',
  'test/e2e/harness/asserts.py': '9e75e7839d1c03150fc5a9e7f7e332ce487d950c0e54aa7e05942807b961e3ce',
  'test/e2e/harness/fd_guard.py': 'a15b45c4bb1cf1ec563f098d7e6a5745360c1253c63b5f05b01fec85ae095d3f',
  'test/e2e/harness/log_capture.py': 'c3770c9c30b2bfd629cf3d7a4993c90a0bd6f177bcdade89632cb1552c268b73',
  'test/e2e/harness/render_evidence.py': '0c1f97e20f26a604234366d04abdb59abb6da92e78f0886c7e6a55b73be5bc76',
  'test/e2e/harness/telemetry_events.py': '6fb135b164b0261cafcf4563ff282efce20999d33131c5f5c0388024d386f365',
  'test/e2e/recorder_preflight.py': 'e972794ae5c807e449402ee283673c6a528f2ade79098d7c038154ba4584275c',
  'test/e2e/run_scenario.py': 'fcc6b9ea2353e2748a97d95fce7f0613cb5ed73aa7eab81db7008c8ff6cf520b',
  'test/e2e/scenarios/__init__.py': '72d44eae31d83b58bc62ec58e034a87d01ab246532e5138dbd6c41053906c75d',
  'test/e2e/scenarios/_question_evidence.py': '1669c21d3d1dff5a15db07fa628bbf82ad5947bf3567721da458366febeaa2fd',
  'test/e2e/scenarios/report_viewer_comments_keyboard.py': '61922b7cdf1381f154a5a082568d493c36011bc260b75f78b488ec19662d1ada',
  'test/e2e/scenarios/report_viewer_horizontal_scroll.py': '4c77e3909b1c8fdfbdef5d298a8f7d1bc8e5b1c72c59fc82449a5e142ba558a9',
  'test/e2e/scenarios/report_viewer_runtime_sentinel.py': '4f9aa1b6b8ff862e6dc3ace585022836bdcec2ceaec46bb775bcc5afcaf87779',
  'test/e2e/tests/__init__.py': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'test/e2e/tests/conftest.py': '824e59cbc35a4c6e8a6164d1866d47cdc0391b349bbf0453f38671c7ace10fbc',
  'test/e2e/tests/test_native_capture.py': '72da9930c8001f4c6ea63bbf16cea3218ece7ef97c8a5a4cca5f6e72c1caef78',
  'test/e2e/tests/test_recorder_preflight.py': '6696724c2ae420e4fd5417e983381dfe02afc53d7c0ce0eba7e6b0369ced5254',
  'test/e2e/tests/test_run_scenario.py': 'e0962762307f6f25a81e47c9272efe9433205a2e060615639bfd322c00647d97',
  'test/e2e/wire_contract_validator.py': 'b2f9d8727577f6615337079227c75d7acef82169c7847ad8593828ebee759ac3',
  'test/fixtures/testtime-stub.cjs': '88375dc2a42f19c7ecf727c51d00e079fe41a4a51a84f08873761988d93f90e4',
  'test/testtime-jest-reporter.cjs': '3dde015e551bab360c7fb53b459858d1fd650b2df5ca8db0340ca2fff8717e70',
  'test/testtime-jest-reporter.test.cjs': 'fba5c267fe50168087e4a3c183af1b2e812a67e75cec966d5e6b9a7a3c281080',
});

const RUN_EDGES = Object.freeze({
  reserved: ['allocated'],
  allocated: ['running', 'scratch_discarding'],
  running: ['sealing', 'scratch_discarding'],
  sealing: ['published', 'blocked_unclassified', 'scratch_discarding'],
  published: ['scratch_discarding'],
  // backing_absent is the terminal disposition for a dead-owner run whose journal-named backing images
  // are PROVABLY gone from disk. It is reached without discarding anything - the bytes were already lost
  // out of band - so it is NOT on the scratch/evidence discard chain, which every other terminal edge is.
  blocked_unclassified: ['scratch_discarding', 'backing_absent'],
  scratch_discarding: ['scratch_discarded'],
  scratch_discarded: ['evidence_discarding'],
  evidence_discarding: ['evidence_discarded'],
  evidence_discarded: [],
  backing_absent: [],
});

const SUPERVISOR_EDGES = Object.freeze({
  initial: ['spawned'],
  spawned: ['stopping', 'cleaning'],
  stopping: ['reaping', 'cleaning'],
  reaping: ['cleaning'],
  cleaning: ['complete'],
  complete: [],
});

const INSTALLED_EDGES = Object.freeze({ absent: ['prepared'], prepared: ['installed'], installed: ['updating', 'restoring'], updating: ['installed'], restoring: ['absent'] });
const TICKET_EDGES = Object.freeze({ registered: ['eligible', 'blocked'], eligible: ['removing', 'blocked'], removing: ['removed', 'blocked'], removed: [], blocked: [] });
const SCHEDULER_EDGES = Object.freeze({ absent: ['prepared'], prepared: ['candidate_installed', 'rolling_back'], candidate_installed: ['smoke_verified', 'rolling_back'], smoke_verified: ['committed', 'rolling_back'], committed: [], rolling_back: ['restored'], restored: [] });

const ALIASES = Object.freeze({
  'report-a': '00000000-0000-4000-8000-000000000001',
  'report-b': '00000000-0000-4000-8000-000000000002',
  'report-c': '00000000-0000-4000-8000-000000000003',
  '35e2eca8': '35e2eca866304e6631b91183d7105d3ec204afa2',
  c657cbf1: 'c657cbf15f9dbabb92f094a2fb375f7ff56b609b',
  '732d4462': '732d44628504629f12fc0f33d2265e4ef226404c',
});

const HISTORICAL_WITNESSES = Object.freeze([
  ['35-AUTH', 'report-a', '35e2eca8', 'allocation before durable intent; missing UID/mode/parent identity', 'I1/I2', 'reject'],
  ['35-ATOMIC', 'report-a', '35e2eca8', 'crash between identity rewrite and destination authority', 'I3', 'reject'],
  ['35-REF', 'report-a', '35e2eca8', 'owner completed->in_progress at final recheck; missing status root', 'I4', 'reject'],
  ['35-GIT', 'report-a', '35e2eca8', 'SHA/branch/device drift; clean behind-contained branch', 'I5', 'mixed'],
  ['35-CAP', 'report-a', '35e2eca8', '100 GiB mount, late singleton, absent state quota, 5s/device drift, write escape', 'I6', 'reject'],
  ['35-PROC', 'report-a', '35e2eca8', 'leader exits 0 with live descendants', 'I7', 'reject'],
  ['35-EVID', 'report-a', '35e2eca8', 'empty run/native objects, no stages/recorder/hash audit', 'I8', 'reject'],
  ['35-RET', 'report-a', '35e2eca8', 'old updated_at used at first death observation; second worktree wait', 'I9', 'mixed'],
  ['35-SCHED', 'report-a', '35e2eca8', 'no singleton/rotation/recovery; swallowed restore failure', 'I10', 'reject'],
  ['35-CORPUS', 'report-a', '35e2eca8', 'docs claim states with no causal internal crash cases', 'closed', 'reject'],
  ['C657-AUTH', 'report-b', 'c657cbf1', 'arbitrary configured-looking root deleted', 'I1/I2', 'reject'],
  ['C657-INTENT', 'report-b', 'c657cbf1', 'abandoned allocation intent/root absent from reconciliation', 'I1/I3/I9', 'reject'],
  ['C657-HANDOFF', 'report-b', 'c657cbf1', 'marker rewritten with staged source and absent accepting destination', 'I1/I2/I3', 'reject'],
  ['C657-SOURCE', 'report-b', 'c657cbf1', 'work/in_progress removed immediately before Git removal', 'I4/I5', 'reject'],
  ['C657-CAP', 'report-b', 'c657cbf1', 'empty fake state quota; unreconciled handed lock; default sim-set reads', 'I2/I3/I6', 'reject'],
  ['C657-PROC', 'report-b', 'c657cbf1', 'descendant exits on TERM but allowed status becomes failure', 'I7', 'accept'],
  ['C657-EVID', 'report-b', 'c657cbf1', 'trivial 11-stage pairs and empty recorder manifest', 'I8', 'reject'],
  ['C657-RET', 'report-b', 'c657cbf1', 'exact-24h tree needs second invocation; removed_at clock', 'I9', 'mixed'],
  ['C657-SCHED', 'report-b', 'c657cbf1', 'installed metadata crash rolls back then foreign-change deadlocks', 'I10', 'accept'],
  ['732-AUTH', 'report-c', '732d4462', 'caller self-declares arbitrary authorityRoot; generation absent', 'I1/I2', 'reject'],
  ['732-ATOMIC', 'report-c', '732d4462', 'scheduler rename lacks parent-directory fsync', 'I3', 'reject'],
  ['732-REF', 'report-c', '732d4462', 'body-only id/status accepted as frontmatter', 'I4', 'reject'],
  ['732-GIT', 'report-c', '732d4462', 'branch lane accepts upstream origin/other', 'I5', 'reject'],
  ['732-CAP', 'report-c', '732d4462', 'candidate config writable outside cap before post-run size check', 'I6', 'reject'],
  ['732-PROC', 'report-c', '732d4462', 'signal+close emits duplicate TERM and KILL', 'I7', 'reject'],
  ['732-EVID', 'report-c', '732d4462', 'unknown nested file accepted; videos not case/digest/time bound', 'I8', 'reject'],
  ['732-RET', 'report-c', '732d4462', 'deleted_at mutable/missing with updated_at fallback', 'I9', 'reject'],
  ['732-SCHED', 'report-c', '732d4462', 'unknown plist overwritten; mtime-only failed smoke commits', 'I10', 'reject'],
]);

// THIRD CONTAINMENT CLASS: the fixed roots must satisfy the constraints of every toolchain that
// runs inside them, which nothing else in the root map captures. The container's roots were
// originally under "Library/Application Support/...", and the SPACE in that path broke the build:
// CocoaPods/Expo generate script phases into node_modules that do not quote their paths, so a
// Release build died with `bash: /Users/example/Library/Application: No such file or directory`
// roughly forty minutes into a gate. We cannot quote generated phases we do not own, and we cannot
// symlink around it either, because canonicalIdentity refuses a symlinked root (AUTHORITY_ROOT_ALIAS).
// The root itself therefore has to be toolchain-safe, and that has to be enforced rather than
// remembered.
//
// Conservative allowlist: [A-Za-z0-9._/-] only. That rejects spaces, non-ASCII, and every
// shell-significant character in one rule, instead of trying to enumerate what each toolchain
// mishandles. The length bound leaves headroom for the very deep trees built beneath these roots -
// DerivedData/Pods build paths observed around 500 characters below the root - inside the 1024-byte
// macOS PATH_MAX.
const TOOLCHAIN_SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const MAX_INSTALLED_ROOT_LENGTH = 120;

function assertToolchainSafePath(label, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error(`ROOT_PATH_UNSAFE:${label}`);
  if (!TOOLCHAIN_SAFE_PATH.test(target)) throw new Error(`ROOT_PATH_UNSAFE:${label}`);
  return target;
}

// The length bound belongs on the installed ROOT, because every other path and the whole build tree
// beneath it are derived from that prefix - bounding the root is what actually reserves headroom.
function assertInstalledRootLength(root) {
  if (typeof root !== 'string' || root.length > MAX_INSTALLED_ROOT_LENGTH) throw new Error('ROOT_PATH_TOO_LONG:support');
  return root;
}

// FOURTH CONTAINMENT CLASS: host-global singleton identities that are NOT derived from the
// installed root. They neither move when the root moves nor stop two installs from colliding, and
// relocating the root made that acute — for the first time two roots can coexist while these names
// cannot tell them apart. Observed instances: a LaunchAgent left loaded against a stale worktree
// path, and an orphaned real-home simulator symlink stranded precisely because its root was not
// under the root that moved.
//
// The rule enforced below: every identity in the layout must be classified as exactly one of
//   * OWNED_UNDER_ROOT     - a mutable identity this install owns, and it MUST live under the root,
//                            so it moves with the root and two roots cannot share it;
//   * HOST_GLOBAL_IDENTITIES - unavoidably host-global, and therefore REQUIRED to carry a stated
//                            collision rule;
//   * EXTERNAL_REFERENCE_ROOTS - read/resolved but never created or mutated by the install, so it
//                            has no collision surface.
// An unclassified key fails closed, so a future layout addition cannot skip this decision.
const OWNED_UNDER_ROOT = Object.freeze(['stateImage', 'state', 'scratchImages', 'evidenceImages', 'scratchMount', 'evidenceMount', 'buildCache']);
const HOST_GLOBAL_IDENTITIES = Object.freeze({
  // launchd's label namespace is process-wide; there is no per-root label, so this identity cannot
  // be moved under the root. Collision rule: first install REJECTS an unowned existing label or
  // plist (SCHEDULER_EXISTING_LABEL_OR_PLIST), so a plist belonging to another root can never be
  // silently adopted. That rejection is exercised by a dedicated test, not merely asserted here.
  launchAgent: 'launchd label namespace is host-global; collision rule = first install rejects an unowned existing label/plist',
});
const EXTERNAL_REFERENCE_ROOTS = Object.freeze(['home', 'support', 'worktrees', 'memory', 'repositories']);

function isUnderRoot(root, target) {
  const normalisedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return typeof target === 'string' && target.startsWith(normalisedRoot);
}

// Path-BOUNDARY containment on resolved paths. Lives here rather than in storage-sandbox.cjs so
// there is exactly one implementation: sandbox imports authority, so authority cannot import sandbox.
// A string prefix would let <home>/repos/pentacle-mobile-evil pass as "inside" pentacle-mobile.
function isResolvedAncestor(ancestor, descendant) {
  let cursor = descendant;
  while (true) {
    if (cursor === ancestor) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function resolveExisting(target) {
  try { return fs.realpathSync.native(target); }
  catch { throw new Error(`SCHEDULER_ARGV_PATH_MISSING:${path.resolve(target)}`); }
}

// Same fourth-class defect, one level deeper: renderPlist() derives ProgramArguments from __dirname,
// so whichever checkout runs the install is baked into the LaunchAgent. That argv is therefore
// checkout-derived - it neither moves with the installed root nor is protected from this janitor's
// own deletion authority. fixedLayout().worktrees is precisely the root the janitor retires, so a
// plist installed from a worktree names a script the janitor may later remove, after which the agent
// fires on its interval against a missing file and fails INVISIBLY, because /dev/null streams are
// invariant 10 by design. Observed for real on this host: a plist whose argv pointed at
// ~/agent-workspace/worktrees/pentacle-mobile__test_storage_self_cleanup_2026_07. Failing closed at
// install is earlier and cheaper than trying to protect it as a non-terminal reference during
// worktree retirement.
// Two POSITIVE assertions against authority we already hold, rather than a heuristic about which
// directories feel permanent - install has no principled notion of a "durable path", but the
// installed root map does enumerate the known main repositories:
//   (a) the rendered argv MUST resolve inside a known main repository, and
//   (b) it MUST NOT resolve inside the janitor-retirable worktrees root.
// Same closed shape as the rest of the installed authority, so an ephemeral lane clone or a
// worktree checkout cannot bake itself into a LaunchAgent that outlives it.
function assertSchedulerArgvDurable(layout = fixedLayout(), scriptRoot = __dirname, sealedRepositories = null, interpreter = process.execPath) {
  // Resolve before comparing so an alias or symlinked checkout cannot smuggle itself across a
  // boundary, and compare with isResolvedAncestor rather than a string prefix.
  const resolvedScriptRoot = resolveExisting(scriptRoot);
  const resolvedScript = resolveExisting(path.join(resolvedScriptRoot, 'storage-cli.cjs'));
  const resolvedInterpreter = resolveExisting(interpreter);
  if (!fs.statSync(resolvedScript).isFile()) throw new Error('SCHEDULER_ARGV_SCRIPT_NOT_FILE');
  if (!fs.statSync(resolvedInterpreter).isFile()) throw new Error('SCHEDULER_ARGV_INTERPRETER_NOT_FILE');
  try { fs.accessSync(resolvedInterpreter, fs.constants.X_OK); }
  catch { throw new Error('SCHEDULER_ARGV_INTERPRETER_NOT_EXECUTABLE'); }
  // Prefer the SEALED canonical roots from the installed root map when the caller has an authority
  // to hand us; canonicalIdentity already refused symlinks and aliases when they were sealed, and
  // validateInstalledAuthority re-proves them (AUTHORITY_ROOT_DRIFT) on every use. Before the first
  // install there is no sealed map yet, so fall back to resolving the installer constants.
  const repositories = (sealedRepositories && sealedRepositories.length ? sealedRepositories : Object.values(layout.repositories)).map(resolveExisting);
  // BOTH assertions are kept deliberately. The second is not redundant: `git worktree add` can place
  // a worktree INSIDE the repository directory, so a path can satisfy (a) and still be retirable.
  // Worktrees first, so the more specific and more actionable error wins: a path under the retirable
  // worktrees root is also outside every known repository, and "you installed from a worktree" tells
  // an operator far more than "outside a known repository". This ordering is also what keeps the
  // second assertion reachable rather than shadowed.
  if (isResolvedAncestor(resolveExisting(layout.worktrees), resolvedScriptRoot)) throw new Error('SCHEDULER_ARGV_INSIDE_WORKTREES');
  if (!repositories.some((repository) => isResolvedAncestor(repository, resolvedScriptRoot))) throw new Error('SCHEDULER_ARGV_OUTSIDE_KNOWN_REPOSITORY');
  return layout;
}

function assertIdentityOwnership(layout = fixedLayout()) {
  assertSchedulerArgvDurable(layout);
  const classified = new Set([...OWNED_UNDER_ROOT, ...Object.keys(HOST_GLOBAL_IDENTITIES), ...EXTERNAL_REFERENCE_ROOTS]);
  for (const key of Object.keys(layout)) {
    if (!classified.has(key)) throw new Error(`IDENTITY_UNCLASSIFIED:${key}`);
  }
  for (const key of OWNED_UNDER_ROOT) {
    if (!isUnderRoot(layout.support, layout[key])) throw new Error(`IDENTITY_NOT_UNDER_ROOT:${key}`);
  }
  for (const [key, rule] of Object.entries(HOST_GLOBAL_IDENTITIES)) {
    if (typeof rule !== 'string' || !rule.includes('collision rule')) throw new Error(`IDENTITY_HOST_GLOBAL_UNDECLARED:${key}`);
  }
  return layout;
}

// Fail closed over every installed root and mountpoint, so a root that violates a toolchain
// constraint is impossible to install rather than discovered mid-gate.
function assertToolchainSafeLayout(layout = fixedLayout()) {
  for (const key of ['support', 'stateImage', 'state', 'scratchImages', 'evidenceImages', 'scratchMount', 'evidenceMount', 'buildCache', 'worktrees', 'launchAgent']) {
    assertToolchainSafePath(key, layout[key]);
  }
  for (const [name, repository] of Object.entries(layout.repositories)) assertToolchainSafePath(`repositories.${name}`, repository);
  assertInstalledRootLength(layout.support);
  assertIdentityOwnership(layout);
  return layout;
}

function fixedLayout() {
  const home = os.homedir();
  const support = path.join(home, 'Library', 'PentacleMobileStorage');
  return Object.freeze({
    home,
    support,
    stateImage: path.join(support, 'State.sparsebundle'),
    state: path.join(support, 'State'),
    buildCache: path.join(support, 'BuildCache'),
    scratchImages: path.join(support, 'ScratchImages'),
    evidenceImages: path.join(support, 'EvidenceImages'),
    scratchMount: path.join(support, 'Scratch'),
    evidenceMount: path.join(support, 'Evidence'),
    worktrees: path.join(home, 'agent-workspace', 'worktrees'),
    memory: path.join(home, 'agent-workspace', 'pentacle-memory'),
    repositories: Object.freeze({ 'pentacle-mobile': path.join(home, 'repos', 'pentacle-mobile') }),
    launchAgent: path.join(home, 'Library', 'LaunchAgents', 'com.pentacle.mobile.storage-janitor.plist'),
  });
}

function rejectAuthority(message = 'FORBIDDEN_AUTHORITY') {
  const error = new Error(message);
  error.code = 'FORBIDDEN_AUTHORITY';
  throw error;
}

function validateScalar(name, value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) rejectAuthority();
  if (name.endsWith('_id') && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) rejectAuthority();
  if (name === 'run_id' || name === 'ticket_id') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) rejectAuthority();
  }
  if (name === 'lock_token' && !/^[0-9a-f]{64}$/.test(value)) rejectAuthority();
  if (name === 'mode' && value !== 'dry-run' && value !== 'apply') rejectAuthority();
  if (name === 'candidate_ref' && (path.isAbsolute(value) || value.includes('..') || value.startsWith('-'))) rejectAuthority();
}

function parseEndpoint(endpoint, input) {
  const fields = CONTRACT.endpoints[endpoint];
  if (!fields || !input || Array.isArray(input) || typeof input !== 'object') rejectAuthority();
  const keys = Object.keys(input).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...fields].sort())) rejectAuthority();
  const result = {};
  for (const field of fields) {
    validateScalar(field, input[field]);
    result[field] = input[field];
  }
  return result;
}

function rejectEnvironmentAuthority(environment = process.env) {
  const forbidden = Object.keys(environment).filter((name) => /^PENTACLE_STORAGE_.*(?:PATH|ROOT|DIR)$/.test(name) || ['PENTACLE_GATE_ARTIFACT_DIR', 'PENTACLE_GATE_NATIVE_ROOT', 'PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT'].includes(name));
  if (forbidden.length) rejectAuthority(`FORBIDDEN_AUTHORITY:${forbidden.sort().join(',')}`);
  return true;
}

function transition(model, current, next) {
  const edges = { run: RUN_EDGES, supervisor: SUPERVISOR_EDGES, installed: INSTALLED_EDGES, ticket: TICKET_EDGES, scheduler: SCHEDULER_EDGES }[model];
  if (!edges || !edges[current] || !edges[current].includes(next)) throw new Error('FORBIDDEN_TRANSITION');
  return next;
}

function generatedId() { return crypto.randomUUID(); }
function generatedToken() { return crypto.randomBytes(32).toString('hex'); }

module.exports = {
  ALIASES,
  CERTIFIED_COMPONENTS,
  CONTRACT,
  HISTORICAL_WITNESSES,
  INSTALLED_EDGES,
  RUN_EDGES,
  SUPERVISOR_EDGES,
  SCHEDULER_EDGES,
  TICKET_EDGES,
  assertIdentityOwnership,
  assertSchedulerArgvDurable,
  isResolvedAncestor,
  assertToolchainSafeLayout,
  assertToolchainSafePath,
  fixedLayout,
  generatedId,
  generatedToken,
  parseEndpoint,
  rejectEnvironmentAuthority,
  transition,
};
