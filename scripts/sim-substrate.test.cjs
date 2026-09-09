'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { reapStaleSimulatorSubstrate, PENTACLE_SIMULATOR_DEVICE_SET } = require('./sim-substrate.cjs');

const DEFAULT_DEVICE_SET = path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
const BOUND = 'BBBB1111-2222-4333-8444-555566667777';
const OTHER = 'AAAA1111-2222-3333-4444-555566667777';

// Fake fs so tests never touch the real /tmp/idb. `entries` are the socket dir listing.
function fakeFs(entries = []) {
  const removed = [];
  return {
    removed,
    readdirSync: () => entries,
    rmSync: (target) => removed.push(target),
  };
}

// Fake host: `companions` are exact-name idb_companion pids; `udidMatches` are the pids whose full
// command line mentions the bound UDID (companions AND unrelated noise like shells).
function fakeHost({ companions = [], udidMatches = [], simulators = [], booted = null, calls = [] } = {}) {
  const command = (name, args) => {
    calls.push([name, args]);
    if (name === 'pgrep' && args[0] === '-x' && args[1] === 'idb_companion') {
      return companions.length ? { status: 0, stdout: `${companions.join('\n')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (name === 'pgrep' && args[0] === '-x' && args[1] === 'Simulator') {
      return simulators.length ? { status: 0, stdout: `${simulators.join('\n')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (name === 'pgrep' && args[0] === '-f') {
      return udidMatches.length ? { status: 0, stdout: `${udidMatches.join('\n')}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (name === 'xcrun' && args.includes('list') && booted) {
      return { status: 0, stdout: JSON.stringify(booted), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { command, calls };
}

const killed = (calls) => calls.filter(([name]) => name === 'kill').map(([, args]) => args[1]);

test('default set: idb teardown is scoped to the bound UDID and heals the registry', () => {
  const { command, calls } = fakeHost({ companions: ['111'], udidMatches: ['111'] });
  const fs = fakeFs([`${BOUND}_companion.sock`, 'notes.txt']);
  const summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: DEFAULT_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: fs });
  assert.equal(summary.idb_companion_reaped, 1);
  assert.equal(summary.idb_sockets_removed, 1);
  assert.equal(summary.idb_registry_healed, true);
  assert.deepEqual(killed(calls), ['111']);
  assert.deepEqual(fs.removed, [`/tmp/idb/${BOUND}_companion.sock`]);
  // default set stays operator-safe: no Simulator.app reap, no sim shutdown
  assert.equal(summary.simulator_app_reaped, 0);
  assert.deepEqual(summary.sims_shutdown, []);
  assert.equal(calls.some(([name, args]) => name === 'pgrep' && args[1] === 'Simulator'), false);
  assert.equal(calls.some(([name]) => name === 'xcrun'), false);
});

// THE REGRESSION THIS FIX EXISTS FOR. Another lane's companion (222) and socket must survive, and a
// non-companion process that merely mentions our UDID (999, e.g. a shell) must not be signalled.
test('another lane\'s companion and socket are never touched, and UDID-mentioning non-companions are not killed', () => {
  const { command, calls } = fakeHost({ companions: ['111', '222'], udidMatches: ['111', '999'] });
  const fs = fakeFs([`${BOUND}_companion.sock`, `${OTHER}_companion.sock`]);
  const summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: DEFAULT_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: fs });
  assert.equal(summary.idb_companion_reaped, 1);
  assert.deepEqual(killed(calls), ['111']);              // intersection only: not 222, not 999
  assert.equal(summary.idb_sockets_removed, 1);
  assert.deepEqual(fs.removed, [`/tmp/idb/${BOUND}_companion.sock`]);
  assert.equal(fs.removed.some((entry) => entry.includes(OTHER)), false);
});

test('no boundUdid: teardown is skipped entirely rather than widened, but the registry still heals', () => {
  const { command, calls } = fakeHost({ companions: ['111', '222'], udidMatches: ['111'] });
  const fs = fakeFs([`${BOUND}_companion.sock`, `${OTHER}_companion.sock`]);
  const summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: DEFAULT_DEVICE_SET, boundUdid: null, shutdownStrays: true, fsModule: fs });
  assert.equal(summary.idb_companion_reaped, 0);
  assert.equal(summary.idb_sockets_removed, 0);
  assert.deepEqual(killed(calls), []);
  assert.deepEqual(fs.removed, []);
  assert.equal(calls.some(([name, args]) => name === 'pgrep' && args[1] === 'idb_companion'), false);
  assert.equal(summary.idb_registry_healed, true);       // read-only, safe without a UDID
  assert.equal(summary.notes.some((note) => note.includes('no boundUdid')), true);
});

test('a socket that is not there is not reported as removed', () => {
  const { command } = fakeHost({ companions: ['111'], udidMatches: ['111'] });
  const fs = fakeFs([`${OTHER}_companion.sock`]);
  const summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: DEFAULT_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: fs });
  assert.equal(summary.idb_sockets_removed, 0);
  assert.deepEqual(fs.removed, []);
});

test('isolated gate set: also reaps Simulator.app + shuts down stray booted sims except the bound one', () => {
  const booted = { devices: { runtime: [{ udid: BOUND, state: 'Booted' }, { udid: 'STRAY-1', state: 'Booted' }, { udid: 'STRAY-2', state: 'Booted' }, { udid: 'OFF', state: 'Shutdown' }] } };
  const { command } = fakeHost({ companions: ['900'], udidMatches: ['900'], simulators: ['901', '902'], booted });
  const summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: PENTACLE_SIMULATOR_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: fakeFs() });
  assert.equal(summary.idb_companion_reaped, 1);
  assert.equal(summary.idb_registry_healed, true);
  assert.equal(summary.simulator_app_reaped, 2);
  assert.deepEqual([...summary.sims_shutdown].sort(), ['STRAY-1', 'STRAY-2']);
});

test('shutdownStrays:false reaps processes/sockets on the isolated set but shuts down no sims', () => {
  const { command, calls } = fakeHost({ companions: ['900'], udidMatches: ['900'], simulators: ['901'] });
  const summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: PENTACLE_SIMULATOR_DEVICE_SET, boundUdid: BOUND, shutdownStrays: false, fsModule: fakeFs() });
  assert.equal(summary.idb_companion_reaped, 1);
  assert.equal(summary.simulator_app_reaped, 1);
  assert.deepEqual(summary.sims_shutdown, []);
  assert.equal(calls.some(([name, args]) => name === 'xcrun' && args.includes('shutdown')), false);
});

test('is a total no-op under PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP', () => {
  const { command, calls } = fakeHost({ companions: ['111'], udidMatches: ['111'] });
  const fs = fakeFs([`${BOUND}_companion.sock`]);
  const summary = reapStaleSimulatorSubstrate({ command, environment: { PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP: '1' }, deviceSetRoot: PENTACLE_SIMULATOR_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: fs });
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.removed, []);
  assert.equal(summary.idb_companion_reaped, 0);
  assert.equal(summary.idb_registry_healed, false);
});

test('narrow idb suppression retains isolated-set Simulator and stray-sim cleanup', () => {
  const booted = { devices: { runtime: [{ udid: BOUND, state: 'Booted' }, { udid: 'STRAY', state: 'Booted' }] } };
  const { command, calls } = fakeHost({ companions: ['111'], udidMatches: ['111'], simulators: ['901'], booted });
  const fs = fakeFs([`${BOUND}_companion.sock`]);
  const summary = reapStaleSimulatorSubstrate({ command, environment: { PENTACLE_TEST_DISABLE_IDB_COMPANION_REAP: '1' }, deviceSetRoot: PENTACLE_SIMULATOR_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: fs });
  assert.equal(summary.idb_companion_reaped, 0);
  assert.equal(summary.idb_sockets_removed, 0);
  assert.equal(summary.idb_registry_healed, false);
  assert.deepEqual(fs.removed, []);
  assert.equal(calls.some(([name, args]) => name === 'pgrep' && args[1] === 'idb_companion'), false);
  assert.equal(calls.some(([name]) => name === 'idb'), false);
  assert.equal(summary.simulator_app_reaped, 1);
  assert.deepEqual(summary.sims_shutdown, ['STRAY']);
});

test('best-effort: probe, socket-listing, heal, and sim-listing failures never throw', () => {
  const command = (name, args) => {
    if (name === 'pgrep') return { status: 2, stdout: '', stderr: 'boom' };
    if (name === 'idb' && args[0] === 'list-targets') return { status: 7, stdout: '', stderr: 'idb down' };
    if (name === 'xcrun' && args.includes('list')) return { status: 0, stdout: 'not-json', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const throwingFs = { readdirSync: () => { throw new Error('no dir'); }, rmSync: () => { throw new Error('nope'); } };
  let summary;
  assert.doesNotThrow(() => {
    summary = reapStaleSimulatorSubstrate({ command, environment: {}, deviceSetRoot: PENTACLE_SIMULATOR_DEVICE_SET, boundUdid: BOUND, shutdownStrays: true, fsModule: throwingFs });
  });
  assert.equal(summary.idb_companion_reaped, 0);
  assert.equal(summary.idb_sockets_removed, 0);
  assert.equal(summary.idb_registry_healed, false);   // list-targets returned nonzero
  assert.equal(summary.simulator_app_reaped, 0);
  assert.deepEqual(summary.sims_shutdown, []);
});
