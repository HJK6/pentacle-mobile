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

test('independent product rejects path authority at every closed endpoint', () => assert.equal(result.endpoint_products, 16));
