'use strict';

// A COMPLETE evidence tree, of either outcome, built without a simulator.
//
// It exists because finalizeScratchDiscard runs the REAL validateEvidence and writeManifest: a
// lifecycle demonstration that reaches publication needs a tree those two accept, and a hand-built
// approximation would fail on some field and send the next reader hunting the lifecycle for a fixture
// bug. Nothing here is capability-bound - it writes only where it is told and mutates no state, no
// container, and no journal.
//
// Every value that the validators COMPARE is derived from the wrapper's own constants
// (REPORT_VIEWER_CASE_PLAN, the certified stage list) rather than restated, so a stage or case-plan
// change cannot leave this fixture quietly building a tree that no longer models a real run. Values
// the validators only range-check (digests, pids, log bodies) are literals.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The certified gate's twelve stages, in order. Deliberately a copy and NOT read from
// storage-gate.cjs: validateCertifiedStages asserts against its own copy, so a fixture that imported
// that copy would agree with it by construction and prove nothing about stage-order drift.
const STAGES = Object.freeze([
  'focused-jest', 'serial-jest', 'typecheck', 'ios-export', 'release-sim-bootstatus', 'release-sim-build',
  'release-sim-reset', 'release-sim-install', 'release-sim-launch', 'release-sim-settle',
  'release-sim-liveness', 'sim-e2e',
]);

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function writeJson(target, value) { fs.writeFileSync(target, `${JSON.stringify(value)}\n`); }

// The nine single-attempt results, their videos, and the manifest that binds them. `now` is passed in
// rather than read here so a caller can build a tree at a fixed instant; the video time binding admits
// a 2-second window either side, which is what the +/- 1000 ms below sits inside.
function writeReportViewerRun(root, casePlan, now) {
  const runs = path.join(root, 'report-viewer-sim-e2e');
  fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
  const cases = [];
  for (const [index, [scenario, sentinel, expected]] of casePlan.entries()) {
    const passing = expected === 'PASS';
    const result = `case-${index}.json`;
    const video = `case-${index}.mp4`;
    const videoFile = path.join(runs, video);
    fs.writeFileSync(videoFile, `video-${index}\n`);
    fs.utimesSync(videoFile, new Date(now), new Date(now));
    writeJson(path.join(runs, result), {
      scenario,
      verdict: passing ? 'PASS' : 'FAIL',
      artifacts: { video },
      extras: {
        screen_capture: {
          video_ready: true, video_returncode: 0, video_finalized: true, video_forced_kill: false,
          video_alive_after_teardown: false,
          video_started_at: (now - 1000) / 1000, video_finished_at: (now + 1000) / 1000,
        },
      },
    });
    cases.push({
      scenario, ...(sentinel ? { sentinel } : {}), run_id: `case-run-${index}`, expected,
      status: passing ? 0 : 1, result, sha256: digest(path.join(runs, result)),
    });
  }
  writeJson(path.join(runs, 'manifest.json'), {
    status: 'passed', attempts_per_case: 1,
    recorder_preflight: { setup_verdict: 'PASS', outcome: 'clear' },
    cases,
  });
}

// `stageCount` is the number of completed stages before failure. full-gate.cjs writes stage N's JSON
// and log before runGate throws, while main pushes only returned entries into summary.gates. The honest
// failed shape is therefore N+1 stage-file pairs against N summary entries. A failed tree with all twelve
// stages green, or with no companion for the failed stage, is unrepresentable.
//
// storage-surface-trigger.json is deliberately NOT written: runFullGate's cleanup writes it on every
// path, and a fixture copy would either be overwritten (dead bytes) or, if cleanup were skipped, hide
// the fact that the wrapper is the thing that must produce it.
function writeEvidenceTree(root, {
  gateStatus,
  casePlan,
  candidateSha = 'a'.repeat(40),
  gateCodeSha = 'b'.repeat(40),
  now = Date.parse('2026-07-23T00:00:00.000Z'),
  stageCount = 3,
} = {}) {
  if (!Number.isInteger(gateStatus)) throw new Error('EVIDENCE_FIXTURE_GATE_STATUS');
  const passed = gateStatus === 0;
  if (!passed && (!Number.isInteger(stageCount) || stageCount < 0 || stageCount >= STAGES.length)) throw new Error('EVIDENCE_FIXTURE_FAILED_STAGE_RANGE');
  const stages = passed ? STAGES : STAGES.slice(0, stageCount);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // NEVER overwritten. On a real evidence volume this file is the CONTAINER MARKER that carries the
  // seal resolveMounted validates, and it is also one of the four files validateEvidence requires -
  // one file answering to two contracts. A fixture that stamped its own placeholder over a real
  // marker would break the seal it needs and report it as an evidence error.
  const marker = path.join(root, '.pentacle-container.json');
  if (!fs.existsSync(marker)) writeJson(marker, { schema: 1, kind: 'evidence' });
  writeJson(path.join(root, 'native-root.json'), {
    candidate_sha: candidateSha, derived_sha: 'b'.repeat(40), parent_sha: candidateSha, derived_paths: [],
  });
  const gates = stages.map((name, index) => {
    const started = new Date(now + index * 1000).toISOString();
    const finished = new Date(now + index * 1000 + 500).toISOString();
    const entry = { name, command: `npm run gate:${name}`, status: 0, started_at: started, finished_at: finished, log: `${name}.log` };
    fs.writeFileSync(path.join(root, `${name}.log`), `${name} completed\n`);
    writeJson(path.join(root, `${name}.json`), entry);
    return entry;
  });
  if (!passed) {
    const name = STAGES[stageCount];
    const started = new Date(now + stageCount * 1000).toISOString();
    const finished = new Date(now + stageCount * 1000 + 500).toISOString();
    const failed = { name, command: `npm run gate:${name}`, status: gateStatus, started_at: started, finished_at: finished, log: `${name}.log` };
    fs.writeFileSync(path.join(root, failed.log), `${name} failed\n`);
    writeJson(path.join(root, `${name}.json`), failed);
  }
  writeJson(path.join(root, 'run.json'), {
    status: passed ? 'passed' : 'failed', gates, sha: candidateSha, candidate_sha: candidateSha,
    gate_code_sha: gateCodeSha, gate_code_tree_clean: true,
  });
  // Only a passed run must carry the nine cases; a failed one may legitimately have died before the
  // recorder ran, and building the directory anyway would assert a stricter precondition than the
  // wrapper does.
  if (passed) writeReportViewerRun(root, casePlan, now);
  return root;
}

module.exports = Object.freeze({ STAGES, writeEvidenceTree, writeReportViewerRun });
