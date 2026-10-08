'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateRecord } = require('./storage-state.cjs');
const { POLICY } = require('./certified-start-receipt.cjs');

function reserved() {
  const id = '00000000-0000-4000-8000-000000000001';
  return { schema: 1, id, revision: 0, state: 'reserved', generation: '00000000-0000-4000-8000-000000000002',
    owner: { host: 'hosta', uid: 501, pid: 42 }, candidate_ref: 'a'.repeat(40),
    gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`, lock_token_digest: 'c'.repeat(64),
    reserved_at: '2026-10-08T00:00:00.000Z', first_dead_at: null };
}

function claim(run) {
  return { schema: 1, policy_revision: POLICY.revision, attempt_id: '00000000-0000-4000-8000-000000000003',
    run_id: run.id, host: run.owner.host, uid: run.owner.uid, candidate_sha: run.candidate_ref, gate_code_sha: run.gate_code_sha,
    observer_sha256: 'd'.repeat(64), raw_evidence_digest: 'e'.repeat(64), fd_window_sha256: 'f'.repeat(64),
    receipt_sha256: '1'.repeat(64), observed_finished_at: '2026-10-07T23:59:50.000Z',
    claimed_at: run.reserved_at, fd_window_expires_at: '2026-10-08T07:00:00.000Z' };
}

test('legacy run records remain readable and a new bound initial claim validates', () => {
  const run = reserved();
  assert.equal(validateRecord('runs', run), true);
  assert.equal(validateRecord('runs', { ...run, quiet_start: claim(run) }), true);
});

for (const [field, value] of [['run_id','00000000-0000-4000-8000-000000000004'],['host','hostb'],['uid',502],
  ['candidate_sha','9'.repeat(40)],['gate_code_sha','9'.repeat(40)],['claimed_at','2026-10-08T00:00:01.000Z']]) {
  test(`journal rejects a claim whose ${field} disagrees with the reserved run`, () => {
    const run = reserved();
    assert.throws(() => validateRecord('runs', { ...run, quiet_start: { ...claim(run), [field]: value } }), /AUTHORITY_QUIET_CLAIM_BINDING/);
  });
}

test('actual record replacement forbids late claim attachment and claim edits before any write', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-state.cjs'), 'utf8');
  const start = source.indexOf('function replaceRecordHeld(');
  const end = source.indexOf('\nfunction replaceRecord(', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /\brequire\s*\(/, 'replacement gained an execution dependency requiring inventory review');
  let current = reserved(), writes = 0;
  const replace = new Function('readRecord','IMMUTABLE_FIELDS','validateRecord','assertWriteTimeRunInvariants','atomicJson','recordFile',
    `${body}\nreturn replaceRecordHeld;`)(() => current, { runs: ['quiet_start'] }, validateRecord, () => {}, () => { writes += 1; }, () => '/synthetic/record.json');
  const attached = { ...current, revision: 1, quiet_start: claim(current) };
  assert.throws(() => replace('runs', current.id, 0, attached), /AUTHORITY_QUIET_CLAIM_LATE/);
  assert.equal(writes, 0);
  current = { ...current, quiet_start: claim(current) };
  assert.throws(() => replace('runs', current.id, 0, { ...current, revision: 1, quiet_start: { ...current.quiet_start, receipt_sha256: '2'.repeat(64) } }), /AUTHORITY_IMMUTABLE_FIELD:quiet_start/);
  assert.equal(writes, 0);
  const unchanged = replace('runs', current.id, 0, { ...current, revision: 1 });
  assert.equal(unchanged.revision, 1); assert.equal(writes, 1);
});
