'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const CAP = 128 * 1024 * 1024;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function inventory(root, limit = CAP) {
  const files = []; let bytes = 0;
  const walk = (relative) => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const member = path.join(relative, name); const file = path.join(root, member);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(member);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > limit || files.length >= 10000) throw new Error('LAUNCH_RETENTION_CAP');
        files.push({ path: member.split(path.sep).join('/'), size: stat.size, mode: stat.mode & 0o777, sha256: hash(fs.readFileSync(file)) });
      } else throw new Error('LAUNCH_RETENTION_OBJECT');
    }
  };
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('LAUNCH_RETENTION_OBJECT');
  walk(''); return files;
}

function launchLogWindow(launch, capturedAt) {
  const start = Date.parse(launch ? launch.started_at : capturedAt);
  const end = Date.parse(launch ? launch.finished_at : capturedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('LAUNCH_RETENTION_LOG_WINDOW');
  return { start: Math.floor(start / 1000) - (launch ? 5 : 120), end: Math.ceil(end / 1000) + (launch ? 5 : 0), basis: launch ? 'launch' : 'cleanup-without-launch' };
}

function collectDeviceLogs({ deviceSet, udid, logWindow }) {
  const result = spawnSync('/usr/bin/xcrun', ['simctl', '--set', deviceSet, 'spawn', udid, 'log', 'show', '--start', `@${logWindow.start}`, '--end', `@${logWindow.end}`, '--style', 'json'], { timeout: 30000, maxBuffer: CAP });
  if (result.error || result.status !== 0) throw new Error(`LAUNCH_RETENTION_LOG_CAPTURE:${result.error?.code || result.status}`);
  return result.stdout;
}

function collectDeviceContext({ deviceSet, udid }) {
  const query = (kind) => {
    const result = spawnSync('/usr/bin/xcrun', ['simctl', '--set', deviceSet, 'list', kind, '--json'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`LAUNCH_RETENTION_DEVICE_CONTEXT:${kind}`);
    return JSON.parse(result.stdout);
  };
  const matches = Object.entries(query('devices').devices).flatMap(([runtime, devices]) => devices.filter((device) => device.udid === udid).map((device) => ({ runtime, device })));
  if (matches.length !== 1 || matches[0].device.state !== 'Booted') throw new Error('LAUNCH_RETENTION_DEVICE_BINDING');
  const runtimes = query('runtimes').runtimes.filter((runtime) => runtime.identifier === matches[0].runtime);
  if (runtimes.length !== 1) throw new Error('LAUNCH_RETENTION_RUNTIME_BINDING');
  return { device: matches[0].device, runtime: runtimes[0] };
}

function captureLaunchEvidence(options, dependencies = {}) {
  const { evidence, scratch, runId, candidateSha, udid, deviceSet, context } = options;
  const buildFile = path.join(evidence, 'release-sim-build.json');
  if (!fs.existsSync(buildFile) || read(buildFile).status !== 0) return null;
  const products = path.join(scratch, 'derived-data/Build/Products/Release-iphonesimulator');
  const apps = fs.readdirSync(products).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('LAUNCH_RETENTION_APP_CARDINALITY');
  const app = path.join(products, apps[0]);
  if (!fs.realpathSync(app).startsWith(fs.realpathSync(scratch) + path.sep)) throw new Error('LAUNCH_RETENTION_SOURCE');
  const before = inventory(app);
  const launchFile = path.join(evidence, 'release-sim-launch.json');
  const launch = fs.existsSync(launchFile) ? read(launchFile) : null;
  const capturedAt = new Date().toISOString();
  const logWindow = launchLogWindow(launch, capturedAt);
  const deviceContext = (dependencies.collectContext || collectDeviceContext)(options);
  const logs = (dependencies.collectLogs || collectDeviceLogs)({ ...options, logWindow });
  if (!Buffer.isBuffer(logs) || logs.length === 0 || logs.length > CAP) throw new Error('LAUNCH_RETENTION_LOG_CAP');
  const root = path.join(evidence, 'launch-diagnosis');
  if (fs.existsSync(root)) throw new Error('LAUNCH_RETENTION_COLLISION');
  fs.mkdirSync(path.join(root, 'product'), { recursive: true });
  fs.cpSync(app, path.join(root, 'product', apps[0]), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const copied = inventory(path.join(root, 'product', apps[0]));
  if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(inventory(app))) throw new Error('LAUNCH_RETENTION_SOURCE_CHANGED');
  fs.writeFileSync(path.join(root, 'device.log.json.gz'), zlib.gzipSync(logs));
  const manifest = { schema: 1, run_id: runId, candidate_sha: candidateSha, udid, device_set: deviceSet,
    app_name: apps[0], context: { ...(typeof context === 'function' ? context() : context), device_context: deviceContext }, launch,
    log_window: logWindow, log_raw_bytes: logs.length, files: inventory(root, 2 * CAP), captured_at: capturedAt };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest) + '\n');
  validateLaunchEvidence(evidence, runId, candidateSha);
  return manifest;
}

function validateLaunchEvidence(evidence, runId, candidateSha) {
  const root = path.join(evidence, 'launch-diagnosis');
  const launchFile = path.join(evidence, 'release-sim-launch.json');
  const launch = fs.existsSync(launchFile) ? read(launchFile) : null;
  if (!fs.existsSync(root)) {
    if (launch && Number.isInteger(launch.status) && launch.status !== 0) throw new Error('EVIDENCE_LAUNCH_RETENTION_REQUIRED');
    return;
  }
  try {
    const manifest = read(path.join(root, 'manifest.json'));
    const keys = ['schema', 'run_id', 'candidate_sha', 'udid', 'device_set', 'app_name', 'context', 'launch', 'log_window', 'log_raw_bytes', 'files', 'captured_at'];
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys.sort()) || manifest.schema !== 1
      || manifest.run_id !== runId || manifest.candidate_sha !== candidateSha
      || !/^[0-9a-f-]{36}$/i.test(manifest.udid) || !path.isAbsolute(manifest.device_set)
      || !/^[\w.-]+\.app$/.test(manifest.app_name) || !manifest.context || typeof manifest.context !== 'object'
      || JSON.stringify(manifest.log_window) !== JSON.stringify(launchLogWindow(manifest.launch, manifest.captured_at)) || !Number.isInteger(manifest.log_raw_bytes) || manifest.log_raw_bytes < 1 || manifest.log_raw_bytes > CAP
      || !Number.isFinite(Date.parse(manifest.captured_at)) || JSON.stringify(manifest.launch) !== JSON.stringify(launch)) throw new Error('manifest binding');
    const run = read(path.join(evidence, 'run.json'));
    const native = read(path.join(evidence, 'native-root.json'));
    const context = manifest.context;
    if (run.candidate_sha !== candidateSha || native.candidate_sha !== candidateSha
      || context.gate_code_sha !== run.gate_code_sha || !/^[0-9a-f]{40}$/.test(context.gate_code_sha)
      || context.native_root !== native.native_root || !path.isAbsolute(context.native_root)
      || typeof context.cwd !== 'string' || !path.isAbsolute(context.cwd)
      || typeof context.sandbox_profile !== 'string' || !context.sandbox_profile.length
      || context.sandbox_profile_sha256 !== crypto.createHash('sha256').update(context.sandbox_profile).digest('hex')
      || manifest.udid !== run.release_target?.udid || manifest.device_set !== run.release_target?.deviceSetRoot
      || manifest.app_name !== path.basename(run.release_target?.appPath || '')
      || context.environment?.PENTACLE_GATE_SIMULATOR_UDID !== manifest.udid
      || context.environment?.PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT !== manifest.device_set
      || context.device_context?.device?.udid !== manifest.udid || context.device_context?.device?.state !== 'Booted'
      || !['identifier', 'version', 'buildversion'].every((key) => typeof context.device_context?.runtime?.[key] === 'string' && context.device_context.runtime[key].length)
      || context.launcher_start_time !== null || typeof context.launcher_start_time_reason !== 'string' || !context.launcher_start_time_reason.length) throw new Error('context binding');
    const files = inventory(root, 2 * CAP).filter((entry) => entry.path !== 'manifest.json');
    if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('member identity');
    const prefix = `product/${manifest.app_name}/`;
    if (files.some((entry) => entry.path !== 'device.log.json.gz' && !entry.path.startsWith(prefix))) throw new Error('unknown member');
    const product = files.filter((entry) => entry.path.startsWith(prefix));
    if (product.reduce((sum, entry) => sum + entry.size, 0) > CAP) throw new Error('product cap');
    for (const name of ['Info.plist', 'main.jsbundle', manifest.app_name.slice(0, -4)]) if (!product.some((entry) => entry.path === prefix + name)) throw new Error('incomplete product');
    const logs = zlib.gunzipSync(fs.readFileSync(path.join(root, 'device.log.json.gz')), { maxOutputLength: CAP });
    if (logs.length !== manifest.log_raw_bytes) throw new Error('log size');
    const events = JSON.parse(logs);
    if (!Array.isArray(events) || !events.length || events.some((event) => !event || typeof event !== 'object')) throw new Error('log records');
  } catch (error) { throw new Error(`EVIDENCE_LAUNCH_RETENTION_INVALID:${error.message}`); }
}

module.exports = { validateLaunchEvidence, bind: (token) => require('./storage-capability.cjs').bind(token, { captureLaunchEvidence }) };
