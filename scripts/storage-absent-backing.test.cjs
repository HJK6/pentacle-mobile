'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('absent-backing disposition drives blocked_unclassified to terminal without deletion and the sweep tolerates the absence', { timeout: 330000 }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-absent-backing-')));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-absent-backing-worker.cjs')], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 300000,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed, {
      // Piece 1 - the liveness sweep no longer errors on a provably-absent image (under-24h window).
      sweep_before_errors: [],
      stayed_blocked: true,
      // AC1 - a supported authority-gated verb completes disposition to the terminal backing_absent state.
      disposed_state: 'backing_absent',
      disposed_shape_ok: true,
      // AC1 - reason/authorization are immutable: a terminal record cannot be re-dispositioned.
      second_dispose: 'ABSENT_BACKING_NOT_AUTHORIZED:state/backing_absent',
      // AC4 - after disposition the sweep is fully clean and the absence reconciles.
      sweep_after_error_count: 0,
      reconciled_absent: true,
      // AC2/AC3 - a present image is refused and NOT deleted (attach path unchanged, no deletion widening).
      present_refusal: 'ABSENT_BACKING_PRESENT:scratch',
      present_kept: true,
      // AC2 - partial absence (one image present) is refused deliberately; the present image is untouched.
      partial_refusal: 'ABSENT_BACKING_PRESENT:evidence',
      partial_evidence_kept: true,
      // Fail-closed: an empty reason is rejected before anything is inspected.
      reason_refusal: 'ABSENT_BACKING_REASON_REQUIRED',
    });
  } finally {
    const cleanup = spawnSync(process.execPath, [path.join(__dirname, 'storage-absent-backing-worker.cjs'), '--cleanup'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    require('./storage-test-teardown.cjs').disposeIsolatedHome(home);
  }
});
