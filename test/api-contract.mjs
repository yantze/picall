import assert from 'node:assert/strict';
export async function assertAPIContract(request) {
  const models=await (await request('/v1/models')).json();
  const full=models.data[0].id, short=full.replace(/^picall\//,'');
  assert.ok(full.startsWith('picall/'));
  assert.equal((await request('/v1/models/'+encodeURIComponent(full))).status,200);
  assert.equal((await request('/v1/models/'+encodeURIComponent(short))).status,200);
  const invalid=await request('/v1/chat/completions',{method:'POST',body:{messages:[{role:'user',content:'hi'}],tools:[]}});assert.equal(invalid.status,400);
  for (const body of [null, [], {}, {messages:[{role:'tool',content:'untrusted'}]}]) {
    const response=await request('/v1/chat/completions',{method:'POST',body});assert.equal(response.status,400,JSON.stringify(body));
    const error=await response.json();assert.equal(error.error.type,'invalid_request_error');assert.equal(error.error.param,null);
  }
  for (const prompt of [undefined,0,[{type:'text',text:'not a prompt string'}],'   '])assert.equal((await request('/v1/runs',{method:'POST',body:{prompt}})).status,400);
  assert.equal((await request('/v1/runs/not-an-id')).status,404);
  const options={method:'POST',body:{prompt:'RESEARCH'},headers:{'Idempotency-Key':'shared-contract'}};
  const accepted=await request('/v1/runs',options);assert.equal(accepted.status,202);
  const first=await accepted.json();assert.equal(first.sessionId,accepted.headers.get('x-session-id'));assert.equal(first.id,accepted.headers.get('x-run-id'));
  assert.ok(Number.isFinite(first.createdAt));assert.ok(['pending','running','completed'].includes(first.status));
  const again=await (await request('/v1/runs',options)).json();assert.equal(again.id,first.id);
  assert.equal((await request('/v1/runs',{...options,body:{prompt:'different'}})).status,409);
  let done;const end=Date.now()+20000;
  do { done=await (await request('/v1/runs/'+first.id)).json();if(!['pending','running'].includes(done.status))break;await new Promise(resolve=>setTimeout(resolve,20)); } while(Date.now()<end);
  assert.equal(done.status,'completed',JSON.stringify(done));assert.ok(done.completion.choices[0].message.content);assert.ok(done.usage.total_tokens>0);
  assert.ok(done.timings.model_requests>0);assert.ok(done.timings.tool_rounds>0);assert.ok(done.timings.model_ms>=0);
  assert.equal(done.session_id,undefined);assert.equal(done.created_at,undefined);
  const body={model:short,messages:[{role:'user',content:'RESEARCH'}],stream:true,stream_options:{include_usage:true}};
  const streamed=await request('/v1/chat/completions',{method:'POST',body});assert.equal(streamed.status,200);
  const wire=await streamed.text();assert.match(wire,/\[DONE\]/);assert.doesNotMatch(wire,/Intermediate research/i);
  const chunks=wire.split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)));
  assert.ok(chunks.some(chunk=>chunk.usage?.total_tokens>0));assert.ok(chunks.some(chunk=>chunk.choices?.[0]?.delta?.content));
}
