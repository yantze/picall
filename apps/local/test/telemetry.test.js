import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, completion } from './helpers.mjs';
import { configFingerprint } from '../src/durable-models.js';

test('each real model request receives a fresh budget without persisting or returning the reminder',async t=>{
  const f=await setup(t),run=await f.runtime.submit(completion('RESEARCH')),done=await f.runtime.wait(run.id);
  assert.equal(done.timings.model_requests,3);assert.equal(done.timings.tool_rounds,2);
  assert.deepEqual(done.timings.models.map(row=>row.tool_rounds_before_request),[0,1,2]);
  for(const [round,request] of f.services.requests.entries()) {
    const wire=JSON.stringify(request.messages);assert.ok(wire.includes(`RESEARCH BUDGET: ${round}/8`),wire);
    assert.equal(wire.match(/RESEARCH BUDGET:/g).length,1);
  }
  assert.ok(!done.completion.choices[0].message.content.includes('RESEARCH BUDGET'));
  assert.ok(done.timings.models.every(row=>Number.isFinite(row.elapsed_ms)));
  const handle=f.runtime.handles.get(run.sessionId);
  const entries=await handle.root.entries({},100,undefined,await import('@earendil-works/chord/context').then(module=>module.BACKGROUND_CONTEXT));
  assert.ok(!JSON.stringify(entries).includes('RESEARCH BUDGET'));
  assert.ok(f.logger.history().some(row=>row.details?.event==='model_finished'));
});
test('baseline disables only reminders, preserves timings and remains compatible with an old default fingerprint',async t=>{
  const f=await setup(t,{budgetReminders:false}),run=await f.runtime.submit(completion('RESEARCH')),done=await f.runtime.wait(run.id);
  assert.equal(done.timings.budget_reminders,false);assert.equal(done.timings.model_requests,3);
  assert.ok(f.services.requests.every(request=>!JSON.stringify(request.messages).includes('RESEARCH BUDGET')));
  const {budgetReminders,...old}=f.store.value;
  assert.equal(configFingerprint({...old,budgetReminders:true}),configFingerprint(old));
  assert.notEqual(configFingerprint(f.store.value),configFingerprint(old));
});
test('provider timing includes the streamed body rather than stopping at response headers',async t=>{
  const f=await setup(t);f.services.readerBodyDelay=150;f.services.sourceDelay=500;
  const run=await f.runtime.submit(completion('RESEARCH')),done=await f.runtime.wait(run.id);
  const jina=done.timings.providers.jina;
  assert.equal(jina.completed_requests,1);assert.ok(jina.elapsed_ms-jina.headers_ms>=75,JSON.stringify(jina));
  assert.equal(done.timings.tools.fetch_content.completed_requests,1);
  assert.equal((await f.runtime.get(run.id)).timings.model_requests,3);
});
