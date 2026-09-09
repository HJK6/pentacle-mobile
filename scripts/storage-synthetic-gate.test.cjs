'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// The cap is a HANG detector, not a performance SLA, and it is sized against SUITE CONCURRENCY.
// Measured standalone on a quiet development host: this worker costs ~23 s (synthetic gate) / ~40 s (q5),
// identical on this branch and at main. The old 110 s spawn cap was ~3x standalone, which the
// suite outgrew: node --test runs its files concurrently and every hdiutil create/attach/detach
// in the suite serialises against the same DiskArbitration queue, so a worker that takes 23 s
// alone can take minutes alongside the others. Two runs died on that cap while both workers were
// provably not hung. Raised deliberately; if you need to catch a slowdown, measure it standalone
// against the numbers above rather than shrinking this back.
test('two live synthetic gate invocations leave no scratch, bounded evidence, and flat state bytes', { timeout: 330000 }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-storage-live-')));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-synthetic-worker.cjs')], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 300000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    const controls = {
      // The wedge: all three dead failures are still retained by the automatic path under 24 hours.
      reclaim_retained_under_24h: 3,
      // NEGATIVE CONTROL - the retention-protected failure is refused and its image survives the refusal.
      reclaim_refused: 'FAILED_SCRATCH_RECLAMATION_NOT_AUTHORIZED',
      reclaim_protected_image_intact: true,
      // POSITIVE CONTROL - the authorised failure reaches a recorded terminal discard, its scratch is
      // really gone, its evidence is really kept, and the journal carries the authorisation.
      reclaim_state: 'scratch_discarded',
      reclaim_scratch_image_gone: true,
      reclaim_evidence_image_kept: true,
      reclaim_record_authorised: true,
    };
    assert.deepEqual({ ...evidence, state_before: 1, state_after: 1 }, { invocations: 2, wrapper_invocations: 2, terminal_journals: 2, live_scratch: 0, scratch_images: 0, evidence_images: 0, evidence_bounded: true, state_before: 1, state_after: 1, ...controls });
    assert.ok(evidence.state_before > 0);
    assert.equal(evidence.state_after, evidence.state_before);
  } finally {
    require('./storage-test-teardown.cjs').disposeIsolatedHome(home);
  }
});
