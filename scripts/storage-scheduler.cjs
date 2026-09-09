'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mutationCapability = require('./storage-capability.cjs').claim();
const { assertToolchainSafeLayout, fixedLayout, generatedId } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const { createRecord, replaceRecord } = stateMutations;
const { readRecord, validateInstalledAuthority } = state;
const containerMutations = require('./storage-containers.cjs').bind(mutationCapability);
const gateMutations = require('./storage-gate.cjs').bind(mutationCapability);

const LABEL = 'com.pentacle.mobile.storage-janitor';
const BASELINE = 'scheduler-baseline.json';

function fsyncDirectory(directory) { const descriptor = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function atomicJson(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  fsyncDirectory(path.dirname(target));
}

function acquireScheduler(authority, recover = false) {
  const target = path.join(fixedLayout().state, 'scheduler.lock');
  const token = crypto.randomUUID();
  const value = { schema: 1, token, generation: authority.generation, host: require('node:os').hostname(), uid: process.getuid(), pid: process.pid, created_at: new Date().toISOString() };
  try { fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); fsyncDirectory(path.dirname(target)); }
  catch (error) {
    if (error.code !== 'EEXIST' || !recover) throw new Error('SCHEDULER_SINGLETON_HELD');
    const held = validateSchedulerLock(JSON.parse(fs.readFileSync(target, 'utf8')));
    if (held.schema !== 1 || held.generation !== authority.generation || held.host !== value.host || held.uid !== value.uid || !Number.isInteger(held.pid)) throw new Error('SCHEDULER_LOCK_INVALID');
    try { process.kill(held.pid, 0); throw new Error('SCHEDULER_SINGLETON_HELD'); } catch (probe) { if (probe.message === 'SCHEDULER_SINGLETON_HELD' || probe.code === 'EPERM') throw probe; if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(target); fsyncDirectory(path.dirname(target));
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); fsyncDirectory(path.dirname(target));
  }
  return () => {
    const held = validateSchedulerLock(JSON.parse(fs.readFileSync(target, 'utf8')));
    if (held.token !== token || held.generation !== authority.generation) throw new Error('SCHEDULER_LOCK_DRIFT');
    fs.unlinkSync(target); fsyncDirectory(path.dirname(target));
  };
}

function validateSchedulerLock(value) {
  const keys = ['created_at', 'generation', 'host', 'pid', 'schema', 'token', 'uid'];
  const exactClock = (clock) => typeof clock === 'string' && Number.isFinite(Date.parse(clock)) && new Date(clock).toISOString() === clock;
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) || value.schema !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.generation) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token) || typeof value.host !== 'string' || !Number.isInteger(value.uid) || !Number.isInteger(value.pid) || value.pid <= 0 || !exactClock(value.created_at)) throw new Error('SCHEDULER_LOCK_INVALID');
  return value;
}

function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

function renderPlist() {
  const root = path.resolve(__dirname, '..');
  const argv = [process.execPath, path.join(__dirname, 'storage-cli.cjs'), 'storage:janitor', 'dry-run'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${argv.map((item) => `<string>${xml(item)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>StartInterval</key><integer>21600</integer><key>RunAtLoad</key><false/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`SCHEDULER_COMMAND_FAILED:${path.basename(binary)}:${String(result.stderr || result.error || '').trim()}`);
  return String(result.stdout || '').trim();
}

function atomicText(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  fsyncDirectory(path.dirname(target));
}

function latestCommittedDigest() {
  try {
    const committed = require('./storage-state.cjs').listRecords('scheduler').filter((transaction) => transaction.state === 'committed' && transaction.candidate_digest).sort((left, right) => Date.parse(right.committed_at || right.recovered_at) - Date.parse(left.committed_at || left.recovered_at));
    return committed[0]?.candidate_digest || null;
  } catch { return null; }
}

function plistOwned(target, expectedDigest) {
  if (arguments.length < 2) throw new Error('SCHEDULER_EXPECTED_DIGEST_REQUIRED');
  if (!fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) return false;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  return /^[0-9a-f]{64}$/.test(expectedDigest) && digest === expectedDigest;
}

function baselineFile() { return path.join(fixedLayout().state, BASELINE); }

function prepareBaseline() {
  const target = baselineFile();
  if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'));
  const launchAgent = fixedLayout().launchAgent;
  if (fs.existsSync(launchAgent)) throw new Error('SCHEDULER_EXISTING_PLIST_OWNERSHIP_UNPROVEN');
  const baseline = { schema: 1, existed: false, digest: null, captured_at: new Date().toISOString() };
  atomicJson(target, baseline);
  return baseline;
}

function schedulerTransition(transaction, nextState, patch = {}) {
  require('./storage-authority.cjs').transition('scheduler', transaction.state, nextState);
  const next = { ...transaction, ...patch, state: nextState, revision: transaction.revision + 1 };
  return replaceRecord('scheduler', transaction.id, transaction.revision, next);
}

function finishRollbackAuthority(action) {
  let authority = require('./storage-state.cjs').readAuthorityState();
  if (action === 'update' && authority.state === 'updating') {
    stateMutations.transitionInstalledAuthority('updating', 'installed');
    return;
  }
  if (action === 'install' && authority.state === 'installed') {
    authority = stateMutations.transitionInstalledAuthority('installed', 'restoring');
  }
  if (action === 'install' && authority.state === 'restoring') {
    stateMutations.transitionInstalledAuthority('restoring', 'absent');
  }
}

function smokeReport(transaction) {
  const directory = path.join(fixedLayout().state, 'reports');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prior = new Set(fs.readdirSync(directory));
  const started = Date.now();
  command('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
  let report;
  while (Date.now() - started < 15000) {
    const created = fs.readdirSync(directory).filter((name) => !prior.has(name) && /^[0-9a-f-]{36}\.json$/.test(name));
    if (created.length === 1) { report = path.join(directory, created[0]); break; }
    if (created.length > 1) throw new Error('SCHEDULER_SMOKE_REPORT_CARDINALITY');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!report) throw new Error('SCHEDULER_SMOKE_REPORT_TIMEOUT');
  const value = JSON.parse(fs.readFileSync(report, 'utf8'));
  validateSmokeReport(value, path.basename(report), started, { transaction_id: transaction.id, generation: transaction.generation, candidate_digest: transaction.candidate_digest });
  return value;
}

function validateSmokeReport(value, filename, started, expected) {
  const keys = Object.keys(value).sort();
  const bindingKeys = ['candidate_digest', 'generation', 'transaction_id'];
  if (!expected || JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(bindingKeys) || JSON.stringify(keys) !== JSON.stringify(['completed_at', 'entries', 'errors', 'mode', 'report_id', 'schema', ...bindingKeys].sort()) || value.schema !== 1 || filename !== `${value.report_id}.json` || value.mode !== 'dry-run' || !Array.isArray(value.entries) || !Array.isArray(value.errors) || value.errors.length || !Number.isFinite(Date.parse(value.completed_at)) || Date.parse(value.completed_at) < started || bindingKeys.some((field) => value[field] !== expected[field])) throw new Error('SCHEDULER_SMOKE_REPORT_INVALID');
  return true;
}

function launchDomain() { return `gui/${process.getuid()}/${LABEL}`; }

function loaded() { return spawnSync('/bin/launchctl', ['print', launchDomain()]).status === 0; }

function bootoutIfLoaded() {
  if (!loaded()) return false;
  command('/bin/launchctl', ['bootout', launchDomain()]);
  if (loaded()) throw new Error('SCHEDULER_BOOTOUT_UNVERIFIED');
  return true;
}

function bootstrapAndVerify(target) {
  command('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, target]);
  if (!loaded()) throw new Error('SCHEDULER_BOOTSTRAP_UNVERIFIED');
}

function restoreBaseline() {
  const baseline = JSON.parse(fs.readFileSync(baselineFile(), 'utf8'));
  if (baseline.schema !== 1 || baseline.existed !== false || baseline.digest !== null) throw new Error('SCHEDULER_BASELINE_INVALID');
  const target = fixedLayout().launchAgent;
  if (fs.existsSync(target) && !plistOwned(target, latestCommittedDigest())) throw new Error('SCHEDULER_UNINSTALL_UNOWNED');
  bootoutIfLoaded();
  if (fs.existsSync(target)) { fs.unlinkSync(target); fsyncDirectory(path.dirname(target)); }
}

function installOrUpdate(action) {
  // Fail closed before any object is created: every installed root and mountpoint must be
  // toolchain-safe. A root containing a space silently broke Release builds ~40 minutes into a gate
  // (unquoted CocoaPods/Expo script phases), and no amount of care downstream can compensate for a
  // root the toolchain cannot express. Enforcing it here makes such a root impossible to install
  // rather than discovered mid-run.
  // Environment precondition FIRST: never adopt a label or plist that may belong to another
  // installed root. That check is about not harming someone else, so it precedes validating our
  // own configuration; ordering only decides which error surfaces when both are violated.
  if (action === 'install' && (fs.existsSync(fixedLayout().launchAgent) || spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).status === 0)) throw new Error('SCHEDULER_EXISTING_LABEL_OR_PLIST');
  assertToolchainSafeLayout();
  let authority;
  if (action === 'install') {
    if (fs.existsSync(path.join(fixedLayout().state, 'authority.json'))) {
      authority = require('./storage-state.cjs').readAuthorityState();
      if (authority.state === 'absent') authority = stateMutations.transitionInstalledAuthority('absent', 'prepared');
      if (authority.state === 'prepared') authority = stateMutations.transitionInstalledAuthority('prepared', 'installed');
      if (authority.state !== 'installed') throw new Error('AUTHORITY_INSTALL_RECOVERY_REQUIRED');
      authority = validateInstalledAuthority();
    }
    else {
      containerMutations.ensureStateImage();
      authority = stateMutations.createInstalledAuthority();
    }
  }
  if (action === 'update') authority = validateInstalledAuthority();
  const release = acquireScheduler(authority);
  if (action === 'update') authority = stateMutations.transitionInstalledAuthority('installed', 'updating');
  try {
    prepareBaseline();
    const target = fixedLayout().launchAgent;
    const committedDigest = latestCommittedDigest();
    if (action === 'update' && !plistOwned(target, committedDigest)) throw new Error('SCHEDULER_UPDATE_UNOWNED');
    const priorText = action === 'update' ? fs.readFileSync(target, 'utf8') : null;
    const priorLoaded = action === 'update' && spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).status === 0;
    if (require('./storage-state.cjs').listRecords('scheduler').some((entry) => !['committed', 'restored'].includes(entry.state))) throw new Error('SCHEDULER_TRANSACTION_INCOMPLETE');
    const id = generatedId();
    let transaction = createRecord('scheduler', { schema: 1, id, revision: 0, state: 'absent', action, generation: authority.generation, prior_owned: plistOwned(target, committedDigest), prior_content: priorText, prior_loaded: priorLoaded, created_at: new Date().toISOString() });
    transaction = schedulerTransition(transaction, 'prepared', { candidate_digest: crypto.createHash('sha256').update(renderPlist()).digest('hex') });
    try {
      if (action === 'update' && priorLoaded) bootoutIfLoaded();
      atomicText(target, renderPlist());
      transaction = schedulerTransition(transaction, 'candidate_installed');
      bootstrapAndVerify(target);
      const smoke = smokeReport(transaction);
      transaction = schedulerTransition(transaction, 'smoke_verified', { smoke_report_id: smoke.report_id, smoke_report_digest: crypto.createHash('sha256').update(JSON.stringify(smoke)).digest('hex') });
      transaction = schedulerTransition(transaction, 'committed', { committed_at: new Date().toISOString() });
      if (action === 'update') stateMutations.transitionInstalledAuthority('updating', 'installed');
      return transaction;
    } catch (error) {
      transaction = schedulerTransition(transaction, 'rolling_back', { failure: String(error.message || error) });
      bootoutIfLoaded();
      if (action === 'install') {
        if (fs.existsSync(target) && plistOwned(target, transaction.candidate_digest)) { fs.unlinkSync(target); fsyncDirectory(path.dirname(target)); }
      } else {
        atomicText(target, priorText);
        if (priorLoaded) bootstrapAndVerify(target);
      }
      schedulerTransition(transaction, 'restored', { restored_at: new Date().toISOString() });
      finishRollbackAuthority(action);
      throw error;
    }
  } catch (error) {
    if (action === 'update') {
      const current = require('./storage-state.cjs').readAuthorityState();
      if (current.state === 'updating') stateMutations.transitionInstalledAuthority('updating', 'installed');
    }
    throw error;
  } finally { release(); }
}

function recoverCommitted() {
  stateMutations.recoverAtomicTemps();
  let authority = require('./storage-state.cjs').readAuthorityState();
  if (authority.state === 'prepared') authority = stateMutations.transitionInstalledAuthority('prepared', 'installed');
  if (authority.state === 'restoring') {
    const releaseRestoring = acquireScheduler(authority, true);
    try { restoreBaseline(); stateMutations.transitionInstalledAuthority('restoring', 'absent'); return 1; }
    finally { releaseRestoring(); }
  }
  if (!['installed', 'updating'].includes(authority.state)) throw new Error('SCHEDULER_AUTHORITY_STATE');
  const release = acquireScheduler(authority, true);
  const target = fixedLayout().launchAgent;
  const directory = path.dirname(target);
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.startsWith(`${path.basename(target)}.`) || !entry.name.endsWith('.tmp')) continue;
      const temporary = path.join(directory, entry.name);
      const stat = fs.lstatSync(temporary);
      if (!entry.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || !/^com\.pentacle\.mobile\.storage-janitor\.plist\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) throw new Error('SCHEDULER_TEMP_INVALID');
      fs.unlinkSync(temporary);
    }
    fsyncDirectory(directory);
  }
  const transactions = require('./storage-state.cjs').listRecords('scheduler').filter((entry) => !['committed', 'restored'].includes(entry.state));
  try { for (let transaction of transactions) {
    if (transaction.generation !== authority.generation) throw new Error('SCHEDULER_GENERATION_DRIFT');
    if (transaction.state === 'absent') transaction = schedulerTransition(transaction, 'prepared', { recovered_at: new Date().toISOString() });
    if (['candidate_installed', 'smoke_verified'].includes(transaction.state) && plistOwned(target, transaction.candidate_digest)) {
      if (!loaded()) throw new Error('SCHEDULER_CANDIDATE_NOT_LOADED');
      if (transaction.state === 'candidate_installed') {
        const smoke = smokeReport(transaction);
        transaction = schedulerTransition(transaction, 'smoke_verified', { smoke_report_id: smoke.report_id, smoke_report_digest: crypto.createHash('sha256').update(JSON.stringify(smoke)).digest('hex') });
      } else {
        const report = path.join(fixedLayout().state, 'reports', `${transaction.smoke_report_id}.json`);
        const smoke = JSON.parse(fs.readFileSync(report, 'utf8'));
        validateSmokeReport(smoke, path.basename(report), Date.parse(transaction.created_at), { transaction_id: transaction.id, generation: transaction.generation, candidate_digest: transaction.candidate_digest });
        if (crypto.createHash('sha256').update(JSON.stringify(smoke)).digest('hex') !== transaction.smoke_report_digest) throw new Error('SCHEDULER_SMOKE_REPORT_DRIFT');
      }
      schedulerTransition(transaction, 'committed', { recovered_at: new Date().toISOString() });
    } else {
      if (transaction.state !== 'rolling_back') transaction = schedulerTransition(transaction, 'rolling_back', { recovered_at: new Date().toISOString() });
      if (transaction.action === 'update' && typeof transaction.prior_content === 'string') {
        bootoutIfLoaded();
        atomicText(fixedLayout().launchAgent, transaction.prior_content);
        if (transaction.prior_loaded) bootstrapAndVerify(fixedLayout().launchAgent);
      } else if (fs.existsSync(fixedLayout().launchAgent) && plistOwned(fixedLayout().launchAgent, transaction.candidate_digest)) { bootoutIfLoaded(); fs.unlinkSync(fixedLayout().launchAgent); fsyncDirectory(path.dirname(fixedLayout().launchAgent)); }
      schedulerTransition(transaction, 'restored', { restored_at: new Date().toISOString() });
      finishRollbackAuthority(transaction.action);
    }
  }
  if (require('./storage-state.cjs').readAuthorityState().state === 'updating') finishRollbackAuthority('update');
  return transactions.length;
  } finally { release(); }
}

function uninstall() {
  let authority = validateInstalledAuthority();
  const release = acquireScheduler(authority, true);
  authority = stateMutations.transitionInstalledAuthority('installed', 'restoring');
  try {
  restoreBaseline();
  stateMutations.transitionInstalledAuthority('restoring', 'absent');
  return { restored: true };
  } finally { release(); }
}

module.exports = { LABEL, bind: (token) => require('./storage-capability.cjs').bind(token, { installOrUpdate, recoverCommitted, uninstall }), plistOwned, renderPlist, smokeReport, validateSmokeReport };
