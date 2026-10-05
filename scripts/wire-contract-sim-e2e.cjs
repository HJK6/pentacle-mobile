#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {};
  const names = new Set(['--artifact-dir', '--fixture', '--expected-checkout', '--mutation-proof-out']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || options[argv[i]]) throw new Error('WIRE_CONTRACT_ARGUMENTS');
    options[argv[i]] = argv[i + 1];
  }
  if (!options['--artifact-dir'] || !options['--fixture'] || !/^[0-9a-f]{40}$/.test(options['--expected-checkout'] || '')) throw new Error('WIRE_CONTRACT_EXPLICIT_INPUT_REQUIRED');
  return options;
}

function run(argv, command = spawnSync) {
  const options = parseArgs(argv);
  return command('python3', [path.join(ROOT, 'test/e2e/wire_contract_validator.py'), ...Object.entries(options).flat()],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, run };
