#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let mainGateBootstrap = null;
let mainHostHealthBaseline = null;
const mutationCapability = require('./storage-capability.cjs').claim();

async function bootstrapAndDispatch(endpoint, values) {
  if (['gate:native-root', 'gate:full'].includes(endpoint)) {
    const repoRoot = path.resolve(__dirname, '..');
    const ownership = require('./owned-process.cjs');
    if (!ownership.isOwnedInvocation()) {
      require('./gate-preflight.cjs').beforeBootstrap(repoRoot, () => undefined);
      const owned = ownership.runOwnedSync(process.execPath, [__filename, endpoint, ...values],
        { stdio: 'inherit', timeout: 10800000, graceMs: 120000 });
      return { forwarded: true, status: owned.status ?? 1 };
    }
    require('./gate-preflight.cjs').beforeBootstrap(repoRoot, (baseline) => {
      mainHostHealthBaseline = baseline;
      process.env.PENTACLE_HOST_HEALTH_BASELINE = JSON.stringify(baseline);
    });
    const result = require('./storage-cli-bootstrap.cjs').bootstrapGateEndpoint(endpoint, values, repoRoot);
    if (result.kind === 'reexecuted') return { forwarded: true, status: result.status };
    if (fs.existsSync(path.join(repoRoot, 'package.json'))) require('./check-provision-pin.cjs').assertProvisionPin(repoRoot);
    mainGateBootstrap = result.context;
  }
  return { forwarded: false, value: await dispatch(endpoint, values) };
}

async function executeEndpoint(endpoint, values) {
  const operation = () => {
    require('./storage-authority.cjs').rejectEnvironmentAuthority();
    return bootstrapAndDispatch(endpoint, values);
  };
  if (endpoint !== 'gate:full') return operation();
  const input = inputFor(endpoint, values);
  // The allocation already exists: its cleanup owner must precede every startup check and re-exec.
  return require('./storage-gate.cjs').bind(mutationCapability)
    .withPreparedAllocation(input.run_id, input.lock_token, operation);
}

function inputFor(endpoint, values) {
  const { CONTRACT, parseEndpoint } = require('./storage-authority.cjs');
  const fields = CONTRACT.endpoints[endpoint];
  if (!fields || fields.length !== values.length) throw new Error('FORBIDDEN_AUTHORITY');
  return parseEndpoint(endpoint, Object.fromEntries(fields.map((field, index) => [field, values[index]])));
}

async function dispatch(endpoint, values) {
  require('./storage-authority.cjs').rejectEnvironmentAuthority();
  const input = inputFor(endpoint, values);
  switch (endpoint) {
    case 'storage:install': return require('./storage-scheduler.cjs').bind(mutationCapability).installOrUpdate('install');
    case 'storage:update': return require('./storage-scheduler.cjs').bind(mutationCapability).installOrUpdate('update');
    case 'gate:native-root': return await require('./storage-gate.cjs').bind(mutationCapability).prepareNativeRoot(input.candidate_ref, mainGateBootstrap);
    case 'gate:full': return await require('./storage-gate.cjs').bind(mutationCapability).runFullGate(input.run_id, input.lock_token, { gateBootstrap: mainGateBootstrap });
    case 'storage:recover-run': return require('./storage-janitor.cjs').bind(mutationCapability).recoverRun(input.run_id);
    case 'storage:recover-system-scratch': return require('./storage-system-scratch.cjs').bind(mutationCapability).recover(input.run_id, input.proof_file);
    case 'storage:discard-scratch': return require('./storage-gate.cjs').bind(mutationCapability).discardPublishedScratch(input.run_id);
    case 'storage:reclaim-failed-scratch': return require('./storage-janitor.cjs').bind(mutationCapability).reclaimFailedScratch(input.run_id);
    case 'storage:discard-evidence': {
      return require('./storage-janitor.cjs').bind(mutationCapability).discardEvidence(input.run_id);
    }
    case 'storage:dispose-unclassified': return require('./storage-janitor.cjs').bind(mutationCapability).disposeUnclassified(input.run_id, input.reason);
    case 'storage:dispose-absent-backing': return require('./storage-janitor.cjs').bind(mutationCapability).disposeAbsentBacking(input.run_id, input.reason);
    case 'storage:register-worktree': return require('./storage-worktrees.cjs').bind(mutationCapability).registerWorktree(input.main_repo_id, input.spec_id, input.lane_id);
    case 'storage:retire-worktree': return require('./storage-worktrees.cjs').bind(mutationCapability).retireWorktree(input.ticket_id);
    case 'storage:janitor': return require('./storage-janitor.cjs').bind(mutationCapability).runJanitor(input.mode);
    case 'storage:restore': return { recovered: require('./storage-scheduler.cjs').bind(mutationCapability).recoverCommitted() };
    case 'storage:uninstall': return require('./storage-scheduler.cjs').bind(mutationCapability).uninstall();
    default: throw new Error('FORBIDDEN_AUTHORITY');
  }
}

// RESOLVED IS NOT SUCCEEDED. dispatch() resolves with a result object that carries the operation's own
// outcome, and the resolve handler used to discard it for EVERY verb: an example gate returned
// {status: 1} from a genuinely failed twelve-stage run and this process exited 0, a false green at the
// certifying SHA. Setting process.exitCode at the gate:full site alone was refused as whack-a-mole - the
// defect is not that one verb forgets its exit code, it is that the CLI had NO CONTRACT for
// resolved-but-failed, so every other verb carrying an outcome had the identical hole and the next
// instance would have arrived silently. This table is that contract.
//
// It is CLOSED against CONTRACT.endpoints (assertClosedOutcomeContract, asserted at load): a verb the
// dispatcher can reach but this table does not name would fall back to "resolution means success", which
// is the defect itself. R6 - two lists that must agree get bound, never trusted to stay in step.
//
// THROWS_ONLY is a CLAIM, not a default: the implementation signals every failure by throwing, so
// resolution really is success and there is no second value to propagate. Verified per verb by search,
// not memory - the enumeration is written down in the lane spec section 13.2 so a successor can check
// the list rather than retrace it. Do not add a verb here without answering that question for it.
const THROWS_ONLY = () => 0;

const OUTCOME_CONTRACT = Object.freeze({
  'storage:install': THROWS_ONLY,
  'storage:update': THROWS_ONLY,
  'gate:native-root': THROWS_ONLY,
  // The instance that exposed the class. result.status is the supervisor's preserved child status -
  // 0/nonzero/130/143 - so propagating it verbatim is what makes the documented "on every exit the
  // supervisor preserves 0/nonzero/130/143" true END TO END rather than only up to this boundary.
  'gate:full': (result) => result.status,
  'storage:recover-run': THROWS_ONLY,
  'storage:recover-system-scratch': THROWS_ONLY,
  'storage:discard-scratch': THROWS_ONLY,
  // THROWS_ONLY answered rather than assumed: refusal is FAILED_SCRATCH_RECLAMATION_NOT_AUTHORIZED, a
  // decision that moved under it is JANITOR_AUTHORIZATION_DRIFT, and a discard that fails part-way
  // propagates out of detachAndDiscard. It resolves only with the run record applyRun returns, which
  // carries no status or errors field, so there is no second value that could mean failure.
  'storage:reclaim-failed-scratch': THROWS_ONLY,
  'storage:discard-evidence': THROWS_ONLY,
  // THROWS_ONLY answered per the rule above, not assumed. Every refusal throws a NAMED error -
  // UNCLASSIFIED_DISPOSITION_{REASON_REQUIRED,NOT_AUTHORIZED,AUTHORIZATION_DRIFT,STALLED,INCOMPLETE} -
  // and it resolves only with the terminal run record applyRun returns, which carries no status or
  // errors field. Its two most dangerous outcomes, a stall and a half-finished sequence, are throws
  // BECAUSE of this contract: a verb that destroyed the scratch and stopped would otherwise resolve, and
  // resolution would have been read as success while the evidence sat stranded.
  'storage:dispose-unclassified': THROWS_ONLY,
  // THROWS_ONLY answered, not assumed. Every refusal throws a NAMED error - ABSENT_BACKING_{REASON_REQUIRED,
  // NOT_AUTHORIZED, PRESENT, MOUNTED, AUTHORIZATION_DRIFT} - and it resolves only with the terminal run
  // record transitionRun returns, which carries no status or errors field. It deletes nothing, so it has no
  // half-finished-destruction outcome that resolution could mask.
  'storage:dispose-absent-backing': THROWS_ONLY,
  'storage:register-worktree': THROWS_ONLY,
  'storage:retire-worktree': THROWS_ONLY,
  // SECOND LIVE INSTANCE, found by the sweep instead of by another false green. runJanitor RESOLVES with
  // report.errors populated - a per-run or per-ticket failure it caught and recorded rather than threw,
  // or the JANITOR_DISABLED kill switch - and the LaunchAgent runs exactly this verb with both streams at
  // /dev/null (storage-scheduler.cjs:59), so the exit code is its ONLY observable. docs/TESTING.md
  // already tells operators that a non-zero middle column in `launchctl list` means the scheduled run is
  // failing; that sentence was unfalsifiable until this line existed. No respawn hazard: renderPlist
  // sets StartInterval with no KeepAlive, so launchd does not relaunch on a non-zero exit.
  'storage:janitor': (result) => {
    if (!Array.isArray(result.errors)) throw new Error('errors is not an array');
    return result.errors.length ? 1 : 0;
  },
  'storage:restore': THROWS_ONLY,
  'storage:uninstall': THROWS_ONLY,
});

function assertClosedOutcomeContract(endpoints = require('./storage-authority.cjs').CONTRACT.endpoints) {
  const declared = Object.keys(OUTCOME_CONTRACT).sort();
  const reachable = Object.keys(endpoints).sort();
  if (JSON.stringify(declared) !== JSON.stringify(reachable)) throw new Error(`CLI_OUTCOME_CONTRACT_OPEN:${JSON.stringify({ declared, reachable })}`);
  return true;
}

// Every failure here NAMES itself. A guard that fails without saying why is the defect fix C existed to
// end, and this one sits on the path that decides whether a run reports success.
function exitCodeFor(endpoint, result) {
  if (!Object.prototype.hasOwnProperty.call(OUTCOME_CONTRACT, endpoint)) throw new Error(`CLI_OUTCOME_UNDECLARED:${endpoint}`);
  let code;
  try { code = OUTCOME_CONTRACT[endpoint](result); }
  catch (error) { throw new Error(`CLI_OUTCOME_SHAPE:${endpoint}:${String(error.message || error)}`); }
  // Range-checked because the OS masks the exit status to its low 8 bits on the way out, so 256 leaves
  // as 0 - an unvalidated propagated number is a false green waiting on an unusual child status.
  if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error(`CLI_OUTCOME_UNREPRESENTABLE:${endpoint}:${String(code)}`);
  return code;
}

assertClosedOutcomeContract();

if (require.main === module) {
  const endpoint = process.argv[2];
  executeEndpoint(endpoint, process.argv.slice(3))
    .then((envelope) => {
      if (envelope.forwarded) { process.exitCode = envelope.status; return; }
      let result = envelope.value;
      if (mainHostHealthBaseline && result && typeof result === 'object') result = { ...result, host_health_baseline: mainHostHealthBaseline };
      // The payload is written FIRST and unconditionally: a failed verb's result is diagnostic and must
      // survive regardless of the exit code, and the stdout contract stays identical for both outcomes
      // (the documented flow pipes gate:native-root's stdout through jq).
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = exitCodeFor(endpoint, result);
    })
    .catch((error) => {
      process.stderr.write(`${String(error.message || error)}\n`);
      // A REJECTION MAY NEVER EXIT 0, whatever it carries - the same defect from the other side. The
      // propagated value is real (storage-gate.cjs sets error.exitCode from a failed native build), so
      // it is honoured only when it is a representable FAILURE code; anything else becomes 1.
      const carried = error.exitCode;
      process.exitCode = Number.isInteger(carried) && carried > 0 && carried <= 255 ? carried : 1;
    });
}

module.exports = { assertClosedOutcomeContract, dispatch, exitCodeFor, inputFor };
