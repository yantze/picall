import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { mkdtemp,rm,readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { options,bindings,req,settled } from './helpers';

async function fixture(t:any){const dir=await mkdtemp(join(tmpdir(),'picall-management-'));let mf=new Miniflare(options(dir));t.after(async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});});return{dir,get mf(){return mf;},async restart(extra:Record<string,string>={}){await mf.dispose();mf=new Miniflare(options(dir,extra));}};}
async function login(mf:Miniflare){const response=await mf.dispatchFetch('https://test/api/auth/login',{method:'POST',headers:{origin:'https://test','content-type':'application/json'},body:JSON.stringify({token:bindings.ADMIN_TOKEN})});assert.equal(response.status,200,await response.clone().text());const cookie=response.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);return cookie.split(';')[0];}
const manage=(mf:Miniflare,cookie:string,path:string,body?:any,method=body===undefined?'GET':'PUT')=>mf.dispatchFetch('https://test'+path,{method,headers:{cookie,origin:'https://test','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('management auth is independent from API bearer, cookie login protects settings and rejects cross-origin writes',async t=>{
  const f=await fixture(t);
  assert.equal((await req(f.mf,'/api/config')).status,401);
  const bad=await f.mf.dispatchFetch('https://test/api/auth/login',{method:'POST',headers:{origin:'https://evil','content-type':'application/json'},body:JSON.stringify({token:bindings.ADMIN_TOKEN})});assert.equal(bad.status,403);
  const cookie=await login(f.mf);
  const publicConfig=await manage(f.mf,cookie,'/api/config');assert.equal(publicConfig.status,200);
  assert.equal((await f.mf.dispatchFetch('https://test/v1/models',{headers:{cookie}})).status,401);
  const cross=await f.mf.dispatchFetch('https://test/api/config',{method:'PUT',headers:{cookie,origin:'https://evil','content-type':'application/json'},body:'{}'});assert.equal(cross.status,403);
  assert.equal((await manage(f.mf,cookie,'/api/auth/logout',{},'POST')).status,200);
  assert.equal((await manage(f.mf,cookie,'/api/config')).status,401);
});
test('encrypted settings persist, clearing does not inherit env, concurrent revisions conflict and missing key never resets',async t=>{
  const f=await fixture(t),cookie=await login(f.mf);
  let config:any=await(await manage(f.mf,cookie,'/api/config')).json();assert.equal(config.braveApiKeyConfigured,true);assert.equal(config.braveApiKey,undefined);
  const secret='!literal-secret-canary-not-for-live-use';
  const patch={revision:config.revision,braveApiKey:secret};
  let saved=await manage(f.mf,cookie,'/api/config',patch);assert.equal(saved.status,200);config=await saved.json();assert.equal(config.braveApiKey,undefined);
  assert.equal((await manage(f.mf,cookie,'/api/config',patch)).status,409);
  assert.equal((await manage(f.mf,cookie,'/api/config',{revision:config.revision,apiKey:''})).status,400);
  await f.restart();assert.equal((await manage(f.mf,cookie,'/api/config')).status,200);
  const walk=async(path:string):Promise<Buffer[]>=>{const output:Buffer[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);output.push(...entry.isDirectory()?await walk(file):[await readFile(file)]);}return output;};
  assert.equal((await walk(f.dir)).some(buffer=>buffer.includes(secret)),false);
  saved=await manage(f.mf,cookie,'/api/config',{revision:config.revision,braveApiKey:''});assert.equal(saved.status,200);
  await f.restart();config=await(await manage(f.mf,cookie,'/api/config')).json();assert.equal(config.braveApiKeyConfigured,false);
  await f.restart({CONFIG_ENCRYPTION_KEY:'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='});
  const wrongKey=await manage(f.mf,cookie,'/api/config');assert.equal(wrongKey.status,503);assert.equal((await wrongKey.json() as any).error.code,'configuration_decryption_failed');
});
test('management playground uses login without exposing or supplying API bearer; token rotation revokes sessions',async t=>{
  const f=await fixture(t),cookie=await login(f.mf);
  const response=await manage(f.mf,cookie,'/api/playground',{messages:[{role:'user',content:'research'}],stream:false},'POST');assert.equal(response.status,200,await response.clone().text());
  const completion:any=await response.json();assert.match(completion.choices[0].message.content,/Final answer/);
  const run=await manage(f.mf,cookie,'/api/runs/'+completion.id);assert.equal((await run.json() as any).status,'completed');
  const status:any=await(await manage(f.mf,cookie,'/api/status')).json();assert.equal(status.runtime.kind,'pi-harness');assert.equal(status.capabilities.logDelivery,'poll');
  await f.restart({ADMIN_TOKEN:'a-rotated-management-token-for-test-only'});assert.equal((await manage(f.mf,cookie,'/api/config')).status,401);
});
test('configuration changed during eviction fails an unfinished run before a new model request',async t=>{
  const f=await fixture(t),cookie=await login(f.mf);
  const accepted:any=await(await req(f.mf,'/v1/runs',{prompt:'slow research'})).json();
  const ns=await f.mf.getDurableObjectNamespace('SESSIONS'), stub=ns.get(ns.idFromName(accepted.sessionId));
  const before:any=await(await stub.fetch('https://internal/test-snapshot')).json();
  const config:any=await(await manage(f.mf,cookie,'/api/config')).json();
  assert.equal((await manage(f.mf,cookie,'/api/config',{revision:config.revision,braveApiKey:'rotated-key-for-test'})).status,200);
  await f.restart();const run=await settled(f.mf,accepted.id);assert.equal(run.status,'failed');assert.equal(run.error.code,'session_configuration_changed');
  const recovered=await f.mf.getDurableObjectNamespace('SESSIONS');
  const after:any=await(await recovered.get(recovered.idFromName(accepted.sessionId)).fetch('https://internal/test-snapshot')).json();
  assert.equal(after.calls,before.calls);
});
test('late admission metadata cannot replace a completed result or regress management logs',async t=>{
  const f=await fixture(t),cookie=await login(f.mf),now=Date.now();
  const record={id:'fixture~run',sessionId:'fixture',status:'completed',model:'picall/fixture',createdAt:now-100,updatedAt:now};
  for(const value of [record,{...record,status:'running',updatedAt:now-10},{...record,prompt:'must-not-be-indexed'}]){
    assert.equal((await f.mf.dispatchFetch('https://test/test-management-record',{method:'POST',body:JSON.stringify(value)})).status,200);
  }
  const status:any=await(await manage(f.mf,cookie,'/api/status')).json();assert.equal(status.requests.active,0);
  const logs:any=await(await manage(f.mf,cookie,'/api/logs')).json();assert.equal(logs.logs.length,1);assert.equal(logs.logs[0].message,'Task completed.');
  assert.equal(JSON.stringify(logs).includes('must-not-be-indexed'),false);
});
test('budget reminders use durable rounds on Workers AI and can be disabled without disabling measurement',async t=>{
  const f=await fixture(t),cookie=await login(f.mf);
  const first:any=await(await req(f.mf,'/v1/runs',{prompt:'research'})).json();
  const done=await settled(f.mf,first.id);assert.equal(done.timings.model_requests,4);assert.equal(done.timings.tool_rounds,3);
  const ns=await f.mf.getDurableObjectNamespace('SESSIONS');
  const snapshot:any=await(await ns.get(ns.idFromName(first.sessionId)).fetch('https://internal/test-snapshot')).json();assert.deepEqual(snapshot.budgets,[0,1,2,3]);
  const config:any=await(await manage(f.mf,cookie,'/api/config')).json();
  assert.equal((await manage(f.mf,cookie,'/api/config',{revision:config.revision,budgetReminders:false})).status,200);
  const second:any=await(await req(f.mf,'/v1/runs',{prompt:'research'})).json(),baseline=await settled(f.mf,second.id);
  assert.equal(baseline.timings.budget_reminders,false);assert.equal(baseline.timings.model_requests,4);
  const plain:any=await(await ns.get(ns.idFromName(second.sessionId)).fetch('https://internal/test-snapshot')).json();assert.deepEqual(plain.budgets,[null,null,null,null]);
});
