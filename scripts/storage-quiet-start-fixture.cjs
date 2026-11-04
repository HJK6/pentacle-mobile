'use strict';

// A valid quiet-start claim for synthetic runs. The storage gate's quiet-start-binding check holds every
// run it verifies to a claim bound to retained evidence, so a fixture run must carry one. The receipt is
// built around the run's own clock and the claim comes from the reviewed certified-start-receipt
// validator itself; nothing here stands in for, or relaxes, that check.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const receipts = require('./certified-start-receipt.cjs');

const { POLICY, hash, canonical } = receipts;

function writeRaw(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  return hash(Buffer.from(content));
}

// Returns the run's `quiet_start` claim (claimed at `reservedAt`, which the run must use as reserved_at)
// and `copyTo(evidenceRoot)`, which retains the claim inputs exactly as a real start does.
function quietStartFixture({ host, uid, candidateSha, gateCodeSha, reservedAt, runId }) {
  const now = Date.parse(reservedAt);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-start-fixture-')));
  try {
    const attempt = crypto.randomUUID();
    const window = { schema: 1, fd_go: true, tell_id: crypto.randomUUID(), from_stream: 'hosta:v2-fd', host, uid,
      candidate_sha: candidateSha, gate_code_sha: gateCodeSha, policy_revision: POLICY.revision, attempt_id: attempt,
      not_before_epoch: (now - 120000) / 1000, expires_epoch: (now + POLICY.combinedClosingBudgetMs + 300000) / 1000 };
    const reviews = {
      source_qa: { report_id: crypto.randomUUID(), qa_verdict: 'accept', target_sha: candidateSha },
      policy_qa: { report_id: crypto.randomUUID(), qa_verdict: 'accept', target_sha: gateCodeSha },
      ci: { head_sha: candidateSha, conclusion: 'success' },
    };
    if (candidateSha !== gateCodeSha) {
      reviews.gate_qa = { report_id: crypto.randomUUID(), qa_verdict: 'accept', target_sha: gateCodeSha };
      reviews.gate_ci = { head_sha: gateCodeSha, conclusion: 'success' };
    }
    for (const [field, value] of Object.entries(reviews)) {
      const name = `review-${field}.json`;
      window[field] = { path: path.join(dir, name), sha256: writeRaw(dir, name, JSON.stringify(value)), ...(value.report_id ? { report_id: value.report_id } : {}) };
    }
    const processChecks = ['process-start', ...Array.from({ length: 6 }, (_, i) => `process-during-${i + 1}`), 'process-end'].map(label => ({ label, ok: true, status: 0, error: null, malformed_rows: 0, identity: { status: 0, error: null }, unavailable: [], heavy: [], excluded_own_ancestor_pids: [100, 10, 1] }));
    const simulatorChecks = ['simulator-start', 'simulator-end'].map(label => ({ label, ok: true, status: 0, error: null, booting: [] }));
    const identities = JSON.stringify([{ pid: 100, executable: '/usr/bin/node', argv: [], exited: false, identity_errno: 0 }, { pid: 10, executable: '/bin/sh', argv: [], exited: false, identity_errno: 0 }, { pid: 1000, executable: '/usr/bin/idle', argv: [], exited: false, identity_errno: 0 }]);
    for (const check of processChecks) {
      writeRaw(dir, `${check.label}-pids.json`, JSON.stringify([{ pid: 100, ppid: 10 }, { pid: 10, ppid: 1 }, { pid: 1, ppid: 0 }, { pid: 1000, ppid: 1 }]));
      check.stdout_sha256 = writeRaw(dir, `${check.label}.stdout.log`, '100 10\n10 1\n1 0\n1000 1\n');
      check.stderr_sha256 = writeRaw(dir, `${check.label}.stderr.log`, '');
      check.identity.stdout_sha256 = writeRaw(dir, `${check.label}-identity.stdout.log`, identities);
      check.identity.stderr_sha256 = writeRaw(dir, `${check.label}-identity.stderr.log`, '');
    }
    for (const check of simulatorChecks) {
      check.stdout_sha256 = writeRaw(dir, `${check.label}.stdout.log`, JSON.stringify({ devices: { fixture: [{ udid: 'fixture', state: 'Shutdown' }] } }));
      check.stderr_sha256 = writeRaw(dir, `${check.label}.stderr.log`, '');
    }
    const iostat = Array.from({ length: 61 }, () => '0 10 0').join('\n') + '\n';
    const iostatStdout = writeRaw(dir, 'iostat.stdout.log', iostat);
    const iostatStderr = writeRaw(dir, 'iostat.stderr.log', '');
    const raw = fs.readdirSync(dir).sort().map(relative => ({ relative, size: fs.statSync(path.join(dir, relative)).size, sha256: hash(fs.readFileSync(path.join(dir, relative))) }));
    fs.writeFileSync(path.join(dir, 'fd-window.json'), JSON.stringify(window));
    const observerSha256 = hash(fs.readFileSync(path.join(__dirname, 'observe-mobile-quiet.cjs')));
    const receipt = {
      schema: 2, certification: 'UNCERTIFIED', native_certification: false, policy_revision: POLICY.revision, observer_pid: 100,
      attempt_id: attempt, host, uid, candidate_sha: candidateSha, gate_code_sha: gateCodeSha, observer_sha256: observerSha256,
      raw_evidence_digest: hash(canonical(raw)), fd_window_go_sha256: hash(fs.readFileSync(path.join(dir, 'fd-window.json'))),
      started_at: new Date(now - 80000).toISOString(), finished_at: new Date(now - 10000).toISOString(),
      observation_elapsed_ms: 60000, median_disk_tps: 10, max_disk_tps: 10,
      disk_intervals: Array.from({ length: 60 }, (_, i) => ({ index: i + 1, elapsed_ms: (i + 1) * 1000, tps: 10, raw: '0 10 0' })),
      process_checks: processChecks, simulator_checks: simulatorChecks,
      iostat: { code: 0, signal: null, observer_bound_ms: POLICY.observerBoundMs, initial_cumulative_row_excluded: true, numeric_rows: 61, parser_errors: [], ownership: { disposition: 'completed', group_alive_after: false }, stdout_sha256: iostatStdout, stderr_sha256: iostatStderr },
      ready: true, result: 'QUIET_60S_PASS',
    };
    fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt));
    const input = receipts.readInputs(path.join(dir, 'receipt.json'));
    const claim = receipts.validateReceipt(input.receipt, input.window, {
      host, uid, candidateSha, gateCodeSha, observerSha256,
      rawDigest: input.rawDigest, windowDigest: input.windowDigest, receiptDigest: input.receiptDigest,
    }, now);
    return {
      claim: { ...claim, run_id: runId },
      copyTo(evidenceRoot) {
        try { return receipts.copyClaimInputs(input, evidenceRoot); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { quietStartFixture };
