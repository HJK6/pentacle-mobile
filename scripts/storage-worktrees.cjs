'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout, generatedId } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const { createRecord, replaceRecord, withRecordMutation } = state.bind(mutationCapability);
const { canonicalIdentity, readRecord, validateInstalledAuthority } = state;

const DAY = 86400000;
const STATUSES = Object.freeze(['backlog', 'analysis', 'ready_for_dev', 'in_progress', 'needs_qa', 'blocked', 'completed', 'deprecated']);
const TERMINAL = new Set(['completed', 'deprecated']);

function git(repository, args) {
  const result = spawnSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`GIT_PROOF_FAILED:${args[0]}:${String(result.stderr || result.error || '').trim()}`);
  return String(result.stdout || '').trim();
}

function removalLockTargets(ticket, resolved) {
  const gitDirectory = git(resolved.record.resolved, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonDirectory = git(resolved.record.resolved, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const branchRef = git(resolved.record.resolved, ['symbolic-ref', 'HEAD']);
  if (branchRef !== `refs/heads/${ticket.branch}`) throw new Error('WORKTREE_BRANCH_REF_DRIFT');
  const canonicalCommon = fs.realpathSync(commonDirectory);
  const canonicalGit = fs.realpathSync(gitDirectory);
  if (canonicalGit !== canonicalCommon && !canonicalGit.startsWith(`${canonicalCommon}${path.sep}`)) throw new Error('WORKTREE_GITDIR_ESCAPE');
  const branchLock = path.resolve(canonicalCommon, `${branchRef}.lock`);
  const refsRoot = path.join(canonicalCommon, 'refs', 'heads');
  if (!branchLock.startsWith(`${refsRoot}${path.sep}`)) throw new Error('WORKTREE_BRANCH_REF_ESCAPE');
  return [branchLock, path.join(canonicalGit, 'HEAD.lock'), path.join(canonicalGit, 'index.lock')].sort();
}

function acquireRemovalLocks(ticket, resolved) {
  const targets = removalLockTargets(ticket, resolved);
  const token = crypto.randomBytes(32).toString('hex');
  const held = [];
  try {
    for (const target of targets) {
      const descriptor = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${token}\n`);
      fs.fsyncSync(descriptor);
      held.push({ target, descriptor });
    }
  } catch (error) {
    for (const lock of held.reverse()) { fs.closeSync(lock.descriptor); try { fs.unlinkSync(lock.target); } catch {} }
    throw new Error(`WORKTREE_REMOVAL_LOCKED:${String(error.code || error.message || error)}`);
  }
  const release = () => {
    for (const lock of held.reverse()) {
      fs.closeSync(lock.descriptor);
      try { fs.unlinkSync(lock.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  return { release, token };
}

function validateRemovalLocks(ticket, resolved, token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('WORKTREE_REMOVAL_CAPABILITY');
  for (const target of removalLockTargets(ticket, resolved)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || fs.readFileSync(target, 'utf8') !== `${token}\n`) throw new Error('WORKTREE_REMOVAL_CAPABILITY');
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function acquireWorktreeAuthority(authority) {
  const target = path.join(fixedLayout().state, 'worktree.lock');
  const token = crypto.randomBytes(32).toString('hex');
  const value = { schema: 1, generation: authority.generation, host: authority.host, uid: authority.uid, pid: process.pid, token };
  const create = () => {
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    fsyncDirectory(path.dirname(target));
  };
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let held;
    try { held = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw new Error('WORKTREE_AUTHORITY_LOCK_INVALID'); }
    if (JSON.stringify(Object.keys(held).sort()) !== JSON.stringify(['generation', 'host', 'pid', 'schema', 'token', 'uid']) || held.schema !== 1 || held.generation !== authority.generation || held.host !== authority.host || held.uid !== authority.uid || !Number.isInteger(held.pid) || !/^[a-f0-9]{64}$/.test(held.token || '')) throw new Error('WORKTREE_AUTHORITY_LOCK_INVALID');
    try { process.kill(held.pid, 0); throw new Error('WORKTREE_AUTHORITY_LOCKED'); } catch (probe) { if (probe.message === 'WORKTREE_AUTHORITY_LOCKED' || probe.code === 'EPERM') throw probe; if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(target);
    fsyncDirectory(path.dirname(target));
    create();
  }
  return {
    token,
    release() {
      validateWorktreeAuthority(authority, token, process.pid);
      fs.unlinkSync(target);
      fsyncDirectory(path.dirname(target));
    },
  };
}

function validateWorktreeAuthority(authority, token, pid) {
  const target = path.join(fixedLayout().state, 'worktree.lock');
  let held;
  try { held = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw new Error('WORKTREE_AUTHORITY_LOCK_INVALID'); }
  if (JSON.stringify(Object.keys(held).sort()) !== JSON.stringify(['generation', 'host', 'pid', 'schema', 'token', 'uid']) || held.schema !== 1 || held.generation !== authority.generation || held.host !== authority.host || held.uid !== authority.uid || held.pid !== pid || held.token !== token) throw new Error('WORKTREE_AUTHORITY_LOCK_DRIFT');
  return true;
}

function readSidecar(file) {
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { throw new Error('SOURCE_FILE_INVALID'); }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > 1024 * 1024 || before.uid !== process.getuid() || (before.mode & 0o022)) throw new Error('SOURCE_FILE_INVALID');
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('SOURCE_FILE_RACE');
    const canonical = fs.realpathSync(file);
    if (canonical !== path.resolve(file)) throw new Error('SOURCE_FILE_ALIAS');
    return { content, digest: crypto.createHash('sha256').update(content).digest('hex'), identity: { canonical, device: String(before.dev), inode: String(before.ino), uid: before.uid, mode: before.mode & 0o777 }, size: before.size };
  } finally { fs.closeSync(descriptor); }
}

function parseFrontmatterSource(source, role) {
  const lines = source.content.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('SOURCE_FRONTMATTER_OPEN');
  const close = lines.indexOf('---', 1);
  if (close < 2) throw new Error('SOURCE_FRONTMATTER_CLOSE');
  const required = new Set(['id', 'title', 'type', 'status', 'canonical', 'created_at', 'updated_at', 'source_path', 'machine', 'owner', 'tags', 'summary', 'related']);
  const allowed = new Set([...required, 'epic', 'priority', 'completed_at', 'deprecated_at', 'superseded_by', 'supersedes', 'branch', 'merge_commit', 'qa_hardening_commit', 'shipping_commit', 'worktree', 'docs_commit', 'repos', 'resolution', 'resolution_note', 'spec_id', 'soak_tracked_by', 'unblocks_on', 'pr_url']);
  const document = YAML.parseDocument(lines.slice(1, close).join('\n'), { strict: true, uniqueKeys: true, prettyErrors: false, maxAliasCount: 0 });
  if (document.errors.length) throw new Error('SOURCE_FRONTMATTER_SYNTAX');
  let value;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch { throw new Error('SOURCE_FRONTMATTER_SYNTAX'); }
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !allowed.has(key))) throw new Error('SOURCE_FRONTMATTER_UNKNOWN');
  if ([...required].some((key) => !Object.hasOwn(value, key)) || !value.id || !STATUSES.includes(value.status)) throw new Error('SOURCE_FRONTMATTER_REQUIRED');
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) {
      if (item.some((entry) => typeof entry !== 'string' || !entry)) throw new Error('SOURCE_FRONTMATTER_TYPE');
    } else if (!['string', 'boolean', 'number'].includes(typeof item) || (typeof item === 'string' && !item)) throw new Error('SOURCE_FRONTMATTER_TYPE');
  }
  if (typeof value.canonical !== 'boolean' || !Array.isArray(value.tags) || !Array.isArray(value.related) || typeof value.machine !== 'string' || typeof value.owner !== 'string') throw new Error('SOURCE_FRONTMATTER_TYPE');
  if (role === 'spec' && (value.type !== 'spec' || !/^spec_[A-Za-z0-9_.:-]+$/.test(value.id))) throw new Error('SOURCE_FRONTMATTER_ROLE');
  if (role === 'summary' && (value.type !== 'work' || !/^work_[A-Za-z0-9_.:-]+$/.test(value.id))) throw new Error('SOURCE_FRONTMATTER_ROLE');
  if (!['spec', 'summary'].includes(role)) throw new Error('SOURCE_FRONTMATTER_ROLE');
  return value;
}

function parseFrontmatter(file) {
  const name = path.basename(file);
  return parseFrontmatterSource(readSidecar(file), name === 'spec.md' ? 'spec' : name === 'summary.md' ? 'summary' : 'unknown');
}

function sourceDigest(source, authority) {
  if (!source?.folder_identity || !source?.spec_source || !source?.summary_source || !authority) throw new Error('SOURCE_DIGEST_AUTHORITY');
  if (source.folder_name !== authority.lane_id || source.spec.id !== authority.spec_id || source.spec.branch !== authority.branch || source.summary.branch !== authority.branch) throw new Error('SOURCE_TICKET_BINDING');
  const ticket = Object.fromEntries(['main_repo_id', 'spec_id', 'lane_id', 'branch', 'upstream', 'head', 'generation', 'creator', 'device', 'inode'].map((key) => [key, authority[key]]));
  return crypto.createHash('sha256').update(JSON.stringify({ status: source.status, folder_name: source.folder_name, folder_identity: source.folder_identity, spec: source.spec, summary: source.summary, spec_source: source.spec_source, summary_source: source.summary_source, ticket })).digest('hex');
}

function sourceFolders() {
  if (arguments.length) throw new Error('SOURCE_ROOT_OVERRIDE_FORBIDDEN');
  const memory = fixedLayout().memory;
  const memoryIdentity = canonicalIdentity(memory);
  if (memoryIdentity.uid !== process.getuid() || (memoryIdentity.mode & 0o022)) throw new Error('SOURCE_ROOT_IDENTITY');
  const work = path.join(memory, 'work');
  const workIdentity = canonicalIdentity(work);
  if (workIdentity.uid !== process.getuid() || (workIdentity.mode & 0o022)) throw new Error('SOURCE_ROOT_IDENTITY');
  for (const status of STATUSES) {
    const root = path.join(work, status);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`SOURCE_STATUS_INVALID:${status}`);
  }
  const folders = [];
  for (const status of STATUSES) {
    const root = path.join(work, status);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('SOURCE_FOLDER_INVALID');
      const folder = path.join(root, entry.name);
      const folderIdentity = canonicalIdentity(folder);
      if (folderIdentity.uid !== process.getuid() || (folderIdentity.mode & 0o022)) throw new Error('SOURCE_FOLDER_IDENTITY');
      const specSource = readSidecar(path.join(folder, 'spec.md'));
      const summarySource = readSidecar(path.join(folder, 'summary.md'));
      const spec = parseFrontmatterSource(specSource, 'spec');
      const summary = parseFrontmatterSource(summarySource, 'summary');
      if (spec.status !== status || summary.status !== status || spec.id.replace(/^spec_/, 'work_') !== summary.id) throw new Error('SOURCE_SIDECAR_MISMATCH');
      if (spec.source_path !== `work/${status}/${entry.name}/spec.md` || summary.source_path !== `work/${status}/${entry.name}/summary.md`) throw new Error('SOURCE_PATH_MISMATCH');
      folders.push({ status, folder, folder_name: entry.name, folder_identity: folderIdentity, spec, summary, spec_content: specSource.content, summary_content: summarySource.content, spec_source: { digest: specSource.digest, identity: specSource.identity, size: specSource.size }, summary_source: { digest: summarySource.digest, identity: summarySource.identity, size: summarySource.size } });
    }
  }
  return folders;
}

function sourceSnapshot() {
  const first = sourceFolders();
  const second = sourceFolders();
  const serialize = (folders) => JSON.stringify(folders.map(({ folder, ...entry }) => entry));
  const encoded = serialize(first);
  if (encoded !== serialize(second)) throw new Error('SOURCE_SNAPSHOT_RACE');
  return Object.freeze({ digest: crypto.createHash('sha256').update(encoded).digest('hex'), folders: Object.freeze(first) });
}

function deriveSourceAuthority(snapshotValue, ticket, expectedDigest, resolvedPath) {
  if (!snapshotValue || !Array.isArray(snapshotValue.folders) || !/^[a-f0-9]{64}$/.test(snapshotValue.digest || '')) throw new Error('SOURCE_SNAPSHOT_INVALID');
  for (const key of ['main_repo_id', 'spec_id', 'lane_id', 'branch', 'upstream', 'head', 'generation', 'creator', 'device', 'inode']) {
    if (ticket?.[key] === undefined || ticket[key] === null || ticket[key] === '') throw new Error('SOURCE_TICKET_INCOMPLETE');
  }
  const owners = snapshotValue.folders.filter((entry) => entry.spec.id === ticket.spec_id);
  if (owners.length !== 1 || !TERMINAL.has(owners[0].status)) throw new Error('SOURCE_OWNER_NONTERMINAL');
  const digest = sourceDigest(owners[0], ticket);
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('SOURCE_OWNER_DRIFT');
  const protectedStrings = [ticket.spec_id, ticket.lane_id, ticket.branch, ticket.head, resolvedPath].filter(Boolean);
  for (const source of snapshotValue.folders.filter((entry) => !TERMINAL.has(entry.status))) {
    if (typeof source.spec_content !== 'string' || typeof source.summary_content !== 'string') throw new Error('SOURCE_SNAPSHOT_INVALID');
    if (protectedStrings.some((value) => source.spec_content.includes(value) || source.summary_content.includes(value))) throw new Error('SOURCE_NONTERMINAL_REFERENCE');
  }
  return Object.freeze({ digest, owner: owners[0], snapshot_digest: snapshotValue.digest });
}

function parseWorktrees(repository) {
  const fields = git(repository, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  const records = [];
  let current = null;
  for (const field of fields) {
    if (!field) continue;
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { resolved: field.slice(9) };
    } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5);
    else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (current && field === 'detached') current.detached = true;
    else if (current && field.startsWith('locked')) current.locked = true;
    else if (current && field.startsWith('prunable')) current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

function resolveWorktree(mainRepoId, laneId) {
  const layout = fixedLayout();
  const repository = layout.repositories[mainRepoId];
  if (!repository) throw new Error('MAIN_REPOSITORY_UNKNOWN');
  const rootIdentity = canonicalIdentity(layout.worktrees);
  const matches = parseWorktrees(repository).filter((record) => path.dirname(record.resolved) === rootIdentity.canonical && path.basename(record.resolved) === laneId);
  if (matches.length !== 1) throw new Error('WORKTREE_CARDINALITY');
  const record = matches[0];
  if (!record.branch || record.detached || record.locked || record.prunable) throw new Error('WORKTREE_REGISTRATION_INVALID');
  if (git(record.resolved, ['check-ref-format', '--branch', record.branch]) !== record.branch) throw new Error('WORKTREE_BRANCH_INVALID');
  const identity = canonicalIdentity(record.resolved);
  const upstream = git(record.resolved, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream !== `origin/${record.branch}`) throw new Error('WORKTREE_UPSTREAM_INVALID');
  return { repository, record, identity, upstream };
}

function registerWorktree(mainRepoId, specId, laneId) {
  const authority = validateInstalledAuthority();
  const sources = sourceSnapshot();
  const resolved = resolveWorktree(mainRepoId, laneId);
  const id = generatedId();
  const ticket = {
    schema: 1,
    id,
    revision: 0,
    state: 'registered',
    generation: authority.generation,
    main_repo_id: mainRepoId,
    spec_id: specId,
    lane_id: laneId,
    branch: resolved.record.branch,
    upstream: resolved.upstream,
    head: resolved.record.head,
    basename: laneId,
    device: resolved.identity.device,
    inode: resolved.identity.inode,
    registered_at: new Date().toISOString(),
    creator: { host: authority.host, uid: authority.uid, pid: process.pid },
  };
  const proof = deriveSourceAuthority(sources, ticket, undefined, resolved.record.resolved);
  return createRecord('tickets', { ...ticket, source_digest: proof.digest });
}

function sourceProof(ticket, resolved) {
  return deriveSourceAuthority(sourceSnapshot(), ticket, ticket.source_digest, resolved.record.resolved);
}

function snapshot(ticket) {
  const resolved = resolveWorktree(ticket.main_repo_id, ticket.lane_id);
  const identity = resolved.identity;
  const dirty = git(resolved.record.resolved, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  const branch = git(resolved.record.resolved, ['symbolic-ref', '--short', 'HEAD']);
  const counts = git(resolved.record.resolved, ['rev-list', '--left-right', '--count', `HEAD...${ticket.upstream}`]).split(/\s+/).map(Number);
  git(resolved.record.resolved, ['merge-base', '--is-ancestor', 'HEAD', ticket.upstream]);
  const facts = { branch, head: resolved.record.head, upstream: resolved.upstream, counts, device: identity.device, inode: identity.inode, dirty, remotely_contained: true };
  validateGitFacts(ticket, facts);
  return { resolved, fingerprint: JSON.stringify(facts) };
}

function fetchRemote(repository, execute = git) {
  return execute(repository, ['fetch', '--prune', 'origin']);
}

function validateGitFacts(ticket, facts) {
  if (facts.branch !== ticket.branch || facts.head !== ticket.head || facts.upstream !== ticket.upstream || facts.device !== ticket.device || facts.inode !== ticket.inode) throw new Error('WORKTREE_IDENTITY_DRIFT');
  if (facts.dirty) throw new Error('WORKTREE_DIRTY');
  if (!Array.isArray(facts.counts) || facts.counts.length !== 2 || facts.counts.some((value) => !Number.isInteger(value) || value < 0) || facts.counts[0] !== 0 || !facts.remotely_contained) throw new Error('WORKTREE_UNPUSHED_OR_DIVERGED');
  return true;
}

function creatorAlive(ticket) {
  if (ticket.creator.host !== require('node:os').hostname() || ticket.creator.uid !== process.getuid()) return true;
  try { process.kill(ticket.creator.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function removeLocked(ticketId) {
  const authority = validateInstalledAuthority();
  const worktreeToken = process.env.STORAGE_WORKTREE_AUTHORITY_TOKEN;
  const removalToken = process.env.STORAGE_REMOVAL_LOCK_TOKEN;
  const parentPid = Number(process.env.STORAGE_WORKTREE_AUTHORITY_PID);
  const expectedFingerprint = process.env.STORAGE_DELETION_FINGERPRINT;
  validateWorktreeAuthority(authority, worktreeToken, parentPid);
  const ticket = readRecord('tickets', ticketId);
  if (ticket.state !== 'removing' || ticket.generation !== authority.generation || !expectedFingerprint) throw new Error('WORKTREE_REMOVAL_AUTHORITY');
  const resolved = resolveWorktree(ticket.main_repo_id, ticket.lane_id);
  validateRemovalLocks(ticket, resolved, removalToken);
  const final = snapshot(ticket);
  if (final.fingerprint !== expectedFingerprint) throw new Error('WORKTREE_FINAL_DELETE_RACE');
  sourceProof(ticket, final.resolved);
  git(final.resolved.repository, ['worktree', 'remove', '--', final.resolved.record.resolved]);
  return true;
}

function invokeLockedRemoval(ticket, fingerprint, worktreeToken, removalToken) {
  const result = spawnSync(process.execPath, [__filename, '__remove_locked', ticket.id], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STORAGE_WORKTREE_AUTHORITY_TOKEN: worktreeToken,
      STORAGE_WORKTREE_AUTHORITY_PID: String(process.pid),
      STORAGE_REMOVAL_LOCK_TOKEN: removalToken,
      STORAGE_DELETION_FINGERPRINT: fingerprint,
    },
  });
  if (result.error || result.status !== 0) throw new Error(`WORKTREE_REMOVE_HELPER:${String(result.stderr || result.error || '').trim()}`);
}

function retireWorktreeHeld(ticketId, now, authority, worktreeToken, dependencies = {}) {
  const readTicket = dependencies.readRecord || readRecord;
  const isCreatorAlive = dependencies.creatorAlive || creatorAlive;
  const takeSnapshot = dependencies.snapshot || snapshot;
  const proveSource = dependencies.sourceProof || sourceProof;
  const refreshRemote = dependencies.fetchRemote || fetchRemote;
  const advanceTicket = dependencies.replaceRecord || replaceRecord;
  const assertTransition = dependencies.transition || require('./storage-authority.cjs').transition;
  const removeLocked = dependencies.invokeLockedRemoval || invokeLockedRemoval;
  let ticket = readTicket('tickets', ticketId);
  if (ticket.generation !== authority.generation) throw new Error('WORKTREE_GENERATION_DRIFT');
  if (ticket.state === 'registered' && (now - Date.parse(ticket.registered_at) < DAY || isCreatorAlive(ticket))) throw new Error('WORKTREE_NOT_ELIGIBLE');
  if (!['registered', 'removing'].includes(ticket.state)) throw new Error('WORKTREE_NOT_ELIGIBLE');
  let deletionFingerprint;
  if (ticket.state === 'registered') {
    const first = takeSnapshot(ticket);
    proveSource(ticket, first.resolved);
    refreshRemote(first.resolved.repository);
    const second = takeSnapshot(ticket);
    proveSource(ticket, second.resolved);
    if (first.fingerprint !== second.fingerprint) throw new Error('WORKTREE_DELETE_TIME_RACE');
    deletionFingerprint = second.fingerprint;
    assertTransition('ticket', ticket.state, 'eligible');
    ticket = advanceTicket('tickets', ticketId, ticket.revision, { ...ticket, state: 'eligible', revision: ticket.revision + 1, eligible_at: new Date(now).toISOString() });
    assertTransition('ticket', ticket.state, 'removing');
    ticket = advanceTicket('tickets', ticketId, ticket.revision, { ...ticket, state: 'removing', revision: ticket.revision + 1, removing_at: new Date(now).toISOString() });
  }
  try {
    const repository = fixedLayout().repositories[ticket.main_repo_id];
    const expected = path.join(fixedLayout().worktrees, ticket.basename);
    const registered = parseWorktrees(repository).filter((record) => record.resolved === expected);
    if (registered.length > 1) throw new Error('WORKTREE_CARDINALITY');
    if (!registered.length) {
      if (fs.existsSync(expected)) throw new Error('WORKTREE_REMOVAL_AMBIGUOUS');
    } else {
      if (!deletionFingerprint) {
        const first = takeSnapshot(ticket);
        proveSource(ticket, first.resolved);
        refreshRemote(first.resolved.repository);
        const second = takeSnapshot(ticket);
        proveSource(ticket, second.resolved);
        if (first.fingerprint !== second.fingerprint) throw new Error('WORKTREE_DELETE_TIME_RACE');
        deletionFingerprint = second.fingerprint;
      }
      const locked = resolveWorktree(ticket.main_repo_id, ticket.lane_id);
      const locks = acquireRemovalLocks(ticket, locked);
      try {
        const final = takeSnapshot(ticket);
        proveSource(ticket, final.resolved);
        if (final.fingerprint !== deletionFingerprint) throw new Error('WORKTREE_FINAL_DELETE_RACE');
        removeLocked(ticket, deletionFingerprint, worktreeToken, locks.token);
      } finally { locks.release(); }
    }
  }
  catch (error) {
    assertTransition('ticket', ticket.state, 'blocked');
    advanceTicket('tickets', ticketId, ticket.revision, { ...ticket, state: 'blocked', revision: ticket.revision + 1, blocked_reason: String(error.message || error) });
    throw error;
  }
  assertTransition('ticket', ticket.state, 'removed');
  return advanceTicket('tickets', ticketId, ticket.revision, { ...ticket, state: 'removed', revision: ticket.revision + 1, deleted_at: new Date(now).toISOString() });
}

function retireWorktreeWithAuthority(ticketId, now = Date.now()) {
  const authority = validateInstalledAuthority();
  const held = acquireWorktreeAuthority(authority);
  try { return retireWorktreeHeld(ticketId, now, authority, held.token); }
  finally { held.release(); }
}

if (require.main === module) {
  try {
    if (process.argv[2] !== '__remove_locked' || !process.argv[3]) throw new Error('WORKTREE_HELPER_INPUT');
    removeLocked(process.argv[3]);
    process.stdout.write('{"removed":true}\n');
  } catch (error) {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  }
}

function retireWorktree(ticketId, now = Date.now()) {
  return withRecordMutation('tickets', ticketId, () => retireWorktreeWithAuthority(ticketId, now));
}

module.exports = { DAY, STATUSES, bind: (token) => require('./storage-capability.cjs').bind(token, { registerWorktree, retireWorktree, retireWorktreeHeld }), creatorAlive, fetchRemote, parseFrontmatter, parseWorktrees, snapshot, sourceDigest, sourceFolders, validateGitFacts };
