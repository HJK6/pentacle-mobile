'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const bootstrap = require('./storage-cli-bootstrap.cjs');

function git(root, args) {
  return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repositoryFixture(files = { 'scripts/storage-cli.cjs': '#!/usr/bin/env node\nprocess.exit(0);\n' }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-cli-bootstrap-'));
  const origin = path.join(temp, 'origin.git');
  const checkout = path.join(temp, 'checkout');
  execFileSync('/usr/bin/git', ['init', '--bare', '--quiet', origin]);
  execFileSync('/usr/bin/git', ['init', '--quiet', '-b', 'main', checkout]);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(checkout, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  git(checkout, ['add', '.']);
  git(checkout, ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'gate']);
  git(checkout, ['remote', 'add', 'origin', origin]);
  git(checkout, ['push', '--quiet', '-u', 'origin', 'main']);
  return { temp, checkout, sha: git(checkout, ['rev-parse', 'HEAD']) };
}

test('a snapshot derives its UUID and invoking checkout, then binds clean pushed HEAD', () => {
  const fixture = repositoryFixture();
  const runId = crypto.randomUUID();
  try {
    const root = bootstrap.createSnapshot(runId, fixture.sha, fixture.checkout);
    const context = bootstrap.snapshotInvocation(root);
    assert.equal(context.runId, runId);
    assert.equal(context.snapshotRoot, root);
    assert.equal(context.invokingRepository, fs.realpathSync(fixture.checkout));
    assert.equal(context.gateCodeSha, fixture.sha);
    assert.deepEqual(bootstrap.requireLiveProvenance(context), { gate_code_sha: fixture.sha, gate_code_tree_clean: true });
    fs.writeFileSync(path.join(fixture.checkout, 'dirty.txt'), 'drift\n');
    assert.throws(() => bootstrap.requireLiveProvenance(context), /RUN_GATE_CODE_DIRTY/);
  } finally {
    bootstrap.discardSnapshot(runId);
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('full bootstrap binds the run record to the exact snapshot before re-exec', () => {
  const fixture = repositoryFixture();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-cli-state-'));
  const runId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.join(stateRoot, 'runs'));
    fs.writeFileSync(path.join(stateRoot, 'runs', `${runId}.json`), `${JSON.stringify({ id: runId, gate_code_sha: fixture.sha, gate_code_tree_clean: true })}\n`);
    const root = bootstrap.createSnapshot(runId, fixture.sha, fixture.checkout);
    const context = bootstrap.requireFullBootstrap(bootstrap.snapshotInvocation(root), runId, stateRoot);
    assert.equal(context.gateCodeSha, fixture.sha);
    fs.writeFileSync(path.join(stateRoot, 'runs', `${runId}.json`), `${JSON.stringify({ id: runId, gate_code_sha: 'f'.repeat(40), gate_code_tree_clean: true })}\n`);
    assert.throws(() => bootstrap.requireFullBootstrap(context, runId, stateRoot), /GATE_CODE_SNAPSHOT_SHA/);
  } finally {
    bootstrap.discardSnapshot(runId);
    fs.rmSync(fixture.temp, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('native bootstrap discards a failed pre-import snapshot and retains a successful one', () => {
  const fixture = repositoryFixture();
  const failedId = crypto.randomUUID();
  const passedId = crypto.randomUUID();
  try {
    const failed = bootstrap.bootstrapGateEndpoint('gate:native-root', ['HEAD'], fixture.checkout, {
      generateId: () => failedId,
      executeSnapshot: () => ({ status: 17, signal: null }),
    });
    assert.equal(failed.status, 17);
    assert.equal(fs.existsSync(bootstrap.snapshotRoot(failedId)), false);

    const passed = bootstrap.bootstrapGateEndpoint('gate:native-root', ['HEAD'], fixture.checkout, {
      generateId: () => passedId,
      executeSnapshot: () => ({ status: 0, signal: null }),
    });
    assert.equal(passed.status, 0);
    assert.equal(bootstrap.requireSnapshot(passedId, fixture.sha), bootstrap.snapshotRoot(passedId));
  } finally {
    bootstrap.discardSnapshot(failedId);
    bootstrap.discardSnapshot(passedId);
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('an isolated gate snapshot never resolves YAML-backed worktree policy', () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const liveBootstrapSource = fs.readFileSync(path.join(__dirname, 'storage-cli-bootstrap.cjs'), 'utf8');
  const bootstrapSource = liveBootstrapSource
    .replace('const runId = (dependencies.generateId || crypto.randomUUID)();', `const runId = '${runId}';`);
  assert.notEqual(bootstrapSource, liveBootstrapSource, 'fixture must pin the snapshot id');
  const fixture = repositoryFixture({
    'scripts/storage-cli.cjs': fs.readFileSync(path.join(__dirname, 'storage-cli.cjs')),
    'scripts/gate-preflight.cjs': `module.exports = { requirePluginIntegrity() {}, beforeBootstrap(_, action) { return action(); } };`,
    'scripts/owned-process.cjs': `module.exports = { isOwnedInvocation() { return true; } };`,
    'scripts/storage-cli-bootstrap.cjs': bootstrapSource,
    'scripts/storage-authority.cjs': fs.readFileSync(path.join(__dirname, 'storage-authority.cjs')),
    'scripts/storage-capability.cjs': fs.readFileSync(path.join(__dirname, 'storage-capability.cjs')),
    'scripts/storage-gate.cjs': `'use strict';\nmodule.exports = { bind: () => ({}) };\n`,
    'scripts/storage-janitor.cjs': `'use strict';\nmodule.exports = { bind: () => ({}) };\n`,
    'scripts/storage-scheduler.cjs': `'use strict';\nmodule.exports = { bind: () => ({}) };\n`,
    'scripts/storage-worktrees.cjs': `'use strict';\nrequire('yaml');\nmodule.exports = { bind: () => ({}) };\n`,
  });
  try {
    assert.equal(fs.existsSync(path.join(fixture.checkout, 'node_modules')), false);
    assert.equal(fs.existsSync(bootstrap.snapshotRoot(runId)), false);
    const result = spawnSync(process.execPath, [path.join(fixture.checkout, 'scripts', 'storage-cli.cjs'), 'gate:native-root', '../forbidden'], {
      cwd: fixture.checkout,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FORBIDDEN_AUTHORITY/);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|yaml/);
    assert.equal(fs.existsSync(bootstrap.snapshotRoot(runId)), false, 'failed snapshot was discarded');
  } finally {
    if (fs.existsSync(bootstrap.snapshotRoot(runId))) bootstrap.discardSnapshot(runId);
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('snapshot discard refuses a redirected deterministic path before recursive mutation', () => {
  const runId = crypto.randomUUID();
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-cli-victim-'));
  const marker = path.join(victim, 'preserved');
  fs.writeFileSync(marker, 'yes\n');
  fs.symlinkSync(victim, bootstrap.snapshotRoot(runId));
  try {
    assert.throws(() => bootstrap.discardSnapshot(runId), /GATE_CODE_SNAPSHOT_IDENTITY/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'yes\n');
  } finally {
    fs.unlinkSync(bootstrap.snapshotRoot(runId));
    fs.rmSync(victim, { recursive: true, force: true });
  }
});

test('same-ID replacement cannot hide altered executable bytes with index flags', () => {
  const fixture = repositoryFixture();
  const runId = crypto.randomUUID();
  const root = bootstrap.createSnapshot(runId, fixture.sha, fixture.checkout);
  const held = `${root}.held`;
  try {
    fs.renameSync(root, held);
    execFileSync('/usr/bin/git', ['clone', '--quiet', fixture.checkout, root]);
    fs.writeFileSync(path.join(root, 'scripts', 'storage-cli.cjs'), '#!/usr/bin/env node\nprocess.exit(23);\n');
    git(root, ['update-index', '--assume-unchanged', 'scripts/storage-cli.cjs']);
    assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
    execFileSync('/bin/chmod', ['-R', 'a-w', root]);
    assert.throws(() => bootstrap.requireSnapshot(runId, fixture.sha), /GATE_CODE_SNAPSHOT_BYTES/);
  } finally {
    bootstrap.discardSnapshot(runId);
    execFileSync('/bin/chmod', ['-R', 'u+w', held]);
    fs.rmSync(held, { recursive: true, force: true });
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('ambient Git selectors cannot redirect the attestation oracle', () => {
  const fixture = repositoryFixture();
  const runId = crypto.randomUUID();
  const selectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR'];
  const prior = Object.fromEntries(selectors.map((name) => [name, process.env[name]]));
  try {
    bootstrap.createSnapshot(runId, fixture.sha, fixture.checkout);
    fs.writeFileSync(path.join(fixture.checkout, 'redirect.txt'), 'new head\n');
    git(fixture.checkout, ['add', 'redirect.txt']);
    git(fixture.checkout, ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'redirect']);
    process.env.GIT_DIR = path.join(fixture.checkout, '.git');
    process.env.GIT_WORK_TREE = fixture.checkout;
    process.env.GIT_INDEX_FILE = path.join(fixture.temp, 'missing-index');
    process.env.GIT_OBJECT_DIRECTORY = path.join(fixture.checkout, '.git', 'objects');
    process.env.GIT_COMMON_DIR = path.join(fixture.checkout, '.git');
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(fixture.temp, 'missing-objects');
    assert.equal(bootstrap.requireSnapshot(runId, fixture.sha), bootstrap.snapshotRoot(runId));
  } finally {
    for (const name of selectors) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
    bootstrap.discardSnapshot(runId);
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('a gitlink accepts only absence or an empty real directory', () => {
  const fixture = repositoryFixture();
  const runId = crypto.randomUUID();
  try {
    git(fixture.checkout, ['update-index', '--add', '--cacheinfo', `160000,${fixture.sha},linked`]);
    git(fixture.checkout, ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'gitlink']);
    git(fixture.checkout, ['push', '--quiet', 'origin', 'main']);
    const sha = git(fixture.checkout, ['rev-parse', 'HEAD']);
    const root = bootstrap.createSnapshot(runId, sha, fixture.checkout);
    execFileSync('/bin/chmod', ['u+w', root]);
    fs.rmdirSync(path.join(root, 'linked'));
    fs.symlinkSync(path.join(fixture.temp, 'missing-gitlink-target'), path.join(root, 'linked'));
    execFileSync('/bin/chmod', ['a-w', root]);
    assert.throws(() => bootstrap.requireSnapshot(runId, sha), /GATE_CODE_SNAPSHOT_BYTES/);
  } finally {
    bootstrap.discardSnapshot(runId);
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test('the real CLI reaches the gate bootstrap before loading storage policy', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-cli.cjs'), 'utf8');
  const entry = source.indexOf('bootstrapGateEndpoint');
  assert.ok(entry > 0);
  for (const module of ['storage-authority.cjs', 'storage-gate.cjs', 'storage-janitor.cjs']) {
    assert.ok(entry < source.indexOf(module), `${module} loaded before bootstrap`);
  }
  assert.doesNotMatch(source, /PENTACLE_GATE_.*BOOTSTRAP|BOOTSTRAP.*PENTACLE_GATE_/);
});

test('file transport is scoped to snapshot creation, not remote provenance proof', () => {
  const source = fs.readFileSync(path.join(__dirname, 'storage-cli-bootstrap.cjs'), 'utf8');
  assert.equal((source.match(/GIT_ALLOW_PROTOCOL/g) || []).length, 2, 'selector removal plus clone-only assignment');
  assert.match(source, /clone[^\n]+\{ allowFile: true \}/);
  const pushed = source.slice(source.indexOf('function requirePushedCommit'));
  assert.doesNotMatch(pushed, /allowFile:\s*true/);
});
