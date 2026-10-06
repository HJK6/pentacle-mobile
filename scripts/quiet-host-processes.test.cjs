'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { heavyWork, heavyWorkCommand } = require('./quiet-host-processes.cjs');

test('quiet observer checks the executable and interpreter dispatch, not brief text or argv0', () => {
  for (const [executable, argv, expected] of [
    ['/tools/codex', ['codex', 'review pytest, run_gate.py and xcodebuild'], false],
    ['/tools/claude', ['claude', 'simctl boot full-gate.cjs'], false],
    ['/bin/sh', ['sh', '-c', 'echo pytest xcodebuild'], false],
    ['/tools/xcodebuild', ['different-argv0', '-workspace', 'app'], true],
    ['/tools/codex', ['xcodebuild', 'review'], false],
    ['/tools/Python', ['python', '-m', 'pytest', '-q'], true],
    ['/tools/python3.13', ['python', '-u', '/tools/run_gate.py'], true],
    ['/tools/python3.13', ['python', '/tools/advisor.py', 'pytest'], false],
    ['/tools/python3.13', ['python', '-c', 'print("pytest")'], false],
    ['/tools/python3.13', ['python', '/tools/pytest'], true],
    ['/tools/node', ['node', '/repo/scripts/full-gate.cjs'], true],
    ['/tools/node', ['node', '/repo/scripts/storage-cli.cjs', 'gate:full'], true],
    ['/tools/node', ['node', '/repo/scripts/storage-cli.cjs', 'status', 'gate:full'], false],
    ['/tools/node', ['node', '/repo/server.js', 'full-gate.cjs'], false],
    ['/tools/simctl', ['simctl', '--set', '/private/owned/Devices', 'boot', 'UDID'], true],
    ['/tools/xcrun', ['xcrun', 'simctl', '--set', '/private/owned/Devices', 'bootstatus', 'UDID'], true],
    ['/tools/simctl', ['simctl', 'list', 'boot'], false],
  ]) assert.equal(heavyWork(executable, argv), expected, JSON.stringify({ executable, argv }));
  assert.throws(() => heavyWork(null, ['pytest']), /QUIET_PROCESS_IDENTITY_INVALID/);
  assert.throws(() => heavyWork('/tools/Python', null), /QUIET_PROCESS_IDENTITY_INVALID/);
});

test('other-uid ps argv remains anchored to the verified interpreter and first script', () => {
  assert.equal(heavyWorkCommand('/tools/Python', 'python -I /Library/Application Support/ci/launcher.py pytest'), false);
  assert.equal(heavyWorkCommand('/tools/Python', 'python /repo with space/run_gate.py'), true);
  assert.equal(heavyWorkCommand('/tools/Python', 'python /repo with space/advisor.py run_gate.py'), false);
  assert.equal(heavyWorkCommand('/tools/codex', 'codex review pytest run_gate.py xcodebuild'), false);
  assert.equal(heavyWorkCommand('/tools/Python', 'python -m pytest'), true);
});
