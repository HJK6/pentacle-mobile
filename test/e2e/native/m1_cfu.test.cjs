'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configureCfu } = require('./m1_cfu.cjs');
const udid = '12345678-1234-1234-1234-123456789abc';
const owner = { createdUdid: udid, name: 'M1-recovery-123', deviceSet: '/owned/Devices' };
const census = [{ udid, name: owner.name, state: 'Booted' }];
function execute(fail = {}) {
  const calls = [];
  const run = (args) => { calls.push(args); const action = args[0] === 'spawn' ? args[3] : args[0]; return { status: fail[action] ?? 0, stdout: action === 'read' ? '2026-10-28 04:25:06 +0000\n' : '' }; };
  return { calls, run };
}
test('owned device write, reboot and readback are recorded in order', () => {
  const x = execute();
  const result = configureCfu({ owner, udid, deviceSet: owner.deviceSet, census, run: x.run, now: new Date('2026-10-28T04:25:06Z') });
  assert.equal(result.verified, true); assert.equal(result.requested, result.readback);
  assert.deepEqual(x.calls.map(a => a[0]), ['spawn', 'shutdown', 'boot', 'bootstatus', 'spawn']);
  assert.ok(result.operations.every(o => o.rc === 0));
  assert.ok(x.calls.every(a => a[1] === udid));
});
test('foreign, unbound, mismatched set, and ambiguous identities are refused without commands', () => {
  for (const changes of [{udid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}, {owner:{...owner, createdUdid:null}}, {deviceSet:'/foreign'}, {census:[...census,...census]}, {census:[{...census[0],name:'foreign'}]}]) {
    const x = execute(); const r = configureCfu({ owner, udid, deviceSet: owner.deviceSet, census, run:x.run, ...changes });
    assert.equal(r.verified, false); assert.match(r.error, /ownership/); assert.equal(x.calls.length, 0);
  }
});
test('write and read failures are recorded without throwing; reboot is attempted after shutdown failure', () => {
  for (const failure of [{write:1}, {shutdown:1}, {read:1}]) {
    const x = execute(failure); const r = configureCfu({owner, udid, deviceSet:owner.deviceSet, census, run:x.run});
    assert.equal(r.verified, false); assert.ok(r.error); assert.ok(r.operations.some(o => o.rc === 1));
    if (failure.shutdown) assert.ok(x.calls.some(a => a[0] === 'boot'));
  }
});
test('exceptions and mismatched readback remain non-blocking and unverified', () => {
  const x = execute();
  const different = configureCfu({owner, udid, deviceSet:owner.deviceSet, census, run:x.run, now:new Date('2026-10-28T04:25:07Z')});
  assert.equal(different.verified, false); assert.equal(different.readback, '2026-10-28 04:25:06 +0000');
  const attempted = [];
  const error = configureCfu({owner, udid, deviceSet:owner.deviceSet, census, run(args) {
    attempted.push(args[0]); if (args[0] === 'shutdown') throw Error('timeout'); return {status:0, stdout:''};
  }});
  assert.equal(error.verified, false); assert.ok(attempted.includes('boot')); assert.equal(error.operations[1].rc, null);
});
