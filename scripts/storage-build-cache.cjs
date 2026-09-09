'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fixedLayout } = require('./storage-authority.cjs');
const { runOwnedSync } = require('./owned-process.cjs');
const { buildArguments } = require('./gate-build-policy.cjs');
const MAX_BYTES = 6 * 1024 ** 3;
const MAX_ENTRIES = 100000;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
function cacheKey(inputs) { return digest(JSON.stringify(canonical(inputs))); }
function fileDigest(file) {
  const hash = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(1024 * 1024);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function inventory(root, { maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('CACHE_SYMLINK_ESCAPE');
  const real = fs.realpathSync(root); const entries = []; let bytes = 0;
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const relative = path.relative(real, file); const stat = fs.lstatSync(file);
      if (entries.length >= maxEntries) throw new Error('CACHE_MANIFEST_OVERFLOW');
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target) || !path.resolve(path.dirname(file), target).startsWith(`${real}${path.sep}`)) throw new Error('CACHE_SYMLINK_ESCAPE');
        entries.push({ path: relative, type: 'link', target });
      } else if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory' }); visit(file); }
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) throw new Error('CACHE_OVERSIZED');
        entries.push({ path: relative, type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: fileDigest(file) });
      } else throw new Error('CACHE_SPECIAL_FILE');
    }
  };
  visit(real);
  return { bytes, entries };
}

function environmentIdentity(environment) {
  const effectiveEnvironment = { ...environment, EXPO_PUBLIC_HARNESS: '1', RCT_NO_LAUNCH_PACKAGER: '1' };
  const ignored = /^(?:TESTTIME_|SIM_QUEUE_|PENTACLE_OWNED_|PENTACLE_DIAGNOSTIC_|AGENT_ORCH_)/;
  const controls = new Set(['_', 'SHLVL', 'TMUX', 'TMUX_PANE', 'PENTACLE_STORAGE_RUN_ID', 'PENTACLE_HOST_HEALTH_BASELINE', 'PENTACLE_GATE_ARTIFACT_DIR', 'PENTACLE_GATE_CODE_ROOT', 'PENTACLE_GATE_SIMULATOR_UDID', 'PENTACLE_SIMULATOR_UDID', 'PENTACLE_SIMULATOR_DEVICE_SET_PATH', 'PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT', 'IDB_COMPANION', 'PENTACLE_GATE_SIM_E2E_CMD', 'PENTACLE_GATE_SIM_E2E_ENV_FILE']);
  const environmentDigests = Object.fromEntries(Object.entries(effectiveEnvironment).filter(([key]) => !ignored.test(key) && !controls.has(key)).map(([key, value]) => [key, digest(String(value))]));
  return environmentDigests;
}

function inputsFor(nativeRoot, environment) {
  const command = (binary, args) => {
    const result = runOwnedSync(binary, args, { cwd: nativeRoot, env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`CACHE_INPUT_UNAVAILABLE:${binary}`);
    return result.stdout.trim();
  };
  const file = (relative) => { const target = path.join(nativeRoot, relative); return fs.existsSync(target) ? fileDigest(target) : null; };
  return { source: command('/usr/bin/git', ['ls-tree', 'HEAD', '--', 'app', 'src', 'assets', 'constants', 'config', 'plugins',
    'package.json', 'package-lock.json', 'tsconfig.json', 'app.config.ts', 'metro.config.js', 'pentacle-chat-core']),
  native: command('/usr/bin/git', ['rev-parse', 'HEAD:ios']),
  dependencies: cacheKey({ lock: file('package-lock.json'), pods: file('ios/Podfile.lock'), properties: file('ios/Podfile.properties.json') }),
  xcode: command('/usr/bin/xcodebuild', ['-version']), sdk: command('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-build-version']),
  architecture: os.arch(), configuration: 'Release', bundleId: environment.PENTACLE_BUNDLE_ID || '',
  settings: buildArguments(path.join(nativeRoot, 'ios/Pentacle.xcworkspace'), path.join(fixedLayout().scratchMount, 'derived-data'), environment.PENTACLE_BUNDLE_ID || ''),
  environment: environmentIdentity(environment),
  localConfig: file('pentacle.config.local.ts'), node: process.version };
}

function cacheRoot() { return fixedLayout().buildCache; }
function locked(action) {
  const root = cacheRoot();
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('CACHE_OWNER_INVALID');
  } else fs.mkdirSync(root, { mode: 0o700 });
  const lock = path.join(root, 'writer.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('CACHE_WRITER_BUSY');
    const prior = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(prior.pid) || prior.pid <= 1 || !/^staging-[0-9a-f-]{36}$/.test(prior.staging || '')) throw new Error('CACHE_WRITER_BUSY');
    let dead = false;
    try { process.kill(prior.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') dead = true; }
    if (!dead || fs.lstatSync(lock).ino !== stat.ino) throw new Error('CACHE_WRITER_BUSY');
    fs.rmSync(path.join(root, prior.staging), { recursive: true, force: true });
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, 'wx', 0o600);
  }
  const lease = { pid: process.pid, started_at: new Date().toISOString(), staging: `staging-${crypto.randomUUID()}` };
  try { fs.writeFileSync(fd, JSON.stringify(lease)); fs.fsyncSync(fd); return action(root, lease); }
  finally { const identity = fs.fstatSync(fd); fs.closeSync(fd); if (fs.lstatSync(lock).ino !== identity.ino) throw new Error('CACHE_LOCK_REPLACED'); fs.unlinkSync(lock); }
}

function paths(scratch) {
  return { 'derived-data': path.join(scratch, 'derived-data') };
}

function inputDifference(previous, current, prefix = '') {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (object(previous) && object(current)) return [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()
    .flatMap(key => inputDifference(previous[key], current[key], prefix ? `${prefix}.${key}` : key));
  if (JSON.stringify(canonical(previous)) === JSON.stringify(canonical(current))) return [];
  return [{ path: prefix, previous: previous ?? null, current: current ?? null,
    ...(previous === undefined ? { change: 'added' } : current === undefined ? { change: 'removed' } : {}) }];
}

function headroomReceipt(root, reserveBytes, phase) {
  const receipt = { schema: 1, phase, measured_at: new Date().toISOString(), floor_bytes: 60 * 1024 ** 3,
    reserve_bytes: reserveBytes, required_bytes: 60 * 1024 ** 3 + reserveBytes, available_bytes: null, ok: false };
  try {
    const capacity = fs.statfsSync(root);
    const available = Number(capacity.bavail) * Number(capacity.bsize);
    if (!Number.isSafeInteger(available) || !Number.isSafeInteger(capacity.bavail) || capacity.bavail < 0 || !Number.isSafeInteger(capacity.bsize) || capacity.bsize <= 0) throw new Error('CACHE_CAPACITY_INVALID');
    receipt.available_bytes = available; receipt.ok = available >= receipt.required_bytes;
  } catch (error) { receipt.error = error.code || error.message; }
  return receipt;
}

function cacheAdmission(root) {
  const reasons = []; let contents = { present: false, bytes: 0, entries: 0 };
  const entry = path.join(root, 'entry');
  try {
    if (fs.existsSync(entry)) {
      contents = { present: true };
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('CACHE_SYMLINK_ESCAPE');
      const manifestFile = path.join(entry, 'manifest.json');
      const manifestStat = fs.lstatSync(manifestFile);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 32 * 1024 ** 2) throw new Error('CACHE_MANIFEST_INVALID');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const actual = inventory(path.join(entry, 'payload'));
      contents = { present: true, bytes: actual.bytes, entries: actual.entries.length,
        inventory_sha256: digest(JSON.stringify(actual)), manifest_sha256: fileDigest(manifestFile) };
      if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory)) throw new Error('CACHE_CONTENT_DRIFT');
    }
  } catch (error) { reasons.push(error.code || error.message); }
  // Reserve both bounded derived-data growth and a complete publication copy.
  // Existing cache bytes are already charged against statfs available space.
  const headroom = headroomReceipt(root, 2 * MAX_BYTES, 'before-restore-build');
  if (!headroom.ok) reasons.push(headroom.error || 'CACHE_BUILD_HEADROOM');
  return { schema: 1, ok: reasons.length === 0, reasons, inventory: contents, headroom };
}

function restore(inputs, scratch, { onReceipt = () => {} } = {}) {
  const key = cacheKey(inputs);
  let receipt = { key, inputs: canonical(inputs), input_diff: null };
  let receiptFailure;
  const record = fields => {
    receipt = { ...receipt, ...fields };
    try { onReceipt(receipt); } catch (error) { receiptFailure = error; throw error; }
    return receipt;
  };
  record({ hit: false, reason: 'inspection-pending' });
  return locked((root) => {
    const admission = cacheAdmission(root);
    record({ admission, hit: false, reason: admission.ok ? 'inspection-pending' : 'CACHE_ADMISSION_REFUSED' });
    if (!admission.ok) throw new Error(`CACHE_ADMISSION_REFUSED:${admission.reasons.join(';')}`);
    const entry = path.join(root, 'entry');
    if (!fs.existsSync(entry)) return record({ hit: false, reason: 'absent' });
    try {
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('CACHE_SYMLINK_ESCAPE');
      const manifestFile = path.join(entry, 'manifest.json'); const manifestStat = fs.lstatSync(manifestFile);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('CACHE_SYMLINK_ESCAPE');
      if (manifestStat.size > 32 * 1024 * 1024) throw new Error('CACHE_MANIFEST_OVERFLOW');
      const raw = fs.readFileSync(manifestFile, 'utf8');
      const manifest = JSON.parse(raw);
      if (!manifest.inputs || cacheKey(manifest.inputs) !== manifest.key) throw new Error('CACHE_MANIFEST_INPUT_IDENTITY');
      record({ cached_key: manifest.key, cached_inputs: manifest.inputs, manifest_sha256: digest(raw), input_diff: inputDifference(manifest.inputs, inputs),
        hit: false, reason: manifest.key !== key || manifest.schema !== 1 ? 'input-mismatch' : 'restore-pending' });
      if (manifest.key !== key || manifest.schema !== 1) return receipt;
      const payload = path.join(entry, 'payload');
      if (JSON.stringify(inventory(payload)) !== JSON.stringify(manifest.inventory)) throw new Error('CACHE_CONTENT_DRIFT');
      const copied = [];
      try {
        for (const [name, destination] of Object.entries(paths(scratch))) {
          const source = path.join(payload, name);
          if (!fs.existsSync(source)) continue;
          if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length)) throw new Error('CACHE_DESTINATION_NOT_EMPTY');
          copied.push(destination);
          fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
          if (JSON.stringify(inventory(source)) !== JSON.stringify(inventory(destination))) throw new Error('CACHE_RESTORE_DRIFT');
        }
      } catch (error) { for (const file of copied) fs.rmSync(file, { recursive: true, force: true }); throw error; }
      return { ...receipt, hit: true, reason: null, bytes: manifest.inventory.bytes };
    } catch (error) {
      if (receiptFailure) throw receiptFailure;
      return record({ hit: false, reason: error.message });
    }
  });
}

function publish(inputs, scratch) {
  return locked((root, lease) => {
    const key = cacheKey(inputs); const sourcePaths = paths(scratch);
    const reasons = []; let inventories = []; let bytes = 0;
    try {
      if (!fs.existsSync(sourcePaths['derived-data'])) throw new Error('no-derived-data');
      inventories = Object.entries(sourcePaths).filter(([, file]) => fs.existsSync(file)).map(([name, file]) => [name, inventory(file)]);
      bytes = inventories.reduce((sum, [, content]) => sum + content.bytes, 0);
      if (bytes > MAX_BYTES) throw new Error('CACHE_OVERSIZED');
    } catch (error) { reasons.push(error.code || error.message); }
    const entry = path.join(root, 'entry'); const staging = path.join(root, lease.staging);
    const headroom = headroomReceipt(root, bytes, 'publish');
    if (!headroom.ok) reasons.push(headroom.error || 'CACHE_STAGING_HEADROOM');
    if (reasons.length) return { key, stored: false, reason: reasons[0], reasons, bytes, headroom };
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      const payload = path.join(staging, 'payload'); fs.mkdirSync(payload);
      for (const [name] of inventories) fs.cpSync(sourcePaths[name], path.join(payload, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      const contents = inventory(payload);
      const manifest = { schema: 1, key, inputs, inventory: contents };
      const manifestFile = path.join(staging, 'manifest.json'); fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      const headroomAfter = headroomReceipt(root, 0, 'publish-after-copy');
      if (!headroomAfter.ok) return { key, stored: false, reason: headroomAfter.error || 'CACHE_PUBLICATION_FLOOR', bytes,
        headroom, headroom_after: headroomAfter };
      // Replace only this cache's prior reproducible entry after the new copy fits.
      if (fs.existsSync(entry)) fs.rmSync(entry, { recursive: true });
      fs.renameSync(staging, entry);
      return { key, stored: true, bytes: contents.bytes, headroom, headroom_after: headroomAfter, manifest_sha256: fileDigest(path.join(entry, 'manifest.json')) };
    } catch (error) {
      return { key, stored: false, reason: error.code || error.message, bytes, headroom,
        headroom_after: headroomReceipt(root, 0, 'publish-after-copy') };
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
  });
}

function receiptErrors(receipt, { requireHeadroom = false } = {}) {
  const errors = []; const restore = receipt?.restore || {};
  if (!restore.inputs || typeof restore.inputs !== 'object' || Array.isArray(restore.inputs)) errors.push('cache canonical inputs missing');
  else if (cacheKey(restore.inputs) !== restore.key) errors.push('cache input key mismatch');
  if (typeof restore.hit !== 'boolean' || (restore.hit ? restore.reason !== null : typeof restore.reason !== 'string')) errors.push('cache restore outcome invalid');
  if (restore.cached_key !== undefined || restore.hit) {
    if (!restore.cached_inputs || cacheKey(restore.cached_inputs) !== restore.cached_key) errors.push('cached input key mismatch');
    if (!/^[a-f0-9]{64}$/.test(restore.manifest_sha256 || '')) errors.push('cache manifest digest missing');
    if (JSON.stringify(inputDifference(restore.cached_inputs, restore.inputs)) !== JSON.stringify(restore.input_diff)) errors.push('cache input diff mismatch');
    if (restore.hit && (restore.key !== restore.cached_key || restore.input_diff?.length !== 0)) errors.push('cache hit identity mismatch');
  } else if (restore.input_diff !== null) errors.push('cache unavailable diff invalid');
  if (receipt?.publish?.key !== undefined && receipt.publish.key !== restore.key) errors.push('cache publish input key mismatch');
  if (requireHeadroom) {
    const validHeadroom = (value, reserve, phase) => value?.schema === 1 && value.phase === phase
      && Number.isFinite(Date.parse(value.measured_at)) && value.floor_bytes === 60 * 1024 ** 3
      && Number.isSafeInteger(reserve) && reserve >= 0 && reserve <= 2 * MAX_BYTES
      && value.reserve_bytes === reserve && value.required_bytes === value.floor_bytes + reserve
      && Number.isSafeInteger(value.available_bytes) && value.available_bytes >= value.required_bytes
      && value.ok === true && value.error === undefined;
    const admission = restore.admission;
    if (admission?.schema !== 1 || admission.ok !== true || !Array.isArray(admission.reasons) || admission.reasons.length) errors.push('cache admission missing or refused');
    if (!validHeadroom(admission?.headroom, 2 * MAX_BYTES, 'before-restore-build')) errors.push('cache admission headroom invalid');
    const inventory = admission?.inventory;
    if (typeof inventory?.present !== 'boolean' || !Number.isSafeInteger(inventory.bytes) || inventory.bytes < 0 || inventory.bytes > MAX_BYTES
      || !Number.isSafeInteger(inventory.entries) || inventory.entries < 0 || inventory.entries > MAX_ENTRIES
      || (inventory.present ? !/^[a-f0-9]{64}$/.test(inventory.inventory_sha256 || '') || !/^[a-f0-9]{64}$/.test(inventory.manifest_sha256 || '')
        : inventory.bytes !== 0 || inventory.entries !== 0)) errors.push('cache admission inventory invalid');
    if (restore.cached_key !== undefined && inventory?.manifest_sha256 !== restore.manifest_sha256) errors.push('cache inventory manifest binding mismatch');
    const publication = receipt?.publish;
    if (publication?.stored !== true || !Number.isSafeInteger(publication.bytes) || publication.bytes < 0 || publication.bytes > MAX_BYTES
      || !/^[a-f0-9]{64}$/.test(publication.manifest_sha256 || '')) errors.push('cache publication missing or refused');
    if (!validHeadroom(publication?.headroom, publication?.bytes, 'publish')) errors.push('cache publish headroom invalid');
    if (!validHeadroom(publication?.headroom_after, 0, 'publish-after-copy')) errors.push('cache publish floor readback invalid');
  }
  return errors;
}

module.exports = { MAX_BYTES, MAX_ENTRIES, cacheKey, inventory, inputsFor, environmentIdentity, receiptErrors,
  bind: (token) => require('./storage-capability.cjs').bind(token, { restore, publish }) };
