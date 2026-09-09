#!/usr/bin/env node
// AC checkbox-8 certification checker, PART 2 — the four gaps certify.sh does not cover.
// §11.1: 12 certified stages exit 0 IN ORDER; 9 report-viewer cases, single attempt, no retry.
// §11.1: cleanup.json status=passed with all four flags true.
// §11.3: manifest-v1.json digest == the journal's evidence_digest.
//
// certify.sh remains the checker for §11.2 accounting, §11.1 host state, §11.3 screenshot admission.
// Run both. This one is `node storage-certify.cjs <evidenceDir> <runId>` or `node storage-certify.cjs --selftest`.
//
// DISCIPLINE (§11.5) applied to the INSTRUMENT: every check below has a negative control in --selftest
// that proves it FAILS on a deliberately broken input, plus a positive control proving a good fixture
// passes. A checker that passes everything is indistinguishable from a checker that checks nothing.
//
// The stage list is DERIVED AT RUNTIME from the wrapper source, never hardcoded here. §11.1's own stale
// "11" is the reason: a certification instrument carrying its own copy of a drifting constant is how this
// lane nearly certified a run that was missing a stage. The wrapper's array is itself test-bound to the
// certified gate's runGate call sites (stage-order contract), so reading it is sound and non-duplicating.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolves from its OWN location. The scratchpad original hardcoded one machine's clone path, which is
// fine for a session tool and wrong for an instrument that must outlive the seat that wrote it.
const REPO = process.env.PENTACLE_REPO || path.resolve(__dirname, '..');

function deriveCertifiedStages(repo = REPO) {
  const src = fs.readFileSync(path.join(repo, 'scripts', 'storage-gate.cjs'), 'utf8');
  const m = src.match(/const stages = \[([^\]]*)\];/);
  if (!m) throw new Error('DERIVATION_STALE: could not locate the wrapper stage array');
  const stages = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  // Anti-under-match, per §10a: a derivation that silently sees fewer stages passes vacuously on both sides.
  if (stages.length !== 12) throw new Error(`DERIVATION_STALE: expected 12 stages, derived ${stages.length}`);
  for (const required of ['sim-e2e', 'release-sim-reset']) {
    if (!stages.includes(required)) throw new Error(`DERIVATION_STALE: missing ${required}`);
  }
  return stages;
}

// §11.1 — 12 certified stages exit 0 in order.
function checkStages(evidenceDir, stages) {
  const run = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'run.json'), 'utf8'));
  const names = (run.gates || []).map((g) => g && g.name);
  if (JSON.stringify(names) !== JSON.stringify(stages)) {
    return `STAGES: expected the ${stages.length} certified stages in order, got ${names.length} [${names.join(', ')}]`;
  }
  const bad = (run.gates || []).filter((g) => g.status !== 0).map((g) => `${g.name}=${g.status}`);
  if (bad.length) return `STAGES: non-zero exit: ${bad.join(', ')}`;
  if (run.status !== 'passed') return `STAGES: run.json status is ${run.status}, expected passed`;
  return null;
}

// §11.1 — 9 report-viewer cases, single attempt, no retry.
function checkCases(evidenceDir, plan) {
  const f = path.join(evidenceDir, 'report-viewer-sim-e2e', 'manifest.json');
  if (!fs.existsSync(f)) return 'CASES: report-viewer-sim-e2e/manifest.json absent';
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (m.attempts_per_case !== 1) return `CASES: attempts_per_case=${m.attempts_per_case}, expected 1 (no retry)`;
  const n = Array.isArray(m.cases) ? m.cases.length : -1;
  if (n !== plan.length) return `CASES: ${n} cases, expected exactly ${plan.length}`;
  if (m.status !== 'passed') return `CASES: manifest status=${m.status}, expected passed`;
  // Counting nine is not checking nine. Measured on the scratchpad original: nine IDENTICAL cases, a
  // FAIL-expected sentinel reporting status 0, every case relabelled PASS, and the cases in reverse order
  // ALL reported CERTIFIED. §11.1 says nine report-viewer cases with their expected verdicts, so identity
  // and per-case verdict are part of the property, not decoration - and this instrument is the sole
  // mechanical basis for declaring the lane done, so leniency here ends it on a false green.
  for (const [index, expected] of plan.entries()) {
    const actual = m.cases[index];
    const [scenario, sentinel, verdict] = expected;
    if (!actual || actual.scenario !== scenario || (actual.sentinel || null) !== sentinel || actual.expected !== verdict) {
      return `CASES: case ${index} is ${actual ? `${actual.scenario}/${actual.sentinel || '-'}/${actual.expected}` : 'absent'}, expected ${scenario}/${sentinel || '-'}/${verdict}`;
    }
    const requiredStatus = verdict === 'PASS' ? 0 : 1;
    if (actual.status !== requiredStatus) return `CASES: case ${index} (${scenario}) status=${actual.status}, ${verdict} requires ${requiredStatus}`;
  }
  return null;
}

// §11.1 — cleanup.json status=passed with all four flags true.
function checkCleanup(evidenceDir, runId) {
  const f = path.join(evidenceDir, 'cleanup.json');
  if (!fs.existsSync(f)) return 'CLEANUP: cleanup.json absent';
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (c.run_id !== runId) return `CLEANUP: run_id ${c.run_id} != ${runId}`;
  if (c.status !== 'passed') return `CLEANUP: status=${c.status}, expected passed`;
  const flags = ['simulator_deleted', 'indirections_removed', 'queue_released', 'scratch_discarded'];
  const off = flags.filter((k) => c[k] !== true);
  if (off.length) return `CLEANUP: flags not true: ${off.join(', ')}`;
  return null;
}

// §11.3 — manifest-v1.json digest == journal evidence_digest.
function checkDigest(evidenceDir, record) {
  const f = path.join(evidenceDir, 'manifest-v1.json');
  if (!fs.existsSync(f)) return 'DIGEST: manifest-v1.json absent';
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (m.schema !== 1) return `DIGEST: manifest schema=${m.schema}`;
  if (m.run_id !== record.id) return `DIGEST: manifest run_id ${m.run_id} != journal ${record.id}`;
  if (!Array.isArray(m.files)) return 'DIGEST: manifest files is not an array';
  if (!record.evidence_digest) return 'DIGEST: journal record carries no evidence_digest';
  const got = crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
  if (got !== record.evidence_digest) return `DIGEST: manifest hashes to ${got.slice(0, 16)}…, journal says ${String(record.evidence_digest).slice(0, 16)}…`;
  // The wrapper classifies from gate_status (storage-gate.cjs:380); a green run must agree.
  const expected = record.gate_status === 0 ? 'passed' : 'failed';
  if (m.outcome !== expected) return `DIGEST: manifest outcome=${m.outcome}, gate_status=${record.gate_status} implies ${expected}`;
  return null;
}

// `plan` comes from the wrapper's REPORT_VIEWER_CASE_PLAN, which storage-behavior.test.cjs binds to the
// certified scenarioPlan()/SENTINELS. So the chain is: certified full-gate.cjs and report-viewer-sim-e2e.cjs
// -> the derivation tests -> the wrapper's arrays -> this instrument. If either binding breaks, this goes
// stale SILENTLY and certifies against the wrong list, which is the failure it exists to prevent arriving
// through its own dependency.
// REFUSES rather than certifying when the certified bytes have drifted. Without this the chain had a
// PROCESS link in the middle: deriveCertifiedStages reads the WRAPPER array, which is bound to the certified
// call sites only by test:storage - so the certification was valid only if someone happened to run the suite
// at the same SHA. Measured: under a certified-file change that turns both chain tests red, the instrument
// still derives 12 with both trap names and certifies happily, because the wrapper array is untouched. An
// unstated precondition that is true when written and silently false later is the shape this lane has been
// burned by all day, so it is converted from a process link into a code link here.
function assertCertifiedComponents(repo = REPO) {
  try { return require('./storage-gate.cjs').verifyCertified(repo); }
  catch (error) { throw new Error(`CERTIFY_REFUSED_CERTIFIED_DRIFT: ${error.message}`); }
}

function runAll(evidenceDir, record, stages, plan = require('./storage-gate.cjs').REPORT_VIEWER_CASE_PLAN, repo = REPO) {
  return [
    () => { assertCertifiedComponents(repo); return null; },
    () => checkStages(evidenceDir, stages),
    () => checkCases(evidenceDir, plan),
    () => checkCleanup(evidenceDir, record.id),
    () => checkDigest(evidenceDir, record),
  ].map((check) => { try { return check(); } catch (error) { return error.message; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// SELFTEST — positive control + one negative control per check.
// ---------------------------------------------------------------------------
function buildValidFixture(stages) {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'certify2-'));
  const runId = '11111111-2222-3333-4444-555555555555';
  const t0 = '2026-07-22T08:00:00.000Z';
  const t1 = '2026-07-22T08:01:00.000Z';
  const gates = stages.map((s) => ({ name: s, command: 'x', status: 0, started_at: t0, finished_at: t1, log: `${s}.log` }));
  fs.writeFileSync(path.join(root, 'run.json'), `${JSON.stringify({ schema: 1, status: 'passed', gates })}\n`);
  fs.mkdirSync(path.join(root, 'report-viewer-sim-e2e'));
  fs.writeFileSync(path.join(root, 'report-viewer-sim-e2e', 'manifest.json'),
    // Plan-conformant, not nine placeholders. The original fixture used Array.from({length:9},(_,i)=>({n:i})),
    // which is precisely WHY the count-only check passed: the positive control was shaped to satisfy the
    // checker rather than to represent a valid run, so it could never have exposed the leniency.
    `${JSON.stringify({ status: 'passed', attempts_per_case: 1, cases: require('./storage-gate.cjs').REPORT_VIEWER_CASE_PLAN.map(([scenario, sentinel, expected], index) => ({ scenario, ...(sentinel ? { sentinel } : {}), run_id: `run-${index}`, expected, status: expected === 'PASS' ? 0 : 1 })) })}\n`);
  fs.writeFileSync(path.join(root, 'cleanup.json'), `${JSON.stringify({
    schema: 1, run_id: runId, status: 'passed', simulator_deleted: true, indirections_removed: true,
    queue_released: true, scratch_discarded: true, completed_at: t1,
  })}\n`);
  const manifest = { schema: 1, run_id: runId, outcome: 'passed', generated_at: t1, files: [] };
  fs.writeFileSync(path.join(root, 'manifest-v1.json'), `${JSON.stringify(manifest)}\n`);
  const record = { id: runId, gate_status: 0, evidence_digest: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
  return { root, record, runId };
}

function selftest() {
  const stages = deriveCertifiedStages();
  console.log(`derived ${stages.length} certified stages from the wrapper source (not hardcoded here)`);
  let failures = 0;
  const report = (name, ok, detail) => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
  };

  // POSITIVE CONTROL — a fully valid fixture must produce ZERO findings. Without this, every negative
  // control below could pass vacuously by the checker rejecting absolutely everything.
  const good = buildValidFixture(stages);
  const clean = runAll(good.root, good.record, stages);
  report('POSITIVE CONTROL: valid sealed run yields no findings', clean.length === 0, clean.join(' | '));

  // NEGATIVE CONTROLS — each breaks exactly one property and must be caught by its own check.
  const cases = [
    ['STAGES: a stage dropped (the 11-of-12 shape)', (f) => {
      const r = JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'), 'utf8'));
      r.gates = r.gates.slice(0, 11);
      fs.writeFileSync(path.join(f.root, 'run.json'), JSON.stringify(r));
    }, /^STAGES/],
    ['CASES: nine IDENTICAL cases (count is not identity)', (f) => {
      const p = path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.cases = m.cases.map(() => ({ ...m.cases[0] }));
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^CASES/],
    ['CASES: a FAIL-expected sentinel reporting status 0', (f) => {
      const p = path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      const i = m.cases.findIndex((c) => c.expected === 'FAIL');
      m.cases[i] = { ...m.cases[i], status: 0 };
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^CASES/],
    ['CASES: every case relabelled expected PASS', (f) => {
      const p = path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.cases = m.cases.map((c) => ({ ...c, expected: 'PASS' }));
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^CASES/],
    ['CASES: cases in reversed order', (f) => {
      const p = path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.cases = [...m.cases].reverse();
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^CASES/],
    ['STAGES: stages reordered', (f) => {
      const r = JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'), 'utf8'));
      [r.gates[0], r.gates[1]] = [r.gates[1], r.gates[0]];
      fs.writeFileSync(path.join(f.root, 'run.json'), JSON.stringify(r));
    }, /^STAGES/],
    ['STAGES: a stage exits non-zero', (f) => {
      const r = JSON.parse(fs.readFileSync(path.join(f.root, 'run.json'), 'utf8'));
      r.gates[5].status = 1;
      fs.writeFileSync(path.join(f.root, 'run.json'), JSON.stringify(r));
    }, /^STAGES/],
    ['CASES: 8 cases instead of 9', (f) => {
      const p = path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.cases = m.cases.slice(0, 8);
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^CASES/],
    ['CASES: a retry was permitted (attempts_per_case=2)', (f) => {
      const p = path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.attempts_per_case = 2;
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^CASES/],
    ['CLEANUP: one flag false', (f) => {
      const p = path.join(f.root, 'cleanup.json');
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      c.queue_released = false;
      fs.writeFileSync(p, JSON.stringify(c));
    }, /^CLEANUP/],
    ['DIGEST: manifest mutated after sealing', (f) => {
      const p = path.join(f.root, 'manifest-v1.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.files = [{ smuggled: true }];
      fs.writeFileSync(p, JSON.stringify(m));
    }, /^DIGEST/],
    ['DIGEST: outcome disagrees with gate_status', (f) => {
      const p = path.join(f.root, 'manifest-v1.json');
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      m.outcome = 'failed';
      fs.writeFileSync(p, JSON.stringify(m));
      f.record.evidence_digest = crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
    }, /^DIGEST/],
  ];

  for (const [name, mutate, expect] of cases) {
    const f = buildValidFixture(stages);
    const before = fs.readFileSync(path.join(f.root, 'run.json'), 'utf8')
      + fs.readFileSync(path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json'), 'utf8')
      + fs.readFileSync(path.join(f.root, 'cleanup.json'), 'utf8')
      + fs.readFileSync(path.join(f.root, 'manifest-v1.json'), 'utf8');
    mutate(f);
    const after = fs.readFileSync(path.join(f.root, 'run.json'), 'utf8')
      + fs.readFileSync(path.join(f.root, 'report-viewer-sim-e2e', 'manifest.json'), 'utf8')
      + fs.readFileSync(path.join(f.root, 'cleanup.json'), 'utf8')
      + fs.readFileSync(path.join(f.root, 'manifest-v1.json'), 'utf8');
    // §11.5: confirm the mutation was ACTUALLY APPLIED. A no-op edit reads as "the guard did not fire".
    if (before === after) { report(name, false, 'MUTATION WAS A NO-OP — result is meaningless'); continue; }
    const found = runAll(f.root, f.record, stages);
    report(name, found.some((x) => expect.test(x)), found.length ? found.join(' | ') : 'checker found NOTHING');
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  fs.rmSync(good.root, { recursive: true, force: true });
  console.log(failures ? `\n*** SELFTEST FAILED: ${failures}` : '\nSELFTEST OK — every check fails closed on its own broken input, and a valid run still passes.');
  return failures;
}

if (require.main === module) {
  if (process.argv[2] === '--selftest') process.exit(selftest() ? 1 : 0);
  const [, , evidenceDir, runId] = process.argv;
  if (!evidenceDir || !runId) { console.error('usage: storage-certify.cjs <evidenceDir> <runId> | --selftest'); process.exit(2); }
  const record = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'Library/PentacleMobileStorage/State/runs', `${runId}.json`), 'utf8'));
  const findings = runAll(evidenceDir, record, deriveCertifiedStages());
  console.log(findings.length ? findings.map((f) => `  NOT CERTIFIED — ${f}`).join('\n') : '  §11.1 stages+cases, §11.1 cleanup, §11.3 digest: ALL PASS');
  process.exit(findings.length ? 1 : 0);
}

module.exports = { assertCertifiedComponents, buildValidFixture, selftest, deriveCertifiedStages, checkStages, checkCases, checkCleanup, checkDigest, runAll };
