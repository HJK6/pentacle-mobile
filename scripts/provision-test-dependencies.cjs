#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertProvisionPin } = require('./check-provision-pin.cjs');

const ROOT = path.resolve(__dirname, '..');
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pentacle-chat-core-pin.json'), 'utf8'));
const target = path.join(ROOT, pin.path);
const telemetry = path.join(target, 'src', 'utils', 'telemetryEvents.ts');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`TEST_PROVISION_GIT:${args[0]}:${detail}`);
  }
  return result.stdout.trim();
}

function verify() {
  if (git(target, ['rev-parse', 'HEAD']) !== pin.commit) throw new Error('TEST_PROVISION_CHAT_CORE_SHA');
  if (git(target, ['ls-files', '--error-unmatch', 'src/utils/telemetryEvents.ts']) !== 'src/utils/telemetryEvents.ts' || !fs.existsSync(telemetry)) {
    throw new Error('TEST_PROVISION_TELEMETRY_REGISTRY_MISSING');
  }
}

function main() {
  if (pin.schema !== 1 || pin.path !== 'pentacle-chat-core' || !/^[0-9a-f]{40}$/.test(pin.commit) || typeof pin.remote !== 'string') {
    throw new Error('TEST_PROVISION_PIN_INVALID');
  }
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    assertProvisionPin(ROOT);
    git(ROOT, ['submodule', 'update', '--init', '--recursive']);
    verify();
    return;
  }

  if (fs.existsSync(target)) {
    if (fs.readdirSync(target).length) throw new Error('TEST_PROVISION_ARCHIVE_TARGET_NOT_EMPTY');
    fs.rmdirSync(target);
  }
  const remote = process.env.PENTACLE_CHAT_CORE_PROVISION_REMOTE || pin.remote;
  git(ROOT, ['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--no-checkout', remote, target]);
  git(target, ['checkout', '--quiet', '--detach', pin.commit]);
  verify();
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${String(error.message || error)}\n`); process.exitCode = 1; }
}

module.exports = { main };
