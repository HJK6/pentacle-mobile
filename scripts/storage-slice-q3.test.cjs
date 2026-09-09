'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('dead reserved recovery disposes artifacts without creating an allocated leak', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-q3-')));
  try {
    const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'storage-slice-q3-worker.cjs')], { cwd: __dirname, env: { ...process.env, HOME: home }, encoding: 'utf8' }));
    assert.equal(result.state, 'reserved');
    assert.equal(result.first_dead_at, '2026-07-18T00:00:00.000Z');
    assert.deepEqual(result.next, { action: 'retain', reason: 'reserved-artifacts-disposed' });
    assert.deepEqual(result.events, ['recover:scratch', 'discard:scratch', 'recover:evidence', 'discard:evidence']);
    assert.equal(result.images_present, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
