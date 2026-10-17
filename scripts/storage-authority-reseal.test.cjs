'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const CLI = path.join(__dirname, 'storage-cli.cjs');
const PRELOAD = path.join(__dirname, 'storage-authority-reseal-preload.cjs');
const UUID = '00000000-0000-4000-8000-000000000001';
const HARDWARE = '10000000-0000-4000-8000-000000000001';
const BACKING = '20000000-0000-4000-8000-000000000001';
const STATE_VOLUME = '30000000-0000-4000-8000-000000000001';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
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
function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const target = path.join(dir, name), stat = fs.lstatSync(target), relative = path.relative(root, target);
      if (stat.isDirectory()) { result[relative] = 'directory'; walk(target); }
      else if (stat.isSymbolicLink()) result[relative] = `symlink:${fs.readlinkSync(target)}`;
      else result[relative] = `${stat.mode & 0o777}:${sha(fs.readFileSync(target))}`;
    }
  }
  walk(root); return result;
}
function refusedWithoutWrites(f, argv, pattern = /AUTHORITY_RESEAL|AUTHORITY_ROOT|STATE_LAYOUT|JSON|Unexpected|ENOENT/, env) {
  const before = snapshot(f.state), result = f.run(argv, env);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
  assert.deepEqual(snapshot(f.state), before, result.stderr);
  return result;
}

test('actual strict validator RED, supported with-proof CLI GREEN, retained preimage, readback and no-write replay', t => {
  const f = fixture(t), originalRun = fs.readFileSync(f.runFile);
  let result = f.run(['storage:inspect-authority-reseal']);
  assert.equal(result.status, 0, result.stderr);
  let readback = JSON.parse(result.stdout);
  assert.equal(readback.normal_admission, false);
  assert.equal(readback.refusal, 'AUTHORITY_ROOT_DRIFT');
  assert.deepEqual(readback.root_drift.map(r => r.changed_fields), [['device'], ['device'], ['device'], ['device']]);
  result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'committed');
  const journal = JSON.parse(fs.readFileSync(path.join(f.state, 'authority-reseal.json')));
  assert.equal(journal.before, f.preimage.toString('base64'));
  assert.equal(journal.manifest[0].path, path.relative(f.state, f.runFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.authorityFile)), { ...f.authority, roots: f.proof.roots });
  assert.ok(fs.readFileSync(f.runFile).equals(originalRun));
  const before = snapshot(f.state);
  result = f.run(['storage:inspect-authority-reseal']); assert.equal(result.status, 0, result.stderr);
  readback = JSON.parse(result.stdout); assert.equal(readback.normal_admission, true); assert.equal(readback.journal.state, 'committed');
  assert.deepEqual(snapshot(f.state), before);
  refusedWithoutWrites(f, undefined, /AUTHORITY_RESEAL_REPLAY/);
});

for (const field of ['canonical', 'inode', 'uid', 'mode']) test(`changed root ${field} cannot reseal`, t => {
  const f = fixture(t);
  f.proof.roots.worktrees[field] = field === 'uid' || field === 'mode' ? f.proof.roots.worktrees[field] + 1 : `${f.proof.roots.worktrees[field]}x`;
  f.saveProof(); refusedWithoutWrites(f);
});
for (const field of ['hardware_uuid', 'backing_volume_uuid', 'state_volume_uuid']) test(`independently observed ${field} substitution refuses caller proof`, t => {
  const f = fixture(t); f.config[field] = '99999999-0000-4000-8000-000000000001'; f.saveConfig(); refusedWithoutWrites(f);
});
for (const field of ['state_same_device', 'foreign_root_device', 'probe_unavailable']) test(`current ${field} cannot bypass mount/backing admission`, t => {
  const f = fixture(t); f.config[field] = true; f.saveConfig(); refusedWithoutWrites(f, undefined, /AUTHORITY_RESEAL|PROBE_UNAVAILABLE/);
});
test('a substituted installed authority cannot use a valid old proof', t => {
  const f = fixture(t), changed = { ...f.authority, created_at: '2026-09-02T00:00:00.000Z' };
  fs.writeFileSync(f.authorityFile, bytes(changed)); refusedWithoutWrites(f, undefined, /CAS/);
});
test('proof aliases and hardlinks are rejected', t => {
  const f = fixture(t), other = path.join(f.root, 'aliased-proof.json');
  fs.symlinkSync(f.proofFile, other); refusedWithoutWrites(f, ['storage:reseal-authority', other], /FILE/);
  fs.unlinkSync(other); fs.linkSync(f.proofFile, other); refusedWithoutWrites(f, ['storage:reseal-authority', f.proofFile], /FILE/);
});
for (const kind of ['foreign-image', 'ambiguous-image', 'absent-image', 'image-inode', 'stale-generation', 'stale-preimage', 'proof-extra', 'proof-mode', 'root-symlink', 'ancestor-symlink', 'lock']) test(`${kind} fails closed before writes`, t => {
  const f = fixture(t);
  if (kind === 'foreign-image') f.config.images[0]['image-path'] += '-foreign';
  if (kind === 'ambiguous-image') f.config.images.push(f.config.images[0]);
  if (kind === 'absent-image') f.config.images = [];
  if (kind === 'image-inode') f.proof.image_identity.inode += '9';
  if (kind === 'stale-generation') f.proof.generation = crypto.randomUUID();
  if (kind === 'stale-preimage') f.proof.authority_sha256 = '0'.repeat(64);
  if (kind === 'proof-extra') f.proof.arbitrary_root = '/elsewhere';
  if (kind === 'proof-mode') fs.chmodSync(f.proofFile, 0o644);
  if (kind === 'root-symlink') { const p = f.proof.roots.worktrees.canonical; fs.renameSync(p, `${p}-original`); fs.symlinkSync(`${p}-original`, p); }
  if (kind === 'ancestor-symlink') { const p = path.join(f.root, 'repos'); fs.renameSync(p, `${p}-original`); fs.symlinkSync(`${p}-original`, p); }
  if (kind === 'lock') fs.writeFileSync(path.join(f.state, 'scheduler.lock'), 'live');
  f.saveConfig(); if (kind !== 'proof-mode') f.saveProof(); refusedWithoutWrites(f);
});

for (const phase of ['before-prepare-open', 'prepared-orphan', 'before-prepare', 'after-prepare', 'before-authority', 'after-authority', 'before-commit', 'after-commit']) test(`crash ${phase}: normal writers refuse, same-proof reconciles once`, t => {
  const f = fixture(t), crash = f.run(undefined, { RESEAL_TEST_CRASH: phase });
  assert.equal(crash.status, 91, crash.stderr);
  const before = snapshot(f.state);
  for (const argv of [['storage:janitor', 'dry-run'], ['storage:restore']]) refusedWithoutWrites(f, argv);
  for (const direct of ['janitor', 'scheduler']) {
    const result = spawnSync(process.execPath, ['--require', PRELOAD, '-e', ''], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', RESEAL_TEST_FIXTURE: f.root, RESEAL_TEST_DIRECT: direct } });
    assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, /AUTHORITY_RESEAL/);
    assert.deepEqual(snapshot(f.state), before, result.stderr);
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const readback = f.run(['storage:inspect-authority-reseal']); assert.equal(readback.status, 0, readback.stderr);
  assert.equal(JSON.parse(readback.stdout).normal_admission, true);
  refusedWithoutWrites(f, undefined, /REPLAY/);
});

test('pre-preparation generation claim blocks ordinary cleanup of unrelated atomic evidence', t => {
  const f = fixture(t); assert.equal(f.run(undefined, { RESEAL_TEST_CRASH: 'before-prepare-open' }).status, 91);
  fs.writeFileSync(path.join(f.state, `.authority.json.${crypto.randomUUID()}.tmp`), 'ordinary evidence', { mode: 0o600 });
  refusedWithoutWrites(f, ['storage:restore'], /AUTHORITY_RESEAL_PENDING/);
  refusedWithoutWrites(f, ['storage:janitor', 'dry-run'], /AUTHORITY_RESEAL_PENDING/);
  // The explicit recovery also preserves the unrelated unknown temporary for reviewed disposition.
  refusedWithoutWrites(f, undefined, /STATE_LAYOUT_UNKNOWN/);
});

test('committed terminal cleanup refuses restored preimage without deleting evidence', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const journal = JSON.parse(fs.readFileSync(path.join(f.state, 'authority-reseal.json')));
  fs.writeFileSync(f.authorityFile, f.preimage);
  fs.writeFileSync(path.join(f.state, journal.temporaries.commit), bytes(journal), { mode: 0o600 });
  refusedWithoutWrites(f, undefined, /AUTHORITY_RESEAL_CAS/);
  assert.equal(JSON.parse(f.run(['storage:inspect-authority-reseal']).stdout).normal_admission, false);
});

test('reused original PID is conservatively refused by the existing claim without writes', t => {
  const f = fixture(t); assert.equal(f.run(undefined, { RESEAL_TEST_CRASH: 'after-prepare' }).status, 91);
  const file = path.join(f.state, 'authority-reseal.json'), journal = JSON.parse(fs.readFileSync(file));
  journal.writer.pid = process.pid; journal.writer.startToken = 'retired-process-epoch';
  fs.writeFileSync(file, bytes(journal));
  const claim = path.join(f.state, 'scheduler', `.mutation-${sha(`scheduler\0${UUID}`)}.claim`);
  const owner = JSON.parse(fs.readFileSync(claim)); owner.pid = process.pid; fs.writeFileSync(claim, bytes(owner));
  refusedWithoutWrites(f, undefined, /RECORD_MUTATION_BUSY/);
});

test('unavailable current writer epoch refuses fresh and interrupted invocation without writes', t => {
  const fresh = fixture(t); fresh.config.epoch_unavailable = true; fresh.saveConfig();
  refusedWithoutWrites(fresh, undefined, /WRITER_UNCERTAIN/);
  const pending = fixture(t); assert.equal(pending.run(undefined, { RESEAL_TEST_CRASH: 'after-prepare' }).status, 91);
  pending.config.epoch_unavailable = true; pending.saveConfig();
  refusedWithoutWrites(pending, undefined, /RECORD_MUTATION_LEASE_IDENTITY/);
});

test('concurrent real CLI writers serialize through the existing generation claim', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--require', PRELOAD, CLI, 'storage:reseal-authority', f.proofFile], {
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', RESEAL_TEST_FIXTURE: f.root, RESEAL_TEST_PAUSE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(f.root, 'writer-paused'))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, stderr || 'writer never reached pause');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  refusedWithoutWrites(f, undefined, /RECORD_MUTATION_BUSY/);
  fs.writeFileSync(path.join(f.root, 'writer-release'), 'release');
  const result = await completion; assert.equal(result.code, 0, stderr);
  assert.equal(JSON.parse(f.run(['storage:inspect-authority-reseal']).stdout).normal_admission, true);
});

for (const change of ['modify', 'add', 'delete']) test(`original preservation manifest rejects post-crash ${change}`, t => {
  const f = fixture(t); assert.equal(f.run(undefined, { RESEAL_TEST_CRASH: 'after-prepare' }).status, 91);
  if (change === 'modify') fs.appendFileSync(f.runFile, 'changed');
  if (change === 'delete') fs.unlinkSync(f.runFile);
  if (change === 'add') fs.writeFileSync(path.join(f.state, 'reports', `${crypto.randomUUID()}.json`), '{}', { mode: 0o600 });
  refusedWithoutWrites(f, undefined, /PRESERVATION_DRIFT/);
  assert.ok(fs.readFileSync(f.authorityFile).equals(f.preimage));
});

for (const problem of ['malformed-journal', 'unknown-temp', 'partial-prepare', 'wrong-proof']) test(`${problem} preserves all evidence through normal cleanup and explicit refusal`, t => {
  const f = fixture(t);
  if (problem === 'malformed-journal') fs.writeFileSync(path.join(f.state, 'authority-reseal.json'), '{', { mode: 0o600 });
  if (problem === 'unknown-temp') fs.writeFileSync(path.join(f.state, '.authority-reseal-unknown.tmp'), 'unknown', { mode: 0o600 });
  if (problem === 'partial-prepare') fs.writeFileSync(path.join(f.state, `.authority-reseal-${f.migrationId}-prepare.tmp`), '{', { mode: 0o600 });
  if (problem === 'wrong-proof') { assert.equal(f.run(undefined, { RESEAL_TEST_CRASH: 'after-prepare' }).status, 91); f.proof.id = crypto.randomUUID(); f.saveProof(); }
  refusedWithoutWrites(f, ['storage:janitor', 'dry-run']);
  refusedWithoutWrites(f, ['storage:restore']);
  refusedWithoutWrites(f);
});

test('live original writer refuses without acquiring a second migration claim', t => {
  const f = fixture(t); assert.equal(f.run(undefined, { RESEAL_TEST_CRASH: 'after-prepare' }).status, 91);
  const file = path.join(f.state, 'authority-reseal.json'), journal = JSON.parse(fs.readFileSync(file));
  journal.writer = { host: os.hostname(), uid: process.getuid(), pid: process.pid,
    startToken: require('node:child_process').execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim() };
  fs.writeFileSync(file, bytes(journal)); refusedWithoutWrites(f, undefined, /WRITER_ALIVE/);
});
test('normal shape-only transition and cleanup cannot bypass a pending journal', t => {
  const f = fixture(t); assert.equal(f.run(undefined, { RESEAL_TEST_CRASH: 'after-prepare' }).status, 91);
  refusedWithoutWrites(f, ['storage:uninstall']);
  refusedWithoutWrites(f, ['storage:install']);
});

test('unknown historical run fields retain their original strict refusal', () => {
  assert.throws(() => require('./storage-state.cjs').validateRecord('runs', { schema: 1, historical_future_field: true }), /AUTHORITY_RECORD_UNKNOWN_FIELD/);
});

test('legacy updater rejects retained migration history; reviewed reader admits it', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const base = spawnSync('git', ['show', '44376b0fb8015b89d669d9fde53cb9d1b36ba52e:scripts/storage-state.cjs'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(base.status, 0, base.stderr);
  const script = `const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');const filename=path.join(process.argv[1],'storage-state-legacy-compat.cjs');const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(process.argv[1]);m._compile(fs.readFileSync(0,'utf8'),filename);try{m.exports.validateInstalledAuthority();process.exitCode=9;}catch(e){console.log(e.message);}`;
  const old = spawnSync(process.execPath, ['--require', PRELOAD, '-e', script, __dirname], { encoding: 'utf8', input: base.stdout,
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', RESEAL_TEST_FIXTURE: f.root } });
  assert.equal(old.status, 0, old.stderr); assert.match(old.stdout, /STATE_LAYOUT_UNKNOWN:authority-reseal.json/);
  assert.equal(JSON.parse(f.run(['storage:inspect-authority-reseal']).stdout).normal_admission, true);
});
