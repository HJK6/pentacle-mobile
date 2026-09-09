'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { createSnapshot, discardSnapshot, requireSnapshot, snapshotRoot } = require('./gate-code-snapshot.cjs');

function git(root, args) {
  return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
}

test('gate code executes from a protected recorded-SHA snapshot, not the live checkout', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-gate-code-source-'));
  const runId = crypto.randomUUID();
  try {
    git(repository, ['init', '--quiet']);
    fs.writeFileSync(path.join(repository, 'gate.cjs'), 'module.exports = "recorded";\n');
    git(repository, ['add', 'gate.cjs']);
    git(repository, ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'gate']);
    const sha = git(repository, ['rev-parse', 'HEAD']);
    const snapshot = createSnapshot(runId, sha, repository);
    assert.equal(snapshot, snapshotRoot(runId));
    assert.equal(requireSnapshot(runId, sha), snapshot);

    fs.writeFileSync(path.join(repository, 'gate.cjs'), 'module.exports = "transient drift";\n');
    assert.equal(fs.readFileSync(path.join(snapshot, 'gate.cjs'), 'utf8'), 'module.exports = "recorded";\n');
    assert.equal(requireSnapshot(runId, sha), snapshot);
  } finally {
    discardSnapshot(runId);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
