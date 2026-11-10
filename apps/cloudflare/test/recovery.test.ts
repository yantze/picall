import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { options, req, settled } from './helpers';

async function fixture(t:any) {
  const directory=await mkdtemp(join(tmpdir(),'picall-cloud-recovery-'));let mf=new Miniflare(options(directory));
  t.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
  return {get mf(){return mf;},async restart(){await mf.dispose();mf=new Miniflare(options(directory));},async internal(session:string,path:string,body?:unknown){
    const ns=await mf.getDurableObjectNamespace('SESSIONS');return ns.get(ns.idFromName(session)).fetch('https://internal/'+path,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  }};
}
test('persisted cancel intent is handled before PiHarness resumes an evicted model', {timeout:30000},async t=>{
  const f=await fixture(t),run:any=await(await req(f.mf,'/v1/runs',{prompt:'slow research'})).json();
  await f.internal(run.sessionId,'test-cancel-intent');
  const before:any=await(await f.internal(run.sessionId,'test-snapshot')).json();
  await f.restart();const done=await settled(f.mf,run.id);assert.equal(done.status,'cancelled');assert.equal(done.error.code,'request_cancelled');
  const after:any=await(await f.internal(run.sessionId,'test-snapshot')).json();assert.equal(after.calls,before.calls);
});
test('a committed answer finalizes after restart past its original deadline', {timeout:30000},async t=>{
  const f=await fixture(t),run:any=await(await req(f.mf,'/v1/runs',{prompt:'research'})).json();
  const first=await settled(f.mf,run.id),before:any=await(await f.internal(run.sessionId,'test-snapshot')).json();
  await f.internal(run.sessionId,'test-recover-answer',{id:run.id});await f.restart();
  const recovered=await settled(f.mf,run.id);assert.deepEqual(recovered.completion,first.completion);
  const after:any=await(await f.internal(run.sessionId,'test-snapshot')).json();assert.equal(after.calls,before.calls);
});
test('result retention expires old runs while preserving an active session and later answers', {timeout:30000},async t=>{
  const f=await fixture(t),run:any=await(await req(f.mf,'/v1/runs',{prompt:'research'})).json();await settled(f.mf,run.id);
  const next:any=await(await req(f.mf,'/v1/runs',{prompt:'next'},{'X-Session-Id':run.sessionId})).json();await settled(f.mf,next.id);
  await f.internal(run.sessionId,'test-expire-result',{id:run.id});await f.internal(run.sessionId,'test-prune');
  assert.equal((await req(f.mf,'/v1/runs/'+run.id)).status,404);
  assert.equal((await req(f.mf,'/v1/runs/'+next.id)).status,200);
  const continued=await req(f.mf,'/v1/chat/completions',{messages:[{role:'user',content:'still here'}]},{'X-Session-Id':run.sessionId});assert.equal(continued.status,200);
});
