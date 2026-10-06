'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readProcessCensus, POLICY } = require('./gate-host-health.cjs');
const { accountCpu } = require('./gate-cpu-accounting.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

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

// Execute the actual consumer with synthetic OS/HTTP boundaries. No host SDK,
// credentials, processes or simulators are used by these fixtures.
const owned = { ownerPid: 20, deviceSetRoot: '/fixture/devices', udid: '00000000-0000-4000-8000-000000000001' };
function hostFixture(options = {}) {
  const filename = path.join(__dirname, 'gate-host-health.cjs');
  const nativeRequire = createRequire(filename);
  const input = fixture();
  const events = []; const calls = []; let nativeCalls = 0; let cpuReads = 0;
  const late = options.late === undefined ? structuredClone(input.after) : options.late;
  const ticks = index => ({ count: 4, total: 1000 + index * 1000, idle: 500 + index * 500 });
  const supplied = rows => ({ rows, exitedPids: [], cpuTicks: ticks(3), monotonicMs: 4000 });
  const success = (stdout, timeout) => ({ status: 0, stdout, ownership: { bound_ms: timeout, disposition: 'completed', group_alive_after: false } });
  const timeout = bound => ({ status: 125, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    ownership: { bound_ms: bound, disposition: 'terminated', group_alive_after: false } });
  const runOwnedSync = (binary, args, commandOptions) => {
    calls.push({ binary, args, options: commandOptions });
    if (binary === 'python3') {
      nativeCalls += 1; events.push(`native-${nativeCalls}`);
      if (nativeCalls === 3 && options.lateError) return timeout(commandOptions.timeout);
      if (nativeCalls === 3 && options.lateOutput !== undefined) return success(options.lateOutput, commandOptions.timeout);
      const result = nativeCalls === 1 ? { rows: input.before, exitedPids: [], cpuTicks: ticks(1), monotonicMs: 1000 }
        : nativeCalls === 2 ? { rows: input.after, exitedPids: [], cpuTicks: ticks(2), monotonicMs: 3000 }
          : supplied(late);
      if (nativeCalls === 3 && options.editResult) options.editResult(result);
      return success(JSON.stringify(result), commandOptions.timeout);
    }
    if (binary === '/usr/sbin/iostat') { events.push('iostat'); return success('disk0\n KB/t tps MB/s\n 1 0 0\n 1 2 0\n', commandOptions.timeout); }
    if (binary === '/usr/sbin/sysctl') { events.push('memory'); options.between?.(late); return success('1\n', commandOptions.timeout); }
    if (binary === '/usr/bin/xcrun' && args.includes('managerpid')) {
      events.push('manager'); return success(`${options.managerPid ?? 40}\n`, commandOptions.timeout);
    }
    if (binary === '/usr/bin/xcrun') { events.push('simulator'); return success(JSON.stringify({ devices: { runtime: [] } }), commandOptions.timeout); }
    if (binary === 'ps') {
      events.push('ps');
      if (options.psError) return timeout(commandOptions.timeout);
      return success(options.psText ?? late.map(row => `${row.pid} ${row.argv0 ?? row.command}`).join('\n'), commandOptions.timeout);
    }
    throw new Error(`unexpected fixture command: ${binary}`);
  };
  const fakeFs = {
    readFileSync: (file, encoding) => String(file).endsWith('gate-process-cpu.py') ? fs.readFileSync(file, encoding)
      : '<configuration><apikey>synthetic</apikey><folder id="fixture"/></configuration>',
    statfsSync: () => ({ bavail: 128 * 1024 ** 3, bsize: 1 }),
  };
  const fakeHttp = { get: (_options, callback) => {
    events.push('http'); const request = new EventEmitter(); request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; callback(response);
      response.emit('data', JSON.stringify({ state: 'idle', needBytes: 0, needFiles: 0, needDeletes: 0 })); response.emit('end');
    });
    return request;
  } };
  const fakeOs = { userInfo: () => ({ homedir: '/fixture/home' }), loadavg: () => [1, 1, 1],
    cpus: () => { cpuReads += 1; return Array.from({ length: 4 }, () => ({ times: { idle: cpuReads * 250, user: cpuReads * 250 } })); } };
  function load(name) {
    if (name === './owned-process.cjs') return { runOwnedSync, probeSignalCapability: async () => {
      events.push('signals'); return { ok: true, visibility_errno: 0, signal_errno: 0, cleanup_verified: true };
    } };
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:os') return fakeOs;
    if (name === 'node:http') return fakeHttp;
    return nativeRequire(name);
  }
  load.resolve = nativeRequire.resolve; load.main = require.main;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: load, module, exports: module.exports,
    __filename: filename, __dirname, process: { pid: options.probePid ?? 30 }, performance, console }, { filename });
  return { consumer: module.exports, input, late, events, calls };
}
const plain = value => JSON.parse(JSON.stringify(value));
const build = (pid = 80, command = 'xcodebuild', extras = {}) => ({ pid, ppid: 1, pgid: pid,
  start: `birth-${pid}`, cpuSeconds: 1, cpuProbeErrno: 0, command, ...extras });

test('owned build census takes a fresh late native census without dispatching ps', async () => {
  const f = hostFixture({ psError: true }); const sample = await f.consumer.collectSnapshot(owned);
  assert.equal(f.consumer.evaluateSnapshot(sample).ok, true);
  assert.deepEqual(plain(sample.competingBuildPids), []);
  assert.deepEqual(f.events, ['manager', 'native-1', 'iostat', 'native-2', 'memory', 'simulator', 'native-3', 'http', 'signals']);
  const native = f.calls.filter(c => c.binary === 'python3'); assert.equal(native.length, 3);
  for (const call of native) {
    assert.deepEqual(plain(call.args), [path.join(__dirname, 'gate-process-cpu.py'), '--complete-census', '--owner-pid', '20', '--probe-pid', '30', '--simulator-pid', '40']);
    assert.equal(call.options.timeout, 5000);
  }
  assert.deepEqual(plain(sample.rawCpu.before.rows), f.input.before);
  assert.deepEqual(plain(sample.rawCpu.after.rows), f.input.after);
  assert.deepEqual(plain(sample.cpuAccounting), { ...accountCpu(f.input), simulator_udid: owned.udid, device_set_root: owned.deviceSetRoot });
  assert.deepEqual(plain(sample.rawBuildCensus.result.rows), f.late);
  assert.equal(sample.rawBuildCensus.producer_sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'gate-process-cpu.py'))).digest('hex'));
  assert.equal(sample.commands[sample.rawBuildCensus.command_index].binary, 'python3');
  assert.equal(sample.commands[sample.rawBuildCensus.command_index].status, 0);
  assert.equal(sample.commands[sample.rawBuildCensus.command_index].ownership.bound_ms, 5000);
  assert.equal(sample.commands[sample.rawBuildCensus.command_index].ownership.disposition, 'completed');
});

test('foreign build starting after CPU after census is still refused', async () => {
  const f = hostFixture({ between: rows => rows.push(build()) });
  const sample = await f.consumer.collectSnapshot(owned);
  assert(!sample.rawCpu.after.rows.some(row => row.pid === 80));
  assert.deepEqual(plain(sample.competingBuildPids), [80]);
  assert(sample.rawBuildCensus.result.rows.some(row => row.pid === 80));
  assert(f.events.indexOf('native-3') > f.events.indexOf('memory'));
  assert.equal(f.consumer.evaluateSnapshot(sample).ok, false);
  const legacy = hostFixture({ between: rows => rows.push(build()) });
  assert.deepEqual(plain((await legacy.consumer.collectSnapshot(null)).competingBuildPids), [80]);
});

test('owned build census refuses foreign, owned and CPU-permission-denied xcodebuild rows', async () => {
  const late = fixture().after.concat([build(80), build(81, 'xcodebuild', { ppid: 20 }),
    build(82, 'xcodebuild', { start: null, cpuSeconds: null, cpuProbeErrno: 1 })]);
  const f = hostFixture({ late }); const sample = await f.consumer.collectSnapshot(owned);
  assert.deepEqual(plain(sample.competingBuildPids), [80, 81, 82]);
  assert.equal(f.consumer.evaluateSnapshot(sample).ok, false);
});

test('owned build census uses the explicitly approved kernel identity in both label directions', async () => {
  for (const [row, expected] of [[build(80, 'xcodebuild', { argv0: '/different/label' }), [80]],
    [build(80, 'worker', { argv0: '/usr/bin/xcodebuild' }), []]]) {
    const f = hostFixture({ late: fixture().after.concat(row) });
    assert.deepEqual(plain((await f.consumer.collectSnapshot(owned)).competingBuildPids), expected);
    assert(!f.events.includes('ps'));
  }
  for (const name of ['xcodebuild_helper', 'Xcodebuild', 'pre-xcodebuild', '/usr/bin/xcodebuild']) {
    const f = hostFixture({ late: fixture().after.concat(build(80, name)) });
    assert.deepEqual(plain((await f.consumer.collectSnapshot(owned)).competingBuildPids), []);
  }
});

test('owned build census rejects malformed and incomplete late inventory without stale reuse or ps', async t => {
  const edits = [
    ['missing rows', result => delete result.rows], ['empty rows', result => { result.rows = []; }],
    ['duplicate PID', result => result.rows.push({ ...result.rows[1] })],
    ...[0, 20, 30, 40].map(pid => [`missing required PID ${pid}`, result => { result.rows = result.rows.filter(row => row.pid !== pid); }]),
    ...[-1, 1.5, '80', 0x80000000].map(pid => [`invalid PID ${pid}`, result => result.rows.push(build(pid))]),
    ...['', null, 42].map(command => [`invalid name ${command}`, result => result.rows.push(build(80, command))]),
    ['missing exited inventory', result => delete result.exitedPids],
    ['invalid exited inventory', result => { result.exitedPids = null; }],
    ['unproved exit', result => { result.exitedPids = [{ pid: 90, errno: 1 }]; }],
    ['duplicate exit', result => { result.exitedPids = [{ pid: 90, errno: 3 }, { pid: 90, errno: 3 }]; }],
    ['unknown counter errno', result => { result.rows[6].cpuProbeErrno = 99; }],
    ['missing CPU ticks', result => delete result.cpuTicks],
    ['invalid CPU ticks', result => { result.cpuTicks.idle = result.cpuTicks.total + 1; }],
    ['invalid clock', result => { result.monotonicMs = 1; }],
    ['root birth changed', result => { result.rows.find(row => row.pid === 20).start = 'reused'; }],
    ['root counter unavailable', result => { result.rows.find(row => row.pid === 30).cpuSeconds = null; }],
    ['simulator identity wrong', result => { result.rows.find(row => row.pid === 40).command = '/runtime/launchd_sim_extra'; }],
    ['owner no longer ancestor', result => { result.rows.find(row => row.pid === 30).ppid = 1; }],
  ];
  for (const [name, editResult] of edits) await t.test(name, async () => {
    const f = hostFixture({ editResult, psText: '1 launchd' }); const sample = await f.consumer.collectSnapshot(owned);
    assert.equal(f.consumer.evaluateSnapshot(sample).ok, false);
    assert.equal(sample.competingBuildPids, null); assert(!f.events.includes('ps'));
  });
  for (const options of [{ lateError: true }, { lateOutput: '{' }]) {
    const f = hostFixture(options); const sample = await f.consumer.collectSnapshot(owned);
    assert.equal(f.consumer.evaluateSnapshot(sample).ok, false); assert.equal(sample.competingBuildPids, null);
    assert(!f.events.includes('ps')); assert.equal(f.calls.filter(c => c.binary === 'python3').length, 3);
  }
});

test('invalid owned context or supplied roots refuse instead of taking an unowned ps path', async () => {
  for (const context of [false, 0, '', [], {}, { ...owned, ownerPid: 1 }, { ...owned, ownerPid: '20' },
    { ...owned, ownerPid: 0x80000000 }, { ...owned, deviceSetRoot: 'relative' },
    { ...owned, deviceSetRoot: '/bad\0root' }, { ...owned, udid: 'unknown' }]) {
    const f = hostFixture(); await assert.rejects(f.consumer.collectSnapshot(context), /OWNERSHIP|owned context/);
    assert.equal(f.calls.length, 0);
  }
  for (const options of [{ probePid: 1 }, { managerPid: 1 }, { managerPid: 'invalid' }, { managerPid: 0x80000000 }]) {
    const f = hostFixture(options); await assert.rejects(f.consumer.collectSnapshot(owned), /OWNERSHIP|simulator/);
    assert(!f.calls.some(c => c.binary === 'ps' || c.binary === 'python3'));
  }
});

test('unowned build census retains legacy arguments, basename matching and failure refusal', async () => {
  const f = hostFixture({ psText: '1 launchd\n80 /usr/bin/xcodebuild' });
  const sample = await f.consumer.collectSnapshot(null);
  assert.deepEqual(plain(sample.competingBuildPids), [80]); assert.equal(f.consumer.evaluateSnapshot(sample).ok, false);
  assert.deepEqual(plain(f.calls.find(c => c.binary === 'ps').args), ['-axo', 'pid=,comm=']);
  assert.equal(f.calls.find(c => c.binary === 'ps').options.timeout, 5000);
  assert(!f.calls.some(c => c.binary === 'python3'));
  const healthy = hostFixture({ psText: '1 launchd' });
  assert.equal(healthy.consumer.evaluateSnapshot(await healthy.consumer.collectSnapshot(null)).ok, true);
  for (const options of [{ psText: 'malformed' }, { psError: true }]) {
    const bad = hostFixture(options); const result = await bad.consumer.collectSnapshot(null);
    assert.equal(result.competingBuildPids, null); assert.equal(bad.consumer.evaluateSnapshot(result).ok, false);
  }
});

test('existing settling thresholds, recovery and immediate census/build refusals remain', async () => {
  const f = hostFixture(); const sample = await f.consumer.collectSnapshot(owned);
  assert.equal(f.consumer.POLICY.maxDiskTransfersPerSecond, 10000);
  assert.equal(f.consumer.POLICY.minAbsoluteIdleRatio, 0.05); assert.equal(f.consumer.POLICY.ownedBootSettleMs, 120000);
  const replay = measurements => {
    let clock = 0, index = 0;
    return f.consumer.settleAdmission(() => f.consumer.evaluateSnapshot({ ...sample, ...measurements[Math.min(index++, measurements.length - 1)] }),
      { bootStartedMs: 0, now: () => clock, sleep: ms => { clock += ms; } });
  };
  const recovery = replay([{ diskTransfersPerSecond: 10467 }, {}, {}]);
  assert.equal(recovery.settling.status, 'ready'); assert.equal(recovery.settling.recovery_samples, 2);
  assert.equal(recovery.settling.sample_interval_ms, 10000); assert.equal(recovery.settling.required_sustained_samples, 3);
  assert.equal(replay([{ diskTransfersPerSecond: 10467 }]).settling.status, 'sustained');
  for (const bad of [{ competingBuildPids: [80] }, { competingBuildPids: null, probeErrors: ['build census: ETIMEDOUT'] }])
    assert.equal(replay([bad]).settling.status, 'refused');
});
