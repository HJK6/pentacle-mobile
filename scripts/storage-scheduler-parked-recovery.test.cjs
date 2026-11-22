'use strict';

// Recovery start state of the SpawnConstraint restoration, end to end through the real CLI: authority installed with a
// COMMITTED reseal journal (real `storage:reseal-authority`), the janitor label booted out, the plist on disk equal to
// the latest committed scheduler digest. Native boundaries (mount probes, launchctl, the janitor run) are fixtures;
// the scheduler transaction, authority, journal and validators execute unchanged. launchctl is never invoked for real.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const PRELOAD = path.join(__dirname, 'storage-authority-reseal-preload.cjs');
const BOUNDARY = path.join(__dirname, 'storage-scheduler-fixture-boundary.cjs');
const PUBLIC_ORIGIN = 'https://github.com/HJK6/pentacle-mobile.git';
const LABEL = 'com.pentacle.mobile.storage-janitor';
const UUID = '00000000-0000-4000-8000-000000000001';
const HARDWARE = '10000000-0000-4000-8000-000000000001';
const BACKING = '20000000-0000-4000-8000-000000000001';
const STATE_VOLUME = '30000000-0000-4000-8000-000000000001';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const darwin = process.platform === 'darwin';

function identity(target) {
  const s = fs.statSync(target);
  return { canonical: fs.realpathSync(target), device: String(s.dev), inode: String(s.ino), uid: s.uid, mode: s.mode & 0o777 };
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'authority-reseal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const support = path.join(root, 'Library/PentacleMobileStorage'), state = path.join(support, 'State');
  for (const p of [state, path.join(state, 'scheduler'), path.join(state, 'runs'), path.join(state, 'reports'), path.join(support, 'State.sparsebundle'), path.join(support, 'ScratchImages'), path.join(support, 'EvidenceImages'), path.join(root, 'agent-workspace/worktrees'), path.join(root, 'repos/pentacle-mobile')]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  const roots = { scratch_images: identity(path.join(support, 'ScratchImages')), evidence_images: identity(path.join(support, 'EvidenceImages')), worktrees: identity(path.join(root, 'agent-workspace/worktrees')), repositories: { 'pentacle-mobile': identity(path.join(root, 'repos/pentacle-mobile')) } };
  const oldRoots = JSON.parse(JSON.stringify(roots));
  for (const r of [oldRoots.scratch_images, oldRoots.evidence_images, oldRoots.worktrees, oldRoots.repositories['pentacle-mobile']]) r.device = String(BigInt(r.device) + 4n);
  const authority = { schema: 1, generation: UUID, host: os.hostname(), uid: process.getuid(), state: 'installed', created_at: '2026-09-01T00:00:00.000Z', roots: oldRoots };
  const preimage = bytes(authority), authorityFile = path.join(state, 'authority.json');
  fs.writeFileSync(authorityFile, preimage, { mode: 0o600 });
  const migrationId = crypto.randomUUID();
  const config = { migration_id: migrationId, hardware_uuid: HARDWARE, backing_volume_uuid: BACKING, state_volume_uuid: STATE_VOLUME,
    images: [{ 'image-path': path.join(support, 'State.sparsebundle'), 'image-type': 'sparse bundle disk image', writeable: true, 'system-entities': [{ 'mount-point': state, 'dev-entry': '/dev/disk99s1' }] }] };
  const proof = { schema: 1, id: migrationId, generation: UUID, authority_preimage: preimage.toString('base64'), authority_sha256: sha(preimage), host: { hostname: os.hostname(), uid: process.getuid(), hardware_uuid: HARDWARE }, backing_volume_uuid: BACKING, state_volume_uuid: STATE_VOLUME, image_identity: identity(path.join(support, 'State.sparsebundle')), roots };
  const proofFile = path.join(root, 'proof.json'), configFile = path.join(root, 'fixture.json');
  fs.writeFileSync(proofFile, bytes(proof), { mode: 0o600 });
  fs.writeFileSync(configFile, bytes(config));
  // Opaque unknown-field record must survive byte for byte; migration never parses run schemas.
  const runFile = path.join(state, 'runs', '00000000-0000-4000-8000-000000000002.json');
  fs.writeFileSync(runFile, '{"historical_future_field":true}\n', { mode: 0o600 });
  const f = { root, support, state, authority, authorityFile, preimage, proof, proofFile, config, configFile, runFile, migrationId };
  f.run = (argv = ['storage:reseal-authority', proofFile], extra = {}) => spawnSync(process.execPath, ['--require', PRELOAD, CLI, ...argv], { encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', RESEAL_TEST_FIXTURE: root, ...extra } });
  f.saveProof = () => fs.writeFileSync(proofFile, bytes(proof));
  f.saveConfig = () => fs.writeFileSync(configFile, bytes(config));
  return f;
}

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd, LC_ALL: 'C' } });
}

// The canonical public scheduler root of the fixture home, a copy of this checkout's scripts (as the real clone is).
function publicRoot(root) {
  const repo = path.join(root, 'repos', 'pentacle-mobile-public');
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(__dirname, path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(repo, 'package.json'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(repo, 'node_modules'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', PUBLIC_ORIGIN);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

const PRIOR_PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>/stale/node</string><string>/stale/storage-janitor-scheduled.cjs</string><string>storage:janitor</string><string>dry-run</string></array><key>StartInterval</key><integer>21600</integer></dict></plist>\n`;

// Builds the parked state: real reseal committed through the CLI, then label absent with the old plist committed.
function parked(t) {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'Library', 'LaunchAgents'), { recursive: true });
  const repo = publicRoot(f.root);
  const scripts = path.join(repo, 'scripts');
  const base = { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', RESEAL_TEST_FIXTURE: f.root, SCHEDULER_FIXTURE_ROOT: f.root };
  const cli = (preloads, args, env = {}) => spawnSync(process.execPath, [...preloads.flatMap((p) => ['--require', p]), path.join(scripts, 'storage-cli.cjs'), ...args], { cwd: repo, encoding: 'utf8', timeout: 60000, env: { ...base, ...env } });
  const resealed = cli([PRELOAD], ['storage:reseal-authority', f.proofFile]);
  assert.equal(resealed.status, 0, resealed.stderr);
  assert.equal(JSON.parse(resealed.stdout).state, 'committed');
  // The committed install record and baseline the real install left behind (plain JSON files; no mutation capability needed).
  const plistFile = path.join(f.root, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  fs.writeFileSync(plistFile, PRIOR_PLIST, { mode: 0o600 });
  fs.writeFileSync(path.join(f.state, 'scheduler-baseline.json'), `${JSON.stringify({ schema: 1, existed: false, digest: null, captured_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  const clock = new Date(Date.now() - 60000).toISOString(), installId = crypto.randomUUID();
  fs.writeFileSync(path.join(f.state, 'scheduler', `${installId}.json`), `${JSON.stringify({ schema: 1, id: installId, revision: 0, state: 'committed', action: 'install', generation: UUID, prior_owned: false, prior_content: null, prior_loaded: false, created_at: clock, candidate_digest: sha(PRIOR_PLIST), smoke_report_id: crypto.randomUUID(), smoke_report_digest: 'a'.repeat(64), committed_at: clock })}\n`, { mode: 0o600 });
  const authorityAfterReseal = fs.readFileSync(f.authorityFile);
  const journalBytes = fs.readFileSync(path.join(f.state, 'authority-reseal.json'));
  const update = (scenario = '') => cli([PRELOAD, BOUNDARY], ['storage:update'], { SCHEDULER_FIXTURE_SCENARIO: scenario });
  const actions = () => (fs.existsSync(path.join(f.root, 'launchctl-actions.log')) ? fs.readFileSync(path.join(f.root, 'launchctl-actions.log'), 'utf8').split('\n').filter(Boolean) : []);
  const records = () => fs.readdirSync(path.join(f.state, 'scheduler')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(f.state, 'scheduler', name), 'utf8')));
  return { f, repo, plistFile, authorityAfterReseal, journalBytes, update, actions, records, loaded: () => fs.existsSync(path.join(f.root, 'launchctl-loaded')) };
}

test('parked state (label out, committed reseal journal): storage:update installs the constrained plist, bootstraps, smokes and commits', { skip: !darwin }, (t) => {
  const p = parked(t);
  assert.equal(p.loaded(), false);
  const result = p.update();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const transaction = p.records().find((record) => record.action === 'update');
  assert.equal(transaction.state, 'committed');
  assert.equal(transaction.prior_loaded, false);
  assert.equal(transaction.prior_content, PRIOR_PLIST);
  const plist = fs.readFileSync(p.plistFile, 'utf8');
  assert.match(plist, /<key>SpawnConstraint<\/key>/);
  assert.equal(sha(plist), transaction.candidate_digest);
  assert.notEqual(plist, PRIOR_PLIST);
  assert.deepEqual(p.actions().filter((action) => action !== 'print'), ['bootstrap', 'kickstart'], 'no bootout, no second bootstrap');
  assert.equal(p.loaded(), true);
  assert.equal(JSON.parse(fs.readFileSync(p.f.authorityFile, 'utf8')).state, 'installed');
  assert.ok(fs.readFileSync(p.f.authorityFile).equals(p.authorityAfterReseal), 'resealed authority bytes untouched');
  assert.ok(fs.readFileSync(path.join(p.f.state, 'authority-reseal.json')).equals(p.journalBytes), 'committed journal retained byte for byte');
  assert.equal(fs.readdirSync(p.f.state).filter((name) => name.endsWith('.lock')).length, 0);
});

test('parked state: a constraint launchd cannot show rolls back, restores the old plist byte for byte and leaves the label out', { skip: !darwin }, (t) => {
  const p = parked(t);
  const result = p.update('bare-print');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCHEDULER_SPAWN_CONSTRAINT_UNVERIFIED/);
  const transaction = p.records().find((record) => record.action === 'update');
  assert.equal(transaction.state, 'restored');
  assert.equal(fs.readFileSync(p.plistFile, 'utf8'), PRIOR_PLIST);
  assert.equal(p.loaded(), false, 'the label stays out');
  assert.deepEqual(p.actions().filter((action) => action !== 'print'), ['bootstrap', 'bootout']);
  assert.equal(JSON.parse(fs.readFileSync(p.f.authorityFile, 'utf8')).state, 'installed');
  assert.ok(fs.readFileSync(p.f.authorityFile).equals(p.authorityAfterReseal));
  assert.ok(fs.readFileSync(path.join(p.f.state, 'authority-reseal.json')).equals(p.journalBytes));
  assert.equal(p.actions().includes('kickstart'), false, 'nothing ran without a verified constraint');
});

test('parked state: the update is refused and writes nothing when the committed journal no longer matches the authority', { skip: !darwin }, (t) => {
  const p = parked(t);
  const authority = JSON.parse(fs.readFileSync(p.f.authorityFile, 'utf8'));
  authority.roots.worktrees.device = String(BigInt(authority.roots.worktrees.device) + 1n);
  fs.writeFileSync(p.f.authorityFile, bytes(authority), { mode: 0o600 });
  const result = p.update();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(p.plistFile, 'utf8'), PRIOR_PLIST);
  assert.deepEqual(p.actions().filter((action) => action !== 'print'), []);
  assert.equal(p.records().filter((record) => record.action === 'update').length, 0);
});

// Both entry points render (and prove the executable's code identity) before any lock, record, authority change or provisioning.
for (const verb of ['storage:install', 'storage:update']) {
  test(`${verb} with an executable whose code identity cannot be proven refuses with no State, lock, transaction or launchctl artifact`, { skip: !darwin }, (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.root, 'Library', 'LaunchAgents'), { recursive: true });
    const repo = publicRoot(f.root);
    const tree = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [path.relative(dir, path.join(e.parentPath, e.name)), sha(fs.readFileSync(path.join(e.parentPath, e.name)))]));
    const before = tree(f.state);
    const result = spawnSync(process.execPath, ['--require', PRELOAD, '--require', BOUNDARY, path.join(repo, 'scripts', 'storage-cli.cjs'), verb], { cwd: repo, encoding: 'utf8', timeout: 60000,
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', RESEAL_TEST_FIXTURE: f.root, SCHEDULER_FIXTURE_ROOT: f.root, SCHEDULER_FIXTURE_SCENARIO: 'codesign-fail' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SCHEDULER_SPAWN_CONSTRAINT_UNAVAILABLE:CODESIGN_DISPLAY/);
    assert.deepEqual(tree(f.state), before, 'State is byte for byte unchanged');
    const log = path.join(f.root, 'launchctl-actions.log');
    assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).every((action) => action === 'print'), 'only the read-only existence print, never a mutation');
    assert.equal(fs.existsSync(path.join(f.root, 'Library', 'LaunchAgents', `${LABEL}.plist`)), false);
  });
}
