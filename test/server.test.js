import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { ConfigStore } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { PiRuntime } from '../src/pi-rpc.js';

const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const completion = (content = 'Say hello', extra = {}) => ({
  model: 'fake/fake-model', messages: [{ role: 'user', content }], ...extra,
});

async function setup(t, settings = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'picall-test-'));
  const configStore = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
  await configStore.load();
  await configStore.update({ model: 'fake/fake-model', ...settings });
  const logger = new Logger({ dataDir });
  const runtime = new PiRuntime({ getConfig: () => configStore.value, logger,
    command: { file: process.execPath, args: [fakePi] } });
  const app = createApp({ configStore, runtime, logger });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { method = 'GET', body, headers = {}, ...options } = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options,
  });
  t.after(async () => {
    await app.close();
    await runtime.close();
    logger.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base, request, runtime, logger, configStore, dataDir };
}

async function waitUntil(check, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not reached before timeout');
}

test('health, static UI, status and models are served without model traffic', async (t) => {
  const { request } = await setup(t);
  assert.equal((await request('/health')).status, 200);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /PiCall/i);
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/styles.css')).status, 200);
  const statusResponse = await request('/api/status');
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.pi.available, true);
  assert.equal(status.sessions.total, 0);
  const modelsResponse = await request('/v1/models');
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.equal(models.object, 'list');
  assert.ok(models.data.some((model) => model.id === 'fake/fake-model'));
  const managementModels = await (await request('/api/models')).json();
  assert.equal(managementModels.models[0].provider, 'fake');
});

test('non-streaming completion waits for agent_settled and reports OpenAI usage', async (t) => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', { method: 'POST', body: completion() });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-session-id'));
  const result = await response.json();
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.model, 'fake/fake-model');
  assert.equal(result.choices[0].message.role, 'assistant');
  assert.equal(result.choices[0].message.content, 'Hello from Pi (turn 1)');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
});

test('SSE returns content deltas, a final reason, usage when requested and [DONE]', async (t) => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', { method: 'POST',
    body: completion('Stream hello', { stream: true, stream_options: { include_usage: true } }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const wire = await response.text();
  const data = wire.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  assert.equal(data.at(-1), '[DONE]');
  const chunks = data.filter((line) => line !== '[DONE]').map((line) => JSON.parse(line));
  assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'));
  assert.equal(chunks.flatMap((chunk) => chunk.choices || []).map((choice) => choice.delta?.content || '').join(''), 'Hello from Pi (turn 1)');
  assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'));
  assert.ok(chunks.some((chunk) => chunk.usage?.total_tokens === 20));
});

test('OpenAI temperature is accepted without forwarding a sampling option to Pi', async (t) => {
  const { request, runtime } = await setup(t);
  const originalAcquire = runtime.acquire.bind(runtime);
  let requests = 0;
  runtime.acquire = async (options) => {
    assert.equal(Object.hasOwn(options, 'temperature'), false);
    const session = await originalAcquire(options);
    const originalRun = session.run;
    session.run = (prompt, options) => {
      assert.equal(Object.hasOwn(options, 'temperature'), false);
      requests++;
      return originalRun(prompt, options);
    };
    return session;
  };
  for (const temperature of [0, 0.7, 2, null]) {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion('Temperature compatibility', { temperature }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.choices[0].message.content, 'Hello from Pi (turn 1)');
  }
  const streamed = await request('/v1/chat/completions', { method: 'POST', body: completion('Temperature stream', { temperature: 1, stream: true }) });
  assert.equal(streamed.status, 200);
  const wire = await streamed.text();
  const chunks = wire.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  assert.equal(chunks.flatMap(chunk => chunk.choices || []).map(choice => choice.delta?.content || '').join(''), 'Hello from Pi (turn 1)');
  assert.ok(wire.includes('data: [DONE]'));
  assert.ok(!wire.includes('unsupported_parameter'));
  assert.equal(requests, 5);
});

test('invalid OpenAI temperature values still return a clear validation error', async (t) => {
  const { request, runtime } = await setup(t);
  for (const temperature of [-1, 2.1, '0.7', true, {}, []]) {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion('Hello', { temperature }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /temperature.*between 0 and 2/);
  }
  assert.equal(runtime.list().length, 0);
});

test('API key protects OpenAI routes while the local management page stays accessible', async (t) => {
  const key = 'sk-test-private-secret';
  const { request } = await setup(t, { apiKey: key });
  assert.equal((await request('/v1/models')).status, 401);
  assert.equal((await request('/v1/chat/completions', { method: 'POST', body: completion() })).status, 401);
  assert.equal((await request('/v1/models', { headers: { authorization: 'Bearer wrong-key' } })).status, 401);
  const authorized = await request('/v1/chat/completions', { method: 'POST', body: completion(), headers: { authorization: `Bearer ${key}` } });
  assert.equal(authorized.status, 200);
  await authorized.json();
  assert.equal((await request('/')).status, 200);
  const config = await (await request('/api/config')).json();
  assert.equal(config.apiKeyConfigured, true);
  assert.equal(config.apiKey, undefined);
  assert.ok(!JSON.stringify(config).includes(key));
  assert.equal((await request('/api/status')).status, 200);
});

test('cross-origin browser requests cannot mutate local management settings', async (t) => {
  const { request, configStore } = await setup(t);
  const before = configStore.value.effort;
  const response = await request('/api/config', { method: 'PUT', body: { effort: 'high' }, headers: { origin: 'https://untrusted.example' } });
  assert.equal(response.status, 403);
  assert.equal(configStore.value.effort, before);
  const key = await request('/api/key', { method: 'POST', headers: { origin: 'https://untrusted.example' } });
  assert.equal(key.status, 403);
  const preflight = await request('/api/config', { method: 'OPTIONS', headers: {
    origin: 'https://untrusted.example', 'access-control-request-method': 'PUT',
  } });
  assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');
  assert.notEqual(preflight.headers.get('access-control-allow-origin'), 'https://untrusted.example');
});

test('X-Session-Id reuses the Pi process and retains turn state', async (t) => {
  const { request } = await setup(t);
  const first = await request('/v1/chat/completions', { method: 'POST', body: completion('First turn') });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).choices[0].message.content, 'Hello from Pi (turn 1)');
  const id = first.headers.get('x-session-id');
  const second = await request('/v1/chat/completions', { method: 'POST', body: completion('Second turn'), headers: { 'x-session-id': id } });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-session-id'), id);
  assert.equal((await second.json()).choices[0].message.content, 'Hello from Pi (turn 2)');
  const sessions = await (await request('/api/sessions')).json();
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].id, id);
  assert.equal(sessions.sessions[0].busy, false);
  assert.equal((await request(`/api/sessions/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await request('/api/sessions')).json()).sessions.length, 0);
});

test('overlapping requests for one session return 409 rather than corrupting its context', async (t) => {
  const { request } = await setup(t);
  const headers = { 'x-session-id': 'concurrent-test' };
  const firstRequest = request('/v1/chat/completions', { method: 'POST', body: completion('SLOW: first'), headers });
  await waitUntil(async () => (await (await request('/api/sessions')).json()).sessions.some((session) => session.busy));
  const duplicate = await request('/v1/chat/completions', { method: 'POST', body: completion('Second'), headers });
  assert.equal(duplicate.status, 409);
  const first = await firstRequest;
  assert.equal(first.status, 200);
  await first.json();
  const sessions = await (await request('/api/sessions')).json();
  assert.equal(sessions.sessions[0].busy, false);
});

test('invalid payloads and unknown models return structured errors', async (t) => {
  const { request } = await setup(t);
  for (const body of [
    {}, { messages: [] }, { messages: 'not-an-array' },
    { messages: [{ role: 'user', content: 123 }] },
    completion('hello', { stream: 'yes' }),
    completion('hello', { model: 'fake/missing' }),
  ]) {
    const response = await request('/v1/chat/completions', { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    const result = await response.json();
    assert.equal(typeof result.error.message, 'string');
    assert.ok(result.error.message.length);
  }
});

test('settings persist, invalid updates are atomic, and keys are generated without implicit saving', async (t) => {
  const { request, configStore, dataDir } = await setup(t);
  const keyResponse = await request('/api/key', { method: 'POST' });
  assert.equal(keyResponse.status, 200);
  const { apiKey } = await keyResponse.json();
  assert.equal(typeof apiKey, 'string');
  assert.ok(apiKey.length >= 24);
  assert.equal(configStore.value.apiKey, '');
  const settings = { model: 'fake/fake-model', effort: 'high', contextWindow: 16000, apiKey };
  const saved = await request('/api/config', { method: 'PUT', body: settings });
  assert.equal(saved.status, 200);
  const publicConfig = await saved.json();
  assert.equal(publicConfig.effort, 'high');
  assert.equal(publicConfig.contextWindow, 16000);
  assert.equal(publicConfig.apiKey, undefined);
  const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
  await reloaded.load();
  assert.equal(reloaded.value.effort, 'high');
  assert.equal(reloaded.value.apiKey, apiKey);
  const before = await readFile(configStore.path, 'utf8');
  for (const body of [{ effort: 'unlimited' }, { contextWindow: -10 }, { port: 9000 }, { apiKey: 'tiny' }]) {
    assert.equal((await request('/api/config', { method: 'PUT', body })).status, 400);
  }
  assert.equal(await readFile(configStore.path, 'utf8'), before);
});

test('operational logs omit request content and API credentials', async (t) => {
  const apiKey = 'sk-sensitive-log-canary';
  const prompt = 'PROMPT_CANARY_do_not_log_this_private_content';
  const { request, logger } = await setup(t, { apiKey });
  const response = await request('/v1/chat/completions', { method: 'POST', body: completion(prompt), headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(response.status, 200);
  await response.json();
  const logsResponse = await request('/api/logs');
  assert.equal(logsResponse.status, 200);
  const { logs } = await logsResponse.json();
  assert.ok(logs.length > 0);
  for (const text of [JSON.stringify(logs), JSON.stringify(logger.history()), await readFile(logger.path, 'utf8')]) {
    assert.ok(!text.includes(apiKey), 'API key leaked into operational logs');
    assert.ok(!text.includes(prompt), 'Prompt leaked into operational logs');
  }
});

test('the log event stream publishes new operational records', async (t) => {
  const { request } = await setup(t);
  const response = await request('/api/logs/stream');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let wire = decoder.decode((await reader.read()).value);
  const saved = await request('/api/config', { method: 'PUT', body: { effort: 'high' } });
  assert.equal(saved.status, 200);
  while (!wire.includes('event: log')) wire += decoder.decode((await reader.read()).value);
  assert.match(wire, /Settings saved/);
  const record = wire.split('\n').find((line) => line.startsWith('data:'));
  assert.equal(JSON.parse(record.slice(5)).level, 'info');
  await reader.cancel();
});

test('a continued session accepts matching full history and rejects a changed prefix', async (t) => {
  const { request } = await setup(t);
  const firstMessage = { role: 'user', content: 'First question' };
  const first = await request('/v1/chat/completions', { method: 'POST', body: { model: 'fake/fake-model', messages: [firstMessage] } });
  const firstResult = await first.json();
  const headers = { 'x-session-id': first.headers.get('x-session-id') };
  const messages = [firstMessage, firstResult.choices[0].message, { role: 'user', content: 'Follow-up' }];
  const followup = await request('/v1/chat/completions', { method: 'POST', body: { model: 'fake/fake-model', messages }, headers });
  assert.equal(followup.status, 200);
  const followupResult = await followup.json();
  assert.equal(followupResult.choices[0].message.content, 'Hello from Pi (turn 2)');
  const changed = [...messages, followupResult.choices[0].message, { role: 'user', content: 'Another follow-up' }];
  changed[0] = { role: 'user', content: 'A different first question' };
  const conflict = await request('/v1/chat/completions', { method: 'POST', body: { model: 'fake/fake-model', messages: changed }, headers });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'session_history_conflict');
});

test('browser API calls require a configured key and authenticated calls receive CORS headers', async (t) => {
  const { request } = await setup(t);
  const origin = 'https://client.example';
  const forbidden = await request('/v1/chat/completions', { method: 'POST', body: completion(), headers: { origin } });
  assert.equal(forbidden.status, 403);
  const key = 'sk-cors-test-key';
  assert.equal((await request('/api/config', { method: 'PUT', body: { apiKey: key } })).status, 200);
  const preflight = await request('/v1/chat/completions', { method: 'OPTIONS', headers: {
    origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.ok(['*', origin].includes(preflight.headers.get('access-control-allow-origin')));
  const authorized = await request('/v1/chat/completions', { method: 'POST', body: completion(), headers: { origin, authorization: `Bearer ${key}` } });
  assert.equal(authorized.status, 200);
  assert.ok(['*', origin].includes(authorized.headers.get('access-control-allow-origin')));
  await authorized.json();
});

test('provider failures stay errors in both JSON and SSE responses', async (t) => {
  const { request } = await setup(t);
  const response = await request('/v1/chat/completions', { method: 'POST', body: completion('FAIL_PROVIDER:') });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'provider_error');
  const stream = await request('/v1/chat/completions', { method: 'POST', body: completion('FAIL_PROVIDER:', { stream: true }) });
  assert.equal(stream.status, 200); // Headers are committed before the provider runs.
  const wire = await stream.text();
  const records = wire.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  assert.equal(records.at(-1), '[DONE]');
  const chunks = records.filter((data) => data !== '[DONE]').map((data) => JSON.parse(data));
  assert.ok(chunks.some((chunk) => chunk.error?.code === 'provider_error'));
  assert.ok(!chunks.some((chunk) => chunk.choices?.some((choice) => choice.finish_reason === 'stop')));
});

test('disconnecting a streaming client cancels the Pi turn and frees its session', async (t) => {
  const { request, runtime } = await setup(t);
  const response = await request('/v1/chat/completions', { method: 'POST', body: completion('SLOW: disconnect', { stream: true }) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await waitUntil(() => runtime.list().length === 0);
});

test('an explicitly cleared system prompt cannot silently reuse earlier system instructions', async (t) => {
  const { request } = await setup(t);
  const first = await request('/v1/chat/completions', { method: 'POST', body: {
    model: 'fake/fake-model', messages: [{ role: 'system', content: 'Always answer in French.' }, { role: 'user', content: 'Hello' }],
  } });
  assert.equal(first.status, 200);
  await first.json();
  const followup = await request('/v1/chat/completions', { method: 'POST', headers: { 'x-session-id': first.headers.get('x-session-id') }, body: {
    model: 'fake/fake-model', messages: [{ role: 'system', content: '' }, { role: 'user', content: 'Hello again' }],
  } });
  assert.equal(followup.status, 409);
  assert.equal((await followup.json()).error.code, 'session_configuration_changed');
});
