import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, completion } from './helpers.mjs';
import { DurableRuntime } from '../src/durable-runtime.js';

test('real Durable runs search -> read -> final answer, accumulates usage and persists tools',async t=>{
  const f=await setup(t);
  const run=await f.runtime.submit(completion('RESEARCH'));
  const result=await f.runtime.wait(run.id);
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(result.completion.choices[0].message.content,'The final verified answer is 42.');
  assert.equal(result.completion.usage.total_tokens,45);
  assert.equal(result.completion.usage.prompt_tokens,30);
  assert.equal(f.services.search,1);assert.equal(f.services.reader,1);
  assert.equal(f.services.authorizations[0],'Bearer !literal-model-fixture');
  assert.equal(result.service_calls.brave,1);assert.equal(result.service_calls.jina,1);
  assert.ok(f.services.requests[0].tools.every(tool=>['web_search','fetch_content','get_search_content'].includes(tool.function.name)));
  if(process.platform!=='win32')assert.equal((await stat(join(f.dataDir,'index.sqlite'))).mode&0o777,0o600);
  const bytes=await readFile(join(f.dataDir,'index.sqlite'));
  assert.ok(!bytes.includes(Buffer.from('!literal-model-fixture')));
});

test('configured JSON-schema GET tools execute through Durable and disabled tools are absent from the model',async t=>{
  const f=await setup(t);
  await f.store.update({toolOverrides:{web_search:false},httpTools:[{name:'lookup_document',description:'Read a fixture document',url:f.services.base+'/source',
    parameters:{type:'object',properties:{q:{type:'string'}},required:['q'],additionalProperties:false}}]});
  const run=await f.runtime.submit(completion('CUSTOM'));
  const done=await f.runtime.wait(run.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(f.services.source,1);
  assert.equal(done.service_calls['custom:lookup_document'],1);
  assert.ok(f.services.requests[0].tools.some(tool=>tool.function.name==='lookup_document'));
  assert.ok(!f.services.requests[0].tools.some(tool=>tool.function.name==='web_search'));
});

test('the execution deadline aborts an active model and persists timeout instead of success',async t=>{
  const f=await setup(t);f.services.delay=500;
  f.store.value={...f.store.value,requestTimeoutSeconds:0.1};
  const run=await f.runtime.submit(completion());const done=await f.runtime.wait(run.id);
  assert.equal(done.status,'failed');assert.equal(done.error.code,'request_timeout');assert.equal(f.services.requests.length,1);
});

test('Durable alone owns retry policy, bounded to two extra attempts, without persisting provider secrets',async t=>{
  const f=await setup(t);f.services.rateLimit=3;
  const run=await f.runtime.submit(completion()),done=await f.runtime.wait(run.id);
  assert.equal(done.status,'failed');assert.equal(f.services.requests.length,3);
  const handle=f.runtime.handles.get(run.sessionId),path=join(f.dataDir,'sessions');
  await f.runtime.close();
  const {readdir}=await import('node:fs/promises');
  for(const file of await readdir(path)){
    const bytes=await readFile(join(path,file));
    for(const value of ['!literal-model-fixture','brave-fixture-key','SECRET_PROVIDER_BODY_CANARY'])assert.ok(!bytes.includes(Buffer.from(value)),file);
  }
});

test('completed results and session history remain available after a close and reopen',async t=>{
  const f=await setup(t);
  const run=await f.runtime.submit(completion('PING'),{idempotencyKey:'persisted'});
  const first=await f.runtime.wait(run.id);
  await f.runtime.close();
  const runtime=new DurableRuntime({dataDir:f.dataDir,getConfig:()=>f.store.value,fetch:f.services.net});t.after(()=>runtime.close());await runtime.open();
  assert.deepEqual(await runtime.get(run.id),first);
  assert.equal((await runtime.lookup(completion('PING'),{idempotencyKey:'persisted'})).id,run.id);
  const next=await runtime.submit({messages:[{role:'user',content:'PING'},first.completion.choices[0].message,{role:'user',content:'Next question'}]},{sessionId:run.sessionId});
  assert.equal((await runtime.wait(next.id)).status,'completed');
  assert.ok(JSON.stringify(f.services.requests.at(-1).messages).includes('PING'));
});
