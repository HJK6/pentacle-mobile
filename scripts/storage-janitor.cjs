'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout, generatedId } = require('./storage-authority.cjs');
const containers = require('./storage-containers.cjs');
const { attachExisting, detachAndDiscard, detachRetain, recoverDiscarding, recoverOrCreate } = containers.bind(mutationCapability);
const { imagePath } = containers;
const state = require('./storage-state.cjs');
const { recoverAtomicTemps, replaceRecord, rotateTerminal, transitionRun, withRecordMutation } = state.bind(mutationCapability);
const { listRecords, readRecord, validateInstalledAuthority } = state;
const worktrees = require('./storage-worktrees.cjs');
const { readConsistencyInventory, reconcileRunImages } = require('./storage-janitor-consistency.cjs');
const { retireWorktree } = worktrees.bind(mutationCapability);
const { DAY } = worktrees;
const gateMutations = require('./storage-gate.cjs').bind(mutationCapability);

function fsyncDirectory(directory) { const descriptor = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function atomicJson(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${require('node:crypto').randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  fsyncDirectory(path.dirname(target));
}

function alive(owner) {
  if (!owner || owner.host !== require('node:os').hostname() || owner.uid !== process.getuid()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function inclusiveElapsed(iso, milliseconds, now) {
  const then = Date.parse(iso);
  return Number.isFinite(then) && then <= now && now - then >= milliseconds;
}

// How many of the newest failures stay diagnosable. Manual reclamation refuses to touch them, so a lane
// debugging a live failure never loses the scratch it is reading, however explicitly it is named.
const FAILURE_RETENTION = 2;

// The manual substitute for the automatic path's 24-hour first-dead term, and ONLY for that term. Every
// other conjunct in runDecision - dead owner, an immutable first_dead_at observed by a prior sweep,
// identity/generation match, and committed evidence - still has to hold on its own below. The 24-hour
// clock buys two things: confidence the owner is really dead rather than transiently unreadable, and time
// for a human to look before anything is destroyed. An operator naming ONE run by id, whose death a
// previous sweep already recorded, supplies both directly. Fail-closed: every term is required, and a
// missing or mismatched authorization falls through to the ordinary retain.
function manualReclaimAuthorized(run, manual) {
  return Boolean(manual) && manual.kind === 'reclaim-scratch' && manual.run_id === run.id
    && run.state === 'blocked_unclassified'
    && !manual.protected.includes(run.id);
}

// The disposition authority that closes the two no-endpoint classes. TWO things must both hold, and the
// separation is the whole safety of it:
//
//   1. The RECORD carries an operator's disposition, written in a prior phase before any byte is at
//      risk. Because it lives in the journal, applyRun's drift re-check re-derives this same decision
//      from the record across the mutation boundary rather than trusting a value threaded past it.
//   2. The CALLER passes a matching in-process authorization. runJanitor never does - it calls
//      runDecision(run, now) with no `manual` - so the unattended sweep NEVER gains this authority,
//      which the spec names as a non-goal. Recording alone must not be enough, or the next scheduled
//      sweep would quietly finish what an operator only authorised.
//
// `kind` is checked so the two manual authorities cannot cross-authorise each other: a reclaim
// authorization must never satisfy disposition, nor the reverse. Fail-closed on every missing term.
function manualDispositionAuthorized(run, manual) {
  return Boolean(manual) && manual.kind === 'dispose-unclassified' && manual.run_id === run.id
    && Boolean(run.unclassified_disposed_at);
}

function runDecision(run, now, manual) {
  if (run.state === 'reserved') {
    if (alive(run.owner)) return { action: 'retain', reason: 'owner-live' };
    return run.first_dead_at ? { action: 'retain', reason: 'reserved-artifacts-disposed' } : { action: 'recover-reserved' };
  }
  if (['allocated', 'running', 'sealing', 'blocked_unclassified'].includes(run.state)) {
    if (alive(run.owner)) return { action: 'retain', reason: 'owner-live' };
    if (!run.first_dead_at) return { action: 'observe-dead' };
    const manualOverride = !inclusiveElapsed(run.first_dead_at, DAY, now);
    if (manualOverride && !manualReclaimAuthorized(run, manual)) return { action: 'retain', reason: 'dead-under-24h' };
    const evidenceCommitted = run.state === 'blocked_unclassified' || Boolean(run.preliminary_audit_at && run.preliminary_evidence_digest);
    // The never-classified class: a run that died in allocated/running/sealing committed no evidence, so
    // it was retained here INDEFINITELY with no endpoint at any age. A recorded disposition is the only
    // thing that reaches it, and it does NOT substitute for the 24-hour wait - `manualOverride` still
    // sends an under-24h run back to the ordinary retain above, so disposition adds an authority without
    // shortening the window a human has to look first.
    if (!evidenceCommitted) {
      if (manualOverride || !manualDispositionAuthorized(run, manual)) return { action: 'retain', reason: 'evidence-unclassified' };
      return { action: 'discard-scratch', reason: 'unclassified-disposition' };
    }
    return manualOverride ? { action: 'discard-scratch', reason: 'manual-failed-reclamation' } : { action: 'discard-scratch' };
  }
  if (run.state === 'scratch_discarding') return alive(run.owner) ? { action: 'retain', reason: 'owner-live' } : { action: 'recover-scratch' };
  if (run.state === 'scratch_discarded') {
    // The stranded class: a run that reached scratch_discarded from blocked_unclassified carries no
    // publication authority, so the 7/30-day expiry below can never authorise its evidence and it was
    // retained forever. A recorded disposition is the other admissible authority; without one this is
    // still the dead end it always was.
    if (!run.published_at || !Number.isInteger(run.gate_status)) {
      if (!manualDispositionAuthorized(run, manual)) return { action: 'retain', reason: 'publication-authority-missing' };
      return { action: 'discard-evidence', reason: 'unclassified-disposition' };
    }
    const retention = run.gate_status === 0 ? 7 * DAY : 30 * DAY;
    return inclusiveElapsed(run.published_at, retention, now) ? { action: 'discard-evidence' } : { action: 'retain', reason: 'evidence-retention' };
  }
  if (run.state === 'evidence_discarding') return alive(run.owner) ? { action: 'retain', reason: 'owner-live' } : { action: 'recover-evidence' };
  return { action: 'retain', reason: `state-${run.state}` };
}

function ensureMounted(kind, id) {
  try { return require('./storage-containers.cjs').resolveMounted(kind, id); }
  catch (error) {
    if (!String(error?.message || '').startsWith('CONTAINER_MOUNT_ABSENT:')) throw error;
    return attachExisting(kind, id);
  }
}

function releaseRetainedContainer(kind, run) {
  let mounted;
  try {
    mounted = containers.resolveMounted(kind, run.id);
  } catch (error) {
    if (!String(error?.message || '').startsWith('CONTAINER_MOUNT_ABSENT:')) throw error;
    // Nothing is mounted at the fixed point. If the backing image is ALSO gone from disk, the container is
    // PROVABLY absent - no volume, no bytes, nothing to detach - so a dead-owner run whose image was lost
    // out of band no longer wedges this liveness sweep forever on CONTAINER_IMAGE_MISSING. Proven, not
    // assumed: the mount was resolved and the image path stat'd. This is a no-op that touches nothing and
    // introduces no deletion authority; the disposition to a terminal record is a separate operator verb.
    // If the image file IS still present it is attached and detached exactly as before (unchanged path).
    if (!fs.existsSync(imagePath(kind, run.id))) return { retained: kind, run_id: run.id, backing_absent: true };
    mounted = attachExisting(kind, run.id);
  }
  // Liveness recovery retains bytes, so the mounted marker's identity is the operative proof. Using
  // its exact seal also normalizes an image that was already detached: it is attached above,
  // detachRetain proves that same image detached, and no deletion authority is introduced.
  return detachRetain(kind, run.id, mounted.seal);
}

function withVerifiedEvidence(run, operation) {
  const mounted = ensureMounted('evidence', run.id);
  let result;
  let primary = null;
  try {
    if (run.unclassified_disposed_at !== undefined) require('./storage-gate.cjs').verifyRetainedEvidence(run);
    else if (run.preliminary_evidence_digest) require('./storage-gate.cjs').verifyPreliminaryEvidence(run);
    else require('./storage-containers.cjs').requireSeal(mounted.seal, run.evidence_seal);
    result = operation();
  } catch (error) {
    primary = error;
  }
  try {
    detachRetain('evidence', run.id, mounted.seal);
  } catch (cleanup) {
    if (!primary) throw cleanup;
    const error = new Error(`JANITOR_EVIDENCE_RELEASE_FAILED[primary=${String(primary.message || primary)}; cleanup=${String(cleanup.message || cleanup)}]`);
    error.errors = [primary, cleanup];
    throw error;
  }
  if (primary) throw primary;
  return result;
}

function discardVerifiedEvidence(run) {
  const mounted = ensureMounted('evidence', run.id);
  try {
    require('./storage-gate.cjs').verifyRetainedEvidence(run);
  } catch (primary) {
    try { detachRetain('evidence', run.id, mounted.seal); }
    catch (cleanup) {
      const error = new Error(`JANITOR_EVIDENCE_RELEASE_FAILED[primary=${String(primary.message || primary)}; cleanup=${String(cleanup.message || cleanup)}]`);
      error.errors = [primary, cleanup];
      throw error;
    }
    throw primary;
  }
  return detachAndDiscard('evidence', run.id, run.evidence_seal);
}

function applyRunHeld(id, decision, now, manual) {
  let run = readRecord('runs', id);
  const currentDecision = runDecision(run, now, manual);
  if (currentDecision.action !== decision.action || currentDecision.reason !== decision.reason) throw new Error('JANITOR_AUTHORIZATION_DRIFT');
  if (decision.action === 'recover-reserved') {
    for (const kind of ['scratch', 'evidence']) {
      if (!fs.existsSync(imagePath(kind, id))) continue;
      const recovered = recoverOrCreate(kind, id);
      detachAndDiscard(kind, id, recovered.seal);
    }
    return replaceRecord('runs', id, run.revision, { ...run, revision: run.revision + 1, first_dead_at: new Date(now).toISOString() });
  }
  if (decision.action === 'observe-dead') {
    return replaceRecord('runs', id, run.revision, { ...run, revision: run.revision + 1, first_dead_at: new Date(now).toISOString() });
  }
  if (decision.action === 'discard-scratch' || decision.action === 'recover-scratch') {
    return withVerifiedEvidence(run, () => {
      if (decision.action === 'discard-scratch') run = transitionRun(id, run.revision, 'scratch_discarding', { scratch_discard_started_at: new Date(now).toISOString() });
      if (fs.existsSync(imagePath('scratch', id))) {
        if (decision.action === 'recover-scratch') recoverDiscarding('scratch', id, run.scratch_seal);
        else { ensureMounted('scratch', id); detachAndDiscard('scratch', id, run.scratch_seal); }
      }
      gateMutations.recoverDeadHostLock(id);
      if (run.published_at) return gateMutations.finalizeScratchDiscard(id, now);
      return transitionRun(id, run.revision, 'scratch_discarded', { scratch_discarded_at: new Date(now).toISOString() });
    });
  }
  // The retention clock has EXPIRED this evidence and nothing has moved yet: the decision exists,
  // the image is intact, and the record still says scratch_discarded - NOT published. A run only
  // reaches a discard-evidence decision after its scratch has already gone, via the branch above, so
  // recovery written for this crash class must match on scratch_discarded or it will never fire.
  if (decision.action === 'discard-evidence') require('./storage-crash-points.cjs').crashPoint('retention');
  if (decision.action === 'discard-evidence') run = transitionRun(id, run.revision, 'evidence_discarding', { evidence_discard_started_at: new Date(now).toISOString() });
  if (decision.action === 'discard-evidence' || decision.action === 'recover-evidence') {
    if (fs.existsSync(imagePath('evidence', id))) {
      if (decision.action === 'recover-evidence') recoverDiscarding('evidence', id, run.evidence_seal, (mount) => require('./storage-gate.cjs').verifyRetainedEvidence(run, mount));
      else discardVerifiedEvidence(run);
    }
    // The tombstone that would close this run has NOT been written. Deliberately stated that way and
    // not as "the evidence is gone": this point sits outside the existsSync above, so on a
    // recover-evidence sweep whose image was already absent nothing was removed HERE. What the
    // crossing bounds either way is the record - the run still says evidence_discarding, which is
    // exactly the state this branch resumes from.
    require('./storage-crash-points.cjs').crashPoint('tombstone');
    return transitionRun(id, run.revision, 'evidence_discarded', { evidence_discarded_at: new Date(now).toISOString(), deleted_at: new Date(now).toISOString() });
  }
  return run;
}

function acquireJanitor(authority) {
  const target = path.join(fixedLayout().state, 'janitor.lock');
  const token = require('node:crypto').randomUUID();
  const value = { schema: 1, generation: authority.generation, host: authority.host, uid: authority.uid, pid: process.pid, token, created_at: new Date().toISOString() };
  try { fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const held = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(Object.keys(held).sort()) !== JSON.stringify(['created_at', 'generation', 'host', 'pid', 'schema', 'token', 'uid']) || held.schema !== 1 || held.generation !== authority.generation || held.host !== authority.host || held.uid !== authority.uid || !Number.isInteger(held.pid)) throw new Error('JANITOR_LOCK_INVALID');
    try { process.kill(held.pid, 0); throw new Error('JANITOR_ALREADY_RUNNING'); } catch (probe) { if (probe.message === 'JANITOR_ALREADY_RUNNING' || probe.code === 'EPERM') throw probe; if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(target); fsyncDirectory(path.dirname(target));
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  }
  fsyncDirectory(path.dirname(target));
  return () => {
    const held = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(Object.keys(held).sort()) !== JSON.stringify(['created_at', 'generation', 'host', 'pid', 'schema', 'token', 'uid']) || held.token !== token || held.generation !== authority.generation || held.pid !== process.pid) throw new Error('JANITOR_LOCK_DRIFT');
    fs.unlinkSync(target); fsyncDirectory(path.dirname(target));
  };
}

function rotateReports(now = Date.now()) {
  const directory = path.join(fixedLayout().state, 'reports');
  if (!fs.existsSync(directory)) return;
  const reports = fs.readdirSync(directory).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map((name) => {
    const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const completed = Date.parse(value.completed_at);
    if (value.report_id !== name.slice(0, -5) || !Number.isFinite(completed) || completed > now) throw new Error('REPORT_RETENTION_AUTHORITY_INVALID');
    return { name, completed };
  }).sort((a, b) => a.completed - b.completed);
  for (const report of reports.filter((entry, index) => now - entry.completed >= 30 * DAY || index < reports.length - 120)) fs.unlinkSync(path.join(directory, report.name));
  fsyncDirectory(directory);
}

function applyRun(id, decision, now, manual) {
  return withRecordMutation('runs', id, () => applyRunHeld(id, decision, now, manual));
}

// `recoverDeadHostLock` is fail-closed: it throws HOST_LOCK_RECOVERY_MISMATCH unless the lock PROVABLY
// belongs to this run, so "not mine" is the NORMAL answer for every run that does not own it and must
// never abort the sweep. One call site treated that as FATAL while the identical call in the liveness
// backstop treated it as skippable - the third instance of the asymmetry pattern in this lane, after
// layer 8's three-of-four call sites and the two `defaults` guards where one threw and one shrugged.
// It was also the most expensive: a stale lock owned by ANY one run disabled ALL janitor reclamation,
// in the very component this lane exists to build, and the gate then wedged itself on disk with no
// verb able to recover (measured: lock owned by `4e61544d` aborted the sweep while it was processing
// `53f30d6f`).
//
// Mismatch is skipped SILENTLY because it is the expected answer for most runs; anything else is
// COUNTED and NAMED into the report rather than swallowed - the R7 corollary, which says an
// enumeration the reclamation agent depends on must never die on one record and that silent skipping
// is not the fix either. The previous bare `catch {}` at the backstop satisfied the first half and
// failed the second.
function tryRecoverDeadHostLock(id, report) {
  try { gateMutations.recoverDeadHostLock(id); }
  catch (error) {
    const message = String(error.message || error);
    if (!message.startsWith('HOST_LOCK_RECOVERY_MISMATCH')) report.errors.push({ kind: 'run', id, error: `HOST_LOCK_RECOVERY:${message}` });
  }
}

function runJanitor(mode, now = Date.now()) {
  recoverAtomicTemps();
  const authority = validateInstalledAuthority();
  const release = acquireJanitor(authority);
  const reportId = generatedId();
  const active = mode === 'dry-run' ? listRecords('scheduler').filter((entry) => entry.state === 'candidate_installed') : [];
  if (active.length > 1) throw new Error('SCHEDULER_SMOKE_TRANSACTION_CARDINALITY');
  const binding = active.length === 1 ? { transaction_id: active[0].id, generation: active[0].generation, candidate_digest: active[0].candidate_digest } : {};
  const report = { schema: 1, report_id: reportId, mode, entries: [], errors: [], completed_at: null, ...binding };
  try {
    const disabled = path.join(fixedLayout().state, 'disabled');
    if (mode === 'apply' && fs.existsSync(disabled)) {
      const stat = fs.lstatSync(disabled);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('JANITOR_KILL_SWITCH_INVALID');
      report.errors.push({ kind: 'authority', id: 'kill-switch', error: 'JANITOR_DISABLED' });
      return report;
    }
    // PRESENT-BUT-INVALID, NEVER ABSENT. The two mean opposite things to the accounting invariant, and
    // getting it wrong here would be worse than throwing: an omitted record makes evidence-images ==
    // journal-runs reconcile against a corpus with a hole in it, so a genuinely leaked image could be
    // MASKED by the arithmetic working out - the check that exists to prove nothing was wrongly deleted
    // reading short. So the record is COUNTED into `entries` with an action that is explicitly not a
    // decision, and NAMED into `errors`, which the CLI outcome contract turns into a non-zero exit and a
    // visible non-zero column in `launchctl list` - the only observable a /dev/null-streamed scheduled
    // janitor has. What it is NOT is handed to runDecision: a malformed record must never reach a path
    // that can delete something.
    //
    // NO READER DIVERGENCE. Nothing here deletes or hides a record FILE, and no JS caller counts runs for
    // accounting (rotateTerminal is the only other run-enumerating caller and stays strict, without a
    // collector), so a file-counting reader and this one still see the same N. That is a property of this
    // shape, not an accident - see spec section 11.2.
    const unreadable = (kind) => (id, error) => {
      report.entries.push({ kind, id, action: 'blocked-unreadable', reason: 'AUTHORITY_RECORD_UNREADABLE' });
      report.errors.push({ kind, id, error: `AUTHORITY_RECORD_UNREADABLE:${error}` });
    };
    const runs = listRecords('runs', unreadable('run'));
    const inventory = readConsistencyInventory(fixedLayout());
    report.entries.push(reconcileRunImages(runs, inventory, inventory.journal));
    for (const run of runs) {
      if (['scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(run.state) && !alive(run.owner)) tryRecoverDeadHostLock(run.id, report);
      // Abnormal-exit LIVENESS backstop for a run whose owner died before releasing its own resources.
      //
      // The state set is deliberately the PRE-PUBLISHED set, not just blocked_unclassified. That state
      // is reached ONLY by runFullGate's in-process catch handlers - precisely the code an uncatchable
      // exit prevents from running. A SIGKILL, panic, OOM or power loss leaves the run in allocated,
      // running or sealing instead, and runDecision returns retain for those PERMANENTLY, not after a
      // wait (evidenceCommitted requires either blocked_unclassified or a preliminary_audit_at that
      // only the success path sets). So applyRun never fires, recoverDeadHostLock is never reached,
      // gate.lock and both mounts strand forever, and every later gate dies on
      // HOST_LOCK_UNREADABLE_OR_STALE with no CLI endpoint able to recover it. Covering only
      // blocked_unclassified would cover the one case that already self-heals in-process and miss
      // every case this backstop exists for.
      //
      // It reclaims EXACTLY TWO things and NOTHING MORE: the mounts and the host lock. It gains ZERO
      // deletion authority. detachRetain detaches WITHOUT discarding, so both images keep their
      // backing; the ONLY authority that may ever delete them remains the fail-closed pre-published
      // relation in runDecision - dead owner + immutable 24h first-dead observation +
      // identity/generation match - which is untouched here, and unclassified evidence stays retained
      // indefinitely (invariant 9). recoverDeadHostLock keeps its own fail-closed proof (dead pid +
      // host/uid/token-digest/generation, including its pre-handoff branch for a lock that was never
      // claimed). Gated on apply so dry-run never changes container attachments or the host lock.
      if (mode === 'apply' && ['allocated', 'running', 'sealing', 'blocked_unclassified'].includes(run.state) && !alive(run.owner)) {
      // A detach that failed must not be reported as recovered: the mount stays occupied and the
      // report is the only place anyone would ever learn it. Swallowed so the sweep continues,
      // named so the run's entry carries an error and the janitor's exit code with it.
      let mountRecoveryFailed = false;
      for (const kind of ['scratch', 'evidence']) {
        try { releaseRetainedContainer(kind, run); }
        catch (failure) {
          mountRecoveryFailed = true;
          report.errors.push({ kind: 'run', id: run.id, error: `mount-recovery-${kind}: ${String(failure.message || failure)}` });
        }
      }
      if (!mountRecoveryFailed) tryRecoverDeadHostLock(run.id, report);
      }
      const decision = runDecision(run, now);
      report.entries.push({ kind: 'run', id: run.id, action: decision.action, reason: decision.reason || null });
      // Dry-run owns exactly one journal mutation: starting a dead-owner observation clock. It
      // cannot recover, discard, retire, or otherwise delete. applyRun re-reads and re-authorizes the
      // decision under the record-mutation lock, so a liveness or identity change still refuses.
      if ((mode === 'apply' && decision.action !== 'retain') || (mode === 'dry-run' && decision.action === 'observe-dead')) {
        try { applyRun(run.id, decision, now); }
        catch (error) { report.errors.push({ kind: 'run', id: run.id, error: String(error.message || error) }); }
      }
    }
    for (const ticket of listRecords('tickets', unreadable('ticket')).filter((entry) => ['registered', 'removing'].includes(entry.state))) {
      const action = ticket.state === 'removing' ? 'recover-removing' : now - Date.parse(ticket.registered_at) >= DAY && !require('./storage-worktrees.cjs').creatorAlive(ticket) ? 'prove-retirement' : 'retain';
      report.entries.push({ kind: 'ticket', id: ticket.id, action, reason: null });
      if (mode === 'apply' && action !== 'retain') {
        try { retireWorktree(ticket.id, now); }
        catch (error) { report.errors.push({ kind: 'ticket', id: ticket.id, error: String(error.message || error) }); }
      }
    }
    if (mode === 'apply') { rotateTerminal('runs', now); rotateTerminal('tickets', now); }
  } finally {
    try {
      report.completed_at = new Date(now).toISOString();
      atomicJson(path.join(fixedLayout().state, 'reports', `${reportId}.json`), report);
      rotateReports(now);
    } finally { release(); }
  }
  return report;
}

function discardEvidence(runId, now = Date.now()) {
  validateInstalledAuthority();
  const run = readRecord('runs', runId);
  const decision = runDecision(run, now);
  if (decision.action !== 'discard-evidence' && decision.action !== 'recover-evidence') throw new Error('EVIDENCE_DISCARD_NOT_AUTHORIZED');
  return applyRun(runId, decision, now);
}

// The newest FAILURE_RETENTION failures, by seal time, which manual reclamation may not touch WHILE THE
// 24-HOUR WAIT IS STILL RUNNING - that is the only thing this set gates. Past 24 hours the automatic
// sweep is already authorised to discard the same scratch, so refusing the manual verb there would
// protect nothing and only make the two paths disagree (verified 2026-07-23: protected id at exactly
// 24 h returns discard-scratch). Derived
// from the journal at call time rather than passed in, so a caller cannot widen its own authority by
// naming a smaller protected set.
function protectedFailures() {
  return listRecords('runs')
    .filter((entry) => entry.state === 'blocked_unclassified')
    .sort((a, b) => String(b.sealing_at).localeCompare(String(a.sealing_at)))
    .slice(0, FAILURE_RETENTION)
    .map((entry) => entry.id);
}

// Reclaim the scratch of ONE named failed run. This exists because discardPublishedScratch requires
// state 'published' and a failed run never reaches it, so before this verb the lane could not reclaim
// after its own failures and wedged itself on disk as failures accumulated.
//
// It gains NO deletion authority of its own. It routes through the same runDecision -> applyRun path the
// automatic sweep uses, so the discard is journal-recorded as blocked_unclassified -> scratch_discarding
// -> scratch_discarded and 11.2 keeps holding: every absent scratch image still has a record authorising
// it. The only thing it substitutes is the 24-hour first-dead wait, and only for the run named here.
function reclaimFailedScratch(runId, now = Date.now()) {
  recoverAtomicTemps();
  validateInstalledAuthority();
  const run = readRecord('runs', runId);
  if (run.state !== 'blocked_unclassified') throw new Error('FAILED_SCRATCH_RECLAMATION_NOT_AUTHORIZED');
  const manual = { kind: 'reclaim-scratch', run_id: runId, protected: protectedFailures() };
  const decision = runDecision(run, now, manual);
  // Either authorization is legitimate: the manual override, or an already-elapsed 24-hour wait that the
  // sweep simply has not reached yet. Anything else - owner live, death unobserved, retention-protected -
  // comes back as retain and is refused here.
  if (decision.action !== 'discard-scratch') throw new Error('FAILED_SCRATCH_RECLAMATION_NOT_AUTHORIZED');
  return applyRun(runId, decision, now, manual);
}

// The two classes with no disposition path, closed by ONE endpoint because they are one defect:
// evidence whose run never published, retained forever because nothing could authorise letting it go.
//
// ELIGIBILITY IS DELEGATED, NOT RESTATED. Rather than re-deriving liveness, the 24-hour observation and
// the state set - four predicates that would then have to be kept in step with runDecision forever -
// this asks runDecision what it says with NO disposition authority and acts only where the answer is one
// of the two dead-end retains. So the endpoint fires exactly where the system itself reports having no
// endpoint, and every other verdict refuses: owner-live, dead-under-24h, evidence-retention (ordinary
// 7/30-day expiry already owns those, and preempting it would destroy evidence early), an already
// authorised discard, or any other state. Fail-closed, and it cannot drift out of step with the
// decision function it defers to.
//
// TWO PHASES, and the ORDER is the safety property. Phase 1 seals the evidence and records the operator's
// authority in the journal; only then does phase 2 destroy anything. A crash between them leaves a run
// that is authorised but intact - recoverable, and honestly described by its own record - which is the
// right way round. The reverse would destroy bytes whose authorisation was never durable.
//
// AC5: the sequence RUNS TO COMPLETION rather than stopping after the scratch. A never-classified run
// whose scratch was discarded would land in scratch_discarded WITHOUT publication authority - the exact
// dead end this spec exists to close, manufactured by the fix for it. So it keeps applying authorised
// decisions until the run is terminal, and refuses to stop half-way.
function disposeUnclassified(runId, reason, now = Date.now()) {
  recoverAtomicTemps();
  validateInstalledAuthority();
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.trim().length > 256) throw new Error('UNCLASSIFIED_DISPOSITION_REASON_REQUIRED');
  const normalizedReason = reason.trim();
  const initial = readRecord('runs', runId);
  const preDecision = runDecision(initial, now);
  const destructiveResume = Boolean(initial.unclassified_disposed_at)
    && ['scratch_discarding', 'evidence_discarding'].includes(initial.state);
  if (destructiveResume && initial.disposition_reason !== normalizedReason) throw new Error('UNCLASSIFIED_DISPOSITION_REASON_DRIFT');
  if (!destructiveResume && (preDecision.action !== 'retain' || !['evidence-unclassified', 'publication-authority-missing'].includes(preDecision.reason))) throw new Error(`UNCLASSIFIED_DISPOSITION_NOT_AUTHORIZED:${preDecision.action}/${preDecision.reason || 'none'}`);

  // PHASE 1 - authorise. Seals under the record mutation so the digest recorded is the digest of what
  // was there when the authority was written, not of something that changed while it was being written.
  if (!destructiveResume) withRecordMutation('runs', runId, () => {
    const run = readRecord('runs', runId);
    const current = runDecision(run, now);
    if (current.action !== preDecision.action || current.reason !== preDecision.reason) throw new Error('UNCLASSIFIED_DISPOSITION_AUTHORIZATION_DRIFT');
    return withVerifiedEvidence(run, () => {
      const digest = gateMutations.sealUnclassifiedEvidence(runId);
      if (run.unclassified_disposed_at !== undefined) {
        if (run.disposition_reason !== normalizedReason) throw new Error('UNCLASSIFIED_DISPOSITION_REASON_DRIFT');
        if (run.evidence_digest !== digest) throw new Error('UNCLASSIFIED_DISPOSITION_DIGEST_DRIFT');
        return run;
      }
      return replaceRecord('runs', runId, run.revision, {
        ...run,
        revision: run.revision + 1,
        evidence_digest: digest,
        unclassified_disposed_at: new Date(now).toISOString(),
        disposition_reason: normalizedReason,
      });
    });
  });

  // PHASE 2 - dispose. The authority now lives in the record, so applyRun's drift re-check re-derives
  // these same decisions from the journal rather than trusting anything threaded through this loop.
  const manual = { kind: 'dispose-unclassified', run_id: runId };
  let run = readRecord('runs', runId);
  // Bounded because an unbounded loop over a decision function is a hang waiting for a schema change to
  // introduce a cycle. Four is the longest legitimate chain (discard-scratch, recover-scratch,
  // discard-evidence, recover-evidence) with room to spare; exceeding it is a defect, not a slow path.
  for (let step = 0; step < 4 && run.state !== 'evidence_discarded'; step += 1) {
    const decision = runDecision(run, now, manual);
    if (decision.action === 'retain') throw new Error(`UNCLASSIFIED_DISPOSITION_STALLED:${run.state}/${decision.reason || 'none'}`);
    run = applyRun(runId, decision, now, manual);
  }
  if (run.state !== 'evidence_discarded') throw new Error(`UNCLASSIFIED_DISPOSITION_INCOMPLETE:${run.state}`);
  return run;
}

function recoverRun(runId, now = Date.now()) {
  recoverAtomicTemps();
  validateInstalledAuthority();
  const run = readRecord('runs', runId);
  const decision = runDecision(run, now);
  if (!['recover-reserved', 'recover-scratch', 'recover-evidence'].includes(decision.action)) throw new Error('RUN_RECOVERY_NOT_ADJACENT');
  return applyRun(runId, decision, now);
}

// The disposition endpoint for a run whose backing images were lost OUT OF BAND: a dead-owner
// blocked_unclassified run whose scratch AND evidence sparsebundles are both gone from disk. Before this
// verb every disposition/recovery primitive attached the image first, so an absent image was an
// unconditional CONTAINER_IMAGE_MISSING and such a run wedged janitor health and gate reservation forever.
//
// It gains NO deletion authority - it is the one disposition path that deletes NOTHING, because there is
// nothing left to delete. It only completes the journal to the terminal `backing_absent` state, recording
// when the absence was dispositioned and on what grounds. Fail-closed on every term:
//   - state blocked_unclassified only (the sole committed-evidence dead-owner state that strands here);
//   - owner dead and a prior sweep already observed the death (first_dead_at), same liveness floor the
//     reclamation verbs require - it does NOT wait the 24-hour term because there are no bytes a human
//     could still want to look at, the whole predicate is that they are already gone;
//   - absence is PROVEN, not assumed: BOTH images must be off disk AND nothing mounted at either fixed
//     point. A single present or still-mounted image means there ARE bytes to account for, so it refuses
//     and the operator uses the ordinary reclamation/disposition path (the partial-absence case).
function disposeAbsentBacking(runId, reason, now = Date.now()) {
  recoverAtomicTemps();
  validateInstalledAuthority();
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.trim().length > 256) throw new Error('ABSENT_BACKING_REASON_REQUIRED');
  const normalizedReason = reason.trim();
  const initial = readRecord('runs', runId);
  if (initial.state !== 'blocked_unclassified') throw new Error(`ABSENT_BACKING_NOT_AUTHORIZED:state/${initial.state}`);
  if (alive(initial.owner)) throw new Error('ABSENT_BACKING_NOT_AUTHORIZED:owner-live');
  if (!initial.first_dead_at) throw new Error('ABSENT_BACKING_NOT_AUTHORIZED:death-unobserved');
  for (const kind of ['scratch', 'evidence']) {
    if (fs.existsSync(imagePath(kind, runId))) throw new Error(`ABSENT_BACKING_PRESENT:${kind}`);
    try { containers.resolveMounted(kind, runId); }
    catch (error) {
      if (String(error?.message || '').startsWith('CONTAINER_MOUNT_ABSENT:')) continue;
      throw error;
    }
    throw new Error(`ABSENT_BACKING_MOUNTED:${kind}`);
  }
  // The authority is re-derived under the record-mutation lock: transitionRun re-reads the record, and a
  // liveness or state change since the checks above turns the blocked_unclassified -> backing_absent edge
  // invalid (fail-closed). Nothing is attached, detached, or deleted here - this is a pure journal write.
  return withRecordMutation('runs', runId, () => {
    const run = readRecord('runs', runId);
    if (run.state !== 'blocked_unclassified' || alive(run.owner) || !run.first_dead_at) throw new Error('ABSENT_BACKING_AUTHORIZATION_DRIFT');
    return transitionRun(runId, run.revision, 'backing_absent', {
      backing_absent_at: new Date(now).toISOString(),
      backing_absent_reason: normalizedReason,
    });
  });
}

module.exports = { DAY, bind: (token) => require('./storage-capability.cjs').bind(token, { discardEvidence, disposeAbsentBacking, disposeUnclassified, reclaimFailedScratch, recoverRun, runJanitor }), inclusiveElapsed, runDecision };
