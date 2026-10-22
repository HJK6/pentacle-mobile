'use strict';
// Test-only native boundary. Never accepts a caller-selected production home.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const home = process.env.RETIRE_TEST_HOME;
if (!home || !/^\/private\/tmp\/pm-retire-[A-Za-z0-9-]+$/.test(home) || fs.realpathSync(home) !== home || fs.lstatSync(home).uid !== process.getuid() || fs.readFileSync(path.join(home, 'fixture-owned'), 'utf8') !== 'storage-retirement-test\n') throw new Error('FIXTURE_REQUIRED');
const repo = path.join(home, 'repos/pentacle-mobile-public'), support = path.join(home, 'Library/PentacleMobileStorage'), state = path.join(support, 'State'), image = path.join(support, 'State.sparsebundle');
if (!process.argv[1]?.startsWith(`${repo}/scripts/`)) throw new Error('SOURCE_ISOLATION');
const load = () => JSON.parse(fs.readFileSync(path.join(home, 'boundary.json')));
const save = c => fs.writeFileSync(path.join(home, 'boundary.json'), JSON.stringify(c));
const log = (binary, args) => fs.appendFileSync(path.join(home, 'commands.jsonl'), JSON.stringify({ binary, args, pid: process.pid })+'\n');
os.homedir = () => home;
const userInfo = os.userInfo;
os.userInfo = () => ({ ...userInfo(), homedir: home });
const origStat = fs.statSync, origLstat = fs.lstatSync, origStatfs = fs.statfsSync;
const mounted = target => load().mounts.some(m => target === m.mount || String(target).startsWith(`${m.mount}/`));
for (const [key, original] of [['statSync',origStat],['lstatSync',origLstat]]) fs[key] = function(target, opts) {
  const s = original.call(this, target, opts); if (s && typeof target === 'string' && load().crossDeviceArchive && target === path.join(home,'Library')) s.dev += typeof s.dev === 'bigint' ? 4n : 4;
  if (s && typeof target === 'string' && mounted(target)) { s.dev += typeof s.dev === 'bigint' ? 8n : 8; if (load().mounts.some(m=>m.mount===target)) s.ino = original.call(this,path.join(image,'.volume'),opts).ino; }
  return s;
};
fs.statfsSync = (target, opts) => {
  if (typeof target !== 'string' || !target.startsWith(home)) throw new Error('FIXTURE_STATFS_ESCAPE');
  const s = origStatfs(target, opts), big = opts?.bigint, num = n => big ? BigInt(n) : n;
  return { ...s, bsize:num(4096), blocks:num(mounted(target)?16384:50000000), bavail:num(load().lowCapacity?1:40000000) };
};
const originalKill = process.kill;
process.kill = (pid, signal) => {
  if (signal !== 0) throw new Error('FIXTURE_SIGNAL_DENIED');
  const c = load();
  if (pid === process.pid || pid === process.ppid) return originalKill(pid,0);
  if (c.live === pid) return true;
  if (c.uncertain === pid) throw Object.assign(new Error('uncertain'),{code:'EPERM'});
  throw Object.assign(new Error('dead'),{code:'ESRCH'});
};
const exec = cp.execFileSync, spawnSync = cp.spawnSync, spawn = cp.spawn;
function jsonPlist(bytes) {
  const s = String(bytes); if (/^[\[{]/.test(s)) return JSON.parse(s);
  const unxml = s => s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>');
  const field = name => unxml((s.match(new RegExp(`<key>${name}</key><string>(.*?)</string>`))||[])[1]||'');
  return { Label:field('Label'), WorkingDirectory:field('WorkingDirectory'), ProgramArguments:[...(s.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)||[])[1]?.matchAll(/<string>(.*?)<\/string>/g)||[]].map(m=>unxml(m[1])) };
}
function nodeArgs(args) {
  if (!Array.isArray(args) || !['storage-cli.cjs','storage-janitor-scheduled.cjs'].some(n=>args[0]===path.join(repo,'scripts',n))) throw new Error('FIXTURE_CHILD_SOURCE');
  if (!['storage:janitor'].includes(args[1]) || args[2] !== 'dry-run' || args.length !== 3) throw new Error('FIXTURE_CHILD_ARGS');
  return ['--require', __filename, ...args];
}
cp.execFileSync = (binary,args,options) => {
  log(binary,args);
  if (binary === '/usr/bin/git' && args.includes('-C') && args[args.indexOf('-C')+1]===repo && ['remote','config','rev-parse','status','merge-base'].includes(args[args.indexOf('-C')+2])) return exec(binary,args,options);
  if (binary === '/bin/ps' && JSON.stringify(args.slice(0,3))===JSON.stringify(['-o','lstart=','-p'])) {
    if (load().deadPids?.includes(Number(args[3]))) throw new Error('FIXTURE_DEAD_EPOCH');
    if (load().epochUnavailable) throw new Error('FIXTURE_EPOCH_UNAVAILABLE');
    return `${load().reused===Number(args[3])?'reused':'fixture'}-epoch-${args[3]}\n`;
  }
  throw new Error(`FIXTURE_EXEC_DENIED:${binary}:${args}`);
};
cp.spawn = (binary,args,options) => {
  log(binary,args);
  if (fs.realpathSync(binary) !== fs.realpathSync(process.execPath) || options?.cwd !== repo) throw new Error('FIXTURE_SPAWN_DENIED');
  return spawn(binary,nodeArgs(args),{...options,env:{...options.env,RETIRE_TEST_HOME:home}});
};
cp.spawnSync = (binary,args,options={}) => {
  log(binary,args); const c=load(), ok=stdout=>({status:0,signal:null,stdout:stdout||'',stderr:''});
  if (binary==='/usr/bin/plutil' && JSON.stringify(args)===JSON.stringify(['-convert','json','-o','-','--','-'])) return ok(JSON.stringify(jsonPlist(options.input)));
  if (binary==='/usr/bin/hdiutil') {
    if (args[0]==='info' && args[1]==='-plist') return ok(JSON.stringify({images:[...(c.inventoryExtra||[]),...c.mounts.map(m=>({'image-path':m.image,writeable:!m.ro,'image-type':'sparse bundle disk image','system-entities':[{'mount-point':m.mount,'dev-entry':'/dev/disk99s1'}]}))]}));
    if (args[0]==='create' && args.at(-1)===image && args.includes('64m')) { fs.mkdirSync(image,{mode:0o700}); fs.mkdirSync(path.join(image,'.volume'),{mode:0o700}); fs.writeFileSync(path.join(image,'fixture-image'),'64MiB'); return ok(); }
    if (args[0]==='attach' && args.at(-1)===image && args.includes('-mountpoint')) {
      const mount=args[args.indexOf('-mountpoint')+1];
      if (!(mount===state || mount.startsWith('/private/tmp/pentacle-state-inspect-')) || c.mounts.length || fs.readdirSync(mount).length) throw new Error('FIXTURE_MOUNT_DENIED');
      for (const n of fs.readdirSync(path.join(image,'.volume'))) fs.renameSync(path.join(image,'.volume',n),path.join(mount,n));
      c.mounts.push({image,mount,ro:args.includes('-readonly')});save(c);return ok();
    }
    if (args[0]==='detach' && args.length===2) {
      const m=c.mounts.find(m=>m.mount===args[1]);if(!m) throw new Error('FIXTURE_DETACH_DENIED');
      if(c.cleanupFail)return {status:1,stdout:'',stderr:'fixture cleanup refused'};
      for(const n of fs.readdirSync(m.mount)) fs.renameSync(path.join(m.mount,n),path.join(image,'.volume',n));
      c.mounts=[];save(c);return ok();
    }
  }
  if (binary==='/usr/sbin/diskutil' && args[0]==='info' && args[1]==='-plist') {
    const m=c.mounts.find(m=>m.mount===args[2]);if(!m)throw new Error('FIXTURE_DISK_DENIED');
    return ok(JSON.stringify({MountPoint:m.mount,DeviceNode:c.wrongDevice?'/dev/disk98s1':'/dev/disk99s1',Writable:c.writable?true:!m.ro,WritableVolume:c.writableVolume?true:!m.ro,FilesystemType:'apfs'}));
  }
  if(binary==='/bin/launchctl') {
    const domain=`gui/${process.getuid()}/com.pentacle.mobile.storage-janitor`;
    if(args[0]==='print' && args[1]===domain) {
      if(c.labelError)return {status:5,stdout:'',stderr:'unreadable'};
      if(!c.loaded)return {status:113,stdout:'',stderr:`Could not find service "com.pentacle.mobile.storage-janitor" in domain for user gui: ${process.getuid()}`};
      const p=jsonPlist(fs.readFileSync(path.join(home,'Library/LaunchAgents/com.pentacle.mobile.storage-janitor.plist')));
      return ok(`path = ${path.join(home,'Library/LaunchAgents/com.pentacle.mobile.storage-janitor.plist')}\nstate = not running\narguments = {\n${(c.foreignArgv?[...p.ProgramArguments.slice(0,3),'apply']:p.ProgramArguments).join('\n')}\n}\nworking directory = ${p.WorkingDirectory}\n${c.running?'pid = 88888\n':''}`);
    }
    if(args[0]==='bootstrap' && args[1]===`gui/${process.getuid()}` && args[2]===path.join(home,'Library/LaunchAgents/com.pentacle.mobile.storage-janitor.plist') && !c.loaded){c.loaded=true;save(c);return ok();}
    if(args[0]==='bootout' && args[1]===domain && c.loaded){crash('before-bootout');c.loaded=false;save(c);crash('after-bootout');return ok();}
    if(args[0]==='kickstart' && args[1]==='-k' && args[2]===domain && c.loaded){
      const p=jsonPlist(fs.readFileSync(path.join(home,'Library/LaunchAgents/com.pentacle.mobile.storage-janitor.plist')));
      return spawnSync(p.ProgramArguments[0],nodeArgs(p.ProgramArguments.slice(1)),{encoding:'utf8',timeout:10000,cwd:repo,env:{PATH:process.env.PATH,RETIRE_TEST_HOME:home}});
    }
  }
  throw new Error(`FIXTURE_NATIVE_DENIED:${binary}:${args}`);
};
// Observer receipt is test evidence only; reports are produced exclusively by the real janitor.
fs.appendFileSync(path.join(home,'producers.jsonl'),JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv,epoch:`fixture-epoch-${process.pid}`})+'\n');

// Crash only in the explicit test preload; production has no environment crash switch.
function crash(seam) { if (process.env.RETIRE_TEST_CRASH === seam) process.exit(91); }
const rename = fs.renameSync, open = fs.openSync, fsync = fs.fsyncSync;
let renameSyncReceipt=null;
fs.renameSync = function(from,to) {
  const phase = to.endsWith('/retirement.json') ? JSON.parse(fs.readFileSync(from)).phase : null;
  if(phase)crash(`before-${phase}-journal-rename`);
  const seam = to.endsWith('/retirement.json') ? 'journal' : to.endsWith('/janitor.plist') ? 'plist' : to.endsWith('/support') ? 'support' : null;
  if (seam) crash(`before-${seam}-rename`);
  const r = rename.apply(this,arguments); if (seam) {renameSyncReceipt={seam:phase?`${phase}-journal`:seam,count:0};crash(`after-${seam}-rename`);} if(phase)crash(`after-${phase}-journal-rename`);return r;
};
fs.openSync = function(file,flags) { if (typeof file === 'string' && file.endsWith('/.retirement-lock')) crash('before-lock-open'); return open.apply(this,arguments); };
fs.fsyncSync = function(fd) { if(renameSyncReceipt)crash(`before-${renameSyncReceipt.seam}-parent-fsync-${renameSyncReceipt.count}`);const r=fsync.apply(this,arguments);if(renameSyncReceipt){crash(`after-${renameSyncReceipt.seam}-parent-fsync-${renameSyncReceipt.count}`);if(++renameSyncReceipt.count>=2)renameSyncReceipt=null;} if (process.env.RETIRE_TEST_CRASH === 'lock-fsynced' && fs.existsSync(path.join(home,'Library/PentacleMobileStorageRetired/.retirement-lock')) && !fs.existsSync(path.join(home,'Library/PentacleMobileStorageRetired',load().generation||'', 'retirement.json'))) crash('lock-fsynced'); return r; };
