#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const state = require('./storage-state.cjs');
const { fixedLayout, rejectEnvironmentAuthority, assertPublicRoot } = require('./storage-authority.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LABEL = 'com.pentacle.mobile.storage-janitor';
const FLOOR = 60 * 2 ** 30;
const fail = code => { throw new Error(`RETIREMENT_${code}`); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
const same = (a, b) => canonical(a) === canonical(b);
const exists = p => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const exactKeys = (v, keys) => v && same(Object.keys(v).sort(), keys.sort());
const under = (root, p) => p === root || p.startsWith(`${root}/`);

function owned(p, directory = true) {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid() || fs.realpathSync(p) !== p) fail('PATH_IDENTITY');
  if (!directory && stat.nlink !== 1) fail('PATH_HARDLINK');
  if (stat.mode & 0o022) fail('PATH_WRITABLE');
  return { device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o777 };
}

// The reviewed shared interpreter is immutable input, not an account-owned mutable root.
function executableIdentity(target = process.execPath) {
  const canonical = fs.realpathSync(target), before = fs.lstatSync(canonical);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7222) || !(before.mode & 0o111)) fail('INTERPRETER_IDENTITY');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try { const held = fs.fstatSync(fd); if (held.dev !== before.dev || held.ino !== before.ino) fail('INTERPRETER_RACE'); bytes = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  const after = fs.lstatSync(canonical);
  for (const key of ['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs']) if (after[key] !== before[key]) fail('INTERPRETER_RACE');
  return { canonical, device:String(before.dev), inode:String(before.ino), uid:before.uid, mode:before.mode & 0o777, sha256:digest(bytes) };
}

function manifest(root) {
  const result = [];
  const dev = owned(root).device;
  const visit = relative => {
    const p = path.join(root, relative);
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.uid !== process.getuid() || String(stat.dev) !== dev) fail('MANIFEST_IDENTITY');
    const entry = { path: relative, kind: stat.isDirectory() ? 'directory' : 'file', inode: String(stat.ino), uid: stat.uid, mode: stat.mode & 0o777 };
    if (stat.isFile()) {
      if (stat.nlink !== 1) fail('MANIFEST_HARDLINK');
      const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(1024 * 1024);
      try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
      finally { fs.closeSync(fd); }
      const after = fs.lstatSync(p);
      if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('MANIFEST_RACE');
      if (after.uid !== stat.uid || after.mode !== stat.mode || after.dev !== stat.dev || after.nlink !== 1) fail('MANIFEST_RACE');
      entry.bytes = stat.size;
      entry.sha256 = hash.digest('hex');
    }
    result.push(entry);
    if (stat.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(relative ? `${relative}/${name}` : name);
  };
  visit('');
  return result;
}

function sync(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeJournal(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  sync(path.dirname(file));
}

function command(binary, args, input) {
  const r = spawnSync(binary, args, { encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) fail(`COMMAND:${path.basename(binary)}:${r.status}:${String(r.stderr || '').trim()}`);
  return r.stdout;
}
function plist(bytes) { return JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], bytes)); }
function readOnlyMount(disk, mount) { return disk.Writable === false && disk.WritableVolume === false && disk.MountPoint === mount; }

function hostPlatform(layout) {
  const domain = `gui/${process.getuid()}/${LABEL}`;
  const inventory = () => {
    const raw = plist(command('/usr/bin/hdiutil', ['info', '-plist']));
    if (!Array.isArray(raw.images)) fail('INVENTORY_INVALID');
    return raw.images.map(i => {
      if (typeof i['image-path'] !== 'string' || !Array.isArray(i['system-entities'])) fail('INVENTORY_INVALID');
      return { image: i['image-path'], writable: i.writeable, entities: i['system-entities'].map(e => ({ mount: e['mount-point'] || null, device: e['dev-entry'] || null })) };
    });
  };
  const argvFromPlist = bytes => {
    const p = plist(bytes), argv = p.ProgramArguments;
    const legacy = path.join(layout.repositories['pentacle-mobile'], 'scripts/storage-cli.cjs');
    const current = path.join(layout.schedulerRoot, 'scripts/storage-janitor-scheduled.cjs');
    if (p.Label !== LABEL || !Array.isArray(argv) || argv.length !== 4 || ![legacy, current].includes(argv[1])
      || argv[2] !== 'storage:janitor' || argv[3] !== 'dry-run' || !path.isAbsolute(argv[0] || '')
      || fs.realpathSync(argv[0]) !== fs.realpathSync(process.execPath)
      || p.WorkingDirectory !== (argv[1] === legacy ? layout.repositories['pentacle-mobile'] : layout.schedulerRoot)) fail('PLIST_ARGV');
    owned(path.dirname(layout.launchAgent)); owned(p.WorkingDirectory); owned(argv[1], false); executableIdentity(argv[0]);
    return { argv, working_directory: p.WorkingDirectory };
  };
  return {
    inventory, argvFromPlist,
    context: () => {
      const source = assertPublicRoot(layout, __dirname);
      const executable = fs.realpathSync(process.execPath);
      return { source: { ...source, identity: owned(source.repository) }, interpreter: { ...executableIdentity(executable), version: process.version } };
    },
    epoch: state.processStartToken,
    dead: owner => {
      if (owner.host !== os.hostname() || owner.uid !== process.getuid() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail('OWNER_IDENTITY');
      // ESRCH is the only death proof. A non-null epoch after ESRCH is PID reuse, never permission.
      try { process.kill(owner.pid, 0); fail('LIVE_OR_REUSED_OWNER'); }
      catch (e) { if (e.code !== 'ESRCH') throw new Error(`RETIREMENT_OWNER_UNCERTAIN:${e.message}`); }
      if (state.processStartToken(owner.pid) !== null) fail('REUSED_OWNER');
    },
    freeBytes: () => { const s = fs.statfsSync(layout.home, { bigint: true }); return s.bavail * s.bsize; },
    launchd: expected => {
      const r = spawnSync('/bin/launchctl', ['print', domain], { encoding: 'utf8', timeout: 20000 });
      const missing = `Could not find service "${LABEL}" in domain for user gui: ${process.getuid()}`;
      if (!r.error && r.status === 113 && [missing,`Bad request.\n${missing}`].includes(String(r.stderr || '').trim())) return { loaded: false };
      if (r.error || r.status !== 0) fail('LAUNCHD_UNREADABLE');
      const text = String(r.stdout), blocks = [...text.matchAll(/arguments = \{([\s\S]*?)\n\s*\}/g)];
      const argv = blocks.length === 1 ? blocks[0][1].trim().split('\n').map(s => s.trim()) : null;
      const paths = [...text.matchAll(/^\s*path = (.+)$/gm)].map(m => m[1]);
      const working = [...text.matchAll(/^\s*working directory = (.+)$/gm)].map(m => m[1]);
      if (!expected || paths.length !== 1 || paths[0] !== layout.launchAgent || working.length !== 1 || working[0] !== expected.working_directory || !same(argv, expected.argv)) fail('PLIST_LOADED_IDENTITY');
      if ([...text.matchAll(/^\s*state = (.+)$/gm)].length !== 1 || !/^\s*state = not running\s*$/m.test(text)) fail('LAUNCHD_STATE');
      if (/^\s*pid = \d+/m.test(text) || /^\s*state = running\s*$/m.test(text)) fail('LIVE_JANITOR');
      return { loaded: true, path: paths[0], argv, working_directory: working[0] };
    },
    bootout: () => command('/bin/launchctl', ['bootout', domain]),
    checkpoint: () => {},
    attachedObservation: () => require('./storage-authority-reseal.cjs').inspect(),
    withState: (image, read) => {
      const before = owned(image), temporary = fs.realpathSync(fs.mkdtempSync('/private/tmp/pentacle-state-inspect-'));
      const mount = path.join(temporary, 'State'); fs.mkdirSync(mount, { mode: 0o700 });
      const matches = () => inventory().filter(i => i.image === image || i.entities.some(e => e.mount === mount));
      if (matches().length) fail('INSPECTION_PREEXISTING');
      let attached = false, primary = null, result;
      try {
        command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image]); attached = true;
        const observed = matches(), disk = plist(command('/usr/sbin/diskutil', ['info', '-plist', mount]));
        if (observed.length !== 1 || observed[0].image !== image || observed[0].writable !== false
          || observed[0].entities.filter(e => e.mount).length !== 1 || observed[0].entities.find(e => e.mount === mount)?.device !== disk.DeviceNode
          || !readOnlyMount(disk, mount) || !same(before, owned(image))) fail('INSPECTION_MOUNT_IDENTITY');
        result = read(mount);
      } catch (error) { primary = error; }
      try {
        const observed = matches();
        if (observed.length) {
          if (!attached || observed.length !== 1 || observed[0].image !== image || observed[0].entities.filter(e => e.mount).length !== 1
            || !observed[0].entities.some(e => e.mount === mount && typeof e.device === 'string') || !same(before, owned(image))) fail('CLEANUP_FAIL:IDENTITY');
          command('/usr/bin/hdiutil', ['detach', mount]);
        }
        if (matches().length) fail('CLEANUP_FAIL:STILL_ATTACHED');
        fs.rmdirSync(mount); fs.rmdirSync(temporary);
      } catch (cleanup) { fail(`CLEANUP_FAIL:${primary?.message || 'none'}:${cleanup.message}`); }
      if (primary) throw primary;
      return result;
    },
  };
}

// Injection exists only in-process for fixtures. The executable accepts identity scalars, never paths.
function createRecovery(layout = fixedLayout(), platform = hostPlatform(layout)) {
  const retired = path.join(layout.home, 'Library/PentacleMobileStorageRetired');
  const archiveFor = generation => { if (!UUID.test(generation || '')) fail('GENERATION'); return path.join(retired, generation); };
  const context = () => ({ host: os.hostname(), uid: process.getuid(), ...platform.context() });
  const capacity = () => { const n = platform.freeBytes(); if (typeof n !== 'bigint' || n < BigInt(FLOOR)) fail('CAPACITY'); };
  const detached = () => {
    for (const i of platform.inventory()) if ([layout.support, retired].some(root => under(root, i.image) || i.entities.some(e => e.mount && under(root, e.mount)))) fail('ATTACHED');
  };
  const assertDead = owner => { if (!owner || owner.host !== os.hostname() || owner.uid !== process.getuid()) fail('OWNER_IDENTITY'); platform.dead(owner); };
  const rootsExpected = { scratch_images: layout.scratchImages, evidence_images: layout.evidenceImages, worktrees: layout.worktrees, repositories: layout.repositories };

  function census(root, attached = false) {
    const failures = [], check = action => { try { return action(); } catch (e) { failures.push(e.message); return null; } };
    // Authority identity is indispensable: never invent a generation from the directory name.
    owned(path.join(root, 'authority.json'), false);
    const authorityBytes = fs.readFileSync(path.join(root, 'authority.json')), authority = JSON.parse(authorityBytes);
    state.validateAuthorityShape(authority, { host: os.hostname(), uid: process.getuid(), roots: rootsExpected });
    check(() => state.validateStateLayout(root));
    if (!attached && fs.readdirSync(root).some(n => n.startsWith('.authority-reseal-') || n === 'authority-reseal.json')) failures.push('RETIREMENT_RESEAL_HISTORY_UNSUPPORTED');
    const roots = [], priorDevices = new Set(), owners = [], counts = {}, transactions = [];
    for (const [name, target] of Object.entries(rootsExpected)) for (const [p, prior] of name === 'repositories' ? Object.entries(target).map(([id,p]) => [p,authority.roots.repositories[id]]) : [[target,authority.roots[name]]]) {
      check(() => {
        const actual = { canonical:p, ...owned(p) };
        if (actual.device !== owned(layout.support).device) fail('ROOT_CROSS_DEVICE');
        for (const key of ['canonical','inode','uid','mode']) if (actual[key] !== prior[key]) fail('ROOT_DRIFT');
        priorDevices.add(prior.device); roots.push(actual);
      });
    }
    if (priorDevices.size !== 1) failures.push('RETIREMENT_ROOT_DEVICE_AMBIGUOUS');
    for (const kind of ['runs','tickets','scheduler']) {
      const directory = path.join(root, kind), files = exists(directory) ? fs.readdirSync(directory).sort() : [];
      counts[kind] = files.length;
      for (const name of files) check(() => {
        // Current state layout validates claims, but retirement never adopts an extant claim/lease/temp.
        if (!UUID.test(name.slice(0,-5)) || !name.endsWith('.json')) fail('CLAIM_OR_TEMP');
        owned(path.join(directory,name), false); const record = json(path.join(directory,name)); state.validateRecord(kind,record);
        if (record.id !== name.slice(0,-5) || record.generation !== authority.generation) fail('RECORD_GENERATION');
        if (kind === 'runs') { owners.push(record.owner); assertDead(record.owner); }
        if (kind === 'tickets') { owners.push(record.creator); assertDead(record.creator); if (record.state !== 'removed') fail('ACTIVE_TICKET'); }
        if (kind === 'scheduler') { if (!['committed','restored'].includes(record.state)) fail('SCHEDULER_INCOMPLETE'); transactions.push(record); }
      });
    }
    for (const name of fs.readdirSync(root).filter(n => n.endsWith('.lock'))) check(() => {
      const file = path.join(root,name); owned(file,false); const lock = json(file);
      if (name === 'scheduler.lock') { state.validateSchedulerLock(lock); if (lock.schema !== 2 || !lock.startToken) fail('LOCK_EPOCH_REQUIRED'); }
      else {
        const keys = ['schema','generation','host','uid','pid','token'];
        if (name === 'janitor.lock') keys.push('created_at');
        else if (name === 'gate.lock') { keys.push('created_at','claimed'); if (lock.claimed === true) keys.push('claimed_at'); }
        else if (name !== 'worktree.lock') fail('LOCK_UNKNOWN');
        if (!exactKeys(lock,keys) || lock.schema !== 1 || !/^[0-9a-f]{64}$/.test(lock.token || '') && !(name === 'janitor.lock' && UUID.test(lock.token || ''))) fail('LOCK_SCHEMA');
        if (keys.includes('created_at') && new Date(lock.created_at).toISOString() !== lock.created_at) fail('LOCK_CLOCK');
        if (name === 'gate.lock' && (typeof lock.claimed !== 'boolean' || lock.claimed === true && new Date(lock.claimed_at).toISOString() !== lock.claimed_at)) fail('LOCK_SCHEMA');
      }
      if (lock.generation !== authority.generation) fail('LOCK_GENERATION'); owners.push(lock); assertDead(lock);
    });
    const baseline = check(() => {
      owned(path.join(root,'scheduler-baseline.json'),false); const b = json(path.join(root,'scheduler-baseline.json'));
      if (!exactKeys(b,['captured_at','digest','existed','schema']) || b.schema !== 1 || b.existed !== false || b.digest !== null || new Date(b.captured_at).toISOString() !== b.captured_at) fail('SCHEDULER_BASELINE'); return b;
    });
    const committed = transactions.filter(t => t.state === 'committed').sort((a,b) => Date.parse(b.committed_at || b.recovered_at)-Date.parse(a.committed_at || a.recovered_at));
    if (!committed.length || committed.length > 1 && Date.parse(committed[0].committed_at || committed[0].recovered_at) === Date.parse(committed[1].committed_at || committed[1].recovered_at)) failures.push('RETIREMENT_SCHEDULER_AMBIGUOUS');
    const logical = check(() => manifest(root));
    return { generation:authority.generation, authority_preimage:authorityBytes.toString('base64'), authority_sha256:digest(authorityBytes), roots, previous_device:[...priorDevices][0] || null, owners, counts, baseline, committed_digest:committed[0]?.candidate_digest || null, logical_manifest:logical, failures };
  }

  function observe() {
    const ctx = context(); owned(layout.home); owned(path.join(layout.home,'Library'));
    const supportIdentity = owned(layout.support); owned(layout.stateImage);
    const inventory = platform.inventory();
    const attached = inventory.some(i => i.image === layout.stateImage || i.entities.some(e => e.mount === layout.state));
    if (attached) {
      const observation = platform.attachedObservation();
      const inner = census(layout.state,true), failures = [...inner.failures];
      let expected = null, scheduler = null;
      try { owned(layout.launchAgent,false); expected = platform.argvFromPlist(fs.readFileSync(layout.launchAgent)); }
      catch (error) { failures.push(error.message); }
      try { scheduler = platform.launchd(expected); }
      catch (error) { failures.push(error.message); }
      if (!require('./storage-scheduler.cjs').plistOwned(layout.launchAgent,inner.committed_digest)) failures.push('RETIREMENT_PLIST_DIGEST');
      if (!observation.normal_admission && observation.refusal !== 'AUTHORITY_ROOT_DRIFT') failures.push(`RETIREMENT_RESEAL_NOT_READY:${observation.refusal || 'unknown'}`);
      if (observation.journal && observation.journal.state !== 'committed') failures.push('RETIREMENT_RESEAL_HISTORY_NOT_READY');
      if (observation.reserved_temporaries?.length) failures.push('RETIREMENT_RESEAL_TEMPORARIES');
      return { attached:true, eligible:false, context:ctx, ...inner, scheduler, reseal:observation, failures:[...failures,'RETIREMENT_ATTACHED'] };
    }
    detached(); capacity();
    if (exists(retired) && owned(retired).device !== supportIdentity.device || owned(path.join(layout.home,'Library')).device !== supportIdentity.device) fail('ARCHIVE_CROSS_DEVICE');
    for (const mount of [layout.state,layout.scratchMount,layout.evidenceMount]) if (owned(mount).device !== supportIdentity.device || fs.readdirSync(mount).length) fail('MOUNT_NOT_EMPTY');
    const imageIdentity = owned(layout.stateImage), plistIdentity = owned(layout.launchAgent,false), plistBytes = fs.readFileSync(layout.launchAgent);
    const expected = platform.argvFromPlist(plistBytes), loaded = platform.launchd(expected);
    const inner = platform.withState(layout.stateImage,root => census(root));
    detached();
    if (!require('./storage-scheduler.cjs').plistOwned(layout.launchAgent,inner.committed_digest)) inner.failures.push('RETIREMENT_PLIST_DIGEST');
    const plan = { schema:1, attached:false, context:ctx, support_identity:supportIdentity, image_identity:imageIdentity, plist_identity:plistIdentity, plist_preimage:plistBytes.toString('base64'), plist_sha256:digest(plistBytes), scheduler:{ ...expected, ...loaded }, ...inner, manifest:manifest(layout.support) };
    return { ...plan, eligible:inner.failures.length === 0 };
  }
  function plan(generation) {
    archiveFor(generation);
    // Attached always refuses before opening a detached inspection resource.
    detached();
    if (exists(archiveFor(generation))) fail('ARCHIVE_EXISTS');
    const data = observe();
    if (data.generation !== generation) fail('GENERATION_MISMATCH');
    if (!data.eligible) fail(`CENSUS:${data.failures.join('|')}`);
    return { ...data, plan_digest:digest(canonical(data)) };
  }

  function apply(generation, reviewedDigest) {
    const archive = archiveFor(generation), file = path.join(archive,'retirement.json');
    if (!/^[0-9a-f]{64}$/.test(reviewedDigest || '')) fail('PLAN_DIGEST_REQUIRED');
    const lock = path.join(retired,'.retirement-lock'), resume = path.join(retired,'.retirement-resume');
    let journal, resuming = false, lease = null, leaseFile = null, successful = false;
    const phases = ['journaled','booted_out','plist_renamed','support_renamed','retired'];
    const checkJournal = j => {
      if (!exactKeys(j,['schema','generation','context','writer','phase','plan_digest','plan']) || j.schema !== 1 || j.generation !== generation || !phases.includes(j.phase)
        || j.plan_digest !== reviewedDigest || digest(canonical(j.plan)) !== j.plan_digest || j.plan.generation !== generation || !j.plan.eligible
        || !same(j.context,context()) || !same(j.context,j.plan.context) || !exactKeys(j.writer,['host','uid','pid','startToken','token','generation','plan_digest'])
        || !UUID.test(j.writer.token) || typeof j.writer.startToken !== 'string' || !j.writer.startToken.trim() || j.writer.generation !== generation || j.writer.plan_digest !== reviewedDigest) fail('ARCHIVE_JOURNAL');
    };
    if (exists(archive)) {
      owned(retired); owned(archive); if (fs.readdirSync(archive).some(n => !['retirement.json','support','janitor.plist'].includes(n))) fail('ARCHIVE_CONTENTS'); if (!exists(file)) fail('ARCHIVE_UNOWNED'); owned(file,false); journal = json(file); checkJournal(journal); resuming = true;
    } else {
      const observed = plan(generation), { plan_digest, ...data } = observed;
      if (plan_digest !== reviewedDigest) fail('PLAN_CHANGED');
      const startToken = platform.epoch(process.pid); if (typeof startToken !== 'string' || !startToken.trim()) fail('WRITER_EPOCH_UNAVAILABLE');
      const writer = { host:os.hostname(), uid:process.getuid(), pid:process.pid, startToken, token:crypto.randomUUID(), generation, plan_digest };
      journal = { schema:1, generation, context:data.context, writer, phase:'journaled', plan_digest, plan:data };
    }
    const archivedSupport = path.join(archive,'support'), archivedPlist = path.join(archive,'janitor.plist');
    const location = (from,to,expected,kind) => {
      const a = exists(from), b = exists(to); if (a === b) fail(`${kind}_BOTH_OR_NEITHER`);
      const current = b ? to : from;
      if (kind === 'SUPPORT' && !same(owned(current),journal.plan.support_identity)) fail('SUPPORT_IDENTITY');
      if (!same(kind === 'SUPPORT' ? manifest(current) : { identity:owned(current,false), sha256:digest(fs.readFileSync(current)) }, expected)) fail(`${kind}_DRIFT`);
      return b;
    };
    const verify = () => {
      if (!same(context(),journal.context)) fail('CONTEXT_DRIFT'); detached(); capacity();
      const supportMoved = location(layout.support,archivedSupport,journal.plan.manifest,'SUPPORT');
      const plistMoved = location(layout.launchAgent,archivedPlist,{identity:journal.plan.plist_identity,sha256:journal.plan.plist_sha256},'PLIST');
      const rank = phases.indexOf(journal.phase);
      if (rank === 0 && (supportMoved || plistMoved) || rank === 1 && supportMoved || rank >= 2 && !plistMoved || rank >= 3 && !supportMoved) fail('PHASE_LOCATION');
      const root = supportMoved ? archivedSupport : layout.support;
      for (const prior of journal.plan.roots) {
        const target = under(layout.support,prior.canonical) ? path.join(root,path.relative(layout.support,prior.canonical)) : prior.canonical;
        if (!same({canonical:prior.canonical,...owned(target)},prior)) fail('ROOT_DRIFT');
      }
      journal.plan.owners.forEach(assertDead);
      const loaded = platform.launchd(journal.plan.scheduler);
      if ((rank >= 1 || !journal.plan.scheduler.loaded) && loaded.loaded) fail('LABEL_REAPPEARED');
      return { supportMoved,plistMoved,loaded };
    };
    if (resuming) {
      verify();
      if (journal.phase === 'retired') {
        if (exists(resume)) fail('RESUME_LOCK_HELD');
        if (exists(lock)) { owned(lock,false); if (!same(json(lock),journal.writer)) fail('LOCK_DRIFT'); assertDead(journal.writer); fs.unlinkSync(lock); sync(retired); }
        return { status:'retired',generation,archive,plan_digest:reviewedDigest };
      }
      assertDead(journal.writer);
      if (!exists(lock)) fail('ORIGINAL_LOCK_MISSING_OR_CHANGED'); owned(lock,false); if (!same(json(lock),journal.writer)) fail('ORIGINAL_LOCK_MISSING_OR_CHANGED');
      if (exists(resume)) fail('RESUME_LOCK_HELD');
      const startToken = platform.epoch(process.pid); if (!startToken) fail('WRITER_EPOCH_UNAVAILABLE');
      lease = { ...journal.writer,pid:process.pid,startToken,token:crypto.randomUUID() }; leaseFile = resume;
    } else {
      fs.mkdirSync(retired,{recursive:true,mode:0o700}); owned(retired);
      if (exists(lock) || exists(resume)) fail('LOCK_HELD'); lease = journal.writer; leaseFile = lock;
    }
    const createLease = () => { const fd = fs.openSync(leaseFile,'wx',0o600); try { fs.writeFileSync(fd,JSON.stringify(lease)+'\n');fs.fsyncSync(fd); } finally {fs.closeSync(fd);} sync(retired); };
    const assertLease = () => { owned(leaseFile,false); if (!same(json(leaseFile),lease) || platform.epoch(process.pid) !== lease.startToken) fail('LOCK_DRIFT'); };
    createLease();
    try {
      if (!resuming) {
        platform.checkpoint('before-journal'); assertLease();
        // Repeat the full logical census immediately before establishing the original immutable baseline.
        const {plan_digest,...fresh} = plan(generation); if (plan_digest !== reviewedDigest || !same(fresh,journal.plan)) fail('PLAN_CHANGED');
        fs.mkdirSync(archive,{mode:0o700}); sync(retired); writeJournal(file,journal); platform.checkpoint('journaled');
      }
      const advance = phase => { assertLease(); journal.phase=phase; platform.checkpoint(`before-${phase}-journal`); writeJournal(file,journal); platform.checkpoint(phase); };
      let current = verify(); assertLease();
      if (journal.phase === 'journaled') {
        platform.checkpoint('before-bootout'); current=verify(); assertLease();
        if (current.loaded.loaded) platform.bootout(); platform.checkpoint('after-bootout');
        if (platform.launchd(journal.plan.scheduler).loaded) fail('BOOTOUT_FAILED'); advance('booted_out');
      }
      if (journal.phase === 'booted_out') {
        platform.checkpoint('before-plist-rename'); current=verify(); assertLease();
        if (!current.plistMoved) { fs.renameSync(layout.launchAgent,archivedPlist); platform.checkpoint('after-plist-rename'); }
        sync(path.dirname(layout.launchAgent));sync(archive);platform.checkpoint('plist-parents-synced');
        advance('plist_renamed');
      }
      if (journal.phase === 'plist_renamed') {
        platform.checkpoint('before-support-rename'); current=verify(); assertLease();
        if (!current.supportMoved) { fs.renameSync(layout.support,archivedSupport);platform.checkpoint('after-support-rename');}
        sync(path.dirname(layout.support));sync(archive);platform.checkpoint('support-parents-synced');
        advance('support_renamed');
      }
      verify(); advance('retired'); successful=true;
      return {status:'retired',generation,archive,plan_digest:reviewedDigest};
    } finally {
      // Keep the original writer lock with any interrupted journal. Never refresh its baseline/epoch.
      if (exists(leaseFile) && same(json(leaseFile),lease) && (leaseFile === resume || successful || !exists(file))) { fs.unlinkSync(leaseFile); sync(retired); }
      if (successful && resuming && exists(lock) && same(json(lock),journal.writer)) { fs.unlinkSync(lock);sync(retired); }
    }
  }
  return { inspect:observe,plan,apply };
}

if (require.main === module) {
  try {
    rejectEnvironmentAuthority();
    const args=process.argv.slice(2), [verb,generation,planDigest]=args;
    if (process.platform !== 'darwin' || os.homedir() !== os.userInfo().homedir || process.env.NODE_OPTIONS || process.env.NODE_PATH
      || !['inspect','plan','apply'].includes(verb) || args.length !== ({inspect:1,plan:2,apply:3}[verb])) fail('ARGUMENTS');
    const result=createRecovery()[verb](generation,planDigest);process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`);process.exitCode=1; }
}
module.exports={createRecovery,executableIdentity,hostPlatform,manifest,readOnlyMount};
