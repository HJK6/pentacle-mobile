#!/usr/bin/env node
'use strict';
// MANUAL ONLY. This driver is dormant until a separate FD grant provisions its real account/domain.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const authority=require('./storage-authority.cjs'),state=require('./storage-state.cjs');
const USER='pmstoragerehearsal',HOME='/Users/pmstoragerehearsal',LABEL='com.pentacle.mobile.storage-janitor';
const fail=code=>{throw new Error(`REHEARSAL_${code}`);},sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const exists=p=>fs.lstatSync(p,{throwIfNoEntry:false})!==undefined;
function identityGuard(args,facts) {
  if(args.length!==2 || !/^[1-9][0-9]*$/.test(args[0]) || !/^[0-9a-f]{40}$/.test(args[1]))fail('ARGUMENTS');
  const uid=Number(args[0]);
  if(!Number.isSafeInteger(uid)||[0,501].includes(uid)||facts.uid!==uid||facts.euid!==uid||facts.username!==USER||facts.home!==HOME||facts.userHome!==HOME||facts.environmentHome!==HOME)fail('REAL_ACCOUNT_REQUIRED');
  if(facts.execArgv.length||facts.env.NODE_OPTIONS||facts.env.NODE_PATH||Object.keys(facts.env).some(k=>/^(RETIRE_TEST_|RESEAL_TEST_|PLANNING_)/.test(k)))fail('PRELOAD_FORBIDDEN');
  authority.rejectEnvironmentAuthority(facts.env);return {uid,sha:args[1]};
}
function command(binary,args,input) {const r=cp.spawnSync(binary,args,{encoding:'utf8',input,timeout:30000,maxBuffer:8*1024*1024});if(r.error||r.status!==0)fail(`COMMAND:${path.basename(binary)}:${r.status}:${r.stderr||r.error}`);return r.stdout;}
function plist(binary,args) {const bytes=command(binary,args);return JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-','--','-'],bytes));}
function missingLabel(uid) {
  const r=cp.spawnSync('/bin/launchctl',['print',`gui/${uid}/${LABEL}`],{encoding:'utf8',timeout:10000});const missing=`Could not find service "${LABEL}" in domain for user gui: ${uid}`;
  return !r.error&&r.status===113&&[missing,`Bad request.\n${missing}`].includes(String(r.stderr||'').trim());
}
function owned(p,directory=true) {const s=fs.lstatSync(p);if(s.isSymbolicLink()||fs.realpathSync(p)!==p||s.uid!==process.getuid()||(s.mode&0o022)||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))fail('PATH_IDENTITY');return {canonical:p,device:String(s.dev),inode:String(s.ino),uid:s.uid,mode:s.mode&0o777};}
function durable(file,data) {const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(data)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
function sourceGuard(pinned,head,originMain,liveMain) {
  if(head!==pinned||originMain!==pinned||liveMain!==`${pinned}\trefs/heads/main`)fail('SOURCE_PIN');
}
function preflight(args) {
  const user=os.userInfo(),id=identityGuard(args,{uid:process.getuid(),euid:process.geteuid(),username:user.username,home:os.homedir(),userHome:user.homedir,environmentHome:process.env.HOME,execArgv:process.execArgv,env:process.env});
  const layout=authority.fixedLayout();
  const source=authority.assertPublicRoot(layout,__dirname);
  sourceGuard(id.sha,source.head,command('/usr/bin/git',['-C',source.repository,'rev-parse','refs/remotes/origin/main']).trim(),command('/usr/bin/git',['-C',source.repository,'ls-remote','--heads','origin','main']).trim());
  const directories=[HOME,path.join(HOME,'Library'),layout.schedulerRoot,layout.repositories['pentacle-mobile'],layout.worktrees,layout.memory];
  const identities=directories.map(p=>owned(p));
  if(identities.some(i=>i.device!==identities[0].device))fail('CROSS_DEVICE');
  if(fs.readdirSync(layout.worktrees).length||fs.readdirSync(layout.memory).length)fail('INITIAL_REFERENCE_NOT_EMPTY');
  const other=layout.repositories['pentacle-mobile'];
  owned(path.join(other,'.git'));
  if(command('/usr/bin/git',['-C',other,'rev-parse','--show-toplevel']).trim()!==other||fs.realpathSync(command('/usr/bin/git',['-C',other,'rev-parse','--path-format=absolute','--git-common-dir']).trim())!==path.join(other,'.git'))fail('SEALED_SOURCE');
  if(!fs.lstatSync(path.join(other,'.git')).isDirectory()||command('/usr/bin/git',['-C',other,'status','--porcelain=v1','--untracked-files=all'])||command('/usr/bin/git',['-C',other,'rev-parse','HEAD']).trim()!==id.sha||command('/usr/bin/git',['-C',other,'remote','get-url','origin']).trim()!=='https://github.com/HJK6/pentacle-mobile.git')fail('SEALED_SOURCE');
  if(exists(layout.support)||exists(layout.launchAgent)||!missingLabel(id.uid))fail('INITIAL_RESOURCES_EXIST');
  command('/bin/launchctl',['print',`gui/${id.uid}`]);
  const space=fs.statfsSync(HOME,{bigint:true});if(space.bavail*space.bsize<60n*2n**30n)fail('CAPACITY');
  const executable=fs.realpathSync(process.execPath),interpreter=require('./storage-retire-generation.cjs').executableIdentity(executable);
  if(!process.version.startsWith('v22.'))fail('NODE22_REQUIRED');
  return {id,layout,source,identities,node:{...interpreter,path:executable,version:process.version}};
}

// Separate owned observer keeps running while the actual installer waits for launchd's smoke.
function observerMain(c) {
  const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),state=require(path.join(c.repo,'scripts/storage-state.cjs'));
  const rows=[],errors=[];const write=(name,value)=>{const fd=fs.openSync(path.join(c.output,name),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const call=(binary,args)=>cp.spawnSync(binary,args,{encoding:'utf8',timeout:3000});
  write(`${c.tag}-observer-ready.json`,{pid:process.pid,epoch:state.processStartToken(process.pid),at:new Date().toISOString()});
  const deadline=Date.now()+20000;
  while(Date.now()<deadline&&!fs.existsSync(path.join(c.output,`${c.tag}-observer-stop`))) {
    const service=call('/bin/launchctl',['print',`gui/${c.uid}/com.pentacle.mobile.storage-janitor`]);
    let servicePid=null;
    if(service.status===0){const match=String(service.stdout).match(/^\s*pid = (\d+)\s*$/m);servicePid=match?Number(match[1]):null;}
    else if(service.status!==113){errors.push({kind:'launchctl',status:service.status,stderr:service.stderr});break;}
    const ps=call('/bin/ps',['-axo','pid=,ppid=,uid=,command=']);
    if(ps.status!==0){errors.push({kind:'ps',status:ps.status,stderr:ps.stderr});break;}
    for(const line of ps.stdout.split('\n')) {
      const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);if(!m||Number(m[3])!==c.uid)continue;
      const argv=m[4],wrapper=`${c.node} ${c.repo}/scripts/storage-janitor-scheduled.cjs storage:janitor dry-run`,child=`${c.node} ${c.repo}/scripts/storage-cli.cjs storage:janitor dry-run`;
      if(![wrapper,child].includes(argv))continue;
      const epoch=state.processStartToken(Number(m[1]));if(!epoch){errors.push({kind:'epoch',pid:Number(m[1])});continue;}
      rows.push({pid:Number(m[1]),ppid:Number(m[2]),uid:c.uid,epoch,argv,kind:argv===wrapper?'wrapper':'janitor',service_pid:servicePid,at:new Date().toISOString()});
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
  write(`${c.tag}-observer.json`,{rows,errors,expired:Date.now()>=deadline,ended_at:new Date().toISOString()});
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function observeInstall(c,tag,runCLI) {
  const child=cp.spawn(process.execPath,['-e',`(${observerMain.toString()})(${JSON.stringify({repo:c.source.repository,node:process.execPath,uid:c.id.uid,output:c.output,tag})})`],{cwd:c.source.repository,env:process.env,stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',b=>{error+=b;});const terminal=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,error})));
  const ready=path.join(c.output,`${tag}-observer-ready.json`),deadline=Date.now()+5000;
  try {
    while(!exists(ready)){if(Date.now()>deadline||child.exitCode!==null)fail(`HARNESS_ERROR:OBSERVER_READY:${error}`);await pause(10);}
    const receipt=JSON.parse(fs.readFileSync(ready));if(!receipt.epoch||receipt.pid!==child.pid)fail('HARNESS_ERROR:OBSERVER_EPOCH');
    const installed=await runCLI('storage-cli.cjs',['storage:install'],tag);
    fs.writeFileSync(path.join(c.output,`${tag}-observer-stop`),'stop',{flag:'wx',mode:0o600});
    const done=await terminal;if(done.code!==0||done.signal)fail(`HARNESS_ERROR:OBSERVER:${JSON.stringify(done)}`);
    const observations=JSON.parse(fs.readFileSync(path.join(c.output,`${tag}-observer.json`)));
    if(observations.errors.length||observations.expired)fail('HARNESS_ERROR:OBSERVER_INCOMPLETE');
    return {...installed,observations};
  } finally {
    if(!exists(path.join(c.output,`${tag}-observer-stop`)))fs.writeFileSync(path.join(c.output,`${tag}-observer-stop`),'stop',{flag:'wx',mode:0o600});
    const done=await terminal;if(done.code!==0||done.signal)durable(path.join(c.output,`${tag}-observer-cleanup-failure.json`),done);
  }
}
function verifyInstalled(c,install,tag) {
  const tx=install.value,a=state.validateInstalledAuthority(),file=path.join(c.layout.state,'reports',`${tx.smoke_report_id}.json`),bytes=fs.readFileSync(file),report=JSON.parse(bytes);
  if(tx.state!=='committed'||tx.generation!==a.generation||sha(JSON.stringify(report))!==tx.smoke_report_digest)fail('GENUINE_TRANSACTION_REPORT');
  const scheduler=require('./storage-scheduler.cjs');scheduler.validateSmokeReport(report,path.basename(file),install.started,{transaction_id:tx.id,generation:a.generation,candidate_digest:tx.candidate_digest});
  if(Date.parse(report.completed_at)>install.ended||!scheduler.plistOwned(c.layout.launchAgent,tx.candidate_digest))fail('REPORT_WINDOW_OR_PLIST');
  const rows=install.observations.rows,wrappers=rows.filter(r=>r.kind==='wrapper'&&r.service_pid===r.pid);
  if(!wrappers.some(w=>rows.some(r=>r.kind==='janitor'&&r.ppid===w.pid&&r.epoch&&Date.parse(r.at)>=install.started&&Date.parse(r.at)<=install.ended)))fail('HARNESS_ERROR:PRODUCER_CHAIN_MISSED');
  const expected=[process.execPath,path.join(c.source.repository,'scripts/storage-janitor-scheduled.cjs'),'storage:janitor','dry-run'];
  const parsed=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-','--','-'],fs.readFileSync(c.layout.launchAgent)));
  if(parsed.Label!==LABEL||parsed.WorkingDirectory!==c.source.repository||JSON.stringify(parsed.ProgramArguments)!==JSON.stringify(expected))fail('LOADED_PLIST');
  require('./storage-retire-generation.cjs').hostPlatform(c.layout).launchd({argv:expected,working_directory:c.source.repository});
  const stdout=fs.readFileSync(path.join(c.layout.state,'logs/janitor.stdout.log'),'utf8'),stderr=fs.readFileSync(path.join(c.layout.state,'logs/janitor.stderr.log'),'utf8');
  if(!stdout.includes(report.report_id)||!stderr.match(/exit=0 signal=none at=([^\]]+)/))fail('WRAPPER_LOGS');
  const footer=Date.parse(stderr.match(/exit=0 signal=none at=([^\]]+)/)[1]);if(footer<install.started||footer>install.ended)fail('WRAPPER_WINDOW');
  durable(path.join(c.output,`${tag}-verified.json`),{generation:a.generation,authority_sha256:sha(fs.readFileSync(path.join(c.layout.state,'authority.json'))),transaction:tx,report_file:file,report_sha256:sha(bytes),source:c.source,node:c.node,observations:install.observations});
  return {authority:a,transaction:tx};
}
function inventory() {const v=plist('/usr/bin/hdiutil',['info','-plist']);if(!Array.isArray(v.images))fail('INVENTORY');return v.images;}
function detachOwned(c,created) {
  const a=state.readAuthorityState();if(!created.has(a.generation))fail('CLEANUP_FAIL:GENERATION');
  const all=inventory(),matches=all.filter(i=>i['image-path']===c.layout.stateImage),mountMatches=all.filter(i=>(i['system-entities']||[]).some(e=>e['mount-point']===c.layout.state));
  const disk=plist('/usr/sbin/diskutil',['info','-plist',c.layout.state]);
  if(matches.length!==1||mountMatches.length!==1||matches[0]!==mountMatches[0]||matches[0].writeable!==true||disk.MountPoint!==c.layout.state||disk.Writable!==true||disk.WritableVolume!==true||(matches[0]['system-entities']||[]).filter(e=>e['mount-point']).length!==1||!matches[0]['system-entities'].some(e=>e['mount-point']===c.layout.state&&e['dev-entry']===disk.DeviceNode))fail('CLEANUP_FAIL:OWNED_MOUNT');
  durable(path.join(c.output,`detach-${a.generation}.json`),{generation:a.generation,image:owned(c.layout.stateImage),disk,attachment:matches[0]});
  command('/usr/bin/hdiutil',['detach',c.layout.state]);
  if(inventory().some(i=>i['image-path']===c.layout.stateImage||(i['system-entities']||[]).some(e=>e['mount-point']===c.layout.state)))fail('CLEANUP_FAIL:STILL_ATTACHED');
}
async function main(args) {
  const c=preflight(args),root=path.join(HOME,'agent-workspace/agent-outputs');
  if(!exists(root))fs.mkdirSync(root,{mode:0o700});owned(root);c.output=path.join(root,'storage-transition-rehearsal');if(exists(c.output))fail('EVIDENCE_EXISTS');fs.mkdirSync(c.output,{mode:0o700});durable(path.join(c.output,'context.json'),c);
  let sequence=0,primary=null,archived=null,archiveManifest=null;const created=new Set();
  async function runCLI(script,args,tag) {
    const started=Date.now(),n=++sequence,argv=[path.join(c.source.repository,'scripts',script),...args];durable(path.join(c.output,`${n}-intent.json`),{tag,argv:[process.execPath,...argv],started,source:c.source,node:c.node});
    const result=await new Promise(resolve=>{const child=cp.spawn(process.execPath,argv,{cwd:c.source.repository,env:process.env,stdio:['ignore','pipe','pipe'],timeout:60000,killSignal:'SIGTERM'});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',error=>resolve({error:String(error),stdout,stderr}));child.on('close',(status,signal)=>resolve({status,signal,stdout,stderr}));});
    const ended=Date.now();durable(path.join(c.output,`${n}-result.json`),{...result,started,ended});if(result.error||result.status!==0||result.signal)fail(`COMMAND_FAILED:${script}:${result.status}:${result.stderr}`);return {value:JSON.parse(result.stdout),started,ended};
  }
  try {
    const first=verifyInstalled(c,await observeInstall(c,'initial',runCLI),'initial');created.add(first.authority.generation);
    for(const p of [c.layout.scratchMount,c.layout.evidenceMount]){if(!exists(p))fs.mkdirSync(p,{mode:0o700});owned(p);if(fs.readdirSync(p).length)fail('FIXED_MOUNT_NOT_EMPTY');}
    fs.writeFileSync(path.join(c.layout.evidenceImages,'rehearsal-retained-byte'),'neutral preservation sentinel\n',{flag:'wx',mode:0o600});
    const utility=require('./storage-retire-generation.cjs');durable(path.join(c.output,'logical-state-preimage.json'),{authority:fs.readFileSync(path.join(c.layout.state,'authority.json')).toString('base64'),manifest:utility.manifest(c.layout.state),plist:fs.readFileSync(c.layout.launchAgent).toString('base64')});
    const attached=(await runCLI('storage-retire-generation.cjs',['inspect'],'attached-census')).value;if(!attached.attached||attached.failures.some(f=>f!=='RETIREMENT_ATTACHED'))fail('CENSUS_NOT_INACTIVE');
    detachOwned(c,created);const before=utility.manifest(c.layout.support);durable(path.join(c.output,'closed-support-preimage.json'),before);
    const inspected=(await runCLI('storage-retire-generation.cjs',['inspect'],'detached-inspect')).value;if(!inspected.eligible||inspected.generation!==first.authority.generation)fail('INNER_AUTHORITY');
    const plan=(await runCLI('storage-retire-generation.cjs',['plan',inspected.generation],'plan')).value;
    const applied=(await runCLI('storage-retire-generation.cjs',['apply',inspected.generation,plan.plan_digest],'apply')).value;
    archived=path.join(applied.archive,'support');archiveManifest=utility.manifest(archived);if(JSON.stringify(archiveManifest)!==JSON.stringify(before))fail('ARCHIVE_CHANGED');
    const second=verifyInstalled(c,await observeInstall(c,'fresh',runCLI),'fresh');created.add(second.authority.generation);if(second.authority.generation===first.authority.generation)fail('GENERATION_REUSED');
    if(JSON.stringify(utility.manifest(archived))!==JSON.stringify(archiveManifest))fail('ARCHIVE_CHANGED');
    durable(path.join(c.output,'sequence-pass.json'),{old_generation:first.authority.generation,new_generation:second.authority.generation,plan_digest:plan.plan_digest,archive:applied.archive,scope:'disposable real integration only; no production-host/native admission'});
  } catch(error) {primary=error;durable(path.join(c.output,'original-failure.json'),{error:error.message,at:new Date().toISOString()});}
  finally {
    try {
      if(exists(path.join(c.layout.state,'authority.json'))){const a=state.validateInstalledAuthority();if(!created.has(a.generation))fail('CLEANUP_FAIL:UNRECOGNIZED_OR_PARTIAL_INSTALL');await runCLI('storage-cli.cjs',['storage:uninstall'],'cleanup-uninstall');detachOwned(c,created);}
      if(!missingLabel(c.id.uid)||inventory().some(i=>[c.layout.stateImage,archived&&path.join(archived,'State.sparsebundle')].includes(i['image-path'])))fail('CLEANUP_FAIL:RESOURCES_RETAINED');
      const receipts=fs.readdirSync(c.output).filter(n=>n.endsWith('-observer.json')).flatMap(n=>JSON.parse(fs.readFileSync(path.join(c.output,n))).rows);
      for(const r of receipts){const epoch=state.processStartToken(r.pid);try{process.kill(r.pid,0);fail('CLEANUP_FAIL:LIVE_OR_REUSED_PRODUCER');}catch(e){if(e.code!=='ESRCH')throw e;}if(epoch!==null)fail('CLEANUP_FAIL:REUSED_OR_UNREADABLE_PRODUCER');}
      if(archived&&JSON.stringify(require('./storage-retire-generation.cjs').manifest(archived))!==JSON.stringify(archiveManifest))fail('CLEANUP_FAIL:ARCHIVE_CHANGED');
      durable(path.join(c.output,'cleanup-pass.json'),{owned_mounts:0,owned_labels:0,live_producers:0,preserved_support_and_archive:true});
    }catch(error){durable(path.join(c.output,'cleanup-failure.json'),{primary:primary?.message||null,cleanup:error.message});if(!primary)primary=error;}
  }
  if(primary)throw primary;return {status:'passed',output:c.output};
}
if(require.main===module)main(process.argv.slice(2)).then(v=>process.stdout.write(JSON.stringify(v)+'\n')).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
module.exports={identityGuard,sourceGuard,preflight,main};
