'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const HEALTH_MODULE = './storage-janitor-health.cjs';
const plist = (interval) => `<plist><dict><key>StartInterval</key><integer>${interval}</integer></dict></plist>`;
const report = (id, completedAt, errors = []) => ({
  filename: `${id}.json`,
  value: { schema: 1, report_id: id, mode: 'dry-run', entries: [], errors, completed_at: completedAt },
});

test('janitor health derives two missed intervals from installed configuration', () => {
  const { evaluateJanitorHealth } = require(HEALTH_MODULE);
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const installedAt = '2026-07-23T11:57:00.000Z';
  assert.deepEqual(evaluateJanitorHealth({ now, installedAt, plist: plist(90), reports: [] }), {
    status: 'fresh-install', interval_seconds: 90, threshold_seconds: 180, age_seconds: 180,
  });
  assert.throws(
    () => evaluateJanitorHealth({ now: now + 1000, installedAt, plist: plist(90), reports: [] }),
    (error) => error.name === 'JanitorNeverLaunchedError' && /stale_seconds=181/.test(error.message),
  );
});

test('janitor health distinguishes recent failure, overdue launch, and recent success', () => {
  const { evaluateJanitorHealth } = require(HEALTH_MODULE);
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const installedAt = '2026-07-01T00:00:00.000Z';
  const recent = report('00000000-0000-4000-8000-000000000001', '2026-07-23T11:55:00.000Z');
  const failed = report('00000000-0000-4000-8000-000000000002', '2026-07-23T11:56:00.000Z', [{ kind: 'run', id: 'run', error: 'FORCED' }]);
  assert.equal(evaluateJanitorHealth({ now, installedAt, plist: plist(300), reports: [recent] }).status, 'healthy');
  assert.throws(
    () => evaluateJanitorHealth({ now, installedAt, plist: plist(300), reports: [failed] }),
    (error) => error.name === 'JanitorLastRunFailedError' && /errors=1/.test(error.message),
  );
  assert.throws(
    () => evaluateJanitorHealth({ now, installedAt, plist: plist(300), reports: [report('00000000-0000-4000-8000-000000000003', '2026-07-23T11:49:59.000Z')] }),
    (error) => error.name === 'JanitorOverdueError' && /stale_seconds=601/.test(error.message),
  );
});

test('the last report at the rotation-age boundary remains an overdue durable signal', () => {
  const { evaluateJanitorHealth } = require(HEALTH_MODULE);
  const now = Date.parse('2026-07-31T00:00:00.000Z');
  const boundary = new Date(now - 30 * 86400000).toISOString();
  assert.throws(
    () => evaluateJanitorHealth({ now, installedAt: '2026-06-01T00:00:00.000Z', plist: plist(21600), reports: [report('00000000-0000-4000-8000-000000000004', boundary)] }),
    (error) => error.name === 'JanitorOverdueError',
  );
});

test('prepareNativeRoot checks janitor health before acquiring the host singleton', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
  const prepare = source.slice(source.indexOf('async function prepareNativeRoot'), source.indexOf('function reportViewerResultsBeforeKeyboard'));
  assert.ok(prepare.indexOf('requireJanitorHealthy()') >= 0);
  assert.ok(prepare.indexOf('requireJanitorHealthy()') < prepare.indexOf('acquireHostLock(authority)'));
});
