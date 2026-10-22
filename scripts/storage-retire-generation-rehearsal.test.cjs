'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process');
const {identityGuard,sourceGuard}=require('./storage-retire-generation-rehearsal.cjs');
const SHA='a'.repeat(40),ARGS=['502',SHA];
const facts=()=>({uid:502,euid:502,username:'pmstoragerehearsal',home:'/Users/pmstoragerehearsal',userHome:'/Users/pmstoragerehearsal',environmentHome:'/Users/pmstoragerehearsal',execArgv:[],env:{}});

test('manual identity contract accepts only exact separately allocated real-account scalars',()=>{assert.deepEqual(identityGuard(ARGS,facts()),{uid:502,sha:SHA});});
for(const [field,value] of [['uid',501],['uid',0],['uid',503],['euid',0],['username','other'],['home','/tmp/rehearsal'],['userHome','/tmp/overridden'],['environmentHome','/tmp/overridden'],['execArgv',['--require','/tmp/preload.cjs']]])test(`real-context guard refuses ${field}=${JSON.stringify(value)}`,()=>{assert.throws(()=>identityGuard(ARGS,{...facts(),[field]:value}),/REAL_ACCOUNT_REQUIRED|PRELOAD_FORBIDDEN/);});
for(const args of [[],['502'],['502',SHA,'inspect'],['0',SHA],['501',SHA],['0502',SHA],['502','main'],['502','a'.repeat(39)],['/tmp/path',SHA]])test(`manual arguments refuse ${JSON.stringify(args)}`,()=>assert.throws(()=>identityGuard(args,facts()),/ARGUMENTS|REAL_ACCOUNT_REQUIRED/));
for(const env of [{NODE_OPTIONS:'--require /tmp/x'},{NODE_PATH:'/tmp/x'},{RETIRE_TEST_HOME:'/tmp/x'},{RESEAL_TEST_FIXTURE:'/tmp/x'},{PLANNING_FIXTURE:'/tmp/x'},{PENTACLE_STORAGE_STATE_ROOT:'/tmp/x'}])test(`real driver refuses ${Object.keys(env)[0]}`,()=>assert.throws(()=>identityGuard(ARGS,{...facts(),env}),/PRELOAD_FORBIDDEN|FORBIDDEN_AUTHORITY/));

test('real entry refuses this unallocated execution account before native/storage commands',()=>{
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,'storage-retire-generation-rehearsal.cjs'),...ARGS],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:require('node:os').homedir()}});
  assert.equal(r.status,1);assert.match(r.stderr,/REHEARSAL_REAL_ACCOUNT_REQUIRED/);
});

for(const values of [[SHA,SHA,`${SHA}\trefs/heads/other`],[SHA,'b'.repeat(40),`${SHA}\trefs/heads/main`],['b'.repeat(40),SHA,`${SHA}\trefs/heads/main`]])test(`source pin refuses ${JSON.stringify(values)}`,()=>assert.throws(()=>sourceGuard(SHA,...values),/SOURCE_PIN/));
