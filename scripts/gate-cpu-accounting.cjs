'use strict';

function parseCensus(text) {
  const rows = String(text).trim().split('\n').map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !fields.slice(0, 3).every((v) => /^\d+$/.test(v))) throw new Error('CPU_CENSUS_MALFORMED');
    const match = fields[8].match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error('CPU_TIME_MALFORMED');
    return { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields.slice(3, 8).join(' '),
      cpuSeconds: Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4]), command: fields.slice(9).join(' ') };
  });
  if (new Set(rows.map((row) => row.pid)).size !== rows.length) throw new Error('CPU_CENSUS_DUPLICATE_PID');
  return rows;
}

function isAncestor(rows, ancestor, pid) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const seen = new Set();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === ancestor) return true;
    seen.add(pid); pid = byPid.get(pid)?.ppid;
  }
  return false;
}

function accountCpu({ before, after, ownerPid, probePid, simulatorPid, cpuCount, intervalMs, idleRatio }) {
  if (![ownerPid, probePid, simulatorPid].every((v) => Number.isInteger(v) && v > 1)
      || !(cpuCount > 0) || !(intervalMs > 0) || !Number.isFinite(idleRatio) || idleRatio < 0 || idleRatio > 1) throw new Error('CPU_OWNERSHIP_INVALID');
  if (!isAncestor(before, ownerPid, probePid) || !isAncestor(after, ownerPid, probePid)) throw new Error('CPU_OWNER_NOT_ANCESTOR');
  const old = new Map(before.map((row) => [row.pid, row]));
  const current = new Map(after.map((row) => [row.pid, row]));
  for (const rows of [old, current]) if (rows.get(simulatorPid)?.command.split('/').at(-1) !== 'launchd_sim') throw new Error('CPU_SIMULATOR_IDENTITY_INVALID');
  for (const rows of [old, current]) for (const pid of [ownerPid, probePid, simulatorPid]) if (!Number.isFinite(rows.get(pid)?.cpuSeconds)) throw new Error(`CPU_ROOT_COUNTER_UNAVAILABLE:${pid}:${rows.get(pid)?.cpuProbeErrno}`);
  if (old.get(simulatorPid).start !== current.get(simulatorPid).start || old.get(ownerPid)?.start !== current.get(ownerPid)?.start) throw new Error('CPU_ROOT_IDENTITY_CHANGED');
  const owned = new Set([ownerPid, simulatorPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of [...before, ...after]) {
      const sameProcess = !old.has(row.pid) || !current.has(row.pid) || old.get(row.pid).start === current.get(row.pid).start;
      if (sameProcess && owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
  }
  let ownedCpuSeconds = 0;
  const ownedGroups = new Set();
  for (const row of after) if (owned.has(row.pid)) {
    const previous = old.get(row.pid);
    if (row.cpuProbeErrno === 3) continue; // Exited after ps: omitting its CPU is conservative.
    if (!Number.isFinite(row.cpuSeconds) || (previous && !Number.isFinite(previous.cpuSeconds) && previous.cpuProbeErrno !== 3)) throw new Error(`CPU_COUNTER_UNAVAILABLE:${row.pid}:${row.cpuProbeErrno}:${previous?.cpuProbeErrno}`);
    const delta = row.cpuSeconds - (previous?.start === row.start ? previous.cpuSeconds : 0);
    if (!Number.isFinite(delta) || delta < 0) throw new Error('CPU_COUNTER_REGRESSED');
    ownedCpuSeconds += delta; ownedGroups.add(row.pgid);
  }
  // Missing exited processes undercount owned CPU, so this remains conservative. Never subtract foreign work.
  const ownedCpuFraction = Math.min(1 - idleRatio, ownedCpuSeconds / (cpuCount * intervalMs / 1000));
  return { scope: 'external', verified: true, owner_pid: ownerPid, simulator_launchd_pid: simulatorPid,
    interval_ms: intervalMs, owned_cpu_seconds: ownedCpuSeconds, owned_pids: [...owned].sort((a, b) => a - b),
    owned_groups: [...ownedGroups].sort((a, b) => a - b), ownedCpuFraction, externalIdleRatio: idleRatio + ownedCpuFraction };
}

module.exports = { parseCensus, isAncestor, accountCpu };
