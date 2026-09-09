'use strict';

// LAYER 10 - the false green. An example wrapper exited 0 on a run whose journal recorded
// gate_status 1: the CLI's resolve handler wrote the result JSON and never set process.exitCode, so a
// verb that RESOLVED with a failing outcome reported success. GATE_RC=0 sat directly under a status:1
// line in the same log, at the SHA the lane was about to certify.
//
// These tests pin the general contract, not the one site. Every assertion that matters observes the
// REAL process exit status of a REAL storage-cli.cjs process (R2: the value the OS reports and the
// value the verb returned must be able to disagree, or the test cannot see which one is consulted).
// Every negative has a positive control, or a CLI that always exited non-zero would pass them all.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const CLI = path.join(__dirname, 'storage-cli.cjs');
const PRELOAD = path.join(__dirname, 'storage-cli-outcome-preload.cjs');
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const LOCK_TOKEN = 'b'.repeat(64);

// A MINIMAL environment, deliberately: the CLI's real rejectEnvironmentAuthority refuses inherited
// PENTACLE_GATE_* variables, and inheriting the runner's environment would make a rejection look like
// a wrong exit code.
function cli(argv, { result, thrown } = {}) {
  const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' };
  if (result !== undefined) env.STORAGE_CLI_OUTCOME_RESULT = JSON.stringify(result);
  if (thrown !== undefined) env.STORAGE_CLI_OUTCOME_THROW = JSON.stringify(thrown);
  return spawnSync(process.execPath, ['--require', PRELOAD, CLI, ...argv], { encoding: 'utf8', env });
}

test('a failed gate exits non-zero through the real CLI process', () => {
  // THE PIN. The result carries status 1; the assertion is on the exit status the OS reports. Before
  // the fix this ran green with a `1` in the payload and a `0` from the process.
  const failed = cli(['gate:full', RUN_ID, LOCK_TOKEN], { result: { run_id: RUN_ID, status: 1, evidence_digest: 'c'.repeat(64) } });
  assert.equal(failed.status, 1, failed.stderr);
  // The payload still reaches stdout on the failing path. A failed run's result is diagnostic, and the
  // documented flow reads gate:native-root's stdout with jq, so the stdout contract may not change with
  // the outcome.
  assert.equal(JSON.parse(failed.stdout).status, 1);

  // POSITIVE CONTROL - without it, a CLI hard-wired to exit 1 would satisfy every assertion above.
  const passed = cli(['gate:full', RUN_ID, LOCK_TOKEN], { result: { run_id: RUN_ID, status: 0, evidence_digest: 'c'.repeat(64) } });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, 0);
});

test('the CLI preserves the exact child status, not merely non-zero-ness', () => {
  // docs/PENTACLE_MOBILE_BUILD.md states that on every exit the supervisor preserves 0/nonzero/130/143.
  // That was true of the supervisor and false end to end, because the CLI discarded the value one
  // boundary later. 17 is the wrapper's own abnormal-exit code and 130/143 are SIGINT/SIGTERM.
  for (const status of [1, 17, 130, 143, 255]) {
    const run = cli(['gate:full', RUN_ID, LOCK_TOKEN], { result: { run_id: RUN_ID, status, evidence_digest: 'c'.repeat(64) } });
    assert.equal(run.status, status, `status ${status}: ${run.stderr}`);
  }
});

test('a janitor run that recorded errors exits non-zero', () => {
  // The SECOND live instance of the class, found by the enumerated sweep rather than by another false
  // green. runJanitor RESOLVES with report.errors populated - a per-run or per-ticket failure it caught
  // and recorded, or the JANITOR_DISABLED kill switch - and the LaunchAgent runs exactly this verb with
  // both streams at /dev/null, so this exit code is the only observable the scheduled janitor has.
  const failed = cli(['storage:janitor', 'apply'], { result: { schema: 1, mode: 'apply', entries: [], errors: [{ kind: 'run', id: RUN_ID, error: 'EVIDENCE_DISCARD_NOT_AUTHORIZED' }] } });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).errors.length, 1);

  const kill = cli(['storage:janitor', 'apply'], { result: { schema: 1, mode: 'apply', entries: [], errors: [{ kind: 'authority', id: 'kill-switch', error: 'JANITOR_DISABLED' }] } });
  assert.equal(kill.status, 1, kill.stderr);

  // POSITIVE CONTROL - a clean janitor run must still exit 0, or the LaunchAgent's only signal becomes
  // permanently red and stops meaning anything.
  const clean = cli(['storage:janitor', 'dry-run'], { result: { schema: 1, mode: 'dry-run', entries: [{ kind: 'run', id: RUN_ID, action: 'retain', reason: 'owner-live' }], errors: [] } });
  assert.equal(clean.status, 0, clean.stderr);
});

test('a rejected verb can never exit 0, whatever exit code it carries', () => {
  // The same defect from the other side. storage-gate.cjs attaches error.exitCode from a failed native
  // build and the reject handler propagates it, so an unvalidated propagated value is a real path: a
  // carried 0 would report success for a thrown error, and a carried 256 is masked to 0 by the OS.
  assert.equal(cli(['gate:native-root', 'HEAD'], { thrown: { message: 'NATIVE_BUILD_FAILED:0', exitCode: 0 } }).status, 1);
  assert.equal(cli(['gate:native-root', 'HEAD'], { thrown: { message: 'NATIVE_BUILD_FAILED:256', exitCode: 256 } }).status, 1);
  assert.equal(cli(['gate:native-root', 'HEAD'], { thrown: { message: 'NATIVE_BUILD_FAILED:-1', exitCode: -1 } }).status, 1);
  assert.equal(cli(['gate:native-root', 'HEAD'], { thrown: { message: 'BOOM' } }).status, 1);
  // POSITIVE CONTROL for propagation itself: a representable failure code is still honoured, so the
  // clamp above is a range check and not a blanket flattening to 1.
  const carried = cli(['gate:native-root', 'HEAD'], { thrown: { message: 'NATIVE_BUILD_FAILED:65', exitCode: 65 } });
  assert.equal(carried.status, 65);
  assert.match(carried.stderr, /NATIVE_BUILD_FAILED:65/);
});

test('a verb whose result cannot be classified fails closed and names why', () => {
  // Fix C's rule applied to this guard itself: it sits on the path that decides whether a run reports
  // success, so it may never fail without saying what it could not classify.
  const shapeless = cli(['gate:full', RUN_ID, LOCK_TOKEN], { result: { run_id: RUN_ID, evidence_digest: 'c'.repeat(64) } });
  assert.equal(shapeless.status, 1);
  assert.match(shapeless.stderr, /CLI_OUTCOME_UNREPRESENTABLE:gate:full:undefined/);

  const oversized = cli(['gate:full', RUN_ID, LOCK_TOKEN], { result: { run_id: RUN_ID, status: 256, evidence_digest: 'c'.repeat(64) } });
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /CLI_OUTCOME_UNREPRESENTABLE:gate:full:256/);

  const janitor = cli(['storage:janitor', 'apply'], { result: { schema: 1, mode: 'apply', entries: [] } });
  assert.equal(janitor.status, 1);
  assert.match(janitor.stderr, /CLI_OUTCOME_SHAPE:storage:janitor:/);
});

test('every verb that resolves with no outcome still exits 0', () => {
  // The THROWS_ONLY claim, exercised rather than asserted in a comment. These verbs signal failure by
  // throwing, so a resolution really is a success - and if one of them ever grows an outcome field, the
  // enumeration in the lane spec is where that gets answered, not here.
  const verbs = [
    ['storage:install', []], ['storage:update', []], ['gate:native-root', ['HEAD']],
    ['storage:recover-run', [RUN_ID]], ['storage:discard-scratch', [RUN_ID]], ['storage:discard-evidence', [RUN_ID]],
    ['storage:recover-system-scratch', [RUN_ID, '/tmp/owned-recovery-proof.json']],
    ['storage:register-worktree', ['pentacle-mobile', 'spec_x', 'lane']], ['storage:retire-worktree', [RUN_ID]],
    ['storage:restore', []], ['storage:uninstall', []],
  ];
  for (const [endpoint, argv] of verbs) {
    const run = cli([endpoint, ...argv], { result: { state: 'committed' } });
    assert.equal(run.status, 0, `${endpoint}: ${run.stderr}`);
  }
});

test('the outcome contract is closed against the endpoint contract', () => {
  // R6. Two lists that must agree get bound, never trusted to stay in step. An endpoint the dispatcher
  // can reach but the outcome table does not name would fall back to "resolution means success" - the
  // defect itself - so the fallback is a throw at load time instead.
  const { assertClosedOutcomeContract, exitCodeFor } = require('./storage-cli.cjs');
  const { CONTRACT } = require('./storage-authority.cjs');
  assert.equal(assertClosedOutcomeContract(), true);
  assert.throws(() => assertClosedOutcomeContract({ ...CONTRACT.endpoints, 'storage:invented': [] }), /CLI_OUTCOME_CONTRACT_OPEN/);
  const { 'storage:janitor': _dropped, ...missing } = CONTRACT.endpoints;
  assert.throws(() => assertClosedOutcomeContract(missing), /CLI_OUTCOME_CONTRACT_OPEN/);
  assert.throws(() => exitCodeFor('storage:invented', {}), /CLI_OUTCOME_UNDECLARED:storage:invented/);
  // Prototype keys are not declarations. The endpoint reaching exitCodeFor has already survived
  // dispatch, but a guard that answers from Object.prototype is one rename away from mattering.
  assert.throws(() => exitCodeFor('constructor', {}), /CLI_OUTCOME_UNDECLARED:constructor/);
  assert.throws(() => exitCodeFor('toString', {}), /CLI_OUTCOME_UNDECLARED:toString/);
});
