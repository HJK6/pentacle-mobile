'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

for (const boundary of ['environment', 'plugin', 'host', 'bootstrap', 'provision', 'dispatch', 'forward']) {
  test(`prepared CLI releases both images and lock after ${boundary} refusal`, async () => {
    const resources = new Set(['scratch', 'evidence', 'lock']);
    const events = [];
    const moduleObject = { exports: {} };
    const runId = '00000000-0000-4000-8000-000000000000';
    const token = 'a'.repeat(64);
    let stderr = '';
    const failure = () => { throw new Error(`REFUSAL:${boundary}`); };
    const fakeProcess = {
      argv: ['node', 'storage-cli.cjs', 'gate:full', runId, token], env: {},
      stdout: { write() {} }, stderr: { write(value) { stderr += value; } },
      exit(code) { throw Object.assign(new Error('process exit'), { code }); },
    };
    const mocks = {
      './storage-authority.cjs': { ...require('./storage-authority.cjs'), rejectEnvironmentAuthority: () => { if (boundary === 'environment') failure(); } },
      './storage-capability.cjs': { claim: () => ({}) },
      './owned-process.cjs': { isOwnedInvocation: () => boundary !== 'forward', runOwnedSync: failure },
      './gate-preflight.cjs': { beforeBootstrap: (_root, receive) => {
        events.push('preflight');
        if (['plugin', 'host'].includes(boundary)) failure();
        receive({ ok: true });
      } },
      './storage-cli-bootstrap.cjs': { bootstrapGateEndpoint: () => {
        if (boundary === 'bootstrap') failure();
        return { kind: 'continue', context: {} };
      } },
      './check-provision-pin.cjs': { assertProvisionPin: () => { if (boundary === 'provision') failure(); } },
      './storage-gate.cjs': { bind: () => ({
        withPreparedAllocation: async (id, suppliedToken, operation) => {
          assert.equal(id, runId); assert.equal(suppliedToken, token);
          events.push('ownership');
          try { return await operation(); }
          finally { for (const name of [...resources]) resources.delete(name); events.push('released'); }
        },
        runFullGate: failure,
      }) },
    };
    try {
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'storage-cli.cjs'), 'utf8'), {
        __dirname, __filename: path.join(__dirname, 'storage-cli.cjs'), module: moduleObject, process: fakeProcess,
        require: Object.assign(name => mocks[name] || require(name), { main: moduleObject }),
      });
    } catch (error) { assert.equal(error.code, 1); }
    await new Promise(resolve => setImmediate(resolve));
    assert.match(stderr, new RegExp(`REFUSAL:${boundary}`));
    assert.deepEqual([...resources], [], 'prepared images and lock must be released');
    assert.equal(events[0], 'ownership');
    assert.equal(events.at(-1), 'released');
    assert.equal(fakeProcess.exitCode, 1);
  });
}
