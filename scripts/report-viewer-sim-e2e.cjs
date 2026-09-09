#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withSimulatorResource } = require('./sim-resource-guard.cjs');
const { reapStaleSimulatorSubstrate } = require('./sim-substrate.cjs');

const CODE_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.PENTACLE_GATE_CANONICAL_RUNNER === '1'
  ? fs.realpathSync(process.cwd())
  : CODE_ROOT;
const POST_SCENARIO_RUNTIME_SETTLE_S = 2.5;
const SIMULATOR_PREFERENCES = 'com.apple.iphonesimulator';
const HARDWARE_KEYBOARD_PREFERENCE = 'ConnectHardwareKeyboard';
const CRASHREPORTER_PREFERENCES = 'com.apple.CrashReporter';
const CRASHREPORTER_DIALOG_PREFERENCE = 'DialogType';
// `server` keeps CrashReporter WRITING .ips reports (so crash_only/fatal detection
// stays intact and the runner reaps the intentional ones) while silencing the host
// "application quit unexpectedly" dialog/notification the sentinels would otherwise pop.
const QUIET_CRASHREPORTER_DIALOG_TYPE = 'server';
const RECORDER_PREFLIGHT_TIMEOUT_MS = 360_000;
const RECORDER_TIMING_TOLERANCE_S = 0.25;
const RECORDER_PROBE_MAX_S = 40.5; // 5s start + 0.5s sample + 30s stop + 5s finalization.
const REMEDIATION_COMMAND_MAX_S = { shutdown: 60, boot: 60, bootstatus: 120 };
const SENTINELS = Object.freeze({
  console_error: { kind: 'runtime_error', source: 'console.error', fatal: false },
  unhandled_rejection: { kind: 'runtime_error', source: 'unhandledrejection', fatal: false },
  fatal: { kind: 'runtime_error', source: 'uncaught', fatal: true },
  delayed_post_return: { kind: 'runtime_error', source: 'console.error', fatal: false },
  crash_only: { kind: 'crash' },
  liveness_loss: { kind: 'liveness' },
});

function commandHasExactArgumentPair(commandLine, flag, value) {
  const argv = String(commandLine || '').trim().split(/\s+/).filter(Boolean);
  return argv.some((token, index) => token === flag && argv[index + 1] === value);
}

function commandIsSimulatorExecutable(commandLine) {
  const [executable] = String(commandLine || '').trim().split(/\s+/).filter(Boolean);
  return Boolean(executable) && path.basename(executable) === 'Simulator';
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function recordCaseAttempt(manifest, execution, details) {
  const record = {
    ...details,
    status: execution.status,
    result: path.basename(execution.resultPath),
    sha256: sha256(execution.resultPath),
  };
  manifest.cases.push(record);
  return record;
}

function runRecorderPreflight(command = spawnSync, environment = process.env) {
  const udid = String(environment.PENTACLE_GATE_BOUND_SIMULATOR_UDID || '').trim();
  if (!udid) {
    return {
      status: 4,
      evidence: {
        schema_version: 1,
        setup_verdict: 'SETUP_FAIL',
        outcome: 'failed',
        failure_reason: 'recorder ownership preflight requires the exact bound simulator UDID',
      },
    };
  }
  const result = command('python3', ['test/e2e/recorder_preflight.py', '--udid', udid], {
    cwd: ROOT,
    encoding: 'utf8',
    env: environment,
    timeout: RECORDER_PREFLIGHT_TIMEOUT_MS,
  });
  let evidence;
  try {
    evidence = JSON.parse(String(result.stdout || '').trim());
  } catch (error) {
    evidence = {
      schema_version: 1,
      setup_verdict: 'SETUP_FAIL',
      outcome: 'failed',
      failure_reason: `recorder ownership preflight returned invalid evidence: ${error.message}`,
      process_error: String(result.error?.message || ''),
      process_stderr: String(result.stderr || '').trim().slice(-1000),
    };
  }
  return { status: result.status ?? 1, evidence, expectedUdid: udid };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOwn(object, key) {
  return object !== null && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key);
}

function validateTimedInterval(label, startedAt, finishedAt, durationS, {
  containerStartedAt,
  containerFinishedAt,
  maxDurationS,
} = {}) {
  const errors = [];
  if (![startedAt, finishedAt, durationS].every(isFiniteNumber)
      || startedAt > finishedAt || durationS < 0) {
    return [`${label} timing is invalid`];
  }
  if (Math.abs((finishedAt - startedAt) - durationS) > RECORDER_TIMING_TOLERANCE_S) {
    errors.push(`${label} duration contradicts timestamps`);
  }
  if (isFiniteNumber(maxDurationS) && durationS > maxDurationS) {
    errors.push(`${label} duration exceeds its bound`);
  }
  if (isFiniteNumber(containerStartedAt) && isFiniteNumber(containerFinishedAt)
      && (startedAt < containerStartedAt || finishedAt > containerFinishedAt)) {
    errors.push(`${label} timing is outside preflight bounds`);
  }
  return errors;
}

function validateSuccessfulRecorderProbe(probe, expectedPhase, preflightStartedAt, preflightFinishedAt) {
  const errors = [];
  if (!probe || typeof probe !== 'object') return [`${expectedPhase} probe is missing`];
  if (probe.phase !== expectedPhase) errors.push(`probe phase is not ${expectedPhase}`);
  if (probe.contract_passed !== true) errors.push(`${expectedPhase} contract_passed is not true`);
  if (probe.host_recording_busy !== false) errors.push(`${expectedPhase} host_recording_busy is not false`);
  if (hasOwn(probe, 'probe_error')) {
    errors.push(`${expectedPhase} reports a probe error`);
  }
  if (probe.video_mechanism !== 'simctl recordVideo') errors.push(`${expectedPhase} video mechanism is invalid`);
  if (probe.frame_count !== null) errors.push(`${expectedPhase} frame_count schema is invalid`);
  if (probe.video_ready !== true) errors.push(`${expectedPhase} readiness is not true`);
  if (!isFiniteNumber(probe.video_ready_wait_s) || probe.video_ready_wait_s < 0 || probe.video_ready_wait_s > 5) {
    errors.push(`${expectedPhase} readiness wait is invalid`);
  }
  if (![probe.video_started_at, probe.video_ready_at, probe.video_finished_at].every(isFiniteNumber)
      || probe.video_started_at > probe.video_ready_at
      || probe.video_ready_at > probe.video_finished_at) {
    errors.push(`${expectedPhase} recorder timing is invalid`);
  } else if (Math.abs((probe.video_ready_at - probe.video_started_at) - probe.video_ready_wait_s)
      > RECORDER_TIMING_TOLERANCE_S) {
    errors.push(`${expectedPhase} readiness duration contradicts timestamps`);
  }
  errors.push(...validateTimedInterval(
    `${expectedPhase} probe`,
    probe.video_started_at,
    probe.video_finished_at,
    probe.video_finished_at - probe.video_started_at,
    {
      containerStartedAt: preflightStartedAt,
      containerFinishedAt: preflightFinishedAt,
      maxDurationS: RECORDER_PROBE_MAX_S,
    },
  ));
  if (probe.video_returncode !== 0) errors.push(`${expectedPhase} return code is not zero`);
  if (probe.video_finalized !== true) errors.push(`${expectedPhase} video is not finalized`);
  if (probe.video_forced_kill !== false) errors.push(`${expectedPhase} recorder was force-killed`);
  if (probe.video_alive_after_teardown !== false) errors.push(`${expectedPhase} recorder survived teardown`);
  if (probe.video_unavailable_reason !== null) errors.push(`${expectedPhase} has an unavailable reason`);
  if (!Number.isInteger(probe.video_bytes) || probe.video_bytes <= 0) errors.push(`${expectedPhase} video bytes are invalid`);
  if (typeof probe.video_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(probe.video_sha256)) {
    errors.push(`${expectedPhase} video hash is invalid`);
  }
  if (probe.video_retained !== false) errors.push(`${expectedPhase} probe retention disposition is invalid`);
  return errors;
}

function validateBusyRecorderProbe(probe, preflightStartedAt, preflightFinishedAt) {
  const errors = [];
  if (!probe || typeof probe !== 'object') return ['initial busy probe is missing'];
  if (probe.phase !== 'initial') errors.push('busy probe phase is not initial');
  if (probe.contract_passed !== false) errors.push('busy probe contract_passed is not false');
  if (probe.host_recording_busy !== true) errors.push('busy probe did not identify host ownership');
  if (hasOwn(probe, 'probe_error')) {
    errors.push('busy probe reports a probe error');
  }
  if (probe.video_mechanism !== 'simctl recordVideo') errors.push('busy probe video mechanism is invalid');
  if (probe.frame_count !== null) errors.push('busy probe frame_count schema is invalid');
  if (probe.video_ready !== false || probe.video_ready_at !== null) errors.push('busy probe incorrectly reports readiness');
  if (!isFiniteNumber(probe.video_ready_wait_s) || probe.video_ready_wait_s < 0 || probe.video_ready_wait_s > 5
      || !isFiniteNumber(probe.video_started_at) || !isFiniteNumber(probe.video_finished_at)
      || probe.video_started_at > probe.video_finished_at) {
    errors.push('busy probe recorder timing is invalid');
  } else if (Math.abs((probe.video_finished_at - probe.video_started_at) - probe.video_ready_wait_s)
      > RECORDER_TIMING_TOLERANCE_S) {
    errors.push('busy probe readiness duration contradicts timestamps');
  }
  errors.push(...validateTimedInterval(
    'initial busy probe',
    probe.video_started_at,
    probe.video_finished_at,
    probe.video_finished_at - probe.video_started_at,
    {
      containerStartedAt: preflightStartedAt,
      containerFinishedAt: preflightFinishedAt,
      maxDurationS: RECORDER_PROBE_MAX_S,
    },
  ));
  if (probe.video_returncode !== 16) errors.push('busy probe return code is not 16');
  if (probe.video_finalized !== false || probe.video_bytes !== 0 || probe.video_sha256 !== null) {
    errors.push('busy probe incorrectly reports finalized video evidence');
  }
  if (probe.video_forced_kill !== false || probe.video_alive_after_teardown !== false) {
    errors.push('busy probe recorder teardown evidence is invalid');
  }
  if (typeof probe.video_unavailable_reason !== 'string'
      || !probe.video_unavailable_reason.includes('Host recording is already in progress')) {
    errors.push('busy probe reason does not prove host ownership');
  }
  if (probe.video_retained !== false) errors.push('busy probe retention disposition is invalid');
  return errors;
}

function validateRecorderRemediation(remediation, preflightStartedAt, preflightFinishedAt) {
  const errors = [];
  if (!remediation || typeof remediation !== 'object') return ['remediation evidence is missing'];
  if (remediation.attempted !== true || remediation.attempts !== 1 || remediation.status !== 'passed') {
    errors.push('remediation disposition is invalid');
  }
  const commands = remediation.commands;
  if (!Array.isArray(commands) || commands.length !== 3) return [...errors, 'remediation command evidence is incomplete'];
  const labels = ['shutdown', 'boot', 'bootstatus'];
  commands.forEach((command, index) => {
    if (command?.label !== labels[index] || command?.returncode !== 0) {
      errors.push(`${labels[index]} remediation command failed identity or exit validation`);
    }
    errors.push(...validateTimedInterval(
      `${labels[index]} remediation`,
      command?.started_at,
      command?.finished_at,
      command?.duration_s,
      {
        containerStartedAt: preflightStartedAt,
        containerFinishedAt: preflightFinishedAt,
        maxDurationS: REMEDIATION_COMMAND_MAX_S[labels[index]],
      },
    ));
    if (index > 0 && isFiniteNumber(commands[index - 1]?.finished_at)
        && isFiniteNumber(command?.started_at)
        && command.started_at < commands[index - 1].finished_at) {
      errors.push(`${labels[index]} remediation overlaps ${labels[index - 1]}`);
    }
    if (typeof command?.stdout !== 'string' || typeof command?.stderr !== 'string') {
      errors.push(`${labels[index]} remediation output evidence is invalid`);
    }
    if (hasOwn(command, 'error')) {
      errors.push(`${labels[index]} remediation reports an error`);
    }
  });
  return errors;
}

function validateRecorderPreflightPass(evidence, expectedUdid) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object') return ['evidence object is missing'];
  if (evidence.schema_version !== 1) errors.push('schema_version is not 1');
  if (evidence.setup_verdict !== 'PASS') errors.push('setup_verdict is not PASS');
  const boundUdid = String(expectedUdid || '').trim();
  if (!boundUdid || evidence.simulator_udid !== boundUdid) {
    errors.push('simulator identity does not match the bound UDID');
  }
  if (['failure_reason', 'process_error', 'process_stderr'].some((key) => hasOwn(evidence, key))) {
    errors.push('PASS evidence contains a failure reason');
  }
  errors.push(...validateTimedInterval(
    'preflight',
    evidence.started_at,
    evidence.finished_at,
    evidence.duration_s,
    { maxDurationS: RECORDER_PREFLIGHT_TIMEOUT_MS / 1000 },
  ));
  const probes = evidence.ownership_probes;
  if (!Array.isArray(probes)) return [...errors, 'ownership_probes is missing'];
  if (evidence.outcome === 'clear') {
    if (evidence.stale_ownership_detected !== false || probes.length !== 1) errors.push('clear ownership disposition is invalid');
    errors.push(...validateSuccessfulRecorderProbe(
      probes[0], 'initial', evidence.started_at, evidence.finished_at,
    ));
    const remediation = evidence.remediation;
    if (!remediation || remediation.attempted !== false || remediation.attempts !== 0
        || remediation.status !== 'not_needed' || !Array.isArray(remediation.commands)
        || remediation.commands.length !== 0 || hasOwn(remediation, 'error')) {
      errors.push('clear remediation evidence is invalid');
    }
  } else if (evidence.outcome === 'remediated') {
    if (evidence.stale_ownership_detected !== true || probes.length !== 2) errors.push('remediated ownership disposition is invalid');
    errors.push(...validateBusyRecorderProbe(probes[0], evidence.started_at, evidence.finished_at));
    if (hasOwn(evidence.remediation, 'error')) {
      errors.push('remediation reports an error');
    }
    errors.push(...validateRecorderRemediation(evidence.remediation, evidence.started_at, evidence.finished_at));
    errors.push(...validateSuccessfulRecorderProbe(
      probes[1], 'post_remediation', evidence.started_at, evidence.finished_at,
    ));
    const commands = evidence.remediation?.commands;
    if (Array.isArray(commands) && commands.length === 3) {
      if (isFiniteNumber(probes[0]?.video_finished_at) && isFiniteNumber(commands[0]?.started_at)
          && commands[0].started_at < probes[0].video_finished_at) {
        errors.push('shutdown remediation begins before the initial busy probe ends');
      }
      if (isFiniteNumber(commands[2]?.finished_at) && isFiniteNumber(probes[1]?.video_started_at)
          && probes[1].video_started_at < commands[2].finished_at) {
        errors.push('post-remediation probe begins before bootstatus ends');
      }
    }
  } else {
    errors.push('outcome is neither clear nor remediated');
  }
  return errors;
}

function requireRecorderPreflight(manifest, execution) {
  manifest.recorder_preflight = execution.evidence;
  if (execution.status !== 0 || execution.evidence?.setup_verdict !== 'PASS') {
    const verdict = execution.evidence?.setup_verdict || 'SETUP_FAIL';
    const reason = execution.evidence?.failure_reason || `process exit ${execution.status}`;
    throw new Error(`recorder ownership preflight ended ${verdict}: ${reason}`);
  }
  const evidenceErrors = validateRecorderPreflightPass(execution.evidence, execution.expectedUdid);
  if (evidenceErrors.length) {
    throw new Error(`recorder ownership preflight PASS evidence is invalid: ${evidenceErrors.join('; ')}`);
  }
  return execution.evidence;
}

function scenarioPlan() {
  return [
    { scenario: 'report_viewer_horizontal_scroll', expected: 'PASS' },
    { scenario: 'report_viewer_runtime_sentinel', sentinel: 'clean', expected: 'PASS' },
    ...Object.entries(SENTINELS).map(([sentinel, runtimeExpected]) => ({
      scenario: 'report_viewer_runtime_sentinel',
      sentinel,
      expected: 'FAIL',
      runtimeExpected,
    })),
    { scenario: 'report_viewer_comments_keyboard', expected: 'PASS' },
  ];
}

function resultFiles(runsDir) {
  return new Set(fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter((entry) => {
      if (!entry.endsWith('.json')) return false;
      if (!entry.endsWith('.teardown.json')) return true;
      // run_scenario emits this auxiliary proof even on SETUP_FAIL. It is not a
      // primary result, but malformed proof or an unreaped owner must fail closed.
      let proof;
      try { proof = JSON.parse(fs.readFileSync(path.join(runsDir, entry), 'utf8')); }
      catch { throw new Error(`SCENARIO_TEARDOWN_INVALID: ${entry}`); }
      if (!proof || Object.keys(proof).sort().join(',') !== 'attempted,closed,closed_count,orphan_count,orphans'
        || !Number.isSafeInteger(proof.attempted) || proof.attempted < 0
        || !Array.isArray(proof.closed) || !proof.closed.every((id) => typeof id === 'string' && id.length > 0)
        || new Set(proof.closed).size !== proof.closed.length || proof.closed_count !== proof.closed.length
        || !Array.isArray(proof.orphans) || proof.orphan_count !== 0 || proof.orphans.length !== 0
        || proof.attempted !== proof.closed_count + proof.orphan_count) {
        throw new Error(`SCENARIO_TEARDOWN_INVALID: ${entry}`);
      }
      return false;
    })
    : []);
}

function validateSentinelResult(payload, { runId, sentinel, expected }) {
  if (payload.verdict === 'SETUP_FAIL' || payload.verdict === 'SKIPPED') {
    throw new Error(`${sentinel} ended ${payload.verdict}, not expected-red`);
  }
  const events = Array.isArray(payload.all_events) ? payload.all_events : [];
  const runErrors = events.filter((event) =>
    event?.message === 'harness:runtime_error'
    && event?.data?.scenario_run_id === runId
  );
  const monitor = payload?.result?.extras?.runtime_monitor;
  const liveness = monitor?.liveness;
  const processIdentity = monitor?.process_identity;
  const outcome = monitor?.outcome;
  if (
    !monitor
    || monitor.settle_s !== POST_SCENARIO_RUNTIME_SETTLE_S
    || !Object.hasOwn(monitor, 'fresh_crash_report')
    || !Object.hasOwn(monitor, 'crash_exit_signal')
    || !liveness
    || typeof liveness.returncode !== 'number'
    || typeof liveness.bundle_present !== 'boolean'
    || typeof liveness.stderr !== 'string'
    || !Number.isFinite(liveness.checked_at)
    || !Number.isFinite(liveness.completed_at)
    || liveness.completed_at < liveness.checked_at
    || typeof liveness.resolved_bundle_id !== 'string'
    || !Array.isArray(liveness.resolved_pids)
    || processIdentity?.verified !== true
    || processIdentity.bundle_id !== liveness.resolved_bundle_id
    || typeof processIdentity.launch_pid !== 'string'
    || processIdentity.armed_telemetry_pid !== processIdentity.launch_pid
    || !Array.isArray(processIdentity.pre_scenario_pids)
    || processIdentity.pre_scenario_pids.length !== 1
    || processIdentity.pre_scenario_pids[0] !== processIdentity.launch_pid
    || !outcome
    || typeof outcome.kind !== 'string'
    || !Array.isArray(outcome.pids)
    || JSON.stringify(outcome.pids) !== JSON.stringify(liveness.resolved_pids)
    || liveness.bundle_present !== (liveness.resolved_pids.length > 0)
    || typeof payload.raw_log_sidecar !== 'string'
    || !payload.raw_log_sidecar.trim()
  ) {
    throw new Error(`${sentinel} lacked crash/liveness runtime-monitor evidence`);
  }
  if (payload.verdict !== 'FAIL') throw new Error(`${sentinel} did not fail`);
  if (sentinel === 'fatal') {
    const release = monitor.post_identity_release;
    const fatalError = monitor.fatal_runtime_error_identity;
    if (release?.verified !== true
      || release.transport !== 'loopback_ack'
      || release.sentinel !== sentinel
      || release.scenario_run_id !== runId
      || release.telemetry_pid !== processIdentity.launch_pid
      || fatalError?.verified !== true
      || fatalError.sentinel !== sentinel
      || fatalError.scenario_run_id !== runId
      || fatalError.telemetry_pid !== processIdentity.launch_pid) {
      throw new Error('fatal sentinel requires exact-PID release and runtime-error evidence');
    }
  }
  if (expected.kind === 'crash') {
    // Crash proof is the simulator's own PID-exact exit signal, NOT the host .ips. macOS
    // throttles/dedups repeated identical crash reports (empirically ZERO filed across repeated
    // identical crashes even with no reaping) and this harness reaps the reports it causes, so
    // `fresh_crash_report` is neither reliable nor self-consistent. This remains a POSITIVE proof:
    // a run where the app did not actually abort logs no SIGABRT for the launched PID and fails.
    const crashSignal = monitor.crash_exit_signal;
    if (
      runErrors.length !== 0
      || crashSignal?.verified !== true
      || crashSignal.signal !== 'SIGABRT'
      || crashSignal.pid !== processIdentity.launch_pid
      || typeof crashSignal.evidence !== 'string'
      || !crashSignal.evidence.trim()
      || liveness.bundle_present !== false
      || monitor.owned_termination !== 'crash_only'
      || outcome.kind !== 'harness_owned_crash'
    ) {
      throw new Error(`${sentinel} lacked independent crash-only expected-red evidence`);
    }
    return [];
  }
  if (expected.kind === 'liveness') {
    // Positively prove a CLEAN termination: the launched PID must carry NO SIGABRT exit signal.
    // (The host .ips is throttled to null in a depleted state, so it cannot carry this contract.)
    if (
      runErrors.length !== 0
      || monitor.crash_exit_signal !== null
      || liveness.bundle_present !== false
      || monitor.owned_termination !== 'liveness_loss'
      || outcome.kind !== 'harness_owned_termination'
    ) {
      throw new Error(`${sentinel} lacked independent liveness-loss expected-red evidence`);
    }
    return [];
  }
  const marker = `runtime sentinel ${sentinel}`;
  const errors = runErrors.filter((event) =>
    event?.data?.source === expected.source
    && event?.data?.fatal === expected.fatal
    && typeof event?.data?.stack === 'string'
    && event.data.stack.includes(marker)
    && event?.data?.detail === marker
  );
  if (errors.length === 0) throw new Error(`${sentinel} lacked matching run-filtered runtime-error evidence`);
  return errors;
}

// Wait for a Simulator surface this run can adopt, after our own launch was DENIED. Split out so each way
// of failing gets its OWN message: a bounded wait that ends is a diagnosis site, and a diagnosis site that
// reports one string for several causes is the defect that cost this program three runs. The three
// outcomes are distinguishable in the thrown error, and the caller records it.
function awaitAdoptableSurface(command, options, udid, pause, attempts = 40) {
  let sawMismatch = false;
  let sawUnreadable = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = command('pgrep', ['-x', 'Simulator'], options);
    if (probe.status !== 0 && probe.status !== 1) throw new Error('could not probe for an adoptable Simulator surface');
    const pids = probe.status === 0 ? String(probe.stdout || '').trim().split(/\s+/).filter(Boolean) : [];
    if (pids.length > 1) throw new Error('ambiguous Simulator surfaces appeared after launch was denied');
    if (pids.length === 1 && /^\d+$/.test(pids[0])) {
      const identity = command('ps', ['-p', pids[0], '-o', 'command='], options);
      // "Could not read the identity" and "read it and it was not ours" are DIFFERENT observations and
      // must not share a flag - collapsing them here would be the very defect these branches exist to
      // avoid, one level in. Caught by its own control rather than by reading.
      if (identity.status !== 0) sawUnreadable = true;
      else if (commandHasExactArgumentPair(identity.stdout, '-CurrentDeviceUDID', udid)) return pids[0];
      else sawMismatch = true;
    }
    pause(250);
  }
  // Distinct on purpose: "one appeared and it was not ours" is a different finding, with a different
  // owner, from "none ever appeared" - the first means the launcher produced the wrong surface, the
  // second means it produced none at all.
  if (sawMismatch) throw new Error('Simulator surface appeared but is not bound to the exact gate UDID');
  if (sawUnreadable) throw new Error('Simulator surface appeared but its identity was unreadable');
  throw new Error('no exact-UDID Simulator surface appeared after launch was denied');
}

function withSoftwareKeyboard(
  run,
  command = spawnSync,
  environment = process.env,
  pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  warn = (message) => process.stderr.write(`[report-viewer-sim-e2e] owned-Simulator teardown clutter (self-heals via the pre-run substrate reap): ${message}\n`),
  // Emitted on EVERY call, success or failure, adopted or launched. The adoption path has never executed
  // in this program's history, so the claim that it skips teardown is reasoned from code and pinned by a
  // test, never observed. The first time it does execute, that must be visible from an artefact rather
  // than inferred from the absence of a denial in a kernel log - so this states positively which mode ran,
  // whether the teardown block ran, and whether a kill was attempted.
  report = (message) => process.stderr.write(`[report-viewer-sim-e2e] simulator surface: ${message}\n`),
) {
  const udid = String(environment.PENTACLE_GATE_BOUND_SIMULATOR_UDID || '').trim();
  if (!udid) throw new Error('comments require the exact bound simulator UDID');

  const options = { encoding: 'utf8' };
  const initialSimulator = command('pgrep', ['-x', 'Simulator'], options);
  if (initialSimulator.status !== 0 && initialSimulator.status !== 1) throw new Error('could not determine Simulator process ownership');
  // A pre-existing surface is ADOPTED only when it is provably bound to this run: exactly one process
  // whose argv carries the exact `-CurrentDeviceUDID <udid>` pair — the identical proof the launch path
  // below applies to the surface it creates. Every other pre-existing state (none matching, more than
  // one, an unreadable identity, a different UDID) still throws exactly as it did before, so this
  // tolerates our own surface without tolerating anyone else's.
  //
  // WHY IT EXISTS: under the gate's sandbox, LaunchServices app launch is denied (-54), so the `open`
  // below cannot run at all. The launch is performed by the wrapper, outside the sandbox, and this
  // function adopts the result instead of refusing it. Adopting is also why teardown stays gated on
  // `launched`: a surface we did not create is not ours to terminate, and its launcher reaps it.
  //
  // ARGV IS NOT AN ATTACHMENT PROOF, and nothing here should be read as claiming it is. Measured
  // 2026-07-22 with a control: for a device in a PRIVATE device set, `open -g -a Simulator --args
  // -CurrentDeviceUDID <udid>` returns rc=0 and the process carries the exact pair, while the named
  // device stays Shutdown and Simulator attaches to a DIFFERENT default-set device instead; adding
  // `-DeviceSetPath <set>` is what makes it genuinely attach. Attachment is therefore proven by the
  // launcher, which knows the device set and fails closed when the device does not boot — never
  // inferred from this check.
  let adoptedPid;
  if (initialSimulator.status === 0) {
    const existing = String(initialSimulator.stdout || '').trim().split(/\s+/).filter(Boolean);
    if (existing.length !== 1 || !/^\d+$/.test(existing[0])) {
      throw new Error('pre-existing Simulator process prevents exact comments ownership');
    }
    const existingIdentity = command('ps', ['-p', existing[0], '-o', 'command='], options);
    if (existingIdentity.status !== 0 || !commandHasExactArgumentPair(existingIdentity.stdout, '-CurrentDeviceUDID', udid)) {
      throw new Error('pre-existing Simulator process prevents exact comments ownership');
    }
    adoptedPid = existing[0];
  }

  const read = command('defaults', ['read', SIMULATOR_PREFERENCES, HARDWARE_KEYBOARD_PREFERENCE], options);
  const preferenceWasAbsent = read.status === 1;
  if (read.status !== 0 && !preferenceWasAbsent) throw new Error('could not read Simulator hardware-keyboard preference');
  const prior = String(read.stdout || '').trim();
  const previous = preferenceWasAbsent ? null : prior === '1' || prior === 'true'
    ? true
    : prior === '0' || prior === 'false'
      ? false
      : undefined;
  if (!preferenceWasAbsent && previous === undefined) throw new Error(`unexpected Simulator hardware-keyboard preference: ${prior}`);

  const disabled = command('defaults', ['write', SIMULATOR_PREFERENCES, HARDWARE_KEYBOARD_PREFERENCE, '-bool', 'false'], options);
  if (disabled.status !== 0) throw new Error('could not disable Simulator hardware keyboard');

  let primaryError;
  let result;
  let launched = false;
  let cleanupRan = false;
  let killAttempted = false;
  let ownedPid;
  let ownedStart;
  let launchedCandidatePid;
  let launchedCandidateStart;
  const cleanupErrors = [];
  // Identity-verification refusals below are BENIGN: the guard safely declined to signal a PID it
  // could not positively confirm as our owned Simulator (the invariant "never kill an unverified
  // PID" holds). Prior-run clutter routinely trips them and they self-heal via the pre-run
  // substrate reap, so they are warned, not thrown. Only genuine failures — a verified kill that
  // failed, an owned process that survived its kill, a preference-restore failure — fail the gate.
  const cleanupWarnings = [];
  try {
    if (adoptedPid) ownedPid = adoptedPid;
    else {
    const launch = command('open', ['-g', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], options);
    // THE DENIAL IS THE TRIGGER. Under the gate sandbox LaunchServices app launch is denied (-54), and
    // this is the ONLY moment at which this function can signal, synchronously and at exactly the moment
    // of need, that it requires a surface it is not permitted to create. Every other candidate signal
    // this function emits - the ownership triple, the preference write - happens AFTER the decision it
    // would have to influence, so a launcher watching for them arrives too late by construction.
    // Outside the sandbox this branch never runs: the launch succeeds and the standalone path is
    // unchanged, so the wait costs nothing where nothing is denied.
    if (launch.status !== 0) {
      ownedPid = awaitAdoptableSurface(command, options, udid, pause);
      adoptedPid = ownedPid;
    } else {
    launched = true;

    let ready = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const probe = command('pgrep', ['-x', 'Simulator'], options);
      if (probe.status === 0) {
        const pids = String(probe.stdout || '').trim().split(/\s+/).filter(Boolean);
        if (pids.length !== 1 || !/^\d+$/.test(pids[0])) throw new Error('owned Simulator surface has ambiguous process identity');
        launchedCandidatePid = pids[0];
        const identity = command('ps', ['-p', pids[0], '-o', 'command='], options);
        const start = command('ps', ['-p', pids[0], '-o', 'lstart='], options);
        if (start.status !== 0 || !String(start.stdout || '').trim()) {
          throw new Error('Simulator surface process start identity is unavailable');
        }
        launchedCandidateStart = String(start.stdout).trim();
        if (identity.status !== 0 || !commandHasExactArgumentPair(identity.stdout, '-CurrentDeviceUDID', udid)) {
          throw new Error('Simulator surface is not bound to the exact gate UDID');
        }
        ownedPid = pids[0];
        ownedStart = launchedCandidateStart;
        ready = true;
        break;
      }
      if (probe.status !== 1) throw new Error('could not probe Simulator surface readiness');
      pause(250);
    }
    if (!ready) throw new Error('exact-UDID Simulator surface did not become ready');
    }
    }
    result = run({
      PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_PID: ownedPid,
      PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_SCENARIO: 'report_viewer_comments_keyboard',
      PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_UDID: udid,
    });
  } catch (error) {
    primaryError = error;
  }

  if (launched) {
    cleanupRan = true;
    let cleanupPid = ownedPid || launchedCandidatePid;
    if (!cleanupPid) {
      const rediscovery = command('pgrep', ['-x', 'Simulator'], options);
      if (rediscovery.status === 0) {
        const pids = String(rediscovery.stdout || '').trim().split(/\s+/).filter(Boolean);
        if (pids.length === 1 && /^\d+$/.test(pids[0])) {
          cleanupPid = pids[0];
          const rediscoveredStart = command('ps', ['-p', cleanupPid, '-o', 'lstart='], options);
          if (rediscoveredStart.status === 0 && String(rediscoveredStart.stdout || '').trim()) {
            launchedCandidateStart = String(rediscoveredStart.stdout).trim();
          } else {
            cleanupWarnings.push(new Error('could not capture launched Simulator process identity for cleanup'));
            cleanupPid = undefined;
          }
        } else cleanupWarnings.push(new Error('could not rediscover one launched Simulator process for cleanup'));
      } else if (rediscovery.status !== 1) {
        cleanupWarnings.push(new Error('could not probe launched Simulator process for cleanup'));
      }
    }
    if (cleanupPid) {
      const cleanupIdentity = command('ps', ['-p', cleanupPid, '-o', 'command='], options);
      const identityMatches = ownedPid
        ? commandHasExactArgumentPair(cleanupIdentity.stdout, '-CurrentDeviceUDID', udid)
        : commandIsSimulatorExecutable(cleanupIdentity.stdout);
      if (cleanupIdentity.status === 1) {
        cleanupPid = undefined;
      } else if (cleanupIdentity.status !== 0 || !identityMatches) {
        cleanupWarnings.push(new Error('refusing to terminate Simulator PID with changed or unverified identity'));
        cleanupPid = undefined;
      }
    }
    const cleanupExpectedStart = ownedStart || launchedCandidateStart;
    if (cleanupPid) {
      const cleanupStart = command('ps', ['-p', cleanupPid, '-o', 'lstart='], options);
      const currentStart = String(cleanupStart.stdout || '').trim();
      if (cleanupStart.status !== 0 || !currentStart || !cleanupExpectedStart || currentStart !== cleanupExpectedStart) {
        cleanupWarnings.push(new Error('refusing to terminate reused or unverified Simulator PID'));
        cleanupPid = undefined;
      }
    }
    if (cleanupPid) {
      killAttempted = true;
      const terminated = command('kill', ['-TERM', cleanupPid], options);
      if (terminated.status !== 0) {
        cleanupErrors.push(new Error('could not terminate owned Simulator process'));
      } else {
      let stopped = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const probe = command('ps', ['-p', cleanupPid, '-o', 'command='], options);
        if (probe.status === 1) {
          stopped = true;
          break;
        }
        if (probe.status === 0 && !commandHasExactArgumentPair(probe.stdout, '-CurrentDeviceUDID', udid)) {
          stopped = true;
          break;
        }
        if (probe.status === 0 && cleanupExpectedStart) {
          const currentStart = command('ps', ['-p', cleanupPid, '-o', 'lstart='], options);
          if (currentStart.status === 0 && String(currentStart.stdout || '').trim() !== cleanupExpectedStart) {
            stopped = true;
            break;
          }
          if (currentStart.status !== 0) {
            // TOCTOU: the `command=` probe just saw the owned PID alive, but by this `lstart=`
            // call the kill-TERM'd process has already exited (its process row is gone). That is
            // exactly the successful termination we asked for — not an identity failure. Treat it
            // as stopped so a benign race can never fail the case.
            stopped = true;
            break;
          }
        }
        if (probe.status !== 0) {
          cleanupWarnings.push(new Error('could not probe owned Simulator PID cleanup'));
          break;
        }
        pause(250);
      }
      if (!stopped && cleanupErrors.length === 0 && cleanupWarnings.length === 0) cleanupErrors.push(new Error('owned Simulator process did not exit'));
      }
    }
  }

  // Positive, unconditional, and it reads like the wrapper's never-fired line by design: the three
  // states - adopted, launched, neither - are named rather than inferred, and the two facts the
  // layer-17 argument rests on (the teardown block did not run, no kill was attempted) are STATED.
  report(`mode=${adoptedPid ? 'adopted' : launched ? 'launched' : 'none'} pid=${ownedPid || 'none'} `
    + `cleanup_block=${cleanupRan ? 'ran' : 'skipped'} kill_attempted=${killAttempted ? 'yes' : 'no'}`);
  const restoreArgs = preferenceWasAbsent
    ? ['delete', SIMULATOR_PREFERENCES, HARDWARE_KEYBOARD_PREFERENCE]
    : ['write', SIMULATOR_PREFERENCES, HARDWARE_KEYBOARD_PREFERENCE, '-bool', String(previous)];
  const restored = command('defaults', restoreArgs, options);
  if (restored.status !== 0) cleanupErrors.push(new Error('could not restore Simulator hardware-keyboard preference'));

  if (cleanupWarnings.length) warn(cleanupWarnings.map((entry) => entry.message).join('; '));
  if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'comments scenario and Simulator cleanup failed');
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'Simulator cleanup failed');
  return result;
}

function runScenario({ scenario, runsDir, runId, sentinel, extraEnvironment = {} }) {
  const before = resultFiles(runsDir);
  const args = ['test/e2e/run_scenario.py', scenario, '--runs-dir', runsDir];
  if (process.env.PENTACLE_GATE_SIM_E2E_ENV_FILE) {
    args.push('--env-file', process.env.PENTACLE_GATE_SIM_E2E_ENV_FILE);
  }
  const result = spawnSync('python3', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnvironment,
      PENTACLE_RUN_ID: runId,
      ...(sentinel ? { PENTACLE_RUNTIME_SENTINEL: sentinel } : {}),
    },
  });
  const created = [...resultFiles(runsDir)].filter((entry) => !before.has(entry));
  if (created.length !== 1) {
    throw new Error(`${scenario}/${runId} produced ${created.length} result JSON files`);
  }
  const resultPath = path.join(runsDir, created[0]);
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    resultPath,
    payload: JSON.parse(fs.readFileSync(resultPath, 'utf8')),
  };
}

// Snapshot the host CrashReporter DialogType, force `server` for the run, and
// return a best-effort restore(). The fatal/crash_only sentinels deliberately
// crash the simulator app, which otherwise pops a host "quit unexpectedly"
// dialog/notification per run; `server` suppresses that surface without stopping
// .ips writing (detection is load-bearing — never disable report writing). A read
// or write failure degrades to a no-op restore so this can never fail the gate.
// Skipped under PENTACLE_TEST_DISABLE_CRASHREPORTER_GUARD=1 so unit tests running
// the real entrypoint (with a mocked runner) never mutate the host preference.
function suppressCrashReporterDialogs(command = spawnSync, environment = process.env) {
  if (String(environment.PENTACLE_TEST_DISABLE_CRASHREPORTER_GUARD || '') === '1') {
    return { restore() {} };
  }
  const options = { encoding: 'utf8' };
  const read = command('defaults', ['read', CRASHREPORTER_PREFERENCES, CRASHREPORTER_DIALOG_PREFERENCE], options);
  const preferenceWasAbsent = read.status !== 0;
  const prior = preferenceWasAbsent ? null : String(read.stdout || '').trim();
  const applied = command('defaults', ['write', CRASHREPORTER_PREFERENCES, CRASHREPORTER_DIALOG_PREFERENCE, QUIET_CRASHREPORTER_DIALOG_TYPE], options);
  const suppressed = applied.status === 0;
  return {
    suppressed,
    restore() {
      if (!suppressed) return;
      if (preferenceWasAbsent) {
        command('defaults', ['delete', CRASHREPORTER_PREFERENCES, CRASHREPORTER_DIALOG_PREFERENCE], options);
      } else {
        command('defaults', ['write', CRASHREPORTER_PREFERENCES, CRASHREPORTER_DIALOG_PREFERENCE, prior], options);
      }
    },
  };
}

function main() {
  const artifactRoot = path.resolve(process.env.PENTACLE_GATE_ARTIFACT_DIR || path.join(ROOT, '_artifacts', 'full-gate', 'standalone'));
  const runsDir = path.join(artifactRoot, 'report-viewer-sim-e2e');
  fs.mkdirSync(runsDir, { recursive: true });
  const candidateSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const prefix = `report-viewer-${candidateSha.slice(0, 12)}-${Date.now()}`;
  const manifest = { candidate_sha: candidateSha, attempts_per_case: 1, cases: [], status: 'failed' };
  const crashReporterGuard = suppressCrashReporterDialogs();
  try {
    withSimulatorResource(() => {
    // Secondary net (full-gate.cjs does the primary pre-boot provisioning): reap stale
    // idb_companion before the plan so the comments teardown's owned-Simulator identity checks
    // aren't polluted by a prior run's daemons. Best-effort; the bound sim is already booted so
    // no sim shutdown here.
    if (!process.env.PENTACLE_STORAGE_RUN_ID) reapStaleSimulatorSubstrate();
    requireRecorderPreflight(manifest, runRecorderPreflight());
    for (const entry of scenarioPlan()) {
      const { scenario, sentinel, expected, runtimeExpected } = entry;
      const suffix = scenario === 'report_viewer_runtime_sentinel' ? `runtime-${sentinel}` : scenario;
      const runId = `${prefix}-${suffix}`;
      const execute = (extraEnvironment = {}) => runScenario({ scenario, runsDir, runId, sentinel, extraEnvironment });
      const execution = scenario === 'report_viewer_comments_keyboard'
        ? withSoftwareKeyboard(execute, spawnSync, process.env)
        : execute();
      const runtimeErrors = (execution.payload.all_events || []).filter((event) =>
        event?.message === 'harness:runtime_error' && event?.data?.scenario_run_id === runId
      );
      const caseRecord = recordCaseAttempt(manifest, execution, {
        scenario,
        ...(sentinel ? { sentinel } : {}),
        run_id: runId,
        expected,
        ...(sentinel === 'clean' ? { runtime_errors: runtimeErrors.length } : {}),
      });
      if (expected === 'PASS') {
        if (execution.status !== 0 || execution.payload.verdict !== 'PASS' || runtimeErrors.length) {
          throw new Error(`${scenario}${sentinel ? `/${sentinel}` : ''} did not pass in its single attempt`);
        }
        continue;
      }
      if (execution.status !== 1) throw new Error(`${sentinel} expected exit 1, received ${execution.status}`);
      const errors = validateSentinelResult(execution.payload, { runId, sentinel, expected: runtimeExpected });
      caseRecord.runtime_errors = errors.length;
    }
    manifest.status = 'passed';
    }, { label: `pentacle-mobile-report-viewer-${candidateSha.slice(0, 12)}` });
  } finally {
    crashReporterGuard.restore();
    fs.writeFileSync(path.join(runsDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function parseCliArgs(args) {
  if (args.length === 0) return { run: true };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { run: false };
  throw new Error(`unsupported argument: ${args.join(' ')}`);
}

if (require.main === module) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.run) main();
    else console.log('Usage: node scripts/report-viewer-sim-e2e.cjs');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { commandHasExactArgumentPair, commandIsSimulatorExecutable, POST_SCENARIO_RUNTIME_SETTLE_S, scenarioPlan, SENTINELS, parseCliArgs, recordCaseAttempt, resultFiles, requireRecorderPreflight, runRecorderPreflight, suppressCrashReporterDialogs, validateRecorderPreflightPass, validateSentinelResult, withSoftwareKeyboard };
