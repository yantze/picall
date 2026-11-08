import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../src/pi-rpc.js';
import { ConfigStore } from '../src/config.js';
import { createApp } from '../src/server.js';
import { Logger } from '../src/logger.js';

// The installed Pi process, model adapter and extension API are real. Only the
// remote model/search/custom HTTP endpoints are replaced with loopback servers.
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'picall-local-runtime-'));
  const profile = join(root, 'profile');
  const workdir = join(root, 'project');
  await mkdir(profile);
  await mkdir(workdir);
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = profile;
  process.env.PI_OFFLINE = '1';
  const state = { calls: [], search: 0, reads: 0, looping: false };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/web/search')) {
        state.search++;
        assert.equal(req.headers['x-subscription-token'], 'brave-fixture-key');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ web: { results: [{ title: 'Current source', url: `${state.base}/source`, description: 'Current reliable source.' }] } }));
        return;
      }
      if (req.url.startsWith('/source')) {
        state.reads++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('A verified source says the answer is 42.');
        return;
      }
      let raw = '';
      for await (const part of req) raw += part;
      const data = JSON.parse(raw);
      state.calls.push({ data, authorization: req.headers.authorization });
      const stage = (state.calls.length - 1) % 3;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finishReason = null, usage) => res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-local-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'local-model', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
      })}\n\n`);
      chunk({ role: 'assistant' });
      if (stage < 2 || state.looping) {
        chunk({ content: 'Intermediate assistant narration must stay private.' });
        const search = stage === 0 || state.looping;
        chunk({ tool_calls: [{ index: 0, id: `call_${state.calls.length}`, type: 'function', function: {
          name: search ? 'web_search' : 'research_lookup', arguments: JSON.stringify(search ? { query: 'current verified fact' } : {}),
        } }] });
        chunk({}, 'tool_calls', { prompt_tokens: 10 * (stage + 1), completion_tokens: 3 + stage });
      } else {
        chunk({ content: 'The final verified answer is 42.' });
        chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 5 });
      }
      res.end('data: [DONE]\n\n');
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.config = {
    workdir, projectTrust: 'deny', enableExtensions: false, enableResearch: true,
    modelBaseUrl: `${state.base}/v1`, modelApiKey: '!literal-fixture-key', defaultModel: 'local-model',
    modelContextWindow: 32000, modelMaxTokens: 1024, requestTimeoutSeconds: 20, maxToolRounds: 8,
    braveBaseUrl: state.base, braveApiKey: 'brave-fixture-key',
    httpTools: [{ name: 'research_lookup', description: 'Read a verified fixture source.', url: `${state.base}/source`,
      parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    ...overrides,
  };
  state.runtime = new PiRuntime({ getConfig: () => state.config });
  t.after(async () => {
    await state.dispose?.();
    await state.runtime.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  });
  state.profile = profile;
  state.root = root;
  return state;
}

test('web configuration drives real Pi provider and built-in research with external extensions disabled', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const models = await f.runtime.models();
  const configured = models.find(model => model.id === 'picall/local-model');
  assert.equal(configured.contextWindow, 32000);
  assert.equal(configured.maxTokens, 1024);
  assert.deepEqual(configured.reasoningEfforts, ['off']);
  const session = await f.runtime.acquire({ model: 'picall/local-model' });
  for (const name of ['web_search', 'fetch_content', 'get_search_content', 'research_lookup']) {
    assert.ok(session.tools.includes(name), `${name} is declared without any external extension`);
  }
  const text = [];
  const result = await session.run('Search, read and answer.', { onText: delta => text.push(delta) });
  assert.equal(result.text, 'The final verified answer is 42.');
  assert.deepEqual(text, [result.text]);
  assert.deepEqual(result.usage, { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 });
  assert.equal(f.search, 1);
  assert.equal(f.reads, 1);
  assert.ok(f.calls.every(call => call.authorization === 'Bearer !literal-fixture-key'));
  assert.ok(JSON.stringify(f.calls[0].data.messages).includes('Current date in Asia/Shanghai'));
  assert.ok(f.calls[1].data.messages.some(message => message.role === 'tool' && message.content.includes('Current source')));
  assert.ok(f.calls[2].data.messages.some(message => message.role === 'tool' && message.content.includes('answer is 42')));

  const reused = await f.runtime.acquire({ sessionId: session.id, model: 'picall/local-model' });
  await reused.run('Repeat the same research in a fresh run.');
  assert.equal(f.search, 2, 'run cache must not reuse stale search content from an earlier prompt');
  assert.equal(f.reads, 2);
  const filenames = await readdir(f.profile);
  assert.ok(!filenames.includes('models.json'), 'managed provider must not write native Pi model settings');
  if (filenames.includes('auth.json')) {
    const auth = await readFile(join(f.profile, 'auth.json'), 'utf8');
    assert.ok(!auth.includes('!literal-fixture-key') && !auth.includes('brave-fixture-key'),
      'Pi may create its empty credential store, but managed credentials must not be copied into it');
  }
});

test('search and provider configuration changes invalidate existing session identity and model probes', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const before = await f.runtime.models();
  assert.equal(before.find(model => model.id === 'picall/local-model').contextWindow, 32000);
  const session = await f.runtime.acquire({ model: 'picall/local-model' });
  await session.run('Research once.');
  f.config.braveApiKey = 'rotated-brave-key';
  await assert.rejects(f.runtime.acquire({ sessionId: session.id, model: 'picall/local-model' }), error => error.code === 'session_configuration_changed');
  f.config.modelContextWindow = 64000;
  assert.equal((await f.runtime.models()).find(model => model.id === 'picall/local-model').contextWindow, 64000);
  f.config.modelApiKey = '';
  assert.ok(!(await f.runtime.models()).some(model => model.id === 'picall/local-model'), 'clearing a key removes the managed provider immediately');
});

test('real Pi stops before an excess tool round and never returns intermediate narration as success', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { maxToolRounds: 1 });
  f.looping = true;
  const session = await f.runtime.acquire({ model: 'picall/local-model' });
  const emitted = [];
  await assert.rejects(session.run('Keep searching forever.', { onText: text => emitted.push(text) }), error => error.code === 'turn_limit');
  assert.equal(f.search, 1, 'an excess tool round must not reach the provider');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(emitted, []);
  assert.deepEqual(f.runtime.list(), []);
});

test('HTTP settings, default and short model names, final-only JSON/SSE and result queries work through real Pi', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const configStore = new ConfigStore({ dataDir: join(f.root, 'app-data'), overrides: { workdir: f.config.workdir } });
  await configStore.load();
  const logger = new Logger();
  const runtime = new PiRuntime({ getConfig: () => configStore.value, logger });
  const app = createApp({ configStore, runtime, logger });
  f.dispose = async () => { await app.close(); logger.close(); };
  await app.ready;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { body, method = 'GET' } = {}) => fetch(`${base}${path}`, {
    method, headers: { Authorization: 'Bearer http-api-fixture-key', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const { workdir: _workdir, ...settings } = f.config;
  const savedResponse = await request('/api/config', { method: 'PUT', body: { ...settings, apiKey: 'http-api-fixture-key' } });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.modelApiKeyConfigured, true);
  assert.equal(saved.braveApiKeyConfigured, true);
  assert.equal(saved.modelApiKey, undefined);
  assert.equal(saved.braveApiKey, undefined);
  const models = await (await request('/v1/models')).json();
  assert.ok(models.data.some(model => model.id === 'picall/local-model'));

  const payload = { messages: [{ role: 'user', content: 'Research this current fact.' }] };
  const response = await request('/v1/chat/completions', { method: 'POST', body: payload });
  assert.equal(response.status, 200);
  const completed = await response.json();
  assert.equal(completed.model, 'picall/local-model');
  assert.equal(completed.choices[0].message.content, 'The final verified answer is 42.');
  assert.deepEqual(completed.usage, { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 });
  const runId = response.headers.get('x-run-id');
  assert.equal(completed.id, runId);
  assert.ok(runId.startsWith(`${response.headers.get('x-session-id')}~`));
  const queried = await (await request(`/v1/runs/${runId}`)).json();
  assert.equal(queried.status, 'completed');
  assert.deepEqual(queried.completion, completed);

  const streamed = await request('/v1/chat/completions', { method: 'POST', body: {
    ...payload, model: 'local-model', stream: true, stream_options: { include_usage: true },
  } });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const wire = await streamed.text();
  assert.ok(!wire.includes('Intermediate assistant narration'));
  assert.ok(wire.includes('The final verified answer is 42.'));
  assert.ok(wire.includes('data: [DONE]'));
  const frames = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.equal(frames.filter(frame => frame.choices?.[0]?.delta?.content).length, 1);
  assert.deepEqual(frames.at(-1).usage, { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 });
  assert.equal((await (await request(`/v1/runs/${streamed.headers.get('x-run-id')}`)).json()).status, 'completed');
  assert.equal(f.search, 2);
  assert.equal(f.reads, 2);
  assert.ok(!JSON.stringify(logger.history()).includes('!literal-fixture-key'));
  assert.ok(!JSON.stringify(queried).includes('brave-fixture-key'));
});
