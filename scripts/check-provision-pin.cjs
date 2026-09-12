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
  if (pin.schema !== 2 || pin.path !== 'pentacle-chat-core' || !/^[0-9a-f]{40}$/.test(pin.tree)) {
    throw new Error('TEST_PROVISION_PIN_INVALID');
  }
  return pin;
}

function trackedTreeSha(root, relativePath) {
  const entry = git(root, ['ls-tree', 'HEAD', '--', relativePath]).split(/\r?\n/).find(Boolean);
  const fields = entry ? entry.trim().split(/\s+/) : [];
  if (fields[0] !== '040000' || fields[1] !== 'tree' || !/^[0-9a-f]{40}$/.test(fields[2] || '')) return null;
  return fields[2];
}

function assertProvisionPin(root = ROOT) {
  const pin = readPin(root);
  const observed = trackedTreeSha(root, pin.path);
  if (observed !== pin.tree) {
    throw new Error(
      `TEST_PROVISION_PIN_DRIFT: ${pin.path} tracked tree ${observed || '<missing>'} does not match `
      + `${PIN_FILE} tree ${pin.tree}; update the tracked tree pin before pushing this commit.`,
    );
  }
  return { path: pin.path, tree: observed };
}

if (require.main === module) {
  try {
    assertProvisionPin(process.argv[2] ? path.resolve(process.argv[2]) : ROOT);
  } catch (error) {
    process.stderr.write(`${String(error.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertProvisionPin, trackedTreeSha, readPin };
