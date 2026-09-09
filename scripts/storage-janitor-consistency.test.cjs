'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { reconcileRunImages } = require('./storage-janitor-consistency.cjs');

const run = (id, state) => ({ id, state });

test('journal/image reconciliation names missing and unauthorized backing relations', () => {
  const runs = [
    run('00000000-0000-4000-8000-000000000001', 'allocated'),
    run('00000000-0000-4000-8000-000000000002', 'scratch_discarded'),
    run('00000000-0000-4000-8000-000000000003', 'blocked_unclassified'),
  ];
  const result = reconcileRunImages(runs, {
    scratch: ['00000000-0000-4000-8000-000000000001.sparsebundle', 'ffffffff-ffff-4fff-8fff-ffffffffffff.sparsebundle'],
    evidence: ['00000000-0000-4000-8000-000000000001.sparsebundle', '00000000-0000-4000-8000-000000000002.sparsebundle'],
  });
  assert.equal(result.action, 'mismatch');
  assert.equal(result.reason, 'runs=3;evidence_images=2;expected_evidence=3;scratch_images=2;expected_scratch=2');
  assert.deepEqual(result.missing_evidence, ['00000000-0000-4000-8000-000000000003']);
  assert.deepEqual(result.missing_scratch, ['00000000-0000-4000-8000-000000000003']);
  assert.deepEqual(result.unexpected_scratch, ['ffffffff-ffff-4fff-8fff-ffffffffffff']);
  assert.deepEqual(result.unexpected_evidence, []);
});

test('a reconciling corpus reports the same global arithmetic as the host checker', () => {
  const runs = [
    run('00000000-0000-4000-8000-000000000001', 'allocated'),
    run('00000000-0000-4000-8000-000000000002', 'scratch_discarded'),
  ];
  const images = {
    scratch: ['00000000-0000-4000-8000-000000000001.sparsebundle'],
    evidence: runs.map((entry) => `${entry.id}.sparsebundle`),
  };
  assert.deepEqual(reconcileRunImages(runs, images), {
    kind: 'consistency',
    id: 'journal-images',
    action: 'reconciled',
    reason: 'runs=2;evidence_images=2;expected_evidence=2;scratch_images=1;expected_scratch=1',
    missing_evidence: [],
    missing_scratch: [],
    unexpected_evidence: [],
    unexpected_scratch: [],
  });
});
