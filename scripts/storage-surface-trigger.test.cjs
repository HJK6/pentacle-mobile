'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const surfaceTrigger = require('./storage-surface-trigger.cjs');
const { createCaseCompletionTrigger, reportViewerResultCount } = surfaceTrigger;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/storage-surface-trigger-'));
  const runs = path.join(root, 'report-viewer-sim-e2e');
  fs.mkdirSync(runs);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runs };
}

function scheduler() {
  const state = { callback: null, delay: null, cancelled: 0, unrefed: false };
  return {
    state,
    schedule(callback, delay) {
      state.callback = callback;
      state.delay = delay;
      return { unref() { state.unrefed = true; } };
    },
    cancel() { state.cancelled += 1; },
  };
}

test('case-result counting is rooted in wrapper evidence and excludes the manifest', (t) => {
  const { root, runs } = fixture(t);
  fs.writeFileSync(path.join(runs, 'case-1.json'), '{}\n');
  fs.writeFileSync(path.join(runs, 'case-2.json'), '{}\n');
  fs.writeFileSync(path.join(runs, 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(runs, 'case-2.mp4'), 'video');
  fs.writeFileSync(path.join(runs, 'case-1.teardown.json'), '{}\n');
  fs.writeFileSync(path.join(runs, 'case-2.teardown.json'), '{}\n');
  assert.equal(reportViewerResultCount(root), 2);
});

test('evidence and diagnostic scratch roots are alternatives, never an additive false trigger', (t) => {
  const { runs } = fixture(t);
  const scratchRuns = fs.realpathSync(fs.mkdtempSync('/tmp/storage-surface-trigger-scratch-'));
  t.after(() => fs.rmSync(scratchRuns, { recursive: true, force: true }));
  for (let index = 1; index <= 2; index += 1) fs.writeFileSync(path.join(runs, `case-${index}.json`), '{}\n');
  for (let index = 1; index <= 3; index += 1) fs.writeFileSync(path.join(scratchRuns, `case-${index}.json`), '{}\n');
  const clock = scheduler();
  const trigger = createCaseCompletionTrigger({
    resultDirectories: [runs, scratchRuns],
    requiredResults: 4,
    schedule: clock.schedule,
    cancel: clock.cancel,
    launch: () => assert.fail('counts from separate roots must not be added'),
  });
  clock.state.callback();
  assert.equal(trigger.observedResults, 3);
});

test('the host trigger ignores teardown sidecars and fires exactly once at primary case 8', (t) => {
  const { root, runs } = fixture(t);
  const clock = scheduler();
  const launches = [];
  const trigger = createCaseCompletionTrigger({
    evidenceRoot: root,
    requiredResults: 8,
    schedule: clock.schedule,
    cancel: clock.cancel,
    launch: () => { launches.push('launch'); return { pid: 8123 }; },
  });
  assert.equal(clock.state.unrefed, true);
  for (let index = 0; index < 8; index++) fs.writeFileSync(path.join(runs, `case-${index}.teardown.json`), '{}\n');
  for (let index = 1; index <= 7; index += 1) fs.writeFileSync(path.join(runs, `case-${index}.json`), '{}\n');
  clock.state.callback();
  assert.equal(launches.length, 0);
  assert.equal(trigger.observedResults, 7);
  fs.writeFileSync(path.join(runs, 'case-8.json'), '{}\n');
  clock.state.callback();
  clock.state.callback();
  assert.equal(launches.length, 1);
  assert.equal(clock.state.cancelled, 1);
  assert.equal(trigger.surface.pid, 8123);
  assert.equal(trigger.summary(), 'fired case_results=8 launched_pid=8123');
});

test('the host trigger reports reasoned inaction and preserves a failed launch for cleanup', (t) => {
  const { root, runs } = fixture(t);
  const clock = scheduler();
  const trigger = createCaseCompletionTrigger({
    evidenceRoot: root,
    requiredResults: 8,
    schedule: clock.schedule,
    cancel: clock.cancel,
    launch: () => { const error = new Error('launch-denied'); error.surface = { pid: 8124 }; throw error; },
  });
  for (let index = 1; index <= 8; index += 1) fs.writeFileSync(path.join(runs, `case-${index}.json`), '{}\n');
  clock.state.callback();
  assert.equal(trigger.surface.pid, 8124);
  assert.equal(trigger.summary(), 'fired case_results=8 failed=launch-denied');

  const quietClock = scheduler();
  const quiet = createCaseCompletionTrigger({ evidenceRoot: root, requiredResults: 9, schedule: quietClock.schedule, cancel: quietClock.cancel, launch: () => assert.fail('must not launch') });
  quiet.stop();
  assert.equal(quiet.summary(), 'skipped reason=case-results-incomplete observed=0 required=9');
});
