'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SNAPSHOT_PREFIX = 'pentacle-mobile-gate-code-';
const GIT_SELECTORS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_ALLOW_PROTOCOL',
];

function snapshotRoot(runId) {
  if (!UUID.test(runId || '')) throw new Error('OPAQUE_ID_INVALID');
  return path.join('/private/tmp', `${SNAPSHOT_PREFIX}${runId}`);
}

function gitEnvironment(allowFile = false) {
  const env = { ...process.env };
  for (const name of GIT_SELECTORS) delete env[name];
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  if (allowFile) env.GIT_ALLOW_PROTOCOL = 'file';
  return env;
}

function git(root, args, { allowFile = false } = {}) {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment(allowFile),
  });
  if (result.error || result.status !== 0) throw new Error(`GATE_CODE_SNAPSHOT_GIT:${args[0]}:${result.status}`);
  return String(result.stdout || '').trim();
}

function tryGit(root, args) {
  return spawnSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment(),
  });
}

function gitRaw(root, args) {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', env: gitEnvironment() });
  if (result.error || result.status !== 0) throw new Error(`GATE_CODE_SNAPSHOT_GIT:${args[0]}:${result.status}`);
  return String(result.stdout || '');
}

function inspectSnapshot(runId) {
  const expected = snapshotRoot(runId);
  const actual = fs.realpathSync(expected);
  if (actual !== expected || !fs.lstatSync(actual).isDirectory()) throw new Error('GATE_CODE_SNAPSHOT_IDENTITY');
  const gateCodeSha = git(actual, ['rev-parse', 'HEAD']);
  if (!SHA.test(gateCodeSha)) throw new Error('GATE_CODE_SNAPSHOT_SHA');
  attestSnapshotTree(actual);
  return { root: actual, gateCodeSha };
}

function blobOid(bytes) {
  return crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
}

function attestSnapshotTree(root) {
  if (git(root, ['rev-parse', '--show-object-format']) !== 'sha1') throw new Error('GATE_CODE_SNAPSHOT_OBJECT_FORMAT');
  const entries = gitRaw(root, ['ls-tree', '-rz', '--full-tree', 'HEAD']).split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, separator).split(' ');
    const relative = entry.slice(separator + 1);
    if (separator < 0 || !relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('GATE_CODE_SNAPSHOT_TREE');
    return { mode, type, oid, relative };
  });
  const tracked = new Set();
  const directories = new Set(['']);
  const gitlinks = new Set();
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.relative);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    const target = path.join(root, ...entry.relative.split('/'));
    if (entry.mode === '160000' && entry.type === 'commit') {
      gitlinks.add(entry.relative);
      let stat;
      try { stat = fs.lstatSync(target); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(target).length) throw new Error('GATE_CODE_SNAPSHOT_BYTES');
      continue;
    }
    if (entry.type !== 'blob' || !['100644', '100755', '120000'].includes(entry.mode)) throw new Error('GATE_CODE_SNAPSHOT_TREE');
    tracked.add(entry.relative);
    let bytes;
    let stat;
    try { stat = fs.lstatSync(target); }
    catch { throw new Error('GATE_CODE_SNAPSHOT_BYTES'); }
    if (entry.mode === '120000') {
      if (!stat.isSymbolicLink()) throw new Error('GATE_CODE_SNAPSHOT_BYTES');
      bytes = fs.readlinkSync(target, { encoding: 'buffer' });
    } else {
      if (!stat.isFile() || stat.isSymbolicLink() || Boolean(stat.mode & 0o111) !== (entry.mode === '100755')) throw new Error('GATE_CODE_SNAPSHOT_BYTES');
      bytes = fs.readFileSync(target);
    }
    if (blobOid(bytes) !== entry.oid) throw new Error('GATE_CODE_SNAPSHOT_BYTES');
  }
  const gitMetadata = path.join(root, '.git');
  if (!fs.lstatSync(gitMetadata).isDirectory()) throw new Error('GATE_CODE_SNAPSHOT_IDENTITY');
  const walk = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory)) {
      if (!relative && name === '.git') continue;
      const childRelative = relative ? `${relative}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (gitlinks.has(childRelative)) {
        if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(target).length) throw new Error('GATE_CODE_SNAPSHOT_BYTES');
        continue;
      }
      if (stat.isDirectory()) {
        if (!directories.has(childRelative)) throw new Error('GATE_CODE_SNAPSHOT_UNTRACKED');
        walk(target, childRelative);
      } else if (!tracked.has(childRelative)) throw new Error('GATE_CODE_SNAPSHOT_UNTRACKED');
    }
  };
  walk(root);
  return true;
}

function requireSnapshot(runId, gateCodeSha) {
  if (!SHA.test(gateCodeSha || '')) throw new Error('RUN_GATE_CODE_PROVENANCE_INVALID');
  const snapshot = inspectSnapshot(runId);
  if (snapshot.gateCodeSha !== gateCodeSha) throw new Error('GATE_CODE_SNAPSHOT_SHA');
  return snapshot.root;
}

function createSnapshot(runId, gateCodeSha, repository) {
  if (!SHA.test(gateCodeSha || '')) throw new Error('RUN_GATE_CODE_PROVENANCE_INVALID');
  const target = snapshotRoot(runId);
  if (fs.existsSync(target)) throw new Error('GATE_CODE_SNAPSHOT_COLLISION');
  const source = fs.realpathSync(repository);
  try {
    git(source, ['clone', '--quiet', '--no-checkout', '--no-recurse-submodules', source, target], { allowFile: true });
    git(target, ['checkout', '--quiet', '--detach', gateCodeSha]);
    requireSnapshot(runId, gateCodeSha);
    const protectedResult = spawnSync('/bin/chmod', ['-R', 'a-w', target], { encoding: 'utf8' });
    if (protectedResult.error || protectedResult.status !== 0) throw new Error('GATE_CODE_SNAPSHOT_PROTECT');
    return requireSnapshot(runId, gateCodeSha);
  } catch (error) {
    discardSnapshot(runId);
    throw error;
  }
}

function discardSnapshot(runId) {
  const target = snapshotRoot(runId);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(target) !== target) {
    throw new Error('GATE_CODE_SNAPSHOT_IDENTITY');
  }
  const writableResult = spawnSync('/bin/chmod', ['-R', 'u+w', target], { encoding: 'utf8' });
  if (writableResult.error || writableResult.status !== 0) throw new Error('GATE_CODE_SNAPSHOT_UNPROTECT');
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function snapshotInvocation(repositoryRoot) {
  const actual = fs.realpathSync(repositoryRoot);
  const name = path.basename(actual);
  if (!name.startsWith(SNAPSHOT_PREFIX)) return null;
  const runId = name.slice(SNAPSHOT_PREFIX.length);
  if (!UUID.test(runId) || actual !== snapshotRoot(runId)) throw new Error('GATE_CODE_SNAPSHOT_IDENTITY');
  const snapshot = inspectSnapshot(runId);
  const origin = git(actual, ['config', '--get', 'remote.origin.url']);
  if (!path.isAbsolute(origin)) throw new Error('GATE_CODE_SNAPSHOT_ORIGIN');
  const invokingRepository = fs.realpathSync(origin);
  if (!fs.lstatSync(invokingRepository).isDirectory() || invokingRepository === actual) throw new Error('GATE_CODE_SNAPSHOT_ORIGIN');
  return Object.freeze({ runId, snapshotRoot: actual, invokingRepository, gateCodeSha: snapshot.gateCodeSha });
}

function requirePushedCommit(root, sha) {
  if (!SHA.test(sha || '')) throw new Error('RUN_GATE_CODE_UNPUSHED');
  const advertised = [...new Set(git(root, ['ls-remote', '--heads', '--tags', 'origin'])
    .split('\n').filter(Boolean).map((line) => line.split('\t', 1)[0]))];
  if (advertised.includes(sha)) return sha;
  const missing = advertised.filter((tip) => tryGit(root, ['cat-file', '-e', `${tip}^{commit}`]).status !== 0);
  if (missing.length) git(root, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', ...missing]);
  if (!advertised.some((tip) => tryGit(root, ['merge-base', '--is-ancestor', sha, `${tip}^{commit}`]).status === 0)) {
    throw new Error('RUN_GATE_CODE_UNPUSHED');
  }
  return sha;
}

function requireLiveProvenance(context) {
  const root = context?.invokingRepository;
  const sha = context?.gateCodeSha;
  if (!root || git(root, ['rev-parse', 'HEAD']) !== sha) throw new Error('RUN_GATE_CODE_PROVENANCE_DRIFT');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('RUN_GATE_CODE_DIRTY');
  requirePushedCommit(root, sha);
  return { gate_code_sha: sha, gate_code_tree_clean: true };
}

function fixedStateRoot(home = os.homedir()) {
  return path.join(home, 'Library', 'PentacleMobileStorage', 'State');
}

function readRunBootstrapRecord(runId, stateRoot = fixedStateRoot()) {
  if (!UUID.test(runId || '')) throw new Error('OPAQUE_ID_INVALID');
  const target = path.join(stateRoot, 'runs', `${runId}.json`);
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 2 * 1024 * 1024) throw new Error('GATE_BOOTSTRAP_RUN_INVALID');
    const record = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (record?.id !== runId || !SHA.test(record?.gate_code_sha || '') || record?.gate_code_tree_clean !== true) {
      throw new Error('GATE_BOOTSTRAP_RUN_INVALID');
    }
    return record;
  } finally {
    fs.closeSync(descriptor);
  }
}

function requireFullBootstrap(context, runId, stateRoot = fixedStateRoot()) {
  if (!context || context.runId !== runId) throw new Error('GATE_CODE_SNAPSHOT_IDENTITY');
  const record = readRunBootstrapRecord(runId, stateRoot);
  requireSnapshot(runId, record.gate_code_sha);
  if (context.gateCodeSha !== record.gate_code_sha) throw new Error('GATE_CODE_SNAPSHOT_SHA');
  requireLiveProvenance(context);
  return context;
}

function executeSnapshot(context, endpoint, values) {
  return spawnSync(process.execPath, [path.join(context.snapshotRoot, 'scripts', 'storage-cli.cjs'), endpoint, ...values], {
    cwd: context.snapshotRoot,
    stdio: 'inherit',
  });
}

function resultStatus(result) {
  if (result.error) throw result.error;
  if (Number.isInteger(result.status)) return result.status;
  if (result.signal === 'SIGINT') return 130;
  if (result.signal === 'SIGTERM') return 143;
  return 1;
}

function bootstrapGateEndpoint(endpoint, values, repositoryRoot, dependencies = {}) {
  if (!['gate:native-root', 'gate:full'].includes(endpoint)) return { kind: 'continue', context: null };
  const invocation = snapshotInvocation(repositoryRoot);
  if (invocation) {
    requireLiveProvenance(invocation);
    if (endpoint === 'gate:full') requireFullBootstrap(invocation, values[0], dependencies.stateRoot);
    return { kind: 'continue', context: invocation };
  }

  const execute = dependencies.executeSnapshot || executeSnapshot;
  if (endpoint === 'gate:native-root') {
    if (values.length !== 1 || typeof values[0] !== 'string' || !values[0]) throw new Error('FORBIDDEN_AUTHORITY');
    const runId = (dependencies.generateId || crypto.randomUUID)();
    const gateCodeSha = git(repositoryRoot, ['rev-parse', 'HEAD']);
    const root = createSnapshot(runId, gateCodeSha, repositoryRoot);
    const context = snapshotInvocation(root);
    const result = execute(context, endpoint, values);
    const status = resultStatus(result);
    if (status !== 0) discardSnapshot(runId);
    return { kind: 'reexecuted', status };
  }

  if (values.length !== 2 || !UUID.test(values[0] || '')) throw new Error('FORBIDDEN_AUTHORITY');
  const record = readRunBootstrapRecord(values[0], dependencies.stateRoot);
  const root = requireSnapshot(values[0], record.gate_code_sha);
  const context = snapshotInvocation(root);
  requireFullBootstrap(context, values[0], dependencies.stateRoot);
  return { kind: 'reexecuted', status: resultStatus(execute(context, endpoint, values)) };
}

module.exports = {
  bootstrapGateEndpoint,
  createSnapshot,
  discardSnapshot,
  fixedStateRoot,
  readRunBootstrapRecord,
  requireFullBootstrap,
  requireLiveProvenance,
  requireSnapshot,
  snapshotInvocation,
  snapshotRoot,
};
