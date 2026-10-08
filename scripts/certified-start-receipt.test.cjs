'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { POLICY, validateReceipt } = require('./certified-start-receipt.cjs');

function valid() {
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  const expected = { host: 'hosta', uid: 501, candidateSha: 'a'.repeat(40), gateCodeSha: 'b'.repeat(40), observerSha256: 'c'.repeat(64), rawDigest: 'd'.repeat(64), windowDigest: 'e'.repeat(64), receiptDigest: 'f'.repeat(64) };
  const attempt = '00000000-0000-4000-8000-000000000001';
  const window = { schema: 1, fd_go: true, tell_id: '00000000-0000-4000-8000-000000000002', from_stream: 'hosta:v2-fd', host: expected.host, uid: expected.uid, candidate_sha: expected.candidateSha, gate_code_sha: expected.gateCodeSha, policy_revision: POLICY.revision, attempt_id: attempt, not_before_epoch: (now - 100000) / 1000, expires_epoch: (now + POLICY.combinedClosingBudgetMs + 100000) / 1000 };
  const receipt = {
    schema: 2, policy_revision: POLICY.revision, certification: 'UNCERTIFIED', native_certification: false,
    attempt_id: attempt, host: expected.host, uid: expected.uid, candidate_sha: expected.candidateSha,
    gate_code_sha: expected.gateCodeSha, observer_sha256: expected.observerSha256,
    raw_evidence_digest: expected.rawDigest, fd_window_go_sha256: expected.windowDigest,
    started_at: new Date(now - 80000).toISOString(), finished_at: new Date(now - 10000).toISOString(),
    observation_elapsed_ms: 60000, median_disk_tps: 10, max_disk_tps: 10,
    disk_intervals: Array.from({ length: 60 }, (_, i) => ({ index: i + 1, elapsed_ms: (i + 1) * 1000, tps: 10, raw: '0 10 0' })),
    iostat: { code: 0, signal: null, observer_bound_ms: 90000, initial_cumulative_row_excluded: true, numeric_rows: 61, parser_errors: [], ownership: { disposition: 'completed', group_alive_after: false } },
    process_checks: ['process-start', ...Array.from({ length: 6 }, (_, i) => `process-during-${i + 1}`), 'process-end'].map(label => ({ label, ok: true, status: 0, error: null, malformed_rows: 0, identity: { status: 0, error: null }, unavailable: [], heavy: [] })),
    simulator_checks: ['simulator-start', 'simulator-end'].map(label => ({ label, ok: true, status: 0, error: null, booting: [] })), ready: true, result: 'QUIET_60S_PASS',
  };
  return { receipt, window, expected, now };
}
const evaluate = f => validateReceipt(f.receipt, f.window, f.expected, f.now);

test('valid complete receipt binds the one initial claim', () => {
  const f = valid(); const claim = evaluate(f);
  assert.equal(claim.attempt_id, f.receipt.attempt_id);
  assert.equal(claim.receipt_sha256, f.expected.receiptDigest);
  assert.equal(claim.claimed_at, new Date(f.now).toISOString());
});

for (const [name, mutate, reason] of [
  ['generic production preflight', f => { f.receipt = { schema: 1, ok: true }; }, 'SCHEMA_POLICY'],
  ['nine-sample settle', f => { f.receipt.disk_intervals.length = 9; }, 'INCOMPLETE'],
  ['59 intervals', f => { f.receipt.disk_intervals.length = 59; }, 'INCOMPLETE'],
  ['under 60 seconds', f => { f.receipt.observation_elapsed_ms = 59999; }, 'INCOMPLETE'],
  ['wrong host', f => { f.receipt.host = 'hostb'; }, 'HOST'],
  ['wrong uid', f => { f.receipt.uid = 502; }, 'HOST'],
  ['wrong candidate', f => { f.receipt.candidate_sha = '9'.repeat(40); }, 'PIN'],
  ['wrong harness', f => { f.receipt.gate_code_sha = '9'.repeat(40); }, 'PIN'],
  ['wrong raw digest', f => { f.receipt.raw_evidence_digest = '9'.repeat(64); }, 'RAW_DIGEST'],
  ['wrong observer pin', f => { f.receipt.observer_sha256 = '9'.repeat(64); }, 'RAW_DIGEST'],
  ['wrong FD digest', f => { f.receipt.fd_window_go_sha256 = '9'.repeat(64); }, 'WINDOW_BINDING'],
  ['wrong attempt window', f => { f.window.attempt_id = '00000000-0000-4000-8000-000000000003'; }, 'WINDOW_BINDING'],
  ['expired window', f => { f.window.expires_epoch = f.now / 1000; }, 'WINDOW_TIME'],
  ['window not started', f => { f.window.not_before_epoch = (f.now + 1) / 1000; }, 'WINDOW_TIME'],
  ['insufficient complete budget', f => { f.window.expires_epoch = (f.now + POLICY.combinedClosingBudgetMs - 1) / 1000; }, 'WINDOW_BUDGET'],
  ['future receipt', f => { f.receipt.finished_at = new Date(f.now + 1).toISOString(); }, 'CLOCK'],
  ['120001ms old', f => { f.receipt.started_at = new Date(f.now - 200000).toISOString(); f.receipt.finished_at = new Date(f.now - 120001).toISOString(); f.window.not_before_epoch = (f.now - 300000) / 1000; }, 'STALE'],
  ['median2000', f => { f.receipt.disk_intervals.forEach(row => { row.tps = 2000; }); f.receipt.median_disk_tps = 2000; f.receipt.max_disk_tps = 2000; }, 'THRESHOLD'],
  ['peak10001', f => { f.receipt.disk_intervals[59].tps = 10001; f.receipt.max_disk_tps = 10001; }, 'THRESHOLD'],
  ['invented summary', f => { f.receipt.max_disk_tps = 0; }, 'SAMPLE_SUMMARY'],
  ['cumulative row retained', f => { f.receipt.iostat.initial_cumulative_row_excluded = false; }, 'COMPLETION'],
  ['terminated command', f => { f.receipt.iostat.ownership.disposition = 'terminated'; }, 'COMPLETION'],
  ['surviving process group', f => { f.receipt.iostat.ownership.group_alive_after = true; }, 'COMPLETION'],
  ['parse error', f => { f.receipt.iostat.parser_errors = ['malformed']; }, 'COMPLETION'],
  ['missing process checks', f => { f.receipt.process_checks = []; }, 'PROCESS_SIMULATOR'],
  ['failed process check', f => { f.receipt.process_checks[3].ok = false; }, 'PROCESS_SIMULATOR'],
  ['missing simulator check', f => { f.receipt.simulator_checks.pop(); }, 'PROCESS_SIMULATOR'],
  ['failed readiness', f => { f.receipt.ready = false; }, 'NOT_READY'],
]) test(`refuses ${name}`, () => { const f = valid(); mutate(f); assert.throws(() => evaluate(f), new RegExp(`QUIET_START_${reason}`)); });

test('exact peak10000 and age120000 boundaries remain valid', () => {
  const f = valid(); f.receipt.disk_intervals[59].tps = 10000; f.receipt.max_disk_tps = 10000;
  f.receipt.started_at = new Date(f.now - 200000).toISOString(); f.receipt.finished_at = new Date(f.now - 120000).toISOString(); f.window.not_before_epoch = (f.now - 300000) / 1000;
  assert.equal(evaluate(f).attempt_id, f.receipt.attempt_id);
});

module.exports = { valid };
