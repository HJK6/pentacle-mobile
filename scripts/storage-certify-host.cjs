#!/usr/bin/env node
// AC checkbox-8 certification checker, PART 3 — THE HOST-STATE READER.
//
// storage-certify.cjs reads an EVIDENCE DIRECTORY. Three of section 11's criteria cannot be answered
// from one: section 11.2's accounting is CROSS-RUN by construction (evidence images == total runs;
// scratch == runs minus those carrying scratch_discarded_at), and section 11.1's post-run criteria are
// facts about the HOST. So this is not "four checks become seven" — it is the instrument gaining a
// reader for a different subject.
//
// PROVENANCE: this is a PORT, not a new checker. The implementation it ports is `certify.sh`, written by
// an earlier QA seat, run repeatedly against real runs, and rescued from a dead seat's /private/tmp
// scratchpad to `agent-workspace/agent-outputs/certify-host-state-11.2.sh`. It worked. The reason to port
// it is that storage-certify.cjs:7 DELEGATES these three criteria to it BY NAME while it was never
// version-controlled on any branch — a landed instrument pointing at a checker living only in volatile
// temp. That is a TOOL dropped across a handoff, which is the same disease as a manual check dropped
// across a handoff, one level worse.
//
// WHAT IS DELIBERATELY UNCHANGED FROM THE ORIGINAL (each is a tripwire; losing one is a CRITERION change,
// not a refactor, and goes to the Nexus BEFORE a run):
//   T1. Mounts are counted BY PATH UNDER THE INSTALLED ROOT. The frozen legacy root at
//       `Library/Application Support/PentacleMobileStorage` keeps its OWN State mount BY DESIGN, so a
//       global count, or "expect exactly one storage mount", misfires PERMANENTLY. A control below pins
//       this in the direction that catches a regression: a legacy-root mount must NOT be counted.
//   T2. THE MID-RUN READING IS INVERTED. Mid-run, gate.lock PRESENT and THREE mounts under the installed
//       root is CORRECT. The original carried that warning in its output text so a human could not
//       misread a healthy mid-run host as a failure; here it is stronger — `phase` is an argument, both
//       readings are checked, and the warning text is still emitted.
//   T3. Section 11.2 is cross-run and needs the journal plus the image directories. It must never be
//       computed from a mounted evidence directory alone, which is how a cross-run property gets quietly
//       computed per-run and stops meaning anything.
//   T4. Section 11.3 fails BOTH ways — undeclared-on-disk AND declared-but-absent — and treats
//       zero-declared-across-all-cases as SUSPICIOUS rather than passing it. All-clear because nothing
//       was captured is not all-clear. Kept at the owner's explicit request; do not make it one-directional.
//
// CHANGES FROM THE HAND CHECKER, each stated so a reviewer can reject them individually:
//   C1. The original hardcoded one machine's absolute path in its mount grep, and derived its root from
//       `~`. Both are HOME-derived. `fixedLayout()` uses os.homedir(), which honours $HOME — MEASURED:
//       under HOME=/tmp/x, os.homedir() returns /tmp/x while os.userInfo().homedir still returns the
//       passwd home. So a checker run under a redirected HOME resolves a DIFFERENT lock, a DIFFERENT
//       root and a DIFFERENT journal, and reports a confident clean about an installation it never read.
//       Here the redirection is a DISTINGUISHED, FAIL-CLOSED outcome rather than a silent wrong answer.
//   C2. The original's gate.lock check is binary: PRESENT-BAD or ABSENT-OK. A lock held by a DEAD pid and
//       a lock held by a LIVE pid mean opposite things — one is debris, the other is a running gate — and
//       conflating them is R11. Split into four outcomes. The verdict for a post-run audit is unchanged;
//       only the diagnosis is finer.
//   C3. The original checks section 11.2 by COUNT only. Counts can reconcile against the wrong corpus:
//       run A discarded with its image still present and run B undiscarded with its image gone reconciles
//       perfectly while B's image has leaked. Section 11.2's own text requires that EVERY absent scratch
//       image have a record authorising its discard, so this implements the stated criterion rather than
//       widening it. This is the one change that can newly FAIL a host the original would have passed.
//   C4. The repo whose source drives certification is bound to evidence/native-root.json candidate_sha:
//       a dirty tree, a different HEAD, an unreadable Git result, and absent evidence are distinct refusals.
//   C5. JSON sidecars are not case payloads. Case results are read only through manifest.cases[].result,
//       which is the producer's own identity map; scanning every .json inflated the old reader's count.
//   C6. The sim-queue path uses the gate producer's exact precedence: SIM_QUEUE_ROOT, then
//       XDG_DATA_HOME/sim-queue, then os.homedir()/.local/share/sim-queue. The fallback deliberately uses
//       os.homedir() because the gate does; the redirected-HOME guard refuses that environment before the
//       reading can certify anything. Passwd-home semantics are used for the journal hunk in the caller,
//       where matching the gate's redirected child is not the subject.
//
// STRUCTURE: every check is a PURE function over injected readings; the readers do the I/O. That is what
// lets the controls run on synthetic host state with no mounts, no lock and no journal — an instrument
// whose selftest needs a real host is one nobody runs.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Every outcome gets its OWN message. Controls assert the exact message, never a family prefix: a
// prefix assertion passes when the checker fires for a DIFFERENT reason, which is a control that proves
// nothing. (Reviewer's v4 method.)
const M = {
  ROOT_REDIRECTED: (env, passwd) => `HOSTROOT: running under a redirected HOME (${env}) while the passwd home is ${passwd} — every HOME-derived reading would describe the wrong installation`,
  ROOT_ABSENT: (root) => `HOSTROOT: installed root ${root} does not exist`,
  ROOT_UNOBSERVABLE: (root, detail) => `HOSTROOT: could not determine whether installed root ${root} exists — ${detail}`,

  LOCK_LIVE: (pid) => `LOCK: gate.lock is PRESENT and owner pid ${pid} is ALIVE — a gate run is in flight`,
  LOCK_STALE: (pid) => `LOCK: gate.lock is PRESENT but STALE — owner pid ${pid} is not alive`,
  LOCK_UNREADABLE: (detail) => `LOCK: gate.lock is PRESENT and UNREADABLE — ${detail}`,
  LOCK_UNOBSERVABLE: (detail) => `LOCK: could not determine whether gate.lock is present — ${detail}`,
  LOCK_ABSENT_MIDRUN: () => 'LOCK: gate.lock is ABSENT during a mid-run audit — the run does not hold the host lock',

  MOUNT_SCRATCH: (p) => `MOUNT: Scratch is still mounted under the installed root at ${p}`,
  MOUNT_EVIDENCE: (p) => `MOUNT: Evidence is still mounted under the installed root at ${p}`,
  MOUNT_STATE_ABSENT: () => 'MOUNT: the State mount under the installed root is ABSENT',
  MOUNT_UNEXPECTED: (p) => `MOUNT: unexpected mount under the installed root: ${p}`,
  MOUNT_SCRATCH_MISSING_MIDRUN: () => 'MOUNT: Scratch is NOT mounted during a mid-run audit',
  MOUNT_EVIDENCE_MISSING_MIDRUN: () => 'MOUNT: Evidence is NOT mounted during a mid-run audit',
  MOUNT_UNOBSERVABLE: (detail) => `MOUNT: host mounts could not be enumerated — ${detail}`,

  ACCT_EVIDENCE_COUNT: (got, want) => `ACCT: ${got} evidence images against ${want} journal runs — section 11.2 requires equality`,
  ACCT_SCRATCH_COUNT: (got, want, disc) => `ACCT: ${got} scratch images against ${want} (runs minus ${disc} discarded)`,
  ACCT_UNAUTHORISED_ABSENCE: (id) => `ACCT: scratch image for run ${id} is ABSENT but its record carries no scratch_discarded_at — an unauthorised deletion`,
  ACCT_DISCARDED_PRESENT: (id) => `ACCT: run ${id} records scratch_discarded_at but its scratch image is still present`,
  ACCT_ORPHAN_IMAGE: (id) => `ACCT: scratch image ${id} has no journal record`,
  ACCT_EVIDENCE_ORPHAN: (id) => `ACCT: evidence image ${id} has no journal record`,
  ACCT_SOURCE_ABSENT: (source) => `ACCT: required accounting source is ABSENT: ${source}`,
  ACCT_UNOBSERVABLE: (detail) => `ACCT: accounting sources could not be read — ${detail}`,

  QUEUE_HELD: (event) => `QUEUE: the sim-queue's last lifecycle event is ${event} — the ticket was not released`,
  QUEUE_UNREADABLE: (detail) => `QUEUE: the sim-queue log could not be read — ${detail}`,
  QUEUE_LOG_ABSENT: (log) => `QUEUE: the sim-queue audit log is ABSENT at ${log} — release cannot be proved`,
  QUEUE_NO_LIFECYCLE: (log) => `QUEUE: the sim-queue audit log at ${log} contains no lifecycle event — release cannot be proved`,

  SHOT_UNDECLARED: (name) => `SHOT: PNG present on disk but declared by no case: ${name} — the seal would throw EVIDENCE_UNKNOWN_NESTED_FILE`,
  SHOT_MISSING: (name) => `SHOT: screenshot declared by a case but ABSENT from disk: ${name}`,
  SHOT_ZERO_DECLARED: (cases) => `SHOT: SUSPICIOUS — ${cases} case payloads and ZERO declared screenshots; capture may have failed silently and an all-clear here would be a green coat`,
  SHOT_UNREADABLE: (detail) => `SHOT: the report-viewer evidence directory could not be read — ${detail}. Failing closed: an unreadable directory is not an empty one`,
  SHOT_SOURCE_ABSENT: (source) => `SHOT: required report-viewer evidence is ABSENT: ${source}`,
  SHOT_RESULT_ABSENT: (name) => `SHOT: case result declared by manifest is ABSENT: ${name}`,

  REPO_EVIDENCE_REQUIRED: () => 'REPO BINDING REFUSED: evidenceDir is required to observe candidate_sha',
  REPO_CANDIDATE_ABSENT: (source) => `REPO BINDING REFUSED: candidate_sha evidence is ABSENT: ${source}`,
  REPO_CANDIDATE_INVALID: (detail) => `REPO BINDING REFUSED: candidate_sha evidence is INVALID — ${detail}`,
  REPO_UNOBSERVABLE: (detail) => `REPO BINDING REFUSED: repository state could not be observed — ${detail}`,
  REPO_DIRTY: (entries) => `REPO BINDING REFUSED: working tree is DIRTY (${entries.join(', ')})`,
  REPO_SHA_MISMATCH: (head, candidate) => `REPO BINDING REFUSED: working tree HEAD ${head} does not match evidence candidate_sha ${candidate}`,
};

// ---------------------------------------------------------------------------
// PURE CHECKS
// ---------------------------------------------------------------------------

// C1. The trap, made observable. os.homedir() honours $HOME; os.userInfo().homedir reads passwd and does
// not. If they disagree we are inside a redirected HOME and EVERY reading below would silently describe
// the wrong installation, so this fails closed and short-circuits rather than reporting a confident clean.
function checkRootResolution({ envHome, passwdHome, installedRootExists, installedRoot, error }) {
  if (envHome !== passwdHome) return [M.ROOT_REDIRECTED(envHome, passwdHome)];
  if (error) return [M.ROOT_UNOBSERVABLE(installedRoot, error)];
  if (!installedRootExists) return [M.ROOT_ABSENT(installedRoot)];
  return [];
}

// C2 + T2. Four distinguished outcomes, and the expectation inverts with phase.
function checkGateLock({ present, ownerPid, ownerAlive, parseError, observationError }, phase = 'post-run') {
  if (observationError) return [M.LOCK_UNOBSERVABLE(observationError)];
  if (phase === 'mid-run' && !present) return [M.LOCK_ABSENT_MIDRUN()];
  if (!present) return [];
  if (parseError) return [M.LOCK_UNREADABLE(parseError)];
  if (phase === 'mid-run' && ownerAlive) return [];
  return ownerAlive ? [M.LOCK_LIVE(ownerPid)] : [M.LOCK_STALE(ownerPid)];
}

// T1 + T2. Counted BY PATH under the installed root. A mount elsewhere — notably the frozen legacy root,
// whose own State mount is EXPECTED — is not under this root and is therefore never counted. Scoping by
// path is the whole mechanism; do not replace it with a name match on "PentacleMobileStorage".
function checkMounts({ installedRoot, mountPoints, error }, phase = 'post-run') {
  if (error) return [M.MOUNT_UNOBSERVABLE(error)];
  const prefix = installedRoot.endsWith('/') ? installedRoot : `${installedRoot}/`;
  const under = mountPoints.filter((p) => p === installedRoot || p.startsWith(prefix));
  const has = (leaf) => under.includes(path.join(installedRoot, leaf));
  const findings = [];
  if (!has('State')) findings.push(M.MOUNT_STATE_ABSENT());
  if (phase === 'mid-run') {
    if (!has('Scratch')) findings.push(M.MOUNT_SCRATCH_MISSING_MIDRUN());
    if (!has('Evidence')) findings.push(M.MOUNT_EVIDENCE_MISSING_MIDRUN());
  } else {
    if (has('Scratch')) findings.push(M.MOUNT_SCRATCH(path.join(installedRoot, 'Scratch')));
    if (has('Evidence')) findings.push(M.MOUNT_EVIDENCE(path.join(installedRoot, 'Evidence')));
  }
  const known = new Set(['State', 'Scratch', 'Evidence'].map((l) => path.join(installedRoot, l)));
  for (const p of under) if (!known.has(p)) findings.push(M.MOUNT_UNEXPECTED(p));
  return findings;
}

// T3 + C3. Cross-run. `runs` is the journal, `scratchImages`/`evidenceImages` are run ids taken from the
// image directories. The counts are the original's check; the per-run correspondence is C3.
function checkAccounting({ runs, evidenceImages, scratchImages, sourceAbsent, error }) {
  if (sourceAbsent) return [M.ACCT_SOURCE_ABSENT(sourceAbsent)];
  if (error) return [M.ACCT_UNOBSERVABLE(error)];
  const findings = [];
  const ids = new Set(runs.map((r) => r.id));
  const discarded = runs.filter((r) => r.scratch_discarded_at);
  if (evidenceImages.length !== runs.length) findings.push(M.ACCT_EVIDENCE_COUNT(evidenceImages.length, runs.length));
  const wantScratch = runs.length - discarded.length;
  if (scratchImages.length !== wantScratch) findings.push(M.ACCT_SCRATCH_COUNT(scratchImages.length, wantScratch, discarded.length));
  const scratchSet = new Set(scratchImages);
  for (const run of runs) {
    const present = scratchSet.has(run.id);
    if (!present && !run.scratch_discarded_at) findings.push(M.ACCT_UNAUTHORISED_ABSENCE(run.id));
    if (present && run.scratch_discarded_at) findings.push(M.ACCT_DISCARDED_PRESENT(run.id));
  }
  for (const id of scratchImages) if (!ids.has(id)) findings.push(M.ACCT_ORPHAN_IMAGE(id));
  for (const id of evidenceImages) if (!ids.has(id)) findings.push(M.ACCT_EVIDENCE_ORPHAN(id));
  return findings;
}

function checkSimQueue({ lastEvent, error, logAbsent, log }) {
  if (error) return [M.QUEUE_UNREADABLE(error)];
  if (logAbsent) return [M.QUEUE_LOG_ABSENT(log)];
  if (lastEvent == null) return [M.QUEUE_NO_LIFECYCLE(log)];
  return ['release', 'reap', 'cancel'].includes(lastEvent) ? [] : [M.QUEUE_HELD(lastEvent)];
}

// T4. Both directions, plus the zero-declared branch. `declared` is the union of artifacts.screenshots
// across case payloads; `onDisk` is the set of .png basenames actually present.
function checkScreenshots({ declared, onDisk, cases, error, sourceAbsent, missingResult }) {
  if (sourceAbsent) return [M.SHOT_SOURCE_ABSENT(sourceAbsent)];
  if (missingResult) return [M.SHOT_RESULT_ABSENT(missingResult)];
  if (error) return [M.SHOT_UNREADABLE(error)];
  const findings = [];
  for (const name of onDisk) if (!declared.includes(name)) findings.push(M.SHOT_UNDECLARED(name));
  for (const name of declared) if (!onDisk.includes(name)) findings.push(M.SHOT_MISSING(name));
  if (cases > 0 && declared.length === 0) findings.push(M.SHOT_ZERO_DECLARED(cases));
  return findings;
}

function checkRepoBinding({ candidateSha, head, dirtyEntries = [], evidenceRequired, candidateAbsent, candidateInvalid, error }) {
  if (evidenceRequired) return [M.REPO_EVIDENCE_REQUIRED()];
  if (candidateAbsent) return [M.REPO_CANDIDATE_ABSENT(candidateAbsent)];
  if (candidateInvalid) return [M.REPO_CANDIDATE_INVALID(candidateInvalid)];
  if (error) return [M.REPO_UNOBSERVABLE(error)];
  const findings = [];
  if (dirtyEntries.length) findings.push(M.REPO_DIRTY(dirtyEntries));
  if (head !== candidateSha) findings.push(M.REPO_SHA_MISMATCH(head, candidateSha));
  return findings;
}

// ---------------------------------------------------------------------------
// READERS — the only I/O. Each returns the shape its check consumes.
// ---------------------------------------------------------------------------

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid positive pid: ${pid}`);
  // EPERM means the process EXISTS and is not ours to signal. Treating it as dead is how a live gate
  // gets reported as debris. ESRCH is the one result that proves absence; every other error is an
  // observation failure and must not be converted into "dead".
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function readRootResolution(installedRoot) {
  const reading = {
    envHome: os.homedir(),
    passwdHome: os.userInfo().homedir,
    installedRoot,
  };
  try {
    reading.installedRootExists = fs.lstatSync(installedRoot).isDirectory();
    if (!reading.installedRootExists) reading.error = 'path exists but is not a directory';
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) reading.installedRootExists = false;
    else reading.error = String(error.message || error);
  }
  return reading;
}

function readGateLock(installedRoot) {
  const target = path.join(installedRoot, 'State', 'gate.lock');
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return { present: true, parseError: 'not a regular non-symlink file' };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { present: false };
    return { observationError: String(error.message || error) };
  }
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    const pid = Number(value.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { present: true, parseError: 'no positive integer pid field' };
    try {
      return { present: true, ownerPid: pid, ownerAlive: processAlive(pid) };
    } catch (error) {
      return { present: true, parseError: `owner liveness probe failed: ${String(error.message || error)}` };
    }
  } catch (error) {
    return { present: true, parseError: String(error.message || error) };
  }
}

// Parses `mount` output into mountpoints. The format is `<device> on <mountpoint> (<opts>)`; taking the
// field between " on " and " (" is what makes this a PATH check rather than a substring match.
function readHostMounts() {
  try {
    const out = execFileSync('/sbin/mount', { encoding: 'utf8' });
    return {
      mountPoints: out.split('\n').map((line) => {
        const m = line.match(/ on (.+?) \(/);
        return m ? m[1] : null;
      }).filter(Boolean),
    };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function readAccounting(installedRoot) {
  const runsDir = path.join(installedRoot, 'State', 'runs');
  const evidenceDir = path.join(installedRoot, 'EvidenceImages');
  const scratchDir = path.join(installedRoot, 'ScratchImages');
  const readRequired = (dir) => {
    try { return { entries: fs.readdirSync(dir).sort() }; } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { sourceAbsent: dir };
      return { error: `${dir}: ${String(error.message || error)}` };
    }
  };
  const sources = [runsDir, evidenceDir, scratchDir].map(readRequired);
  const absent = sources.find((source) => source.sourceAbsent);
  if (absent) return { sourceAbsent: absent.sourceAbsent };
  const unreadable = sources.find((source) => source.error);
  if (unreadable) return { error: unreadable.error };
  try {
    const runs = sources[0].entries.filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')));
    const ids = (entries) => entries.filter((name) => name.endsWith('.sparsebundle'))
      .map((name) => name.replace(/\.sparsebundle$/, ''));
    return { runs, evidenceImages: ids(sources[1].entries), scratchImages: ids(sources[2].entries) };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

// Exact producer precedence from storage-gate.cjs:hostSimQueueRoot(). The fallback deliberately receives
// os.homedir(), not passwd home, because this reader measures the producer; checkRootResolution refuses a
// redirected HOME before the result can be trusted.
function resolveSimQueueRoot(environment = process.env, homedir = os.homedir()) {
  if (environment.SIM_QUEUE_ROOT) return environment.SIM_QUEUE_ROOT;
  if (environment.XDG_DATA_HOME) return path.join(environment.XDG_DATA_HOME, 'sim-queue');
  return path.join(homedir, '.local', 'share', 'sim-queue');
}

function readSimQueue(queueRoot) {
  const log = path.join(queueRoot, 'log.jsonl');
  try {
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    // `command` entries are status probes, not lifecycle events; the original read the last line of any
    // kind, which reports "command" on a queue that is genuinely held.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const event = JSON.parse(lines[i]).event;
      if (['acquire', 'release', 'renew', 'enqueue', 'reap', 'cancel'].includes(event)) return { lastEvent: event, log };
    }
    return { lastEvent: null, log };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { logAbsent: true, log };
    return { error: String(error.message || error), log };
  }
}

function readScreenshots(evidenceDir) {
  const dir = path.join(evidenceDir, 'report-viewer-sim-e2e');
  try {
    const entries = fs.readdirSync(dir);
    const onDisk = entries.filter((n) => n.endsWith('.png'));
    const manifestFile = path.join(dir, 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { sourceAbsent: manifestFile };
      return { error: String(error.message || error) };
    }
    if (!Array.isArray(manifest.cases)) return { error: 'manifest.json has no cases array' };
    const declared = new Set();
    const results = new Set();
    for (const item of manifest.cases) {
      const name = item && item.result;
      if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.json') || results.has(name)) {
        return { error: `manifest carries invalid or duplicate case result: ${name}` };
      }
      results.add(name);
      let payload;
      try { payload = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { missingResult: name };
        return { error: String(error.message || error) };
      }
      for (const shot of (payload.artifacts || {}).screenshots || []) declared.add(shot);
    }
    return { declared: [...declared], onDisk, cases: manifest.cases.length };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { sourceAbsent: dir };
    return { error: String(error.message || error) };
  }
}

function readRepoBinding(repo, evidenceDir) {
  if (!evidenceDir) return { evidenceRequired: true };
  const candidateFile = path.join(evidenceDir, 'native-root.json');
  let candidate;
  try { candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8')); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { candidateAbsent: candidateFile };
    return { candidateInvalid: `${candidateFile}: ${String(error.message || error)}` };
  }
  if (!candidate || !/^[0-9a-f]{40}$/.test(candidate.candidate_sha || '')) {
    return { candidateInvalid: `${candidateFile} has no lowercase 40-hex candidate_sha` };
  }
  try {
    const head = execFileSync('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('/usr/bin/git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], { encoding: 'utf8' });
    if (!/^[0-9a-f]{40}$/.test(head)) return { error: `git returned invalid HEAD for ${repo}` };
    const allDirty = status.split('\n').filter(Boolean).map((line) => line.trim());
    const dirtyEntries = allDirty.slice(0, 5);
    if (allDirty.length > dirtyEntries.length) dirtyEntries.push(`... plus ${allDirty.length - dirtyEntries.length} more`);
    return { candidateSha: candidate.candidate_sha, head, dirtyEntries };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function runHostChecks(readings, phase = 'post-run') {
  const root = checkRootResolution(readings.root);
  // Short-circuit: under a redirected HOME every reading below describes a different installation, so
  // continuing would produce confident findings about the wrong host.
  if (root.length) return [
    { name: 'host-root', findings: root },
    ...['repo-binding', 'gate-lock', 'installed-root-mounts', 'accounting', 'sim-queue', 'screenshots']
      .map((name) => ({ name, findings: [], skipped: true, dependencies: ['host-root'] })),
  ];
  return [
    { name: 'host-root', findings: [] },
    { name: 'repo-binding', findings: checkRepoBinding(readings.repo) },
    { name: 'gate-lock', findings: checkGateLock(readings.lock, phase) },
    { name: 'installed-root-mounts', findings: checkMounts(readings.mounts, phase) },
    { name: 'accounting', findings: checkAccounting(readings.accounting) },
    { name: 'sim-queue', findings: checkSimQueue(readings.queue) },
    { name: 'screenshots', findings: readings.screenshots ? checkScreenshots(readings.screenshots) : [], skipped: !readings.screenshots, ...(!readings.screenshots ? { dependencies: ['screenshot-source'] } : {}) },
  ];
}

function runHostAll(readings, phase = 'post-run') {
  return runHostChecks(readings, phase).flatMap((check) => check.findings);
}

function readHost(installedRoot, {
  queueRoot,
  evidenceDir,
  repo = process.env.PENTACLE_REPO || path.resolve(__dirname, '..'),
  environment = process.env,
  homedir = os.homedir(),
} = {}) {
  const mounts = readHostMounts();
  return {
    root: readRootResolution(installedRoot),
    repo: readRepoBinding(repo, evidenceDir),
    lock: readGateLock(installedRoot),
    mounts: { installedRoot, ...mounts },
    accounting: readAccounting(installedRoot),
    queue: readSimQueue(queueRoot !== undefined ? queueRoot : resolveSimQueueRoot(environment, homedir)),
    screenshots: evidenceDir ? readScreenshots(evidenceDir) : null,
  };
}

// ---------------------------------------------------------------------------
// SELFTEST — section 11.5 in its hard form.
//
// The positive control is NOT built to the checker. It is built to describe a REAL post-run host as
// measured on this machine, and it deliberately CONTAINS the two things a naive implementation trips
// over: the frozen legacy root's own State mount, and unrelated system mounts. A checker that counted
// "PentacleMobileStorage" mounts globally, or expected exactly one storage mount anywhere, FAILS this
// positive control. That is T1 pinned in the direction that catches a regression rather than asserted
// in a comment.
//
// Every negative control asserts its OWN EXACT MESSAGE, never a family prefix. A prefix assertion passes
// when the checker fires for a different reason, which is a control that proves nothing.
// ---------------------------------------------------------------------------
const ROOT = '/Users/example/Library/PentacleMobileStorage';
const LEGACY = '/Users/example/Library/Application Support/PentacleMobileStorage';

function goodHost() {
  return {
    root: { envHome: '/Users/example', passwdHome: '/Users/example', installedRoot: ROOT, installedRootExists: true },
    repo: { candidateSha: 'a'.repeat(40), head: 'a'.repeat(40), dirtyEntries: [] },
    lock: { present: false },
    mounts: {
      installedRoot: ROOT,
      mountPoints: ['/', '/System/Volumes/Data', `${LEGACY}/State`, `${ROOT}/State`],
    },
    accounting: {
      runs: [
        { id: 'aaa', scratch_discarded_at: '2026-07-22T08:00:00Z' },
        { id: 'bbb' },
        { id: 'ccc' },
      ],
      evidenceImages: ['aaa', 'bbb', 'ccc'],
      scratchImages: ['bbb', 'ccc'],
    },
    queue: { lastEvent: 'release' },
    screenshots: { declared: ['one__launch.png', 'two__launch.png'], onDisk: ['one__launch.png', 'two__launch.png'], cases: 2 },
  };
}

function selftestHost() {
  let failures = 0;
  const report = (name, ok, detail) => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
  };

  const clean = runHostAll(goodHost());
  report('POSITIVE CONTROL: a real post-run host (legacy State mount and system mounts PRESENT) yields no findings',
    clean.length === 0, clean.join(' | '));

  const midRun = goodHost();
  midRun.lock = { present: true, ownerPid: 4242, ownerAlive: true };
  midRun.mounts.mountPoints = [...midRun.mounts.mountPoints, `${ROOT}/Scratch`, `${ROOT}/Evidence`];
  const midFindings = runHostAll(midRun, 'mid-run');
  report('T2 DIRECTIONAL: mid-run, lock PRESENT and three mounts is CORRECT and yields no findings',
    midFindings.length === 0, midFindings.join(' | '));

  const midMissing = goodHost();
  midMissing.mounts.mountPoints = midMissing.mounts.mountPoints.filter((p) => p !== `${ROOT}/State`);
  const midMissingFindings = runHostAll(midMissing, 'mid-run');
  report('T2 DIRECTIONAL: mid-run lock ABSENT has its own outcome',
    midMissingFindings.includes(M.LOCK_ABSENT_MIDRUN()), midMissingFindings.join(' | '));
  report('T2 DIRECTIONAL: mid-run Scratch ABSENT has its own outcome',
    midMissingFindings.includes(M.MOUNT_SCRATCH_MISSING_MIDRUN()), midMissingFindings.join(' | '));
  report('T2 DIRECTIONAL: mid-run Evidence ABSENT has its own outcome',
    midMissingFindings.includes(M.MOUNT_EVIDENCE_MISSING_MIDRUN()), midMissingFindings.join(' | '));

  const legacyOnly = goodHost();
  legacyOnly.mounts.mountPoints = ['/', `${LEGACY}/State`, `${LEGACY}/Scratch`, `${ROOT}/State`];
  const legacyFindings = runHostAll(legacyOnly).filter((f) => f.startsWith('MOUNT'));
  report('T1 DIRECTIONAL: a Scratch mount under the FROZEN LEGACY root is not counted against the installed root',
    legacyFindings.length === 0, legacyFindings.join(' | '));

  // C3's JUSTIFICATION, pinned mechanically rather than argued in a comment.
  //
  // An unauthorised absence CANNOT be isolated from every other anomaly: section 11.2's count identity
  // (scratch == runs - discarded) means that hiding a missing image inside a reconciling count REQUIRES a
  // compensating anomaly. So the honest control is DIFFERENTIAL — it shows the port catching a host that
  // the ORIGINAL COUNT-ONLY implementation passes completely. `countOnly` below is the original's logic,
  // reproduced exactly: two count comparisons and nothing else.
  const countOnly = ({ runs, evidenceImages, scratchImages }) => {
    const out = [];
    const disc = runs.filter((r) => r.scratch_discarded_at).length;
    if (evidenceImages.length !== runs.length) out.push('evidence count');
    if (scratchImages.length !== runs.length - disc) out.push('scratch count');
    return out;
  };
  const hidden = goodHost();
  // bbb's image is gone with no record authorising it; aaa's discarded image is still present. Two
  // anomalies, and the counts reconcile exactly: 3 evidence == 3 runs, 2 scratch == 3 - 1 discarded.
  hidden.accounting.scratchImages = ['aaa', 'ccc'];
  const hiddenCountOnly = countOnly(hidden.accounting);
  const hiddenPort = checkAccounting(hidden.accounting);
  report('C3 DIFFERENTIAL: the count-only original finds NOTHING on a host with an unauthorised absence',
    hiddenCountOnly.length === 0, hiddenCountOnly.join(' | '));
  report('C3 DIFFERENTIAL: the port catches the same host, naming the unauthorised absence AND the compensating anomaly',
    hiddenPort.includes(M.ACCT_UNAUTHORISED_ABSENCE('bbb')) && hiddenPort.includes(M.ACCT_DISCARDED_PRESENT('aaa')),
    hiddenPort.join(' | '));

  const simRoot = '/private/tmp/seat20/sim-root';
  const xdgRoot = '/private/tmp/seat20/xdg';
  const fallbackHome = '/Users/example';
  report('H2 PRECEDENCE: SIM_QUEUE_ROOT wins over XDG_DATA_HOME and fallback',
    resolveSimQueueRoot({ SIM_QUEUE_ROOT: simRoot, XDG_DATA_HOME: xdgRoot }, fallbackHome) === simRoot);
  report('H2 PRECEDENCE: XDG_DATA_HOME supplies sim-queue when SIM_QUEUE_ROOT is unset',
    resolveSimQueueRoot({ XDG_DATA_HOME: xdgRoot }, fallbackHome) === path.join(xdgRoot, 'sim-queue'));
  report('H2 PRECEDENCE: fallback matches the gate producer current behaviour',
    resolveSimQueueRoot({}, fallbackHome) === path.join(fallbackHome, '.local', 'share', 'sim-queue'));

  const sidecarRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-certify-sidecar-'));
  try {
    const sidecarDir = path.join(sidecarRoot, 'report-viewer-sim-e2e');
    fs.mkdirSync(sidecarDir);
    fs.writeFileSync(path.join(sidecarDir, 'manifest.json'), JSON.stringify({ cases: [{ result: 'case-a.json' }, { result: 'case-b.json' }] }));
    fs.writeFileSync(path.join(sidecarDir, 'case-a.json'), JSON.stringify({ artifacts: { screenshots: ['a.png'] }, ui_trace_sidecar: 'case-a-trace.json' }));
    fs.writeFileSync(path.join(sidecarDir, 'case-b.json'), JSON.stringify({ artifacts: { screenshots: ['b.png'] } }));
    fs.writeFileSync(path.join(sidecarDir, 'case-a-trace.json'), JSON.stringify({ trace: true }));
    fs.writeFileSync(path.join(sidecarDir, 'a.png'), 'a');
    fs.writeFileSync(path.join(sidecarDir, 'b.png'), 'b');
    const legacyCount = fs.readdirSync(sidecarDir).filter((name) => name.endsWith('.json') && name !== 'manifest.json').length;
    const measured = readScreenshots(sidecarRoot);
    report('C5 SIDECAR DIFFERENTIAL: a .json sidecar inflated the scan count, but manifest result identities exclude it',
      legacyCount === 3 && measured.cases === 2 && checkScreenshots(measured).length === 0,
      `legacy=${legacyCount} manifest-bound=${measured.cases}`);
  } finally {
    fs.rmSync(sidecarRoot, { recursive: true, force: true });
  }

  // Each entry: [name, mutate(host), the EXACT message this control must produce]
  const controls = [
    ['H1 REPO BINDING: working tree SHA differs from evidence candidate_sha', (h) => { h.repo.head = 'b'.repeat(40); }, M.REPO_SHA_MISMATCH('b'.repeat(40), 'a'.repeat(40))],
    ['H1 REPO BINDING: dirty working tree is a distinguished refusal', (h) => { h.repo.dirtyEntries = ['M scripts/storage-certify.cjs']; }, M.REPO_DIRTY(['M scripts/storage-certify.cjs'])],
    ['H1 REPO BINDING: Git observation failure is not a clean match', (h) => { h.repo = { error: 'spawn /usr/bin/git EACCES' }; }, M.REPO_UNOBSERVABLE('spawn /usr/bin/git EACCES')],
    ['H1 REPO BINDING: missing evidenceDir is not a clean match', (h) => { h.repo = { evidenceRequired: true }; }, M.REPO_EVIDENCE_REQUIRED()],
    ['H1 REPO BINDING: absent candidate evidence differs from unreadable evidence', (h) => { h.repo = { candidateAbsent: '/evidence/native-root.json' }; }, M.REPO_CANDIDATE_ABSENT('/evidence/native-root.json')],
    ['H1 REPO BINDING: invalid candidate evidence differs from absent evidence', (h) => { h.repo = { candidateInvalid: 'bad JSON' }; }, M.REPO_CANDIDATE_INVALID('bad JSON')],
    ['LOCK: present with a LIVE owner', (h) => { h.lock = { present: true, ownerPid: 4242, ownerAlive: true }; }, M.LOCK_LIVE(4242)],
    ['LOCK: present with a DEAD owner (distinct from live — R11)', (h) => { h.lock = { present: true, ownerPid: 31720, ownerAlive: false }; }, M.LOCK_STALE(31720)],
    ['LOCK: present and unparseable', (h) => { h.lock = { present: true, parseError: 'no positive integer pid field' }; }, M.LOCK_UNREADABLE('no positive integer pid field')],
    ['LOCK: path observation failure is not absence', (h) => { h.lock = { observationError: 'EACCES' }; }, M.LOCK_UNOBSERVABLE('EACCES')],
    ['MOUNT: Scratch retained after the run', (h) => { h.mounts.mountPoints.push(`${ROOT}/Scratch`); }, M.MOUNT_SCRATCH(`${ROOT}/Scratch`)],
    ['MOUNT: Evidence retained after the run', (h) => { h.mounts.mountPoints.push(`${ROOT}/Evidence`); }, M.MOUNT_EVIDENCE(`${ROOT}/Evidence`)],
    ['MOUNT: the State mount is gone', (h) => { h.mounts.mountPoints = h.mounts.mountPoints.filter((p) => p !== `${ROOT}/State`); }, M.MOUNT_STATE_ABSENT()],
    ['MOUNT: an unexpected mount under the installed root', (h) => { h.mounts.mountPoints.push(`${ROOT}/Sneaky`); }, M.MOUNT_UNEXPECTED(`${ROOT}/Sneaky`)],
    ['MOUNT: enumeration failure is not a clean State-only host', (h) => { h.mounts = { installedRoot: ROOT, error: 'spawn /sbin/mount EACCES' }; }, M.MOUNT_UNOBSERVABLE('spawn /sbin/mount EACCES')],
    ['ACCT: evidence images do not equal journal runs', (h) => { h.accounting.evidenceImages = ['aaa', 'bbb']; }, M.ACCT_EVIDENCE_COUNT(2, 3)],
    ['ACCT: scratch images do not equal runs minus discarded', (h) => { h.accounting.scratchImages = ['bbb']; }, M.ACCT_SCRATCH_COUNT(1, 2, 1)],
    // C3's control, and the one that matters: the COUNTS STILL RECONCILE. bbb's image is gone without
    // authority while aaa's discarded image is still present, so 2 scratch images against 2 expected.
    // The original count-only check passes this host completely.
    ['ACCT: an UNAUTHORISED absence while the counts still reconcile', (h) => { h.accounting.scratchImages = ['aaa', 'ccc']; }, M.ACCT_UNAUTHORISED_ABSENCE('bbb')],
    ['ACCT: a discarded run whose image is still present', (h) => { h.accounting.scratchImages = ['aaa', 'ccc']; }, M.ACCT_DISCARDED_PRESENT('aaa')],
    ['ACCT: a scratch image with no journal record', (h) => { h.accounting.scratchImages = ['bbb', 'ccc', 'zzz']; }, M.ACCT_ORPHAN_IMAGE('zzz')],
    ['ACCT: an evidence image with no journal record', (h) => { h.accounting.evidenceImages = ['aaa', 'bbb', 'ccc', 'zzz']; }, M.ACCT_EVIDENCE_ORPHAN('zzz')],
    ['ACCT: absent source differs from unreadable source', (h) => { h.accounting = { sourceAbsent: `${ROOT}/State/runs` }; }, M.ACCT_SOURCE_ABSENT(`${ROOT}/State/runs`)],
    ['ACCT: unreadable source is not counted as empty', (h) => { h.accounting = { error: 'EACCES' }; }, M.ACCT_UNOBSERVABLE('EACCES')],
    ['QUEUE: the ticket was acquired and never released', (h) => { h.queue = { lastEvent: 'acquire' }; }, M.QUEUE_HELD('acquire')],
    ['QUEUE: unreadable audit log is not a clean release', (h) => { h.queue = { error: 'EACCES' }; }, M.QUEUE_UNREADABLE('EACCES')],
    ['QUEUE: absent audit log is not a clean release', (h) => { h.queue = { logAbsent: true, log: '/queue/log.jsonl' }; }, M.QUEUE_LOG_ABSENT('/queue/log.jsonl')],
    ['QUEUE: a readable log without lifecycle events is not a clean release', (h) => { h.queue = { lastEvent: null, log: '/queue/log.jsonl' }; }, M.QUEUE_NO_LIFECYCLE('/queue/log.jsonl')],
    ['SHOT: a PNG on disk that no case declares', (h) => { h.screenshots.onDisk = [...h.screenshots.onDisk, 'stray.png']; }, M.SHOT_UNDECLARED('stray.png')],
    ['SHOT: a declared screenshot absent from disk', (h) => { h.screenshots.onDisk = ['one__launch.png']; }, M.SHOT_MISSING('two__launch.png')],
    ['SHOT: cases present but ZERO declared screenshots (the green coat)', (h) => { h.screenshots = { declared: [], onDisk: [], cases: 9 }; }, M.SHOT_ZERO_DECLARED(9)],
    ['SHOT: an unreadable evidence directory fails closed rather than passing empty', (h) => { h.screenshots = { error: 'ENOENT' }; }, M.SHOT_UNREADABLE('ENOENT')],
    ['SHOT: an absent evidence directory differs from an unreadable one', (h) => { h.screenshots = { sourceAbsent: '/evidence/report-viewer-sim-e2e' }; }, M.SHOT_SOURCE_ABSENT('/evidence/report-viewer-sim-e2e')],
    ['SHOT: a manifest-declared result absent from disk is named', (h) => { h.screenshots = { missingResult: 'case-a.json' }; }, M.SHOT_RESULT_ABSENT('case-a.json')],
    ['HOSTROOT: a redirected HOME is caught before any reading is trusted', (h) => { h.root.envHome = '/private/tmp/scratch/home'; }, M.ROOT_REDIRECTED('/private/tmp/scratch/home', '/Users/example')],
    ['HOSTROOT: the installed root does not exist', (h) => { h.root.installedRootExists = false; }, M.ROOT_ABSENT(ROOT)],
    ['HOSTROOT: an observation failure is not reported as absent', (h) => { h.root.error = 'EACCES'; }, M.ROOT_UNOBSERVABLE(ROOT, 'EACCES')],
  ];

  for (const [name, mutate, expected] of controls) {
    const host = goodHost();
    const before = JSON.stringify(host);
    mutate(host);
    // Section 11.5: confirm the mutation was ACTUALLY APPLIED. A no-op edit reads as "the guard did not fire".
    if (before === JSON.stringify(host)) { report(name, false, 'MUTATION WAS A NO-OP — result is meaningless'); continue; }
    const found = runHostAll(host);
    report(name, found.includes(expected), found.length ? `got: ${found.join(' | ')}` : 'checker found NOTHING');
  }

  console.log(failures
    ? `\n*** HOST SELFTEST FAILED: ${failures}`
    : '\nHOST SELFTEST OK — every check fails closed on its own message, and a real post-run host still passes.');
  return failures;
}

if (require.main === module) {
  if (process.argv[2] === '--selftest') process.exit(selftestHost() ? 1 : 0);
  const installedRoot = process.argv[2];
  const evidenceDir = process.argv[3];
  const phase = process.argv[4] === '--mid-run' ? 'mid-run' : 'post-run';
  if (!installedRoot || !evidenceDir) {
    console.error('usage: storage-certify-host.cjs <installedRoot> <evidenceDir> [--mid-run] | --selftest');
    console.error('  installedRoot is REQUIRED and absolute: deriving it from HOME is the defect this file exists to avoid.');
    console.error('  evidenceDir is REQUIRED: repo HEAD/cleanliness must be bound to evidence/native-root.json candidate_sha.');
    process.exit(2);
  }
  // T2, carried in the output text as the original did: a human reading this must not mistake a healthy
  // mid-run host for a failure.
  console.log(`=== HOST STATE (${phase})${phase === 'mid-run' ? ' — mid-run, gate.lock PRESENT and three mounts under the installed root is CORRECT' : ''} ===`);
  const readings = readHost(installedRoot, { evidenceDir });
  const checks = runHostChecks(readings, phase);
  for (const check of checks) console.log(`  ${check.skipped ? 'SKIP' : (check.findings.length ? 'FAIL' : 'PASS')} ${check.name}`);
  const findings = checks.flatMap((check) => check.findings);
  console.log(findings.length
    ? findings.map((f) => `  NOT CERTIFIED — ${f}`).join('\n')
    : '  §11.2 accounting, §11.1 host state, §11.3 screenshot admission: ALL PASS');
  process.exit(findings.some((finding) => finding.startsWith('REPO BINDING REFUSED:')) ? 3 : (findings.length ? 1 : 0));
}

module.exports = {
  M,
  goodHost,
  selftestHost,
  checkRootResolution,
  checkGateLock,
  checkMounts,
  checkAccounting,
  checkSimQueue,
  checkScreenshots,
  checkRepoBinding,
  processAlive,
  resolveSimQueueRoot,
  readHost,
  readHostMounts,
  readGateLock,
  readAccounting,
  readSimQueue,
  readScreenshots,
  readRepoBinding,
  runHostChecks,
  runHostAll,
};
