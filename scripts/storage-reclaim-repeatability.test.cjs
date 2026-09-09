'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('failed-scratch reclaim releases mounts and reports lock and journal failures across recovery paths', { timeout: 330000 }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-reclaim-repeatability-')));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-reclaim-repeatability-worker.cjs')], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 300000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      direct: ['scratch_discarded', 'scratch_discarded'],
      separate: ['scratch_discarded', 'scratch_discarded'],
      swept: ['scratch_discarded', 'scratch_discarded'],
      refusal: 'CONTAINER_JOURNAL_SEAL_MISMATCH',
      refused_state: 'blocked_unclassified',
      refused_scratch_kept: true,
      body_failure: 'CONTAINER_JOURNAL_SEAL_MISMATCH',
      body_failure_state: 'scratch_discarding',
      body_failure_scratch_kept: true,
      attachments: 0,
      helpers: 0,
      detach_retry_targets: ['/dev/disk999', '/dev/disk999'],
      detach_retry_inventory_timeout_recovered: true,
      failure_paths: ['attach-throw-after-effect', 'foreign-preserved', 'source-drift', 'mount-ambiguity', 'image-ambiguity', 'silent-cleanup', 'retry-exhaustion', 'operation-throw'],
      foreign_lock_sweep: { state: 'scratch_discarded', scratch_kept: false, lock_present: false, errors: 0, accounting: true },
      diagnostic_sweep: { non_mismatch_recorded: true, journal_mismatch_recorded: true, liveness_detach_false_failure: false },
    });
  } finally {
    const cleanup = spawnSync(process.execPath, [path.join(__dirname, 'storage-reclaim-repeatability-worker.cjs'), '--cleanup'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    require('./storage-test-teardown.cjs').disposeIsolatedHome(home);
  }
});
