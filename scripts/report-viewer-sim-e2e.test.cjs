const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runnerModule = process.env.PENTACLE_REPORT_VIEWER_RUNNER_MODULE || './report-viewer-sim-e2e.cjs';

// Exercise the actual private selector on the old and new certified sources.
function selectScenarioResults(runsDir) {
  const source = fs.readFileSync(require.resolve(runnerModule), 'utf8');
  const selector = source.match(/^function resultFiles\(runsDir\) \{[\s\S]*?^\}/m);
  assert.ok(selector, 'certified result selector must exist');
  return [...vm.runInNewContext(`(${selector[0]})`, { fs, path })(runsDir)].sort();
}

function resultFixture(t, teardown = { attempted: 0, closed: [], closed_count: 0, orphans: [], orphan_count: 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'start.teardown.json'), JSON.stringify(teardown));
  return root;
}

test('scenario results distinguish the producer teardown sidecar from the primary result', (t) => {
  const root = resultFixture(t);
  fs.writeFileSync(path.join(root, 'finish.json'), JSON.stringify({ verdict: 'PASS' }));
  assert.deepEqual(selectScenarioResults(root), ['finish.json']);
});

test('a teardown sidecar cannot manufacture a missing primary result', (t) => {
  assert.deepEqual(selectScenarioResults(resultFixture(t)), []);
});

test('unknown and duplicate primary JSON remain counted', (t) => {
  const root = resultFixture(t);
  for (const name of ['primary.json', 'duplicate.json', 'unknown.json']) fs.writeFileSync(path.join(root, name), '{}');
  assert.deepEqual(selectScenarioResults(root), ['duplicate.json', 'primary.json', 'unknown.json']);
});

for (const [label, payload] of [
  ['primary disguised as teardown', { verdict: 'PASS' }],
  ['orphaned owner', { attempted: 1, closed: [], closed_count: 0, orphans: [{ stream_id: 'owned' }], orphan_count: 1 }],
  ['inconsistent counts', { attempted: 1, closed: [], closed_count: 0, orphans: [], orphan_count: 0 }],
]) {
  test(`scenario results reject ${label} sidecar`, (t) => {
    assert.throws(() => selectScenarioResults(resultFixture(t, payload)), /SCENARIO_TEARDOWN_INVALID/);
  });
}

test('scenario results reject malformed teardown JSON', (t) => {
  const root = resultFixture(t);
  fs.writeFileSync(path.join(root, 'start.teardown.json'), '{broken');
  assert.throws(() => selectScenarioResults(root), /SCENARIO_TEARDOWN_INVALID/);
});
const { commandHasExactArgumentPair, recordCaseAttempt, requireRecorderPreflight, runRecorderPreflight, scenarioPlan, SENTINELS, suppressCrashReporterDialogs, validateSentinelResult, withSoftwareKeyboard } = require(runnerModule);

function successfulRecorderProbe(phase, startedAt = 10) {
  return {
    phase,
    contract_passed: true,
    host_recording_busy: false,
    video_mechanism: 'simctl recordVideo',
    frame_count: null,
    video_ready: true,
    video_started_at: startedAt,
    video_ready_at: startedAt + 1,
    video_ready_wait_s: 1,
    video_finished_at: startedAt + 2,
    video_returncode: 0,
    video_finalized: true,
    video_forced_kill: false,
    video_alive_after_teardown: false,
    video_unavailable_reason: null,
    video_bytes: 1024,
    video_sha256: 'a'.repeat(64),
    video_retained: false,
  };
}

function clearRecorderPreflightEvidence() {
  return {
    schema_version: 1,
    simulator_udid: 'SIM-EXACT',
    setup_verdict: 'PASS',
    outcome: 'clear',
    stale_ownership_detected: false,
    ownership_probes: [successfulRecorderProbe('initial')],
    remediation: { attempted: false, attempts: 0, status: 'not_needed', commands: [] },
    started_at: 9,
    finished_at: 13,
    duration_s: 4,
  };
}

function remediatedRecorderPreflightEvidence() {
  const command = (label, offset) => ({
    label,
    returncode: 0,
    stdout: '',
    stderr: '',
    started_at: 20 + offset,
    finished_at: 21 + offset,
    duration_s: 1,
  });
  return {
    ...clearRecorderPreflightEvidence(),
    finished_at: 21,
    duration_s: 12,
    outcome: 'remediated',
    stale_ownership_detected: true,
    ownership_probes: [{
      phase: 'initial',
      contract_passed: false,
      host_recording_busy: true,
      video_mechanism: 'simctl recordVideo',
      frame_count: null,
      video_ready: false,
      video_started_at: 10,
      video_ready_at: null,
      video_ready_wait_s: 1,
      video_finished_at: 11,
      video_returncode: 16,
      video_finalized: false,
      video_forced_kill: false,
      video_alive_after_teardown: false,
      video_unavailable_reason: 'Host recording is already in progress',
      video_bytes: 0,
      video_sha256: null,
      video_retained: false,
    }, successfulRecorderProbe('post_remediation', 18)],
    remediation: {
      attempted: true,
      attempts: 1,
      status: 'passed',
      commands: [command('shutdown', -8), command('boot', -6), command('bootstatus', -4)],
    },
  };
}

function boundedRemediationEvidence(durations) {
  const evidence = remediatedRecorderPreflightEvidence();
  let cursor = 12;
  evidence.remediation.commands.forEach((command, index) => {
    const duration = durations[index];
    Object.assign(command, { started_at: cursor, finished_at: cursor + duration, duration_s: duration });
    cursor += duration + 1;
  });
  evidence.ownership_probes[1] = successfulRecorderProbe('post_remediation', cursor);
  evidence.finished_at = cursor + 3;
  evidence.duration_s = evidence.finished_at - evidence.started_at;
  return evidence;
}

test('runs GUI-owning comments after every headless runtime sentinel', () => {
  const plan = scenarioPlan();
  assert.equal(plan[0].scenario, 'report_viewer_horizontal_scroll');
  assert.equal(plan.at(-1).scenario, 'report_viewer_comments_keyboard');
  assert.equal(plan.at(-1).expected, 'PASS');
  assert.equal(
    plan.filter((entry) => entry.scenario === 'report_viewer_runtime_sentinel').length,
    Object.keys(SENTINELS).length + 1,
  );
  assert.equal(plan.slice(0, -1).some((entry) => entry.scenario === 'report_viewer_comments_keyboard'), false);
});

test('failed case evidence is recorded before the caller aborts', () => {
  const manifest = { cases: [] };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-failed-case-'));
  const resultPath = path.join(tempRoot, 'failed-result.json');
  fs.writeFileSync(resultPath, '{}');
  try {
    const recorded = recordCaseAttempt(manifest, {
      status: 1,
      resultPath,
    }, {
      scenario: 'report_viewer_horizontal_scroll',
      run_id: 'single-attempt',
      expected: 'PASS',
    });
    assert.equal(recorded.status, 1);
    assert.deepEqual(manifest.cases, [recorded]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('recorder preflight evidence is persisted before a setup failure aborts all cases', () => {
  const manifest = { cases: [] };
  const evidence = {
    setup_verdict: 'SETUP_FAIL',
    outcome: 'failed',
    stale_ownership_detected: true,
    remediation: { attempted: true, attempts: 1 },
  };
  assert.throws(
    () => requireRecorderPreflight(manifest, { status: 4, evidence }),
    /recorder ownership preflight ended SETUP_FAIL/,
  );
  assert.deepEqual(manifest.recorder_preflight, evidence);
  assert.deepEqual(manifest.cases, []);
});

test('recorder preflight accepts only evidence satisfying the complete invariant contract', () => {
  const readinessAtBound = clearRecorderPreflightEvidence();
  Object.assign(readinessAtBound.ownership_probes[0], {
    video_ready_at: 15,
    video_ready_wait_s: 5,
    video_finished_at: 16,
  });
  Object.assign(readinessAtBound, { finished_at: 17, duration_s: 8 });
  const probeAtBound = clearRecorderPreflightEvidence();
  probeAtBound.ownership_probes[0].video_finished_at = 50.5;
  Object.assign(probeAtBound, { finished_at: 51.5, duration_s: 42.5 });
  const preflightAtBound = clearRecorderPreflightEvidence();
  Object.assign(preflightAtBound, { finished_at: 369, duration_s: 360 });
  const busyWaitAtBound = remediatedRecorderPreflightEvidence();
  Object.assign(busyWaitAtBound.ownership_probes[0], { video_finished_at: 15, video_ready_wait_s: 5 });
  Object.assign(busyWaitAtBound.remediation.commands[0], { started_at: 16, finished_at: 17 });
  Object.assign(busyWaitAtBound.remediation.commands[1], { started_at: 18, finished_at: 19 });
  Object.assign(busyWaitAtBound.remediation.commands[2], { started_at: 20, finished_at: 21 });
  busyWaitAtBound.ownership_probes[1] = successfulRecorderProbe('post_remediation', 22);
  Object.assign(busyWaitAtBound, { finished_at: 25, duration_s: 16 });
  const validEvidence = [
    clearRecorderPreflightEvidence(),
    remediatedRecorderPreflightEvidence(),
    readinessAtBound,
    probeAtBound,
    preflightAtBound,
    busyWaitAtBound,
    boundedRemediationEvidence([60, 1, 1]),
    boundedRemediationEvidence([1, 60, 1]),
    boundedRemediationEvidence([1, 1, 120]),
  ];
  for (const evidence of validEvidence) {
    const manifest = { cases: [] };
    assert.equal(requireRecorderPreflight(manifest, {
      status: 0,
      expectedUdid: 'SIM-EXACT',
      evidence,
    }), evidence);
    assert.equal(manifest.recorder_preflight, evidence);
  }

  const clear = clearRecorderPreflightEvidence;
  const remediated = remediatedRecorderPreflightEvidence;
  const mutations = [
    ['schema is required', clear, (evidence) => { delete evidence.schema_version; }],
    ['bound simulator identity is exact', clear, (evidence) => { evidence.simulator_udid = 'SIM-WRONG'; }],
    ['outcome is a known disposition', clear, (evidence) => { evidence.outcome = 'unknown'; }],
    ['initial phase evidence is required', clear, (evidence) => { evidence.ownership_probes = []; }],
    ['initial phase identity is exact', clear, (evidence) => { evidence.ownership_probes[0].phase = 'wrong'; }],
    ['successful probe contract disposition is exact', clear, (evidence) => { evidence.ownership_probes[0].contract_passed = false; }],
    ['successful probe is not hostbusy', clear, (evidence) => { evidence.ownership_probes[0].host_recording_busy = true; }],
    ['successful probe mechanism is exact', clear, (evidence) => { evidence.ownership_probes[0].video_mechanism = 'other'; }],
    ['readiness is required', clear, (evidence) => { evidence.ownership_probes[0].video_ready = false; }],
    ['readiness wait type is numeric', clear, (evidence) => { evidence.ownership_probes[0].video_ready_wait_s = '1'; }],
    ['readiness hard bound is not widened by coherence tolerance', clear, (evidence) => {
      Object.assign(evidence.ownership_probes[0], {
        video_ready_at: 15.001,
        video_ready_wait_s: 5.001,
        video_finished_at: 16,
      });
      Object.assign(evidence, { finished_at: 17, duration_s: 8 });
    }],
    ['zero recorder exit is required', clear, (evidence) => { evidence.ownership_probes[0].video_returncode = 1; }],
    ['finalization is required', clear, (evidence) => { evidence.ownership_probes[0].video_finalized = false; }],
    ['successful probe forbids forced kill', clear, (evidence) => { evidence.ownership_probes[0].video_forced_kill = true; }],
    ['successful probe forbids a live recorder', clear, (evidence) => { evidence.ownership_probes[0].video_alive_after_teardown = true; }],
    ['successful probe forbids unavailable reason', clear, (evidence) => { evidence.ownership_probes[0].video_unavailable_reason = ''; }],
    ['nonzero video is required', clear, (evidence) => { evidence.ownership_probes[0].video_bytes = 0; }],
    ['video byte count is an integer', clear, (evidence) => { evidence.ownership_probes[0].video_bytes = 1.5; }],
    ['video hash is required', clear, (evidence) => { evidence.ownership_probes[0].video_sha256 = null; }],
    ['video hash type is exact', clear, (evidence) => { evidence.ownership_probes[0].video_sha256 = ['a'.repeat(64)]; }],
    ['probe retention disposition is exact', clear, (evidence) => { evidence.ownership_probes[0].video_retained = true; }],
    ['probe timestamps are ordered', clear, (evidence) => { evidence.ownership_probes[0].video_ready_at = 20; }],
    ['probe timestamp types are numeric', clear, (evidence) => { evidence.ownership_probes[0].video_started_at = '10'; }],
    ['clear stale-ownership disposition is exact', clear, (evidence) => { evidence.stale_ownership_detected = true; }],
    ['clear outcome forbids remediation', clear, (evidence) => { evidence.remediation.attempted = true; }],
    ['clear PASS forbids serialized remediation error', clear, (evidence) => { evidence.remediation.error = null; }],
    ['PASS forbids a failure reason', clear, (evidence) => { evidence.failure_reason = 'contradictory failure'; }],
    ['PASS forbids serialized null failure reason', clear, (evidence) => { evidence.failure_reason = null; }],
    ['PASS forbids serialized process error', clear, (evidence) => { evidence.process_error = null; }],
    ['PASS forbids process stderr', clear, (evidence) => { evidence.process_stderr = 'diagnostic'; }],
    ['PASS forbids a probe error', clear, (evidence) => { evidence.ownership_probes[0].probe_error = 'failed'; }],
    ['probe_error must be absent, not empty', clear, (evidence) => { evidence.ownership_probes[0].probe_error = ''; }],
    ['probe_error must be absent, not null', clear, (evidence) => { evidence.ownership_probes[0].probe_error = null; }],
    ['frame_count schema is exact', clear, (evidence) => { evidence.ownership_probes[0].frame_count = 'unknown'; }],
    ['preflight duration matches timestamps', clear, (evidence) => { evidence.duration_s = 40; }],
    ['preflight duration is bounded', clear, (evidence) => { evidence.finished_at = 410; evidence.duration_s = 401; }],
    ['preflight hard bound is not widened by coherence tolerance', clear, (evidence) => {
      Object.assign(evidence, { finished_at: 369.001, duration_s: 360.001 });
    }],
    ['initial probe starts within preflight', clear, (evidence) => {
      Object.assign(evidence.ownership_probes[0], successfulRecorderProbe('initial', 8));
    }],
    ['initial probe ends within preflight', clear, (evidence) => { evidence.ownership_probes[0].video_finished_at = 14; }],
    ['readiness duration matches timestamps', clear, (evidence) => { evidence.ownership_probes[0].video_ready_wait_s = 4; }],
    ['ownership probe duration is bounded', clear, (evidence) => {
      Object.assign(evidence, { finished_at: 60, duration_s: 51 });
      evidence.ownership_probes[0].video_finished_at = 59;
    }],
    ['ownership probe rejects any duration over 40.5 seconds', clear, (evidence) => {
      Object.assign(evidence, { finished_at: 51.501, duration_s: 42.501 });
      evidence.ownership_probes[0].video_finished_at = 50.501;
    }],
    ['busy and post phases are both required', remediated, (evidence) => { evidence.ownership_probes.pop(); }],
    ['remediated stale-ownership disposition is exact', remediated, (evidence) => { evidence.stale_ownership_detected = false; }],
    ['busy probe phase identity is exact', remediated, (evidence) => { evidence.ownership_probes[0].phase = 'wrong'; }],
    ['busy probe contract disposition is exact', remediated, (evidence) => { evidence.ownership_probes[0].contract_passed = true; }],
    ['busy probe proves host ownership', remediated, (evidence) => { evidence.ownership_probes[0].host_recording_busy = false; }],
    ['busy probe forbids probe_error', remediated, (evidence) => { evidence.ownership_probes[0].probe_error = ''; }],
    ['busy probe forbids serialized null probe_error', remediated, (evidence) => { evidence.ownership_probes[0].probe_error = null; }],
    ['busy probe mechanism is exact', remediated, (evidence) => { evidence.ownership_probes[0].video_mechanism = 'other'; }],
    ['busy probe frame_count schema is exact', remediated, (evidence) => { evidence.ownership_probes[0].frame_count = 0; }],
    ['busy probe is not ready', remediated, (evidence) => { evidence.ownership_probes[0].video_ready = true; }],
    ['busy probe has no readiness timestamp', remediated, (evidence) => { evidence.ownership_probes[0].video_ready_at = 10.5; }],
    ['busy wait matches timestamps', remediated, (evidence) => { evidence.ownership_probes[0].video_ready_wait_s = 4; }],
    ['busy wait rejects any duration over 5 seconds', remediated, (evidence) => {
      Object.assign(evidence.ownership_probes[0], { video_finished_at: 15.001, video_ready_wait_s: 5.001 });
      Object.assign(evidence.remediation.commands[0], { started_at: 16, finished_at: 17 });
      Object.assign(evidence.remediation.commands[1], { started_at: 18, finished_at: 19 });
      Object.assign(evidence.remediation.commands[2], { started_at: 20, finished_at: 21 });
      evidence.ownership_probes[1] = successfulRecorderProbe('post_remediation', 22);
      Object.assign(evidence, { finished_at: 25, duration_s: 16 });
    }],
    ['busy reason must be a string', remediated, (evidence) => {
      evidence.ownership_probes[0].video_unavailable_reason = ['Host recording is already in progress'];
    }],
    ['busy reason must name host ownership', remediated, (evidence) => { evidence.ownership_probes[0].video_unavailable_reason = 'busy'; }],
    ['busy return code is exactly rc16', remediated, (evidence) => { evidence.ownership_probes[0].video_returncode = 0; }],
    ['busy video is unfinalized', remediated, (evidence) => { evidence.ownership_probes[0].video_finalized = true; }],
    ['busy video has zero bytes', remediated, (evidence) => { evidence.ownership_probes[0].video_bytes = 1; }],
    ['busy video has no hash', remediated, (evidence) => { evidence.ownership_probes[0].video_sha256 = 'a'.repeat(64); }],
    ['busy probe forbids forced kill', remediated, (evidence) => { evidence.ownership_probes[0].video_forced_kill = true; }],
    ['busy probe forbids a live recorder', remediated, (evidence) => { evidence.ownership_probes[0].video_alive_after_teardown = true; }],
    ['busy probe retention disposition is exact', remediated, (evidence) => { evidence.ownership_probes[0].video_retained = true; }],
    ['busy probe is contained by preflight', remediated, (evidence) => {
      Object.assign(evidence.ownership_probes[0], { video_started_at: 8, video_ready_wait_s: 3 });
    }],
    ['shutdown follows the busy probe', remediated, (evidence) => {
      Object.assign(evidence.remediation.commands[0], { started_at: 10.5, finished_at: 11.5 });
    }],
    ['boot does not overlap shutdown', remediated, (evidence) => {
      Object.assign(evidence.remediation.commands[1], { started_at: 12.5, finished_at: 13.5 });
    }],
    ['bootstatus does not overlap boot', remediated, (evidence) => {
      Object.assign(evidence.remediation.commands[2], { started_at: 14.5, finished_at: 15.5 });
    }],
    ['command duration matches timestamps', remediated, (evidence) => { evidence.remediation.commands[0].duration_s = 5; }],
    ['shutdown rejects any duration over 60 seconds', () => boundedRemediationEvidence([60.001, 1, 1]), () => {}],
    ['boot rejects any duration over 60 seconds', () => boundedRemediationEvidence([1, 60.001, 1]), () => {}],
    ['bootstatus rejects any duration over 120 seconds', () => boundedRemediationEvidence([1, 1, 120.001]), () => {}],
    ['post probe follows bootstatus', remediated, (evidence) => {
      Object.assign(evidence.ownership_probes[1], successfulRecorderProbe('post_remediation', 16.5));
    }],
    ['post probe is contained by preflight', remediated, (evidence) => { evidence.ownership_probes[1].video_finished_at = 22; }],
    ['exactly one remediation is required', remediated, (evidence) => { evidence.remediation.attempts = 2; }],
    ['remediation attempted disposition is exact', remediated, (evidence) => { evidence.remediation.attempted = false; }],
    ['remediation status is passed', remediated, (evidence) => { evidence.remediation.status = 'failed'; }],
    ['remediation command cardinality is exact', remediated, (evidence) => { evidence.remediation.commands.pop(); }],
    ['remediation command identity and order are exact', remediated, (evidence) => { evidence.remediation.commands[1].label = 'bootstatus'; }],
    ['remediation command exit is zero', remediated, (evidence) => { evidence.remediation.commands[0].returncode = 1; }],
    ['remediation output evidence is required', remediated, (evidence) => { delete evidence.remediation.commands[0].stdout; }],
    ['remediation forbids an error disposition', remediated, (evidence) => { evidence.remediation.error = 'failed'; }],
    ['remediation forbids serialized null error', remediated, (evidence) => { evidence.remediation.error = null; }],
    ['successful command forbids an error disposition', remediated, (evidence) => { evidence.remediation.commands[0].error = 'timed out'; }],
    ['successful command forbids serialized null error', remediated, (evidence) => { evidence.remediation.commands[0].error = null; }],
    ['post phase identity is exact', remediated, (evidence) => { evidence.ownership_probes[1].phase = 'wrong'; }],
    ['post readiness is required', remediated, (evidence) => { evidence.ownership_probes[1].video_ready = false; }],
  ];
  for (const [name, factory, mutate] of mutations) {
    const evidence = factory();
    mutate(evidence);
    const manifest = { cases: [] };
    assert.throws(
      () => requireRecorderPreflight(manifest, { status: 0, expectedUdid: 'SIM-EXACT', evidence }),
      /PASS evidence is invalid/,
      name,
    );
    assert.equal(manifest.recorder_preflight, evidence, `${name}: evidence was not persisted`);
    assert.deepEqual(manifest.cases, [], `${name}: a case was allowed to start`);
  }

  const missingBoundIdentityManifest = { cases: [] };
  assert.throws(
    () => requireRecorderPreflight(missingBoundIdentityManifest, {
      status: 0,
      expectedUdid: '',
      evidence: clearRecorderPreflightEvidence(),
    }),
    /PASS evidence is invalid/,
  );
  assert.deepEqual(missingBoundIdentityManifest.cases, []);
});

test('recorder preflight invokes the bounded Python contract for the exact simulator', () => {
  const evidence = { setup_verdict: 'PASS', outcome: 'clear' };
  const calls = [];
  const execution = runRecorderPreflight((name, args, options) => {
    calls.push({ name, args, options });
    return { status: 0, stdout: `${JSON.stringify(evidence)}\n`, stderr: '' };
  }, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' });

  assert.equal(execution.status, 0);
  assert.deepEqual(execution.evidence, evidence);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'python3');
  assert.deepEqual(calls[0].args, ['test/e2e/recorder_preflight.py', '--udid', 'SIM-EXACT']);
  assert.equal(calls[0].options.timeout, 360_000);
});

test('recorder preflight fails closed on missing identity or malformed evidence', () => {
  const missing = runRecorderPreflight(() => assert.fail('must not spawn without a bound simulator'), {});
  assert.equal(missing.status, 4);
  assert.equal(missing.evidence.setup_verdict, 'SETUP_FAIL');

  const malformed = runRecorderPreflight(
    () => ({ status: 0, stdout: 'not-json', stderr: 'broken preflight' }),
    { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' },
  );
  const manifest = { cases: [] };
  assert.throws(() => requireRecorderPreflight(manifest, malformed), /invalid evidence/);
  assert.equal(manifest.recorder_preflight.setup_verdict, 'SETUP_FAIL');
  assert.deepEqual(manifest.cases, []);

  const incompleteManifest = { cases: [] };
  assert.throws(
    () => requireRecorderPreflight(incompleteManifest, {
      status: 0,
      expectedUdid: 'SIM-EXACT',
      evidence: { setup_verdict: 'PASS' },
    }),
    /recorder ownership preflight PASS evidence is invalid/,
  );
  assert.deepEqual(incompleteManifest.recorder_preflight, { setup_verdict: 'PASS' });
  assert.deepEqual(incompleteManifest.cases, []);
});

test('run-level recorder setup failure persists manifest evidence and executes zero cases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-viewer-recorder-preflight-'));
  const artifactDir = path.join(root, 'artifacts');
  const python = path.join(root, 'python3');
  const evidence = {
    schema_version: 1,
    setup_verdict: 'SETUP_FAIL',
    outcome: 'failed',
    stale_ownership_detected: true,
    remediation: { attempted: true, attempts: 1, status: 'failed', commands: [] },
    ownership_probes: [{ phase: 'initial', host_recording_busy: true, video_returncode: 16 }],
    failure_reason: 'single simulator shutdown/boot remediation failed',
  };
  fs.writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(evidence)}'\nexit 4\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    PENTACLE_GATE_ARTIFACT_DIR: artifactDir,
    PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT',
    PENTACLE_GATE_TEST_MODE: '1',
    PENTACLE_TEST_DISABLE_SIM_RESOURCE_GUARD: '1',
    PENTACLE_TEST_DISABLE_CRASHREPORTER_GUARD: '1',
    PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP: '1',
  };
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'report-viewer-sim-e2e.cjs')], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /recorder ownership preflight ended SETUP_FAIL/);
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'report-viewer-sim-e2e', 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'failed');
    assert.deepEqual(manifest.cases, []);
    assert.deepEqual(manifest.recorder_preflight, evidence);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comments force software keyboard mode and restore the prior preference', () => {
  const calls = [];
  let pgrepCalls = 0;
  let psCalls = 0;
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0, 1][pgrepCalls++];
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ < 2
      ? { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let ran = false;
  withSoftwareKeyboard(() => { ran = true; }, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {});
  assert.equal(ran, true);
  assert.deepEqual(calls.filter(([name]) => name === 'defaults').map(([, args]) => args), [
    ['read', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard'],
    ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'false'],
    ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'true'],
  ]);
});

test('comments restore an absent preference even when the scenario fails', () => {
  const calls = [];
  let pgrepCalls = 0;
  let psCalls = 0;
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0, 1][pgrepCalls++];
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ < 2
      ? { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(
    () => withSoftwareKeyboard(() => { throw new Error('scenario failed'); }, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /scenario failed/,
  );
  assert.deepEqual(calls.filter(([name]) => name === 'defaults').at(-1)[1], ['delete', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard']);
});

test('comments fail closed before launch when keyboard mode cannot be read', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') return { status: 1, stdout: '', stderr: '' };
    return { status: 2, stdout: '', stderr: 'read failed' };
  };
  let ran = false;
  assert.throws(() => withSoftwareKeyboard(() => { ran = true; }, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}), /could not read/);
  assert.equal(ran, false);
  assert.deepEqual(calls.map(([name, args]) => [name, args[0]]), [['pgrep', '-x'], ['defaults', 'read']]);
});

test('crash-reporter guard snapshots DialogType, forces server, and restores the prior value', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: 'crashreport\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const guard = suppressCrashReporterDialogs(command, {});
  assert.equal(guard.suppressed, true);
  guard.restore();
  assert.deepEqual(calls.map(([name, args]) => [name, ...args]), [
    ['defaults', 'read', 'com.apple.CrashReporter', 'DialogType'],
    ['defaults', 'write', 'com.apple.CrashReporter', 'DialogType', 'server'],
    ['defaults', 'write', 'com.apple.CrashReporter', 'DialogType', 'crashreport'],
  ]);
});

test('crash-reporter guard restores an absent DialogType by deleting the override', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'defaults' && args[0] === 'read') return { status: 1, stdout: '', stderr: 'does not exist' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const guard = suppressCrashReporterDialogs(command, {});
  assert.equal(guard.suppressed, true);
  guard.restore();
  assert.deepEqual(calls.map(([name, args]) => [name, ...args]), [
    ['defaults', 'read', 'com.apple.CrashReporter', 'DialogType'],
    ['defaults', 'write', 'com.apple.CrashReporter', 'DialogType', 'server'],
    ['defaults', 'delete', 'com.apple.CrashReporter', 'DialogType'],
  ]);
});

test('crash-reporter guard is a no-op under PENTACLE_TEST_DISABLE_CRASHREPORTER_GUARD', () => {
  const calls = [];
  const command = (name, args) => { calls.push([name, args]); return { status: 0, stdout: '', stderr: '' }; };
  const guard = suppressCrashReporterDialogs(command, { PENTACLE_TEST_DISABLE_CRASHREPORTER_GUARD: '1' });
  guard.restore();
  assert.deepEqual(calls, []);
});

test('crash-reporter guard never touches the preference again when it could not apply the override', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: 'crashreport\n', stderr: '' };
    if (name === 'defaults' && args[0] === 'write') return { status: 1, stdout: '', stderr: 'denied' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const guard = suppressCrashReporterDialogs(command, {});
  assert.equal(guard.suppressed, false);
  guard.restore();
  assert.deepEqual(calls.map(([name, args]) => [name, args[0]]), [['defaults', 'read'], ['defaults', 'write']]);
});

test('comments launch an exact-UDID Simulator surface and clean it up', () => {
  const calls = [];
  let pgrepCalls = 0;
  let psCalls = 0;
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0, 1][pgrepCalls++];
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ < 2
      ? { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let ran = false;
  let runEnvironment;
  withSoftwareKeyboard(
    (environment) => { ran = true; runEnvironment = environment; },
    command,
    { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' },
    () => {},
  );
  assert.equal(ran, true);
  assert.deepEqual(runEnvironment, {
    PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_PID: '9001',
    PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_SCENARIO: 'report_viewer_comments_keyboard',
    PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_UDID: 'SIM-EXACT',
  });
  assert.deepEqual(calls, [
    ['pgrep', ['-x', 'Simulator']],
    ['defaults', ['read', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard']],
    ['defaults', ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'false']],
    ['open', ['-g', '-a', 'Simulator', '--args', '-CurrentDeviceUDID', 'SIM-EXACT']],
    ['pgrep', ['-x', 'Simulator']],
    ['ps', ['-p', '9001', '-o', 'command=']],
    ['ps', ['-p', '9001', '-o', 'lstart=']],
    ['ps', ['-p', '9001', '-o', 'command=']],
    ['ps', ['-p', '9001', '-o', 'lstart=']],
    ['kill', ['-TERM', '9001']],
    ['ps', ['-p', '9001', '-o', 'command=']],
    ['defaults', ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'true']],
  ]);
});

test('comments reject a pre-existing Simulator before changing preferences', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    return { status: 0, stdout: '9001\n', stderr: '' };
  };
  let ran = false;
  assert.throws(
    () => withSoftwareKeyboard(
      () => { ran = true; },
      command,
      { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' },
      () => {},
    ),
    /pre-existing Simulator/,
  );
  assert.equal(ran, false);
  // The identity read is the only thing allowed between the probe and the refusal: adoption has to
  // learn WHICH Simulator this is before it can reject it. The property this test exists for is that
  // no PREFERENCE is touched on the refusal path, so it is asserted directly rather than implied by
  // an exact call list that now legitimately contains a second read.
  assert.deepEqual(calls, [['pgrep', ['-x', 'Simulator']], ['ps', ['-p', '9001', '-o', 'command=']]]);
  assert.equal(calls.some(([name]) => name === 'defaults'), false);
});

// LAYER 16. The three tests below are one set: an acceptance and its two refusals, built on the SAME
// fixture shape so the acceptance cannot pass vacuously. Only the identity string differs between the
// first two, which is exactly the value adoption is supposed to be deciding on.
test('comments adopt a pre-existing Simulator surface bound to the exact gate UDID', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') return { status: 0, stdout: '9001\n', stderr: '' };
    if (name === 'ps') return { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let ownership;
  let callsWhenScenarioRan = -1;
  withSoftwareKeyboard(
    (environment) => { ownership = environment; callsWhenScenarioRan = calls.length; },
    command,
    { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' },
    () => {},
  );
  assert.equal(ownership.PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_PID, '9001');
  assert.equal(ownership.PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_UDID, 'SIM-EXACT');
  // Never launches: under the gate sandbox `open` is denied outright, which is the entire reason
  // adoption exists. A version that still launched would satisfy every other assertion here.
  assert.equal(calls.some(([name]) => name === 'open'), false);
  // Never terminates a surface it did not create — the launcher that made it reaps it.
  assert.equal(calls.some(([name]) => name === 'kill'), false);
  // THE TEARDOWN BLOCK MUST NOT RUN AT ALL, asserted as an exact count rather than as "no kill
  // happened". Mutation-found: with `launched` wrongly set on this path the block DOES run and still
  // issues no kill, because it refuses a PID whose start time it never captured — so a no-kill
  // assertion passes for entirely the wrong reason and the layer-17 property goes unpinned. After the
  // scenario returns, the only remaining command is the single preference restore.
  assert.equal(calls.length - callsWhenScenarioRan, 1);
  assert.deepEqual(calls.at(-1), ['defaults', ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'true']]);
  // The keyboard preference is still forced and still restored, because adoption changes who owns the
  // process, not what this function guarantees about the preference.
  assert.deepEqual(calls.filter(([name]) => name === 'defaults').map(([, args]) => args), [
    ['read', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard'],
    ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'false'],
    ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'true'],
  ]);
});

test('comments refuse to adopt a pre-existing Simulator bound to another UDID', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') return { status: 0, stdout: '9001\n', stderr: '' };
    if (name === 'ps') return { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-OTHER\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let ran = false;
  assert.throws(
    () => withSoftwareKeyboard(() => { ran = true; }, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /pre-existing Simulator/,
  );
  assert.equal(ran, false);
  assert.equal(calls.some(([name]) => name === 'defaults'), false);
});

test('comments refuse to adopt an ambiguous set of pre-existing Simulator processes', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') return { status: 0, stdout: '9001\n9002\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let ran = false;
  assert.throws(
    () => withSoftwareKeyboard(() => { ran = true; }, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /pre-existing Simulator/,
  );
  assert.equal(ran, false);
  // Refused on cardinality alone — it never even asks which process it is.
  assert.deepEqual(calls, [['pgrep', ['-x', 'Simulator']]]);
});

// DENIAL AS TRIGGER. Under the gate sandbox the launch is denied, and that denial is the signal the
// launcher waits for. These five share one fixture and differ ONLY in what the wait observes, and each
// asserts its OWN message: a control that passes on a neighbour's string leaves the property it exists
// to pin unproven, which has already happened once in this lane's instruments.
const denialFixture = ({ pgrep, ps }) => {
  const calls = [];
  let probes = 0;
  const command = (name, args) => {
    calls.push([name, args]);
    // Probe 1 is the ENTRY check, and it must show no surface or the function adopts before it ever
    // reaches the launch. The launcher only creates one in response to the denial, so "nothing at entry,
    // something afterwards" is the real sequence and every shape below starts from it.
    if (name === 'pgrep') { probes += 1; return probes === 1 ? { status: 1, stdout: '', stderr: '' } : pgrep(probes); }
    if (name === 'open') return { status: 1, stdout: '', stderr: 'LSOpen denied (-54)' };
    if (name === 'ps') return ps();
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, command };
};
const simulatorLine = (udid) => ({ status: 0, stdout: `/Applications/Xcode.app/Simulator -CurrentDeviceUDID ${udid}\n`, stderr: '' });

test('a denied launch waits for the launcher and adopts the surface it provides', () => {
  const { calls, command } = denialFixture({
    pgrep: () => ({ status: 0, stdout: '9001\n', stderr: '' }),
    ps: () => simulatorLine('SIM-EXACT'),
  });
  let ownership;
  withSoftwareKeyboard((environment) => { ownership = environment; }, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {});
  assert.equal(ownership.PENTACLE_REPORT_VIEWER_OWNED_SIMULATOR_PID, '9001');
  // Still never terminates a surface it did not create, so layer 17 stays shut on this path too.
  assert.equal(calls.some(([name]) => name === 'kill'), false);
  // The launch WAS attempted first: outside the sandbox it succeeds and this wait never runs at all.
  assert.equal(calls.some(([name]) => name === 'open'), true);
});

test('a denied launch with no surface ever appearing names that exact cause', () => {
  const { command } = denialFixture({ pgrep: () => ({ status: 1, stdout: '', stderr: '' }), ps: () => simulatorLine('SIM-EXACT') });
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /no exact-UDID Simulator surface appeared after launch was denied/,
  );
});

test('a denied launch answered by a foreign-UDID surface names that exact cause', () => {
  const { command } = denialFixture({
    pgrep: () => ({ status: 0, stdout: '9001\n', stderr: '' }),
    ps: () => simulatorLine('SIM-OTHER'),
  });
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /Simulator surface appeared but is not bound to the exact gate UDID/,
  );
});

test('a denied launch answered by an unreadable surface names that exact cause', () => {
  const { command } = denialFixture({
    pgrep: () => ({ status: 0, stdout: '9001\n', stderr: '' }),
    ps: () => ({ status: 1, stdout: '', stderr: '' }),
  });
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /Simulator surface appeared but its identity was unreadable/,
  );
});

test('a denied launch answered by more than one surface names that exact cause', () => {
  const { command } = denialFixture({
    pgrep: () => ({ status: 0, stdout: '9001\n9002\n', stderr: '' }),
    ps: () => simulatorLine('SIM-EXACT'),
  });
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /ambiguous Simulator surfaces appeared after launch was denied/,
  );
});

// LAYER 17 INSTRUMENTATION. The adoption path has never executed in this program's history, so the claim
// that it skips teardown is reasoned and test-pinned, never observed. When it first executes, that must be
// readable from an artefact rather than inferred from the absence of a kernel denial - so the report is
// unconditional and names the mode. All three modes are pinned here, because a report that only fires on
// success cannot distinguish "adopted and skipped cleanup" from "never got there".
test('every mode reports positively whether cleanup ran and whether a kill was attempted', () => {
  const modes = [];
  // adopted, via the denial trigger
  const denied = denialFixture({ pgrep: () => ({ status: 0, stdout: '9001\n', stderr: '' }), ps: () => simulatorLine('SIM-EXACT') });
  withSoftwareKeyboard(() => {}, denied.command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}, () => {}, (m) => modes.push(m));
  assert.equal(modes[0], 'mode=adopted pid=9001 cleanup_block=skipped kill_attempted=no');

  // launched, the ordinary standalone path: cleanup DOES run and a kill IS attempted
  let pgrepCalls = 0;
  let psCalls = 0;
  const launchCommand = (name, args) => {
    if (name === 'pgrep') { const status = [1, 0, 1][pgrepCalls++]; return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' }; }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ < 2 ? simulatorLine('SIM-EXACT') : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const launchedModes = [];
  withSoftwareKeyboard(() => {}, launchCommand, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}, () => {}, (m) => launchedModes.push(m));
  assert.equal(launchedModes[0], 'mode=launched pid=9001 cleanup_block=ran kill_attempted=yes');

  // The two modes must not report the same thing, or the instrument proves nothing about which ran.
  assert.notEqual(modes[0], launchedModes[0]);
});

test('the four denied-launch refusals are mutually distinguishable', () => {
  // The property, asserted directly. Four separate assert.throws above would all still pass if the
  // implementation collapsed them into one shared string, which is exactly the _element_frames defect.
  const messages = new Set();
  const cases = [
    { pgrep: () => ({ status: 1, stdout: '', stderr: '' }), ps: () => simulatorLine('SIM-EXACT') },
    { pgrep: () => ({ status: 0, stdout: '9001\n', stderr: '' }), ps: () => simulatorLine('SIM-OTHER') },
    { pgrep: () => ({ status: 0, stdout: '9001\n', stderr: '' }), ps: () => ({ status: 1, stdout: '', stderr: '' }) },
    { pgrep: () => ({ status: 0, stdout: '9001\n9002\n', stderr: '' }), ps: () => simulatorLine('SIM-EXACT') },
  ];
  for (const shape of cases) {
    const { command } = denialFixture(shape);
    try { withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}); }
    catch (error) { messages.add(error.message); }
  }
  assert.equal(messages.size, 4);
});

test('comments reject a Simulator surface bound to the wrong UDID', () => {
  let pgrepCalls = 0;
  let psCalls = 0;
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0, 1][pgrepCalls++];
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ < 2
      ? { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-WRONG\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  let ran = false;
  assert.throws(
    () => withSoftwareKeyboard(
      () => { ran = true; },
      command,
      { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' },
      () => {},
    ),
    /not bound to the exact gate UDID/,
  );
  assert.equal(ran, false);
  assert.deepEqual(calls.filter(([name]) => name === 'kill'), [['kill', ['-TERM', '9001']]]);
});

test('comments require the exact bound simulator before changing preferences', () => {
  let commandCalled = false;
  assert.throws(
    () => withSoftwareKeyboard(
      () => {},
      () => { commandCalled = true; return { status: 0, stdout: '', stderr: '' }; },
      {},
      () => {},
    ),
    /bound simulator UDID/,
  );
  assert.equal(commandCalled, false);
});

test('comments restore preferences when exact Simulator launch fails', () => {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') return { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '0\n', stderr: '' };
    if (name === 'open') return { status: 1, stdout: '', stderr: 'launch failed' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    // A denied launch is now the TRIGGER: it waits for the launcher, and only when nothing arrives does
    // it fail - with the more specific cause. The property this test exists for is unchanged and still
    // asserted below: a failed launch must still restore the preference it changed.
    /no exact-UDID Simulator surface appeared after launch was denied/,
  );
  assert.deepEqual(calls.filter(([name]) => name === 'defaults').at(-1)[1], ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'false']);
});

test('comments fail when owned Simulator PID termination fails and still restore preferences', () => {
  let pgrepCalls = 0;
  let psCalls = 0;
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0][pgrepCalls++] ?? 0;
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ < 2
      ? { status: 0, stdout: '/Applications/Xcode.app/Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    if (name === 'kill') return { status: 1, stdout: '', stderr: 'terminate failed' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /could not terminate owned Simulator process/,
  );
  assert.deepEqual(calls.filter(([name]) => name === 'defaults').at(-1)[1], ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'true']);
});

test('Simulator command identity requires exact UDID argv token and value', () => {
  assert.equal(commandHasExactArgumentPair('Simulator -CurrentDeviceUDID SIM-EXACT', '-CurrentDeviceUDID', 'SIM-EXACT'), true);
  assert.equal(commandHasExactArgumentPair('Simulator -CurrentDeviceUDID SIM-EXACT-SUFFIX', '-CurrentDeviceUDID', 'SIM-EXACT'), false);
  assert.equal(commandHasExactArgumentPair('Simulator --note=-CurrentDeviceUDID SIM-EXACT', '-CurrentDeviceUDID', 'SIM-EXACT'), false);
});

test('comments WARN (not fail the gate) when the owned PID is reused before cleanup, and never signal it', () => {
  let pgrepCalls = 0;
  let startCalls = 0;
  const calls = [];
  const warnings = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0][pgrepCalls++] ?? 0;
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return {
      status: 0,
      stdout: startCalls++ === 0 ? 'Wed Jul 15 12:00:00 2026\n' : 'Wed Jul 15 12:01:00 2026\n',
      stderr: '',
    };
    if (name === 'ps') return { status: 0, stdout: 'Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  // A benign identity churn (stale prior-run clutter) must no longer fail the gate: the scenario
  // succeeds, the guard safely declines to signal the unverifiable PID, and it is only warned.
  assert.doesNotThrow(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}, (message) => warnings.push(message)),
  );
  assert.equal(calls.some(([name]) => name === 'kill'), false);
  assert.match(warnings.join('\n'), /reused or unverified Simulator PID/);
  assert.deepEqual(calls.filter(([name]) => name === 'defaults').at(-1)[1], ['write', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard', '-bool', 'true']);
});

test('comments safely clean a launch discovered only after readiness validation fails', () => {
  let pgrepCalls = 0;
  let psCalls = 0;
  const calls = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const responses = [
        { status: 1, stdout: '' },
        { status: 2, stdout: '' },
        { status: 0, stdout: '9001\n' },
      ];
      return { ...responses[pgrepCalls++], stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' };
    if (name === 'ps') return psCalls++ === 0
      ? { status: 0, stdout: 'Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}),
    /could not probe Simulator surface readiness/,
  );
  assert.deepEqual(calls.filter(([name]) => name === 'kill'), [['kill', ['-TERM', '9001']]]);
  assert.equal(calls.filter(([name, args]) => name === 'ps' && args.at(-1) === 'lstart=').length, 2);
});

test('comments never signal a rediscovered PID whose start identity changes, and warn (not double-fail) on it', () => {
  let pgrepCalls = 0;
  let startCalls = 0;
  const calls = [];
  const warnings = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const responses = [
        { status: 1, stdout: '' },
        { status: 2, stdout: '' },
        { status: 0, stdout: '9001\n' },
      ];
      return { ...responses[pgrepCalls++], stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') return {
      status: 0,
      stdout: startCalls++ === 0 ? 'Wed Jul 15 12:00:00 2026\n' : 'Wed Jul 15 12:01:00 2026\n',
      stderr: '',
    };
    if (name === 'ps') return { status: 0, stdout: 'Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  // The genuine failure here is the readiness-probe error (primaryError). The cleanup identity
  // churn must NOT be piled on as a second failure: it is warned, never signalled, and the surfaced
  // error is exactly the primary readiness failure — not an AggregateError with the benign refusal.
  assert.throws(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}, (message) => warnings.push(message)),
    /could not probe Simulator surface readiness/,
  );
  assert.equal(calls.some(([name]) => name === 'kill'), false);
  assert.match(warnings.join('\n'), /reused or unverified Simulator PID/);
});

test('teardown treats an owned PID that exits between command= and lstart= as STOPPED, never a flake', () => {
  let pgrepCalls = 0;
  let lstartCalls = 0;
  const calls = [];
  const warnings = [];
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep') {
      const status = [1, 0][pgrepCalls++] ?? 0;
      return { status, stdout: status === 0 ? '9001\n' : '', stderr: '' };
    }
    if (name === 'ps' && args.at(-1) === 'lstart=') {
      // readiness (0) and the pre-kill start check (1) see a stable start so the kill proceeds;
      // the post-kill exit-confirm start read (2) finds the row already gone — the TOCTOU exit.
      return lstartCalls++ < 2
        ? { status: 0, stdout: 'Wed Jul 15 12:00:00 2026\n', stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    }
    if (name === 'ps') return { status: 0, stdout: 'Simulator -CurrentDeviceUDID SIM-EXACT\n', stderr: '' };
    if (name === 'defaults' && args[0] === 'read') return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  // The kill-TERM'd owned PID vanishing between the two ps calls is a benign, successful
  // termination — it must neither warn nor fail the case.
  assert.doesNotThrow(
    () => withSoftwareKeyboard(() => {}, command, { PENTACLE_GATE_BOUND_SIMULATOR_UDID: 'SIM-EXACT' }, () => {}, (message) => warnings.push(message)),
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(calls.filter(([name]) => name === 'kill'), [['kill', ['-TERM', '9001']]]);
});

test('help and unknown arguments cannot launch a scenario or create gate artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-viewer-cli-'));
  const artifactDir = path.join(root, 'artifacts');
  const spawnMarker = path.join(root, 'python-spawned');
  const python = path.join(root, 'python3');
  fs.writeFileSync(python, '#!/bin/sh\ntouch "$PENTACLE_QA_PYTHON_MARKER"\nexit 99\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    PENTACLE_GATE_ARTIFACT_DIR: artifactDir,
    PENTACLE_QA_PYTHON_MARKER: spawnMarker,
  };
  try {
    const help = spawnSync(process.execPath, [path.join(__dirname, 'report-viewer-sim-e2e.cjs'), '--help'], { env, encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage:/);
    assert.equal(fs.existsSync(spawnMarker), false);
    assert.equal(fs.existsSync(artifactDir), false);

    const unknown = spawnSync(process.execPath, [path.join(__dirname, 'report-viewer-sim-e2e.cjs'), '--definitely-unknown'], { env, encoding: 'utf8' });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unsupported argument/);
    assert.equal(fs.existsSync(spawnMarker), false);
    assert.equal(fs.existsSync(artifactDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function payload(runId, source = 'console.error', fatal = false) {
  return {
    verdict: 'FAIL',
    all_events: [{
      message: 'harness:runtime_error',
      data: { scenario_run_id: runId, source, fatal, detail: 'runtime sentinel console_error', stack: 'Error: runtime sentinel console_error\n at test' },
    }],
    raw_log_sidecar: 'runtime.applog',
    result: { extras: { runtime_monitor: {
      settle_s: 2.5,
      fresh_crash_report: null,
      crash_exit_signal: null,
      liveness: { returncode: 0, bundle_present: true, stderr: '', checked_at: 1, completed_at: 2, resolved_bundle_id: 'com.example.pentacle', resolved_pids: ['431'] },
      process_identity: { verified: true, bundle_id: 'com.example.pentacle', launch_pid: '431', armed_telemetry_pid: '431', pre_scenario_pids: ['431'] },
      outcome: { kind: 'live', pids: ['431'] },
      owned_termination: null,
    } } },
  };
}

// A crash is proven by the simulator's own PID-exact SIGABRT exit signal, never by the host .ips
// (macOS throttles/dedups repeat crash reports and the harness reaps the ones it causes).
const CRASH_SIGNAL = Object.freeze({
  verified: true,
  pid: '431',
  signal: 'SIGABRT',
  source: 'simulator_unified_log',
  evidence: 'launchd_sim: [UIKitApplication:com.example.pentacle [431]:] exited due to SIGABRT',
});

function monitorOnlyPayload({ crashSignal = null, crash = null, bundlePresent = false } = {}) {
  const crashOnly = crashSignal !== null;
  return {
    verdict: 'FAIL',
    all_events: [],
    raw_log_sidecar: 'runtime.applog',
    result: { extras: { runtime_monitor: {
      settle_s: 2.5,
      fresh_crash_report: crash,
      crash_exit_signal: crashSignal,
      liveness: { returncode: 0, bundle_present: bundlePresent, stderr: '', checked_at: 1, completed_at: 2, resolved_bundle_id: 'com.example.pentacle', resolved_pids: bundlePresent ? ['431'] : [] },
      process_identity: { verified: true, bundle_id: 'com.example.pentacle', launch_pid: '431', armed_telemetry_pid: '431', pre_scenario_pids: ['431'] },
      outcome: { kind: crashOnly ? 'harness_owned_crash' : 'harness_owned_termination', pids: [] },
      owned_termination: crashOnly ? 'crash_only' : 'liveness_loss',
    } } },
  };
}

test('crash-only and liveness-loss sentinels require independent expected-red monitor evidence', () => {
  const crash = monitorOnlyPayload({ crashSignal: CRASH_SIGNAL });
  assert.deepEqual(validateSentinelResult(crash, {
    runId: 'crash-run', sentinel: 'crash_only', expected: { kind: 'crash' },
  }), []);
  assert.throws(() => validateSentinelResult(monitorOnlyPayload(), {
    runId: 'crash-run', sentinel: 'crash_only', expected: { kind: 'crash' },
  }), /crash-only/);

  assert.deepEqual(validateSentinelResult(monitorOnlyPayload(), {
    runId: 'liveness-run', sentinel: 'liveness_loss', expected: { kind: 'liveness' },
  }), []);
  const productExit = monitorOnlyPayload();
  productExit.result.extras.runtime_monitor.owned_termination = null;
  productExit.result.extras.runtime_monitor.outcome.kind = 'crashless_product_exit';
  assert.throws(() => validateSentinelResult(productExit, {
    runId: 'liveness-run', sentinel: 'liveness_loss', expected: { kind: 'liveness' },
  }), /liveness-loss/);
  assert.throws(() => validateSentinelResult(crash, {
    runId: 'liveness-run', sentinel: 'liveness_loss', expected: { kind: 'liveness' },
  }), /liveness-loss/);
});

test('liveness-loss FAILS when the launched PID actually crashed, with the signal as the ONLY discriminator', () => {
  // Node-layer guard for the clean-termination proof (mirror of the crash-only signal test).
  // The payload is otherwise PERFECT liveness_loss evidence — owned_termination=liveness_loss,
  // outcome=harness_owned_termination, bundle_present=false, no runtime errors — and
  // fresh_crash_report is null (the depleted state). So `crash_exit_signal !== null` is the only
  // check that can reject it: swap that back to the fresh_crash_report form and this test fails,
  // which is exactly the silent regression this covers.
  const crashedButClaimsClean = monitorOnlyPayload();
  const monitor = crashedButClaimsClean.result.extras.runtime_monitor;
  monitor.crash_exit_signal = CRASH_SIGNAL;
  assert.equal(monitor.fresh_crash_report, null, 'depleted state: no host report to discriminate on');
  assert.equal(monitor.owned_termination, 'liveness_loss');
  assert.equal(monitor.outcome.kind, 'harness_owned_termination');
  assert.throws(() => validateSentinelResult(crashedButClaimsClean, {
    runId: 'liveness-run', sentinel: 'liveness_loss', expected: { kind: 'liveness' },
  }), /liveness-loss/);
});

test('crash-only passes with NO host .ips (OS-throttled) but still demands a positive PID-exact SIGABRT proof', () => {
  // The depleted/throttled state QA certifies in: fresh_crash_report is null, yet the crash is
  // still positively proven by the simulator's own exit signal.
  const depleted = monitorOnlyPayload({ crashSignal: CRASH_SIGNAL, crash: null });
  assert.deepEqual(validateSentinelResult(depleted, {
    runId: 'crash-run', sentinel: 'crash_only', expected: { kind: 'crash' },
  }), []);

  // NOT a bare "tolerate absent .ips": with neither a report nor a signal it must still fail,
  // so a genuine detection failure can never pass.
  assert.throws(() => validateSentinelResult(monitorOnlyPayload({ crash: null }), {
    runId: 'crash-run', sentinel: 'crash_only', expected: { kind: 'crash' },
  }), /crash-only/);

  // A .ips alone (no verified signal) is not sufficient either.
  assert.throws(() => validateSentinelResult(monitorOnlyPayload({ crash: { path: '/tmp/x.ips' } }), {
    runId: 'crash-run', sentinel: 'crash_only', expected: { kind: 'crash' },
  }), /crash-only/);
});

test('crash-only rejects an unverified, wrong-signal, wrong-PID, or evidence-less crash signal', () => {
  const cases = [
    { verified: false },                                   // not verified
    { signal: 'SIGKILL' },                                 // wrong signal (clean kill, not a crash)
    { pid: '999' },                                        // a DIFFERENT process crashed, not ours
    { evidence: '' },                                      // no supporting log line
  ];
  for (const override of cases) {
    const bad = monitorOnlyPayload({ crashSignal: { ...CRASH_SIGNAL, ...override } });
    assert.throws(() => validateSentinelResult(bad, {
      runId: 'crash-run', sentinel: 'crash_only', expected: { kind: 'crash' },
    }), /crash-only/, `expected rejection for ${JSON.stringify(override)}`);
  }
});

test('expected-red validation requires source, fatal flag, stack, run ID, and runtime monitor', () => {
  assert.equal(validateSentinelResult(payload('run-1'), {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }).length, 1);
  assert.throws(() => validateSentinelResult(payload('foreign'), {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }), /run-filtered/);
  assert.throws(() => validateSentinelResult({ ...payload('run-1'), verdict: 'SETUP_FAIL' }, {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }), /not expected-red/);
  const unrelated = payload('run-1');
  unrelated.all_events[0].data.detail = 'different console failure';
  unrelated.all_events[0].data.stack = 'Error: different console failure';
  assert.throws(() => validateSentinelResult(unrelated, {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }), /run-filtered/);
  const emptyMonitor = payload('run-1');
  emptyMonitor.result.extras.runtime_monitor = {};
  assert.throws(() => validateSentinelResult(emptyMonitor, {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }), /runtime-monitor/);
  for (const invalidSettle of [Infinity, 1e9]) {
    const invalid = payload('run-1');
    invalid.result.extras.runtime_monitor.settle_s = invalidSettle;
    assert.throws(() => validateSentinelResult(invalid, {
      runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
    }), /runtime-monitor/);
  }
  const blankRawLog = payload('run-1');
  blankRawLog.raw_log_sidecar = '   ';
  assert.throws(() => validateSentinelResult(blankRawLog, {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }), /runtime-monitor/);
  const mismatchedIdentity = payload('run-1');
  mismatchedIdentity.result.extras.runtime_monitor.process_identity.armed_telemetry_pid = '432';
  assert.throws(() => validateSentinelResult(mismatchedIdentity, {
    runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
  }), /runtime-monitor/);
  for (const missingField of ['checked_at', 'completed_at', 'resolved_bundle_id', 'resolved_pids']) {
    const missingLookupEvidence = payload('run-1');
    delete missingLookupEvidence.result.extras.runtime_monitor.liveness[missingField];
    assert.throws(() => validateSentinelResult(missingLookupEvidence, {
      runId: 'run-1', sentinel: 'console_error', expected: { source: 'console.error', fatal: false },
    }), /runtime-monitor/);
  }
});

test('fatal expected-red requires exact-PID release and runtime-error evidence', () => {
  const fatal = payload('run-fatal', 'uncaught', true);
  const runtimeError = fatal.all_events.find((event) => event.message === 'harness:runtime_error');
  runtimeError.data.detail = 'runtime sentinel fatal';
  runtimeError.data.stack = 'Error: runtime sentinel fatal\n at test';
  fatal.result.extras.runtime_monitor.post_identity_release = {
    verified: true,
    transport: 'loopback_ack',
    sentinel: 'fatal',
    scenario_run_id: 'run-fatal',
    telemetry_pid: '431',
  };
  fatal.result.extras.runtime_monitor.fatal_runtime_error_identity = {
    verified: true,
    sentinel: 'fatal',
    scenario_run_id: 'run-fatal',
    telemetry_pid: '431',
  };
  assert.equal(validateSentinelResult(fatal, {
    runId: 'run-fatal', sentinel: 'fatal', expected: { source: 'uncaught', fatal: true },
  }).length, 1);

  const missingRelease = structuredClone(fatal);
  missingRelease.result.extras.runtime_monitor.post_identity_release = null;
  assert.throws(() => validateSentinelResult(missingRelease, {
    runId: 'run-fatal', sentinel: 'fatal', expected: { source: 'uncaught', fatal: true },
  }), /release and runtime-error evidence/);

  const wrongPid = structuredClone(fatal);
  wrongPid.result.extras.runtime_monitor.post_identity_release.telemetry_pid = '432';
  assert.throws(() => validateSentinelResult(wrongPid, {
    runId: 'run-fatal', sentinel: 'fatal', expected: { source: 'uncaught', fatal: true },
  }), /release and runtime-error evidence/);

  const missingErrorIdentity = structuredClone(fatal);
  missingErrorIdentity.result.extras.runtime_monitor.fatal_runtime_error_identity = null;
  assert.throws(() => validateSentinelResult(missingErrorIdentity, {
    runId: 'run-fatal', sentinel: 'fatal', expected: { source: 'uncaught', fatal: true },
  }), /release and runtime-error evidence/);
});
