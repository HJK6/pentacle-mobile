'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runOwnedSync } = require('./owned-process.cjs');

async function waitForAppReady(options, dependencies) {
  const now = dependencies.now || (() => performance.now());
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const samples = [];
  for (;;) {
    const elapsed = now() - started;
    const transport = dependencies.transport();
    if ((transport.status != null && transport.status !== 0) || transport.signal)
      throw Object.assign(new Error('APP_LAUNCH_FAILED'), { readiness: { elapsed_ms: elapsed, transport, samples } });
    if (elapsed > options.deadlineMs) throw Object.assign(new Error('APP_READY_TIMEOUT'), { readiness: { elapsed_ms: elapsed, transport, samples } });
    let observation = null; let error = null;
    try { observation = await dependencies.read(Math.max(1, options.deadlineMs - elapsed)); } catch (failure) { error = failure.message; }
    const receipt = observation?.receipt;
    const valid = receipt?.nonce === options.nonce && receipt.bundle_id === options.bundleId
      && Number.isSafeInteger(receipt.pid) && receipt.pid > 1 && observation.livePid === receipt.pid
      && typeof observation.processBirth === 'string' && /^[1-9][0-9]*$/.test(observation.processBirth)
      && Number.isFinite(receipt.created_at) && receipt.created_at >= options.startedAt
      && receipt.created_at <= options.startedAt + Math.min(options.deadlineMs, now() - started + 1000);
    samples.push({ elapsed_ms: now() - started, pid: receipt?.pid || null, live_pid: observation?.livePid || null,
      bound: valid, ...(error ? { error } : {}) });
    if (valid && now() - started <= options.deadlineMs) return { ready: true, pid: receipt.pid, nonce: options.nonce,
      process_birth: observation.processBirth,
      elapsed_ms: now() - started, native_receipt: receipt, transport, samples };
    if (now() - started >= options.deadlineMs) throw Object.assign(new Error('APP_READY_TIMEOUT'), { readiness: { elapsed_ms: now() - started, transport, samples } });
    await sleep(Math.min(options.pollMs, options.deadlineMs - (now() - started)));
  }
}

function simctl(target, args, timeout = 10000) {
  const result = runOwnedSync('/usr/bin/xcrun', ['simctl', '--set', target.deviceSetRoot, ...args], { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(`simctl ${args[0]} failed: ${result.status}`);
  return result.stdout.trim();
}

function currentPid(target, timeout) {
  const escaped = target.bundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = new RegExp(`(?:^|:)${escaped}(?:\\[|$)`);
  const rows = simctl(target, ['spawn', target.udid, 'launchctl', 'list'], timeout).split('\n');
  const pids = rows.flatMap((row) => {
    const match = row.trim().match(/^(\d+)\s+\S+\s+(.*)$/);
    return match && label.test(match[2]) ? [Number(match[1])] : [];
  });
  return pids.length === 1 ? pids[0] : null;
}

function processBirth(pid, command = runOwnedSync) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('APP_SMOKE_PID_INVALID');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pentacle-smoke-birth-'));
  try {
    const file = path.join(root, 'pid.json');
    fs.writeFileSync(file, JSON.stringify([{ pid }]));
    // Reuse the public collector's legacy input contract and exact kernel birth value.
    const result = command('python3', [require.resolve('./gate-process-cpu.py'), file],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw result.error || new Error('APP_SMOKE_BIRTH_READ_FAILED');
    const rows = JSON.parse(result.stdout).rows;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].pid !== pid) throw new Error('APP_SMOKE_BIRTH_ROW_INVALID');
    const row = rows[0];
    if (row.cpuProbeErrno === 3 && row.start == null) return null; // Actual ESRCH only.
    if (row.cpuProbeErrno !== 0 || typeof row.start !== 'string' || !/^[1-9][0-9]*$/.test(row.start))
      throw new Error('APP_SMOKE_BIRTH_UNAVAILABLE');
    return row.start;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function launchAndWait(input) {
  const { target, receiptFile, nonce } = input;
  const data = simctl(target, ['get_app_container', target.udid, target.bundleId, 'data']);
  const ownedDevice = fs.realpathSync(path.join(target.deviceSetRoot, target.udid));
  if (!fs.realpathSync(data).startsWith(`${ownedDevice}${path.sep}`)) throw new Error('APP_DATA_NOT_OWNED');
  const marker = path.join(data, 'Documents', '.pentacle-gate-ready.json');
  fs.rmSync(marker, { force: true });
  const startedAt = Date.now();
  const transport = { status: null, signal: null, stdout: '', stderr: '' };
  let child; let outcome;
  try {
    fs.writeFileSync(receiptFile, JSON.stringify({ nonce, target, started_at: startedAt, phase: 'launch-intent' }));
    child = spawn('/usr/bin/xcrun', ['simctl', '--set', target.deviceSetRoot, 'launch', '--terminate-running-process', target.udid, target.bundleId],
      { env: { ...process.env, SIMCTL_CHILD_PENTACLE_GATE_READY_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { transport.stdout = (transport.stdout + chunk).slice(-4096); });
    child.stderr.on('data', (chunk) => { transport.stderr = (transport.stderr + chunk).slice(-4096); });
    child.on('error', (error) => { transport.status = 127; transport.stderr = error.message; });
    child.on('exit', (status, signal) => { transport.status = status; transport.signal = signal; });
    outcome = await waitForAppReady({ nonce, bundleId: target.bundleId, startedAt, deadlineMs: 120000, pollMs: 250 }, {
      transport: () => ({ ...transport }), read: async (remaining) => {
        if (!fs.existsSync(marker)) return null;
        const stat = fs.statSync(marker);
        if (stat.size > 4096) throw new Error('APP_READY_RECEIPT_OVERSIZED');
        const receipt = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (receipt.nonce !== nonce) return { receipt, livePid: null };
        const livePid = currentPid(target, Math.min(2000, remaining));
        return { receipt, livePid, processBirth: livePid === receipt.pid ? processBirth(livePid) : null };
      },
    });
    return outcome;
  } catch (error) { outcome = { ready: false, error: error.message, ...(error.readiness || {}) }; throw error; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      transport.terminated_after_readiness = outcome?.ready === true;
    }
    const lateFailure = outcome?.ready && transport.status != null && transport.status !== 0;
    if (lateFailure) outcome = { ...outcome, ready: false, error: 'APP_LAUNCH_FAILED' };
    fs.writeFileSync(receiptFile, JSON.stringify({ ...outcome, nonce, target, started_at: startedAt, transport }));
    if (lateFailure) throw new Error('APP_LAUNCH_FAILED');
  }
}

function verifyReady(input, readPid = currentPid, readBirth = processBirth) {
  const { collectChecks, requireChecks } = require('./gate-checks.cjs');
  let receipt; let pid;
  const checks = collectChecks([
    { name: 'readiness-receipt', run: () => { receipt = JSON.parse(fs.readFileSync(input.receiptFile, 'utf8')); } },
    { name: 'receipt-binding', dependsOn: ['readiness-receipt'], run: () => {
      if (!receipt.ready || receipt.nonce !== input.nonce || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 1
        || receipt.native_receipt?.nonce !== input.nonce || receipt.native_receipt?.pid !== receipt.pid
        || receipt.native_receipt?.bundle_id !== input.target.bundleId
        || ['deviceSetRoot', 'udid', 'bundleId'].some((key) => receipt.target?.[key] !== input.target[key])
        || (input.target.live_pid != null && receipt.pid !== input.target.live_pid)) throw new Error('APP_READY_RECEIPT_INVALID');
    } },
    { name: 'live-pid-readback', run: () => { pid = readPid(input.target, 5000); } },
    { name: 'pid-binding', dependsOn: ['readiness-receipt', 'live-pid-readback'], run: () => { if (pid !== receipt.pid) throw new Error('APP_READY_PID_MISMATCH'); } },
    { name: 'process-birth-binding', dependsOn: ['receipt-binding', 'pid-binding'], run: () => {
      if (typeof receipt.process_birth !== 'string' || !/^[1-9][0-9]*$/.test(receipt.process_birth)
        || readBirth(pid) !== receipt.process_birth) throw new Error('APP_READY_PROCESS_BIRTH_MISMATCH');
    } },
  ]);
  try { requireChecks(checks); } catch (error) { throw new Error(`APP_READY_LIVENESS_FAILED:${error.message}`); }
  return checks;
}

function stopOwnedSmoke(input, dependencies = {}) {
  const readPid = dependencies.readPid || currentPid;
  const readBirth = dependencies.readBirth || processBirth;
  const signal = dependencies.signal || ((target, pid) => simctl(target, ['spawn', target.udid, 'kill', '-TERM', String(pid)]));
  const now = dependencies.now || (() => performance.now());
  const sleep = dependencies.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const started = now();
  let receipt;
  const teardown = { status: 'pending', pid: input.target.live_pid, nonce: input.nonce, signal_sent: false,
    started_at: new Date().toISOString() };
  try {
    receipt = JSON.parse(fs.readFileSync(input.receiptFile, 'utf8'));
    teardown.pid = receipt.pid;
    teardown.process_birth = receipt.process_birth;
    teardown.checks = verifyReady(input, readPid, readBirth);
    // Check the exact bundle PID again after the birth read, before the only signal.
    if (readPid(input.target, 5000) !== receipt.pid) throw new Error('APP_SMOKE_PID_CHANGED');
    if (readBirth(receipt.pid) !== receipt.process_birth) throw new Error('APP_SMOKE_PID_REUSED');
    signal(input.target, receipt.pid);
    teardown.signal_sent = true;
    for (;;) {
      const pid = readPid(input.target, 5000);
      const birth = readBirth(receipt.pid);
      if (pid === null && birth === null) break;
      if (pid !== null && pid !== receipt.pid) throw new Error('APP_SMOKE_FOREIGN_PID');
      if (birth !== null && birth !== receipt.process_birth) throw new Error('APP_SMOKE_PID_REUSED');
      if (now() - started >= 30000) throw new Error('APP_SMOKE_TEARDOWN_TIMEOUT');
      sleep(50);
    }
    teardown.status = 'stopped';
    teardown.live_pid_after = null;
    teardown.process_birth_after = null;
    return teardown;
  } catch (error) { teardown.status = 'failed'; teardown.error = error.message; throw error; }
  finally {
    teardown.finished_at = new Date().toISOString();
    teardown.elapsed_ms = now() - started;
    if (receipt) fs.writeFileSync(input.receiptFile, JSON.stringify({ ...receipt, smoke_teardown: teardown }));
  }
}

if (require.main === module) {
  const input = JSON.parse(process.argv[2]);
  if (input.verify) {
    if (input.teardown) stopOwnedSmoke(input);
    else verifyReady(input);
  } else launchAndWait(input).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verifyReady, waitForAppReady, launchAndWait, currentPid, processBirth, stopOwnedSmoke };
