'use strict';

// Scenario-output recertification: independently reviewed bytes, public example review.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EXPECTED_PINS = {
  // Independently derived from the reviewed artifacts. This oracle deliberately restates the complete
  // closure rather than importing the authority table, so a pin-site edit cannot agree with itself.
  'scripts/gate-app-ready.cjs': 'dca3be9c08dce3c6adae44cbed09a6b4e4834ece24a02c67fe1b9207bded92f5',
  'scripts/gate-build-policy.cjs': 'ede25009d9cb865a760c56da127f0a5147248be3d0810b9f02ad534440958b45',
  'scripts/gate-checks.cjs': '314c7bdb6b6d2ee47ec6e51f0a67af3c9c8bd6ab1579a1b5b1af029545ea1ba8',
  'scripts/gate-process-cpu.py': '0534f53046f14cac963565336673d2e71983f01c061bc7e0e74780e8aff22c4b',
  'scripts/gate-cpu-accounting.cjs': '52f98392780db563dbb1f38425e968b190b84f6f4c57dd8e84594d438e931b58',
  'scripts/gate-host-health.cjs': 'f4b67aba828a67fcffabf9017383ed4ace28f0b2ab61b40239e5ec2748dad212',
  'scripts/owned-process.cjs': '9f0a45f47395af5b6de954e9b787f339b3067be6a5ebffd634075a03690818db',
  'plugins/withHarnessLaunchUrl.js': '17e0d96c38e95555815f1fad8ef3ab311564b02f6a7d6a833fe31851fca75a08',
  // CPU-tick readiness recertification; independent artifact digests, launch_cpu provenance.
  'scripts/full-gate.cjs': '225f9d678d76ac5c3babdcd34a55d32ebe799628d09c76c20ae1679566361824',
  'scripts/full-gate.test.cjs': 'edb00cdcfa26229a485bec8bc6590eb58eac2b05aeb0a9cb9086725809495f2f',
  'scripts/gate-code-provenance.cjs': '472d3f0c31c11d12c2c30ad005b1dfb221c23dc0bbbf4506cc53f2fd1ccc1317',
  'scripts/report-viewer-sim-e2e.cjs': 'bedffe7f5212f5c8768e9c41374f425cc64132c620ce41a15a531f186a163587',
  'scripts/report-viewer-sim-e2e.test.cjs': '225a7181792be00bbf22a658eee95f4b11db6fe15c9e8c7578193bcfff63c7f2',
  'scripts/sim-resource-guard.cjs': '5d9c910ba81db1526f5a5cb74db47ff206497979aa280461d1b67b4db7a15b9c',
  'scripts/sim-substrate.cjs': '6be2a4801854d965c208db673bad731a56ffd03e38350866fd94e5b139b89672',
  'scripts/wire-contract-sim-e2e.cjs': 'b5e47b08421b76c735a3c73da553c6645008cbea2fffca5d2712e265aeafe8f4',
  'scripts/wire-contract-sim-e2e.test.cjs': '9b2d421e144f66581610592f6aa27b44d23310cc741181e45e4b249a771ff48f',
  'test/testtime-jest-reporter.cjs': '7677be47ffd5746e0164b014126bd590ae5e3226169afdba4e57bb1f793c23f7',
  'test/e2e/recorder_preflight.py': '583c232a1d3bdcdb2beb92a63d94be6c81008291e5c7260aacab9bb9ca04e1a0',
  'test/e2e/tests/test_recorder_preflight.py': 'f13b3f9bf8b9bee318d9b3cae28e7804006f4ae8f064eeb5af9d431ad8362dd6',
};

const EXPECTED_RUN_EDGES = {
  reserved: ['allocated'], allocated: ['running', 'scratch_discarding'], running: ['sealing', 'scratch_discarding'],
  sealing: ['published', 'blocked_unclassified', 'scratch_discarding'], published: ['scratch_discarding'],
  blocked_unclassified: ['scratch_discarding', 'backing_absent'], scratch_discarding: ['scratch_discarded'],
  scratch_discarded: ['evidence_discarding'], evidence_discarding: ['evidence_discarded'], evidence_discarded: [],
  backing_absent: [],
};

const WITNESS_IDS = [
  '35-AUTH', '35-ATOMIC', '35-REF', '35-GIT', '35-CAP', '35-PROC', '35-EVID', '35-RET', '35-SCHED', '35-CORPUS',
  'C657-AUTH', 'C657-INTENT', 'C657-HANDOFF', 'C657-SOURCE', 'C657-CAP', 'C657-PROC', 'C657-EVID', 'C657-RET', 'C657-SCHED',
  '732-AUTH', '732-ATOMIC', '732-REF', '732-GIT', '732-CAP', '732-PROC', '732-EVID', '732-RET', '732-SCHED',
];

test('certified gate files retain the exact independent closure pins', () => {
  const root = path.resolve(__dirname, '..');
  const actual = {};
  for (const [relative, expected] of Object.entries(EXPECTED_PINS)) {
    actual[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
    assert.equal(actual[relative], expected);
  }
  assert.deepEqual(require('./storage-authority.cjs').CERTIFIED_COMPONENTS, EXPECTED_PINS);
});

test('run model accepts every explicit edge and rejects every other state pair', () => {
  const { CONTRACT, RUN_EDGES, transition } = require('./storage-authority.cjs');
  assert.deepEqual(RUN_EDGES, EXPECTED_RUN_EDGES);
  for (const from of CONTRACT.states.run) {
    for (const to of CONTRACT.states.run) {
      if ((EXPECTED_RUN_EDGES[from] || []).includes(to)) assert.equal(transition('run', from, to), to);
      else assert.throws(() => transition('run', from, to), /FORBIDDEN_TRANSITION/);
    }
  }
});

test('installed, supervisor, ticket, and scheduler models reject every unlisted edge', () => {
  const authority = require('./storage-authority.cjs');
  const expected = {
    installed: { absent: ['prepared'], prepared: ['installed'], installed: ['updating', 'restoring'], updating: ['installed'], restoring: ['absent'] },
    supervisor: { initial: ['spawned'], spawned: ['stopping', 'cleaning'], stopping: ['reaping', 'cleaning'], reaping: ['cleaning'], cleaning: ['complete'], complete: [] },
    ticket: { registered: ['eligible', 'blocked'], eligible: ['removing', 'blocked'], removing: ['removed', 'blocked'], removed: [], blocked: [] },
    scheduler: { absent: ['prepared'], prepared: ['candidate_installed', 'rolling_back'], candidate_installed: ['smoke_verified', 'rolling_back'], smoke_verified: ['committed', 'rolling_back'], committed: [], rolling_back: ['restored'], restored: [] },
  };
  for (const [model, edges] of Object.entries(expected)) {
    for (const from of authority.CONTRACT.states[model]) {
      for (const to of authority.CONTRACT.states[model]) {
        if ((edges[from] || []).includes(to)) assert.equal(authority.transition(model, from, to), to);
        else assert.throws(() => authority.transition(model, from, to), /FORBIDDEN_TRANSITION/);
      }
    }
  }
});

test('installed authority rejects absent, unknown, host, UID, generation, and root-schema mutations', () => {
  const { validateAuthorityShape } = require('./storage-state.cjs');
  const identity = (canonical) => ({ canonical, device: '1', inode: '2', uid: 501, mode: 448 });
  const expected = { host: 'hosta', uid: 501, roots: { scratch_images: '/fixed/scratch', evidence_images: '/fixed/evidence', worktrees: '/fixed/worktrees', repositories: { mobile: '/fixed/repo' } } };
  const valid = { schema: 1, generation: '00000000-0000-4000-8000-000000000000', host: 'hosta', uid: 501, state: 'installed', created_at: '2026-07-17T00:00:00Z', roots: { scratch_images: identity('/fixed/scratch'), evidence_images: identity('/fixed/evidence'), worktrees: identity('/fixed/worktrees'), repositories: { mobile: identity('/fixed/repo') } } };
  assert.equal(validateAuthorityShape(valid, expected), true);
  const mutations = [
    { ...valid, host: 'other' }, { ...valid, uid: 0 }, { ...valid, generation: '' }, { ...valid, extra: true },
    { ...valid, roots: { ...valid.roots, unknown: identity('/fixed/unknown') } },
    { ...valid, roots: { ...valid.roots, scratch_images: { ...valid.roots.scratch_images, alias: true } } },
    { ...valid, roots: { ...valid.roots, repositories: {} } },
  ];
  for (const mutation of mutations) assert.throws(() => validateAuthorityShape(mutation, expected), /AUTHORITY_/);
});

test('run journals reject unknown fields and malformed owner/revision authority', () => {
  const { validateRecord } = require('./storage-state.cjs');
  const valid = { schema: 1, id: '00000000-0000-4000-8000-000000000000', revision: 0, state: 'reserved', generation: '00000000-0000-4000-8000-000000000001', owner: { host: 'hosta', uid: 501, pid: 42 }, candidate_ref: 'a'.repeat(40), scratch_image: '00000000-0000-4000-8000-000000000000.sparsebundle', evidence_image: '00000000-0000-4000-8000-000000000000.sparsebundle', lock_token_digest: 'b'.repeat(64), reserved_at: '2026-07-17T00:00:00.000Z', first_dead_at: null };
  assert.equal(validateRecord('runs', valid), true);
  for (const mutation of [{ extra: true }, { revision: -1 }, { owner: { ...valid.owner, path: '/tmp' } }, { owner: null }, { schema: 2 }, { id: '../escape' }, { generation: 'forged' }, { reserved_at: 'not-a-clock' }]) assert.throws(() => validateRecord('runs', { ...valid, ...mutation }), /AUTHORITY_RECORD/);
  assert.throws(() => validateRecord('runs', { ...valid, state: 'allocated' }), /AUTHORITY_RECORD/);
});

test('tickets require immutable source and clock authority', () => {
  const { validateRecord } = require('./storage-state.cjs');
  const valid = { schema: 1, id: '00000000-0000-4000-8000-000000000000', revision: 0, state: 'registered', generation: '00000000-0000-4000-8000-000000000001', main_repo_id: 'pentacle-mobile', spec_id: 'spec_x', lane_id: 'lane', branch: 'fix/lane', upstream: 'origin/fix/lane', head: 'a'.repeat(40), source_digest: 'b'.repeat(64), basename: 'lane', device: '1', inode: '2', registered_at: '2026-07-17T00:00:00.000Z', creator: { host: 'hosta', uid: 501, pid: 42 } };
  assert.equal(validateRecord('tickets', valid), true);
  for (const mutation of [{ source_digest: undefined }, { source_digest: 'bad' }, { registered_at: 'not-a-clock' }, { generation: 'bad' }, { id: '../other' }]) assert.throws(() => validateRecord('tickets', { ...valid, ...mutation }), /AUTHORITY_RECORD/);
});

test('mutation modules expose no arbitrary path-taking writer', () => {
  const state = require('./storage-state.cjs');
  assert.equal(Object.hasOwn(state, 'atomicJson'), false);
  assert.equal(Object.hasOwn(state, 'fsyncDirectory'), false);
});

test('all 28 immutable historical witnesses, aliases, and I1-I10 coverage survive', () => {
  const { ALIASES, HISTORICAL_WITNESSES } = require('./storage-authority.cjs');
  assert.equal(HISTORICAL_WITNESSES.length, 28);
  assert.deepEqual(HISTORICAL_WITNESSES.map(([id]) => id), WITNESS_IDS);
  assert.deepEqual(ALIASES, {
    'report-a': '00000000-0000-4000-8000-000000000001', 'report-b': '00000000-0000-4000-8000-000000000002',
    'report-c': '00000000-0000-4000-8000-000000000003', '35e2eca8': '35e2eca866304e6631b91183d7105d3ec204afa2',
    c657cbf1: 'c657cbf15f9dbabb92f094a2fb375f7ff56b609b', '732d4462': '732d44628504629f12fc0f33d2265e4ef226404c',
  });
  const coverage = new Set(HISTORICAL_WITNESSES.flatMap((entry) => entry[4].match(/I\d+/g) || []));
  assert.deepEqual([...coverage].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), Array.from({ length: 10 }, (_, index) => `I${index + 1}`));
  for (const entry of HISTORICAL_WITNESSES) {
    assert.ok(ALIASES[entry[1]]);
    assert.ok(ALIASES[entry[2]]);
    assert.ok(['reject', 'accept', 'mixed'].includes(entry[5]));
  }
});

test('1 MiB, 64 MiB, 2 GiB, and 12 GiB literal byte boundaries are inclusive and overflow rejects', () => {
  const { LIMITS, withinCap } = require('./storage-containers.cjs');
  const specifiedBytes = {
    config: 1_048_576,
    state: 67_108_864,
    evidence: 2_147_483_648,
    scratch: 12_884_901_888,
  };
  for (const [kind, bytes] of Object.entries(specifiedBytes)) {
    assert.equal(LIMITS[kind], bytes, `${kind} implementation limit must equal the specified literal byte count`);
    assert.equal(withinCap(kind, bytes - 1), true);
    assert.equal(withinCap(kind, bytes), true);
    assert.equal(withinCap(kind, bytes + 1), false);
  }
});

test('60 GiB start and 40 GiB running boundaries fail only below the inclusive cutoff', () => {
  const { GiB, requireCapacity } = require('./storage-containers.cjs');
  const stat = (bytes) => () => ({ bavail: BigInt(bytes), bsize: 1n });
  assert.throws(() => requireCapacity('start', stat(60 * GiB - 1)), /BELOW_60/);
  assert.equal(requireCapacity('start', stat(60 * GiB)), 60n * BigInt(GiB));
  assert.throws(() => requireCapacity('running', stat(40 * GiB - 1)), /BELOW_40/);
  assert.equal(requireCapacity('running', stat(40 * GiB)), 40n * BigInt(GiB));
});

test('start capacity admits the independent literal byte immediately above 60 GiB', () => {
  const { requireCapacity } = require('./storage-containers.cjs');
  const aboveSixtyGiB = 64_424_509_441n;
  assert.equal(requireCapacity('start', () => ({ bavail: aboveSixtyGiB, bsize: 1n })), aboveSixtyGiB);
});

test('sparse backing admits the literal logical cap plus 256 MiB and rejects one byte more', (t) => {
  const { enforceImageBacking, imagePath } = require('./storage-containers.cjs');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), 'storage-backing-cap-')));
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const runId = '00000000-0000-4000-8000-000000000099';
  const image = imagePath('scratch', runId);
  fs.mkdirSync(image, { recursive: true });
  const band = path.join(image, 'band');
  const exactBackingBytes = 13_153_337_344;
  fs.writeFileSync(band, '');
  fs.truncateSync(band, exactBackingBytes);
  assert.equal(enforceImageBacking('scratch', runId), true);
  fs.truncateSync(band, exactBackingBytes + 1);
  assert.throws(() => enforceImageBacking('scratch', runId), /CONTAINER_BACKING_OVERHEAD/);
});

test('sandbox admits only scratch/evidence writes and keeps state read-only', (t) => {
  const { renderProfile } = require('./storage-sandbox.cjs');
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), 'storage-sandbox-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'scratch');
  const evidence = path.join(root, 'evidence');
  const state = path.join(root, 'state');
  const profile = renderProfile({ writeRoots: [scratch, evidence], readOnlyRoots: [state] });
  assert.match(profile, /\(deny default\)/);
  assert.ok(profile.includes(`(allow file-write* (subpath "${scratch}"))`));
  assert.ok(profile.includes(`(allow file-write* (subpath "${evidence}"))`));
  assert.ok(profile.includes(`(deny file-write* (subpath "${state}"))`));
  assert.equal(profile.includes(`(allow file-write* (subpath "${state}"))`), false);
  for (const broad of ['/tmp', '/Users/operator', '/Library/Developer/CoreSimulator']) {
    assert.equal(profile.includes(`(allow file-write* (subpath "${broad}"))`), false);
  }
  assert.throws(() => renderProfile({ writeRoots: [scratch, scratch], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
  assert.throws(() => renderProfile({ writeRoots: ['relative', evidence], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
  assert.throws(() => renderProfile({ writeRoots: [root, evidence], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
});

test('supervisor event injection produces one TERM, one KILL, and one cleanup at most', () => {
  const { SupervisorMachine } = require('./storage-supervisor.cjs');
  for (const first of ['SIGINT', 'SIGTERM', 'low-disk', 'child-error']) {
    const machine = new SupervisorMachine();
    machine.move('spawned');
    assert.equal(machine.beginShutdown(first), true);
    for (const duplicate of ['SIGINT', 'SIGTERM', 'low-disk', 'child-error', 'close']) assert.equal(machine.beginShutdown(duplicate), false);
    assert.equal(machine.beginReap(), true);
    assert.equal(machine.beginReap(), false);
    assert.equal(machine.beginCleanup(), true);
    assert.equal(machine.beginCleanup(), false);
    machine.complete();
    assert.deepEqual([machine.termCount, machine.killCount, machine.cleanupCount], [1, 1, 1]);
  }
});

test('retention clocks are inclusive and missing, future, or rollback values fail closed', () => {
  const { DAY, inclusiveElapsed, runDecision } = require('./storage-janitor.cjs');
  const now = Date.parse('2026-07-17T00:00:00.000Z');
  assert.equal(inclusiveElapsed(new Date(now - DAY).toISOString(), DAY, now), true);
  assert.equal(inclusiveElapsed(new Date(now - DAY + 1).toISOString(), DAY, now), false);
  assert.equal(inclusiveElapsed(new Date(now + 1).toISOString(), DAY, now), false);
  assert.deepEqual(runDecision({ state: 'scratch_discarded', published_at: null, gate_status: 0 }, now), { action: 'retain', reason: 'publication-authority-missing' });
  assert.equal(runDecision({ state: 'scratch_discarded', published_at: new Date(now - 7 * DAY).toISOString(), gate_status: 0 }, now).action, 'discard-evidence');
  assert.equal(runDecision({ state: 'scratch_discarded', published_at: new Date(now - 30 * DAY).toISOString(), gate_status: 17 }, now).action, 'discard-evidence');
});

test('24-hour, 7-day, and 30-day retention clocks cover before, equal, and after with literal durations', () => {
  const { runDecision } = require('./storage-janitor.cjs');
  const now = Date.parse('2026-07-17T00:00:00.000Z');
  const dead = { host: require('node:os').hostname(), uid: process.getuid(), pid: 2_147_483_647 };
  const unpublished = {
    state: 'running', owner: dead, preliminary_audit_at: '2026-07-15T00:00:00.000Z',
    preliminary_evidence_digest: 'a'.repeat(64),
  };
  assert.deepEqual(runDecision({ ...unpublished, first_dead_at: new Date(now - 86_400_000 + 1).toISOString() }, now), { action: 'retain', reason: 'dead-under-24h' });
  assert.deepEqual(runDecision({ ...unpublished, first_dead_at: new Date(now - 86_400_000).toISOString() }, now), { action: 'discard-scratch' });
  assert.deepEqual(runDecision({ ...unpublished, first_dead_at: new Date(now - 86_400_000 - 1).toISOString() }, now), { action: 'discard-scratch' });

  const retained = (gateStatus, age) => runDecision({ state: 'scratch_discarded', gate_status: gateStatus, published_at: new Date(now - age).toISOString() }, now);
  assert.deepEqual(retained(0, 604_800_000 - 1), { action: 'retain', reason: 'evidence-retention' });
  assert.deepEqual(retained(0, 604_800_000), { action: 'discard-evidence' });
  assert.deepEqual(retained(0, 604_800_000 + 1), { action: 'discard-evidence' });
  assert.deepEqual(retained(17, 2_592_000_000 - 1), { action: 'retain', reason: 'evidence-retention' });
  assert.deepEqual(retained(17, 2_592_000_000), { action: 'discard-evidence' });
  assert.deepEqual(retained(17, 2_592_000_000 + 1), { action: 'discard-evidence' });
});

test('retention rejects malformed, future, and rolled-back observations with named reasons', () => {
  const { runDecision } = require('./storage-janitor.cjs');
  const observedNow = Date.parse('2026-07-17T00:00:00.000Z');
  const publishedAt = new Date(observedNow - 604_800_000).toISOString();
  const base = { state: 'scratch_discarded', gate_status: 0 };
  assert.deepEqual(runDecision({ ...base, published_at: 'not-an-iso-clock' }, observedNow), { action: 'retain', reason: 'evidence-retention' });
  assert.deepEqual(runDecision({ ...base, published_at: new Date(observedNow + 1).toISOString() }, observedNow), { action: 'retain', reason: 'evidence-retention' });
  assert.deepEqual(runDecision({ ...base, published_at: publishedAt }, observedNow), { action: 'discard-evidence' });
  assert.deepEqual(runDecision({ ...base, published_at: publishedAt }, observedNow - 604_800_001), { action: 'retain', reason: 'evidence-retention' });
});

test('LaunchAgent contract is fixed, background, dry-run, six-hour, and /dev/null bounded', () => {
  const plist = require('./storage-scheduler.cjs').renderPlist();
  for (const required of ['com.pentacle.mobile.storage-janitor', 'storage:janitor', 'dry-run', '<integer>21600</integer>', '<key>RunAtLoad</key><false/>', '<string>/dev/null</string>', '<string>Background</string>']) assert.ok(plist.includes(required));
  for (const forbidden of ['sudo', 'LaunchDaemons', '--apply', '--path', '--root']) assert.equal(plist.includes(forbidden), false);
});

test('operator docs expose the same path-free APIs, caps, retention, and lifecycle commands', () => {
  const docs = ['docs/TESTING.md', 'docs/PENTACLE_MOBILE_BUILD.md'].map((file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')).join('\n');
  // The second group was added 2026-07-22 after an acceptance audit found the guard asserted only the
  // commands, caps, retention windows and sim-queue - while the AC also requires authority, host
  // singleton, state/reference schemas, evidence/cache classification, dry-run/apply, recovery, and the
  // kickstart and kill-switch operations. Those were all PRESENT in the docs and none was protected, so
  // every one could regress silently with the suite green. Content that is true today only stays true if
  // something asserts it.
  for (const required of ['gate:native-root', 'gate:full', 'storage:install', 'storage:update', 'storage:restore', 'storage:uninstall', 'storage:register-worktree', 'storage:retire-worktree', '60 GiB', '40 GiB', '1 MiB', '64 MiB', '2 GiB', '12 GiB', '24-hour', '7 days', '30 days', 'sim-queue',
    'kickstart', 'kill-switch', 'host singleton', 'authority', 'schema', 'classification', 'cache', 'dry-run', 'apply', 'recovery']) assert.ok(docs.includes(required), required);
  for (const forbidden of ['--artifacts', '--memory-root', '--path <worktree>', 'PENTACLE_GATE_NATIVE_ROOT', 'storage-janitor-launchd.cjs']) assert.equal(docs.includes(forbidden), false, forbidden);
});
