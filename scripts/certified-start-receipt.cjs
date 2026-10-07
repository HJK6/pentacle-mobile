'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { heavyWork, heavyWorkCommand } = require('./quiet-host-processes.cjs');

const POLICY = Object.freeze({
  revision: 'mobile-quiet-60s-peak10000-v1',
  minimumSamples: 60, minimumElapsedMs: 60000,
  medianTpsBelow: 2000, peakTpsAtMost: 10000,
  observerBoundMs: 90000,
  // New interval: reviewed as part of launch-chain QA before activation.
  maximumClaimAgeMs: 120000,
  combinedClosingBudgetMs: 22500000,
  remainingFullBudgetMs: 11580000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const refuse = code => { throw new Error(`QUIET_START_${code}`); };
const exactIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;

function validateReceipt(receipt, window, expected, now = Date.now()) {
  if (!receipt || receipt.schema !== 2 || receipt.policy_revision !== POLICY.revision
      || receipt.certification !== 'UNCERTIFIED' || receipt.native_certification !== false) refuse('SCHEMA_POLICY');
  if (!UUID.test(receipt.attempt_id || '') || !SHA.test(receipt.candidate_sha || '')
      || !SHA.test(receipt.gate_code_sha || '') || !DIGEST.test(receipt.observer_sha256 || '')) refuse('IDENTITY');
  if (receipt.host !== expected.host || receipt.uid !== expected.uid) refuse('HOST');
  if (receipt.candidate_sha !== expected.candidateSha || receipt.gate_code_sha !== expected.gateCodeSha) refuse('PIN');
  if (receipt.observer_sha256 !== expected.observerSha256 || receipt.raw_evidence_digest !== expected.rawDigest) refuse('RAW_DIGEST');
  if (!window || window.schema !== 1 || window.fd_go !== true || !UUID.test(window.tell_id || '')
      || typeof window.from_stream !== 'string' || !window.from_stream
      || window.host !== expected.host || window.uid !== expected.uid
      || window.candidate_sha !== expected.candidateSha || window.gate_code_sha !== expected.gateCodeSha
      || window.policy_revision !== POLICY.revision
      || window.attempt_id !== receipt.attempt_id
      || receipt.fd_window_go_sha256 !== expected.windowDigest) refuse('WINDOW_BINDING');
  const start = window.not_before_epoch * 1000;
  const end = window.expires_epoch * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || now < start || now >= end) refuse('WINDOW_TIME');
  if (end - now < POLICY.combinedClosingBudgetMs) refuse('WINDOW_BUDGET');
  if (!exactIso(receipt.started_at) || !exactIso(receipt.finished_at)) refuse('CLOCK');
  const observedStart = Date.parse(receipt.started_at), finished = Date.parse(receipt.finished_at);
  if (observedStart < start || finished < observedStart || finished > now || finished >= end) refuse('CLOCK');
  if (now - finished > POLICY.maximumClaimAgeMs) refuse('STALE');

  const intervals = receipt.disk_intervals;
  if (!Array.isArray(intervals) || intervals.length < POLICY.minimumSamples
      || !Number.isFinite(receipt.observation_elapsed_ms) || receipt.observation_elapsed_ms < POLICY.minimumElapsedMs
      || finished - observedStart < receipt.observation_elapsed_ms) refuse('INCOMPLETE');
  let elapsed = -1;
  for (const [index, row] of intervals.entries()) {
    if (row.index !== index + 1 || !Number.isFinite(row.elapsed_ms) || row.elapsed_ms <= elapsed
        || !Number.isFinite(row.tps) || row.tps < 0 || typeof row.raw !== 'string') refuse('SAMPLE');
    elapsed = row.elapsed_ms;
  }
  if (elapsed < POLICY.minimumElapsedMs || elapsed > receipt.observation_elapsed_ms) refuse('INCOMPLETE');
  const ordered = intervals.map(row => row.tps).sort((a, b) => a - b);
  const median = (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2;
  const peak = ordered.at(-1);
  if (receipt.median_disk_tps !== median || receipt.max_disk_tps !== peak) refuse('SAMPLE_SUMMARY');
  if (median >= POLICY.medianTpsBelow || peak > POLICY.peakTpsAtMost) refuse('THRESHOLD');
  const terminal = receipt.iostat;
  if (!terminal || terminal.code !== 0 || terminal.signal !== null
      || terminal.observer_bound_ms !== POLICY.observerBoundMs
      || terminal.initial_cumulative_row_excluded !== true || terminal.numeric_rows !== intervals.length + 1
      || !Array.isArray(terminal.parser_errors) || terminal.parser_errors.length
      || terminal.ownership?.disposition !== 'completed' || terminal.ownership?.group_alive_after !== false) refuse('COMPLETION');
  const processes = receipt.process_checks, simulators = receipt.simulator_checks;
  if (!Array.isArray(processes) || !Array.isArray(simulators)) refuse('PROCESS_SIMULATOR');
  const names = new Set(processes.map(row => row.label));
  const required = ['process-start', 'process-end', ...Array.from({ length: Math.floor(receipt.observation_elapsed_ms / 10000) }, (_, i) => `process-during-${i + 1}`)];
  if (required.some(name => !names.has(name)) || names.size !== processes.length
      || processes.some(row => row.ok !== true || row.status !== 0 || row.error !== null || row.malformed_rows !== 0
        || row.identity?.status !== 0 || row.identity?.error !== null
        || !Array.isArray(row.unavailable) || row.unavailable.length || !Array.isArray(row.heavy) || row.heavy.length)
      || simulators.length !== 2 || simulators[0].label !== 'simulator-start' || simulators[1].label !== 'simulator-end'
      || simulators.some(row => row.ok !== true || row.status !== 0 || row.error !== null || !Array.isArray(row.booting) || row.booting.length)) refuse('PROCESS_SIMULATOR');
  if (receipt.ready !== true || receipt.result !== 'QUIET_60S_PASS' || receipt.error) refuse('NOT_READY');
  return {
    schema: 1, policy_revision: POLICY.revision, attempt_id: receipt.attempt_id,
    host: receipt.host, uid: receipt.uid, candidate_sha: receipt.candidate_sha,
    gate_code_sha: receipt.gate_code_sha, observer_sha256: receipt.observer_sha256,
    raw_evidence_digest: expected.rawDigest, fd_window_sha256: expected.windowDigest,
    observed_finished_at: receipt.finished_at, claimed_at: new Date(now).toISOString(),
    fd_window_expires_at: new Date(end).toISOString(), receipt_sha256: expected.receiptDigest,
  };
}

function readRegular(file, maximum = 1024 * 1024) {
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch { refuse('FILE'); }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum || stat.uid !== process.getuid()) refuse('FILE');
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function readInputs(receiptFile) {
  if (typeof receiptFile !== 'string' || !receiptFile || !path.isAbsolute(receiptFile)) refuse('RECEIPT_REQUIRED');
  const root = path.dirname(receiptFile);
  try { if (fs.realpathSync(root) !== root) refuse('FILE'); } catch { refuse('FILE'); }
  const bytes = readRegular(receiptFile);
  let receipt, window;
  const windowBytes = readRegular(path.join(root, 'fd-window.json'));
  try { receipt = JSON.parse(bytes); window = JSON.parse(windowBytes); } catch { refuse('MALFORMED'); }
  const raw = fs.readdirSync(root).filter(name => name !== path.basename(receiptFile) && name !== 'fd-window.json').sort().map(name => {
    if (name.includes('/') || name === '.' || name === '..') refuse('FILE');
    const content = readRegular(path.join(root, name), 16 * 1024 * 1024);
    return { relative: name, size: content.length, sha256: hash(content) };
  });
  const byName = new Map(raw.map(row => [row.relative, row]));
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || !Array.isArray(receipt.process_checks) || !Array.isArray(receipt.simulator_checks)) refuse('MALFORMED');
  for (const check of [...receipt.process_checks, ...receipt.simulator_checks, receipt.iostat || {}]) {
    const label = check.label || 'iostat';
    if (!/^(?:process-(?:start|end|during-[1-9]\d*)|simulator-(?:start|end)|iostat)$/.test(label)
        || !DIGEST.test(check.stdout_sha256 || '') || !DIGEST.test(check.stderr_sha256 || '')) refuse('RAW_DIGEST');
    if (byName.get(`${label}.stdout.log`)?.sha256 !== check.stdout_sha256
        || byName.get(`${label}.stderr.log`)?.sha256 !== check.stderr_sha256) refuse('RAW_DIGEST');
    if (check.identity && (!DIGEST.test(check.identity.stdout_sha256 || '') || !DIGEST.test(check.identity.stderr_sha256 || '')
        || byName.get(`${label}-identity.stdout.log`)?.sha256 !== check.identity.stdout_sha256
        || byName.get(`${label}-identity.stderr.log`)?.sha256 !== check.identity.stderr_sha256)) refuse('RAW_DIGEST');
  }
  if (!Number.isInteger(receipt.observer_pid) || receipt.observer_pid < 1) refuse('PROCESS_IDENTITY');
  for (const check of receipt.process_checks) {
    let identities;
    try { identities = JSON.parse(readRegular(path.join(root, `${check.label}-identity.stdout.log`), 16 * 1024 * 1024)); } catch { refuse('RAW_PARSE'); }
    if (!Array.isArray(identities)) refuse('RAW_PARSE');
    const rows = readRegular(path.join(root, `${check.label}.stdout.log`), 16 * 1024 * 1024).toString().split('\n').filter(line => line.trim()).map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) refuse('RAW_PARSE');
      return { pid: Number(match[1]), ppid: Number(match[2]) };
    });
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (byPid.size !== rows.length || !byPid.has(receipt.observer_pid)) refuse('RAW_PARSE');
    const ancestors = new Set(); let cursor = receipt.observer_pid;
    while (cursor > 0 && !ancestors.has(cursor)) { ancestors.add(cursor); cursor = byPid.get(cursor)?.ppid || 0; }
    if (canonical([...ancestors]) !== canonical(check.excluded_own_ancestor_pids)) refuse('PROCESS_IDENTITY');
    if (new Set(identities.map(row => row.pid)).size !== identities.length
        || identities.some(row => !byPid.has(row.pid))) refuse('RAW_PARSE');
    const unavailable = identities.filter(row => !ancestors.has(row.pid) && !row.exited
      && (row.identity_errno !== 0 || !row.executable || !Array.isArray(row.argv) && typeof row.command_line !== 'string'));
    const heavy = identities.filter(row => !ancestors.has(row.pid) && !row.exited && row.identity_errno === 0
      && (Array.isArray(row.argv) ? heavyWork(row.executable, row.argv)
        : typeof row.command_line === 'string' && heavyWorkCommand(row.executable, row.command_line)));
    if (canonical(unavailable) !== canonical(check.unavailable) || canonical(heavy) !== canonical(check.heavy)) refuse('PROCESS_IDENTITY');
  }
  for (const check of receipt.simulator_checks) {
    let devices;
    try {
      const parsed = JSON.parse(readRegular(path.join(root, `${check.label}.stdout.log`), 16 * 1024 * 1024));
      if (!parsed.devices || Object.values(parsed.devices).some(value => !Array.isArray(value))) refuse('RAW_PARSE');
      devices = Object.values(parsed.devices).flat();
    } catch { refuse('RAW_PARSE'); }
    const booting = devices.filter(device => !['Shutdown', 'Booted'].includes(device.state));
    if (canonical(booting) !== canonical(check.booting)) refuse('PROCESS_SIMULATOR');
  }
  // Replay the disk parser from the reviewed observer against the retained command output.
  const numeric = readRegular(path.join(root, 'iostat.stdout.log'), 16 * 1024 * 1024).toString().split('\n').filter(line => /^\s*\d/.test(line));
  const parsed = numeric.map(line => {
    const fields = line.trim().split(/\s+/).map(Number);
    if (!fields.length || fields.length % 3 || !fields.every(Number.isFinite)) refuse('RAW_PARSE');
    return { raw: line, tps: fields.filter((_, i) => i % 3 === 1).reduce((a, b) => a + b, 0) };
  });
  if (!Array.isArray(receipt.disk_intervals) || parsed.length !== receipt.disk_intervals.length + 1
      || parsed.slice(1).some((row, i) => row.raw !== receipt.disk_intervals[i].raw || row.tps !== receipt.disk_intervals[i].tps)) refuse('RAW_PARSE');
  return { receipt, window, receiptDigest: hash(bytes), windowDigest: hash(windowBytes), rawDigest: hash(canonical(raw)), root, raw, receiptFile };
}

function requireReceiptInput(environment = process.env) {
  const file = environment.PENTACLE_GATE_QUIET_RECEIPT;
  if (!file) refuse('RECEIPT_REQUIRED');
  return file;
}

function git(root, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) delete env[key];
  const result = spawnSync('/usr/bin/git', args, { cwd: root, env, encoding: 'utf8' });
  if (result.error || result.status !== 0) refuse('PIN');
  return result.stdout.trim();
}

function expectedBindings(repository, candidateRef, authority, inputs) {
  return {
    host: authority.host, uid: authority.uid,
    candidateSha: git(repository, ['rev-parse', `${candidateRef}^{commit}`]),
    gateCodeSha: git(repository, ['rev-parse', 'HEAD']),
    observerSha256: hash(readRegular(path.join(repository, 'scripts/observe-mobile-quiet.cjs'))),
    rawDigest: inputs.rawDigest, windowDigest: inputs.windowDigest, receiptDigest: inputs.receiptDigest,
  };
}

function assertUnclaimed(claim, runs, sameRunId = null) {
  const prior = runs.find(run => run.quiet_start && (run.quiet_start.attempt_id === claim.attempt_id
    || run.quiet_start.receipt_sha256 === claim.receipt_sha256
    || run.quiet_start.raw_evidence_digest === claim.raw_evidence_digest));
  if (prior && (prior.id !== sameRunId || canonical(prior.quiet_start) !== canonical({ ...claim, run_id: sameRunId }))) refuse('ALREADY_CLAIMED');
  return claim;
}

function inspectNativeStart(repository, candidateRef, environment, authority, runs, now = Date.now()) {
  const inputs = readInputs(requireReceiptInput(environment));
  const expected = expectedBindings(repository, candidateRef, authority, inputs);
  const claim = validateReceipt(inputs.receipt, inputs.window, expected, now);
  assertUnclaimed(claim, runs);
  return { ...inputs, expected, claim };
}

function validateClaimShape(claim) {
  const keys = ['schema', 'policy_revision', 'attempt_id', 'host', 'uid', 'candidate_sha', 'gate_code_sha', 'observer_sha256', 'raw_evidence_digest', 'fd_window_sha256', 'observed_finished_at', 'claimed_at', 'fd_window_expires_at', 'receipt_sha256', 'run_id'].sort();
  if (!claim || canonical(Object.keys(claim).sort()) !== canonical(keys) || claim.schema !== 1
      || claim.policy_revision !== POLICY.revision || !UUID.test(claim.attempt_id || '') || !UUID.test(claim.run_id || '')
      || typeof claim.host !== 'string' || !claim.host || !Number.isInteger(claim.uid) || claim.uid < 0
      || !SHA.test(claim.candidate_sha || '') || !SHA.test(claim.gate_code_sha || '')
      || ['observer_sha256', 'raw_evidence_digest', 'fd_window_sha256', 'receipt_sha256'].some(key => !DIGEST.test(claim[key] || ''))
      || ['observed_finished_at', 'claimed_at', 'fd_window_expires_at'].some(key => !exactIso(claim[key]))) refuse('CLAIM');
  return true;
}

function copyClaimInputs(input, evidenceRoot) {
  const target = path.join(evidenceRoot, 'quiet-start');
  fs.mkdirSync(target, { mode: 0o700 });
  for (const [name, digest] of [['receipt.json', input.receiptDigest], ['fd-window.json', input.windowDigest], ...input.raw.map(row => [row.relative, row.sha256])]) {
    const file = name === 'receipt.json' ? input.receiptFile : path.join(input.root, name);
    const bytes = readRegular(file, 16 * 1024 * 1024);
    if (hash(bytes) !== digest) refuse('RAW_DIGEST');
    fs.writeFileSync(path.join(target, name), bytes, { mode: 0o600, flag: 'wx' });
  }
  return target;
}

function validateClaimEvidence(evidenceRoot, run) {
  validateClaimShape(run.quiet_start);
  const claim = run.quiet_start;
  if (claim.run_id !== run.id || claim.host !== run.owner.host || claim.uid !== run.owner.uid
      || claim.candidate_sha !== run.candidate_ref || claim.gate_code_sha !== run.gate_code_sha
      || claim.claimed_at !== run.reserved_at) refuse('CLAIM_BINDING');
  const inputs = readInputs(path.join(evidenceRoot, 'quiet-start', 'receipt.json'));
  const checked = validateReceipt(inputs.receipt, inputs.window, {
    host: claim.host, uid: claim.uid, candidateSha: run.candidate_ref, gateCodeSha: run.gate_code_sha,
    observerSha256: claim.observer_sha256, rawDigest: inputs.rawDigest,
    windowDigest: inputs.windowDigest, receiptDigest: inputs.receiptDigest,
  }, Date.parse(claim.claimed_at));
  if (canonical({ ...checked, run_id: run.id }) !== canonical(claim)) refuse('CLAIM_BINDING');
  return inputs;
}

function requireAllocatedStart(runId, repository, now = Date.now()) {
  const state = require('./storage-state.cjs');
  const authority = state.validateInstalledAuthority();
  const run = state.readRecord('runs', runId);
  if (run.generation !== authority.generation || run.owner.host !== authority.host || run.owner.uid !== authority.uid) refuse('HOST');
  const evidence = require('./storage-containers.cjs').resolveMounted('evidence', runId).mount;
  const input = validateClaimEvidence(evidence, run);
  if (run.quiet_start.observer_sha256 !== hash(readRegular(path.join(repository, 'scripts/observe-mobile-quiet.cjs')))) refuse('PIN');
  const end = input.window.expires_epoch * 1000;
  if (now < Date.parse(run.quiet_start.claimed_at) || now >= end) refuse('WINDOW_TIME');
  if (end - now < POLICY.remainingFullBudgetMs) refuse('WINDOW_BUDGET');
  return run.quiet_start;
}

module.exports = { POLICY, UUID, SHA, DIGEST, hash, canonical, validateReceipt, readInputs, readRegular, requireReceiptInput,
  expectedBindings, assertUnclaimed, inspectNativeStart, validateClaimShape, copyClaimInputs, validateClaimEvidence, requireAllocatedStart };
