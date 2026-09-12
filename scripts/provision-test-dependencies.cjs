#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertProvisionPin } = require('./check-provision-pin.cjs');

const ROOT = path.resolve(__dirname, '..');
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pentacle-chat-core-pin.json'), 'utf8'));
const telemetryRelative = path.join(pin.path, 'src', 'utils', 'telemetryEvents.ts');
const telemetry = path.join(ROOT, telemetryRelative);

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`TEST_PROVISION_GIT:${args[0]}:${detail}`);
  }
  return result.stdout.trim();
}

function verify() {
  if (git(ROOT, ['ls-files', '--error-unmatch', telemetryRelative]) !== telemetryRelative || !fs.existsSync(telemetry)) {
    throw new Error('TEST_PROVISION_TELEMETRY_REGISTRY_MISSING');
  }
}

function main() {
  if (pin.schema !== 2 || pin.path !== 'pentacle-chat-core' || !/^[0-9a-f]{40}$/.test(pin.tree)) {
    throw new Error('TEST_PROVISION_PIN_INVALID');
  }
  if (!fs.existsSync(path.join(ROOT, '.git'))) throw new Error('TEST_PROVISION_TREE_PROVENANCE_REQUIRED');
  assertProvisionPin(ROOT);
  verify();
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${String(error.message || error)}\n`); process.exitCode = 1; }
}

module.exports = { main };
