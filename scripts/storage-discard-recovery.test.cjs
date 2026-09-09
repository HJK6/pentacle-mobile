'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('journal-authorized discard recovery closes both states with mounted and unmounted unusable containers', {
  skip: process.platform !== 'darwin' ? 'requires hdiutil' : false,
  timeout: 420000,
}, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-discard-recovery-')));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-discard-recovery-worker.cjs')], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 390000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      recovered: ['scratch:mounted:scratch_discarded', 'scratch:unmounted:scratch_discarded', 'evidence:mounted:evidence_discarded', 'evidence:unmounted:evidence_discarded'],
      identity_refusal: 'CONTAINER_JOURNAL_IMAGE_IDENTITY_MISMATCH',
      identity_image_kept: true,
      detach_refusal: true,
      detach_attempts: 5,
      detach_discards: 0,
    });
  } finally {
    require('./storage-test-teardown.cjs').disposeIsolatedHome(home);
  }
});
