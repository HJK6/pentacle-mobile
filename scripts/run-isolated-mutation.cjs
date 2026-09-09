#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`ISOLATED_MUTATION_GIT:${args[0]}:${detail}`);
  }
  return result.stdout.trim();
}

function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf('--');
  const command = separator === -1 ? argv : argv.slice(separator + 1);
  if (!command.length) throw new Error('usage: run-isolated-mutation.cjs -- <command> [args...]');

  const source = fs.realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']));
  if (git(source, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('ISOLATED_MUTATION_SOURCE_DIRTY: commit the candidate before mutation testing');
  }
  const head = git(source, ['rev-parse', '--verify', 'HEAD']);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mutation-'));
  let added = false;
  let child = null;
  let cleanupError = null;
  try {
    git(source, ['worktree', 'add', '--detach', worktree, head]);
    added = true;
    child = spawnSync(command[0], command.slice(1), {
      cwd: worktree,
      env: { ...process.env, PENTACLE_MUTATION_WORKTREE: worktree },
      stdio: 'inherit',
    });
  } finally {
    try {
      if (added) git(source, ['worktree', 'remove', '--force', worktree]);
      else fs.rmSync(worktree, { recursive: true, force: true });
      git(source, ['worktree', 'prune']);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
  if (child?.error) throw child.error;
  if (child?.signal) throw new Error(`ISOLATED_MUTATION_SIGNAL:${child.signal}`);
  return child?.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${String(error.message || error)}\n`); process.exitCode = 1; }
}

module.exports = { main };
