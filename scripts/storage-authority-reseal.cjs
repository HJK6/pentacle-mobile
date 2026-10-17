'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { fixedLayout } = require('./storage-authority.cjs');

const JOURNAL = 'authority-reseal.json';
const PREFIX = '.authority-reseal-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VOLUME_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = bytes => Buffer.from(bytes).toString('base64');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw new Error(`AUTHORITY_RESEAL_${reason}`); };
const exists = target => Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
const claimName = generation => `.mutation-${digest(`scheduler\0${generation}`)}.claim`;
const hasClaim = j => exists(path.join(fixedLayout().state, 'scheduler', claimName(j.generation)));
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('SCHEMA');
}
function decode(value) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) fail('ENCODING');
  const bytes = Buffer.from(value, 'base64');
  if (encode(bytes) !== value) fail('ENCODING');
  return bytes;
}
function readFile(target, limit = 2 * 1024 * 1024) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o600 || stat.size > limit || fs.realpathSync(target) !== path.resolve(target)) fail('FILE');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size) fail('FILE_RACE');
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) fail('FILE_RACE');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function proofFromBytes(bytes) {
  if (bytes.length > 65536) fail('PROOF_SIZE');
  const p = JSON.parse(bytes);
  keys(p, ['schema', 'id', 'generation', 'authority_preimage', 'authority_sha256', 'host', 'backing_volume_uuid', 'state_volume_uuid', 'image_identity', 'roots']);
  keys(p.host, ['hostname', 'uid', 'hardware_uuid']);
  if (p.schema !== 1 || !UUID.test(p.id) || !UUID.test(p.generation) || !SHA.test(p.authority_sha256)
    || p.host.hostname !== os.hostname() || p.host.uid !== process.getuid()
    || ![p.host.hardware_uuid, p.backing_volume_uuid, p.state_volume_uuid].every(v => typeof v === 'string' && VOLUME_UUID.test(v))) fail('PROOF_IDENTITY');
  const beforeBytes = decode(p.authority_preimage);
  if (digest(beforeBytes) !== p.authority_sha256) fail('PREIMAGE');
  const before = JSON.parse(beforeBytes);
  const layout = fixedLayout();
  const state = require('./storage-state.cjs');
  const expected = { scratch_images: layout.scratchImages, evidence_images: layout.evidenceImages, worktrees: layout.worktrees, repositories: layout.repositories };
  state.validateAuthorityShape(before, { host: os.hostname(), uid: process.getuid(), roots: expected });
  if (before.generation !== p.generation) fail('GENERATION');
  const after = { ...before, roots: p.roots };
  state.validateAuthorityShape(after, { host: os.hostname(), uid: process.getuid(), roots: expected });
  const oldRoots = flatten(before.roots), newRoots = flatten(after.roots);
  if (new Set(oldRoots.map(r => r.device)).size !== 1 || new Set(newRoots.map(r => r.device)).size !== 1) fail('DEVICE_SET');
  let changed = false;
  for (let i = 0; i < oldRoots.length; i++) {
    for (const k of ['canonical', 'inode', 'uid', 'mode']) if (oldRoots[i][k] !== newRoots[i][k]) fail('ROOT_CHANGE');
    if (oldRoots[i].device !== newRoots[i].device) changed = true;
  }
  if (!changed) fail('NO_DRIFT');
  keys(p.image_identity, ['canonical', 'device', 'inode', 'uid', 'mode']);
  if (p.image_identity.canonical !== layout.stateImage || p.image_identity.uid !== process.getuid()
    || typeof p.image_identity.device !== 'string' || typeof p.image_identity.inode !== 'string'
    || !Number.isInteger(p.image_identity.mode)) fail('IMAGE');
  return { proof: p, beforeBytes, afterBytes: jsonBytes(after) };
}
function flatten(roots) { return [roots.scratch_images, roots.evidence_images, roots.worktrees, roots.repositories['pentacle-mobile']]; }
function names(id) { return Object.fromEntries(['prepare', 'authority', 'commit'].map(k => [k, `${PREFIX}${id}-${k}.tmp`])); }
function validateJournal(j) {
  keys(j, ['schema', 'state', 'id', 'generation', 'proof_bytes', 'proof_sha256', 'before', 'after', 'manifest', 'manifest_sha256', 'writer', 'temporaries', 'created_at', 'commit_at']);
  const input = decode(j.proof_bytes), parsed = proofFromBytes(input);
  if (j.schema !== 1 || !['prepared', 'committed'].includes(j.state) || j.id !== parsed.proof.id || j.generation !== parsed.proof.generation
    || digest(input) !== j.proof_sha256 || j.before !== encode(parsed.beforeBytes) || j.after !== encode(parsed.afterBytes)
    || !equal(j.temporaries, names(j.id)) || !Array.isArray(j.manifest) || j.manifest.length > 10000
    || digest(jsonBytes(j.manifest)) !== j.manifest_sha256
    || !Number.isFinite(Date.parse(j.created_at)) || !Number.isFinite(Date.parse(j.commit_at))) fail('JOURNAL');
  keys(j.writer, ['host', 'uid', 'pid', 'startToken']);
  if (j.writer.host !== os.hostname() || j.writer.uid !== process.getuid() || !Number.isSafeInteger(j.writer.pid) || j.writer.pid < 1
    || typeof j.writer.startToken !== 'string' || !j.writer.startToken) fail('WRITER');
  let previous = '';
  for (const entry of j.manifest) {
    keys(entry, ['path', 'sha256', 'size', 'uid', 'mode']);
    if (typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path) || entry.path.split('/').some(k => !k || k === '.' || k === '..')
      || entry.path <= previous || !SHA.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !Number.isInteger(entry.uid) || !Number.isInteger(entry.mode)) fail('MANIFEST');
    previous = entry.path;
  }
  return j;
}
function reservedTemps(root = fixedLayout().state) {
  return fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.startsWith(PREFIX)) : [];
}
// Shared by admission, shape-only transitions and pre-admission cleanup. Never repairs evidence.
function assertNormalReady() {
  const root = fixedLayout().state;
  if (reservedTemps(root).length) fail('PENDING');
  const target = path.join(root, JOURNAL);
  if (!exists(target)) {
    // A writer can die after acquiring the generation claim but before publishing preparation.
    // Ordinary cleanup must preserve that earlier boundary too. The legacy authority reader did
    // not require mode0600, so this lookup does not add a new mode rule to ordinary admission.
    const authorityFile = path.join(root, 'authority.json');
    if (exists(authorityFile)) {
      const stat = fs.lstatSync(authorityFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('FILE');
      const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
      if (UUID.test(authority.generation) && hasClaim(authority)) fail('PENDING');
    }
    return;
  }
  const journal = validateJournal(JSON.parse(readFile(target)));
  if (journal.state !== 'committed' || hasClaim(journal)) fail('PENDING');
  const authority = JSON.parse(readFile(path.join(root, 'authority.json')));
  const after = JSON.parse(decode(journal.after));
  if (authority.generation !== journal.generation || !equal(authority.roots, after.roots)) fail('JOURNAL_DRIFT');
}
function plist(binary, args) {
  const options = { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
  const raw = childProcess.execFileSync(binary, args, options);
  return JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { ...options, input: raw }));
}
function observe() {
  if (process.platform !== 'darwin') fail('PLATFORM');
  const layout = fixedLayout(), state = require('./storage-state.cjs');
  const hardware = plist('/usr/sbin/ioreg', ['-a', '-rd1', '-c', 'IOPlatformExpertDevice']);
  const backing = plist('/usr/sbin/diskutil', ['info', '-plist', '/System/Volumes/Data']);
  const mounted = plist('/usr/sbin/diskutil', ['info', '-plist', layout.state]);
  const inventory = plist('/usr/bin/hdiutil', ['info', '-plist']);
  const images = inventory.images;
  if (!Array.isArray(hardware) || hardware.length !== 1 || !Array.isArray(images)) fail('PROBE');
  const matches = images.filter(i => (i['system-entities'] || []).some(e => e['mount-point'] === layout.state));
  const imageMatches = images.filter(i => i['image-path'] === layout.stateImage);
  if (matches.length !== 1 || imageMatches.length !== 1 || matches[0] !== imageMatches[0]
    || matches[0].writeable !== true || matches[0]['image-type'] !== 'sparse bundle disk image') fail('MOUNT');
  const entities = matches[0]['system-entities'].filter(e => e['mount-point'] === layout.state);
  if (entities.length !== 1 || entities[0]['dev-entry'] !== mounted.DeviceNode || mounted.MountPoint !== layout.state
    || mounted.FilesystemType !== 'apfs' || backing.FilesystemType !== 'apfs' || backing.MountPoint !== '/System/Volumes/Data') fail('MOUNT');
  const identities = { support: state.canonicalIdentity(layout.support), image: state.canonicalIdentity(layout.stateImage), state: state.canonicalIdentity(layout.state),
    backing: state.canonicalIdentity(backing.MountPoint), roots: { scratch_images: state.canonicalIdentity(layout.scratchImages), evidence_images: state.canonicalIdentity(layout.evidenceImages), worktrees: state.canonicalIdentity(layout.worktrees), repositories: { 'pentacle-mobile': state.canonicalIdentity(layout.repositories['pentacle-mobile']) } } };
  if ([identities.support, identities.image, ...flatten(identities.roots)].some(r => r.device !== identities.backing.device || r.uid !== process.getuid())
    || identities.state.device === identities.backing.device) fail('CROSS_DEVICE');
  const result = { host: { hostname: os.hostname(), uid: process.getuid(), hardware_uuid: hardware[0].IOPlatformUUID }, backing_volume_uuid: backing.VolumeUUID, state_volume_uuid: mounted.VolumeUUID,
    image_identity: identities.image, roots: identities.roots, state_identity: identities.state, state_device: mounted.DeviceNode };
  if (![result.host.hardware_uuid, result.backing_volume_uuid, result.state_volume_uuid].every(v => typeof v === 'string' && VOLUME_UUID.test(v))) fail('PROBE');
  return result;
}
function verifyObserved(p) {
  const current = observe();
  for (const key of ['host', 'backing_volume_uuid', 'state_volume_uuid', 'image_identity', 'roots']) if (!equal(p[key], current[key])) fail(`OBSERVATION:${key}`);
  return current;
}
function noConflicts() {
  const root = fixedLayout().state;
  for (const name of ['gate.lock', 'janitor.lock', 'scheduler.lock', 'worktree.lock']) if (exists(path.join(root, name))) fail('LOCKED');
  for (const record of require('./storage-state.cjs').listRecords('scheduler')) if (!['absent', 'committed', 'restored'].includes(record.state)) fail('SCHEDULER_PENDING');
}
function preservation(j) {
  const layout = fixedLayout(), root = layout.state;
  const claim = claimName(j.generation);
  const excluded = new Set(['authority.json', JOURNAL, ...Object.values(j.temporaries)]);
  const results = [];
  function walk(dir, relative = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      if (!relative && (excluded.has(name) || ['.fseventsd', '.Spotlight-V100', '.Trashes'].includes(name))) continue;
      if (relative === 'scheduler' && (name === claim || name.startsWith(`${claim}.`))) continue;
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('PRESERVATION_ALIAS');
      if (stat.isDirectory()) walk(file, rel);
      else if (stat.isFile() && stat.nlink === 1) results.push({ path: rel, sha256: digest(fs.readFileSync(file)), size: stat.size, uid: stat.uid, mode: stat.mode & 0o777 });
      else fail('PRESERVATION_FILE');
    }
  }
  walk(root);
  return results.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function quotaAndLayout(j = null) {
  const state = require('./storage-state.cjs'), root = fixedLayout().state;
  const usage = fs.statfsSync(root, { bigint: true });
  if (usage.blocks * usage.bsize > BigInt(state.STATE_LIMIT) || state.directoryBytes(root) > state.STATE_LIMIT) fail('QUOTA');
  // Exact reserved files are checked separately against the journal during reconciliation.
  state.validateStateLayout(root, j ? Object.values(j.temporaries) : []);
}
function originalWriterDead(writer) {
  const current = require('./storage-state.cjs').processStartToken(writer.pid);
  if (current !== null) { if (current === writer.startToken) fail('WRITER_ALIVE'); return; }
  try { process.kill(writer.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
  fail('WRITER_UNCERTAIN');
}
function syncDir() {
  const fd = fs.openSync(fixedLayout().state, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeTemp(name, bytes) {
  const target = path.join(fixedLayout().state, name);
  if (exists(target)) { if (!readFile(target).equals(bytes)) fail('TEMP_CONTENT'); return target; }
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir();
  return target;
}
function checkTemps(j) {
  const prepared = { ...j, state: 'prepared' }, committed = { ...j, state: 'committed' };
  const expected = { [j.temporaries.prepare]: jsonBytes(prepared), [j.temporaries.authority]: decode(j.after), [j.temporaries.commit]: jsonBytes(committed) };
  for (const name of reservedTemps()) if (!expected[name] || !readFile(path.join(fixedLayout().state, name)).equals(expected[name])) fail('TEMP_CONTENT');
}
function verifyTransaction(j, p, { beforeOnly = false } = {}) {
  verifyObserved(p);
  noConflicts();
  checkTemps(j);
  quotaAndLayout(j);
  const current = readFile(path.join(fixedLayout().state, 'authority.json'));
  const isAfter = current.equals(decode(j.after));
  if (j.state === 'committed' ? !isAfter : !current.equals(decode(j.before)) && (beforeOnly || !isAfter)) fail('CAS');
  if (!equal(preservation(j), j.manifest)) fail('PRESERVATION_DRIFT');
  return current;
}
function reseal(proofFile, token) {
  const input = readFile(path.resolve(proofFile), 65536), parsed = proofFromBytes(input), p = parsed.proof;
  const root = fixedLayout().state, target = path.join(root, JOURNAL), authorityFile = path.join(root, 'authority.json');
  verifyObserved(p); noConflicts();
  let j;
  if (exists(target)) j = validateJournal(JSON.parse(readFile(target)));
  else if (reservedTemps().length) {
    const orphan = path.join(root, names(p.id).prepare);
    j = validateJournal(JSON.parse(readFile(orphan)));
    if (j.state !== 'prepared') fail('JOURNAL');
  }
  if (j) {
    if (j.proof_sha256 !== digest(input) || j.id !== p.id || j.generation !== p.generation) fail('PROOF_DRIFT');
    if (j.state === 'committed' && reservedTemps().length === 0 && !hasClaim(j)) fail('REPLAY');
    originalWriterDead(j.writer);
    verifyTransaction(j, p);
  } else {
    if (!readFile(authorityFile).equals(parsed.beforeBytes)) fail('CAS');
    const startToken = require('./storage-state.cjs').processStartToken(process.pid);
    if (!startToken) fail('WRITER_UNCERTAIN');
    j = { schema: 1, state: 'prepared', id: p.id, generation: p.generation, proof_bytes: encode(input), proof_sha256: digest(input), before: encode(parsed.beforeBytes), after: encode(parsed.afterBytes), manifest: [], manifest_sha256: '',
      writer: { host: os.hostname(), uid: process.getuid(), pid: process.pid, startToken }, temporaries: names(p.id), created_at: new Date().toISOString(), commit_at: new Date().toISOString() };
    quotaAndLayout();
    j.manifest = preservation(j); j.manifest_sha256 = digest(jsonBytes(j.manifest));
    validateJournal(j);
    verifyTransaction(j, p, { beforeOnly: true });
  }
  const journalBytes = jsonBytes(j);
  const mutations = require('./storage-state.cjs').bind(token);
  return mutations.withAuthorityResealMutation(p.generation, () => {
    verifyTransaction(j, p);
    if (exists(target) && !readFile(target).equals(journalBytes)) fail('JOURNAL_CAS');
    if (j.state === 'committed') {
      for (const name of reservedTemps()) fs.unlinkSync(path.join(root, name));
      syncDir();
      return { generation: p.generation, migration_id: p.id, state: 'committed', reconciled: true, authority_sha256: digest(readFile(authorityFile)) };
    }
    if (!exists(target)) {
      const temporary = writeTemp(j.temporaries.prepare, journalBytes);
      verifyTransaction(j, p, { beforeOnly: true });
      if (exists(target)) fail('JOURNAL_CAS');
      fs.renameSync(temporary, target); syncDir();
    }
    const proposed = decode(j.after), current = readFile(authorityFile);
    if (!current.equals(proposed)) {
      const temporary = writeTemp(j.temporaries.authority, proposed);
      verifyTransaction(j, p, { beforeOnly: true });
      if (!readFile(target).equals(journalBytes)) fail('JOURNAL_CAS');
      fs.renameSync(temporary, authorityFile); syncDir();
    }
    const committed = { ...j, state: 'committed' };
    const temporary = writeTemp(j.temporaries.commit, jsonBytes(committed));
    verifyTransaction(j, p);
    if (!readFile(authorityFile).equals(proposed) || !readFile(target).equals(journalBytes)) fail('COMMIT_CAS');
    fs.renameSync(temporary, target); syncDir();
    // Only fully validated reserved artifacts can remain after same-proof reconciliation.
    checkTemps(committed);
    for (const name of reservedTemps()) fs.unlinkSync(path.join(root, name));
    syncDir();
    return { generation: p.generation, migration_id: p.id, state: 'committed', reconciled: false, authority_sha256: digest(proposed), preimage_sha256: digest(parsed.beforeBytes), journal: target };
  });
}
function inspect() {
  const root = fixedLayout().state, bytes = readFile(path.join(root, 'authority.json')), authority = JSON.parse(bytes);
  const observation = observe();
  let normal = false, refusal = null;
  try { require('./storage-state.cjs').validateInstalledAuthority(); normal = true; } catch (error) { refusal = error.message; }
  const target = path.join(root, JOURNAL);
  let journal = null;
  if (exists(target)) {
    try { const j = validateJournal(JSON.parse(readFile(target))); journal = { id: j.id, state: j.state, generation: j.generation, proof_sha256: j.proof_sha256, preimage_sha256: digest(decode(j.before)), after_sha256: digest(decode(j.after)), preservation_sha256: j.manifest_sha256 }; }
    catch (error) { journal = { state: 'invalid', error: error.message }; }
  }
  const roots = flatten(authority.roots), actual = flatten(observation.roots);
  return { generation: authority.generation, authority_sha256: digest(bytes), observation, journal, reserved_temporaries: reservedTemps(), normal_admission: normal, refusal,
    root_drift: roots.map((r, i) => ({ canonical: r.canonical, changed_fields: Object.keys(r).filter(k => r[k] !== actual[i][k]) })) };
}

module.exports = { assertNormalReady, inspect, bind: token => require('./storage-capability.cjs').bind(token, { reseal: proofFile => reseal(proofFile, token) }) };
