'use strict';

// Preloaded with `node --require` AHEAD of the real storage-cli.cjs, so the process under test IS the
// CLI: its own argv parse, its own real storage-authority.cjs endpoint validation, its own dispatch,
// its own resolve handler, and its own process exit. The ONLY thing synthesised is the operation's
// RESULT - the value the resolve handler was discarding.
//
// This shape is required by R2. An assertion that reads the outcome back out of the same object the
// verb returned would force the two values to agree and destroy the ability to observe which one the
// process actually exits with, which is precisely how a resolved-but-failed verb exited 0 undetected.
// Here the result says one thing, the OS reports another, and the test compares them across a real
// process boundary.
//
// The four operation modules are stubbed at Module._load - the same interception storage-slice-q8's
// endpoint worker uses - so no installed authority, image or mount is touched. storage-authority.cjs
// and storage-capability.cjs stay REAL: the CLI is a TRUSTED caller and its capability claim must
// genuinely succeed, or the test would prove the exit path of something that is not the CLI.

const Module = require('node:module');
const path = require('node:path');

const STUBBED = new Set(['storage-gate.cjs', 'storage-janitor.cjs', 'storage-scheduler.cjs', 'storage-worktrees.cjs', 'storage-system-scratch.cjs']);
const RESULT = process.env.STORAGE_CLI_OUTCOME_RESULT;
const THROW = process.env.STORAGE_CLI_OUTCOME_THROW;

function operation() {
  if (THROW !== undefined) {
    const spec = JSON.parse(THROW);
    const error = new Error(spec.message);
    if (spec.exitCode !== undefined) error.exitCode = spec.exitCode;
    throw error;
  }
  return JSON.parse(RESULT);
}

// Every name any verb destructures off a bound module, so a single stub serves all thirteen endpoints
// and the test never has to know which module owns which verb.
const OPERATIONS = [
  'discardPublishedScratch', 'prepareNativeRoot', 'runFullGate',
  'discardEvidence', 'recoverRun', 'runJanitor',
  'recover',
  'installOrUpdate', 'recoverCommitted', 'uninstall',
  'registerWorktree', 'retireWorktree',
];

const stub = Object.freeze({
  // The real bind() checks the capability token; this one does not, because the token it would be
  // handed is the real one and the check is not what is under test here.
  bind: () => Object.freeze({ ...Object.fromEntries(OPERATIONS.map((name) => [name, operation])),
    withPreparedAllocation: async (_id, _token, execute) => execute() }),
});

const original = Module._load;
Module._load = function load(request) {
  if (path.basename(request) === 'gate-preflight.cjs') return { requirePluginIntegrity: () => undefined, beforeBootstrap: (_, bootstrap) => bootstrap() };
  if (path.basename(request) === 'owned-process.cjs') return { isOwnedInvocation: () => true };
  if (path.basename(request) === 'storage-cli-bootstrap.cjs') {
    return { bootstrapGateEndpoint: () => ({ kind: 'continue', context: Object.freeze({ test: true }) }) };
  }
  if (STUBBED.has(path.basename(request))) return stub;
  return original.apply(this, arguments);
};
