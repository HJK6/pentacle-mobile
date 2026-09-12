'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const GUARD = path.join(__dirname, 'check-provision-pin.cjs');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture({ pin }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-provision-pin-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'pentacle-chat-core'));
  fs.writeFileSync(path.join(root, 'pentacle-chat-core', 'marker.txt'), 'tracked tree fixture\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'guard@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Provision Pin Guard'], { cwd: root });
  execFileSync('git', ['add', 'pentacle-chat-core'], { cwd: root });
  const indexTree = git(root, ['write-tree']);
  const tree = git(root, ['ls-tree', indexTree, '--', 'pentacle-chat-core']).split(/\s+/)[2];
  fs.writeFileSync(path.join(root, 'config', 'pentacle-chat-core-pin.json'), JSON.stringify({ schema: 2, path: 'pentacle-chat-core', tree: pin || tree }));
  execFileSync('git', ['add', 'config/pentacle-chat-core-pin.json'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return { root, tree };
}

function run(root) {
  return require('./check-provision-pin.cjs').assertProvisionPin(root);
}

test('a synced tracked tree and pin pass', () => {
  const { root, tree } = fixture({});
  assert.deepEqual(run(root), { path: 'pentacle-chat-core', tree });
});

for (const [name, pin] of [
  ['pin drift', 'a'.repeat(40)],
  ['missing-tree pin', 'b'.repeat(40)],
]) {
  test(`rejects ${name} with the tree-pin action`, () => {
    const { root } = fixture({ pin });
    assert.throws(() => run(root), (error) => {
      assert.match(error.message, /^TEST_PROVISION_PIN_DRIFT:/);
      assert.match(error.message, /update the tracked tree pin/);
      return true;
    });
  });
}

test('the command exits non-zero and preserves the actionable drift message', () => {
  const { root } = fixture({ pin: 'd'.repeat(40) });
  const result = require('node:child_process').spawnSync(process.execPath, [GUARD, root], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_PROVISION_PIN_DRIFT:.*update the tracked tree pin/);
});
