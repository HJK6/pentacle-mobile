'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const RUNNER = path.join(__dirname, 'run-isolated-mutation.cjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mutation-source-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Mutation Test']);
  git(root, ['config', 'user.email', 'mutation@example.invalid']);
  fs.writeFileSync(path.join(root, 'subject.txt'), 'candidate\n');
  git(root, ['add', 'subject.txt']);
  git(root, ['commit', '-qm', 'candidate']);
  return root;
}

test('mutation command edits only a detached throwaway worktree', () => {
  const root = repository();
  const proof = path.join(os.tmpdir(), `pentacle-mutation-proof-${process.pid}-${Date.now()}.txt`);
  try {
    const child = "const fs=require('node:fs'); fs.writeFileSync('subject.txt','mutated\\n'); fs.writeFileSync(process.argv[1], process.cwd());";
    const result = spawnSync(process.execPath, [RUNNER, '--', process.execPath, '-e', child, proof], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'candidate\n');
    assert.notEqual(fs.readFileSync(proof, 'utf8'), fs.realpathSync(root));
    assert.equal(git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(proof, { force: true });
  }
});

test('a failing mutation is cleaned up without touching the source tree', () => {
  const root = repository();
  try {
    const child = "require('node:fs').writeFileSync('subject.txt','mutated\\n'); process.exit(9);";
    const result = spawnSync(process.execPath, [RUNNER, '--', process.execPath, '-e', child], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 9, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'subject.txt'), 'utf8'), 'candidate\n');
    assert.equal(git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the runner refuses a dirty source tree', () => {
  const root = repository();
  try {
    fs.writeFileSync(path.join(root, 'subject.txt'), 'dirty\n');
    const result = spawnSync(process.execPath, [RUNNER, '--', process.execPath, '-e', 'process.exit(0)'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ISOLATED_MUTATION_SOURCE_DIRTY/);
    assert.equal(git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
