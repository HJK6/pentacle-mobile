#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

function readPositiveInteger(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return value;
}

const runs = readPositiveInteger('--runs', 30);
const maxWorkers = readPositiveInteger('--max-workers', availableParallelism());
const runInBand = process.argv.includes('--run-in-band');
const outputIndex = process.argv.indexOf('--output-dir');
const outputDir = resolve(outputIndex === -1
  ? `.artifacts/jest-stress-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
  : process.argv[outputIndex + 1]);
const jestBin = resolve('node_modules/jest/bin/jest.js');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
}

function captureProvenance(stage) {
  const sha = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']);
  if (!branch) throw new Error('provenance requires a named branch');
  const status = git([
    'status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none',
  ]);
  if (status) throw new Error(`provenance requires a clean tracked tree (${stage})`);
  execFileSync('git', ['diff', '--quiet', '--ignore-submodules=none']);
  execFileSync('git', ['diff', '--cached', '--quiet', '--ignore-submodules=none']);
  const submodules = git(['submodule', 'status', '--recursive']);
  if (submodules.split('\n').filter(Boolean).some((line) => !line.startsWith(' '))) {
    throw new Error(`provenance requires clean initialized submodules (${stage})`);
  }
  const remoteLine = git(['ls-remote', 'origin', `refs/heads/${branch}`]);
  const originSha = remoteLine.split(/\s+/)[0] || '';
  if (originSha !== sha) {
    throw new Error(`origin/${branch} does not match HEAD (${stage})`);
  }
  return {
    stage,
    captured_at: new Date().toISOString(),
    sha,
    branch,
    origin_sha: originSha,
    tracked_tree: 'clean',
    index: 'clean',
    submodules,
  };
}

function comparableProvenance(value) {
  const { stage: _stage, captured_at: _capturedAt, ...stable } = value;
  return stable;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const before = captureProvenance('before');
const { sha, branch } = before;
const summary = {
  sha,
  branch,
  requested_runs: runs,
  execution_mode: runInBand ? 'run_in_band' : 'parallel',
  max_workers: runInBand ? null : maxWorkers,
  started_at: new Date().toISOString(),
  completed_at: null,
  passed_runs: 0,
  failed_run: null,
  runs: [],
};

mkdirSync(outputDir, { recursive: true });
const beforePath = resolve(outputDir, 'provenance-before.json');
const afterPath = resolve(outputDir, 'provenance-after.json');
writeFileSync(beforePath, `${JSON.stringify(before, null, 2)}\n`);
const writeSummary = () => writeFileSync(
  resolve(outputDir, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
writeSummary();

let suiteExitCode = 0;
for (let run = 1; run <= runs; run += 1) {
  const startedAt = new Date().toISOString();
  const logPath = resolve(outputDir, `run-${String(run).padStart(2, '0')}.log`);
  const logFd = openSync(logPath, 'w');
  const exitCode = await new Promise((resolveExit, reject) => {
    const jestArgs = runInBand
      ? [jestBin, '--runInBand', '--watchman=false']
      : [jestBin, `--maxWorkers=${maxWorkers}`, '--watchman=false'];
    const child = spawn(process.execPath, jestArgs, {
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  }).finally(() => closeSync(logFd));

  const result = {
    run,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    exit_code: exitCode,
    log: logPath,
  };
  summary.runs.push(result);
  if (exitCode !== 0) {
    summary.failed_run = run;
    summary.completed_at = result.completed_at;
    writeSummary();
    suiteExitCode = exitCode;
    break;
  }

  summary.passed_runs += 1;
  writeSummary();
  console.log(`PASS run ${run}/${runs}`);
}

const after = captureProvenance('after');
if (JSON.stringify(comparableProvenance(after)) !== JSON.stringify(comparableProvenance(before))) {
  throw new Error('repository provenance changed during Jest execution');
}
writeFileSync(afterPath, `${JSON.stringify(after, null, 2)}\n`);
summary.completed_at = summary.completed_at || new Date().toISOString();
writeSummary();
const artifactPaths = [
  beforePath,
  afterPath,
  resolve(outputDir, 'summary.json'),
  ...summary.runs.map((result) => result.log),
];
writeFileSync(resolve(outputDir, 'evidence-manifest.json'), `${JSON.stringify({
  schema_version: 1,
  sha,
  branch,
  provenance_matches: true,
  artifacts: Object.fromEntries(artifactPaths.map((path) => [path, sha256(path)])),
}, null, 2)}\n`);
if (suiteExitCode !== 0) {
  console.error(`FAIL run ${summary.failed_run}/${runs}; evidence: ${outputDir}`);
  process.exit(suiteExitCode);
}
console.log(`PASS ${runs}/${runs}; evidence: ${outputDir}`);
