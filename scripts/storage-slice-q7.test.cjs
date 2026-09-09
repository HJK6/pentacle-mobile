'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { renderProfile } = require('./storage-sandbox.cjs');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'),'pentacle-q7-')));
  const roots = Object.fromEntries(['scratch', 'evidence', 'state'].map((name) => { const target = path.join(root, name); fs.mkdirSync(target); return [name, fs.realpathSync(target)]; }));
  fs.writeFileSync(path.join(roots.state, 'authority.json'), '{}\n');
  return { root, roots };
}

test('candidate profile has two writable roots and one disjoint read-only state root', () => {
  const { root, roots } = fixture();
  try {
    const profile = renderProfile({ writeRoots: [roots.scratch, roots.evidence], readOnlyRoots: [roots.state] });
    for (const writable of [roots.scratch, roots.evidence]) assert.ok(profile.includes(`(allow file-write* (subpath "${writable}"))`));
    assert.equal(profile.includes(`(allow file-write* (subpath "${roots.state}"))`), false);
    assert.ok(profile.includes(`(deny file-write* (subpath "${roots.state}"))`));
    assert.throws(() => renderProfile({ writeRoots: [roots.scratch, roots.state], readOnlyRoots: [roots.state] }), /SANDBOX_ROOT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('macOS candidate process reads state but cannot mutate it', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const { root, roots } = fixture();
  try {
    const profile = renderProfile({ writeRoots: [roots.scratch, roots.evidence], readOnlyRoots: [roots.state] });
    assert.equal(spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', path.join(roots.state, 'authority.json')]).status, 0);
    assert.notEqual(spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', path.join(roots.state, 'forged.json')]).status, 0);
    assert.equal(fs.existsSync(path.join(roots.state, 'forged.json')), false);
    assert.equal(spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', path.join(roots.scratch, 'allowed')]).status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixed candidate profile keeps parent authority outside descendant writes', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'),'pentacle-q7-home-')));
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, 'storage-slice-q7-worker.cjs')], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(JSON.parse(run.stdout), { state_read: 0, state_write: 1, scratch_write: 0, forged: false });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
function authorityFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'),"storage-q7-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = path.join(root, "scratch");
  const evidence = path.join(root, "evidence");
  const state = path.join(root, "state");
  for (const target of [scratch, evidence, state]) fs.mkdirSync(target, { recursive: true });
  return { root, scratch, evidence, state };
}

test("candidate profile rejects nested writable roots", (t) => {
  const { scratch, state } = authorityFixture(t);
  const nested = path.join(scratch, "evidence");
  fs.mkdirSync(nested);
  assert.throws(() => renderProfile({ writeRoots: [scratch, nested], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
});

test("candidate profile rejects lexical root aliases", (t) => {
  const { root, scratch, state } = authorityFixture(t);
  const aliasParent = path.join(root, "alias-parent");
  fs.mkdirSync(aliasParent);
  const alias = `${aliasParent}${path.sep}..${path.sep}${path.basename(scratch)}`;
  assert.throws(() => renderProfile({ writeRoots: [scratch, alias], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
});

test("candidate profile rejects symlink root aliases", (t) => {
  const { root, scratch, state } = authorityFixture(t);
  const alias = path.join(root, "scratch-link");
  fs.symlinkSync(scratch, alias);
  assert.throws(() => renderProfile({ writeRoots: [scratch, alias], readOnlyRoots: [state] }), /SANDBOX_ROOT_IDENTITY/);
});
function danglingAuthorityFixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'),"storage-q7-dangling-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const alias = path.join(root, "alias");
  const disjoint = path.join(root, "disjoint");
  fs.mkdirSync(disjoint);
  fs.symlinkSync(target, alias);
  return { target, alias, disjoint };
}

test("candidate profile rejects dangling alias across writable roots", (t) => {
  const { target, alias, disjoint } = danglingAuthorityFixture(t);
  assert.throws(() => renderProfile({ writeRoots: [target, alias], readOnlyRoots: [disjoint] }), /SANDBOX_ROOT_IDENTITY/);
});

test("candidate profile rejects dangling alias from writable to read-only root", (t) => {
  const { target, alias, disjoint } = danglingAuthorityFixture(t);
  assert.throws(() => renderProfile({ writeRoots: [target, disjoint], readOnlyRoots: [alias] }), /SANDBOX_ROOT_IDENTITY/);
});

test("candidate profile rejects dangling alias from second writable to read-only root", (t) => {
  const { target, alias, disjoint } = danglingAuthorityFixture(t);
  assert.throws(() => renderProfile({ writeRoots: [disjoint, target], readOnlyRoots: [alias] }), /SANDBOX_ROOT_IDENTITY/);
});
