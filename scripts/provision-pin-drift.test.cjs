'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const GUARD = path.join(__dirname, 'check-provision-pin.cjs');

function fixture({ gitlink, pin }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-provision-pin-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'pentacle-chat-core-pin.json'), JSON.stringify({
    schema: 1,
    path: 'pentacle-chat-core',
    remote: 'git@example.test:chat-core.git',
    commit: pin,
  }));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'guard@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Provision Pin Guard'], { cwd: root });
  execFileSync('git', ['add', 'config/pentacle-chat-core-pin.json'], { cwd: root });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${gitlink},pentacle-chat-core`], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

function run(root) {
  return require('./check-provision-pin.cjs').assertProvisionPin(root);
}

test('a synced gitlink and pin pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-real-gitlink-'));
  try {
    const core = path.join(root, 'pentacle-chat-core');
    fs.mkdirSync(core);
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: core });
    fs.writeFileSync(path.join(core, 'source.txt'), 'synthetic core\n');
    execFileSync('git', ['add', '.'], { cwd: core });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'core'], { cwd: core });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/pentacle-chat-core-pin.json'), JSON.stringify({ schema: 1, path: 'pentacle-chat-core', commit: sha }));
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'gitlink'], { cwd: root });
    assert.deepEqual(run(root), { path: 'pentacle-chat-core', commit: sha });
    assert.equal(fs.existsSync(path.join(core, '.git')), true, 'positive uses a real initialized nested repository');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function vendoredFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-tree-pin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  fs.mkdirSync(path.join(root, 'pentacle-chat-core'));
  fs.writeFileSync(path.join(root, 'pentacle-chat-core/source.txt'), 'reviewed core\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  const tree = execFileSync('git', ['write-tree', '--prefix=pentacle-chat-core/'], { cwd: root, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/pentacle-chat-core-pin.json'), JSON.stringify({ schema: 2, representation: 'vendored_tree', path: 'pentacle-chat-core', tree }));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'tree'], { cwd: root });
  return { root, tree };
}

test('a pinned tracked vendored tree passes', (t) => {
  const { root, tree } = vendoredFixture(t);
  assert.deepEqual(run(root), { path: 'pentacle-chat-core', representation: 'vendored_tree', tree });
});

test('changed executed files fail even when the HEAD tree still matches', (t) => {
  const { root } = vendoredFixture(t);
  fs.appendFileSync(path.join(root, 'pentacle-chat-core/source.txt'), 'drift\n');
  assert.throws(() => run(root), /TEST_PROVISION_CORE_DIRTY/);
});

test('a committed tree change without pin alignment fails', (t) => {
  const { root } = vendoredFixture(t);
  fs.appendFileSync(path.join(root, 'pentacle-chat-core/source.txt'), 'drift\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'drift'], { cwd: root });
  assert.throws(() => run(root), /TEST_PROVISION_PIN_DRIFT/);
});

test('missing pins and representation mismatches fail without a fallback', (t) => {
  const { root, tree } = vendoredFixture(t);
  const pin = path.join(root, 'config/pentacle-chat-core-pin.json');
  fs.unlinkSync(pin);
  assert.throws(() => run(root), /TEST_PROVISION_PIN_INVALID/);
  fs.writeFileSync(pin, JSON.stringify({ schema: 1, path: 'pentacle-chat-core', commit: tree }));
  assert.throws(() => run(root), /TEST_PROVISION_PIN_DRIFT/);
});

test('a vendored-tree pin rejects a tracked gitlink without guessing', (t) => {
  const root = fixture({ gitlink: 'a'.repeat(40), pin: 'a'.repeat(40) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config/pentacle-chat-core-pin.json'), JSON.stringify({ schema: 2, representation: 'vendored_tree', path: 'pentacle-chat-core', tree: 'a'.repeat(40) }));
  assert.throws(() => run(root), /TEST_PROVISION_PIN_DRIFT/);
});

for (const [name, gitlink, pin] of [
  ['gitlink-only drift', 'b'.repeat(40), 'a'.repeat(40)],
  ['pin-only drift', 'a'.repeat(40), 'b'.repeat(40)],
]) {
  test(`rejects ${name} with the align-pin action`, () => {
    const root = fixture({ gitlink, pin });
    assert.throws(() => run(root), (error) => {
      assert.match(error.message, /^TEST_PROVISION_PIN_DRIFT:/);
      assert.match(error.message, /align-pin chore/);
      return true;
    });
  });
}

test('the command exits non-zero and preserves the actionable drift message', () => {
  const root = fixture({ gitlink: 'c'.repeat(40), pin: 'd'.repeat(40) });
  const result = require('node:child_process').spawnSync(process.execPath, [GUARD, root], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_PROVISION_PIN_DRIFT:.*align-pin chore/);
});
