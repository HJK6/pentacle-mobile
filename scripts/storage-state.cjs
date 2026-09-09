'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixedLayout, transition } = require('./storage-authority.cjs');

const SCHEMA = 1;
const STATE_LIMIT = 64 * 1024 * 1024;
const RECORD_LIMIT = 120;
const RECORD_FIELDS = Object.freeze({
  runs: new Set(['schema', 'id', 'revision', 'state', 'generation', 'owner', 'candidate_ref', 'gate_code_sha', 'gate_code_tree_clean', 'scratch_image', 'evidence_image', 'lock_token_digest', 'reserved_at', 'first_dead_at', 'scratch_seal', 'evidence_seal', 'device_set_identity', 'allocated_at', 'recovered', 'failure', 'handoff_from_pid', 'running_at', 'gate_status', 'sealing_at', 'classification_error', 'preliminary_audit_at', 'preliminary_evidence_digest', 'published_at', 'scratch_discard_started_at', 'scratch_discarded_at', 'evidence_digest', 'evidence_discard_started_at', 'evidence_discarded_at', 'deleted_at', 'unclassified_disposed_at', 'disposition_reason', 'backing_absent_at', 'backing_absent_reason']),
  tickets: new Set(['schema', 'id', 'revision', 'state', 'generation', 'main_repo_id', 'spec_id', 'lane_id', 'branch', 'upstream', 'head', 'source_digest', 'basename', 'device', 'inode', 'registered_at', 'creator', 'eligible_at', 'removing_at', 'blocked_reason', 'deleted_at']),
  scheduler: new Set(['schema', 'id', 'revision', 'state', 'action', 'generation', 'prior_owned', 'prior_content', 'prior_loaded', 'created_at', 'candidate_digest', 'smoke_report_id', 'smoke_report_digest', 'failure', 'committed_at', 'recovered_at', 'restored_at']),
});
const CORE_FIELDS = ['schema', 'id', 'revision', 'state', 'generation'];
const RUN_BASE = [...CORE_FIELDS, 'owner', 'candidate_ref', 'scratch_image', 'evidence_image', 'lock_token_digest', 'reserved_at', 'first_dead_at'];
const RUN_PROVENANCE_FIELDS = new Set(['gate_code_sha', 'gate_code_tree_clean']);
const RUN_ALLOCATED = [...RUN_BASE, 'scratch_seal', 'evidence_seal', 'device_set_identity', 'allocated_at'];
const RUN_RUNNING = [...RUN_ALLOCATED, 'handoff_from_pid', 'running_at'];
const RUN_SEALING = [...RUN_RUNNING, 'gate_status', 'sealing_at'];
const RUN_PUBLISHED = [...RUN_SEALING, 'preliminary_audit_at', 'preliminary_evidence_digest', 'published_at'];
// A run reaches scratch discard from EITHER published - carrying publication authority - or from
// blocked_unclassified, carrying classification_error and no publication authority at all. Both are
// legitimate, so publication authority is optional across the two scratch-discard states, and the
// all-or-nothing invariant in validateRecord stops the published path losing any strictness from that.
//
// The RUN_EVIDENCE_* shapes below USED to build on the published shape, making publication authority
// mandatory to reach evidence discard. That was deliberate, and it was also the schema half of the dead
// end: a run that reached scratch_discarded from blocked_unclassified could never advance, so its
// evidence was retained forever with no endpoint able to touch it. runDecision's
// publication-authority-missing retain named the same dead end from the decision side. They now require
// EITHER publication or disposition authority - never neither - which closes it without loosening what
// the published path has to prove.
// Built from RUN_ALLOCATED: the disposition endpoint accepts a run that died in allocated, before it
// had a handoff or a running timestamp. The conditional invariants below keep the running and sealing
// fields required for every classic discard while admitting only a disposition-authorised earlier run.
const RUN_SCRATCH_DISCARD_MINIMUM = [...RUN_ALLOCATED, 'scratch_discard_started_at'];
const RUN_RUNNING_OPTIONAL = ['handoff_from_pid', 'running_at'];
const RUN_SEALING_OPTIONAL = ['gate_status', 'sealing_at'];
const RUN_PUBLICATION_OPTIONAL = ['preliminary_audit_at', 'preliminary_evidence_digest', 'published_at', 'classification_error'];
// DISPOSITION AUTHORITY is a PEER of publication authority, not a weakening of it. A run that died
// unclassified never published, so it can never carry publication authority - and forging one would put a
// false `published_at` in the journal, which is the whole reason the classification shape was refused.
// Instead an operator's recorded disposition, carrying its own evidence digest, authorises the discard.
// The two authorities are mutually exclusive in practice and the invariant below requires EXACTLY ONE:
// a run may not reach evidence discard carrying neither (the dead end this spec closes) and a published
// run gains nothing from it.
const RUN_DISPOSITION_OPTIONAL = ['unclassified_disposed_at', 'disposition_reason'];
// Publication is no longer REQUIRED to reach evidence discard - the disposition authority is the other
// admissible proof - but `evidence_digest` still is, because verifyRetainedEvidence recomputes the
// manifest against it before anything is deleted (storage-gate.cjs:447). That check is what makes this a
// peer authority rather than a bypass: both paths prove the bytes they destroy are the bytes they audited.
const RUN_EVIDENCE_DISCARD_MINIMUM = [...RUN_SCRATCH_DISCARD_MINIMUM, 'scratch_discarded_at', 'evidence_digest', 'evidence_discard_started_at'];
const RUN_EVIDENCE_DISCARDING = [...RUN_EVIDENCE_DISCARD_MINIMUM];
const RUN_EVIDENCE_DISCARDED = [...RUN_EVIDENCE_DISCARDING, 'evidence_discarded_at', 'deleted_at'];
const TICKET_BASE = [...CORE_FIELDS, 'main_repo_id', 'spec_id', 'lane_id', 'branch', 'upstream', 'head', 'source_digest', 'basename', 'device', 'inode', 'registered_at', 'creator'];
const SCHEDULER_BASE = [...CORE_FIELDS, 'action', 'prior_owned', 'prior_content', 'prior_loaded', 'created_at'];
const exactFields = (required, optional = []) => Object.freeze({ required: Object.freeze(required), allowed: new Set([...required, ...optional]) });
const STATE_FIELDS = Object.freeze({
  runs: Object.freeze({
    reserved: exactFields(RUN_BASE),
    // The four states a disposable-but-never-published run can be sitting in when an operator authorises
    // its disposition. The authority is recorded HERE, before the run moves, because runDecision reads it
    // off the record to authorise the move at all - see manualDispositionAuthorized in storage-janitor.
    // `evidence_digest` joins them: the disposition seals the image at authorisation time, so the journal
    // records a digest of exactly what is about to be destroyed. Admitting these fields grants NO
    // authority on its own; the exactly-one-authority invariant below governs what may act on them.
    allocated: exactFields(RUN_ALLOCATED, ['recovered', 'evidence_digest', ...RUN_DISPOSITION_OPTIONAL]),
    running: exactFields(RUN_RUNNING, ['recovered', 'failure', 'evidence_digest', ...RUN_DISPOSITION_OPTIONAL]),
    sealing: exactFields(RUN_SEALING, ['recovered', 'failure', 'evidence_digest', ...RUN_DISPOSITION_OPTIONAL]),
    blocked_unclassified: exactFields([...RUN_SEALING, 'classification_error'], ['recovered', 'failure', 'evidence_digest', ...RUN_DISPOSITION_OPTIONAL]),
    published: exactFields(RUN_PUBLISHED, ['recovered', 'failure']),
    scratch_discarding: exactFields(RUN_SCRATCH_DISCARD_MINIMUM, ['recovered', 'failure', 'evidence_digest', ...RUN_RUNNING_OPTIONAL, ...RUN_PUBLICATION_OPTIONAL, ...RUN_DISPOSITION_OPTIONAL, ...RUN_SEALING_OPTIONAL]),
    scratch_discarded: exactFields([...RUN_SCRATCH_DISCARD_MINIMUM, 'scratch_discarded_at'], ['recovered', 'failure', 'evidence_digest', ...RUN_RUNNING_OPTIONAL, ...RUN_PUBLICATION_OPTIONAL, ...RUN_DISPOSITION_OPTIONAL, ...RUN_SEALING_OPTIONAL]),
    evidence_discarding: exactFields(RUN_EVIDENCE_DISCARDING, ['recovered', 'failure', ...RUN_RUNNING_OPTIONAL, ...RUN_PUBLICATION_OPTIONAL, ...RUN_DISPOSITION_OPTIONAL, ...RUN_SEALING_OPTIONAL]),
    evidence_discarded: exactFields(RUN_EVIDENCE_DISCARDED, ['recovered', 'failure', ...RUN_RUNNING_OPTIONAL, ...RUN_PUBLICATION_OPTIONAL, ...RUN_DISPOSITION_OPTIONAL, ...RUN_SEALING_OPTIONAL]),
    // Terminal disposition for a dead-owner blocked_unclassified run whose backing images were lost out of
    // band. It carries blocked_unclassified's whole record forward (RUN_SEALING + classification_error)
    // plus two fields naming WHEN it was recorded and ON WHAT GROUNDS. It deliberately has NO evidence_digest
    // path of its own: nothing was audited or destroyed here, so it must not borrow the disposition/publication
    // authorities that authorise a real discard. `evidence_digest` stays admissible only because a run may
    // already carry one from an earlier authorised phase; it is never required or minted here.
    backing_absent: exactFields([...RUN_SEALING, 'classification_error', 'backing_absent_at', 'backing_absent_reason'], ['recovered', 'failure', 'evidence_digest', ...RUN_DISPOSITION_OPTIONAL]),
  }),
  tickets: Object.freeze({
    registered: exactFields(TICKET_BASE),
    eligible: exactFields([...TICKET_BASE, 'eligible_at']),
    removing: exactFields([...TICKET_BASE, 'eligible_at', 'removing_at']),
    blocked: exactFields([...TICKET_BASE, 'blocked_reason'], ['eligible_at', 'removing_at']),
    removed: exactFields([...TICKET_BASE, 'eligible_at', 'removing_at', 'deleted_at']),
  }),
  scheduler: Object.freeze({
    absent: exactFields(SCHEDULER_BASE),
    prepared: exactFields([...SCHEDULER_BASE, 'candidate_digest'], ['recovered_at']),
    candidate_installed: exactFields([...SCHEDULER_BASE, 'candidate_digest'], ['recovered_at']),
    smoke_verified: exactFields([...SCHEDULER_BASE, 'candidate_digest', 'smoke_report_id', 'smoke_report_digest'], ['recovered_at']),
    committed: exactFields([...SCHEDULER_BASE, 'candidate_digest', 'smoke_report_id', 'smoke_report_digest'], ['committed_at', 'recovered_at']),
    rolling_back: exactFields([...SCHEDULER_BASE, 'candidate_digest'], ['smoke_report_id', 'smoke_report_digest', 'failure', 'recovered_at']),
    restored: exactFields([...SCHEDULER_BASE, 'candidate_digest', 'restored_at'], ['smoke_report_id', 'smoke_report_digest', 'failure', 'recovered_at']),
  }),
});
const IMMUTABLE_FIELDS = Object.freeze({
  runs: ['schema', 'id', 'generation', 'candidate_ref', 'gate_code_sha', 'gate_code_tree_clean', 'scratch_image', 'evidence_image', 'lock_token_digest', 'reserved_at', 'first_dead_at', 'scratch_seal', 'evidence_seal', 'device_set_identity', 'allocated_at', 'handoff_from_pid', 'running_at', 'gate_status', 'sealing_at', 'preliminary_audit_at', 'published_at', 'preliminary_evidence_digest', 'scratch_discard_started_at', 'scratch_discarded_at', 'evidence_digest', 'evidence_discard_started_at', 'evidence_discarded_at', 'deleted_at', 'unclassified_disposed_at', 'disposition_reason', 'backing_absent_at', 'backing_absent_reason'],
  tickets: ['schema', 'id', 'generation', 'main_repo_id', 'spec_id', 'lane_id', 'branch', 'upstream', 'head', 'source_digest', 'basename', 'device', 'inode', 'registered_at', 'creator', 'eligible_at', 'removing_at', 'deleted_at'],
  scheduler: ['schema', 'id', 'generation', 'action', 'prior_owned', 'prior_content', 'prior_loaded', 'created_at', 'candidate_digest', 'smoke_report_id', 'smoke_report_digest'],
});

function canonicalIdentity(target) {
  const lexical = path.resolve(target);
  const current = fs.lstatSync(lexical);
  if (current.isSymbolicLink() || !current.isDirectory()) throw new Error('AUTHORITY_ROOT_INVALID');
  const real = fs.realpathSync(lexical);
  if (real !== lexical) throw new Error('AUTHORITY_ROOT_ALIAS');
  const stat = fs.statSync(real);
  return { canonical: real, device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o777 };
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function atomicJson(target, value) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  // The payload is DURABLE and INVISIBLE: fsynced into a temporary name that no reader looks for.
  // This is the point the atomicity of every journal write turns on, and it was previously only
  // arguable - the rename is one syscall away and there was no seam between them.
  require('./storage-crash-points.cjs').crashPoint('journal-durability');
  fs.renameSync(temporary, target);
  fsyncDirectory(directory);
}

function readExactJson(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('AUTHORITY_FILE_INVALID');
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('AUTHORITY_JSON_INVALID');
  return value;
}

function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error('STATE_SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) stack.push(child);
      else if (stat.isFile()) total += stat.size;
      else throw new Error('STATE_OBJECT_FORBIDDEN');
    }
  }
  return total;
}

function expectedRoots(layout = fixedLayout()) {
  return {
    scratch_images: layout.scratchImages,
    evidence_images: layout.evidenceImages,
    worktrees: layout.worktrees,
    repositories: layout.repositories,
  };
}

function createPreparedAuthority() {
  const layout = fixedLayout();
  if (fs.existsSync(path.join(layout.state, 'authority.json'))) throw new Error('AUTHORITY_ALREADY_INSTALLED');
  for (const directory of [layout.support, layout.scratchImages, layout.evidenceImages, layout.worktrees]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const backingDevice = canonicalIdentity(layout.support).device;
  if (canonicalIdentity(layout.scratchImages).device !== backingDevice || canonicalIdentity(layout.evidenceImages).device !== backingDevice || canonicalIdentity(layout.stateImage).device !== backingDevice) throw new Error('AUTHORITY_CROSS_DEVICE_BACKING');
  const stateFs = fs.statfsSync(layout.state, { bigint: true });
  if (stateFs.blocks * stateFs.bsize > BigInt(STATE_LIMIT)) throw new Error('STATE_VOLUME_NOT_CAPPED');
  const roots = {};
  for (const [name, target] of Object.entries(expectedRoots(layout))) {
    if (name === 'repositories') {
      roots.repositories = {};
      for (const [id, repository] of Object.entries(target)) roots.repositories[id] = canonicalIdentity(repository);
    } else roots[name] = canonicalIdentity(target);
  }
  const authority = {
    schema: SCHEMA,
    generation: crypto.randomUUID(),
    host: os.hostname(),
    uid: process.getuid(),
    state: 'prepared',
    created_at: new Date().toISOString(),
    roots,
  };
  atomicJson(path.join(layout.state, 'authority.json'), authority);
  return authority;
}

function readAuthorityState() {
  const layout = fixedLayout();
  const authority = readExactJson(path.join(layout.state, 'authority.json'));
  validateAuthorityShape(authority, { host: os.hostname(), uid: process.getuid(), roots: expectedRoots(layout) }, require('./storage-authority.cjs').CONTRACT.states.installed);
  return authority;
}

function transitionInstalledAuthority(expectedState, nextState) {
  const authority = readAuthorityState();
  if (authority.state !== expectedState) throw new Error('AUTHORITY_STATE_RACE');
  transition('installed', expectedState, nextState);
  const next = { ...authority, state: nextState };
  atomicJson(path.join(fixedLayout().state, 'authority.json'), next);
  return next;
}

function createInstalledAuthority() {
  createPreparedAuthority();
  return transitionInstalledAuthority('prepared', 'installed');
}

function validateInstalledAuthority() {
  const layout = fixedLayout();
  const authority = readExactJson(path.join(layout.state, 'authority.json'));
  validateAuthorityShape(authority, { host: os.hostname(), uid: process.getuid(), roots: expectedRoots(layout) });
  const expected = expectedRoots(layout);
  const backingDevice = canonicalIdentity(layout.support).device;
  if (canonicalIdentity(layout.scratchImages).device !== backingDevice || canonicalIdentity(layout.evidenceImages).device !== backingDevice || canonicalIdentity(layout.stateImage).device !== backingDevice) throw new Error('AUTHORITY_CROSS_DEVICE_BACKING');
  for (const [name, target] of Object.entries(expected)) {
    if (name === 'repositories') {
      for (const [id, repository] of Object.entries(target)) validateIdentity(authority.roots.repositories[id], canonicalIdentity(repository));
    } else validateIdentity(authority.roots[name], canonicalIdentity(target));
  }
  const stateFs = fs.statfsSync(layout.state, { bigint: true });
  if (stateFs.blocks * stateFs.bsize > BigInt(STATE_LIMIT) || directoryBytes(layout.state) > STATE_LIMIT) throw new Error('STATE_QUOTA_EXCEEDED');
  validateStateLayout(layout.state);
  return authority;
}

const MUTATION_CLAIM = /^\.mutation-([a-f0-9]{64})\.claim$/;

function validateMutationClaim(kind, directory, name, expectedId = null) {
  const match = MUTATION_CLAIM.exec(name);
  if (!match) return null;
  const target = path.join(directory, name);
  const stat = fs.lstatSync(target);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.nlink !== 1 || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`STATE_LAYOUT_UNKNOWN:${kind}/${name}`);
  }
  const owner = readExactJson(target);
  if (Object.keys(owner).sort().join(',') !== 'host,id,kind,pid,token,uid' || owner.kind !== kind || (expectedId !== null && owner.id !== expectedId) || !UUID.test(owner.id) || !UUID.test(owner.token) || typeof owner.host !== 'string' || owner.uid !== expectedUid || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw new Error(`STATE_LAYOUT_UNKNOWN:${kind}/${name}`);
  }
  const digest = crypto.createHash('sha256').update(`${kind}\0${owner.id}`).digest('hex');
  if (digest !== match[1]) throw new Error(`STATE_LAYOUT_UNKNOWN:${kind}/${name}`);
  return owner;
}

function validateStateLayout(root) {
  const topFiles = new Set(['authority.json', 'gate.lock', 'janitor.lock', 'scheduler.lock', 'worktree.lock', 'scheduler-baseline.json', 'disabled']);
  const topDirectories = new Set(['runs', 'tickets', 'scheduler', 'reports', '.fseventsd', '.Spotlight-V100', '.Trashes']);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('STATE_LAYOUT_SYMLINK');
    if (entry.isDirectory()) {
      if (!topDirectories.has(entry.name)) throw new Error(`STATE_LAYOUT_UNKNOWN:${entry.name}`);
      if (['runs', 'tickets', 'scheduler', 'reports'].includes(entry.name)) {
        for (const child of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })) {
          if (validateMutationClaim(entry.name, path.join(root, entry.name), child.name)) continue;
          if (!child.isFile() || child.isSymbolicLink() || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(child.name)) throw new Error(`STATE_LAYOUT_UNKNOWN:${entry.name}/${child.name}`);
        }
      }
    } else if (!entry.isFile() || !topFiles.has(entry.name)) throw new Error(`STATE_LAYOUT_UNKNOWN:${entry.name}`);
  }
  return true;
}

function recoverAtomicTemps() {
  const root = fixedLayout().state;
  let recovered = 0;
  for (const directory of [root, ...['runs', 'tickets', 'scheduler', 'reports'].map((name) => path.join(root, name)).filter((target) => fs.existsSync(target))]) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!/^\..+\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (!entry.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 2 * 1024 * 1024) throw new Error('STATE_TEMP_INVALID');
      fs.unlinkSync(target);
      recovered += 1;
    }
    if (recovered) fsyncDirectory(directory);
  }
  return recovered;
}

function validateAuthorityShape(authority, expected, allowedStates = ['installed']) {
  const exactKeys = ['created_at', 'generation', 'host', 'roots', 'schema', 'state', 'uid'];
  if (JSON.stringify(Object.keys(authority).sort()) !== JSON.stringify(exactKeys)) throw new Error('AUTHORITY_SCHEMA_INVALID');
  if (authority.schema !== SCHEMA || authority.host !== expected.host || authority.uid !== expected.uid || !allowedStates.includes(authority.state)) throw new Error('AUTHORITY_IDENTITY_INVALID');
  if (!UUID.test(authority.generation)) throw new Error('AUTHORITY_GENERATION_INVALID');
  if (!authority.roots || Array.isArray(authority.roots) || typeof authority.roots !== 'object') throw new Error('AUTHORITY_ROOT_SET');
  if (JSON.stringify(Object.keys(authority.roots).sort()) !== JSON.stringify(Object.keys(expected.roots).sort())) throw new Error('AUTHORITY_ROOT_SET');
  for (const [name, target] of Object.entries(expected.roots)) {
    if (name === 'repositories') {
      if (JSON.stringify(Object.keys(authority.roots.repositories).sort()) !== JSON.stringify(Object.keys(target).sort())) throw new Error('AUTHORITY_REPOSITORY_SET');
      for (const id of Object.keys(target)) { validateIdentityShape(authority.roots.repositories[id]); if (authority.roots.repositories[id].canonical !== target[id]) throw new Error('AUTHORITY_ROOT_DRIFT'); }
    } else { validateIdentityShape(authority.roots[name]); if (authority.roots[name].canonical !== target) throw new Error('AUTHORITY_ROOT_DRIFT'); }
  }
  return true;
}

function validateIdentityShape(identity) {
  if (!identity || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(['canonical', 'device', 'inode', 'mode', 'uid'])) throw new Error('AUTHORITY_ROOT_SCHEMA');
  if (!path.isAbsolute(identity.canonical) || typeof identity.device !== 'string' || typeof identity.inode !== 'string' || !Number.isInteger(identity.uid) || !Number.isInteger(identity.mode)) throw new Error('AUTHORITY_ROOT_SCHEMA');
}

function validateIdentity(expected, actual) {
  for (const key of ['canonical', 'device', 'inode', 'uid', 'mode']) {
    if (expected?.[key] !== actual[key]) throw new Error('AUTHORITY_ROOT_DRIFT');
  }
  if (actual.uid !== process.getuid()) throw new Error('AUTHORITY_ROOT_OWNERSHIP');
}

function recordFile(kind, id) {
  if (!['runs', 'tickets', 'scheduler'].includes(kind) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('OPAQUE_ID_INVALID');
  return path.join(fixedLayout().state, kind, `${id}.json`);
}

// A RUN THAT KNOWS IT FAILED MUST SAY WHY. gate_status is the wrapper's OWN observation of the child's
// exit, so any non-zero value is a failure the journal has already classified; one with no `failure`
// string is exactly the record run 53f30d6f wrote - gate_status 1, failure null, classification_error
// null - whose cause was recoverable only by re-attaching the evidence image, which is what fix C exists
// to end.
//
// WRITE-TIME ONLY, AND THAT IS THE WHOLE POINT. This began life inside validateRecord, which readRecord
// and listRecords also call, so it applied RETROACTIVELY to records written before the rule existed.
// Measured against the real host journal rather than reasoned about: 53f30d6f and b21bf29f both carry a
// non-zero gate_status with no failure, so listRecords('runs') threw, and storage-janitor.cjs enumerates
// every run through it - a TOTAL outage of the reclamation agent, indefinite because unclassified
// non-zero evidence is retained forever. Enforcing on write delivers the entire guarantee for every new
// record without invalidating history, and the journal is an audit record that must not be backfilled to
// make a validator happy. R7: when you add a constraint, measure the corpus that already exists.
//
// The `current` clause is grandfathering and is deliberately NARROW: it exempts only a record that
// ALREADY carried this exact unexplained status, so the two legacy runs can still be retired by the
// janitor when their retention elapses. It cannot launder a NEW failure - a write that introduces a
// non-zero gate_status, or changes one unexplained value to another, still has no prior to match.
function assertWriteTimeRunInvariants(kind, next, current = undefined) {
  if (kind !== 'runs') return true;
  if (!current && (next.gate_code_sha === undefined || next.gate_code_tree_clean === undefined)) {
    throw new Error('AUTHORITY_RECORD_RUN_PROVENANCE_REQUIRED');
  }
  if (!Number.isInteger(next.gate_status) || next.gate_status === 0 || typeof next.failure === 'string') return true;
  if (current && current.gate_status === next.gate_status && typeof current.failure !== 'string') return true;
  throw new Error('AUTHORITY_RECORD_RUN_FAILURE_UNEXPLAINED');
}

function createRecord(kind, record) {
  validateRecord(kind, record);
  assertWriteTimeRunInvariants(kind, record);
  const target = recordFile(kind, record.id);
  if (fs.existsSync(target)) throw new Error('ID_ALREADY_EXISTS');
  atomicJson(target, record);
  return Object.freeze(record);
}

function readRecord(kind, id) {
  const record = readExactJson(recordFile(kind, id));
  validateRecord(kind, record);
  if (record.id !== id) throw new Error('AUTHORITY_RECORD_ID_MISMATCH');
  return record;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

function exactIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function exactOwner(owner) {
  return owner && JSON.stringify(Object.keys(owner).sort()) === JSON.stringify(['host', 'pid', 'uid']) && typeof owner.host === 'string' && owner.host.length > 0 && !owner.host.includes('/') && Number.isInteger(owner.uid) && owner.uid >= 0 && Number.isInteger(owner.pid) && owner.pid > 0;
}

function exactSeal(seal) {
  if (!seal || JSON.stringify(Object.keys(seal).sort()) !== JSON.stringify(['image', 'object_id'])) return false;
  if (!UUID.test(seal.object_id)) return false;
  try { validateIdentityShape(seal.image); } catch { return false; }
  return true;
}

function requireFields(record, fields) {
  if (fields.some((field) => record[field] === undefined)) throw new Error('AUTHORITY_RECORD_REQUIRED_FIELD');
}

function requireExactStateFields(kind, record) {
  const shape = STATE_FIELDS[kind]?.[record.state];
  if (!shape || Object.keys(record).some((field) => !shape.allowed.has(field) && !(kind === 'runs' && RUN_PROVENANCE_FIELDS.has(field)))) throw new Error('AUTHORITY_RECORD_STATE_FIELD');
  requireFields(record, shape.required);
}

function requireCausalClocks(record, fields, error) {
  let prior = null;
  for (const field of fields) {
    if (record[field] === undefined || record[field] === null) continue;
    if (!exactIso(record[field])) throw new Error(error);
    const current = Date.parse(record[field]);
    if (prior !== null && current < prior) throw new Error(error);
    prior = current;
  }
}

function validateRecord(kind, record) {
  const allowed = RECORD_FIELDS[kind];
  if (!record || Array.isArray(record) || typeof record !== 'object' || !allowed || Object.keys(record).some((key) => !allowed.has(key))) throw new Error('AUTHORITY_RECORD_UNKNOWN_FIELD');
  if (record.schema !== SCHEMA || !UUID.test(record.id) || !UUID.test(record.generation) || !Number.isInteger(record.revision) || record.revision < 0 || typeof record.state !== 'string') throw new Error('AUTHORITY_RECORD_SCHEMA');
  const model = kind === 'runs' ? 'run' : kind === 'tickets' ? 'ticket' : 'scheduler';
  if (!require('./storage-authority.cjs').CONTRACT.states[model].includes(record.state)) throw new Error('AUTHORITY_RECORD_STATE');
  requireExactStateFields(kind, record);
  if (kind === 'runs') {
    requireFields(record, ['owner', 'candidate_ref', 'scratch_image', 'evidence_image', 'lock_token_digest', 'reserved_at', 'first_dead_at']);
    const carriesGateProvenance = record.gate_code_sha !== undefined || record.gate_code_tree_clean !== undefined;
    if (!exactOwner(record.owner) || !GIT_SHA.test(record.candidate_ref) || (carriesGateProvenance && (!GIT_SHA.test(record.gate_code_sha) || record.gate_code_tree_clean !== true)) || record.scratch_image !== `${record.id}.sparsebundle` || record.evidence_image !== `${record.id}.sparsebundle` || !SHA256.test(record.lock_token_digest) || !exactIso(record.reserved_at) || (record.first_dead_at !== null && !exactIso(record.first_dead_at))) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.state !== 'reserved') {
      requireFields(record, ['scratch_seal', 'evidence_seal', 'device_set_identity', 'allocated_at']);
      if (!exactSeal(record.scratch_seal) || !exactSeal(record.evidence_seal) || !exactIso(record.allocated_at)) throw new Error('AUTHORITY_RECORD_RUN');
      try { validateIdentityShape(record.device_set_identity); } catch { throw new Error('AUTHORITY_RECORD_RUN'); }
    }
    const discardState = ['scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(record.state);
    const carriesRunning = record.running_at !== undefined || record.handoff_from_pid !== undefined;
    if ((['running', 'sealing', 'published', 'blocked_unclassified'].includes(record.state) || (discardState && record.unclassified_disposed_at === undefined) || carriesRunning) && (!exactIso(record.running_at) || !Number.isInteger(record.handoff_from_pid) || record.handoff_from_pid <= 0)) throw new Error('AUTHORITY_RECORD_RUN');
    const carriesSealing = record.gate_status !== undefined || record.sealing_at !== undefined;
    if ((['sealing', 'published', 'blocked_unclassified'].includes(record.state) || (discardState && record.unclassified_disposed_at === undefined) || carriesSealing) && (!Number.isInteger(record.gate_status) || !exactIso(record.sealing_at))) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.preliminary_evidence_digest !== undefined && !SHA256.test(record.preliminary_evidence_digest)) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.evidence_digest !== undefined && !SHA256.test(record.evidence_digest)) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.state === 'published' && (!exactIso(record.preliminary_audit_at) || !SHA256.test(record.preliminary_evidence_digest) || !exactIso(record.published_at))) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.state === 'blocked_unclassified' && typeof record.classification_error !== 'string') throw new Error('AUTHORITY_RECORD_RUN');
    // Publication authority is ALL-OR-NOTHING wherever it survives. Making the three fields optional on
    // the scratch-discard states admits the failed path, which has none of them; it must not admit a
    // published run that kept published_at while silently dropping the two preliminary fields that
    // authorise it. A run either carries the whole publication proof forward, or none of it.
    if (record.published_at !== undefined && record.published_at !== null && (!exactIso(record.preliminary_audit_at) || !SHA256.test(record.preliminary_evidence_digest) || !exactIso(record.published_at))) throw new Error('AUTHORITY_RECORD_RUN');
    if (['scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(record.state) && !exactIso(record.scratch_discard_started_at)) throw new Error('AUTHORITY_RECORD_RUN');
    if (['scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(record.state) && !exactIso(record.scratch_discarded_at)) throw new Error('AUTHORITY_RECORD_RUN');
    if (['evidence_discarding', 'evidence_discarded'].includes(record.state) && (!SHA256.test(record.evidence_digest) || !exactIso(record.evidence_discard_started_at))) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.state === 'evidence_discarded' && (!exactIso(record.evidence_discarded_at) || !exactIso(record.deleted_at))) throw new Error('AUTHORITY_RECORD_RUN');
    // backing_absent is terminal on evidence it does NOT delete, so it carries NO deleted_at (nothing was
    // removed) and instead records when the absence was dispositioned and on what grounds. Both fields are
    // required in this state and forbidden in every other, so no ordinary record can silently acquire them.
    if (record.state === 'backing_absent' && (!exactIso(record.backing_absent_at) || typeof record.backing_absent_reason !== 'string' || record.backing_absent_reason.length === 0 || record.backing_absent_reason.length > 256 || record.deleted_at !== undefined)) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.state !== 'backing_absent' && (record.backing_absent_at !== undefined || record.backing_absent_reason !== undefined)) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.backing_absent_at !== undefined && Date.parse(record.backing_absent_at) < Date.parse(record.sealing_at)) throw new Error('AUTHORITY_RECORD_RUN_CLOCK');
    // Disposition authority is ALL-OR-NOTHING too, for the same reason publication is: the timestamp
    // says an operator authorised destroying unclassified evidence and the reason says on what grounds,
    // so a record carrying one without the other records an authorisation nobody can account for.
    if ((record.unclassified_disposed_at !== undefined) !== (record.disposition_reason !== undefined)) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.unclassified_disposed_at !== undefined && (!exactIso(record.unclassified_disposed_at) || typeof record.disposition_reason !== 'string' || record.disposition_reason.length === 0)) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.unclassified_disposed_at !== undefined && !SHA256.test(record.evidence_digest)) throw new Error('AUTHORITY_RECORD_RUN');
    // EXACTLY ONE authority reaches evidence discard, and NEITHER is the case this spec exists to close.
    // Publication proves the run published; disposition proves an operator authorised disposing of a run
    // that never could. Requiring one of them keeps the published path exactly as strict as it was, and
    // refusing both stops a record acquiring deletion authority it was never granted - which is the same
    // failure the all-or-nothing rules above prevent within each authority.
    if (['evidence_discarding', 'evidence_discarded'].includes(record.state) && (record.published_at === undefined || record.published_at === null) === (record.unclassified_disposed_at === undefined)) throw new Error('AUTHORITY_RECORD_RUN_DISPOSITION_AUTHORITY');
    // NOT in the causal chain below: the two classes record it at genuinely different points - a
    // never-classified run is disposed BEFORE its scratch discard begins, a stranded blocked_unclassified
    // run AFTER its scratch discard completed - so no single position in a monotonic list is correct for
    // both. Bounded against the endpoints that are common to both instead.
    if (record.unclassified_disposed_at !== undefined) {
      const disposed = Date.parse(record.unclassified_disposed_at);
      if (disposed < Date.parse(record.reserved_at)) throw new Error('AUTHORITY_RECORD_RUN_CLOCK');
      if (record.evidence_discard_started_at !== undefined && disposed > Date.parse(record.evidence_discard_started_at)) throw new Error('AUTHORITY_RECORD_RUN_CLOCK');
    }
    if (record.recovered !== undefined && record.recovered !== true) throw new Error('AUTHORITY_RECORD_RUN');
    if (record.failure !== undefined && typeof record.failure !== 'string') throw new Error('AUTHORITY_RECORD_RUN');
    requireCausalClocks(record, ['reserved_at', 'allocated_at', 'running_at', 'sealing_at', 'preliminary_audit_at', 'published_at', 'scratch_discard_started_at', 'scratch_discarded_at', 'evidence_discard_started_at', 'evidence_discarded_at', 'deleted_at'], 'AUTHORITY_RECORD_RUN_CLOCK');
    if (record.first_dead_at !== null && Date.parse(record.first_dead_at) < Date.parse(record.reserved_at)) throw new Error('AUTHORITY_RECORD_RUN_CLOCK');
  }
  if (kind === 'tickets') {
    requireFields(record, ['main_repo_id', 'spec_id', 'lane_id', 'branch', 'upstream', 'head', 'source_digest', 'basename', 'device', 'inode', 'registered_at', 'creator']);
    if (!exactOwner(record.creator) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(record.main_repo_id) || !/^spec_[A-Za-z0-9_.:-]+$/.test(record.spec_id) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(record.lane_id) || record.basename !== record.lane_id || !record.branch || record.upstream !== `origin/${record.branch}` || !GIT_SHA.test(record.head) || !SHA256.test(record.source_digest) || typeof record.device !== 'string' || typeof record.inode !== 'string' || !exactIso(record.registered_at)) throw new Error('AUTHORITY_RECORD_TICKET');
    if (['eligible', 'removing', 'removed'].includes(record.state) && !exactIso(record.eligible_at)) throw new Error('AUTHORITY_RECORD_TICKET');
    if (['removing', 'removed'].includes(record.state) && !exactIso(record.removing_at)) throw new Error('AUTHORITY_RECORD_TICKET');
    if (record.state === 'removed' && !exactIso(record.deleted_at)) throw new Error('AUTHORITY_RECORD_TICKET');
    if (record.state === 'blocked' && typeof record.blocked_reason !== 'string') throw new Error('AUTHORITY_RECORD_TICKET');
    requireCausalClocks(record, ['registered_at', 'eligible_at', 'removing_at', 'deleted_at'], 'AUTHORITY_RECORD_TICKET_CLOCK');
  }
  if (kind === 'scheduler') {
    requireFields(record, ['action', 'prior_owned', 'prior_content', 'prior_loaded', 'created_at']);
    if (!['install', 'update'].includes(record.action) || typeof record.prior_owned !== 'boolean' || !(record.prior_content === null || typeof record.prior_content === 'string') || typeof record.prior_loaded !== 'boolean' || !exactIso(record.created_at)) throw new Error('AUTHORITY_RECORD_SCHEDULER');
    if (record.state !== 'absent' && !SHA256.test(record.candidate_digest)) throw new Error('AUTHORITY_RECORD_SCHEDULER');
    if (['smoke_verified', 'committed'].includes(record.state) && (!UUID.test(record.smoke_report_id) || !SHA256.test(record.smoke_report_digest))) throw new Error('AUTHORITY_RECORD_SCHEDULER');
    if (record.state === 'committed' && !exactIso(record.committed_at || record.recovered_at)) throw new Error('AUTHORITY_RECORD_SCHEDULER');
    if (record.state === 'restored' && !exactIso(record.restored_at)) throw new Error('AUTHORITY_RECORD_SCHEDULER');
    if (record.failure !== undefined && typeof record.failure !== 'string') throw new Error('AUTHORITY_RECORD_SCHEDULER');
    for (const clock of ['committed_at', 'recovered_at', 'restored_at']) if (record[clock] !== undefined && Date.parse(record[clock]) < Date.parse(record.created_at)) throw new Error('AUTHORITY_RECORD_SCHEDULER_CLOCK');
  }
  return true;
}

const ACTIVE_RECORD_MUTATIONS = new Set();

function recordMutationClaim(kind, id) {
  const target = recordFile(kind, id);
  const digest = crypto.createHash('sha256').update(`${kind}\0${id}`).digest('hex');
  return path.join(path.dirname(target), `.mutation-${digest}.claim`);
}

function claimOwnerAlive(owner) {
  if (!owner || Object.keys(owner).sort().join(',') !== 'host,id,kind,pid,token,uid' || owner.host !== os.hostname() || owner.uid !== (typeof process.getuid === 'function' ? process.getuid() : owner.uid) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processStartToken(pid) {
  try {
    if (process.platform === 'linux') {
      const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
      return fields[19] || null;
    }
    // Runs in the WRAPPER, outside the sandbox, so setuid /bin/ps is fine here and this is not affected by
    // the gate's PATH shim. If it is ever moved inside the sandbox it breaks identically - and note the
    // empty-to-null fallback below silently drops the startToken ABA defence, which is the same ABA class
    // that got beda300a rejected. Move this and you must re-derive that defence, not just the exec.
    const value = childProcess.execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function leaseHolderAlive(holder) {
  if (!holder || Object.keys(holder).sort().join(',') !== 'host,pid,startToken' || !Number.isSafeInteger(holder.pid) || holder.pid < 1 || typeof holder.startToken !== 'string' || holder.startToken.length === 0) return false;
  if (holder.host !== os.hostname()) return true;
  const current = processStartToken(holder.pid);
  if (current !== null) return current === holder.startToken;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function disposeLeaseTree(target, bestEffort = false) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.unlinkSync(target);
      return;
    }
    for (const entry of fs.readdirSync(target)) disposeLeaseTree(path.join(target, entry), bestEffort);
    fs.rmdirSync(target);
  } catch (error) {
    if (!bestEffort && error?.code !== 'ENOENT') throw error;
  }
}

function readLeaseHolder(lease) {
  const holderFile = path.join(lease, 'holder.json');
  const stat = fs.lstatSync(holderFile);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error('RECORD_MUTATION_LEASE');
  return readExactJson(holderFile);
}

function leaseIdentity(lease) {
  const stat = fs.lstatSync(lease);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o700) throw new Error('RECORD_MUTATION_LEASE');
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameLeaseHolder(left, right) {
  return left?.host === right.host && left?.pid === right.pid && left?.startToken === right.startToken && Object.keys(left).sort().join(',') === 'host,pid,startToken';
}

function requireOwnedLease(lease, holder, identity) {
  const currentIdentity = leaseIdentity(lease);
  if (currentIdentity.device !== identity.device || currentIdentity.inode !== identity.inode || !sameLeaseHolder(readLeaseHolder(lease), holder)) throw new Error('RECORD_MUTATION_OWNER');
}

function releaseOwnedLease(lease, holder, identity) {
  const extracted = `${lease}.${crypto.randomUUID()}.release`;
  try {
    fs.renameSync(lease, extracted);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('RECORD_MUTATION_OWNER');
    throw error;
  }
  let owned = false;
  try {
    const extractedIdentity = leaseIdentity(extracted);
    owned = extractedIdentity.device === identity.device && extractedIdentity.inode === identity.inode && sameLeaseHolder(readLeaseHolder(extracted), holder);
  } catch {
    owned = false;
  }
  if (owned) {
    disposeLeaseTree(extracted);
    return;
  }
  try {
    fs.renameSync(extracted, lease);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
  }
  throw new Error('RECORD_MUTATION_OWNER');
}

function recycleLease(lease) {
  const recycled = `${lease}.${crypto.randomUUID()}.recycle`;
  try {
    fs.renameSync(lease, recycled);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false;
    throw new Error('RECORD_MUTATION_BUSY');
  }
  disposeLeaseTree(recycled, true);
  return true;
}

function reapDeadLeaseTemps(lease) {
  const directory = path.dirname(lease);
  const prefix = `${path.basename(lease)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const target = path.join(directory, name);
    let alive;
    try { alive = leaseHolderAlive(readLeaseHolder(target)); } catch { continue; }
    if (alive) continue;
    const recycled = `${lease}.${crypto.randomUUID()}.recycle`;
    try { fs.renameSync(target, recycled); } catch { continue; }
    disposeLeaseTree(recycled, true);
  }
}

function reapDeadLeaseReleases(lease) {
  const directory = path.dirname(lease);
  const prefix = `${path.basename(lease)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.release')) continue;
    const target = path.join(directory, name);
    let alive = false;
    try { alive = leaseHolderAlive(readLeaseHolder(target)); } catch { alive = false; }
    if (alive) continue;
    const recycled = `${lease}.${crypto.randomUUID()}.recycle`;
    try { fs.renameSync(target, recycled); } catch { continue; }
    disposeLeaseTree(recycled, true);
  }
}

function withMutationClaimGuard(claim, action) {
  const lease = `${claim}.guard`;
  const directory = path.dirname(claim);
  const startToken = processStartToken(process.pid);
  if (startToken === null) throw new Error('RECORD_MUTATION_LEASE_IDENTITY');
  const holder = { host: os.hostname(), pid: process.pid, startToken };
  for (;;) {
    reapDeadLeaseReleases(lease);
    reapDeadLeaseTemps(lease);
    const temporary = `${lease}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(temporary, { mode: 0o700 });
    atomicJson(path.join(temporary, 'holder.json'), holder);
    let acquired = false;
    let identity;
    try {
      try {
        fs.renameSync(temporary, lease);
        acquired = true;
        identity = leaseIdentity(lease);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      }
      if (!acquired) {
        let alive = false;
        try { alive = leaseHolderAlive(readLeaseHolder(lease)); } catch { alive = false; }
        if (alive) throw new Error('RECORD_MUTATION_BUSY');
        if (!recycleLease(lease)) continue;
        continue;
      }
      try {
        requireOwnedLease(lease, holder, identity);
        const result = action();
        requireOwnedLease(lease, holder, identity);
        return result;
      } finally {
        releaseOwnedLease(lease, holder, identity);
        try { fsyncDirectory(directory); } catch { /* best-effort after release */ }
      }
    } finally {
      if (!acquired) disposeLeaseTree(temporary);
    }
  }
}

function reapDeadClaimTemps(kind, id, claim) {
  const directory = path.dirname(claim);
  const prefix = `${path.basename(claim)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp') || name.slice(prefix.length, -4).length !== 36) continue;
    const target = path.join(directory, name);
    let owner;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) continue;
      owner = readExactJson(target);
      if (owner.kind !== kind || owner.id !== id) continue;
    } catch { continue; }
    if (claimOwnerAlive(owner)) continue;
    try { fs.unlinkSync(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function acquireRecordMutation(kind, id) {
  const claim = recordMutationClaim(kind, id);
  const directory = path.dirname(claim);
  const name = path.basename(claim);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const owner = { host: os.hostname(), id, kind, pid: process.pid, token: crypto.randomUUID(), uid: expectedUid };
  const temporary = `${claim}.${owner.token}.tmp`;
  let descriptor;
  let temporaryExists = false;
  try {
    reapDeadClaimTemps(kind, id, claim);
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryExists = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return withMutationClaimGuard(claim, () => {
      if (fs.existsSync(claim)) {
        const existing = validateMutationClaim(kind, directory, name, id);
        if (claimOwnerAlive(existing)) throw new Error('RECORD_MUTATION_BUSY');
        fs.unlinkSync(claim);
      }
      fs.linkSync(temporary, claim);
      fs.unlinkSync(temporary);
      temporaryExists = false;
      fsyncDirectory(directory);
      validateMutationClaim(kind, directory, name, id);
      return { claim, owner };
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryExists) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
}

function releaseRecordMutation(handle) {
  const directory = path.dirname(handle.claim);
  const name = path.basename(handle.claim);
  withMutationClaimGuard(handle.claim, () => {
    const existing = validateMutationClaim(handle.owner.kind, directory, name, handle.owner.id);
    if (existing.token !== handle.owner.token || existing.host !== handle.owner.host || existing.pid !== handle.owner.pid || existing.uid !== handle.owner.uid) {
      throw new Error('RECORD_MUTATION_OWNER');
    }
    fs.unlinkSync(handle.claim);
    fsyncDirectory(directory);
  });
}

function withRecordMutation(kind, id, action) {
  if (typeof action !== 'function') throw new Error('RECORD_MUTATION_ACTION');
  const claim = recordMutationClaim(kind, id);
  if (ACTIVE_RECORD_MUTATIONS.has(claim)) return action();
  const handle = acquireRecordMutation(kind, id);
  ACTIVE_RECORD_MUTATIONS.add(claim);
  try {
    return action();
  } finally {
    ACTIVE_RECORD_MUTATIONS.delete(claim);
    releaseRecordMutation(handle);
  }
}

function replaceRecordHeld(kind, id, expectedRevision, next) {
  const current = readRecord(kind, id);
  if (current.revision !== expectedRevision || next.id !== id || next.revision !== expectedRevision + 1) throw new Error('AUTHORITY_REVISION_RACE');
  for (const field of IMMUTABLE_FIELDS[kind]) if (current[field] !== undefined && current[field] !== null && JSON.stringify(current[field]) !== JSON.stringify(next[field])) throw new Error(`AUTHORITY_IMMUTABLE_FIELD:${field}`);
  validateRecord(kind, next);
  assertWriteTimeRunInvariants(kind, next, current);
  atomicJson(recordFile(kind, id), next);
  return Object.freeze(next);
}

function replaceRecord(kind, id, expectedRevision, next) {
  return withRecordMutation(kind, id, () => replaceRecordHeld(kind, id, expectedRevision, next));
}

function transitionRun(id, expectedRevision, nextState, patch = {}) {
  const authority = validateInstalledAuthority();
  const current = readRecord('runs', id);
  transition('run', current.state, nextState);
  if (current.generation !== authority.generation) throw new Error('AUTHORITY_GENERATION_DRIFT');
  if (patch.owner && (current.state !== 'allocated' || nextState !== 'running' || patch.owner.host !== current.owner.host || patch.owner.uid !== current.owner.uid || patch.owner.pid !== process.pid)) throw new Error('AUTHORITY_OWNER_HANDOFF');
  const next = { ...current, ...patch, id, state: nextState, revision: expectedRevision + 1 };
  return replaceRecord('runs', id, expectedRevision, next);
}

// `onInvalid` is OPT-IN and absent by default, so every existing caller keeps throwing exactly as before
// and nothing is loosened where nobody asked for it.
//
// The janitor opts in, because AN ENUMERATION PATH THE RECLAMATION AGENT DEPENDS ON MUST NEVER DIE ON ONE
// BAD RECORD. A single hand-edited, truncated or externally corrupted record would otherwise take out the
// entire sweep and every other record with it - and do it SILENTLY, since the scheduled janitor's streams
// go to /dev/null by design. The try covers the READ as well as the validation, or a truncated file would
// still throw from readExactJson before any validator saw it.
//
// WITHHOLDING A RECORD FROM THE CALLER IS NOT THE SAME AS DROPPING IT, and the difference is the whole
// safety of this. An invalid record must never reach a decision path that can delete something, so it is
// not returned; but it must be reported as PRESENT-BUT-INVALID rather than absent, which is the
// COLLECTOR'S obligation and is why onInvalid is required to opt in rather than being a silent default.
// A caller that swallows the callback converts this check into a rubber stamp. See storage-janitor.cjs
// for the one caller that opts in and what it does with it.
function listRecords(kind, onInvalid = null) {
  const directory = path.join(fixedLayout().state, kind);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).sort().map((name) => {
    const id = name.slice(0, -5);
    try {
      const record = readExactJson(path.join(directory, name));
      validateRecord(kind, record);
      if (record.id !== id) throw new Error('AUTHORITY_RECORD_ID_MISMATCH');
      return record;
    } catch (error) {
      if (!onInvalid) throw error;
      onInvalid(id, String(error.message || error));
      return null;
    }
  }).filter((record) => record !== null);
}

function rotateTerminal(kind, now = Date.now()) {
  const records = listRecords(kind);
  const terminal = records.filter((record) => record.deleted_at && Number.isFinite(Date.parse(record.deleted_at)) && Date.parse(record.deleted_at) <= now).sort((a, b) => Date.parse(a.deleted_at) - Date.parse(b.deleted_at));
  const countPressure = Math.max(0, records.length - RECORD_LIMIT);
  const remove = terminal.filter((record, index) => now - Date.parse(record.deleted_at) >= 30 * 86400000 || index < countPressure);
  for (const record of remove) {
    const target = recordFile(kind, record.id);
    fs.unlinkSync(target);
    fsyncDirectory(path.dirname(target));
  }
  return remove.map((record) => record.id);
}

module.exports = {
  RECORD_LIMIT,
  SCHEMA,
  STATE_LIMIT,
  bind: (token) => require('./storage-capability.cjs').bind(token, { createPreparedAuthority, createInstalledAuthority, createRecord, recoverAtomicTemps, replaceRecord, withRecordMutation, rotateTerminal, transitionInstalledAuthority, transitionRun }),
  canonicalIdentity,
  directoryBytes,
  // Exported so the container layer can validate a marker's seal against the SAME contract that
  // writes it, instead of re-implementing a looser copy. A read-only predicate: it decides nothing
  // and mutates nothing, so it does not belong to the capability-bound surface.
  exactSeal,
  listRecords,
  readRecord,
  readAuthorityState,
  validateRecord,
  validateAuthorityShape,
  validateInstalledAuthority,
  validateStateLayout,
};
