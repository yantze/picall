import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunIndex,fingerprint,digest } from '../src/run-index.js';
import { DurableRuntime } from '../src/durable-runtime.js';
import { DEFAULTS } from '../src/config.js';
import { setup,completion,until } from './helpers.mjs';

async function directory(t){const path=await mkdtemp(join(tmpdir(),'picall-index-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
test('legacy results and idempotency import atomically without changing files; old sessions cannot continue',async t=>{
  const dataDir=await directory(t);await mkdir(join(dataDir,'runs'));
  const input=completion(),old={id:'legacy~run',sessionId:'legacy',status:'completed',createdAt:Date.now(),updatedAt:Date.now(),inputFingerprint:fingerprint(input),idempotencyHash:digest('old-key'),completion:{choices:[{message:{role:'assistant',content:'Saved answer'}}]}};
  const original=JSON.stringify(old);await writeFile(join(dataDir,'runs','legacy~run.json'),original);
  const interrupted={...old,id:'interrupted~run',sessionId:'interrupted',status:'running',idempotencyHash:undefined};await writeFile(join(dataDir,'runs',interrupted.id+'.json'),JSON.stringify(interrupted));
  const index=new RunIndex(dataDir);await index.open();assert.equal(index.lookup(input,{idempotencyKey:'old-key'}).completion.choices[0].message.content,'Saved answer');assert.equal(index.get(interrupted.id).error.code,'process_interrupted');
  assert.throws(()=>index.stage(input,input,{sessionId:'legacy'},'hash',1000),error=>error.code==='session_expired');
  assert.equal(await readFile(join(dataDir,'runs','legacy~run.json'),'utf8'),original);index.close();
  const again=new RunIndex(dataDir);await again.open();assert.equal(again.all().length,2);again.close();
});
test('interrupted legacy migration rolls back its records and marker before a clean retry',async t=>{
  const dataDir=await directory(t);await mkdir(join(dataDir,'runs'));
  for(const id of ['first','second'])await writeFile(join(dataDir,'runs',id+'~run.json'),JSON.stringify({id:id+'~run',sessionId:id,status:'completed',createdAt:Date.now(),updatedAt:Date.now()}));
  const interrupted=new RunIndex(dataDir),put=interrupted.put.bind(interrupted);let writes=0;
  interrupted.put=run=>{put(run);if(++writes===2)throw Error('simulated migration interruption');};
  await assert.rejects(interrupted.open(),/simulated migration interruption/);
  const retry=new RunIndex(dataDir);const migrate=retry.importLegacy.bind(retry);
  retry.importLegacy=async()=>{assert.equal(retry.all().length,0);assert.equal(retry.sessions().length,0);assert.equal(retry.db.prepare('SELECT value FROM meta WHERE key=?').get('legacy-v1'),undefined);await migrate();};
  await retry.open();assert.equal(retry.all().length,2);retry.close();
  const again=new RunIndex(dataDir);await again.open();assert.equal(again.all().length,2);again.close();
});
test('one writer owns a data directory and SQLite releases ownership on close',async t=>{
  const path=await directory(t),one=new RunIndex(path),two=new RunIndex(path);await one.open();await assert.rejects(two.open(),error=>error.code==='data_dir_locked');one.close();const three=new RunIndex(path);await three.open();three.close();
});
test('closing during startup releases the writer lock and leaves no recovering process',async t=>{
  const path=await directory(t),runtime=new DurableRuntime({dataDir:path,getConfig:()=>DEFAULTS});
  const starting=runtime.open();starting.catch(()=>{});await runtime.close();await assert.rejects(starting,error=>error.code==='unavailable');
  const index=new RunIndex(path);await index.open();index.close();assert.equal(runtime.handles.size,0);
});
test('TTL removes expired records and session files only after closing the idle session',async t=>{
  const path=await directory(t),index=new RunIndex(path);await index.open();
  const old=Date.now()-8*86400000;
  index.putSession({id:'expired',createdAt:old,lastUsedAt:old});index.put({id:'expired~run',sessionId:'expired',status:'completed',createdAt:old,updatedAt:old});
  const file=join(path,'sessions',digest('expired')+'.sqlite');await writeFile(file,'fixture');let closed=false;
  await index.cleanup(async id=>{assert.equal(id,'expired');assert.equal(await readFile(file,'utf8'),'fixture');closed=true;});
  assert.equal(closed,true);assert.equal(index.get('expired~run'),undefined);await assert.rejects(stat(file),{code:'ENOENT'});index.close();
});
test('idle handle eviction keeps the database and conversation available for continuation',async t=>{
  const f=await setup(t),run=await f.runtime.submit(completion());await f.runtime.wait(run.id);
  f.runtime.handles.get(run.sessionId).lastUsed=0;await f.runtime.reap();assert.equal(f.runtime.handles.has(run.sessionId),false);
  const next=await f.runtime.submit(completion('next'),{sessionId:run.sessionId});assert.equal((await f.runtime.wait(next.id)).status,'completed');
});
test('storage failures reject waiting clients, expose degraded health, and block fresh work',async t=>{
  const f=await setup(t);f.services.delay=200;
  const run=await f.runtime.submit(completion());const original=f.runtime.index.put.bind(f.runtime.index);
  f.runtime.index.put=()=>{throw Error('simulated disk failure');};
  await assert.rejects(f.runtime.wait(run.id),error=>error.code==='storage_error');
  assert.equal((await f.runtime.check()).available,false);await assert.rejects(f.runtime.submit(completion('next')),error=>error.code==='storage_error');
  f.runtime.index.put=original;
});
