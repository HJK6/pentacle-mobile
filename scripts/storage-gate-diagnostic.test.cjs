'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const os = require('node:os');
const vm = require('node:vm');

function exerciseDriver(t, { canonical = true, resultCount = 1, teardown = null } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-contract-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const product = path.join(temporary, 'product');
  const alias = path.join(temporary, 'product-alias');
  fs.mkdirSync(product);
  fs.symlinkSync(product, alias);
  const codeRoot = path.join(temporary, 'snapshot');
  const calls = [];
  const fakeProcess = {
    argv: ['node', 'gate-diagnostic.cjs'], pid: 42,
    env: { ...(canonical ? { PENTACLE_GATE_CANONICAL_RUNNER: '1' } : {}), PRIVATE_TEST_SECRET: 'must-not-persist' },
    cwd: () => alias, stdout: { write() {} }, exitCode: 0,
  };
  const modules = {
    'node:fs': fs, 'node:path': path,
    'node:child_process': {
      execFileSync(command, args) {
        assert.equal(command, '/usr/bin/getconf');
        assert.deepEqual(Array.from(args), ['DARWIN_USER_TEMP_DIR']);
        return temporary;
      },
      spawnSync(command, args, options) {
        if (command === 'git') {
          assert.deepEqual(Array.from(args), ['rev-parse', 'HEAD']);
          return { status: 0, stdout: 'abcdef0123456789\n' };
        }
        assert.equal(command, 'python3');
        assert.equal(args[0], 'test/e2e/run_scenario.py');
        calls.push({ args: Array.from(args), cwd: options.cwd });
        const runsDir = args[args.indexOf('--runs-dir') + 1];
        if (teardown) fs.writeFileSync(path.join(runsDir, 'owned.teardown.json'), JSON.stringify(teardown));
        for (let i = 0; i < resultCount; i++) {
          fs.writeFileSync(path.join(runsDir, `result-${i}.json`), JSON.stringify({ verdict: 'PASS', all_events: [] }));
        }
        return { status: resultCount ? 0 : 29, signal: null, stdout: 'child stdout', stderr: 'registry missing' };
      },
    },
    './storage-capability.cjs': { claim: () => ({}) },
    './storage-surface-trigger.cjs': { bind: () => ({ mirrorDiagnosticCaseResult() {} }) },
    './sim-resource-guard.cjs': { withSimulatorResource: (fn) => fn() },
    './sim-substrate.cjs': { reapStaleSimulatorSubstrate() {} },
    './report-viewer-sim-e2e.cjs': {
      resultFiles: (runsDir) => require('./report-viewer-sim-e2e.cjs').resultFiles(runsDir),
      recordCaseAttempt() {}, requireRecorderPreflight() {}, runRecorderPreflight() {},
      scenarioPlan: () => [{ scenario: 'fixture', expected: 'PASS' }],
      suppressCrashReporterDialogs: () => ({ restore() {} }),
      validateSentinelResult() { throw new Error('unexpected sentinel'); },
      withSoftwareKeyboard() { throw new Error('unexpected keyboard'); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'gate-diagnostic.cjs'), 'utf8'), {
    require(name) { assert.ok(Object.hasOwn(modules, name), `unexpected require ${name}`); return modules[name]; },
    __dirname: path.join(codeRoot, 'scripts'), process: fakeProcess,
  }, { filename: 'gate-diagnostic.cjs' });
  const output = path.join(temporary, 'pentacle-diagnostic-abcdef012345-42');
  return { calls, product: fs.realpathSync(product), codeRoot, output, fakeProcess,
    summary: JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8')) };
}

test('canonical diagnostic executes Python in the real product cwd, outside the gate snapshot', (t) => {
  const run = exerciseDriver(t);
  assert.equal(run.calls[0].cwd, run.product);
  assert.equal(run.summary.passed, 1);
  assert.equal(run.fakeProcess.exitCode, 1);
});

test('ordinary diagnostic retains its code-root cwd', (t) => {
  const run = exerciseDriver(t, { canonical: false });
  assert.equal(run.calls[0].cwd, run.codeRoot);
});

test('missing result preserves child failure separately without manufacturing a result', (t) => {
  const run = exerciseDriver(t, { resultCount: 0 });
  assert.equal(run.summary.passed, 0);
  assert.match(run.summary.outcomes[0].reason, /produced 0 result JSON files/);
  const invocationDir = path.join(run.output, 'invocations');
  const files = fs.readdirSync(invocationDir);
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(invocationDir, files[0]), 'utf8');
  const receipt = JSON.parse(raw);
  assert.equal(receipt.status, 29);
  assert.equal(receipt.stderr, 'registry missing');
  assert.equal(receipt.stdout, 'child stdout');
  assert.equal(receipt.cwd, run.product);
  assert.deepEqual(receipt.argv, ['python3', ...run.calls[0].args]);
  assert.equal(raw.includes('must-not-persist'), false);
  assert.equal(fs.readdirSync(path.join(run.output, 'runs')).length, 0);
  assert.equal(run.fakeProcess.exitCode, 1);
});

test('duplicate child results still fail cardinality', (t) => {
  const run = exerciseDriver(t, { resultCount: 2 });
  assert.equal(run.summary.passed, 0);
  assert.match(run.summary.outcomes[0].reason, /produced 2 result JSON files/);
});

const cleanTeardown = { attempted: 0, closed: [], closed_count: 0, orphans: [], orphan_count: 0 };
test('diagnostic accepts one primary plus the producer teardown sidecar', (t) => {
  assert.equal(exerciseDriver(t, { teardown: cleanTeardown }).summary.passed, 1);
});

test('diagnostic sidecar cannot substitute for a missing primary', (t) => {
  const run = exerciseDriver(t, { resultCount: 0, teardown: cleanTeardown });
  assert.equal(run.summary.passed, 0);
  assert.match(run.summary.outcomes[0].reason, /produced 0 result JSON files/);
});

test('diagnostic rejects invalid teardown through the shared certified selector', (t) => {
  const run = exerciseDriver(t, { teardown: { ...cleanTeardown, attempted: 1 } });
  assert.equal(run.summary.passed, 0);
  assert.match(run.summary.outcomes[0].reason, /SCENARIO_TEARDOWN_INVALID/);
});

test('diagnostic driver proves its presence before any case work', () => {
  const driver = path.join(__dirname, 'gate-diagnostic.cjs');
  const result = spawnSync(process.execPath, [driver, '--assert-present'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[diagnostic] DRIVER_PRESENT all-cases collector\n');
  assert.equal(result.stderr, '');
});

test('package script maintains the all-cases driver and feeds each result to the case-eight trigger', () => {
  const driver = fs.readFileSync(path.join(__dirname, 'gate-diagnostic.cjs'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['gate:diagnostic'], 'node scripts/gate-diagnostic.cjs');
  assert.match(driver, /mirrorDiagnosticCaseResult\(execution\.resultPath\)/);
  assert.ok(driver.indexOf('mirrorDiagnosticCaseResult(execution.resultPath)') < driver.indexOf('outcome.status = execution.status'));
});
