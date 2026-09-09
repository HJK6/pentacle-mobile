#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
}

function resetSimulatorApp({ deviceSetRoot, udid, bundleId }, command = spawnSync) {
  if (!deviceSetRoot || !udid || !bundleId) throw new Error('device set, UDID, and bundle id are required');
  const options = { encoding: 'utf8' };
  const listed = command('xcrun', ['simctl', '--set', deviceSetRoot, 'listapps', udid], options);
  requireSuccess(listed, 'simulator app inventory');
  const converted = command('plutil', ['-convert', 'json', '-o', '-', '-'], {
    ...options,
    input: listed.stdout,
  });
  requireSuccess(converted, 'simulator app inventory conversion');
  let apps;
  try {
    apps = JSON.parse(converted.stdout);
  } catch (error) {
    throw new Error(`simulator app inventory was invalid JSON: ${error.message}`);
  }
  if (!apps || Array.isArray(apps) || typeof apps !== 'object') {
    throw new Error('simulator app inventory was not an object');
  }
  if (!Object.hasOwn(apps, bundleId)) return { prior_state: 'absent', removed: false };
  const removed = command(
    'xcrun',
    ['simctl', '--set', deviceSetRoot, 'uninstall', udid, bundleId],
    options,
  );
  requireSuccess(removed, 'simulator app reset');
  return { prior_state: 'installed', removed: true };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !['--device-set', '--udid', '--bundle-id'].includes(flag)) {
      throw new Error('Usage: reset-simulator-app --device-set <path> --udid <udid> --bundle-id <id>');
    }
    values[flag] = value;
  }
  return {
    deviceSetRoot: values['--device-set'],
    udid: values['--udid'],
    bundleId: values['--bundle-id'],
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(resetSimulatorApp(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, resetSimulatorApp };
