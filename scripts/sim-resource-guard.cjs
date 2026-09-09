const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const CRASH_REPORTER_DOMAIN = 'com.apple.CrashReporter';
const CRASH_REPORTER_KEY = 'DialogType';
const DEFAULTS_BINARY = '/usr/bin/defaults';
const PLUTIL_BINARY = '/usr/bin/plutil';
const PS_BINARY = '/bin/ps';
const SIMULATOR_QUEUE_TTL_SECONDS = 10800;
const TICKET_PATTERN = /^\d+-[A-Za-z0-9_.-]+-\d+$/;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stripOutputTerminator(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function commandResult(command, name, args, environment) {
  const result = command(name, args, { encoding: 'utf8', env: environment });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function requireSuccess(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

// `defaults read` answers status 1 for a key that is genuinely ABSENT and for a key it COULD NOT READ,
// with the same message - so on its own that status can never authorize a delete. Measured: with the
// cfprefs shm map denied, CFPrefs goes volatile and reports a key that IS on disk as missing, and
// `defaults`' plist-PATH form fabricates identically because it routes through cfprefsd too. `plutil`
// reads the backing file directly and does NOT: it returned the true value under both profiles even with
// HOME redirected. So absence is trusted only when the backing file independently agrees. The path is
// resolved through getpwuid (os.userInfo) rather than $HOME, which the container redirects to its scratch.
function crashReporterAbsenceConfirmed(command, environment) {
  const plist = path.join(os.userInfo().homedir, 'Library', 'Preferences', `${CRASH_REPORTER_DOMAIN}.plist`);
  const extracted = commandResult(command, PLUTIL_BINARY, ['-extract', CRASH_REPORTER_KEY, 'raw', '-o', '-', plist], environment);
  if (extracted.status === 0) return false;
  // EXACTLY two failures mean the key really is not there: no such key, or no such file. Any other
  // failure leaves absence unconfirmed, so restore fails closed instead of deleting on an answer we
  // cannot trust.
  return /No value at that key path|no such file/i.test(extracted.stderr);
}

function snapshotCrashReporter(command = spawnSync, environment = process.env) {
  const read = commandResult(command, DEFAULTS_BINARY, ['read', CRASH_REPORTER_DOMAIN, CRASH_REPORTER_KEY], environment);
  if (read.status === 1) return { exists: false, absenceConfirmed: crashReporterAbsenceConfirmed(command, environment) };
  requireSuccess(read, 'CrashReporter DialogType read');
  const readType = requireSuccess(
    commandResult(command, DEFAULTS_BINARY, ['read-type', CRASH_REPORTER_DOMAIN, CRASH_REPORTER_KEY], environment),
    'CrashReporter DialogType type read',
  );
  const match = readType.stdout.trim().match(/^Type is (.+)$/);
  if (!match || match[1] !== 'string') {
    throw new Error(`unsupported CrashReporter DialogType preference type: ${match?.[1] || readType.stdout.trim()}`);
  }
  return { exists: true, absenceConfirmed: false, type: 'string', value: stripOutputTerminator(read.stdout) };
}

function setCrashReporterServer(command = spawnSync, environment = process.env) {
  requireSuccess(
    commandResult(command, DEFAULTS_BINARY, ['write', CRASH_REPORTER_DOMAIN, CRASH_REPORTER_KEY, '-string', 'server'], environment),
    'CrashReporter server mode write',
  );
}

function restoreCrashReporter(snapshot, command = spawnSync, environment = process.env) {
  if (!snapshot.exists && !snapshot.absenceConfirmed) {
    // FAIL CLOSED: an unreadable key is never a key we may remove. Deleting here would destroy the
    // operator's real preference on the strength of an answer measured to be fabricable.
    // Deliberately NOT thrown: the caller's recovery path (see close()) retries restore in an
    // unbounded loop, and an unreadable preference channel is an environment fault no retry can
    // clear, so throwing would wedge the run instead of protecting anything. Leaving DialogType at
    // the `server` this guard wrote is non-destructive and reversible by hand, which a delete is not.
    console.error(`CrashReporter ${CRASH_REPORTER_KEY} restore REFUSED: the pre-run value was unreadable, not absent, so it must not be deleted. ${CRASH_REPORTER_DOMAIN} ${CRASH_REPORTER_KEY} is left as written; restore it by hand if it mattered.`);
    return;
  }
  const args = snapshot.exists
    ? ['write', CRASH_REPORTER_DOMAIN, CRASH_REPORTER_KEY, '-string', snapshot.value]
    : ['delete', CRASH_REPORTER_DOMAIN, CRASH_REPORTER_KEY];
  requireSuccess(commandResult(command, DEFAULTS_BINARY, args, environment), 'CrashReporter DialogType restore');
}

function ownerIsAncestor(ownerPid, processObject, command = spawnSync, environment = process.env) {
  // The ppid walk below needs /bin/ps, which is setuid root and CANNOT be exec'd inside the gate's
  // sandbox - kernel-enforced, not expressible as a profile allowance even at (allow default). So when the
  // gate wrapper spawns us it resolves this OUTSIDE the sandbox and hands the verdict in. That is strictly
  // more authoritative than this walk, because the wrapper IS the process that acquired the ticket and
  // spawned us, rather than something inferring the relationship after the fact.
  //
  // FAIL CLOSED, both directions. A verdict that does not match the pid we were asked about returns false
  // rather than falling through to a walk that would EPERM - and absence of a verdict does NOT mean yes, it
  // means do the walk, which outside the sandbox works and inside the sandbox throws. The point of this
  // check is that an inherited SIM_QUEUE_TICKET is not accepted on presentation alone; softening it into a
  // default-yes on any of these paths would be exactly the antipattern it exists to prevent.
  //
  // Deliberately independent of the ps broker: this needs nothing at runtime, so a broker failure can never
  // silently degrade a security control into a pass.
  const verified = environment.SIM_QUEUE_OWNER_VERIFIED_PID;
  if (verified !== undefined) return /^\d+$/.test(String(verified)) && Number(verified) === Number(ownerPid);
  let candidate = Number(processObject.ppid);
  const visited = new Set();
  for (let depth = 0; depth < 64 && Number.isInteger(candidate) && candidate > 1; depth += 1) {
    if (candidate === ownerPid) return true;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    const result = requireSuccess(
      commandResult(command, PS_BINARY, ['-o', 'ppid=', '-p', String(candidate)], environment),
      'simulator queue owner ancestry check',
    );
    candidate = Number(result.stdout.trim());
  }
  return false;
}

class SimulatorResourceGuard {
  constructor({
    label,
    command = spawnSync,
    environment = process.env,
    processObject = process,
    queueBinary = environment.PENTACLE_SIM_QUEUE_BIN || 'sim-queue',
    recoverRestoreFailure = processObject === process,
    restoreRetryIntervalMs = 1000,
    sleep = sleepSync,
  }) {
    if (!label) throw new Error('simulator resource guard requires a label');
    this.label = label;
    this.command = command;
    this.environment = environment;
    this.processObject = processObject;
    this.queueBinary = queueBinary;
    this.recoverRestoreFailure = recoverRestoreFailure;
    this.restoreRetryIntervalMs = restoreRetryIntervalMs;
    this.sleep = sleep;
    this.ticket = null;
    this.crashSnapshot = null;
    this.signalHandlers = new Map();
    this.previousTicket = undefined;
    this.inherited = false;
    this.closed = false;
  }

  acquire() {
    const inheritedTicket = this.environment.SIM_QUEUE_TICKET;
    if (inheritedTicket) {
      if (!TICKET_PATTERN.test(inheritedTicket)) throw new Error('inherited simulator queue ticket is invalid');
      const status = requireSuccess(
        commandResult(this.command, this.queueBinary, ['status', '--json'], this.environment),
        'inherited simulator queue status',
      );
      let payload;
      try {
        payload = JSON.parse(status.stdout);
      } catch {
        throw new Error('inherited simulator queue status returned invalid JSON');
      }
      const holderPid = Number(payload?.holder?.pid);
      if (payload?.holder?.ticket !== inheritedTicket || !ownerIsAncestor(holderPid, this.processObject, this.command, this.environment)) {
        throw new Error('inherited simulator queue ticket is not the live holder');
      }
      this.ticket = inheritedTicket;
      this.inherited = true;
      return;
    }
    const queueEnvironment = { ...this.environment, SIM_QUEUE_OWNER_PID: String(this.processObject.pid) };
    const result = requireSuccess(
      commandResult(
        this.command,
        this.queueBinary,
        ['acquire', '--label', this.label, '--wait', '--ttl', String(SIMULATOR_QUEUE_TTL_SECONDS), '--owner-pid', String(this.processObject.pid)],
        queueEnvironment,
      ),
      'simulator queue acquire',
    );
    const ticket = result.stdout.trim();
    if (!TICKET_PATTERN.test(ticket)) throw new Error('simulator queue acquire returned an invalid ticket');
    this.ticket = ticket;
    this.previousTicket = this.environment.SIM_QUEUE_TICKET;
    this.environment.SIM_QUEUE_TICKET = ticket;
  }

  installSignalHandlers() {
    for (const signalName of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        try {
          this.close();
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          this.processObject.exitCode = 1;
          return;
        }
        this.processObject.kill(this.processObject.pid, signalName);
      };
      this.signalHandlers.set(signalName, handler);
      this.processObject.on(signalName, handler);
    }
  }

  enter() {
    try {
      this.acquire();
      if (this.inherited) return this.ticket;
      this.crashSnapshot = snapshotCrashReporter(this.command, this.environment);
      setCrashReporterServer(this.command, this.environment);
      this.installSignalHandlers();
    } catch (error) {
      try {
        this.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'simulator resource setup and cleanup failed');
      }
      throw error;
    }
    return this.ticket;
  }

  close() {
    if (this.closed) return;
    this.closed = true;

    if (this.inherited) return;

    if (this.crashSnapshot) {
      let initialRestoreError;
      try {
        restoreCrashReporter(this.crashSnapshot, this.command, this.environment);
      } catch (error) {
        if (!this.recoverRestoreFailure) {
          throw new AggregateError(
            [error],
            `CrashReporter restore failed; simulator queue ticket ${this.ticket} retained. Restore DialogType exactly, then release this ticket manually.`,
          );
        }
        initialRestoreError = error;
        console.error(`CrashReporter restore failed; simulator queue ticket ${this.ticket} remains live while recovery retries.`);
        for (;;) {
          try {
            requireSuccess(
              commandResult(this.command, this.queueBinary, ['renew', '--ticket', this.ticket], this.environment),
              'simulator queue recovery renew',
            );
          } catch {
            // The live owner PID still prevents dead-owner reaping; retry both operations.
          }
          this.sleep(this.restoreRetryIntervalMs);
          try {
            restoreCrashReporter(this.crashSnapshot, this.command, this.environment);
            break;
          } catch {
            // Never release or exit while CrashReporter remains in temporary server mode.
          }
        }
      }
      if (initialRestoreError) this.initialRestoreError = initialRestoreError;
    }
    if (this.ticket) {
      requireSuccess(
        commandResult(this.command, this.queueBinary, ['release', '--ticket', this.ticket], this.environment),
        'simulator queue release',
      );
    }
    if (this.previousTicket === undefined) delete this.environment.SIM_QUEUE_TICKET;
    else this.environment.SIM_QUEUE_TICKET = this.previousTicket;
    for (const [signalName, handler] of this.signalHandlers) {
      this.processObject.removeListener(signalName, handler);
    }
    this.signalHandlers.clear();
    if (this.initialRestoreError) {
      throw new AggregateError(
        [this.initialRestoreError],
        'CrashReporter restore initially failed and recovered; simulator queue was released only after exact restoration.',
      );
    }
  }
}

function withSimulatorResource(callback, options) {
  const environment = options?.environment || process.env;
  if (
    environment.NODE_TEST_CONTEXT === 'child-v8'
    && environment.PENTACLE_GATE_TEST_MODE === '1'
    && environment.PENTACLE_TEST_DISABLE_SIM_RESOURCE_GUARD === '1'
  ) {
    return callback();
  }
  const guard = new SimulatorResourceGuard(options);
  guard.enter();
  let value;
  let primaryError;
  try {
    value = callback();
  } catch (error) {
    primaryError = error;
  }
  try {
    guard.close();
  } catch (cleanupError) {
    if (primaryError) throw new AggregateError([primaryError, cleanupError], 'simulator stage and cleanup failed');
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return value;
}

module.exports = {
  SIMULATOR_QUEUE_TTL_SECONDS,
  CRASH_REPORTER_DOMAIN,
  CRASH_REPORTER_KEY,
  DEFAULTS_BINARY,
  PLUTIL_BINARY,
  PS_BINARY,
  SimulatorResourceGuard,
  restoreCrashReporter,
  setCrashReporterServer,
  snapshotCrashReporter,
  ownerIsAncestor,
  withSimulatorResource,
};
