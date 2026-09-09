'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const containers = require('./storage-containers.cjs');
const state = require('./storage-state.cjs');
const { runOwnedSync } = require('./owned-process.cjs');

function evaluateRecovery(data) {
  const predicates = {
    'failed-scratch': data.kind === 'scratch' && data.state === 'scratch_discarding' && Number.isInteger(data.gateStatus) && data.gateStatus !== 0,
    'local-dead-owner': data.localOwner === true && data.ownerAlive === false,
    identity: data.identityMatches === true,
    journal: data.journalUnchanged === true,
    'retained-evidence': data.evidenceRetained === true && data.evidenceVerified === true,
    'detached-evidence': data.evidenceDetached === true,
    'bound-groups': data.groupsBound === true,
    'empty-groups': data.groupsEmpty === true,
    'no-other-jobs': Array.isArray(data.otherJobs) && data.otherJobs.length === 0,
    'no-open-handles': Array.isArray(data.openHandles) && data.openHandles.length === 0,
    probes: data.probesValid === true,
    'normal-detach-busy': data.normalDetachBusy === true,
    'system-dissenter': Number.isInteger(data.dissenter?.pid) && data.dissenter.pid > 1 && data.dissenter.ppid === 1 && data.dissenter.command === '/usr/libexec/syspolicyd',
  };
  const checks = Object.entries(predicates).map(([name, ok]) => ({ name, status: ok ? 'passed' : 'failed' }));
  return { ok: Object.values(predicates).every(Boolean), checks };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function buildOwnership(run, metadata, build, outer) {
  if (metadata.release_target?.run_id !== run.id || metadata.candidate_sha !== run.gate_code_sha
      || !Number.isInteger(build.status) || build.status === 0 || !Array.isArray(metadata.gates)) throw new Error('SYSTEM_SCRATCH_BUILD_BINDING');
  const records = [...metadata.gates.map(gate => gate.ownership), build.ownership, outer];
  if (records.some(record => record?.kind !== 'ownership' || !Number.isInteger(record.owned_process_group)
      || record.owned_process_group <= 1 || record.group_alive_after !== false)) throw new Error('SYSTEM_SCRATCH_GROUP_BINDING');
  return [...new Set(records.map(record => record.owned_process_group))];
}

function recover(runId, proofFile, token) {
  state.validateInstalledAuthority();
  const mutations = containers.bind(token);
  const journal = state.bind(token);
  const run = state.readRecord('runs', runId);
  const original = JSON.stringify(run);
  if (run.state !== 'scratch_discarding' || !Number.isInteger(run.gate_status) || run.gate_status === 0) throw new Error('SYSTEM_SCRATCH_FAILED_RUN_REQUIRED');
  if (run.owner.host !== os.hostname() || run.owner.uid !== process.getuid() || alive(run.owner.pid)) throw new Error('SYSTEM_SCRATCH_OWNER_ACTIVE_OR_FOREIGN');
  const stat = fs.lstatSync(proofFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('SYSTEM_SCRATCH_PROOF_FILE');
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  const outer = proof.outer;
  const runner = proof.runner;
  if (runner?.run_id !== runId || runner.candidate_sha !== run.gate_code_sha || outer?.owned_process_group !== runner.runner_pgid
      || !Number.isInteger(outer?.owned_process_group) || outer.owned_process_group <= 1
      || outer.kind !== 'ownership' || outer.group_alive_after !== false || !Number.isInteger(outer.child_exit?.code) || outer.child_exit.code === 0) throw new Error('SYSTEM_SCRATCH_OUTER_BINDING');
  if (alive(-outer.owned_process_group)) throw new Error('SYSTEM_SCRATCH_OUTER_ACTIVE');
  const receiptFile = path.join(path.dirname(fs.realpathSync(proofFile)), `system-scratch-${runId}-${require('node:crypto').randomUUID()}.json`);
  const receiptDescriptor = fs.openSync(receiptFile, 'wx', 0o600);
  const receipt = { schema: 1, run_id: runId, started_at: new Date().toISOString(), checks: [], commands: [] };
  const save = () => {
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    fs.ftruncateSync(receiptDescriptor, 0);
    fs.writeSync(receiptDescriptor, bytes, 0, bytes.length, 0);
    fs.fsyncSync(receiptDescriptor);
  };
  const command = (binary, args) => {
    const result = runOwnedSync(binary, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    const stdout = binary === '/bin/ps' && args.includes('-axo')
      ? String(result.stdout || '').split('\n').filter(line => line.includes(containers.mountPath('scratch'))).join('\n') : result.stdout;
    receipt.commands.push({ binary, args, status: result.status, stdout, stderr: result.stderr, ownership: result.ownership });
    save();
    if (result.error || result.signal || !Number.isInteger(result.status)) throw new Error('SYSTEM_SCRATCH_PROBE_UNAVAILABLE');
    return result;
  };
  let groups;
  try {
    journal.withRecordMutation('runs', runId, () => {
      if (JSON.stringify(state.readRecord('runs', runId)) !== original) throw new Error('SYSTEM_SCRATCH_JOURNAL_DRIFT');
      const evidence = mutations.attachExisting('evidence', runId);
      try {
        containers.requireSeal(evidence.seal, run.evidence_seal);
        require('./storage-gate.cjs').verifyPreliminaryEvidence(run);
        const root = containers.mountPath('evidence');
        const metadata = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
        const build = JSON.parse(fs.readFileSync(path.join(root, 'release-sim-build.json'), 'utf8'));
        groups = buildOwnership(run, metadata, build, outer);
        if (groups.some(group => alive(-group))) throw new Error('SYSTEM_SCRATCH_GROUP_ACTIVE');
        receipt.evidence_digest = run.preliminary_evidence_digest;
      } finally { mutations.detachRetain('evidence', runId, run.evidence_seal); }
      containers.assertImageDetached('evidence', runId);
      const initial = containers.resolveMounted('scratch', runId);
      containers.requireSeal(initial.seal, run.scratch_seal);
      receipt.preimage = { image: initial.image, mount: initial.mount, device: initial.attachment.device, seal: initial.seal, owner: run.owner, groups };
      save();
      try {
        mutations.detachAndDiscard('scratch', runId, run.scratch_seal);
        receipt.disposition = 'normal-discard';
        return;
      } catch (error) {
        receipt.normal_error = String(error.message || error);
        if (!receipt.normal_error.includes('Resource busy')) throw error;
      }
      const dissent = command('/usr/sbin/diskutil', ['unmount', initial.mount]);
      const match = `${dissent.stdout}\n${dissent.stderr}`.match(/dissented by PID (\d+) \(\/usr\/libexec\/syspolicyd\)/);
      if (!match) throw new Error('SYSTEM_SCRATCH_DISSENTER_UNPROVEN');
      const dissenterPid = Number(match[1]);
      const revalidate = () => {
        const observations = {};
        const errors = [];
        const observe = (name, operation) => { try { observations[name] = operation(); } catch (error) { errors.push({ name, error: String(error.message || error) }); } };
        observe('identity', () => { const current = containers.resolveMounted('scratch', runId); containers.requireSeal(current.seal, run.scratch_seal); return current.image === initial.image && current.mount === initial.mount && current.attachment.device === initial.attachment.device; });
        observe('journal', () => JSON.stringify(state.readRecord('runs', runId)) === original);
        observe('evidence', () => { containers.assertImageDetached('evidence', runId); return JSON.stringify(state.canonicalIdentity(containers.imagePath('evidence', runId))) === JSON.stringify(run.evidence_seal.image); });
        observe('groups', () => groups.every(group => !alive(-group)));
        observe('processes', () => { const result = command('/bin/ps', ['-axo', 'pid=,ppid=,command=']); if (result.status !== 0) throw new Error('PS_FAILED'); return result.stdout.split('\n').filter(line => line.includes(initial.mount) && Number(line.trim().split(/\s+/)[0]) !== process.pid); });
        observe('handles', () => { const result = command('/usr/sbin/lsof', ['-nP', '-Fpn', '+f', '--', initial.mount]); if (![0, 1].includes(result.status) || result.stderr?.trim()) throw new Error('LSOF_FAILED'); return result.stdout.split('\n').filter(line => /^p\d+$/.test(line)); });
        observe('dissenter', () => { const result = command('/bin/ps', ['-p', String(dissenterPid), '-o', 'ppid=,comm=']); const value = result.stdout.trim().match(/^(\d+)\s+(.+)$/); return value && result.status === 0 ? { pid: dissenterPid, ppid: Number(value[1]), command: value[2] } : null; });
        const data = { kind: 'scratch', state: run.state, gateStatus: run.gate_status, localOwner: run.owner.host === os.hostname() && run.owner.uid === process.getuid(), ownerAlive: alive(run.owner.pid), identityMatches: observations.identity, journalUnchanged: observations.journal, evidenceRetained: observations.evidence, evidenceDetached: observations.evidence, evidenceVerified: true, groupsBound: true, groupsEmpty: observations.groups, otherJobs: observations.processes, openHandles: observations.handles, probesValid: errors.length === 0, normalDetachBusy: true, dissenter: observations.dissenter };
        const verdict = evaluateRecovery(data);
        receipt.checks = verdict.checks;
        receipt.probe_errors = errors;
        receipt.observations = data;
        save();
        if (!verdict.ok) throw new Error(`SYSTEM_SCRATCH_REFUSED:${JSON.stringify(verdict.checks.filter(check => check.status === 'failed'))}`);
        return true;
      };
      mutations.forceDiscardFailedScratch(runId, run.scratch_seal, initial.attachment.device, revalidate, (binary, args) => {
        const result = command(binary, args);
        if (result.status !== 0) throw new Error(`SYSTEM_SCRATCH_COMMAND_FAILED:${result.status}`);
        return result.stdout;
      });
      receipt.disposition = 'forced-failed-scratch-discard';
    });
    const result = require('./storage-janitor.cjs').bind(token).recoverRun(runId);
    receipt.final_state = result.state;
    receipt.finished_at = new Date().toISOString();
    save();
    return { run_id: runId, state: result.state, receipt: receiptFile, disposition: receipt.disposition };
  } catch (error) { receipt.error = String(error.message || error); save(); throw error; }
  finally { fs.closeSync(receiptDescriptor); }
}

module.exports = { buildOwnership, evaluateRecovery, bind: token => require('./storage-capability.cjs').bind(token, { recover: (runId, proofFile) => recover(runId, proofFile, token) }) };
