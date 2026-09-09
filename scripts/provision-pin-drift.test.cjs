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
  const sha = 'a'.repeat(40);
  assert.deepEqual(run(fixture({ gitlink: sha, pin: sha })), { path: 'pentacle-chat-core', commit: sha });
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
