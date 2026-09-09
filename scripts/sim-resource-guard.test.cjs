const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DEFAULTS_BINARY, PLUTIL_BINARY, PS_BINARY, restoreCrashReporter, snapshotCrashReporter, withSimulatorResource } = require('./sim-resource-guard.cjs');

class FakeProcess extends EventEmitter {
  constructor(pid = 4242, ppid = 1) {
    super();
    this.pid = pid;
    this.ppid = ppid;
    this.signals = [];
    this.exitCode = undefined;
  }

  kill(pid, signalName) {
    this.signals.push([pid, signalName]);
  }
}

function fakeHarness({ initialPreference = { exists: true, value: 'crashreport' } } = {}) {
  const events = [];
  const state = {
    preference: initialPreference.exists ? initialPreference.value : undefined,
    tickets: [],
    ticketOwners: {},
  };
  let nextTicket = 1;
  const command = (name, args, options) => {
    events.push([name, [...args], options?.env?.SIM_QUEUE_OWNER_PID]);
    if (name === 'sim-queue' && args[0] === 'acquire') {
      const ticket = `${String(nextTicket++).padStart(12, '0')}-mobile-${args.at(-1)}`;
      state.tickets.push(ticket);
      state.ticketOwners[ticket] = Number(args.at(-1));
      return { status: 0, stdout: `${ticket}\n`, stderr: '' };
    }
    if (name === 'sim-queue' && args[0] === 'release') {
      state.tickets = state.tickets.filter((ticket) => ticket !== args[2]);
      delete state.ticketOwners[args[2]];
      return { status: 0, stdout: `${args[2]}\n`, stderr: '' };
    }
    if (name === 'sim-queue' && args[0] === 'status') {
      return {
        status: 0,
        stdout: `${JSON.stringify({ holder: state.tickets[0] ? { ticket: state.tickets[0], pid: state.ticketOwners[state.tickets[0]] } : null, queue: [] })}\n`,
        stderr: '',
      };
    }
    if (name === DEFAULTS_BINARY && args[0] === 'read') {
      return state.preference === undefined
        ? { status: 1, stdout: '', stderr: 'missing' }
        : { status: 0, stdout: `${state.preference}\n`, stderr: '' };
    }
    if (name === DEFAULTS_BINARY && args[0] === 'read-type') return { status: 0, stdout: 'Type is string\n', stderr: '' };
    // The backing file agrees with the domain read - the HEALTHY case. Divergence between these two
    // is exactly what distinguishes "genuinely absent" from "could not read", and the tests below
    // inject it deliberately.
    if (name === PLUTIL_BINARY) {
      return state.preference === undefined
        ? { status: 1, stdout: '', stderr: `${args.at(-1)}: Could not extract value, error: No value at that key path or invalid key path: DialogType` }
        : { status: 0, stdout: `${state.preference}\n`, stderr: '' };
    }
    if (name === DEFAULTS_BINARY && args[0] === 'write') {
      state.preference = args.at(-1);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (name === DEFAULTS_BINARY && args[0] === 'delete') {
      state.preference = undefined;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (name === PS_BINARY) return { status: 0, stdout: '1\n', stderr: '' };
    throw new Error(`unexpected command: ${name} ${args.join(' ')}`);
  };
  return { command, events, state };
}

function runGuard(callback, harness, processObject = new FakeProcess(), environment = {}, options = {}) {
  return withSimulatorResource(callback, {
    label: 'pentacle-mobile-test',
    command: harness.command,
    environment,
    processObject,
    queueBinary: 'sim-queue',
    ...options,
  });
}

test('guard passes the long-lived controller PID and exports its live ticket', () => {
  const harness = fakeHarness();
  const processObject = new FakeProcess(7331);
  const environment = {};
  runGuard(() => {
    assert.equal(harness.state.preference, 'server');
    assert.match(environment.SIM_QUEUE_TICKET, /^\d+-mobile-7331$/);
    assert.equal(harness.state.tickets.length, 1);
  }, harness, processObject, environment);
  const acquire = harness.events.find(([name, args]) => name === 'sim-queue' && args[0] === 'acquire');
  assert.deepEqual(acquire[1].slice(-2), ['--owner-pid', '7331']);
  assert.equal(acquire[2], '7331');
  assert.equal(environment.SIM_QUEUE_TICKET, undefined);
});

for (const [name, initialPreference] of [
  ['custom preference', { exists: true, value: '  crashreport  ' }],
  ['absent preference', { exists: false }],
]) {
  test(`guard restores ${name} before queue release on success`, () => {
    const harness = fakeHarness({ initialPreference });
    runGuard(() => assert.equal(harness.state.preference, 'server'), harness);
    assert.equal(harness.state.preference, initialPreference.exists ? initialPreference.value : undefined);
    const cleanup = harness.events.filter(([command, args]) =>
      (command === DEFAULTS_BINARY && ['write', 'delete'].includes(args[0])) || (command === 'sim-queue' && args[0] === 'release')
    );
    const releaseIndex = cleanup.findIndex(([command]) => command === 'sim-queue');
    const restoreIndex = cleanup.findLastIndex(([command, args]) => command === DEFAULTS_BINARY && (args.at(-1) !== 'server' || args[0] === 'delete'));
    assert.ok(restoreIndex >= 0 && restoreIndex < releaseIndex);
  });
}

test('guard restores preference then releases when the simulator stage fails', () => {
  const harness = fakeHarness();
  assert.throws(() => runGuard(() => { throw new Error('stage failed'); }, harness), /stage failed/);
  assert.equal(harness.state.preference, 'crashreport');
  assert.deepEqual(harness.state.tickets, []);
  const tail = harness.events.slice(-2).map(([name, args]) => [name, args[0]]);
  assert.deepEqual(tail, [[DEFAULTS_BINARY, 'write'], ['sim-queue', 'release']]);
});

test('signal cleanup restores preference before release and re-raises the signal', () => {
  const harness = fakeHarness({ initialPreference: { exists: false } });
  const processObject = new FakeProcess(8118);
  runGuard(() => processObject.emit('SIGTERM'), harness, processObject);
  assert.equal(harness.state.preference, undefined);
  assert.deepEqual(harness.state.tickets, []);
  assert.deepEqual(processObject.signals, [[8118, 'SIGTERM']]);
  const deleteIndex = harness.events.findIndex(([name, args]) => name === DEFAULTS_BINARY && args[0] === 'delete');
  const releaseIndex = harness.events.findIndex(([name, args]) => name === 'sim-queue' && args[0] === 'release');
  assert.ok(deleteIndex < releaseIndex);
});

test('two-holder handoff cannot observe the prior holder server preference', () => {
  const harness = fakeHarness();
  runGuard(() => assert.equal(harness.state.preference, 'server'), harness, new FakeProcess(1001));
  const firstRelease = harness.events.findIndex(([name, args]) => name === 'sim-queue' && args[0] === 'release');
  const secondReadStart = harness.events.length;
  runGuard(() => assert.equal(harness.state.preference, 'server'), harness, new FakeProcess(1002));
  const firstRestore = harness.events.findLastIndex(
    ([name, args], index) => index < firstRelease && name === DEFAULTS_BINARY && args[0] === 'write' && args.at(-1) === 'crashreport',
  );
  const secondRead = harness.events.findIndex(
    ([name, args], index) => index >= secondReadStart && name === DEFAULTS_BINARY && args[0] === 'read',
  );
  assert.ok(firstRestore < firstRelease && firstRelease < secondRead);
});

test('nested simulator child verifies and reuses the inherited holder without deadlock or double cleanup', () => {
  const harness = fakeHarness();
  const environment = {};
  runGuard(() => {
    const outerTicket = environment.SIM_QUEUE_TICKET;
    runGuard(() => {
      assert.equal(environment.SIM_QUEUE_TICKET, outerTicket);
      assert.equal(harness.state.preference, 'server');
      assert.deepEqual(harness.state.tickets, [outerTicket]);
    }, harness, new FakeProcess(2002, 2001), environment);
  }, harness, new FakeProcess(2001), environment);
  const queueCommands = harness.events.filter(([name]) => name === 'sim-queue').map(([, args]) => args[0]);
  assert.deepEqual(queueCommands, ['acquire', 'status', 'release']);
  const preferenceWrites = harness.events.filter(([name, args]) => name === DEFAULTS_BINARY && args[0] === 'write');
  assert.deepEqual(preferenceWrites.map(([, args]) => args.at(-1)), ['server', 'crashreport']);
  assert.deepEqual(harness.state.tickets, []);
});

test('nested simulator child fails closed for a forged or stale inherited ticket', () => {
  const harness = fakeHarness();
  const environment = { SIM_QUEUE_TICKET: '000000000999-forged-9000' };
  assert.throws(
    () => runGuard(() => {}, harness, new FakeProcess(9000), environment),
    /not the live holder/,
  );
  assert.equal(harness.events.some(([name]) => name === DEFAULTS_BINARY), false);
  assert.equal(harness.events.some(([name, args]) => name === 'sim-queue' && args[0] === 'release'), false);
});

test('nested simulator child rejects a real holder owned by an unrelated live process', () => {
  const harness = fakeHarness();
  const ticket = '000000000001-unrelated-3001';
  harness.state.tickets.push(ticket);
  harness.state.ticketOwners[ticket] = 3001;
  const environment = { SIM_QUEUE_TICKET: ticket };
  assert.throws(
    () => runGuard(() => {}, harness, new FakeProcess(4001, 4000), environment),
    /not the live holder/,
  );
  assert.equal(harness.events.some(([name]) => name === DEFAULTS_BINARY), false);
  assert.equal(harness.events.some(([name, args]) => name === 'sim-queue' && args[0] === 'release'), false);
});

test('nested simulator child accepts the outer holder through shell and npm ancestors', () => {
  const harness = fakeHarness({ initialPreference: { exists: true, value: 'server' } });
  const ticket = '000000000001-outer-6001';
  harness.state.tickets.push(ticket);
  harness.state.ticketOwners[ticket] = 6001;
  const parents = new Map([[6003, 6002], [6002, 6001]]);
  const baseCommand = harness.command;
  harness.command = (name, args, options) => {
    if (name === PS_BINARY) return { status: 0, stdout: `${parents.get(Number(args.at(-1))) || 1}\n`, stderr: '' };
    return baseCommand(name, args, options);
  };
  const environment = { SIM_QUEUE_TICKET: ticket };
  let ran = false;
  runGuard(() => { ran = true; }, harness, new FakeProcess(6004, 6003), environment);
  assert.equal(ran, true);
  assert.equal(harness.events.some(([name, args]) => name === 'sim-queue' && ['acquire', 'release'].includes(args[0])), false);
});

// `defaults read` cannot distinguish "genuinely absent" from "could not read" - it answers status 1 with
// the SAME message for both, and that single value used to mean DELETE. These tests drive the divergence
// through an injected command; nothing here reads or writes a real preference.
function preferenceProbe({ domainRead, fileRead }) {
  const issued = [];
  const command = (name, args) => {
    issued.push([name, ...args]);
    if (name === DEFAULTS_BINARY && args[0] === 'read') return domainRead;
    if (name === PLUTIL_BINARY) return fileRead;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { command, issued };
}

const ABSENT_DOMAIN_READ = { status: 1, stdout: '', stderr: 'The domain/default pair of (com.apple.CrashReporter, DialogType) does not exist' };
const deletes = (issued) => issued.some(([name, verb]) => name === DEFAULTS_BINARY && verb === 'delete');

test('an unreadable CrashReporter preference is never deleted, and a genuinely absent one still is', () => {
  // NEGATIVE: the domain read says "does not exist" while the backing FILE still holds the value -
  // exactly what a denied cfprefs shm map produces. Absence is unconfirmed, so restore must refuse.
  const fabricated = preferenceProbe({ domainRead: ABSENT_DOMAIN_READ, fileRead: { status: 0, stdout: 'crashreport\n', stderr: '' } });
  const unreadable = snapshotCrashReporter(fabricated.command, {});
  assert.deepEqual(unreadable, { exists: false, absenceConfirmed: false });
  restoreCrashReporter(unreadable, fabricated.command, {});
  assert.equal(deletes(fabricated.issued), false);

  // POSITIVE CONTROL, so the assertion above cannot pass vacuously: when the file agrees the key is
  // gone, absence IS confirmed and the delete still happens.
  const genuine = preferenceProbe({ domainRead: ABSENT_DOMAIN_READ, fileRead: { status: 1, stdout: '', stderr: 'Could not extract value, error: No value at that key path or invalid key path: DialogType' } });
  const absent = snapshotCrashReporter(genuine.command, {});
  assert.deepEqual(absent, { exists: false, absenceConfirmed: true });
  restoreCrashReporter(absent, genuine.command, {});
  assert.deepEqual(genuine.issued.at(-1), [DEFAULTS_BINARY, 'delete', 'com.apple.CrashReporter', 'DialogType']);

  // A missing plist file is genuine absence too.
  const noFile = preferenceProbe({ domainRead: ABSENT_DOMAIN_READ, fileRead: { status: 1, stdout: '', stderr: 'com.apple.CrashReporter.plist: (The file could not be opened because there is no such file.)' } });
  assert.equal(snapshotCrashReporter(noFile.command, {}).absenceConfirmed, true);

  // ...but ANY other plutil failure leaves absence unconfirmed and therefore undeletable.
  const unclassified = preferenceProbe({ domainRead: ABSENT_DOMAIN_READ, fileRead: { status: 1, stdout: '', stderr: 'plutil: unexpected failure' } });
  const undetermined = snapshotCrashReporter(unclassified.command, {});
  assert.equal(undetermined.absenceConfirmed, false);
  restoreCrashReporter(undetermined, unclassified.command, {});
  assert.equal(deletes(unclassified.issued), false);
});

test('CrashReporter restore failure retains the ticket and recovery environment', () => {
  const harness = fakeHarness();
  const environment = {};
  const baseCommand = harness.command;
  harness.command = (name, args, options) => {
    if (name === DEFAULTS_BINARY && args[0] === 'write' && args.at(-1) === 'crashreport') {
      harness.events.push([name, [...args], options?.env?.SIM_QUEUE_OWNER_PID]);
      return { status: 1, stdout: '', stderr: 'restore denied' };
    }
    return baseCommand(name, args, options);
  };
  assert.throws(
    () => runGuard(() => {}, harness, new FakeProcess(5001), environment),
    /ticket .* retained/,
  );
  assert.deepEqual(harness.state.tickets, [environment.SIM_QUEUE_TICKET]);
  assert.equal(harness.state.preference, 'server');
  assert.equal(harness.events.some(([name, args]) => name === 'sim-queue' && args[0] === 'release'), false);
});

test('a transient restore failure renews ownership and releases only after recovery', () => {
  const harness = fakeHarness();
  const baseCommand = harness.command;
  let restoreAttempts = 0;
  harness.command = (name, args, options) => {
    if (name === DEFAULTS_BINARY && args[0] === 'write' && args.at(-1) === 'crashreport' && restoreAttempts++ === 0) {
      harness.events.push([name, [...args], options?.env?.SIM_QUEUE_OWNER_PID]);
      return { status: 1, stdout: '', stderr: 'transient restore failure' };
    }
    if (name === 'sim-queue' && args[0] === 'renew') {
      harness.events.push([name, [...args], options?.env?.SIM_QUEUE_OWNER_PID]);
      return { status: 0, stdout: '', stderr: '' };
    }
    return baseCommand(name, args, options);
  };
  assert.throws(
    () => runGuard(
      () => {},
      harness,
      new FakeProcess(5101),
      {},
      { recoverRestoreFailure: true, restoreRetryIntervalMs: 0, sleep: () => {} },
    ),
    /initially failed and recovered/,
  );
  assert.equal(restoreAttempts, 2);
  assert.equal(harness.state.preference, 'crashreport');
  assert.deepEqual(harness.state.tickets, []);
  const renewIndex = harness.events.findIndex(([name, args]) => name === 'sim-queue' && args[0] === 'renew');
  const releaseIndex = harness.events.findIndex(([name, args]) => name === 'sim-queue' && args[0] === 'release');
  assert.ok(renewIndex >= 0 && renewIndex < releaseIndex);
});

test('a real controller stays live and blocks handoff while CrashReporter restore keeps failing', async (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-restore-recovery-'));
  const marker = path.join(tempRoot, 'restore-failed');
  const queueBinary = process.env.PENTACLE_SIM_QUEUE_BIN || 'sim-queue';
  const childSource = `
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const { DEFAULTS_BINARY, withSimulatorResource } = require(${JSON.stringify(path.join(__dirname, 'sim-resource-guard.cjs'))});
    const command = (name, args, options) => {
      if (name !== DEFAULTS_BINARY) return spawnSync(name, args, options);
      if (args[0] === 'read') return { status: 0, stdout: 'crashreport\\n', stderr: '' };
      if (args[0] === 'read-type') return { status: 0, stdout: 'Type is string\\n', stderr: '' };
      if (args[0] === 'write' && args.at(-1) === 'server') return { status: 0, stdout: '', stderr: '' };
      fs.writeFileSync(process.env.RESTORE_FAILURE_MARKER, 'failed');
      return { status: 1, stdout: '', stderr: 'restore denied' };
    };
    withSimulatorResource(() => {}, { label: 'recovery-child', command, restoreRetryIntervalMs: 20 });
  `;
  const environment = {
    ...process.env,
    SIM_QUEUE_ROOT: tempRoot,
    PENTACLE_SIM_QUEUE_BIN: queueBinary,
    RESTORE_FAILURE_MARKER: marker,
  };
  const child = spawn(process.execPath, ['-e', childSource], { env: environment, stdio: 'ignore' });
  let contenderTicket;
  context.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (contenderTicket) {
      spawnSync(queueBinary, ['status', '--json'], { env: environment });
      spawnSync(queueBinary, ['release', '--ticket', contenderTicket], { env: environment });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(marker), true);
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(child.exitCode, null);

  const contender = spawnSync(
    queueBinary,
    ['acquire', '--label', 'contender', '--nowait', '--owner-pid', String(process.pid)],
    { env: environment, encoding: 'utf8' },
  );
  assert.equal(contender.status, 0, contender.stderr);
  contenderTicket = JSON.parse(contender.stdout).ticket;
  const status = spawnSync(queueBinary, ['status', '--json'], { env: environment, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.holder.pid, child.pid);
  assert.equal(payload.queue.some((item) => item.ticket === contenderTicket), true);
});

test('test-only bypass requires the explicit test-mode pair', () => {
  const harness = fakeHarness();
  const environment = { PENTACLE_TEST_DISABLE_SIM_RESOURCE_GUARD: '1' };
  runGuard(() => {}, harness, new FakeProcess(), environment);
  assert.ok(harness.events.some(([name]) => name === 'sim-queue'));

  const nonRunnerHarness = fakeHarness();
  const nonRunnerEnvironment = {
    PENTACLE_GATE_TEST_MODE: '1',
    PENTACLE_TEST_DISABLE_SIM_RESOURCE_GUARD: '1',
  };
  runGuard(() => {}, nonRunnerHarness, new FakeProcess(), nonRunnerEnvironment);
  assert.ok(nonRunnerHarness.events.some(([name]) => name === 'sim-queue'));

  const bypassHarness = fakeHarness();
  const bypassEnvironment = {
    NODE_TEST_CONTEXT: 'child-v8',
    PENTACLE_GATE_TEST_MODE: '1',
    PENTACLE_TEST_DISABLE_SIM_RESOURCE_GUARD: '1',
  };
  withSimulatorResource(() => {}, {
    label: 'bypass',
    command: bypassHarness.command,
    environment: bypassEnvironment,
    processObject: new FakeProcess(),
  });
  assert.deepEqual(bypassHarness.events, []);
});

test('both simulator entrypoints use the shared guard', () => {
  for (const file of ['full-gate.cjs', 'report-viewer-sim-e2e.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(source, /withSimulatorResource/);
  }
});
