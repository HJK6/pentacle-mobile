#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PIN_FILE = 'config/pentacle-chat-core-pin.json';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`TEST_PROVISION_GIT:${args[0]}:${detail}`);
  }
  return result.stdout.trim();
}

function readPin(root) {
  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(path.join(root, PIN_FILE), 'utf8'));
  } catch (error) {
    throw new Error(`TEST_PROVISION_PIN_INVALID:${error.message}`);
  }
  const legacy = pin.schema === 1 && !Object.hasOwn(pin, 'representation') && /^[0-9a-f]{40}$/.test(pin.commit || '');
  const vendored = pin.schema === 2 && pin.representation === 'vendored_tree' && /^[0-9a-f]{40}$/.test(pin.tree || '')
    && !Object.hasOwn(pin, 'commit');
  if (pin.path !== 'pentacle-chat-core' || (!legacy && !vendored)) {
    throw new Error('TEST_PROVISION_PIN_INVALID');
  }
  return pin;
}

function trackedEntry(root, relativePath) {
  const entry = git(root, ['ls-tree', 'HEAD', '--', relativePath]).split(/\r?\n/).find(Boolean);
  const fields = entry ? entry.trim().split(/\s+/) : [];
  return { mode: fields[0], type: fields[1], sha: fields[2] };
}

function gitlinkSha(root, relativePath) {
  const entry = trackedEntry(root, relativePath);
  return entry.mode === '160000' && entry.type === 'commit' ? entry.sha : null;
}

function assertProvisionEntry(root = ROOT) {
  const pin = readPin(root);
  const entry = trackedEntry(root, pin.path);
  const expected = pin.schema === 2 ? pin.tree : pin.commit;
  const matchingForm = pin.schema === 2
    ? entry.mode === '040000' && entry.type === 'tree'
    : entry.mode === '160000' && entry.type === 'commit';
  if (!matchingForm || entry.sha !== expected) {
    throw new Error(
      `TEST_PROVISION_PIN_DRIFT: ${pin.path} ${entry.type || '<missing>'} ${entry.sha || '<missing>'} does not match `
      + `${PIN_FILE} ${pin.schema === 2 ? 'vendored tree' : 'gitlink commit'} ${expected}; run the align-pin chore before pushing this commit.`,
    );
  }
  return pin.schema === 2 ? { path: pin.path, representation: pin.representation, tree: entry.sha }
    : { path: pin.path, commit: entry.sha };
}

function assertProvisionPin(root = ROOT) {
  const verified = assertProvisionEntry(root);
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', verified.path])) {
    throw new Error('TEST_PROVISION_CORE_DIRTY: executed core bytes must match the pinned tracked entry');
  }
  return verified;
}

if (require.main === module) {
  try {
    assertProvisionPin(process.argv[2] ? path.resolve(process.argv[2]) : ROOT);
  } catch (error) {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertProvisionEntry, assertProvisionPin, gitlinkSha, readPin, trackedEntry };
