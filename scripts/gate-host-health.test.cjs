'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readProcessCensus, POLICY } = require('./gate-host-health.cjs');
const { accountCpu } = require('./gate-cpu-accounting.cjs');

test('complete CPU census is one owned command with exact roots and the existing five-second deadline', () => {
  const calls = [];
  const supplied = { rows: [{ pid: 0, start: null, cpuSeconds: null, cpuProbeErrno: 1 }] };
  const result = readProcessCensus((...args) => { calls.push(args); return JSON.stringify(supplied); }, { ownerPid: 20 }, 40, 30);
  assert.deepEqual(result, supplied);
  assert.deepEqual(calls, [['python3', [path.join(__dirname, 'gate-process-cpu.py'), '--complete-census',
    '--owner-pid', '20', '--probe-pid', '30', '--simulator-pid', '40'], 5000]]);
  assert.equal(POLICY.minIdleRatio, 0.5);
  assert.equal(POLICY.minAbsoluteIdleRatio, 0.05);
});

function fixture() {
  const row = (pid, ppid, start, cpuSeconds, command = 'worker', cpuProbeErrno = 0) => ({ pid, ppid, pgid: 20, start, cpuSeconds, command, cpuProbeErrno });
  const before = [row(0, 0, null, null, 'kernel_task', 1), row(20, 1, 'owner', 1), row(30, 20, 'probe', 1),
    row(40, 1, 'simulator', 1, '/runtime/launchd_sim'), row(50, 20, 'owned-child', 1),
    row(60, 1, 'foreign', 1), row(70, 1, null, null, 'restricted-foreign', 1)];
  const after = before.map(r => ({ ...r, cpuSeconds: r.pid === 50 ? 2 : r.pid === 60 ? 4 : r.cpuSeconds }));
  return { before, after, ownerPid: 20, probePid: 30, simulatorPid: 40, cpuCount: 4, intervalMs: 2000, idleRatio: 0.5 };
}

test('unchanged accounting excludes foreign work and unavailable PID0/foreign counters', () => {
  const result = accountCpu(fixture());
  assert.equal(result.owned_cpu_seconds, 1);
  assert.equal(result.ownedCpuFraction, 0.125);
  assert.equal(result.externalIdleRatio, 0.625);
  for (const pid of [0, 60, 70]) assert(!result.owned_pids.includes(pid));
});

test('unchanged accounting rejects missing/unavailable roots, simulator prefix and unavailable owned counters', () => {
  for (const [edit, expected] of [
    [rows => rows.filter(r => r.pid !== 20), /CPU_ROOT_COUNTER_UNAVAILABLE/],
    [rows => rows.map(r => r.pid === 40 ? { ...r, cpuSeconds: null, cpuProbeErrno: 1 } : r), /CPU_ROOT_COUNTER_UNAVAILABLE/],
    [rows => rows.map(r => r.pid === 40 ? { ...r, command: '/runtime/launchd_sim_extra' } : r), /CPU_SIMULATOR_IDENTITY_INVALID/],
    [rows => rows.map(r => r.pid === 50 ? { ...r, cpuSeconds: null, cpuProbeErrno: 1 } : r), /CPU_COUNTER_UNAVAILABLE/],
  ]) {
    const input = fixture();
    assert.throws(() => accountCpu({ ...input, after: edit(input.after) }), expected);
  }
});

test('unchanged accounting never credits an owned child PID reused by foreign work', () => {
  const input = fixture();
  input.after = input.after.map(r => r.pid === 50 ? { ...r, ppid: 1, start: 'different-birth', cpuSeconds: 100 } : r);
  assert.equal(accountCpu(input).owned_cpu_seconds, 0);
});
