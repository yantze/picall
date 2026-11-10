import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config.js';
import { RunIndex } from '../src/run-index.js';
import { completion, mockServices, until } from './helpers.mjs';

async function environment(t){
  const services=await mockServices(t),dataDir=await mkdtemp(join(tmpdir(),'picall-recovery-'));
  const store=new ConfigStore({dataDir});await store.load();await store.update({modelApiKey:'recovery-model-fixture',defaultModel:'fixture-model',modelBaseUrl:services.base+'/v1',braveApiKey:'fixture-search',braveBaseUrl:services.base,requestTimeoutSeconds:30});
  const children=[];t.after(async()=>{for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null)await child.kill();await rm(dataDir,{recursive:true,force:true});});
  const launch=async(phase='')=>{
    const process=fork(fileURLToPath(new URL('./fixtures/durable-child.mjs',import.meta.url)),[dataDir,services.base,phase],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
    const events=[];let errors='';process.stderr.on('data',value=>{errors+=value.toString();});process.on('message',message=>events.push(message));
    const exited=once(process,'exit');let request=0;
    const child={process,events,kill:async()=>{if(process.exitCode===null&&process.signalCode===null){process.kill('SIGKILL');await exited;}},
      wait:event=>until(()=>{const found=events.find(value=>value.event===event);if(found)return found;if(process.exitCode!==null)throw Error('Child exited: '+errors);},15000),
      call:async(type,args={})=>{const number=++request;process.send({type,request:number,...args});const reply=await until(()=>events.find(message=>message.event==='response'&&message.request===number),15000);if(reply.error)throw Object.assign(Error(reply.error.message),reply.error);return reply.value;},
      send:(type,args={})=>process.send({type,request:++request,...args}),
    };children.push(child);await child.wait('ready');return child;
  };
  const alter=async fn=>{const index=new RunIndex(dataDir);await index.open();try{await fn(index);}finally{index.close();}};
  return {services,dataDir,store,launch,alter};
}

for(const phase of ['index-stored','durable-submitted','answer-settled','before-finalize'])test(`SIGKILL at ${phase} recovers one durable input and the original run ID`,{timeout:30000},async t=>{
  const f=await environment(t),first=await f.launch(phase);
  first.send('submit',{input:completion('PING'),options:{idempotencyKey:'crash-once'}});
  const point=await first.wait('checkpoint');await first.kill();
  const second=await f.launch();
  const result=await second.call('wait',{id:point.id});assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(result.id,point.id);assert.equal(result.completion.choices[0].message.content,'The final verified answer is 42.');
  const inspected=await second.call('inspect',{id:point.id});assert.equal(inspected.submissions.filter(record=>record.type==='input').length,1);
  const replay=await second.call('submit',{input:completion('PING'),options:{idempotencyKey:'crash-once'}});assert.equal(replay.id,point.id);
  if(['answer-settled','before-finalize'].includes(phase))assert.equal(f.services.requests.length,1,'a committed final answer must never regenerate');
});

test('SIGKILL while the model streams resumes without returning partial assistant text',{timeout:30000},async t=>{
  const f=await environment(t);f.services.delay=5000;const first=await f.launch();
  const run=await first.call('submit',{input:completion('PING')});await until(()=>f.services.requests.length===1);await first.kill();f.services.delay=0;
  const second=await f.launch(),done=await second.call('wait',{id:run.id});assert.equal(done.status,'completed');assert.equal(done.completion.choices[0].message.content,'The final verified answer is 42.');assert.equal(f.services.requests.length,2);
});

test('SIGKILL during a tool keeps completed search results and replays only the unfinished read',{timeout:30000},async t=>{
  const f=await environment(t);f.services.readerDelay=5000;const first=await f.launch();
  const run=await first.call('submit',{input:completion('RESEARCH')});await until(()=>f.services.reader===1);await first.kill();f.services.readerDelay=0;
  const second=await f.launch(),done=await second.call('wait',{id:run.id});assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(f.services.search,1);assert.equal(f.services.reader,2);assert.equal(done.completion.usage.total_tokens,45);
});

test('expired staged input is failed before any model request after restart',{timeout:30000},async t=>{
  const f=await environment(t),first=await f.launch('index-stored');first.send('submit',{input:completion()});const point=await first.wait('checkpoint');await first.kill();
  await f.alter(index=>{const run=index.get(point.id);run.deadline=Date.now()-1;index.put(run);});
  const second=await f.launch(),done=await second.call('get',{id:point.id});assert.equal(done.status,'failed');assert.equal(done.error.code,'request_timeout');assert.equal(f.services.requests.length,0);
});

test('changed credentials fail an interrupted task without sending a new model request',{timeout:30000},async t=>{
  const f=await environment(t);f.services.delay=5000;const first=await f.launch();const run=await first.call('submit',{input:completion()});await until(()=>f.services.requests.length);await first.kill();
  await f.store.update({modelApiKey:'rotated-model-fixture'});f.services.delay=0;
  const second=await f.launch(),done=await second.call('get',{id:run.id});assert.equal(done.error.code,'session_configuration_changed');assert.equal(f.services.requests.length,1);
});

test('a persisted cancellation intent is handled before resume after SIGKILL',{timeout:30000},async t=>{
  const f=await environment(t);f.services.delay=5000;const first=await f.launch('cancel-intent');const run=await first.call('submit',{input:completion()});await until(()=>f.services.requests.length);first.send('cancel',{id:run.id});await first.wait('checkpoint');await first.kill();f.services.delay=0;
  const second=await f.launch(),done=await second.call('get',{id:run.id});assert.equal(done.status,'cancelled');assert.equal(f.services.requests.length,1);
});

test('tool-round count survives restart instead of granting a fresh budget',{timeout:30000},async t=>{
  const f=await environment(t);await f.store.update({maxToolRounds:1});const first=await f.launch('tool-start');first.send('submit',{input:completion('LOOP')});const point=await first.wait('checkpoint');await first.kill();
  const second=await f.launch(),done=await second.call('wait',{id:point.id});assert.equal(done.status,'failed');assert.equal(done.error.code,'turn_limit');assert.equal(f.services.requests.length,1);assert.equal(f.services.search,1);
});

test('an answer committed before the deadline remains successful when finalization resumes after the deadline',{timeout:30000},async t=>{
  const f=await environment(t),first=await f.launch('answer-settled');first.send('submit',{input:completion()});const point=await first.wait('checkpoint');await first.kill();
  await new Promise(resolve=>setTimeout(resolve,20));
  await f.alter(index=>{const run=index.get(point.id);run.deadline=Date.now()-1;index.put(run);});
  const second=await f.launch(),done=await second.call('get',{id:point.id});assert.equal(done.status,'completed');assert.equal(f.services.requests.length,1);
});

test('recovered tasks respect a reduced concurrency limit and queued recovery starts when a slot frees',{timeout:30000},async t=>{
  const f=await environment(t);await f.store.update({maxSessions:2});f.services.delay=5000;
  const first=await f.launch(),one=await first.call('submit',{input:completion('one')}),two=await first.call('submit',{input:completion('two')});
  await until(()=>f.services.requests.length===2);await first.kill();await until(()=>f.services.inflight===0);
  await f.store.update({maxSessions:1});f.services.delay=100;f.services.peak=0;
  const second=await f.launch();
  assert.equal((await second.call('wait',{id:one.id})).status,'completed');assert.equal((await second.call('wait',{id:two.id})).status,'completed');
  assert.equal(f.services.peak,1);assert.equal(f.services.requests.length,4);
});
