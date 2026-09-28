'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');
const WebSocket = require('ws');
const subject = path.join(__dirname,'..','dashboard_hub_mock_server.cjs');

function fixtures() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'pentacle-public-dashboard-'));
  const put = (name,value) => fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
  put('synthetic.json',{dashboard_id:'synthetic.dashboard',data:{snapshots:{'synthetic-batch':{pipeline_summary:{skiptrace_gate:'open'}}}}});
  const names = ['reject_no_token','reject_device_without_scope','reject_invalid_batch',
                 'reject_invalid_gate','reject_invalid_setting','writer_failure'];
  put('contract.json',{cases:names.map((name,index)=>({case:name,response:{status:[401,403,400,400,400,500][index],body:{error:name}}}))});
  return {directory,args:['--port','0','--fixture-dir',directory,'--fixtures','synthetic.json',
    '--gate-contract',path.join(directory,'contract.json'),'--device-token','synthetic-write',
    '--readonly-token','synthetic-readonly','--dashboard-id','synthetic.dashboard']};
}
function until(predicate, milliseconds=5000) {
  return new Promise((resolve,reject)=>{
    const start=Date.now();
    const poll=setInterval(()=>{
      if(predicate()){clearInterval(poll);resolve();}
      else if(Date.now()-start>milliseconds){clearInterval(poll);reject(new Error('synthetic receipt timeout'));}
    },10);
  });
}

test('every configured input is required before binding a listener',()=>{
  const fixture=fixtures();
  try {
    for(const flag of ['port','fixture-dir','fixtures','gate-contract','device-token','readonly-token','dashboard-id']) {
      const args=fixture.args.slice();const index=args.indexOf('--'+flag);args.splice(index,2);
      const result=spawnSync(process.execPath,[subject,...args],{encoding:'utf8',timeout:5000});
      assert.equal(result.error,undefined);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,new RegExp('--'+flag+' is required'));
      assert.equal(result.stdout,'');
    }
  } finally {fs.rmSync(fixture.directory,{recursive:true});}
});

test('owned loopback server enforces scopes, updates state, broadcasts and stops',async(t)=>{
  const fixture=fixtures();
  const child=spawn(process.execPath,[subject,...fixture.args],{stdio:['ignore','pipe','pipe']});
  const lines=readline.createInterface({input:child.stdout});
  let ready=null;let stderr='';let socket;
  lines.on('line',(line)=>{ready=JSON.parse(line);});
  child.stderr.on('data',(chunk)=>{stderr+=chunk;});
  const exited=once(child,'exit');
  t.after(async()=>{
    socket?.terminate();
    if(child.exitCode===null){child.kill('SIGTERM');await exited;}
    lines.close();
    child.stdout.destroy();child.stderr.destroy();
    fs.rmSync(fixture.directory,{recursive:true});
  });
  await until(()=>ready || child.exitCode!==null);
  assert.equal(stderr,'');assert.equal(ready.ready,true);assert.equal(ready.host,'127.0.0.1');assert.ok(ready.port>0);
  const base='http://127.0.0.1:'+ready.port;
  assert.deepEqual(await (await fetch(base+'/health')).json(),{ok:true});
  const frames=[];
  socket=new WebSocket('ws://127.0.0.1:'+ready.port+'/live?token=synthetic-write');
  socket.on('message',(raw)=>frames.push(JSON.parse(String(raw))));
  await once(socket,'open');socket.send(JSON.stringify({type:'hello'}));
  await until(()=>frames.some((frame)=>frame.type==='snapshot'));
  assert.deepEqual(frames.find((frame)=>frame.type==='welcome').dashboards,['synthetic.dashboard']);
  const mutate=async(token,body)=>{
    const response=await fetch(base+'/control/batch-gate',{method:'POST',
      headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const valid={batch:'synthetic-batch',gate:'closed'};
  assert.deepEqual(await mutate(null,valid),{status:401,body:{error:'reject_no_token'}});
  assert.deepEqual(await mutate('synthetic-readonly',valid),{status:403,body:{error:'reject_device_without_scope'}});
  assert.equal((await mutate('synthetic-write',{...valid,gate:'invalid'})).body.error,'reject_invalid_gate');
  assert.equal((await mutate('synthetic-write',{...valid,batch:'unknown'})).body.error,'reject_invalid_batch');
  assert.equal((await mutate('synthetic-write',{...valid,batch:'__writer_failure__'})).status,500);
  const response=await mutate('synthetic-write',valid);
  assert.equal(response.status,200);assert.equal(response.body.changed,true);
  assert.equal(response.body.batch,'synthetic-batch');assert.equal(response.body.gate,'closed');
  await until(()=>frames.some((frame)=>frame.envelope?.data.snapshots['synthetic-batch'].pipeline_summary.skiptrace_gate==='closed'));
  assert.equal((await (await fetch(base+'/stats')).json()).gate_broadcasts,1);
  const closed=once(socket,'close');child.kill('SIGTERM');
  const [code,signal]=await exited;await closed;
  assert.equal(code,0);assert.equal(signal,null);
  assert.equal(stderr,'');
  await assert.rejects(fetch(base+'/health'));
});
