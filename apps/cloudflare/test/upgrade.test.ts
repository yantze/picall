import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { options, req } from './helpers';

function legacyOptions(directory: string) {
  return options(directory, {}, 'legacy-worker.js');
}

for (const pending of [false, true]) test(`v1 SQLite upgrade preserves ${pending ? 'interrupted task records without replay' : 'answers, idempotency and full history'}`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picall-v1-upgrade-'));
  let mf = new Miniflare(legacyOptions(directory));
  try {
    const response = await mf.dispatchFetch('https://test/seed', { method: 'POST', body: JSON.stringify({ pending }) });
    assert.equal(response.status, 200, await response.clone().text());
    const old = await response.json() as any;
    await mf.dispose(); mf = new Miniflare(options(directory));
    const resultResponse = await req(mf, '/v1/runs/' + old.id);
    assert.equal(resultResponse.status, 200, await resultResponse.clone().text());
    const run = await resultResponse.json() as any;
    assert.equal(run.id, old.id); assert.equal(run.sessionId, old.session);
    if (pending) {
      assert.equal(run.status, 'failed'); assert.equal(run.error.code, 'process_interrupted');
      const ns = await mf.getDurableObjectNamespace('SESSIONS');
      const snapshot = await (await ns.get(ns.idFromName(old.session)).fetch('https://internal/test-snapshot')).json() as any;
      assert.equal(snapshot.calls, 1); assert.equal(snapshot.active, undefined);
    } else {
      assert.deepEqual(run.completion, old.completion);
      const body = { messages: [{ role: 'user', content: 'legacy question' }] };
      const repeated = await req(mf, '/v1/chat/completions', body, { 'Idempotency-Key': 'legacy-key' });
      assert.equal(repeated.status, 200, await repeated.clone().text());
      assert.deepEqual(await repeated.json(), old.completion);
      const next = await req(mf, '/v1/chat/completions', { messages: [...body.messages, old.completion.choices[0].message, { role: 'user', content: 'next question' }] }, { 'X-Session-Id': old.session });
      assert.equal(next.status, 200, await next.clone().text());
    }
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
