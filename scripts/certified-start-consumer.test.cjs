'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { POLICY, canonical, hash } = require('./certified-start-receipt.cjs');

test('actual native-root START refuses missing quiet receipt before any heavy child', async () => {
  let heavyStarts = 0;
  let stderr = '';
  const moduleObject = { exports: {} };
  const processStub = {
    argv: ['node', 'storage-cli.cjs', 'gate:native-root', 'HEAD'], env: {},
    stdout: { write() {} }, stderr: { write(value) { stderr += value; } },
    exit(code) { throw Object.assign(new Error('exit'), { code }); },
  };
  const mocks = {
    './storage-authority.cjs': { ...require('./storage-authority.cjs'), rejectEnvironmentAuthority() {} },
    './storage-capability.cjs': { claim: () => ({}) },
    './owned-process.cjs': { isOwnedInvocation: () => false, runOwnedSync: () => { heavyStarts += 1; return { status: 0 }; } },
    './gate-preflight.cjs': { beforeBootstrap: (_root, receive) => receive({ ok: true }) },
  };
  const localRequire = name => mocks[name] || (name.startsWith('./') ? require(path.join(__dirname, name)) : require(name));
  localRequire.main = moduleObject;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'storage-cli.cjs'), 'utf8'), {
    __dirname, __filename: path.join(__dirname, 'storage-cli.cjs'), module: moduleObject,
    process: processStub, require: localRequire,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heavyStarts, 0, 'missing receipt must refuse before the owned child boundary');
  assert.match(stderr, /QUIET_START_RECEIPT_REQUIRED/);
  assert.equal(processStub.exitCode, 1);
});

function receiptFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-start-consumer-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '..');
  const head = cp.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const now = Date.now(); const host = os.hostname(); const uid = process.getuid(); const attempt = crypto.randomUUID();
  const window = { schema: 1, fd_go: true, tell_id: crypto.randomUUID(), from_stream: 'hosta:v2-fd', host, uid, candidate_sha: head, gate_code_sha: head, policy_revision: POLICY.revision, attempt_id: attempt, not_before_epoch: (now - 120000) / 1000, expires_epoch: (now + POLICY.combinedClosingBudgetMs + 300000) / 1000 };
  for (const [field, value] of Object.entries({
    source_qa: { report_id: crypto.randomUUID(), qa_verdict: 'accept', target_sha: head },
    policy_qa: { report_id: crypto.randomUUID(), qa_verdict: 'accept', target_sha: head },
    ci: { head_sha: head, conclusion: 'success' },
  })) {
    const file = path.join(dir, `review-${field}.json`);
    const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
    window[field] = { path: file, sha256: hash(bytes), ...(value.report_id ? { report_id: value.report_id } : {}) };
  }
  fs.writeFileSync(path.join(dir, 'fd-window.json'), JSON.stringify(window));
  const processChecks = ['process-start', ...Array.from({ length: 6 }, (_, i) => `process-during-${i + 1}`), 'process-end'].map(label => ({ label, ok: true, status: 0, error: null, malformed_rows: 0, identity: { status: 0, error: null }, unavailable: [], heavy: [], excluded_own_ancestor_pids: [100, 10, 1] }));
  const simulatorChecks = ['simulator-start', 'simulator-end'].map(label => ({ label, ok: true, status: 0, error: null, booting: [] }));
  for (const check of [...processChecks, ...simulatorChecks]) {
    if (check.identity) fs.writeFileSync(path.join(dir, `${check.label}-pids.json`), JSON.stringify([{ pid: 100, ppid: 10 }, { pid: 10, ppid: 1 }, { pid: 1, ppid: 0 }, { pid: 1000, ppid: 1 }]));
    for (const kind of ['stdout', 'stderr']) {
      const content = kind === 'stdout' ? (check.identity ? '100 10\n10 1\n1 0\n1000 1\n' : JSON.stringify({ devices: { fixture: [{ udid: 'fixture', state: 'Shutdown' }] } })) : '';
      fs.writeFileSync(path.join(dir, `${check.label}.${kind}.log`), content);
      check[`${kind}_sha256`] = hash(Buffer.from(content));
      if (check.identity) {
        const identityContent = kind === 'stdout' ? JSON.stringify([{ pid: 100, executable: '/usr/bin/node', argv: [], exited: false, identity_errno: 0 }, { pid: 10, executable: '/bin/sh', argv: [], exited: false, identity_errno: 0 }, { pid: 1000, executable: '/usr/bin/idle', argv: [], exited: false, identity_errno: 0 }]) : '';
        fs.writeFileSync(path.join(dir, `${check.label}-identity.${kind}.log`), identityContent); check.identity[`${kind}_sha256`] = hash(Buffer.from(identityContent));
      }
    }
  }
  const stdout = Array.from({ length: 61 }, () => '0 10 0').join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'iostat.stdout.log'), stdout); fs.writeFileSync(path.join(dir, 'iostat.stderr.log'), '');
  const raw = fs.readdirSync(dir).filter(name => name !== 'fd-window.json').sort().map(relative => ({ relative, size: fs.statSync(path.join(dir, relative)).size, sha256: hash(fs.readFileSync(path.join(dir, relative))) }));
  const receipt = {
    schema: 2, certification: 'UNCERTIFIED', native_certification: false, policy_revision: POLICY.revision, observer_pid: 100,
    attempt_id: attempt, host, uid, candidate_sha: head, gate_code_sha: head,
    observer_sha256: hash(fs.readFileSync(path.join(source, 'scripts/observe-mobile-quiet.cjs'))),
    raw_evidence_digest: hash(canonical(raw)), fd_window_go_sha256: hash(fs.readFileSync(path.join(dir, 'fd-window.json'))),
    started_at: new Date(now - 80000).toISOString(), finished_at: new Date(now - 10000).toISOString(),
    observation_elapsed_ms: 60000, median_disk_tps: 10, max_disk_tps: 10,
    disk_intervals: Array.from({ length: 60 }, (_, i) => ({ index: i + 1, elapsed_ms: (i + 1) * 1000, tps: 10, raw: '0 10 0' })),
    process_checks: processChecks, simulator_checks: simulatorChecks,
    iostat: { code: 0, signal: null, observer_bound_ms: 90000, initial_cumulative_row_excluded: true, numeric_rows: 61, parser_errors: [], ownership: { disposition: 'completed', group_alive_after: false }, stdout_sha256: hash(Buffer.from(stdout)), stderr_sha256: hash(Buffer.from('')) },
    ready: true, result: 'QUIET_60S_PASS',
  };
  const file = path.join(dir, 'receipt.json');
  return { file, receipt, window, dir, authority: { host, uid }, write: () => {
    fs.writeFileSync(path.join(dir, 'fd-window.json'), JSON.stringify(window));
    receipt.fd_window_go_sha256 = hash(fs.readFileSync(path.join(dir, 'fd-window.json')));
    fs.writeFileSync(file, JSON.stringify(receipt));
  }, refreshRaw: () => {
    const raw = fs.readdirSync(dir).filter(name => name !== 'fd-window.json' && name !== 'receipt.json').sort().map(relative => ({ relative, size: fs.statSync(path.join(dir, relative)).size, sha256: hash(fs.readFileSync(path.join(dir, relative))) }));
    receipt.raw_evidence_digest = hash(canonical(raw));
  } };
}

async function actualStart(environment, authority, values = ['HEAD']) {
  let heavyStarts = 0; let stderr = '';
  const moduleObject = { exports: {} };
  const processStub = { argv: ['node', 'storage-cli.cjs', 'gate:native-root', ...values], env: environment, stdout: { write() {} }, stderr: { write(value) { stderr += value; } }, exit(code) { throw Object.assign(new Error('exit'), { code }); } };
  const mocks = {
    './storage-authority.cjs': { ...require('./storage-authority.cjs'), rejectEnvironmentAuthority() {} },
    './storage-capability.cjs': { claim: () => ({}) },
    './storage-state.cjs': { validateInstalledAuthority: () => authority, listRecords: () => [] },
    './owned-process.cjs': { isOwnedInvocation: () => false, runOwnedSync: () => { heavyStarts += 1; return { status: 0 }; } },
    './gate-preflight.cjs': { beforeBootstrap: (_root, receive) => receive({ ok: true }) },
  };
  const localRequire = name => mocks[name] || (name.startsWith('./') ? require(path.join(__dirname, name)) : require(name)); localRequire.main = moduleObject;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'storage-cli.cjs'), 'utf8'), { __dirname, __filename: path.join(__dirname, 'storage-cli.cjs'), module: moduleObject, process: processStub, require: localRequire });
  await new Promise(resolve => setImmediate(resolve));
  return { heavyStarts, stderr, exit: processStub.exitCode || 0 };
}

test('valid input reaches the actual unchanged owned admission boundary once', async t => {
  const f = receiptFixture(t); f.write();
  const result = await actualStart({ PENTACLE_GATE_QUIET_RECEIPT: f.file }, f.authority);
  assert.equal(result.heavyStarts, 1); assert.equal(result.exit, 0); assert.equal(result.stderr, '');
});

test('invalid native-root arity refuses before the owned child even with a valid quiet input', async t => {
  const f = receiptFixture(t); f.write();
  const result = await actualStart({ PENTACLE_GATE_QUIET_RECEIPT: f.file }, f.authority, ['HEAD', 'extra']);
  assert.equal(result.heavyStarts, 0); assert.equal(result.exit, 1);
  assert.match(result.stderr, /FORBIDDEN_AUTHORITY/);
});

test('same immutable claim reaches full after preparation; copied reviews survive original-file removal', t => {
  const f = receiptFixture(t); f.write();
  const quiet = require('./certified-start-receipt.cjs');
  const repository = path.resolve(__dirname, '..');
  const inputs = quiet.readInputs(f.file);
  const now = Date.now();
  const initial = quiet.validateReceipt(inputs.receipt, inputs.window, quiet.expectedBindings(repository, 'HEAD', f.authority, inputs), now);
  const id = crypto.randomUUID(), generation = crypto.randomUUID();
  const run = { id, generation, owner: { ...f.authority, pid: 100 }, candidate_ref: f.receipt.candidate_sha,
    gate_code_sha: f.receipt.gate_code_sha, reserved_at: initial.claimed_at, quiet_start: { ...initial, run_id: id } };
  const evidence = path.join(f.dir, 'retained'); fs.mkdirSync(evidence);
  quiet.copyClaimInputs(inputs, evidence);
  for (const field of ['source_qa','policy_qa','ci']) fs.unlinkSync(f.window[field].path);
  const mockState = { validateInstalledAuthority: () => ({ ...f.authority, generation }), readRecord: () => run };
  const moduleObject = { exports: {} };
  const localRequire = name => name === './storage-state.cjs' ? mockState
    : name === './storage-containers.cjs' ? { resolveMounted: () => ({ mount: evidence }) }
    : name.startsWith('./') ? require(path.join(__dirname, name)) : require(name);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'certified-start-receipt.cjs'), 'utf8'), {
    require: localRequire, module: moduleObject, __dirname, process,
  });
  const claim = moduleObject.exports.requireAllocatedStart(id, repository, now + 300000);
  assert.equal(claim.receipt_sha256, initial.receipt_sha256);
  assert.equal(claim.claimed_at, initial.claimed_at);
  assert.throws(() => quiet.assertUnclaimed(initial, [run]), /ALREADY_CLAIMED/);
  run.quiet_start.receipt_sha256 = '9'.repeat(64);
  assert.throws(() => moduleObject.exports.requireAllocatedStart(id, repository, now + 300000), /CLAIM_BINDING/);
});

for (const [name, alter, error] of [
  ['generic preflight', f => { f.receipt.schema = 1; }, 'SCHEMA_POLICY'],
  ['failed observation', f => { f.receipt.ready = false; }, 'NOT_READY'],
  ['wrong host', f => { f.receipt.host = 'hostb'; }, 'HOST'],
  ['wrong candidate', f => { f.receipt.candidate_sha = '0'.repeat(40); }, 'PIN'],
  ['stale observation', f => { f.receipt.finished_at = new Date(Date.now() - 121000).toISOString(); f.receipt.started_at = new Date(Date.now() - 191000).toISOString(); }, 'CLOCK|STALE'],
  ['altered raw bytes', f => { fs.appendFileSync(path.join(f.dir, 'iostat.stdout.log'), '0 1 0\n'); }, 'RAW_DIGEST|RAW_PARSE'],
]) test(`actual START refuses ${name} with zero heavy starts`, async t => {
  const f = receiptFixture(t); alter(f); f.write();
  const result = await actualStart({ PENTACLE_GATE_QUIET_RECEIPT: f.file }, f.authority);
  assert.equal(result.heavyStarts, 0); assert.equal(result.exit, 1); assert.match(result.stderr, new RegExp(`QUIET_START_(${error})`));
});

for (const [name, alter] of [
  ['missing source review', f => { delete f.window.source_qa; }],
  ['missing policy review', f => { delete f.window.policy_qa; }],
  ['unrelated accepted policy review', f => {
    const reference = f.window.policy_qa;
    const report = JSON.parse(fs.readFileSync(reference.path));
    report.target_sha = 'b'.repeat(40);
    fs.writeFileSync(reference.path, JSON.stringify(report));
    reference.sha256 = hash(fs.readFileSync(reference.path)); f.refreshRaw();
  }],
  ['missing exact CI', f => { delete f.window.ci; }],
  ['unbound source review copy', f => { fs.unlinkSync(path.join(f.dir, 'review-source_qa.json')); f.refreshRaw(); }],
  ['foreign PID omitted from identity rows', f => {
    const check = f.receipt.process_checks[0];
    const file = path.join(f.dir, `${check.label}-identity.stdout.log`);
    const identities = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file, JSON.stringify(identities.filter(row => row.pid !== 1000)));
    check.identity.stdout_sha256 = hash(fs.readFileSync(file)); f.refreshRaw();
  }],
  ['undeclared file in retained quiet evidence', f => {
    fs.writeFileSync(path.join(f.dir, 'undeclared.json'), '{}'); f.refreshRaw();
  }],
  ['identity helper receives a different PID census', f => {
    const check = f.receipt.process_checks[0];
    fs.writeFileSync(path.join(f.dir, `${check.label}-pids.json`), JSON.stringify([{ pid: 100, ppid: 10 }])); f.refreshRaw();
  }],
]) test(`actual START refuses ${name} even when summary and raw hashes agree`, async t => {
  const f = receiptFixture(t); alter(f); f.write();
  const result = await actualStart({ PENTACLE_GATE_QUIET_RECEIPT: f.file }, f.authority);
  assert.equal(result.heavyStarts, 0);
  assert.equal(result.exit, 1);
});
