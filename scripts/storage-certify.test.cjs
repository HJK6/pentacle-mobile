'use strict';

// Scenario-output certification checks for the pinned runner test suite.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The certification instrument is covered BY the suite it certifies against. It previously lived in a QA
// session scratchpad and would have died with that seat - a certification instrument with a shorter
// lifetime than the thing it certifies. An uncovered checker is the same defect class as an unproven
// guard, one level out: nothing would notice it going stale.
const certify = require('./storage-certify.cjs');

test('the certification instrument selftest passes with zero failures', () => {
  // selftest returns a FAILURE COUNT: positive control first, then one negative control per property,
  // each byte-compared to confirm the mutation actually applied so a no-op cannot read as a pass.
  assert.equal(certify.selftest(), 0);
});

test('the byte-pinned certified recorder mutation suite executes completely', () => {
  const target = path.join(__dirname, 'report-viewer-sim-e2e.test.cjs');
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
    '225a7181792be00bbf22a658eee95f4b11db6fe15c9e8c7578193bcfff63c7f2',
  );
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', target], {
    cwd: path.resolve(__dirname, '..'), env: childEnvironment, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /# fail 0(?:\n|$)/);
  assert.match(output, /# skipped 0(?:\n|$)/);
});

test('the instrument refuses to run on an under-matching stage derivation', () => {
  // The anti-under-match guard is the instrument's own version of the trap it exists to catch: a
  // derivation seeing fewer stages would compare a short list against a short list and certify happily.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), 'cert-'));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    const real = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
    const target = path.join(directory, 'scripts', 'storage-gate.cjs');

    fs.writeFileSync(target, real.replace(/const stages = \[[^\]]*\];/, "const stages = ['focused-jest', 'sim-e2e'];"));
    assert.throws(() => certify.deriveCertifiedStages(directory), /DERIVATION_STALE: expected 12 stages, derived 2/);

    // Twelve entries but the trap name missing: the count alone must not be enough.
    const twelve = Array.from({ length: 12 }, (_, index) => `'stage-${index}'`).join(', ');
    fs.writeFileSync(target, real.replace(/const stages = \[[^\]]*\];/, `const stages = [${twelve}];`));
    assert.throws(() => certify.deriveCertifiedStages(directory), /DERIVATION_STALE: missing sim-e2e/);

    // Targets the stages array specifically: 'release-sim-reset' occurs FIRST in stageFiles, so a naive
    // whole-file replace edits the wrong array and the guard correctly does not fire - which would have
    // made this control vacuous rather than the guard weak.
    const withoutReset = ['focused-jest', 'serial-jest', 'typecheck', 'ios-export', 'release-sim-bootstatus', 'release-sim-build', 'release-sim-install', 'release-sim-launch', 'release-sim-settle', 'release-sim-liveness', 'sim-e2e'].map((name) => `'${name}'`).join(', ');
    fs.writeFileSync(target, real.replace(/const stages = \[[^\]]*\];/, `const stages = [${withoutReset}];`));
    assert.throws(() => certify.deriveCertifiedStages(directory), /DERIVATION_STALE: expected 12 stages, derived 11/);

    fs.writeFileSync(target, real.replace(/const stages = \[[^\]]*\];/, 'const notStages = [];'));
    assert.throws(() => certify.deriveCertifiedStages(directory), /DERIVATION_STALE: could not locate/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the instrument checks case identity and per-case verdict, not just the count', () => {
  // Regression for the leniency found reviewing it: counting nine is not checking nine. Every one of these
  // reported CERTIFIED before the fix, and this is the sole mechanical basis for declaring the lane done,
  // so a lenient checker ends it on a false green.
  const stages = certify.deriveCertifiedStages();
  const plan = require('./storage-gate.cjs').REPORT_VIEWER_CASE_PLAN;
  const mutations = {
    'nine identical cases': (m) => { m.cases = m.cases.map(() => ({ ...m.cases[0] })); },
    'a FAIL-expected case reporting success': (m) => { const i = m.cases.findIndex((c) => c.expected === 'FAIL'); m.cases[i] = { ...m.cases[i], status: 0 }; },
    'every case relabelled PASS': (m) => { m.cases = m.cases.map((c) => ({ ...c, expected: 'PASS' })); },
    'cases reversed': (m) => { m.cases = [...m.cases].reverse(); },
    'a case scenario swapped': (m) => { m.cases[0] = { ...m.cases[0], scenario: 'report_viewer_comments_keyboard' }; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const fixture = certify.buildValidFixture(stages);
    try {
      assert.deepEqual(certify.runAll(fixture.root, fixture.record, stages, plan), [], `${label}: fixture must be valid before mutation`);
      const manifestFile = path.join(fixture.root, 'report-viewer-sim-e2e', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      mutate(manifest);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      const findings = certify.runAll(fixture.root, fixture.record, stages, plan);
      assert.ok(findings.some((finding) => /^CASES/.test(finding)), `${label} must not certify`);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('the instrument refuses to certify when certified bytes have drifted', () => {
  // The chain had a PROCESS link: deriveCertifiedStages reads the WRAPPER array, which is bound to the
  // certified call sites only by test:storage. So a certified-file change turns both chain tests red, but
  // the instrument still derives 12 with both trap names and certifies happily - the certification being
  // valid only if someone happened to run the suite at the same SHA. That is an unstated precondition,
  // true when written and silently false later. Now a code link.
  const { CERTIFIED_COMPONENTS } = require('./storage-authority.cjs');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native('/tmp'), 'drift-'));
  try {
    const repoRoot = path.resolve(__dirname, '..');
    for (const relative of Object.keys(CERTIFIED_COMPONENTS)) {
      fs.mkdirSync(path.join(directory, path.dirname(relative)), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, relative), path.join(directory, relative));
    }

    // POSITIVE CONTROL FIRST: an untouched copy must pass, or the refusal below proves nothing - a checker
    // that refuses everything would satisfy the negative case for free.
    assert.doesNotThrow(() => certify.assertCertifiedComponents(directory), 'an unmutated certified set must pass');

    // Drift ONE certified component by a single appended byte.
    const victim = 'scripts/full-gate.cjs';
    fs.appendFileSync(path.join(directory, victim), '\n');
    assert.throws(() => certify.assertCertifiedComponents(directory), (error) => {
      // The refusal must NAME what drifted, not merely decline - same rule as the symlink path and the
      // sidecar split. A bare refusal sends the next reader hunting the wrong end of the chain.
      assert.match(error.message, /CERTIFY_REFUSED_CERTIFIED_DRIFT/);
      assert.match(error.message, /CERTIFIED_COMPONENT_DRIFT:scripts\/full-gate\.cjs/);
      return true;
    });

    // And it refuses at the CERTIFY path, not merely in a helper: runAll must not report findings-or-clean
    // on a drifted tree, because "no findings" is what CERTIFIED means.
    const stages = certify.deriveCertifiedStages();
    const fixture = certify.buildValidFixture(stages);
    try {
      const plan = require('./storage-gate.cjs').REPORT_VIEWER_CASE_PLAN;
      assert.deepEqual(certify.runAll(fixture.root, fixture.record, stages, plan, repoRoot), [], 'a valid run in an undrifted repo still certifies');
      assert.match(certify.runAll(fixture.root, fixture.record, stages, plan, directory).join('\n'), /CERTIFY_REFUSED_CERTIFIED_DRIFT/, 'a drifted repo must refuse while collecting independent findings');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
