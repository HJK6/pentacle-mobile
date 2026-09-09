'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IDB_SOCKET_DIR = '/tmp/idb';

// The isolated gate device set. Simulator.app reaping and stray-sim shutdown are confined to
// THIS set so a run on a developer's default set never touches their personal sims/windows.
const PENTACLE_SIMULATOR_DEVICE_SET = path.join(os.homedir(), 'Library', 'Developer', 'PentacleCoreSimulator', 'Devices');

// Reap stale simulator substrate that pollutes the owned-Simulator identity checks and can fail
// the gate closed on prior-run clutter (root cause: days-old idb_companion daemons left the
// report-viewer comments teardown unable to verify its owned Simulator PID). Best-effort — every
// step swallows its own failure into the returned summary; nothing here throws, so provisioning
// can never fail the gate.
//
// Developer safety AND multi-lane safety: every destructive step is
// scoped. idb companion/socket teardown touches ONLY `boundUdid`'s own companion and socket, and is
// skipped outright when no UDID is bound. Killing Simulator.app windows or shutting down booted sims
// is confined to the ISOLATED gate device set (`PentacleCoreSimulator`); on the default set only the
// bound sim's idb companion is touched. `shutdownStrays` additionally requires `boundUdid` and never
// shuts down that sim. Nothing here may disturb a concurrent lane's run.
function reapStaleSimulatorSubstrate(options = {}) {
  const {
    command = spawnSync,
    environment = process.env,
    deviceSetRoot = null,
    boundUdid = null,
    shutdownStrays = false,
  } = options;
  const summary = {
    idb_companion_reaped: 0,
    idb_sockets_removed: 0,
    idb_registry_healed: false,
    simulator_app_reaped: 0,
    sims_shutdown: [],
    notes: [],
  };
  if (String(environment.PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP || '') === '1') {
    summary.notes.push('skipped: PENTACLE_TEST_DISABLE_SIM_SUBSTRATE_REAP=1');
    return summary;
  }
  const opts = { encoding: 'utf8' };
  // idb companion hygiene: a killed OR crashed idb_companion leaves a stale
  // /tmp/idb/<udid>_companion.sock that `idb ui` connects to -> [Errno 61] Connection refused, so
  // every `idb ui describe-all` in the report-viewer scenarios fails identically (the true root of
  // the horizontal-scroll "missing accessible scroll viewport" flake). Kill the stale companion,
  // remove its now-stale socket, then `idb list-targets` to prune idb's dead-companion registry so
  // the next `idb ui` auto-spawns a fresh working companion. Killing the process WITHOUT clearing its
  // socket is actively harmful, which is why those two always move together.
  //
  // SCOPED to `boundUdid` (2026-07-26). This step runs BEFORE the device-set gate below, so the
  // operator-safe early-return never covered it: reaping EVERY idb_companion on the host and deleting
  // EVERY /tmp/idb/*.sock drops a CONCURRENT lane's in-flight idb session, and no amount of UDID
  // pinning on either side prevents that because the teardown precedes UDID binding. The old
  // "always safe, companions respawn" rationale holds for a single-lane host only: the companion
  // respawns, but the other lane's running gate does not recover. Observed on hosta against an example
  // mobile release run that drives its whole UI through idb.
  //
  // With no boundUdid the teardown is SKIPPED, never widened -- destroying other lanes' sessions is
  // not the safer default. Registry healing stays unconditional: `idb list-targets` is read-only.
  const fsModule = options.fsModule || fs;
  if (String(environment.PENTACLE_TEST_DISABLE_IDB_COMPANION_REAP || '') === '1') {
    summary.notes.push('skipped idb hygiene: PENTACLE_TEST_DISABLE_IDB_COMPANION_REAP=1');
  } else {
    if (boundUdid) {
      summary.idb_companion_reaped = reapOwnIdbCompanion(command, boundUdid, opts);
      summary.idb_sockets_removed = removeOwnIdbSocket(fsModule, boundUdid);
    } else {
      summary.notes.push('skipped idb companion/socket teardown: no boundUdid to scope it to');
    }
    summary.idb_registry_healed = command('idb', ['list-targets'], opts).status === 0;
  }
  const onIsolatedSet = Boolean(deviceSetRoot) && path.resolve(deviceSetRoot) === PENTACLE_SIMULATOR_DEVICE_SET;
  if (!onIsolatedSet) {
    summary.notes.push('default device set: reaped idb_companion only (operator-safe)');
    return summary;
  }
  summary.simulator_app_reaped = reapProcessesByName(command, 'Simulator', opts);
  if (shutdownStrays && boundUdid) {
    summary.sims_shutdown = shutdownStrayBootedSims(command, deviceSetRoot, boundUdid, opts);
  }
  return summary;
}

// Remove the bound sim's OWN stale idb companion socket. Once that companion is reaped its
// /tmp/idb/<udid>_companion.sock is dead; leaving it makes `idb ui` fail with Connection refused
// instead of spawning a fresh companion. Other UDIDs' sockets belong to other lanes and are never
// touched. The directory is listed rather than removed blind so the returned count is honest about
// whether a socket was actually there. Best-effort; returns 1 if removed, else 0.
function removeOwnIdbSocket(fsModule, udid) {
  const expected = `${udid}_companion.sock`;
  let entries;
  try {
    entries = fsModule.readdirSync(IDB_SOCKET_DIR);
  } catch {
    return 0;
  }
  if (!entries.includes(expected)) return 0;
  try {
    fsModule.rmSync(path.join(IDB_SOCKET_DIR, expected), { force: true });
    return 1;
  } catch {
    return 0;
  }
}

// TERM only the idb_companion serving `udid`. A companion runs as
// `idb_companion --udid <UDID> --grpc-domain-sock /tmp/idb/<UDID>_companion.sock --only simulator`,
// so the UDID is on its command line. `pgrep -f <udid>` alone would also match unrelated processes
// that merely mention the UDID (a shell, an editor, this gate's own wrapper), and `pgrep -x
// idb_companion` alone cannot tell whose companion it is -- so the target set is the INTERSECTION:
// an exact-name idb_companion process that also carries this UDID. Returns the count signalled.
function reapOwnIdbCompanion(command, udid, opts) {
  const named = command('pgrep', ['-x', 'idb_companion'], opts);
  if (named.status !== 0) return 0;
  const namePids = new Set(pidsFrom(named.stdout));
  if (namePids.size === 0) return 0;
  const matched = command('pgrep', ['-f', udid], opts);
  if (matched.status !== 0) return 0;
  let reaped = 0;
  for (const pid of pidsFrom(matched.stdout)) {
    if (!namePids.has(pid)) continue;
    if (command('kill', ['-TERM', pid], opts).status === 0) reaped += 1;
  }
  return reaped;
}

function pidsFrom(stdout) {
  return String(stdout || '').trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid));
}

// pgrep -x <name> then TERM each PID. status 1 = none running; any other nonzero = probe failed and
// is skipped (best-effort). Returns the count actually signalled.
function reapProcessesByName(command, name, opts) {
  const found = command('pgrep', ['-x', name], opts);
  if (found.status !== 0) return 0;
  const pids = pidsFrom(found.stdout);
  let reaped = 0;
  for (const pid of pids) {
    if (command('kill', ['-TERM', pid], opts).status === 0) reaped += 1;
  }
  return reaped;
}

// Shut down every BOOTED sim in the gate device set EXCEPT the bound one, so stray prior-run sims
// cannot pollute the substrate. Called only inside the sim-queue-held region, so no concurrent
// lead's gate is holding a sim here.
function shutdownStrayBootedSims(command, deviceSetRoot, boundUdid, opts) {
  const listing = command('xcrun', ['simctl', '--set', deviceSetRoot, 'list', 'devices', 'booted', '-j'], opts);
  if (listing.status !== 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(String(listing.stdout || '{}'));
  } catch {
    return [];
  }
  const shutdown = [];
  for (const devices of Object.values(parsed.devices || {})) {
    for (const device of devices || []) {
      const udid = String(device?.udid || '');
      if (!udid || udid === boundUdid || String(device?.state || '') !== 'Booted') continue;
      if (command('xcrun', ['simctl', '--set', deviceSetRoot, 'shutdown', udid], opts).status === 0) {
        shutdown.push(udid);
      }
    }
  }
  return shutdown;
}

module.exports = { reapStaleSimulatorSubstrate, PENTACLE_SIMULATOR_DEVICE_SET };
