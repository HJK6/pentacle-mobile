'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const run = spawnSync(process.execPath, [path.join(__dirname, 'storage-generated-worker.cjs')], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
assert.equal(run.status, 0, run.stderr || run.stdout);
const result = JSON.parse(run.stdout);

test('independent product contains exactly five locked models and 33 states', () => {
  assert.deepEqual(result.models, ['installed', 'run', 'supervisor', 'ticket', 'scheduler']);
  assert.equal(result.states, 33);
});

test('independent product executes every state transition pair', () => assert.equal(result.transition_pairs, 235));

test('independent product injects path, identity, digest, and authority at every state', () => assert.equal(result.argument_products, 132));

test('independent product injects every event class and before/after crash boundary', () => {
  assert.deepEqual({ event_products: result.event_products, event_instances: result.event_instances, crash_boundaries: result.crash_boundaries }, { event_products: 198, event_instances: 1056, crash_boundaries: 14 });
});

// Named, not counted: a new CONTRACT endpoint must be added here deliberately, and each one must refuse
// caller path authority. Listing the reseal endpoints asserts only that refusal, not their wider behaviour.
const CLOSED_ENDPOINTS = [
  'storage:install', 'storage:update', 'storage:reseal-authority', 'storage:inspect-authority-reseal',
  'gate:certified', 'gate:native-root', 'gate:full', 'storage:recover-run', 'storage:recover-system-scratch',
  'storage:discard-scratch', 'storage:reclaim-failed-scratch', 'storage:discard-evidence', 'storage:dispose-unclassified',
  'storage:dispose-absent-backing', 'storage:register-worktree', 'storage:retire-worktree', 'storage:janitor',
  'storage:restore', 'storage:uninstall',
];

test('independent product rejects path authority at every closed endpoint', () => {
  assert.deepEqual(result.endpoint_rejections, Object.fromEntries(CLOSED_ENDPOINTS.map(endpoint => [endpoint, 'FORBIDDEN_AUTHORITY'])));
  assert.equal(result.endpoint_products, CLOSED_ENDPOINTS.length);
});
