'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESULT_DIRECTORY = 'report-viewer-sim-e2e';
const MANIFEST = 'manifest.json';
const DEFAULT_POLL_MS = 250;

function terminateOwnedSurface(surface, {
  processState,
  signal = process.kill,
  pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  attempts = 40,
  pollMs = 100,
} = {}) {
  if (!surface || !Number.isInteger(surface.pid) || typeof surface.start !== 'string' || !surface.start || typeof processState !== 'function') throw new Error('GATE_SIMULATOR_SURFACE_CLEANUP_IDENTITY_INVALID');
  const observe = () => {
    const observed = processState(surface.pid);
    if (!observed || observed.alive !== true) return false;
    if (observed.start !== surface.start) throw new Error(`GATE_SIMULATOR_SURFACE_CLEANUP_IDENTITY_DRIFT:${surface.pid}`);
    return true;
  };
  if (!observe()) return { pid: surface.pid, outcome: 'already-exited' };
  try { signal(surface.pid, 'SIGTERM'); }
  catch (error) {
    if (error.code === 'ESRCH') return { pid: surface.pid, outcome: 'already-exited' };
    throw new Error(`GATE_SIMULATOR_SURFACE_CLEANUP_SIGNAL:${surface.pid}:${error.code || String(error.message || error)}`);
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!observe()) return { pid: surface.pid, outcome: 'terminated' };
    pause(pollMs);
  }
  throw new Error(`GATE_SIMULATOR_SURFACE_CLEANUP_SURVIVOR:${surface.pid}`);
}

function reportViewerResultCount(evidenceRoot, fsModule = fs) {
  if (typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)) throw new Error('GATE_SURFACE_TRIGGER_EVIDENCE_ROOT_INVALID');
  return resultCountInDirectory(path.join(evidenceRoot, RESULT_DIRECTORY), fsModule);
}

function mirrorDiagnosticCaseResult(resultPath, environment = process.env, fsModule = fs) {
  const directory = String(environment.PENTACLE_DIAGNOSTIC_SURFACE_TRIGGER_DIR || '').trim();
  if (!path.isAbsolute(directory)) throw new Error('DIAGNOSTIC_SURFACE_TRIGGER_DIR_INVALID');
  if (typeof resultPath !== 'string' || !path.isAbsolute(resultPath) || path.extname(resultPath) !== '.json' || !fsModule.lstatSync(resultPath).isFile()) throw new Error('DIAGNOSTIC_SURFACE_TRIGGER_RESULT_INVALID');
  fsModule.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, path.basename(resultPath));
  fsModule.copyFileSync(resultPath, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function resultCountInDirectory(runs, fsModule) {
  let entries;
  try { entries = fsModule.readdirSync(runs, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  return entries.filter((entry) => entry.isFile() && entry.name !== MANIFEST
    && entry.name.endsWith('.json') && !entry.name.endsWith('.teardown.json')).length;
}

function createCaseCompletionTrigger({
  evidenceRoot,
  resultDirectories,
  requiredResults,
  launch,
  fsModule = fs,
  pollMs = DEFAULT_POLL_MS,
  schedule = setInterval,
  cancel = clearInterval,
}) {
  if (!Number.isInteger(requiredResults) || requiredResults < 1) throw new Error('GATE_SURFACE_TRIGGER_RESULT_COUNT_INVALID');
  if (typeof launch !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function') throw new Error('GATE_SURFACE_TRIGGER_CALLBACK_INVALID');
  const directories = resultDirectories || [path.join(evidenceRoot || '', RESULT_DIRECTORY)];
  if (!Array.isArray(directories) || !directories.length || directories.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) throw new Error('GATE_SURFACE_TRIGGER_RESULT_ROOTS_INVALID');
  const trigger = {
    attempted: false,
    failure: null,
    observedResults: 0,
    probeFailure: null,
    surface: null,
    surfaces: [],
    timer: null,
    cleanupUnproven: false,
    requiredResults,
  };
  const stopTimer = () => {
    if (!trigger.timer) return;
    cancel(trigger.timer);
    trigger.timer = null;
  };
  const poll = () => {
    if (trigger.attempted || trigger.probeFailure) return;
    let count;
    try { count = Math.max(...directories.map((directory) => resultCountInDirectory(directory, fsModule))); }
    catch (error) {
      trigger.probeFailure = String(error.message || error);
      stopTimer();
      return;
    }
    trigger.observedResults = Math.max(trigger.observedResults, count);
    if (count < requiredResults) return;
    trigger.attempted = true;
    stopTimer();
    try {
      trigger.surface = launch();
      trigger.surfaces = trigger.surface ? [trigger.surface] : [];
    }
    catch (error) {
      trigger.failure = String(error.message || error);
      trigger.surface = error.surface || null;
      trigger.surfaces = Array.isArray(error.surfaces) ? error.surfaces : trigger.surface ? [trigger.surface] : [];
      trigger.cleanupUnproven = error.cleanupUnproven === true;
    }
  };
  trigger.stop = stopTimer;
  trigger.summary = () => {
    if (trigger.attempted) {
      if (trigger.failure) return `fired case_results=${trigger.observedResults} failed=${trigger.failure}`;
      return `fired case_results=${trigger.observedResults} launched_pid=${trigger.surface?.pid ?? 'unknown'}`;
    }
    if (trigger.probeFailure) return `skipped reason=artifact-probe-failed detail=${trigger.probeFailure}`;
    return `skipped reason=case-results-incomplete observed=${trigger.observedResults} required=${requiredResults}`;
  };
  trigger.timer = schedule(poll, pollMs);
  if (trigger.timer && typeof trigger.timer.unref === 'function') trigger.timer.unref();
  return trigger;
}

module.exports = {
  bind: (token) => require('./storage-capability.cjs').bind(token, { mirrorDiagnosticCaseResult, terminateOwnedSurface }),
  createCaseCompletionTrigger,
  reportViewerResultCount,
};
