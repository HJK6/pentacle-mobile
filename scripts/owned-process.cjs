'use strict';

// The guardian is detached from its caller, so caller/group death cannot strand its child group.
// A pipe barrier holds the actual command until its owner has durably recorded the group identity.
function guardian() {
  const fs = require('node:fs');
  const { spawn, spawnSync } = require('node:child_process');
  const input = JSON.parse(process.argv[1]);
  const started = Date.now();
  let child; let childExit = null; let stopping = false; let timer; let watcher;
  const record = { kind: 'ownership', stage: input.stage, owner_pid: input.ownerPid,
    guardian_pid: process.pid, started_at: new Date(started).toISOString(), bound_ms: input.boundMs,
    term_sent: false, kill_sent: false, child_exit: null, group_alive_after: null, disposition: 'intent' };
  const persist = () => {
    const file = fs.openSync(input.marker, 'w', 0o600);
    try { fs.writeFileSync(file, JSON.stringify(record)); fs.fsyncSync(file); } finally { fs.closeSync(file); }
  };
  const alive = () => {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code !== 'EPERM') throw error;
      // Darwin may answer EPERM for a group that just disappeared. Prove absence independently.
      const census = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 2000 });
      if (census.error || census.status !== 0) throw error;
      const rows = census.stdout.trim().split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)$/));
      if (rows.some((row) => !row)) throw error;
      return rows.some((row) => Number(row[2]) === child.pid);
    }
  };
  const signal = (name) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, name); record[name === 'SIGTERM' ? 'term_sent' : 'kill_sent'] = true; }
    catch (error) { if (error.code !== 'ESRCH') record.signal_error = `${error.code}:${error.message}`; }
  };
  const finish = (status) => {
    clearTimeout(timer); clearInterval(watcher);
    record.child_exit = childExit;
    try { record.group_alive_after = alive(); } catch (error) { record.group_alive_after = true; record.census_error = error.message; }
    record.finished_at = new Date().toISOString();
    if (record.group_alive_after || record.signal_error) status = 125;
    try { persist(); } catch (error) { process.stderr.write(`ownership receipt failed: ${error.message}\n`); status = 125; }
    if (record.disposition === 'owner-exit' && input.cleanupRoot) {
      try { fs.rmSync(input.cleanupRoot, { recursive: true, force: true }); }
      catch (error) { process.stderr.write(`owned temporary cleanup failed: ${error.message}\n`); status = 125; }
    }
    process.exit(status);
  };
  const stop = (cause, status) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer); clearInterval(watcher);
    record.disposition = cause;
    if (cause === 'timeout') delete record.kind;
    signal('SIGTERM');
    const deadline = Date.now() + input.graceMs;
    const reap = () => {
      let remaining;
      try { remaining = alive(); } catch (error) { record.census_error = error.message; return finish(125); }
      if (!remaining) { if (cause === 'timeout') record.disposition = record.kill_sent ? 'killed' : 'terminated'; return finish(status); }
      if (Date.now() < deadline) return setTimeout(reap, 25);
      signal('SIGKILL');
      const killed = Date.now();
      const drain = () => {
        try { if (!alive()) { if (cause === 'timeout') record.disposition = 'killed'; return finish(status); } }
        catch (error) { record.census_error = error.message; return finish(125); }
        if (Date.now() - killed < 1000) return setTimeout(drain, 25);
        record.disposition = 'survived-sigkill'; finish(125);
      };
      drain();
    };
    reap();
  };
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => stop(name, name === 'SIGINT' ? 130 : 143));
  process.on('uncaughtException', (error) => { record.guardian_error = error.message; stop('guardian-error', 125); });
  persist();
  const launch = 'process.stdin.once("data",()=>{const c=require("child_process").spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:"inherit"});c.on("error",e=>{console.error(e.message);process.exit(127)});c.on("exit",(code,signal)=>process.exit(code??(signal==="SIGINT"?130:signal==="SIGTERM"?143:1)));process.stdin.destroy()})';
  child = spawn(process.execPath, ['-e', launch, input.command[0], JSON.stringify(input.command.slice(1))],
    { detached: true, env: process.env, stdio: ['pipe', 'inherit', 'inherit'] });
  record.owned_pid = child.pid;
  record.owned_process_group = child.pid;
  record.disposition = 'spawned';
  persist();
  child.on('error', (error) => { record.spawn_error = error.message; stop('spawn-error', 127); });
  child.on('exit', (code, signalName) => {
    childExit = { code, signal: signalName };
    if (!stopping) stop('completed', code ?? (signalName === 'SIGTERM' ? 143 : signalName === 'SIGINT' ? 130 : 1));
  });
  child.stdin.on('error', (error) => { record.pipe_error = error.message; stop('barrier-error', 125); });
  timer = setTimeout(() => stop('timeout', 124), input.boundMs);
  watcher = setInterval(() => {
    let parentAlive = process.ppid !== 1;
    try { if (input.ownerPid) process.kill(input.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') parentAlive = false; }
    if (!parentAlive) stop('owner-exit', 143);
  }, 100);
  child.stdin.end('go');
}

const RUNNER_SOURCE = `(${guardian.toString()})()`;

function runOwnedSync(binary, args = [], options = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(options.env?.TMPDIR || os.tmpdir(), 'pentacle-owned-'));
  const marker = path.join(root, 'owner.json');
  const boundMs = options.timeout || 60000;
  const { timeout, ...spawnOptions } = options;
  try {
    const result = spawnSync(process.execPath, ['-e', RUNNER_SOURCE, JSON.stringify({ command: [binary, ...args],
      marker, cleanupRoot: root, stage: path.basename(binary), boundMs, graceMs: options.graceMs || 2000, ownerPid: process.pid })],
    { ...spawnOptions, env: { ...(spawnOptions.env || process.env), PENTACLE_OWNED_GROUP_RECEIPT: marker }, detached: true });
    const receipt = JSON.parse(fs.readFileSync(marker, 'utf8'));
    result.ownership = receipt;
    if (receipt.bound_ms && !receipt.kind) result.error = Object.assign(new Error(`${binary} timed out after ${boundMs}ms`), { code: 'ETIMEDOUT' });
    return result;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function spawnOwned(binary, args = [], options = {}) {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const root = fs.mkdtempSync(path.join(options.env?.TMPDIR || os.tmpdir(), 'pentacle-owned-'));
  const marker = path.join(root, 'owner.json');
  try {
    const child = require('node:child_process').spawn(process.execPath, ['-e', RUNNER_SOURCE, JSON.stringify({
      command: [binary, ...args], marker, cleanupRoot: root, stage: path.basename(binary),
      boundMs: options.timeout || 10800000, graceMs: 2000, ownerPid: process.pid,
    })], { cwd: options.cwd, env: { ...(options.env || process.env), PENTACLE_OWNED_GROUP_RECEIPT: marker }, stdio: options.stdio || 'inherit', detached: true });
    child.once('close', () => fs.rmSync(root, { recursive: true, force: true }));
    return child;
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

function signalProbeRelay() {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  let timer;
  const cleanup = () => {
    if (!child.pid) return;
    child.kill('SIGTERM');
    timer ||= setTimeout(() => child.kill('SIGKILL'), 250);
  };
  child.once('spawn', () => process.send({ owned_pid: child.pid, owned_pgid: child.pid }));
  child.once('error', () => process.exit(1));
  child.once('exit', () => {
    clearTimeout(timer);
    if (process.connected) process.send({ cleanup_verified: true }, () => process.exit(0));
    else process.exit(0);
  });
  process.on('message', cleanup);
  process.once('disconnect', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

function probeSignalCapability() {
  return new Promise((resolve) => {
    const started = Date.now();
    const result = { probe_pid: process.pid, relay_pid: null, owned_pid: null, owned_pgid: null,
      visibility_errno: null, signal_errno: null, cleanup_verified: false, ok: false };
    const relay = require('node:child_process').spawn(process.execPath, ['-e', `(${signalProbeRelay.toString()})()`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    result.relay_pid = relay.pid;
    const cleanup = () => { if (relay.connected) relay.send('cleanup', () => undefined); };
    const timer = setTimeout(() => { result.timeout_ms = 3000; cleanup(); }, 3000);
    relay.on('message', (message) => {
      if (message.cleanup_verified) { result.cleanup_verified = true; return; }
      if (!Number.isInteger(message.owned_pid) || message.owned_pid <= 1 || message.owned_pgid !== message.owned_pid) { cleanup(); return; }
      Object.assign(result, message);
      for (const [signal, key] of [[0, 'visibility_errno'], ['SIGTERM', 'signal_errno']]) {
        try { process.kill(-message.owned_pgid, signal); result[key] = 0; }
        catch (error) { result[key] = Math.abs(error.errno || 1); result[`${key}_code`] = error.code; }
      }
      cleanup();
    });
    relay.once('error', (error) => { result.error = error.message; });
    relay.once('close', (code) => {
      clearTimeout(timer);
      result.ok = code === 0 && result.cleanup_verified && result.visibility_errno === 0 && result.signal_errno === 0 && !result.timeout_ms;
      result.elapsed_ms = Date.now() - started;
      resolve(result);
    });
  });
}

function isOwnedInvocation() {
  try {
    const receipt = JSON.parse(require('node:fs').readFileSync(process.env.PENTACLE_OWNED_GROUP_RECEIPT, 'utf8'));
    return receipt.owned_process_group === process.ppid && receipt.owner_pid !== process.pid && receipt.disposition === 'spawned';
  } catch { return false; }
}

module.exports = { RUNNER_SOURCE, runOwnedSync, spawnOwned, probeSignalCapability, isOwnedInvocation };
