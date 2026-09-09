'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const scheduler = require('./storage-scheduler.cjs');
const WORKER = path.join(__dirname, 'storage-slice-q6-worker.cjs');

function runWorker(home, scenario, args = []) {
  return spawnSync(process.execPath, [WORKER, scenario, ...args], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30000,
  });
}

async function waitFor(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, 'Q6_WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotSelected(home) {
  const support = path.join(home, 'Library', 'PentacleMobileStorage');
  const selected = [
    path.join(support, 'State', 'runs'), path.join(support, 'State', 'tickets'), path.join(support, 'State', 'scheduler'),
    path.join(support, 'State', 'gate.lock'), path.join(support, 'State', 'disabled'),
    path.join(support, 'ScratchImages'), path.join(support, 'EvidenceImages'),
  ];
  const snapshot = {};
  const visit = (target) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    const relative = path.relative(home, target);
    snapshot[relative] = {
      type: stat.isDirectory() ? 'directory' : 'file', inode: String(stat.ino), size: stat.size,
      ...(stat.isFile() ? { sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') } : {}),
    };
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
  };
  for (const target of selected) visit(target);
  return snapshot;
}

test('plist ownership is exact to the active candidate digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-q6-plist-'));
  try {
    const target = path.join(root, 'janitor.plist');
    fs.writeFileSync(target, scheduler.renderPlist());
    const digest = crypto.createHash('sha256').update(scheduler.renderPlist()).digest('hex');
    assert.equal(scheduler.plistOwned(target, digest), true);
    assert.equal(scheduler.plistOwned(target, 'a'.repeat(64)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('smoke reports bind transaction, generation, and candidate digest', () => {
  const expected = { transaction_id: '00000000-0000-4000-8000-000000000000', generation: '00000000-0000-4000-8000-000000000001', candidate_digest: 'a'.repeat(64) };
  const report = { schema: 1, report_id: '00000000-0000-4000-8000-000000000002', mode: 'dry-run', entries: [], errors: [], completed_at: '2026-07-17T00:00:01.000Z', ...expected };
  assert.equal(scheduler.validateSmokeReport(report, `${report.report_id}.json`, Date.parse('2026-07-17T00:00:00.000Z'), expected), true);
  for (const field of Object.keys(expected)) { const unbound = { ...report }; delete unbound[field]; assert.throws(() => scheduler.validateSmokeReport(unbound, `${report.report_id}.json`, Date.parse('2026-07-17T00:00:00.000Z'), expected), /SCHEDULER_SMOKE/); }
});

for (const scenario of ['digest-mismatch', 'bound-forward', 'janitor-binding', 'bootout-failure', 'bootout-unverified']) test(`scheduler recovery exact transaction boundary: ${scenario}`, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pentacle-q6-${scenario}-`)));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-slice-q6-worker.cjs'), scenario], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('dry-run starts only the dead-owner clock and leaves every deletion-owned byte unchanged', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-q6-dry-run-')));
  try {
    const seeded = runWorker(home, 'janitor-seed');
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const runId = seeded.stdout.trim();
    const before = snapshotSelected(home);
    const result = runWorker(home, 'janitor-once', ['2026-07-22T00:00:00.000Z']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const after = snapshotSelected(home);
    const stateRoot = path.join(home, 'Library', 'PentacleMobileStorage', 'State');
    const runKey = path.relative(home, path.join(stateRoot, 'runs', `${runId}.json`));
    delete before[runKey];
    delete after[runKey];
    assert.deepEqual(after, before);
    const observed = JSON.parse(fs.readFileSync(path.join(stateRoot, 'runs', `${runId}.json`), 'utf8'));
    assert.equal(observed.first_dead_at, '2026-07-22T00:00:00.000Z');
    assert.equal(observed.state, 'blocked_unclassified');
    assert.equal(fs.existsSync(path.join(stateRoot, 'janitor.lock')), false);
    const reports = fs.readdirSync(path.join(stateRoot, 'reports')).filter((name) => name.endsWith('.json'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(stateRoot, 'reports', reports[0]), 'utf8'));
    assert.deepEqual(report.entries.filter((entry) => entry.action === 'observe-dead').map((entry) => entry.id), [runId]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('janitor singleton admits one holder, names the refused contender, and releases cleanly', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-q6-singleton-')));
  try {
    const initialized = runWorker(home, 'janitor-init');
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const ready = path.join(home, 'holder.ready');
    const release = path.join(home, 'holder.release');
    const holder = new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, 'janitor-hold', ready, release, '2026-07-22T00:00:00.000Z'], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });
    await waitFor(ready);
    const contender = runWorker(home, 'janitor-contender', ['2026-07-22T00:00:00.000Z']);
    assert.equal(contender.status, 0, contender.stderr || contender.stdout);
    assert.equal(contender.stdout.trim(), 'JANITOR_ALREADY_RUNNING');
    fs.writeFileSync(release, 'release');
    assert.deepEqual(await holder, { code: 0, signal: null, stderr: '' });
    const lock = path.join(home, 'Library', 'PentacleMobileStorage', 'State', 'janitor.lock');
    assert.equal(fs.existsSync(lock), false);
    const successor = runWorker(home, 'janitor-once', ['2026-07-22T00:00:00.000Z']);
    assert.equal(successor.status, 0, successor.stderr || successor.stdout);
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

for (const [phase, jsonCountBeforeRecovery, tempCount] of [
  ['report-before-rename', 1, 1],
  ['report-after-rename', 2, 0],
  ['report-after-directory-fsync', 2, 0],
]) test(`janitor reports stay atomic across ${phase}`, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pentacle-q6-${phase}-`)));
  try {
    const initialized = runWorker(home, 'janitor-init');
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const reports = path.join(home, 'Library', 'PentacleMobileStorage', 'State', 'reports');
    const priorId = '99999999-9999-4999-8999-999999999999';
    const prior = { schema: 1, report_id: priorId, mode: 'dry-run', entries: [], errors: [], completed_at: '2026-07-21T23:59:59.000Z' };
    fs.writeFileSync(path.join(reports, `${priorId}.json`), `${JSON.stringify(prior)}\n`);

    const crashed = runWorker(home, phase, ['2026-07-22T00:00:00.000Z']);
    assert.equal(crashed.status, 23, crashed.stderr || crashed.stdout);
    const names = fs.readdirSync(reports);
    const jsonNames = names.filter((name) => name.endsWith('.json'));
    assert.equal(jsonNames.length, jsonCountBeforeRecovery);
    assert.equal(names.filter((name) => name.endsWith('.tmp')).length, tempCount);
    for (const name of jsonNames) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(reports, name), 'utf8')), `${name} must be complete JSON`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reports, `${priorId}.json`), 'utf8')), prior);

    const recovered = runWorker(home, 'janitor-once', ['2026-07-22T00:00:00.000Z']);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredNames = fs.readdirSync(reports);
    assert.equal(recoveredNames.some((name) => name.endsWith('.tmp')), false);
    for (const name of recoveredNames.filter((entry) => entry.endsWith('.json'))) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(reports, name), 'utf8')), `${name} must remain complete JSON`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('known SHA-256 bytes survive publication, journal finalization, reattach, and retained verification', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-q6-evidence-chain-')));
  try {
    const result = runWorker(home, 'evidence-chain');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.payload_sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(evidence.state, 'scratch_discarded');
    assert.match(evidence.evidence_digest, /^[0-9a-f]{64}$/);
    assert.ok(evidence.attachments >= 3, 'publication and retained verification must independently resolve the evidence image');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('unknown evidence blocks janitor discard and preserves identical bytes and image identity', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-q6-unknown-')));
  try {
    const result = runWorker(home, 'unknown-preserve');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { error: 'EVIDENCE_RETAINED_DIGEST_DRIFT', preserved: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
