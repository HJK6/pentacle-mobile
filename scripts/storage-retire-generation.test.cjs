'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), test = require('node:test');
const { manifest, readOnlyMount } = require('./storage-retire-generation.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const JSONbytes = v => JSON.stringify(v)+'\n';
function fixture(t) {
  const home=fs.realpathSync(fs.mkdtempSync('/private/tmp/pm-retire-')),repo=path.join(home,'repos/pentacle-mobile-public'),support=path.join(home,'Library/PentacleMobileStorage');
  for(const p of [repo,path.join(home,'repos/pentacle-mobile'),path.join(home,'agent-workspace/worktrees'),path.join(home,'agent-workspace/pentacle-memory'),path.join(support,'Scratch'),path.join(support,'Evidence')])fs.mkdirSync(p,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(home,'fixture-owned'),'storage-retirement-test\n');fs.writeFileSync(path.join(home,'boundary.json'),JSONbytes({mounts:[],loaded:false}));
  fs.cpSync(__dirname,path.join(repo,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(repo,'node_modules'),{mode:0o700});fs.cpSync(path.join(__dirname,'../node_modules/yaml'),path.join(repo,'node_modules/yaml'),{recursive:true});
  fs.writeFileSync(path.join(repo,'.gitignore'),'node_modules/\n');
  const git = args => {const r=cp.spawnSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-q']);git(['config','user.name','Pentacle Agent']);git(['config','user.email','agent@users.noreply.github.com']);git(['add','scripts','.gitignore']);git(['commit','-qm','owned source fixture']);git(['remote','add','origin','https://github.com/HJK6/pentacle-mobile.git']);git(['update-ref','refs/remotes/origin/main',git(['rev-parse','HEAD'])]);
  const state=path.join(support,'State'),image=path.join(support,'State.sparsebundle'),inner=path.join(image,'.volume'),plist=path.join(home,'Library/LaunchAgents/com.pentacle.mobile.storage-janitor.plist'),configFile=path.join(home,'boundary.json');
  const f={home,repo,support,state,image,inner,plist,git,config:()=>JSON.parse(fs.readFileSync(configFile)),save:c=>fs.writeFileSync(configFile,JSONbytes(c))};
  f.run=(name,args=[],extra={})=>cp.spawnSync(process.execPath,['--require',path.join(repo,'scripts/storage-retire-generation-preload.cjs'),path.join(repo,'scripts',name),...args],{encoding:'utf8',timeout:20000,cwd:repo,env:{PATH:process.env.PATH,RETIRE_TEST_HOME:home,...extra}});
  f.utility=(args,env)=>f.run('storage-retire-generation.cjs',args,env);
  f.commands=()=>fs.existsSync(path.join(home,'commands.jsonl'))?fs.readFileSync(path.join(home,'commands.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  f.install=()=>{const r=f.run('storage-cli.cjs',['storage:install']);assert.equal(r.status,0,r.stderr);const tx=JSON.parse(r.stdout),authority=JSON.parse(fs.readFileSync(path.join(state,'authority.json'))),report=JSON.parse(fs.readFileSync(path.join(state,'reports',`${tx.smoke_report_id}.json`)));assert.equal(tx.state,'committed');assert.equal(report.transaction_id,tx.id);assert.equal(report.generation,authority.generation);assert.equal(sha(JSON.stringify(report)),tx.smoke_report_digest);assert.deepEqual(report.errors,[]);assert.match(fs.readFileSync(path.join(state,'logs/janitor.stderr.log'),'utf8'),/exit=0 signal=none/);return {tx,authority,report};};
  f.detach=()=>{const c=f.config();assert.equal(c.mounts.length,1);assert.equal(c.mounts[0].mount,state);for(const n of fs.readdirSync(state))fs.renameSync(path.join(state,n),path.join(inner,n));c.mounts=[];f.save(c);};
  f.prepare=()=>{const installed=f.install();f.generation=installed.authority.generation;fs.writeFileSync(path.join(support,'EvidenceImages/sentinel'),'retained neutral evidence',{mode:0o600});f.detach();return installed;};
  f.plan=()=>{const r=f.utility(['plan',f.generation]);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  f.archive=()=>path.join(home,'Library/PentacleMobileStorageRetired',f.generation);
  f.afterChildDeath=()=>{const c=f.config();const producers=fs.readFileSync(path.join(home,'producers.jsonl'),'utf8').trim().split('\n').map(JSON.parse);c.deadPids=producers.map(p=>p.pid);f.save(c);};
  t.after(()=>{assert.equal(f.config().mounts.length,0,'fixture has retained simulated mount');fs.rmSync(home,{recursive:true,force:true});});
  return f;
}
function snapshot(f) { return { support:manifest(f.support),plist:sha(fs.readFileSync(f.plist)) }; }
function unintended(commands) {return commands.filter(c=>c.binary==='/bin/launchctl' && ['bootout','bootstrap','kickstart'].includes(c.args[0]) || c.binary==='/usr/bin/hdiutil' && c.args[0]==='create');}
function refusal(f,args,pattern,env) {const before=snapshot(f),n=f.commands().length,r=f.utility(args,env);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,pattern);assert.deepEqual(snapshot(f),before);assert.deepEqual(unintended(f.commands().slice(n)),[]);return r;}

test('both disk Writable predicates are mandatory',()=>{const v={MountPoint:'/owned',Writable:false,WritableVolume:false};assert.equal(readOnlyMount(v,'/owned'),true);for(const k of ['Writable','WritableVolume']){assert.equal(readOnlyMount({...v,[k]:true},'/owned'),false);const c={...v};delete c[k];assert.equal(readOnlyMount(c,'/owned'),false);}});

test('actual utility inspect→digest plan→apply→ordinary current install; genuine wrapper/janitor report and unchanged archive',t=>{
  const f=fixture(t),old=f.prepare(),before=snapshot(f);
  let r=f.utility(['inspect']);assert.equal(r.status,0,r.stderr);const inspected=JSON.parse(r.stdout);assert.equal(inspected.generation,old.authority.generation);assert.equal(inspected.authority_sha256,sha(fs.readFileSync(path.join(f.inner,'authority.json'))));assert.equal(inspected.eligible,true);assert.deepEqual(snapshot(f),before);
  const plan=f.plan();assert.match(plan.plan_digest,/^[0-9a-f]{64}$/);assert.deepEqual(f.plan(),plan);
  refusal(f,['apply',f.generation,'0'.repeat(64)],/PLAN_CHANGED/);
  r=f.utility(['apply',f.generation,plan.plan_digest]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'retired');assert.equal(fs.existsSync(f.support),false);
  const archived=path.join(f.archive(),'support'),archiveManifest=manifest(archived);assert.deepEqual(archiveManifest,before.support);assert.equal(sha(fs.readFileSync(path.join(f.archive(),'janitor.plist'))),before.plist);
  r=f.utility(['apply',f.generation,plan.plan_digest]);assert.equal(r.status,0,r.stderr);
  const fresh=f.install();assert.notEqual(fresh.authority.generation,old.authority.generation);assert.deepEqual(manifest(archived),archiveManifest);assert.equal(fresh.tx.generation,fresh.authority.generation);
  const chain=fs.readFileSync(path.join(f.home,'producers.jsonl'),'utf8').trim().split('\n').map(JSON.parse),wrappers=chain.filter(p=>p.argv[1].endsWith('storage-janitor-scheduled.cjs')),children=chain.filter(p=>p.argv[2]==='storage:janitor');
  assert.equal(wrappers.length,2);assert.equal(children.length,4);for(const wrapper of wrappers)assert.ok(children.some(p=>p.ppid===wrapper.pid && p.argv[1].endsWith('storage-cli.cjs')));
  f.detach();
});

for(const kind of ['host','uid','generation','inode','missing-authority','altered-authority','reseal','foreign-claim','active-ticket','unfinished-scheduler','baseline','foreign-plist','nonempty-State','nonempty-Scratch','nonempty-Evidence','root-alias','hardlink','low-capacity','running-label','unreadable-label','live-owner','uncertain-owner','reused-owner','epoch-unavailable'])test(`retained negative ${kind}`,t=>{
  const f=fixture(t);f.prepare();const authorityFile=path.join(f.inner,'authority.json'),a=JSON.parse(fs.readFileSync(authorityFile));let expected=/RETIREMENT|AUTHORITY|STATE_LAYOUT|ENOENT|JSON/;
  if(['host','uid','generation','inode'].includes(kind)){if(kind==='host')a.host+='-foreign';if(kind==='uid')a.uid++;if(kind==='generation')a.generation=crypto.randomUUID();if(kind==='inode')a.roots.worktrees.inode='0';fs.writeFileSync(authorityFile,JSONbytes(a));}
  if(kind==='missing-authority')fs.unlinkSync(authorityFile);
  if(kind==='altered-authority')fs.writeFileSync(authorityFile,'{');
  if(kind==='reseal')fs.writeFileSync(path.join(f.inner,'authority-reseal.json'),'{}');
  if(kind==='foreign-claim')fs.writeFileSync(path.join(f.inner,'scheduler/.mutation-'+ 'a'.repeat(64)+'.claim'),'{}');
  if(kind==='active-ticket'){const id=crypto.randomUUID();fs.mkdirSync(path.join(f.inner,'tickets'));fs.writeFileSync(path.join(f.inner,'tickets',id+'.json'),JSONbytes({schema:1,id,generation:f.generation,revision:0,state:'registered',main_repo_id:'pentacle-mobile',spec_id:'spec_fixture',lane_id:'fixture',basename:'fixture',branch:'fixture',upstream:'origin/fixture',head:'a'.repeat(40),source_digest:'b'.repeat(64),device:'1',inode:'2',registered_at:new Date().toISOString(),creator:{host:os.hostname(),uid:process.getuid(),pid:900000}}));}
  if(kind==='unfinished-scheduler'){const file=path.join(f.inner,'scheduler',fs.readdirSync(path.join(f.inner,'scheduler'))[0]),tx=JSON.parse(fs.readFileSync(file));tx.state='candidate_installed';for(const k of ['smoke_report_id','smoke_report_digest','committed_at'])delete tx[k];fs.writeFileSync(file,JSONbytes(tx));}
  if(kind==='baseline')fs.writeFileSync(path.join(f.inner,'scheduler-baseline.json'),JSONbytes({schema:1,existed:true,digest:null,captured_at:new Date().toISOString()}));
  if(kind==='foreign-plist')fs.appendFileSync(f.plist,'changed');
  if(kind.startsWith('nonempty-'))fs.writeFileSync(path.join(f.support,kind.slice(9),'foreign'),'retained');
  if(kind==='root-alias'){const p=path.join(f.home,'agent-workspace/worktrees');fs.renameSync(p,p+'-original');fs.symlinkSync(p+'-original',p);}
  if(kind==='hardlink')fs.linkSync(path.join(f.support,'EvidenceImages/sentinel'),path.join(f.support,'EvidenceImages/alias'));
  const c=f.config();
  if(kind==='low-capacity')c.lowCapacity=true;if(kind==='running-label')c.running=true;if(kind==='unreadable-label')c.labelError=true;if(kind==='epoch-unavailable')c.epochUnavailable=true;
  if(['live-owner','uncertain-owner','reused-owner'].includes(kind)){const lock={schema:2,startToken:'original-epoch',transaction_id:null,token:crypto.randomUUID(),generation:f.generation,host:os.hostname(),uid:process.getuid(),pid:900000,created_at:new Date().toISOString()};fs.writeFileSync(path.join(f.inner,'scheduler.lock'),JSONbytes(lock),{mode:0o600});c[kind==='live-owner'?'live':kind==='uncertain-owner'?'uncertain':'reused']=900000;}
  f.save(c);
  // Alias/hardlink controls must preserve bytes even when the strict manifest itself refuses.
  if(['root-alias','hardlink'].includes(kind)){const before=fs.readFileSync(path.join(f.support,'EvidenceImages/sentinel'));const n=f.commands().length,r=f.utility(['plan',f.generation]);assert.notEqual(r.status,0);assert.deepEqual(fs.readFileSync(path.join(f.support,'EvidenceImages/sentinel')),before);assert.deepEqual(unintended(f.commands().slice(n)),[]);return;}
  if(kind==='epoch-unavailable'){const plan=f.plan();refusal(f,['apply',f.generation,plan.plan_digest],/EPOCH/);return;}
  refusal(f,['plan',f.generation],expected);
});

for(const argv of [[],['inspect','extra'],['plan'],['apply'],['apply','bad','0'.repeat(64)],['unknown'],['plan','/tmp/escape']])test(`closed arguments ${JSON.stringify(argv)}`,t=>{const f=fixture(t);f.prepare();refusal(f,argv,/RETIREMENT_(ARGUMENTS|GENERATION)/);});
for(const env of [{PENTACLE_STORAGE_STATE_ROOT:'/tmp/escape'},{NODE_PATH:'/tmp/escape'},{NODE_OPTIONS:'--no-warnings'}])test(`closed environment ${Object.keys(env)[0]}`,t=>{const f=fixture(t);f.prepare();refusal(f,['inspect'],/FORBIDDEN_AUTHORITY|RETIREMENT_ARGUMENTS/,env);});

test('source isolation refuses a foreign entry before any command',t=>{const f=fixture(t),n=f.commands().length;const r=cp.spawnSync(process.execPath,['--require',path.join(f.repo,'scripts/storage-retire-generation-preload.cjs'),'-e',"require('node:child_process').spawnSync('/usr/bin/hdiutil',['info','-plist'])"],{encoding:'utf8',env:{RETIRE_TEST_HOME:f.home}});assert.notEqual(r.status,0);assert.match(r.stderr,/SOURCE_ISOLATION/);assert.equal(f.commands().length,n);});

for(const seam of ['before-lock-open','lock-fsynced','before-journal-rename','after-journal-rename','before-bootout','after-bootout','before-plist-rename','after-plist-rename','before-support-rename','after-support-rename'])test(`crash ${seam}: exact resume or named retained failure`,t=>{
  const f=fixture(t);f.prepare();const plan=f.plan(),before=snapshot(f),r=f.utility(['apply',f.generation,plan.plan_digest],{RETIRE_TEST_CRASH:seam});assert.equal(r.status,91,r.stderr);f.afterChildDeath();
  const journal=path.join(f.archive(),'retirement.json'),original=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal)):null;
  const resumed=f.utility(['apply',f.generation,plan.plan_digest]);
  if(['before-journal-rename'].includes(seam)){assert.notEqual(resumed.status,0);assert.match(resumed.stderr,/ARCHIVE_UNOWNED|ARCHIVE_CONTENTS/);assert.deepEqual(snapshot(f),before);}
  else if(seam==='lock-fsynced'){assert.notEqual(resumed.status,0);assert.match(resumed.stderr,/LOCK_HELD/);assert.deepEqual(snapshot(f),before);}
  else {assert.equal(resumed.status,0,resumed.stderr);assert.deepEqual(manifest(path.join(f.archive(),'support')),before.support);const j=JSON.parse(fs.readFileSync(journal));if(original){assert.deepEqual(j.plan,original.plan);assert.deepEqual(j.writer,original.writer);assert.equal(j.plan_digest,original.plan_digest);}}
});

test('post-crash changed support and wrong digest never acquire a new baseline',t=>{const f=fixture(t);f.prepare();const plan=f.plan();assert.equal(f.utility(['apply',f.generation,plan.plan_digest],{RETIRE_TEST_CRASH:'after-journal-rename'}).status,91);f.afterChildDeath();const file=path.join(f.archive(),'retirement.json'),original=fs.readFileSync(file);fs.appendFileSync(path.join(f.support,'EvidenceImages/sentinel'),'changed');refusal(f,['apply',f.generation,'0'.repeat(64)],/JOURNAL/);refusal(f,['apply',f.generation,plan.plan_digest],/SUPPORT_DRIFT/);assert.deepEqual(fs.readFileSync(file),original);});

for(const kind of ['foreign-image','foreign-mount','duplicate-image','writable','writable-volume','wrong-device','foreign-loaded-argv','cross-device-archive'])test(`native identity refusal ${kind}`,t=>{
  const f=fixture(t);f.prepare();const c=f.config();
  if(kind==='foreign-image')c.inventoryExtra=[{'image-path':'/foreign/image','system-entities':[{'mount-point':f.state,'dev-entry':'/dev/disk99s1'}]}];
  if(kind==='foreign-mount')c.inventoryExtra=[{'image-path':path.join(f.support,'EvidenceImages/foreign'),'system-entities':[{'mount-point':'/foreign/mount','dev-entry':'/dev/disk99s1'}]}];
  if(kind==='duplicate-image')c.inventoryExtra=[{'image-path':f.image,'system-entities':[]}];
  if(kind==='writable')c.writable=true;if(kind==='writable-volume')c.writableVolume=true;if(kind==='wrong-device')c.wrongDevice=true;if(kind==='foreign-loaded-argv')c.foreignArgv=true;if(kind==='cross-device-archive')c.crossDeviceArchive=true;f.save(c);
  refusal(f,['plan',f.generation],/RETIREMENT/);
});
for(const seam of ['after-booted_out-journal-rename','after-plist_renamed-journal-rename','after-support_renamed-journal-rename','after-retired-journal-rename','before-plist-parent-fsync-0','after-plist-parent-fsync-0','before-plist-parent-fsync-1','after-plist-parent-fsync-1','before-support-parent-fsync-0','after-support-parent-fsync-0','before-support-parent-fsync-1','after-support-parent-fsync-1'])test(`durable crash ${seam} retains original transaction`,t=>{
  const f=fixture(t);f.prepare();const plan=f.plan(),before=snapshot(f),r=f.utility(['apply',f.generation,plan.plan_digest],{RETIRE_TEST_CRASH:seam});assert.equal(r.status,91,r.stderr);f.afterChildDeath();const journal=path.join(f.archive(),'retirement.json'),original=JSON.parse(fs.readFileSync(journal));const resumed=f.utility(['apply',f.generation,plan.plan_digest]);assert.equal(resumed.status,0,resumed.stderr);const j=JSON.parse(fs.readFileSync(journal));assert.deepEqual(j.plan,original.plan);assert.deepEqual(j.writer,original.writer);assert.equal(j.plan_digest,plan.plan_digest);assert.deepEqual(manifest(path.join(f.archive(),'support')),before.support);assert.equal(fs.existsSync(path.join(f.home,'Library/PentacleMobileStorageRetired/.retirement-lock')),false);
});
for(const kind of ['plist-both','plist-neither','plist-changed','support-both','support-neither','support-changed','writer-live','writer-no-epoch','resume-lock','partial-journal'])test(`interrupted retention ${kind}`,t=>{
  const f=fixture(t);f.prepare();const plan=f.plan(),seam=kind.startsWith('plist-')?'after-plist-rename':kind.startsWith('support-')?'after-support-rename':'after-journal-rename';assert.equal(f.utility(['apply',f.generation,plan.plan_digest],{RETIRE_TEST_CRASH:seam}).status,91);f.afterChildDeath();
  const journal=path.join(f.archive(),'retirement.json'),j=JSON.parse(fs.readFileSync(journal)),plist=path.join(f.archive(),'janitor.plist'),support=path.join(f.archive(),'support'),lock=path.join(f.home,'Library/PentacleMobileStorageRetired/.retirement-lock');
  if(kind==='plist-both')fs.copyFileSync(plist,f.plist);if(kind==='plist-neither')fs.renameSync(plist,path.join(f.home,'retained-plist'));if(kind==='plist-changed')fs.appendFileSync(plist,'changed');
  if(kind==='support-both')fs.mkdirSync(f.support);if(kind==='support-neither')fs.renameSync(support,path.join(f.home,'retained-support'));if(kind==='support-changed')fs.appendFileSync(path.join(support,'EvidenceImages/sentinel'),'changed');
  if(kind==='writer-live'){j.writer.pid=process.pid;fs.writeFileSync(journal,JSONbytes(j));fs.writeFileSync(lock,JSONbytes(j.writer));}
  if(kind==='writer-no-epoch'){delete j.writer.startToken;fs.writeFileSync(journal,JSONbytes(j));}
  if(kind==='resume-lock')fs.writeFileSync(path.join(f.home,'Library/PentacleMobileStorageRetired/.retirement-resume'),'foreign');
  if(kind==='partial-journal')fs.writeFileSync(journal,'{');
  const before=manifest(f.archive()),n=f.commands().length,r=f.utility(['apply',f.generation,plan.plan_digest]);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,/RETIREMENT|JSON|Unexpected|SyntaxError/);assert.deepEqual(manifest(f.archive()),before);assert.deepEqual(unintended(f.commands().slice(n)),[]);
});

test('claimed host lock uses its exact causal timestamp contract',t=>{const f=fixture(t);f.prepare();fs.writeFileSync(path.join(f.inner,'gate.lock'),JSONbytes({schema:1,generation:f.generation,host:os.hostname(),uid:process.getuid(),pid:900000,token:'a'.repeat(64),claimed:true,created_at:new Date().toISOString(),claimed_at:'invalid'}),{mode:0o600});refusal(f,['plan',f.generation],/RETIREMENT_CENSUS/);});
for(const phase of ['journaled','booted_out','plist_renamed','support_renamed','retired'])for(const edge of ['before','after'])test(`phase directory sync ${edge}-${phase}`,t=>{
  const f=fixture(t);f.prepare();const plan=f.plan(),before=snapshot(f),seam=`${edge}-${phase}-journal-parent-fsync-0`,r=f.utility(['apply',f.generation,plan.plan_digest],{RETIRE_TEST_CRASH:seam});assert.equal(r.status,91,r.stderr);f.afterChildDeath();const file=path.join(f.archive(),'retirement.json'),original=JSON.parse(fs.readFileSync(file));const resumed=f.utility(['apply',f.generation,plan.plan_digest]);assert.equal(resumed.status,0,resumed.stderr);const after=JSON.parse(fs.readFileSync(file));assert.deepEqual(after.writer,original.writer);assert.deepEqual(after.plan,original.plan);assert.deepEqual(manifest(path.join(f.archive(),'support')),before.support);
});
