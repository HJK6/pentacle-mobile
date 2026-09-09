'use strict';

const { spawn } = require('node:child_process');
const { transition } = require('./storage-authority.cjs');

class SupervisorMachine {
  constructor() {
    this.state = 'initial';
    this.shutdownCause = null;
    this.termCount = 0;
    this.killCount = 0;
    this.cleanupCount = 0;
  }

  move(next) { this.state = transition('supervisor', this.state, next); }

  beginShutdown(cause) {
    if (this.shutdownCause) return false;
    if (this.state !== 'spawned') return false;
    this.shutdownCause = cause;
    this.move('stopping');
    this.termCount += 1;
    return true;
  }

  beginReap() {
    if (this.state !== 'stopping') return false;
    this.move('reaping');
    this.killCount += 1;
    return true;
  }

  beginCleanup() {
    if (!['spawned', 'stopping', 'reaping'].includes(this.state)) return false;
    this.move('cleaning');
    this.cleanupCount += 1;
    return true;
  }

  complete() {
    if (this.state !== 'cleaning') throw new Error('SUPERVISOR_CLEANUP_ORDER');
    this.move('complete');
  }
}

function processGroupAlive(pid, signal = process.kill) {
  try { signal(-pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') throw error;
    if (signal !== process.kill) return true;
    const result = require('node:child_process').spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 2000 });
    if (result.error || result.status !== 0) return true;
    const rows = result.stdout.trim().split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)$/));
    if (rows.some((row) => !row)) return true;
    return rows.some((row) => Number(row[2]) === pid);
  }
}

function exitStatus(code, signalName, cause) {
  if (cause === 'SIGINT') return 130;
  if (cause === 'SIGTERM') return 143;
  if (cause === 'low-disk' || cause === 'child-error' || cause === 'survivor') return 17;
  if (signalName === 'SIGINT') return 130;
  if (signalName === 'SIGTERM') return 143;
  return Number.isInteger(code) ? code : 17;
}

async function supervise(argv, options = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((value) => typeof value !== 'string')) throw new Error('SUPERVISOR_ARGV_INVALID');
  const machine = new SupervisorMachine();
  const spawnChild = options.spawnChild || ((command, args) => require('./owned-process.cjs').spawnOwned(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' }));
  const signalGroup = options.signalGroup || ((pid, signalName) => process.kill(-pid, signalName));
  const groupAlive = options.groupAlive || processGroupAlive;
  const capacity = options.capacity || (() => undefined);
  const cleanup = options.cleanup || (async () => undefined);
  const graceMs = options.graceMs ?? 10000;
  const reapMs = options.reapMs ?? 5000;
  const pollMs = options.pollMs ?? 5000;
  let child;
  let graceTimer;
  let reapTimer;
  let diskTimer;
  let settled = false;
  let childCode = null;
  let childSignal = null;
  let cleanupError = null;
  let pendingCause = null;

  return await new Promise((resolve) => {
    const clear = () => {
      if (graceTimer) clearTimeout(graceTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (diskTimer) clearInterval(diskTimer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };

    const finish = async () => {
      if (settled || !machine.beginCleanup()) return;
      settled = true;
      clear();
      try { await cleanup(); } catch (error) { cleanupError = error; }
      machine.complete();
      let status = exitStatus(childCode, childSignal, machine.shutdownCause);
      if (cleanupError && status === 0) status = 17;
      resolve({ status, machine, cleanup_error: cleanupError ? String(cleanupError.message || cleanupError) : null });
    };

    const kill = () => {
      if (!machine.beginReap()) return;
      try { signalGroup(child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') machine.shutdownCause ||= 'child-error'; }
      reapTimer = setTimeout(() => {
        if (groupAlive(child.pid)) machine.shutdownCause = 'survivor';
        void finish();
      }, reapMs);
    };

    const graceExpired = () => {
      if (!groupAlive(child.pid)) { void finish(); return; }
      kill();
    };

    const stop = (cause) => {
      if (!machine.beginShutdown(cause)) return;
      try { signalGroup(child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') machine.shutdownCause ||= 'child-error'; }
      graceTimer = setTimeout(graceExpired, graceMs);
    };

    const requestStop = (cause) => {
      if (machine.state === 'initial') { pendingCause ||= cause; return; }
      stop(cause);
    };
    const onSigint = () => requestStop('SIGINT');
    const onSigterm = () => requestStop('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    try {
      child = spawnChild(argv[0], argv.slice(1));
      machine.move('spawned');
      if (pendingCause) requestStop(pendingCause);
    } catch (error) {
      machine.state = 'spawned';
      machine.shutdownCause = 'child-error';
      childCode = 17;
      void finish();
      return;
    }

    child.once('error', () => requestStop('child-error'));
    child.once('close', (code, signalName) => {
      childCode = code;
      childSignal = signalName;
      if (groupAlive(child.pid)) requestStop('descendants');
      else void finish();
    });

    diskTimer = setInterval(() => {
      try { capacity(); } catch { requestStop('low-disk'); }
    }, pollMs);
  });
}

module.exports = { SupervisorMachine, bind: (token) => require('./storage-capability.cjs').bind(token, { supervise }), exitStatus, processGroupAlive };
