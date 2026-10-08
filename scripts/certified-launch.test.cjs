'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const quiet = require('./certified-start-receipt.cjs');
const launch = require('./certified-launch.cjs');

// Controlled boundaries around the actual facade: journal, containers, git and children are fakes that
// record what was started; allocation, review and output files are real files on disk.
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const CANDIDATE = 'a'.repeat(40);
const GATE_CODE = 'b'.repeat(40);
const ATTEMPT = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b2';
const TOKEN = 'f'.repeat(64);
const DIGEST = 'd'.repeat(64);
const SEAL = { image: 'evidence', nonce: 1 };
const SOURCE_REPORT = '00000000-0000-4000-8000-0000000000d1';
const POLICY_REPORT = '00000000-0000-4000-8000-0000000000d2';
const GATE_REPORT = '00000000-0000-4000-8000-0000000000d3';

const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certified-launch-test-'));
  dirs.push(dir);
  const reference = (name, value) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return { path: file, sha256: quiet.hash(fs.readFileSync(file)) };
  };
  const gateCode = options.gateCode || CANDIDATE;
  const packet = {
    schema: 1, fd_go: true, tell_id: '00000000-0000-4000-8000-0000000000c3', from_stream: 'hosta:v2-fd',
    attempt_id: ATTEMPT, host: 'hosta', uid: 501, candidate_sha: CANDIDATE, gate_code_sha: gateCode,
    policy_revision: quiet.POLICY.revision, not_before_epoch: (NOW - 60000) / 1000,
    expires_epoch: (NOW + (options.windowMs ?? 7 * 3600000)) / 1000,
    source_qa: { ...reference('source-qa', { report: { qa_verdict: 'accept', target_sha: CANDIDATE, report_id: SOURCE_REPORT } }), report_id: SOURCE_REPORT },
    policy_qa: { ...reference('policy-qa', { qa_verdict: 'accept', target_sha: 'c'.repeat(40), report_id: POLICY_REPORT }), report_id: POLICY_REPORT },
    ci: reference('ci', { head_sha: CANDIDATE, conclusion: 'success' }),
    ...options.packet,
  };
  if (options.gateReviews) Object.assign(packet, options.gateReviews(reference));
  const allocation = path.join(dir, 'allocation.json');
  fs.writeFileSync(allocation, JSON.stringify(packet));
  const lock = path.join(dir, 'gate.lock');
  const outputRoot = path.join(dir, 'out');
  const calls = { children: [], release: [], attach: 0, detach: 0, probes: 0 };
  let attached = options.preAttached === true;
  const run = { id: RUN, gate_status: 0, state: 'scratch_discarded', evidence_digest: DIGEST, evidence_seal: SEAL,
    candidate_ref: CANDIDATE, gate_code_sha: gateCode, owner: { host: 'hosta', uid: 501 }, quiet_start: null };
  const child = (binary, args, spawnOptions) => {
    const name = args[0].endsWith('observe-mobile-quiet.cjs') ? 'observer' : args[1];
    calls.children.push({ name, args, env: spawnOptions.env, timeout: spawnOptions.timeout });
    const ownership = { disposition: 'completed', group_alive_after: false, command: [binary, ...args] };
    const behaviour = (options.children || {})[name];
    if (name === 'observer') {
      fs.mkdirSync(args[2]);
      fs.writeFileSync(path.join(args[2], 'receipt.json'), '{"ready":true}\n');
      return { status: 0, stdout: '{"result":"QUIET"}\n', stderr: '', ownership, ...behaviour?.() };
    }
    if (name === 'gate:native-root') {
      fs.writeFileSync(lock, 'held');
      return { status: 0, stdout: `${JSON.stringify({ run_id: RUN, lock_token: TOKEN })}\n`, stderr: '', ownership, ...behaviour?.() };
    }
    // gate:full: its own prepared-allocation wrapper releases the lock on every completed exit.
    const result = { status: 0, stdout: `${JSON.stringify({ run_id: RUN, status: 0, evidence_digest: DIGEST, candidate_sha: CANDIDATE, gate_code_sha: gateCode })}\n`,
      stderr: `PREPARED_ALLOCATION_CLEANUP:{"run_id":"${RUN}"}\nlock ${TOKEN}\n`, ownership, ...behaviour?.() };
    if (!result.keepLock) fs.rmSync(lock, { force: true });
    return result;
  };
  const boundaries = {
    now: () => NOW, outputRoot, lockPath: lock, run: options.run || child,
    git: args => ({ 'rev-parse': args[1] === 'HEAD' ? gateCode : CANDIDATE, remote: 'https://github.com/HJK6/pentacle-mobile.git', status: '' })[args[0]],
    state: {
      validateInstalledAuthority: () => ({ host: 'hosta', uid: 501 }),
      listRecords: () => options.runs || [],
      readRecord: () => JSON.parse(JSON.stringify(run)),
    },
    containers: {
      requireCapacity() {},
      requireSeal(actual, expected) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('CONTAINER_SEAL_MISMATCH'); },
      assertImageDetached() { if (attached) throw new Error('CONTAINER_STILL_MOUNTED'); },
    },
    gate: { verifyCertified() {}, verifyRetainedEvidence: options.verifyRetainedEvidence || (() => { if (!attached) throw new Error('CONTAINER_MOUNT_ABSENT'); return true; }) },
    provenance: { requirePushedCommit() {} },
    attestTrackedTree: options.attestTrackedTree || (() => true),
    janitor: { requireJanitorHealthy() {} },
    environment: {
      canonicalChildEnvironment: () => ({ PATH: '/usr/bin:/bin', PENTACLE_TEST: '1' }),
      probeChildEnvironment: options.probe || (() => { calls.probes += 1; return { schema: 1, global_environment_changed: false }; }),
    },
    quiet: {
      ...quiet,
      inspectNativeStart(root, candidate, environment, authority, runs, now) {
        const receiptDigest = quiet.hash(quiet.readRegular(environment.PENTACLE_GATE_QUIET_RECEIPT));
        run.quiet_start = { attempt_id: ATTEMPT, fd_window_sha256: quiet.hash(fs.readFileSync(allocation)), receipt_sha256: receiptDigest };
        return { claim: { attempt_id: ATTEMPT, observed_finished_at: new Date(now).toISOString() },
          windowDigest: quiet.hash(fs.readFileSync(path.join(path.dirname(environment.PENTACLE_GATE_QUIET_RECEIPT), '..', 'fd-window.json'))),
          receiptDigest, rawDigest: 'e'.repeat(64) };
      },
      requireAllocatedStart: options.requireAllocatedStart || (() => true),
      validateClaimEvidence() { return true; },
    },
    mutations: options.mutations === null ? undefined : {
      attachExisting: () => { calls.attach += 1; attached = true; return { mount: dir, seal: SEAL }; },
      detachRetain: (kind, id, seal) => {
        calls.detach += 1;
        if (options.detachFails) throw new Error('CONTAINER_DETACH_UNPROVEN');
        assert.deepEqual([kind, id, seal], ['evidence', RUN, SEAL]); attached = false;
      },
      releasePreparedAllocation: (runId, token) => {
        calls.release.push([runId, token]);
        if (options.releaseFails) throw new Error('PREPARED_ALLOCATION_CLEANUP:{"checks":[{"name":"lock","status":"failed"}]}');
        fs.rmSync(lock, { force: true }); return { run_id: runId, retained: true };
      },
    },
  };
  return { dir, allocation, lock, calls, outputRoot, boundaries, isAttached: () => attached,
    start: () => launch.runCertified('origin/main', allocation, boundaries) };
}

function persisted(f) {
  const root = path.join(f.outputRoot, ATTEMPT);
  if (!fs.existsSync(root)) return { files: {}, terminal: null };
  const files = {};
  const walk = dir => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.statSync(file).isDirectory()) walk(file); else files[path.relative(root, file)] = fs.readFileSync(file, 'utf8'); } };
  walk(root);
  return { files, terminal: files['terminal.json'] ? JSON.parse(files['terminal.json']) : null };
}

function assertNoToken(f, terminal) {
  assert.ok(!JSON.stringify(terminal).includes(TOKEN), 'returned terminal leaks the lock token');
  for (const [name, content] of Object.entries(persisted(f).files)) assert.ok(!content.includes(TOKEN), `${name} leaks the lock token`);
}

const started = f => f.calls.children.map(call => call.name);

test('valid launch certifies only after verified evidence, owned cleanup and canonical SHA handoff', async () => {
  const f = fixture();
  const terminal = await f.start();
  assert.equal(terminal.disposition, 'CERTIFIED', terminal.error);
  assert.equal(terminal.status, 0);
  assert.deepEqual(started(f), ['observer', 'gate:native-root', 'gate:full']);
  assert.equal(f.calls.children[1].args[2], CANDIDATE, 'native-root must receive the resolved SHA, not the mutable ref');
  assert.deepEqual(f.calls.children[2].args.slice(1), ['gate:full', RUN, TOKEN]);
  assert.equal(f.calls.children[0].timeout, quiet.POLICY.observerBoundMs);
  assert.equal(f.calls.children[1].env.PENTACLE_GATE_QUIET_RECEIPT, path.join(f.outputRoot, ATTEMPT, 'observation', 'receipt.json'));
  assert.equal(f.calls.attach, 1); assert.equal(f.calls.detach, 1); assert.equal(f.isAttached(), false);
  assert.deepEqual(f.calls.release, [], 'gate:full released its own allocation; the facade must not release again');
  assert.equal(fs.existsSync(f.lock), false);
  assert.deepEqual(persisted(f).terminal, terminal, 'durable terminal equals the returned result');
  assertNoToken(f, terminal);
});

test('differing gate code requires its own accepted review and CI', async () => {
  const missing = fixture({ gateCode: GATE_CODE });
  const refused = await missing.start();
  assert.equal(refused.disposition, 'REFUSED');
  assert.equal(refused.error, 'QUIET_START_REVIEW_REFERENCE');
  assert.deepEqual(started(missing), []);
  const bound = fixture({ gateCode: GATE_CODE, gateReviews: reference => ({
    gate_qa: { ...reference('gate-qa', { qa_verdict: 'accept', target_sha: GATE_CODE, report_id: GATE_REPORT }), report_id: GATE_REPORT },
    gate_ci: reference('gate-ci', { head_sha: GATE_CODE, conclusion: 'success' }) }) });
  const terminal = await bound.start();
  assert.equal(terminal.disposition, 'CERTIFIED', terminal.error);
  assert.equal(terminal.reviews.gate_report_id, GATE_REPORT);
});

for (const [label, options, error] of [
  ['missing mutation capability', { mutations: null }, 'CERTIFIED_LAUNCH_MUTATION_CAPABILITY'],
  ['expired window', { packet: { expires_epoch: (NOW - 1000) / 1000 } }, 'CERTIFIED_LAUNCH_WINDOW'],
  ['window shorter than observer plus combined budget', { windowMs: quiet.POLICY.combinedClosingBudgetMs + quiet.POLICY.observerBoundMs - 1 }, 'CERTIFIED_LAUNCH_WINDOW'],
  ['reused attempt', { runs: [{ quiet_start: { attempt_id: ATTEMPT } }] }, 'CERTIFIED_LAUNCH_ATTEMPT_USED'],
]) {
  test(`${label} refuses before any child or allocation`, async () => {
    const f = fixture(options);
    const terminal = await f.start();
    assert.deepEqual([terminal.disposition, terminal.status, terminal.error, terminal.certification], ['REFUSED', 1, error, 'NOT_CERTIFIED']);
    assert.deepEqual(started(f), []);
    assert.equal(f.calls.probes, 0);
  });
}

test('an existing host lock refuses without starting or touching the foreign allocation', async () => {
  const f = fixture();
  fs.writeFileSync(f.lock, 'foreign');
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['REFUSED', 'CERTIFIED_LAUNCH_ALLOCATION_UNRESOLVED']);
  assert.deepEqual(started(f), []); assert.deepEqual(f.calls.release, []);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'foreign');
});

test('missing tool or import in the child environment refuses durably before observation', async () => {
  const f = fixture({ probe: () => { throw new Error('CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb'); } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.failed_phase, terminal.error], ['REFUSED', 'preflight', 'CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb']);
  assert.deepEqual(started(f), []);
  assert.equal(persisted(f).terminal.error, 'CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb');
});

test('observer failure refuses with retained output and no native start', async () => {
  const f = fixture({ children: { observer: () => ({ status: 2, stdout: '{"result":"BUSY_OR_UNAVAILABLE"}\n' }) } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['REFUSED', 'CERTIFIED_LAUNCH_PHASE:observer:2']);
  assert.deepEqual(started(f), ['observer']);
  assert.match(persisted(f).files['observer.stdout.log'], /BUSY_OR_UNAVAILABLE/);
});

test('malformed native handoff retains sanitized output and reports the unowned allocation', async () => {
  const other = 'c'.repeat(64);
  const f = fixture({ children: { 'gate:native-root': () => ({ stdout: `${JSON.stringify({ run_id: RUN, lock_token: TOKEN })}\n${JSON.stringify({ run_id: RUN, lock_token: other })}\n` }) } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['CLEANUP_INCOMPLETE', 'CERTIFIED_LAUNCH_NATIVE_HANDOFF']);
  assert.deepEqual(started(f), ['observer', 'gate:native-root']);
  assert.deepEqual(f.calls.release, [], 'no token was admitted, so nothing is released by the facade');
  assert.deepEqual(terminal.cleanup, [{ name: 'native-allocation', status: 'failed', error: 'CERTIFIED_LAUNCH_ALLOCATION_UNOWNED' }]);
  const log = persisted(f).files['gate:native-root.stdout.log'] ?? persisted(f).files['native-root.stdout.log'];
  assert.match(log, /REDACTED_LOCK_TOKEN/);
  assert.ok(!log.includes(other));
  assertNoToken(f, terminal);
});

test('native failure leaves cleanup to native-root and starts no full gate', async () => {
  const f = fixture({ children: { 'gate:native-root': () => { fs.rmSync(f.lock, { force: true }); return { status: 1, stdout: '', stderr: 'GATE_NATIVE_BUILD_FAILED\n' }; } } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['FAILED', 'CERTIFIED_LAUNCH_PHASE:native-root:1']);
  assert.deepEqual(started(f), ['observer', 'gate:native-root']);
  assert.deepEqual(f.calls.release, []);
});

test('insufficient window at the full boundary releases the facade-owned allocation without starting full', async () => {
  const f = fixture({ requireAllocatedStart: () => { throw new Error('QUIET_START_WINDOW_BUDGET'); } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.failed_phase, terminal.error], ['FAILED', 'full', 'QUIET_START_WINDOW_BUDGET']);
  assert.deepEqual(started(f), ['observer', 'gate:native-root']);
  assert.deepEqual(f.calls.release, [[RUN, TOKEN]]);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(terminal.cleanup[0].owner, 'certified-launch');
  assertNoToken(f, terminal);
});

test('full failure retains the failed result payload', async () => {
  const failed = { run_id: RUN, status: 1, evidence_digest: DIGEST, candidate_sha: CANDIDATE, gate_code_sha: CANDIDATE, errors: ['REPORT_VIEWER_CASE_FAILED'] };
  const f = fixture({ children: { 'gate:full': () => ({ status: 1, stdout: `${JSON.stringify(failed)}\n` }) } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['FAILED', 'CERTIFIED_LAUNCH_PHASE:full:1']);
  assert.equal(terminal.full_result.status, 1);
  assert.deepEqual(JSON.parse(persisted(f).files['full-result.json']).errors, ['REPORT_VIEWER_CASE_FAILED']);
  assert.equal(f.calls.attach, 0, 'a failed full is never verified as certified evidence');
  assert.deepEqual(terminal.cleanup, [{ name: 'prepared-allocation', status: 'passed', owner: 'gate:full' }]);
});

test('full exit 0 with a failed semantic result is never CERTIFIED', async () => {
  const f = fixture({ children: { 'gate:full': () => ({ status: 0, stdout: `${JSON.stringify({ run_id: RUN, status: 1, evidence_digest: DIGEST, candidate_sha: CANDIDATE, gate_code_sha: CANDIDATE })}\n` }) } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.status, terminal.error], ['FAILED', 1, 'CERTIFIED_LAUNCH_FULL_RESULT']);
  assert.equal(terminal.full_result.status, 1);
});

test('verifier rejection preserves the error and detaches the evidence it attached', async () => {
  const f = fixture({ verifyRetainedEvidence: () => { throw new Error('EVIDENCE_RETAINED_DIGEST_DRIFT'); } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['FAILED', 'EVIDENCE_RETAINED_DIGEST_DRIFT']);
  assert.equal(f.isAttached(), false);
  assert.deepEqual(terminal.cleanup.map(check => [check.name, check.status]), [['evidence-detach', 'passed'], ['prepared-allocation', 'passed']]);
});

test('evidence already attached is inspected and never layered over', async () => {
  const f = fixture({ preAttached: true });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['FAILED', 'CONTAINER_STILL_MOUNTED']);
  assert.equal(f.calls.attach, 0); assert.equal(f.calls.detach, 0);
});

test('verifier rejection plus detach failure keeps both errors as CLEANUP_INCOMPLETE', async () => {
  const f = fixture({ detachFails: true, verifyRetainedEvidence: () => { throw new Error('EVIDENCE_RETAINED_DIGEST_DRIFT'); } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['CLEANUP_INCOMPLETE', 'EVIDENCE_RETAINED_DIGEST_DRIFT']);
  assert.deepEqual(terminal.cleanup[0], { name: 'evidence-detach', status: 'failed', error: 'CONTAINER_DETACH_UNPROVEN' });
});

test('killed full child with failed owned release reports original and cleanup errors', async () => {
  const f = fixture({ releaseFails: true, children: { 'gate:full': () => ({ status: null, signal: 'SIGKILL', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), stdout: '', keepLock: true }) } });
  const terminal = await f.start();
  assert.deepEqual([terminal.disposition, terminal.error], ['CLEANUP_INCOMPLETE', 'CERTIFIED_LAUNCH_PHASE:full:ETIMEDOUT']);
  assert.deepEqual(f.calls.release, [[RUN, TOKEN]]);
  assert.equal(terminal.cleanup[0].status, 'failed');
  assert.match(terminal.cleanup[0].error, /^PREPARED_ALLOCATION_CLEANUP:/);
  assertNoToken(f, terminal);
});

test('redaction removes known tokens and unknown lock_token fields', () => {
  assert.equal(launch.redact(`x ${TOKEN} {"lock_token": "zzz"}`, [TOKEN]), 'x [REDACTED_LOCK_TOKEN] {"lock_token": "[REDACTED_LOCK_TOKEN]"}');
  assert.deepEqual(launch.redact({ lock_token: 'q', argv: ['gate:full', TOKEN] }, TOKEN), { lock_token: '[REDACTED_LOCK_TOKEN]', argv: ['gate:full', '[REDACTED_LOCK_TOKEN]'] });
});

test('the facade module does not claim the mutation capability when loaded', () => {
  const source = fs.readFileSync(require.resolve('./certified-launch.cjs'), 'utf8');
  assert.ok(!/storage-capability\.cjs'\)\.claim\(/.test(source));
});
