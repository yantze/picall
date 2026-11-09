import test from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { setup, completion, until } from './helpers.mjs';

test('health, configuration UI and configured model discovery require no generation request',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('/health')).status,200);
  assert.match(await (await f.request('/')).text(),/SQLite/);
  const status=await(await f.request('/api/status')).json();
  assert.equal(status.runtime.kind,'pi-durable');assert.equal(status.pi,undefined);
  const capabilities=await(await f.request('/api/capabilities')).json();
  assert.equal(capabilities.tools.length,3);assert.equal(capabilities.extensions,undefined);
  const models=await(await f.request('/v1/models')).json();
  assert.equal(models.data[0].id,'picall/fixture-model');
  assert.equal((await f.request('/v1/models/picall%2Ffixture-model')).status,200);
  assert.equal((await f.request('/v1/models/fixture-model')).status,200);
  assert.equal((await f.request('/v1/models/missing')).status,404);
  assert.equal(f.services.requests.length,0);
});

test('JSON and SSE return only the final answer with usage accumulated over real Durable tool rounds',async t=>{
  const f=await setup(t);
  for(const stream of [false,true]){
    const response=await f.request('/v1/chat/completions',{method:'POST',body:completion('RESEARCH',{model:'fixture-model',stream,stream_options:{include_usage:true}})});
    assert.equal(response.status,200);
    const id=response.headers.get('x-run-id');assert.ok(id);assert.ok(response.headers.get('x-session-id'));
    const wire=await response.text();
    assert.ok(!wire.includes('Intermediate research narration'));
    if(stream){assert.ok(wire.includes('[DONE]'));const chunks=wire.split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)));assert.equal(chunks.flatMap(chunk=>chunk.choices||[]).map(choice=>choice.delta?.content||'').join(''),'The final verified answer is 42.');assert.equal(chunks.find(chunk=>chunk.usage)?.usage.total_tokens,45);}
    else assert.equal(JSON.parse(wire).usage.total_tokens,45);
    assert.equal((await(await f.request('/v1/runs/'+id)).json()).status,'completed');
  }
});

test('only public v1 routes require the local bearer; management remains same-origin and cross-site navigation opens HTML',async t=>{
  const f=await setup(t,{apiKey:'pc-api-fixture-key'});
  assert.equal((await f.request('/v1/models')).status,401);
  assert.equal((await f.request('/api/config')).status,200);
  const headers={authorization:'Bearer pc-api-fixture-key',origin:'https://example.com'};
  const models=await f.request('/v1/models',{headers});assert.equal(models.status,200);assert.equal(models.headers.get('access-control-allow-origin'),'*');
  assert.equal((await f.request('/api/config',{method:'PUT',headers,body:{maxSessions:3}})).status,403);
  const preflight=await f.request('/v1/chat/completions',{method:'OPTIONS',headers});assert.equal(preflight.status,204);
  const navigate=(path,extra={})=>new Promise((resolve,reject)=>httpGet(f.base+path,{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document',...extra}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject));
  assert.equal(await navigate('/'),200);assert.equal(await navigate('/api/config'),403);assert.equal(await navigate('/',{'sec-fetch-dest':'iframe'}),403);assert.equal(await navigate('/',{host:'untrusted.example'}),403);
});

test('malformed and unsupported input fails before starting any task',async t=>{
  const f=await setup(t);
  for(const body of [{},{messages:[]},completion('PING',{stream:'yes'}),completion('PING',{tools:[]}),completion('PING',{temperature:3}),completion('PING',{messages:[{role:'tool',content:'x'}]})]){
    assert.equal((await f.request('/v1/chat/completions',{method:'POST',body})).status,400,JSON.stringify(body));
  }
  assert.equal((await f.request('/v1/chat/completions',{method:'POST',body:completion('PING',{model:'unavailable'})})).status,404);
  assert.equal((await f.request('/v1/chat/completions',{method:'POST',body:completion('PING',{reasoning_effort:'high'})})).status,400);
  assert.equal(f.services.requests.length,0);assert.equal(f.runtime.index.all().length,0);
});

test('full-history consistency and configuration conflicts do not destroy a valid persisted session',async t=>{
  const f=await setup(t);
  const first=await f.request('/v1/chat/completions',{method:'POST',body:completion('PING')});const value=await first.json();const sessionId=first.headers.get('x-session-id');
  const headers={'x-session-id':sessionId};
  const invalid={messages:[{role:'user',content:'different'},value.choices[0].message,{role:'user',content:'next'}]};
  const error=await f.request('/v1/chat/completions',{method:'POST',body:invalid,headers});assert.equal(error.status,409);assert.equal((await error.json()).error.code,'session_history_conflict');
  const valid={messages:[{role:'user',content:'PING'},value.choices[0].message,{role:'user',content:'next'}],reasoning_effort:null};
  assert.equal((await f.request('/v1/chat/completions',{method:'POST',body:valid,headers})).status,200);
  await f.store.update({braveApiKey:'rotated-fixture-key'});
  assert.equal((await f.request('/v1/chat/completions',{method:'POST',body:completion(),headers})).status,409);
});

test('async admission is durable, duplicate submissions share IDs, conflicts and same-session concurrency return 409',async t=>{
  const f=await setup(t,{maxSessions:1});f.services.delay=300;
  const options={method:'POST',body:{prompt:'SLOW PING'},headers:{'idempotency-key':'first-request'}};
  const responses=await Promise.all([f.request('/v1/runs',options),f.request('/v1/runs',options)]);
  assert.ok(responses.every(response=>response.status===202));const runs=await Promise.all(responses.map(response=>response.json()));assert.equal(runs[0].id,runs[1].id);
  const stored=f.runtime.index.get(runs[0].id);assert.ok(stored.submissionId);assert.ok(stored.deadline>stored.createdAt);
  assert.equal((await f.request('/v1/runs',{...options,body:{prompt:'changed'}})).status,409);
  assert.equal((await f.request('/v1/runs',{method:'POST',body:{prompt:'another'},headers:{'x-session-id':runs[0].sessionId}})).status,409);
  assert.equal((await f.request('/v1/runs',{method:'POST',body:{prompt:'another session'}})).status,503);
  const done=await f.runtime.wait(runs[0].id);assert.equal(done.status,'completed');
  await f.store.update({modelApiKey:'',defaultModel:'new-model'});
  const replay=await f.request('/v1/runs',options);assert.equal((await replay.json()).id,done.id);assert.equal(f.services.requests.length,1);
});

test('SSE disconnection stops waiting only; a later query returns the finished answer',async t=>{
  const f=await setup(t);f.services.delay=200;
  const response=await f.request('/v1/chat/completions',{method:'POST',body:completion('SLOW',{stream:true})});
  const id=response.headers.get('x-run-id');await response.body.cancel();
  const run=await f.runtime.wait(id);assert.equal(run.status,'completed');assert.equal(f.services.requests.length,1);
});

test('a concurrent idempotent retry cannot acknowledge index-only staging before Durable admission',async t=>{
  let release,staged=false;
  const paused=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{}, {runtime:{checkpoint:async phase=>{if(phase==='index-stored'){staged=true;await paused;}}}});
  const options={method:'POST',body:{prompt:'PING'},headers:{'idempotency-key':'staged-duplicate'}};
  const first=f.request('/v1/runs',options);await until(()=>staged);
  let acknowledged=false;const second=f.request('/v1/runs',options).then(response=>{acknowledged=true;return response;});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(acknowledged,false);assert.equal(f.services.requests.length,0);
  release();const responses=await Promise.all([first,second]);assert.ok(responses.every(response=>response.status===202));
  const [one,two]=await Promise.all(responses.map(response=>response.json()));assert.equal(one.id,two.id);assert.ok(f.runtime.index.get(one.id).submissionId);
});

test('explicit cancel persists and aborts the model; a late result cannot overwrite cancellation',async t=>{
  const f=await setup(t);f.services.delay=300;
  const response=await f.request('/v1/runs',{method:'POST',body:{prompt:'SLOW'}});const accepted=await response.json();
  await until(()=>f.services.requests.length);
  const cancel=await f.request('/v1/runs/'+accepted.id+'/cancel',{method:'POST'});assert.equal(cancel.status,200);assert.equal((await cancel.json()).status,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,350));assert.equal((await f.runtime.get(accepted.id)).status,'cancelled');
  assert.equal(f.runtime.index.get(accepted.id).needsAbort,false);
});

test('round limit, output limit, empty answer and provider failure remain explicit failures',async t=>{
  const f=await setup(t,{maxToolRounds:1});
  for(const [prompt,code] of [['LOOP','turn_limit'],['LENGTH','output_limit'],['EMPTY','unanswered'],['FAIL','provider_error']]){
    const response=await f.request('/v1/chat/completions',{method:'POST',body:completion(prompt)});
    assert.ok(response.status>=400,prompt);const data=await response.json();assert.equal(data.error.code,code,JSON.stringify(data));assert.ok(!JSON.stringify(data).includes('SECRET_PROVIDER_BODY_CANARY'));
  }
  assert.equal(f.services.search,1);
  const failed=f.runtime.index.all().find(run=>run.error?.code==='turn_limit');
  assert.equal(failed.service_calls.brave,1);assert.ok(failed.usage.total_tokens>0);
});

test('config readback and operational logs expose neither model/search keys nor request content',async t=>{
  const f=await setup(t);
  const prompt='PRIVATE_USER_PROMPT_CANARY';await(await f.request('/v1/chat/completions',{method:'POST',body:completion(prompt)})).json();
  const config=await(await f.request('/api/config')).text();const logs=await(await f.request('/api/logs')).text();
  for(const value of ['!literal-model-fixture','brave-fixture-key'])assert.ok(!config.includes(value)&&!logs.includes(value));
  assert.ok(!logs.includes(prompt));
});
