'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ALIASES, HISTORICAL_WITNESSES } = require('./storage-authority.cjs');

const TARGETS = Object.freeze({
  AUTH: ['storage-adversarial.test.cjs', 'authority intent exists before allocation'],
  INTENT: ['storage-adversarial.test.cjs', 'authority intent exists before allocation'],
  ATOMIC: ['storage-gate.test.cjs', 'publication recovers after every durable crash boundary'],
  HANDOFF: ['storage-adversarial.test.cjs', 'registry handoff is a recoverable multi-record transaction'],
  REF: ['storage-janitor.test.cjs', 'worktree proof blocks references'],
  SOURCE: ['storage-adversarial.test.cjs', 'source scan rejects every malformed'],
  GIT: ['storage-adversarial.test.cjs', 'worktree admission immutably binds'],
  CAP: ['storage-adversarial.test.cjs', 'sandbox cannot grant writes outside capped roots'],
  PROC: ['storage-adversarial.test.cjs', 'normal child exit fails closed while descendants survive'],
  EVID: ['storage-adversarial.test.cjs', 'evidence requires the complete recorder-authoritative gate set'],
  RET: ['storage-adversarial.test.cjs', 'dead-resource retention starts at immutable first observation'],
  SCHED: ['storage-adversarial.test.cjs', 'launchd recovers interrupted transactions'],
  CORPUS: ['storage-gate.test.cjs', 'publication recovers after every durable crash boundary'],
});

const LEGACY = Object.freeze({
  AUTH: ['storage-native-root.test.cjs', 'native preparation registers image and scratch'],
  REF: ['storage-janitor.test.cjs', 'worktree proof blocks references'],
  GIT: ['storage-janitor.test.cjs', 'worktree proof blocks references'],
  CAP: ['storage-runtime.test.cjs', 'sandbox writes are restricted to the quota root'],
  PROC: ['storage-supervisor.test.cjs', 'unresponsive owned group escalates'],
  EVID: ['storage-policy.test.cjs', 'cleanup preserves and fails on unknown files'],
  RET: ['storage-janitor.test.cjs', 'retention boundaries are exact'],
  SCHED: ['storage-janitor-launchd.test.cjs', 'failed update restores immediate current state'],
});

function extract(repository, sha, destination, remaining) {
  const archive = spawnSync('/usr/bin/git', ['-C', repository, 'archive', sha, 'scripts'], { timeout: remaining(), maxBuffer: 32 * 1024 * 1024 });
  if (archive.status !== 0) throw Object.assign(new Error(`HISTORICAL_ARCHIVE:${sha}`), { stdout: archive.stdout, stderr: archive.stderr });
  const unpack = spawnSync('/usr/bin/tar', ['-x', '-C', destination], { timeout: remaining(), input: archive.stdout, maxBuffer: 32 * 1024 * 1024 });
  if (unpack.status !== 0) throw Object.assign(new Error(`HISTORICAL_UNPACK:${sha}`), { stdout: unpack.stdout, stderr: unpack.stderr });
}

function targetFor(id, parentRoot) {
  const key = id.slice(id.indexOf('-') + 1);
  const selected = fs.existsSync(path.join(parentRoot, 'scripts', 'storage-adversarial.test.cjs')) ? TARGETS[key] : (LEGACY[key] || TARGETS[key]);
  if (!selected) throw new Error(`HISTORICAL_TARGET:${id}`);
  return selected;
}

function collectParents(witnesses, receiptsRoot, execute) {
  fs.mkdirSync(receiptsRoot, { recursive: true });
  return witnesses.map(witness => {
    const [id, , parentAlias] = witness;
    const started = Date.now();
    let run;
    let failure;
    try { run = execute(witness); } catch (error) { failure = error; }
    const stdout = run?.stdout || failure?.stdout || '';
    const stderr = run?.stderr || failure?.stderr || '';
    const matched = /(?:ℹ|#) (?:pass|fail) [1-9][0-9]*/.test(stdout);
    const receipt = {
      id, parent: ALIASES[parentAlias] || null, executed: Boolean(run),
      status: run?.status ?? null, signal: run?.signal ?? null,
      error: String(failure?.message || run?.error?.message || '') || null,
      dependency: failure?.dependency || null, matched,
      valid: Boolean(run && !run.error && [0, 1].includes(run.status) && matched),
      duration_ms: Date.now() - started,
      stdout: path.join(receiptsRoot, `${id}.stdout.log`),
      stderr: path.join(receiptsRoot, `${id}.stderr.log`),
    };
    fs.writeFileSync(receipt.stdout, stdout);
    fs.writeFileSync(receipt.stderr, stderr);
    fs.writeFileSync(path.join(receiptsRoot, `${id}.json`), `${JSON.stringify(receipt)}\n`);
    return receipt;
  });
}

function main() {
  if (process.argv.length !== 2) throw new Error('HISTORICAL_ARGUMENT_FORBIDDEN');
  const repository = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-history-'));
  try {
    const roots = new Map();
    const receiptsParent = path.join(repository, '_artifacts', 'storage-historical');
    fs.mkdirSync(receiptsParent, { recursive: true });
    const receiptsRoot = fs.mkdtempSync(path.join(receiptsParent, 'run-'));
    // Leave ten seconds for receipts and owned cleanup before the caller's 110 s deadline.
    const deadline = Date.now() + 100000;
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw Object.assign(new Error('HISTORICAL_BATCH_DEADLINE'), { dependency: 'remaining-worker-budget' });
      return Math.min(60000, milliseconds);
    };
    const observations = collectParents(HISTORICAL_WITNESSES, receiptsRoot, ([id, , parentAlias]) => {
      remaining();
      const parent = ALIASES[parentAlias];
      if (!roots.has(parent)) {
        const root = path.join(temporary, parent);
        fs.mkdirSync(root, { recursive: true });
        try { extract(repository, parent, root, remaining); } catch (error) {
          error.dependency ||= `parent-archive:${parent}`;
          throw error;
        }
        roots.set(parent, root);
      }
      const root = roots.get(parent);
      const [file, pattern] = targetFor(id, root);
      const environment = { ...process.env, HOME: path.join(root, 'home') };
      delete environment.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, path.join(root, 'scripts', file)], { cwd: root, encoding: 'utf8', timeout: remaining(), env: environment });
    });
    const results = HISTORICAL_WITNESSES.map(([id, reportAlias, parentAlias, tuple, invariants, expected], index) => {
      const parent = ALIASES[parentAlias];
      const run = observations[index];
      if (!run.valid) return { id, parent, executable: false, error: run.error || `HISTORICAL_PARENT_PROCESS:${id}:${run.status}`, dependency: run.dependency };
      const oracle = run.status === 1 ? 'historical-defect-reproduced' : expected === 'accept' ? 'allowed-acceptance' : expected === 'mixed' ? 'mixed-boundary' : 'construction-safe-rejection';
      return { id, report: ALIASES[reportAlias], parent, tuple, invariants, expected, oracle, executable: true };
    });
    const executed = observations.filter(row => row.executed).length;
    const failures = results.filter(row => !row.executable);
    process.stdout.write(`${JSON.stringify({ ids: results.map(({ id }) => id), executed, source_probes: 0, parent_processes: executed, results, receipts_root: receiptsRoot })}\n`);
    if (failures.length) {
      process.stderr.write(`${JSON.stringify({ code: 'HISTORICAL_PARENT_FAILURES', failures, receipts_root: receiptsRoot })}\n`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { collectParents };
