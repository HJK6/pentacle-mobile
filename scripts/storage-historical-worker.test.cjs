'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { collectParents } = require('./storage-historical-worker.cjs');

test('worker entrypoint reports a malformed first parent after executing the full immutable corpus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-entry-test-'));
  const fakeModule = { exports: {} };
  let parents = 0;
  let stdout = '';
  let stderr = '';
  const workerProcess = { argv: ['node', 'worker'], execPath: process.execPath, env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'storage-historical-worker.cjs'), 'utf8'), {
      __dirname: path.join(root, 'scripts'), module: fakeModule, process: workerProcess,
      require: Object.assign(name => name === 'node:child_process' ? { spawnSync: (_command, args) => {
        if (args[0] !== '--test') return { status: 0, stdout: Buffer.alloc(0) };
        parents += 1;
        return { status: parents === 1 ? 1 : 0, stdout: parents === 1 ? 'unparsed parent crash\n' : '# pass 1\n', stderr: parents === 1 ? 'parent raw cause\n' : '' };
      } } : require(name), { main: fakeModule }),
    });
    assert.equal(parents, 28);
    assert.equal(workerProcess.exitCode, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.executed, 28);
    assert.equal(result.results.filter(row => !row.executable).length, 1);
    assert.equal(JSON.parse(stderr).failures.length, 1);
    assert.equal(fs.readFileSync(path.join(result.receipts_root, `${result.ids[0]}.stderr.log`), 'utf8'), 'parent raw cause\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('historical collection preserves failed raw output and executes later parents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-receipt-test-'));
  try {
    const called = [];
    const result = collectParents([['first'], ['second'], ['third']], root, ([id]) => {
      called.push(id);
      if (id === 'second') throw Object.assign(new Error('archive unavailable'), { dependency: 'parent-archive' });
      return { status: id === 'first' ? 1 : 0, stdout: id === 'first' ? 'raw invalid output\n' : 'ℹ pass 1\n', stderr: id === 'first' ? 'real diagnostic\n' : '' };
    });
    assert.deepEqual(called, ['first', 'second', 'third']);
    assert.deepEqual(result.map(row => row.valid), [false, false, true]);
    assert.equal(fs.readFileSync(path.join(root, 'first.stdout.log'), 'utf8'), 'raw invalid output\n');
    assert.equal(fs.readFileSync(path.join(root, 'first.stderr.log'), 'utf8'), 'real diagnostic\n');
    const failed = JSON.parse(fs.readFileSync(path.join(root, 'first.json')));
    assert.equal(failed.status, 1);
    assert.equal(failed.matched, false);
    assert.equal(result[1].dependency, 'parent-archive');
    assert.equal(result[1].executed, false);
    assert.equal(result[2].executed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('historical defect exit remains valid while timeout and missing execution fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-status-test-'));
  try {
    const result = collectParents([['defect'], ['timeout'], ['missing']], root, ([id]) => id === 'defect'
      ? { status: 1, stdout: '# fail 1\n', stderr: '' }
      : id === 'timeout' ? { status: null, signal: 'SIGTERM', stdout: '# pass 1\n', stderr: '', error: new Error('ETIMEDOUT') }
        : { status: 0, stdout: '# pass 0\n', stderr: '' });
    assert.deepEqual(result.map(row => row.valid), [true, false, false]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'timeout.json'))).signal, 'SIGTERM');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
