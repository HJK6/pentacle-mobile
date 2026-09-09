'use strict';

const path = require('node:path');
const TOKEN = Object.freeze({});
const TRUSTED = new Set([
  'gate-diagnostic.cjs', 'storage-cli.cjs', 'storage-gate.cjs', 'storage-janitor.cjs', 'storage-scheduler.cjs', 'storage-worktrees.cjs',
  'storage-behavior.test.cjs', 'storage-model-oracle.test.cjs', 'storage-qa-regressions.test.cjs', 'storage-slice-q1.test.cjs',
  'storage-scheduler-recovery-worker.cjs', 'storage-slice-q3-worker.cjs', 'storage-slice-q6-worker.cjs', 'storage-synthetic-worker.cjs', 'storage-worktree-q2-worker.cjs',
  // WORKERS, not test files: separate processes that drive the real lifecycle and arm the real crash
  // points deliberately, which is the same reason every other worker above is named here - and, for
  // arming, the whole reason it is in-process rather than an environment variable. Their test file is
  // deliberately ABSENT: it spawns these workers and asserts on exit status and on-disk state, and
  // never needs the mutation capability itself. Naming a test file here would be a strictly larger
  // grant than the demonstrations require.
  'storage-crash-matrix-worker.cjs', 'storage-discard-recovery-worker.cjs', 'storage-legacy-retirement-worker.cjs', 'storage-lifecycle-seams-worker.cjs', 'storage-reclaim-repeatability-worker.cjs', 'storage-unclassified-resume-worker.cjs', 'storage-absent-backing-worker.cjs',
].map((name) => path.join(__dirname, name)));

function callerFile() {
  const prior = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, stack) => stack;
    return new Error().stack[2]?.getFileName();
  } finally { Error.prepareStackTrace = prior; }
}

function claim() {
  const caller = callerFile();
  const owner = caller && require.cache[caller];
  if (!TRUSTED.has(caller) || !owner || !owner.children.includes(module)) throw new Error('MUTATION_CAPABILITY_DENIED');
  return TOKEN;
}

function bind(token, api) {
  if (token !== TOKEN) throw new Error('MUTATION_CAPABILITY_DENIED');
  return Object.freeze({ ...api });
}

module.exports = Object.freeze({ bind, claim });
