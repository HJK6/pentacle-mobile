'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { runOwnedSync, probeSignalCapability } = require('./owned-process.cjs');
const { parseCensus, accountCpu } = require('./gate-cpu-accounting.cjs');
const GiB = 1024 ** 3;
// The accepted executable snapshot is removed before final evidence sealing.
// Freeze the consumer's expected identity now; probes still hash the file they run.
const producerIdentity = Object.freeze((() => {
  try { return { sha256: crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./gate-process-cpu.py'))).digest('hex') }; }
  catch (error) { return { error: error.code || error.message }; }
})());
const POLICY = Object.freeze({ minFreeBytes: 60 * GiB, maxLoadPerCpu: 2, minIdleRatio: 0.5, minAbsoluteIdleRatio: 0.05, ownedBootSettleMs: 120000,
  maxDiskTransfersPerSecond: 10000, maxSyncBytes: GiB, maxSyncOperations: 2000, maxBootedSimulators: 3 });

function evaluateSnapshot(measurements) {
  const reasons = [];
  if (!measurements || typeof measurements !== 'object' || Array.isArray(measurements)) {
    reasons.push('measurements missing or malformed'); measurements = {};
  }
  const accounting = measurements.cpuAccounting;
  let effectiveIdleRatio = measurements.idleRatio;
  if (accounting !== undefined && accounting !== null) {
    if (accounting.scope !== 'external' || accounting.verified !== true || !Number.isFinite(accounting.ownedCpuFraction)
        || accounting.ownedCpuFraction < 0 || accounting.ownedCpuFraction > 1 || !Number.isFinite(accounting.externalIdleRatio)
        || accounting.externalIdleRatio < 0 || accounting.externalIdleRatio > 1
        || Math.abs(accounting.externalIdleRatio - Math.min(1, measurements.idleRatio + accounting.ownedCpuFraction)) > 0.000001) reasons.push('owned CPU accounting unavailable or inconsistent');
    else effectiveIdleRatio = accounting.externalIdleRatio;
  }
  const signals = measurements.signalCapability;
  if (!signals || signals.ok !== true || signals.visibility_errno !== 0 || signals.signal_errno !== 0 || signals.cleanup_verified !== true) reasons.push(`owned process-group signal capability refused: ${JSON.stringify(signals ?? null)}`);
  const number = (key, min = 0) => {
    if (!Number.isFinite(measurements[key]) || measurements[key] < min) reasons.push(`${key} unavailable: ${measurements[key]}`);
    return measurements[key];
  };
  for (const key of ['cpuCount', 'load1', 'idleRatio', 'freeBytes', 'memoryPressure', 'diskTransfersPerSecond', 'bootedSimulators']) number(key);
  if (!(measurements.cpuCount >= 1) || measurements.idleRatio > 1) reasons.push('invalid CPU sample');
  if (measurements.freeBytes < POLICY.minFreeBytes) reasons.push(`freeBytes=${measurements.freeBytes} < ${POLICY.minFreeBytes}`);
  if (measurements.idleRatio < POLICY.minAbsoluteIdleRatio) reasons.push(`absolute idleRatio=${measurements.idleRatio} < ${POLICY.minAbsoluteIdleRatio}`);
  if (measurements.load1 > POLICY.maxLoadPerCpu * measurements.cpuCount && effectiveIdleRatio < POLICY.minIdleRatio)
    reasons.push(`load1=${measurements.load1}, cpuCount=${measurements.cpuCount}, idleRatio=${measurements.idleRatio}, externalIdleRatio=${effectiveIdleRatio}`);
  if (measurements.memoryPressure !== 1) reasons.push(`memoryPressure=${measurements.memoryPressure}, required=1`);
  if (measurements.diskTransfersPerSecond > POLICY.maxDiskTransfersPerSecond) reasons.push(`diskTransfersPerSecond=${measurements.diskTransfersPerSecond} > ${POLICY.maxDiskTransfersPerSecond}`);
  if (measurements.bootedSimulators > POLICY.maxBootedSimulators) reasons.push(`bootedSimulators=${measurements.bootedSimulators} > ${POLICY.maxBootedSimulators}`);
  if (!Array.isArray(measurements.competingBuildPids)) reasons.push('build census unavailable');
  else if (measurements.competingBuildPids.length) reasons.push(`competingBuildPids=${measurements.competingBuildPids.join(',')}`);
  if (!Array.isArray(measurements.sync) || !measurements.sync.length) reasons.push('Syncthing census unavailable');
  else for (const folder of measurements.sync) {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)) { reasons.push('Syncthing sample malformed'); continue; }
    const values = [folder.needBytes, folder.needFiles, folder.needDeletes];
    if (!values.every((value) => Number.isFinite(value) && value >= 0) || typeof folder.state !== 'string') reasons.push('Syncthing sample malformed');
    else if (folder.needBytes > POLICY.maxSyncBytes || folder.needFiles + folder.needDeletes > POLICY.maxSyncOperations)
      reasons.push(`Syncthing state=${folder.state} needBytes=${folder.needBytes} operations=${folder.needFiles + folder.needDeletes}`);
  }
  if (!Array.isArray(measurements.probeErrors)) reasons.push('probe outcomes unavailable');
  else reasons.push(...measurements.probeErrors);
  return { schema: 1, ok: reasons.length === 0, measured_at: new Date().toISOString(), policy: POLICY, reasons, measurements };
}

function admissionReceiptErrors(receipt, { external = false } = {}) {
  const errors = [];
  if (!receipt || receipt.schema !== 1) errors.push('admission receipt schema must be 1');
  if (receipt?.ok !== true || !Array.isArray(receipt?.reasons) || receipt.reasons.length) errors.push('admission receipt did not pass');
  if (typeof receipt?.measured_at !== 'string' || !Number.isFinite(Date.parse(receipt.measured_at))) errors.push('admission receipt timestamp missing or malformed');
  const policy = receipt?.policy;
  if (!policy || Object.keys(policy).length !== Object.keys(POLICY).length
      || Object.entries(POLICY).some(([key, value]) => policy[key] !== value)) errors.push('admission policy mismatch');
  // Re-run the actual writer's checks; a claimed ok flag cannot replace required measurements.
  errors.push(...evaluateSnapshot(receipt?.measurements).reasons);
  const accounting = receipt?.measurements?.cpuAccounting;
  if (external && (accounting?.scope !== 'external' || accounting?.verified !== true)) errors.push('verified external CPU accounting required');
  return errors;
}

function cpuTicks() {
  const cpus = os.cpus();
  return { count: cpus.length, idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0) };
}

function getJson(route, apiKey) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: 8384, path: route, headers: { 'X-API-Key': apiKey } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) request.destroy(new Error('Syncthing response oversized')); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Syncthing HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Syncthing response malformed')); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('Syncthing timeout')));
    request.on('error', reject);
  });
}

async function collectSnapshot(ownedContext = null) {
  const probeErrors = []; const commands = [];
  const probe = (label, action) => { try { return action(); } catch (error) { probeErrors.push(`${label}: ${error.code || error.message}`); return null; } };
  const command = (binary, args, timeout = 5000, options = {}) => {
    const result = runOwnedSync(binary, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, ...options });
    commands.push({ binary, status: result.status, ownership: result.ownership });
    if (result.error || result.status !== 0) throw result.error || new Error(`${path.basename(binary)} exit ${result.status}`);
    return result.stdout;
  };
  const realHome = os.userInfo().homedir;
  let simulatorPid = null;
  if (ownedContext) simulatorPid = probe('owned simulator identity', () => {
    const pid = Number(command('/usr/bin/xcrun', ['simctl', '--set', ownedContext.deviceSetRoot, 'spawn', ownedContext.udid, 'launchctl', 'managerpid'], 10000).trim());
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid simulator manager PID');
    return pid;
  });
  const census = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-cpu-census-'));
    try {
      const input = path.join(root, 'pids.json');
      fs.writeFileSync(input, JSON.stringify(parseCensus(command('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,time=,comm=']))));
      return JSON.parse(command('python3', [require.resolve('./gate-process-cpu.py'), input]));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  const intervalStarted = performance.now();
  const initialCpu = cpuTicks();
  const processBefore = ownedContext ? probe('owned CPU before', census) : null;
  const before = processBefore?.cpuTicks || initialCpu;
  const io = probe('disk I/O', () => command('/usr/sbin/iostat', ['-d', '-w', '1', '-c', '2']));
  const processAfter = ownedContext ? probe('owned CPU after', census) : null;
  const after = processAfter?.cpuTicks || cpuTicks();
  const intervalMs = processBefore && processAfter ? processAfter.monotonicMs - processBefore.monotonicMs : performance.now() - intervalStarted;
  const total = after.total - before.total;
  const diskTransfersPerSecond = probe('disk I/O parse', () => {
    const rows = String(io).trim().split('\n').filter((line) => /^\s*\d/.test(line));
    if (rows.length < 2) throw new Error('second interval missing');
    const fields = rows.at(-1).trim().split(/\s+/).map(Number);
    if (!fields.length || fields.length % 3 || !fields.every(Number.isFinite)) throw new Error('invalid interval');
    return fields.filter((_, index) => index % 3 === 1).reduce((a, b) => a + b, 0);
  });
  const idleRatio = total > 0 ? (after.idle - before.idle) / total : null;
  let cpuAccounting = null;
  if (ownedContext) cpuAccounting = probe('owned CPU attribution', () => ({
    ...accountCpu({ before: processBefore?.rows, after: processAfter?.rows, ownerPid: ownedContext.ownerPid, probePid: process.pid,
      simulatorPid, cpuCount: after.count, intervalMs, idleRatio }),
    simulator_udid: ownedContext.udid, device_set_root: ownedContext.deviceSetRoot,
  }));
  if (ownedContext && !cpuAccounting) cpuAccounting = { scope: 'external', verified: false };
  const freeBytes = probe('disk capacity', () => { const stat = fs.statfsSync(realHome); return Number(stat.bavail) * Number(stat.bsize); });
  const memoryPressure = probe('memory pressure', () => Number(command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim()));
  const bootedSimulators = probe('simulator census', () => {
    const data = JSON.parse(command('/usr/bin/xcrun', ['simctl', '--set', path.join(realHome, 'Library/Developer/CoreSimulator/Devices'), 'list', 'devices', 'available', '--json'], 10000));
    if (!data.devices || typeof data.devices !== 'object') throw new Error('devices missing');
    return Object.values(data.devices).flat().filter((device) => device.state === 'Booted').length;
  });
  const competingBuildPids = probe('build census', () => command('ps', ['-axo', 'pid=,comm=']).trim().split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) throw new Error('process row malformed');
    return path.basename(match[2]) === 'xcodebuild' ? [Number(match[1])] : [];
  }));
  let sync = null;
  try {
    const config = fs.readFileSync(path.join(realHome, 'Library/Application Support/Syncthing/config.xml'), 'utf8');
    const apiKey = config.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
    const folders = [...config.matchAll(/<folder\s[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
    if (!apiKey || !folders.length) throw new Error('Syncthing configuration unavailable');
    sync = await Promise.all(folders.map(async (id) => {
      const state = await getJson(`/rest/db/status?folder=${encodeURIComponent(id)}`, apiKey);
      return { id, state: state.state, needBytes: state.needBytes, needFiles: state.needFiles, needDeletes: state.needDeletes };
    }));
  } catch (error) { probeErrors.push(`Syncthing: ${error.code || error.message}`); }
  let signalCapability = null;
  try { signalCapability = await probeSignalCapability(); }
  catch (error) { probeErrors.push(`owned process-group signals: ${error.message}`); }
  const rawCpu = ownedContext ? probe('raw CPU producer identity', () => ({ before: processBefore, after: processAfter, probe_pid: process.pid,
    producer_sha256: crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./gate-process-cpu.py'))).digest('hex') })) : null;
  return { cpuCount: after.count, load1: os.loadavg()[0], idleRatio, cpuAccounting,
    rawCpu, rawDiskIo: io,
    freeBytes, memoryPressure, diskTransfersPerSecond, bootedSimulators, competingBuildPids, sync, signalCapability, probeErrors, commands };
}

function ownedArgs(context) {
  return context ? ['--owned-simulator', context.deviceSetRoot, context.udid, '--owner-pid', String(context.ownerPid), ...(context.settleBoot ? ['--settle-owned-boot', '--owned-boot-start-ms', String(context.bootStartedMs), ...(context.samplesFile ? ['--samples-file', context.samplesFile] : [])] : [])] : [];
}
function openPreparationSamples(file, { maxBytes = 32 * 1024 ** 2 } = {}) {
  maxBytes = Math.min(maxBytes, 32 * 1024 ** 2);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('PREPARATION_SAMPLE_BOUND_INVALID');
  const fd = fs.openSync(file, 'wx', 0o600); const hash = crypto.createHash('sha256');
  let bytes = 0; let samples = 0; let descriptor;
  return {
    write: (sample) => {
      if (descriptor) throw new Error('PREPARATION_SAMPLE_WRITER_CLOSED');
      if (samples >= Math.ceil(POLICY.ownedBootSettleMs / 10000) + 1) throw new Error('PREPARATION_SAMPLE_COUNT_LIMIT');
      const line = Buffer.from(`${JSON.stringify({ schema: 1, index: samples + 1, elapsed_ms: sample.elapsed_ms, receipt: sample.receipt })}\n`);
      if (bytes + line.length > maxBytes) throw new Error(`PREPARATION_SAMPLE_BYTE_LIMIT:${bytes + line.length}>${maxBytes}`);
      fs.writeFileSync(fd, line); fs.fsyncSync(fd); hash.update(line); bytes += line.length; samples += 1;
    },
    close: () => {
      if (!descriptor) {
        try { descriptor = { schema: 1, file: path.basename(file), bytes, samples, sha256: hash.digest('hex') }; }
        finally { fs.closeSync(fd); }
      }
      return descriptor;
    },
  };
}

function settleAdmission(probe, { now = () => Number(process.hrtime.bigint()) / 1e6, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), budgetMs = POLICY.ownedBootSettleMs, bootStartedMs, onSample = () => {} } = {}) {
  const started = bootStartedMs; const samples = []; let result; let recovery = 0; let recoverySince;
  const streaks = new Map(); const intervalMs = 10000; const sustainedSamples = 3;
  budgetMs = Math.min(budgetMs, POLICY.ownedBootSettleMs);
  const finish = (status, extraReasons = [], sustained = []) => ({ ...result,
    ok: status === 'ready', reasons: [...(result?.reasons || []), ...extraReasons],
    settling: { budget_ms: budgetMs, boot_started_monotonic_ms: started, elapsed_ms: now() - started,
      sample_interval_ms: intervalMs, required_recovery_samples: 2, recovery_samples: recovery,
      required_sustained_samples: sustainedSamples, sustained_conditions: sustained,
      window_basis: 'verified-owned-boot', load_attribution: 'unproven', status, samples } });
  if (!Number.isFinite(started) || started < 0 || started > now() || !Number.isFinite(budgetMs) || budgetMs <= 0)
    return finish('refused', ['owned boot monotonic anchor unavailable or invalid']);
  for (;;) {
    const remaining = budgetMs - (now() - started);
    if (remaining <= 0) break;
    const probeStarted = now();
    result = probe(remaining);
    const sampledElapsed = now() - started;
    onSample({ elapsed_ms: sampledElapsed, receipt: result });
    const accounting = result?.measurements?.cpuAccounting;
    if (accounting?.scope !== 'external' || accounting.verified !== true)
      result = { ...result, ok: false, reasons: [...(result?.reasons || []), 'verified owned simulator CPU accounting unavailable'] };
    samples.push({ elapsed_ms: sampledElapsed, ok: result.ok, reasons: result.reasons, idleRatio: result.measurements?.idleRatio,
      externalIdleRatio: result.measurements?.cpuAccounting?.externalIdleRatio, memoryPressure: result.measurements?.memoryPressure,
      freeBytes: result.measurements?.freeBytes, sync: result.measurements?.sync,
      diskTransfersPerSecond: result.measurements?.diskTransfersPerSecond,
      within_first_boot_10s: sampledElapsed <= 10000 });
    if (now() - started > budgetMs) break;
    // Timing grants a bounded observation window, never ownership attribution or weaker ceilings.
    const conditions = new Set(); const immediate = [];
    for (const reason of result.reasons || []) {
      const condition = typeof reason === 'string' && /^(absolute idleRatio|load1|diskTransfersPerSecond)=/.exec(reason)?.[1];
      if (condition) conditions.add(condition); else immediate.push(reason);
    }
    if (immediate.length || !Array.isArray(result.reasons) || (!result.ok && !conditions.size)) return finish('refused');
    for (const key of streaks.keys()) if (!conditions.has(key)) streaks.delete(key);
    for (const key of conditions) {
      const previous = streaks.get(key) || { count: 0, since: sampledElapsed };
      streaks.set(key, { ...previous, count: previous.count + 1 });
    }
    if (result.ok && !conditions.size) {
      if (!recovery) recoverySince = sampledElapsed;
      recovery += 1;
    } else { recovery = 0; recoverySince = undefined; }
    if (recovery >= 2 && sampledElapsed - recoverySince >= intervalMs) return finish('ready');
    const sustained = [...streaks].filter(([, value]) => value.count >= sustainedSamples && sampledElapsed - value.since >= intervalMs * (sustainedSamples - 1)).map(([key]) => key);
    if (sustained.length) return finish('sustained', [], sustained);
    if (now() - started >= budgetMs) break;
    sleep(Math.min(Math.max(0, intervalMs - (now() - probeStarted)), budgetMs - (now() - started)));
  }
  return finish('deadline', ['owned boot settling deadline exceeded']);
}
function preparationSampleErrors(receipt, root, { bootStartedMs } = {}) {
  const errors = []; const settling = receipt?.settling; const descriptor = settling?.raw_samples;
  const expectedFile = 'host-health-start.json.samples.jsonl';
  if (!descriptor || descriptor.schema !== 1 || descriptor.file !== expectedFile) errors.push('raw sample descriptor missing or malformed');
  if (settling?.budget_ms !== POLICY.ownedBootSettleMs || !Number.isFinite(settling?.boot_started_monotonic_ms)
      || (bootStartedMs !== undefined && settling.boot_started_monotonic_ms !== bootStartedMs)) errors.push('raw sample boot deadline binding');
  let raw;
  try {
    const file = path.join(root, expectedFile); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) throw new Error('file type or byte bound');
    raw = fs.readFileSync(file);
  } catch (error) { return [...errors, `raw sample file unavailable: ${error.code || error.message}`]; }
  if (descriptor?.bytes !== raw.length) errors.push('raw sample byte count mismatch');
  if (descriptor?.sha256 !== crypto.createHash('sha256').update(raw).digest('hex')) errors.push('raw sample digest mismatch');
  const lines = raw.toString('utf8').split('\n');
  if (lines.pop() !== '') errors.push('raw sample trailing record incomplete');
  const rows = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { errors.push(`raw sample ${index + 1} malformed JSON`); return null; }
  });
  if (rows.length !== descriptor?.samples || rows.length !== settling?.samples?.length
      || rows.length < 2 || rows.length > Math.ceil(POLICY.ownedBootSettleMs / 10000) + 1) errors.push('raw sample count mismatch');
  const producerHash = producerIdentity.sha256;
  if (!producerHash) errors.push(`raw sample producer identity unavailable: ${producerIdentity.error}`);
  rows.forEach((row, index) => {
    if (!Number.isFinite(row?.elapsed_ms) || row.elapsed_ms < 0 || row.elapsed_ms > POLICY.ownedBootSettleMs
        || (index > 0 && row.elapsed_ms <= rows[index - 1]?.elapsed_ms)) errors.push(`raw sample ${index + 1} timestamp invalid`);
    const sample = row?.receipt; const measurements = sample?.measurements; const summary = settling?.samples?.[index];
    if (row?.schema !== 1 || row?.index !== index + 1 || !summary || row.elapsed_ms !== summary.elapsed_ms
        || sample?.ok !== summary.ok || JSON.stringify(sample?.reasons) !== JSON.stringify(summary.reasons)
        || ['idleRatio', 'memoryPressure', 'freeBytes', 'diskTransfersPerSecond', 'sync'].some(key => JSON.stringify(measurements?.[key]) !== JSON.stringify(summary?.[key]))) errors.push(`raw sample ${index + 1} binding mismatch`);
    const evaluated = evaluateSnapshot(measurements);
    if (sample?.schema !== 1 || sample?.ok !== evaluated.ok || JSON.stringify(sample?.reasons) !== JSON.stringify(evaluated.reasons)
        || JSON.stringify(sample?.policy) !== JSON.stringify(POLICY)) errors.push(`raw sample ${index + 1} producer policy mismatch`);
    try {
      const cpu = measurements.rawCpu; const before = cpu.before; const after = cpu.after;
      const intervalMs = after.monotonicMs - before.monotonicMs; const total = after.cpuTicks.total - before.cpuTicks.total;
      if (cpu.producer_sha256 !== producerHash || !(total > 0) || !(intervalMs > 0)) throw new Error('producer or interval');
      const idleRatio = Math.max(0, Math.min(1, (after.cpuTicks.idle - before.cpuTicks.idle) / total));
      const accounting = measurements.cpuAccounting;
      const calculated = accountCpu({ before: before.rows, after: after.rows, ownerPid: accounting.owner_pid,
        probePid: cpu.probe_pid, simulatorPid: accounting.simulator_launchd_pid, cpuCount: after.cpuTicks.count, intervalMs, idleRatio });
      if (idleRatio !== measurements.idleRatio || Object.entries(calculated).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(accounting[key]))) throw new Error('counter mismatch');
    } catch (error) { errors.push(`raw sample ${index + 1} CPU accounting invalid: ${error.message}`); }
  });
  if (rows.length && JSON.stringify(rows.at(-1)?.receipt?.measurements) !== JSON.stringify(receipt?.measurements)) errors.push('raw final measurement binding mismatch');
  if (rows.every(row => row?.receipt && Number.isFinite(row.elapsed_ms))) {
    let clock = 0; let index = 0;
    const replay = settleAdmission(() => {
      const row = rows[index++];
      if (!row) { clock = POLICY.ownedBootSettleMs + 1; return rows.at(-1)?.receipt; }
      clock = row.elapsed_ms; return row.receipt;
    }, { bootStartedMs: 0, now: () => clock, sleep: () => {} });
    if (!replay.ok || replay.settling.status !== settling?.status || index !== rows.length) errors.push('raw samples do not reproduce admission');
    if (['sample_interval_ms', 'required_recovery_samples', 'recovery_samples', 'required_sustained_samples', 'sustained_conditions', 'window_basis', 'load_attribution']
      .some(key => JSON.stringify(replay.settling[key]) !== JSON.stringify(settling?.[key]))) errors.push('raw settling outcome metadata mismatch');
  }
  return errors;
}

function requireHostHealth(outputFile, ownedContext = null) {
  const context = ownedContext?.settleBoot && outputFile ? { ...ownedContext, samplesFile: `${path.resolve(outputFile)}.samples.jsonl` } : ownedContext;
  const result = runOwnedSync(process.execPath, [__filename, ...ownedArgs(context)], { encoding: 'utf8', timeout: ownedContext?.settleBoot ? POLICY.ownedBootSettleMs + 3000 : 45000, maxBuffer: 16 * 1024 * 1024 });
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { throw new Error(`HOST_HEALTH_UNAVAILABLE:${result.error?.code || result.status}:${String(result.stderr).slice(-500)}`); }
  if (outputFile) fs.writeFileSync(outputFile, `${JSON.stringify(receipt)}\n`);
  if (result.status !== 0 || receipt.ok !== true) throw new Error(`HOST_HEALTH_REFUSED:${JSON.stringify(receipt)}`);
  return receipt;
}


if (require.main === module) Promise.resolve().then(() => {
  const args = process.argv.slice(2);
  let ownedContext = null;
  let settleBoot = false;
  let bootStartedMs;
  let samplesFile;
  if (args[0] === '--owned-simulator') {
    if (args.length < 5 || args[3] !== '--owner-pid' || !path.isAbsolute(args[1]) || !/^[0-9a-f-]{36}$/i.test(args[2]) || !/^[1-9]\d*$/.test(args[4])) throw new Error('HOST_HEALTH_OWNERSHIP_ARGUMENTS_INVALID');
    ownedContext = { deviceSetRoot: fs.realpathSync(args[1]), udid: args[2], ownerPid: Number(args[4]) };
    args.splice(0, 5);
  }
  if (args[0] === '--settle-owned-boot' && ownedContext) {
    settleBoot = true; args.shift();
    if (args[0] !== '--owned-boot-start-ms' || !/^[0-9]+(?:\.[0-9]+)?$/.test(args[1] || '')) throw new Error('HOST_HEALTH_BOOT_ANCHOR_INVALID');
    bootStartedMs = Number(args[1]); args.splice(0, 2);
  }
  if (args[0] === '--samples-file' && settleBoot) {
    if (!args[1] || !path.isAbsolute(args[1])) throw new Error('HOST_HEALTH_SAMPLE_PATH_INVALID');
    samplesFile = args[1]; args.splice(0, 2);
  }
  if (args.length && (args[0] !== '--then' || args.length < 2)) throw new Error('HOST_HEALTH_ARGUMENTS_INVALID');
  if (settleBoot) {
    const recorder = samplesFile ? openPreparationSamples(samplesFile) : null;
    let result;
    try { result = settleAdmission((remaining) => {
      const child = runOwnedSync(process.execPath, [__filename, ...ownedArgs(ownedContext)], { encoding: 'utf8', timeout: Math.min(45000, remaining), maxBuffer: 16 * 1024 * 1024 });
      try { const receipt = JSON.parse(child.stdout); if (child.error || ![0, 1].includes(child.status)) throw new Error('probe failed'); return receipt; }
      catch { return { ok: false, reasons: [`owned boot probe unavailable: ${child.error?.code || child.status}`] }; }
    }, { bootStartedMs, onSample: recorder?.write }); }
    finally { const descriptor = recorder?.close(); if (result && descriptor) result.settling.raw_samples = descriptor; }
    return { result, continuation: args };
  }
  return collectSnapshot(ownedContext).then((sample) => ({ result: evaluateSnapshot(sample), continuation: args }));
}).then(({ result, continuation }) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  if (result.ok && continuation.length) {
    const child = runOwnedSync(continuation[1], continuation.slice(2), { stdio: 'inherit', timeout: 255000 });
    process.exitCode = child.status ?? 1;
  }
}).catch((error) => { console.error(`HOST_HEALTH_UNAVAILABLE:${error.message}`); process.exitCode = 1; });

module.exports = { admissionReceiptErrors, preparationSampleErrors, settleAdmission, ownedArgs, POLICY, collectSnapshot, evaluateSnapshot, requireHostHealth, openPreparationSamples };
