'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const test = require('node:test');

const WORKER = path.join(__dirname, 'storage-slice-q8-worker.cjs');
const ENDPOINT_WORKER = path.join(__dirname, 'storage-slice-q8-endpoint-worker.cjs');
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-q8-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const kind of ['runs', 'tickets', 'scheduler']) fs.mkdirSync(path.join(root, kind));
  return root;
}

function reservedRun(id = RUN_ID) {
  return {
    schema: 1,
    id,
    revision: 0,
    state: 'reserved',
    generation: '33333333-3333-4333-8333-333333333333',
    owner: { host: 'hosta', uid: process.getuid(), pid: process.pid },
    candidate_ref: 'a'.repeat(40),
    scratch_image: `${id}.sparsebundle`,
    evidence_image: `${id}.sparsebundle`,
    lock_token_digest: 'b'.repeat(64),
    reserved_at: '2026-07-18T00:00:00.000Z',
    first_dead_at: null,
  };
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: process.env.Q8_DEBUG === '1' ? ['ignore', 'ignore', 'inherit'] : 'ignore' });
    child.once('exit', (code, signal) => resolve(signal ? 99 : code));
  });
}

function runEndpoint(mode, root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENDPOINT_WORKER, mode, root], { stdio: process.env.Q8_DEBUG === '1' ? ['ignore', 'ignore', 'inherit'] : 'ignore' });
    child.once('exit', (code, signal) => resolve(signal ? 99 : code));
  });
}

function claimPath(root, kind, id) {
  const digest = crypto.createHash('sha256').update(`${kind}\0${id}`).digest('hex');
  return path.join(root, kind, `.mutation-${digest}.claim`);
}

function leasePath(root, kind, id) {
  return `${claimPath(root, kind, id)}.guard`;
}

function leaseArtifacts(root, kind) {
  return fs.readdirSync(path.join(root, kind)).filter((name) => name.includes('.claim.guard'));
}

async function waitFor(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, 'Q8_WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Q8 compare-and-swap admits only one writer for one revision', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'runs', `${RUN_ID}.json`), `${JSON.stringify(reservedRun())}\n`);
  const barrier = path.join(root, 'replace-barrier');
  const codes = await Promise.all([
    run(['replace', root, 'runs', RUN_ID, barrier, 'a']),
    run(['replace', root, 'runs', RUN_ID, barrier, 'b']),
  ]);
  assert.equal(codes.filter((code) => code === 0).length, 1);
});

for (const kind of ['runs', 'tickets']) {
  test(`Q8 ${kind} mutation endpoints share one per-object claim`, async (t) => {
    const root = fixture(t);
    const ready = path.join(root, `${kind}.ready`);
    const release = path.join(root, `${kind}.release`);
    const holder = run(['hold', root, kind, RUN_ID, ready, release]);
    await waitFor(ready);
    const blocked = await run(['try', root, kind, RUN_ID]);
    const disjoint = await run(['try', root, kind, OTHER_ID]);
    fs.writeFileSync(release, 'release');
    assert.equal(await holder, 0);
    assert.equal(blocked, 17);
    assert.equal(disjoint, 0);
  });
}

test('Q8 a dead per-object claim is recovered before the next mutation', async (t) => {
  const root = fixture(t);
  assert.equal(await run(['crash', root, 'runs', RUN_ID]), 23);
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 0);
});

for (const boundary of ['exit-before-rename', 'exit-after-rename', 'exit-during-mutation', 'exit-before-release', 'exit-during-release', 'exit-before-lease-release', 'exit-after-lease-extract', 'exit-before-owned-delete', 'exit-during-owned-delete']) {
  test(`Q8 lease recovers after ${boundary}`, async (t) => {
    const root = fixture(t);
    assert.equal(await run([boundary, root, 'runs', RUN_ID]), 23);
    assert.equal(await run(['try', root, 'runs', RUN_ID]), 0);
    assert.equal(await run(['validate', root, 'runs', RUN_ID]), 0);
    assert.deepEqual(leaseArtifacts(root, 'runs'), []);
  });
}

test('Q8 injected takeover preserves the replacement and admits one completion', async (t) => {
  const root = fixture(t);
  const outcome = `${root}.aba.outcome`;
  const completed = `${root}.aba.completed`;
  t.after(() => { for (const file of [outcome, completed]) { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } } });
  assert.equal(await run(['aba-release', root, 'runs', RUN_ID, outcome, completed]), 17);
  assert.equal(JSON.parse(fs.readFileSync(outcome, 'utf8')).replacement_lease_survived, true);
  assert.equal(fs.existsSync(leasePath(root, 'runs', RUN_ID)), true);
  assert.equal(fs.existsSync(completed), false);
  assert.equal(await run(['complete', root, 'runs', RUN_ID, completed, 'successor']), 0);
  assert.deepEqual(fs.readFileSync(completed, 'utf8').trim().split('\n'), ['successor']);
  assert.equal(await run(['validate', root, 'runs', RUN_ID]), 0);
  assert.deepEqual(leaseArtifacts(root, 'runs'), []);
});

test('Q8 expired lease handover admits exactly one concurrent contender', async (t) => {
  const root = fixture(t);
  const lease = leasePath(root, 'runs', RUN_ID);
  fs.mkdirSync(lease, { mode: 0o700 });
  fs.writeFileSync(path.join(lease, 'holder.json'), `${JSON.stringify({ host: os.hostname(), pid: 99999999, startToken: 'expired' })}\n`, { mode: 0o600 });
  const ready = path.join(root, 'race.ready');
  const release = path.join(root, 'race.release');
  const contenders = [
    run(['race', root, 'runs', RUN_ID, ready, release, 'a']),
    run(['race', root, 'runs', RUN_ID, ready, release, 'b']),
  ];
  await waitFor(ready);
  fs.writeFileSync(release, 'release');
  const codes = await Promise.all(contenders);
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(codes.filter((code) => code === 17).length, 1);
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 0);
  assert.deepEqual(leaseArtifacts(root, 'runs'), []);
});

test('Q8 unreadable lease holder is atomically handed over', async (t) => {
  const root = fixture(t);
  const lease = leasePath(root, 'runs', RUN_ID);
  fs.mkdirSync(lease, { mode: 0o700 });
  fs.writeFileSync(path.join(lease, 'holder.json'), '{not-json}\n', { mode: 0o600 });
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 0);
  assert.equal(await run(['validate', root, 'runs', RUN_ID]), 0);
  assert.deepEqual(leaseArtifacts(root, 'runs'), []);
});

test('Q8 live lease holder remains untouched under contention', async (t) => {
  const root = fixture(t);
  const ready = path.join(root, 'lease.ready');
  const release = path.join(root, 'lease.release');
  const holder = run(['lease-hold', root, 'runs', RUN_ID, ready, release]);
  await waitFor(ready);
  const lease = leasePath(root, 'runs', RUN_ID);
  const before = fs.readFileSync(path.join(lease, 'holder.json'), 'utf8');
  const inode = fs.statSync(lease).ino;
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 17);
  assert.equal(fs.readFileSync(path.join(lease, 'holder.json'), 'utf8'), before);
  assert.equal(fs.statSync(lease).ino, inode);
  fs.writeFileSync(release, 'release');
  assert.equal(await holder, 0);
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 0);
});

test('Q8 a hard-linked wrong-object claim cannot authorize takeover', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'forged-claim');
  fs.writeFileSync(source, `${JSON.stringify({ host: os.hostname(), id: OTHER_ID, kind: 'tickets', pid: 99999999, token: '44444444-4444-4444-8444-444444444444' })}\n`, { mode: 0o600 });
  fs.linkSync(source, claimPath(root, 'runs', RUN_ID));
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 17);
  assert.equal(fs.statSync(source).nlink, 2);
});

test('Q8 unreadable or forged claim layout fails closed', async (t) => {
  const root = fixture(t);
  const claim = claimPath(root, 'runs', RUN_ID);
  fs.writeFileSync(claim, `${JSON.stringify({ host: os.hostname(), id: RUN_ID, kind: 'runs', pid: 99999999, token: '55555555-5555-4555-8555-555555555555' })}\n`, { mode: 0o000 });
  assert.equal(await run(['try', root, 'runs', RUN_ID]), 17);
  assert.equal(await run(['validate', root, 'runs', RUN_ID]), 17);
});

test('Q8 active claims remain valid state-layout evidence', async (t) => {
  const root = fixture(t);
  const ready = `${root}.active.ready`;
  const release = `${root}.active.release`;
  t.after(() => { for (const file of [ready, release]) { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } } });
  const holder = run(['hold', root, 'runs', RUN_ID, ready, release]);
  await waitFor(ready);
  assert.equal(await run(['validate', root, 'runs', RUN_ID]), 0);
  fs.writeFileSync(release, 'release');
  assert.equal(await holder, 0);
});

test('Q8 revision mismatch cannot enter the external-effect edge', async (t) => {
  const root = fixture(t);
  const file = path.join(root, 'runs', `${RUN_ID}.json`);
  fs.writeFileSync(file, `${JSON.stringify(reservedRun())}\n`);
  assert.equal(await run(['mismatch', root, 'runs', RUN_ID]), 17);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 0);
});

for (const endpoint of ['discard', 'recover']) {
  test(`Q8 ${endpoint} endpoint holds the run claim through every external effect`, async (t) => {
    const root = fixture(t);
    assert.equal(await runEndpoint(endpoint, root), 0);
  });
}
