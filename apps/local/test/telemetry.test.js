import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, completion } from './helpers.mjs';
import { configFingerprint } from '../src/durable-models.js';

test('each real model request receives a fresh budget without persisting or returning the reminder',async t=>{
  const f=await setup(t,{researchBudgetMode:'staged'}),run=await f.runtime.submit(completion('RESEARCH')),done=await f.runtime.wait(run.id);
  assert.equal(done.timings.model_requests,3);assert.equal(done.timings.tool_rounds,2);
  assert.equal(done.timings.budget_strategy,'staged');assert.equal(done.timings.initial_round_target,2);
  assert.equal(done.timings.budget_phase,'extended');assert.equal(done.timings.round_target,7);
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
test('the soft target permits needed research but never expands the SDK hard limit',async t=>{
  const f=await setup(t,{maxToolRounds:4,researchBudgetMode:'staged'}),run=await f.runtime.submit(completion('LOOP')),done=await f.runtime.wait(run.id);
  assert.equal(done.status,'failed');assert.equal(done.error.code,'turn_limit');
  assert.equal(f.services.requests.length,4);
  const messages=f.services.requests.map(request=>JSON.stringify(request.messages));
  assert.ok(messages[0].includes('Aim to finish within 2 tool rounds'));
  assert.ok(messages[2].includes('single extension phase'));
  assert.ok(messages[3].includes('No answer-safe tool rounds remain'));
  assert.equal(done.timings.hard_limit,4);assert.equal(done.timings.round_target,3);
});
test('a one-round hard limit does not offer an impossible extension',async t=>{
  const f=await setup(t,{maxToolRounds:1,researchBudgetMode:'staged'}),run=await f.runtime.submit(completion('PING')),done=await f.runtime.wait(run.id);
  assert.equal(done.status,'completed');assert.equal(done.timings.round_target,0);
  assert.equal(done.timings.budget_phase,'finalize');
  assert.ok(JSON.stringify(f.services.requests[0].messages).includes('No answer-safe tool rounds remain'));
});
test('baseline disables only reminders, preserves timings and remains compatible with an old default fingerprint',async t=>{
  const f=await setup(t,{budgetReminders:false}),run=await f.runtime.submit(completion('RESEARCH')),done=await f.runtime.wait(run.id);
  assert.equal(done.timings.budget_reminders,false);assert.equal(done.timings.model_requests,3);
  assert.equal(done.timings.budget_strategy,undefined);
  assert.ok(f.services.requests.every(request=>!JSON.stringify(request.messages).includes('RESEARCH BUDGET')));
  const {budgetReminders,researchBudgetMode,...old}=f.store.value;
  assert.equal(configFingerprint({...old,budgetReminders:true}),configFingerprint(old));
  assert.notEqual(configFingerprint(f.store.value),configFingerprint(old));
  assert.equal(configFingerprint({...old,researchBudgetMode:'fixed'}),configFingerprint(old));
  assert.notEqual(configFingerprint({...old,researchBudgetMode:'staged'}),configFingerprint(old));
});
test('provider timing includes the streamed body rather than stopping at response headers',async t=>{
  const f=await setup(t);f.services.readerBodyDelay=150;f.services.sourceDelay=500;
  const run=await f.runtime.submit(completion('RESEARCH')),done=await f.runtime.wait(run.id);
  const jina=done.timings.providers.jina;
  assert.equal(jina.completed_requests,1);assert.ok(jina.elapsed_ms-jina.headers_ms>=75,JSON.stringify(jina));
  assert.equal(done.timings.tools.fetch_content.completed_requests,1);
  assert.equal((await f.runtime.get(run.id)).timings.model_requests,3);
});
