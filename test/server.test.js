import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
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
  await configStore.update(settings);
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
  assert.deepEqual(new Set(status.pi.tools), new Set(['read']));
  assert.deepEqual(new Set(status.pi.availableTools), new Set(['read', 'bash', 'fixture_inactive']));
  assert.equal(typeof status.pi.workdir, 'string');
  assert.equal(typeof status.pi.agentDir, 'string');
  assert.equal(typeof status.pi.offlineStartup, 'boolean');
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
  const before = configStore.value.maxSessions;
  const response = await request('/api/config', { method: 'PUT', body: { maxSessions: 12 }, headers: { origin: 'https://untrusted.example' } });
  assert.equal(response.status, 403);
  assert.equal(configStore.value.maxSessions, before);
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

test('invalid payloads return structured errors', async (t) => {
  const { request } = await setup(t);
  for (const body of [
    {}, { messages: [] }, { messages: 'not-an-array' },
    { messages: [{ role: 'user', content: 123 }] },
    completion('hello', { stream: 'yes' }),
  ]) {
    const response = await request('/v1/chat/completions', { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    const result = await response.json();
    assert.equal(typeof result.error.message, 'string');
    assert.ok(result.error.message.length);
  }
});

test('unknown models return readable OpenAI JSON errors before committing an SSE response', async (t) => {
  const apiKey = 'sk-model-error-test';
  const { request, runtime } = await setup(t, { apiKey });
  const missingModel = 'fake/missing-model';
  for (const stream of [false, true]) {
    const response = await request('/v1/chat/completions', { method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, origin: 'https://client.example',
        accept: stream ? 'text/event-stream' : 'application/json' },
      body: completion('Hello', { model: missingModel, stream }) });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-session-id'), null);
    const { error } = await response.json();
    assert.equal(error.type, 'invalid_request_error');
    assert.equal(error.code, 'model_not_found');
    assert.equal(error.param, 'model');
    assert.ok(error.message.includes(missingModel));
    assert.match(error.message, /\/v1\/models/);
  }
  assert.equal(runtime.list().length, 0);
});

test('settings persist, invalid updates are atomic, and keys are generated without implicit saving', async (t) => {
  const { request, configStore, dataDir } = await setup(t);
  const keyResponse = await request('/api/key', { method: 'POST' });
  assert.equal(keyResponse.status, 200);
  const { apiKey } = await keyResponse.json();
  assert.equal(typeof apiKey, 'string');
  assert.ok(apiKey.length >= 24);
  assert.equal(configStore.value.apiKey, '');
  const settings = { maxSessions: 12, idleTimeoutMinutes: 20, apiKey };
  const saved = await request('/api/config', { method: 'PUT', body: settings });
  assert.equal(saved.status, 200);
  const publicConfig = await saved.json();
  assert.equal(publicConfig.maxSessions, 12);
  assert.equal(publicConfig.idleTimeoutMinutes, 20);
  assert.equal(publicConfig.apiKey, undefined);
  const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
  await reloaded.load();
  assert.equal(reloaded.value.maxSessions, 12);
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
  const saved = await request('/api/config', { method: 'PUT', body: { maxSessions: 12 } });
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
  assert.deepEqual((await response.json()).error, {
    message: 'Fake provider failed', type: 'api_error', param: null, code: 'provider_error',
  });
  const stream = await request('/v1/chat/completions', { method: 'POST', body: completion('FAIL_PROVIDER:', { stream: true }) });
  assert.equal(stream.status, 200); // Headers are committed before the provider runs.
  assert.match(stream.headers.get('content-type'), /^text\/event-stream\b/);
  const wire = await stream.text();
  const records = wire.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  assert.equal(records.at(-1), '[DONE]');
  const chunks = records.filter((data) => data !== '[DONE]').map((data) => JSON.parse(data));
  const errors = chunks.filter((chunk) => chunk.error);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].error, {
    message: 'Fake provider failed', type: 'api_error', param: null, code: 'provider_error',
  });
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

test('project trust defaults safely, persists valid decisions and rejects unknown values atomically', { timeout: 10_000 }, async (t) => {
  const { request, configStore, dataDir } = await setup(t);
  assert.equal((await (await request('/api/config')).json()).projectTrust, 'default');
  for (const projectTrust of ['allow', 'deny', 'default']) {
    const response = await request('/api/config', { method: 'PUT', body: { projectTrust } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).projectTrust, projectTrust);
    const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
    await reloaded.load();
    assert.equal(reloaded.value.projectTrust, projectTrust);
  }
  const before = await readFile(configStore.path, 'utf8');
  for (const projectTrust of ['approve', 'always', '', null, true]) {
    const response = await request('/api/config', { method: 'PUT', body: { projectTrust } });
    assert.equal(response.status, 400);
    assert.equal(await readFile(configStore.path, 'utf8'), before);
    assert.equal(configStore.value.projectTrust, 'default');
  }
});

test('model discovery exposes Pi capabilities and model retrieval without a synthetic default', async (t) => {
  const { request } = await setup(t);
  const { data } = await (await request('/v1/models')).json();
  assert.equal(data.length, 3);
  assert.ok(!data.some(model => model.id === 'pi'));
  const plain = data.find(model => model.id === 'fake/plain-model');
  assert.equal(plain.object, 'model');
  assert.equal(plain.context_window, 8192);
  assert.equal(plain.max_output_tokens, 1024);
  assert.equal(plain.reasoning, false);
  assert.deepEqual(plain.supported_reasoning_efforts, ['off']);
  assert.deepEqual(plain.input_modalities, ['text']);
  const limited = data.find(model => model.id === 'fake/limited-model');
  assert.deepEqual(limited.supported_reasoning_efforts, ['off', 'low', 'high', 'xhigh']);
  for (const id of ['fake/plain-model', 'fake%2Fplain-model']) {
    const response = await request(`/v1/models/${id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), plain);
  }
  const absent = await request('/v1/models/fake/missing');
  assert.equal(absent.status, 404);
  const { error } = await absent.json();
  assert.equal(error.type, 'invalid_request_error');
  assert.equal(error.code, 'model_not_found');
  assert.equal(error.param, 'model');
  assert.ok(error.message.includes('fake/missing'));
});

test('separate clients select models and effort without gateway model defaults', async (t) => {
  const { request, configStore } = await setup(t);
  const choices = [
    { model: 'fake/fake-model', reasoning_effort: 'high', expected: 'high' },
    { model: 'fake/fake-model', reasoning_effort: 'low', expected: 'low' },
    { model: 'fake/plain-model', reasoning_effort: 'none', expected: 'off' },
  ];
  const results = await Promise.all(choices.map(async ({ expected, ...params }) => {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion('REQUEST_METADATA:', params) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, params.model);
    const actual = JSON.parse(result.choices[0].message.content);
    assert.equal(actual.model, params.model);
    assert.equal(actual.effort, expected);
    assert.equal(actual.explicitEffort, true);
    return actual;
  }));
  assert.equal(results[2].contextWindow, 8192);
  for (const name of ['model', 'effort', 'contextWindow']) assert.equal(Object.hasOwn(configStore.value, name), false);
});

test('omitted effort uses Pi defaults and continued sessions retain initial effort', async (t) => {
  const { request } = await setup(t);
  const defaultResponse = await request('/v1/chat/completions', { method: 'POST', body: completion('REQUEST_METADATA:', { model: 'fake/plain-model' }) });
  assert.equal(defaultResponse.status, 200);
  assert.deepEqual(JSON.parse((await defaultResponse.json()).choices[0].message.content),
    { model: 'fake/plain-model', effort: 'off', explicitEffort: false, contextWindow: 8192 });
  const first = await request('/v1/chat/completions', { method: 'POST', body: completion('REQUEST_METADATA:', { reasoning_effort: 'high' }) });
  assert.equal(first.status, 200);
  await first.json();
  const headers = { 'x-session-id': first.headers.get('x-session-id') };
  const next = await request('/v1/chat/completions', { method: 'POST', headers, body: completion('REQUEST_METADATA:') });
  assert.equal(next.status, 200);
  assert.equal(JSON.parse((await next.json()).choices[0].message.content).effort, 'high');
  const conflict = await request('/v1/chat/completions', { method: 'POST', headers, body: completion('Hello', { reasoning_effort: 'low' }) });
  assert.equal(conflict.status, 409);
});

test('request selection rejects missing models and unsupported effort levels', async (t) => {
  const { request, runtime } = await setup(t);
  for (const body of [
    { messages: [{ role: 'user', content: 'hello' }] },
    completion('hello', { model: 'fake/plain-model', reasoning_effort: 'high' }),
    completion('hello', { model: 'fake/limited-model', reasoning_effort: 'medium' }),
    completion('hello', { reasoning_effort: 'xhigh' }),
    completion('hello', { context_window: 64000 }),
  ]) assert.equal((await request('/v1/chat/completions', { method: 'POST', body })).status, 400);
  assert.equal((await request('/v1/chat/completions', { method: 'POST', body: completion('hello', { model: 'pi' }) })).status, 404);
  assert.equal(runtime.list().length, 0);
});

test('legacy defaults migrate out without changing keys or overriding client requests', async (t) => {
  const { request, configStore } = await setup(t);
  const legacy = { ...configStore.value, model: 'fake/missing', effort: 'high', contextWindow: 1024,
    apiKey: 'pc-legacy-auth-key', maxSessions: 10 };
  const contents = JSON.stringify(legacy);
  await writeFile(configStore.path, contents, { mode: 0o600 });
  await configStore.load();
  assert.equal(await readFile(configStore.path, 'utf8'), contents);
  const config = await (await request('/api/config')).json();
  for (const name of ['model', 'effort', 'contextWindow', 'apiKey']) assert.equal(Object.hasOwn(config, name), false);
  assert.equal(config.maxSessions, 10);
  assert.equal(config.apiKeyConfigured, true);
  const response = await request('/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer pc-legacy-auth-key' }, body: completion('REQUEST_METADATA:') });
  assert.equal(response.status, 200);
  const metadata = JSON.parse((await response.json()).choices[0].message.content);
  assert.equal(metadata.model, 'fake/fake-model');
  assert.equal(metadata.effort, 'medium');
  assert.equal(metadata.explicitEffort, false);
  assert.equal(metadata.contextWindow, 32000);
  for (const patch of [{ model: 'fake/plain-model' }, { effort: 'high' }, { contextWindow: 16000 }]) {
    assert.equal((await request('/api/config', { method: 'PUT', body: patch })).status, 400);
  }
  await configStore.update({ maxSessions: 12 });
  const persisted = JSON.parse(await readFile(configStore.path, 'utf8'));
  assert.equal(persisted.apiKey, legacy.apiKey);
  for (const name of ['model', 'effort', 'contextWindow']) assert.equal(Object.hasOwn(persisted, name), false);
});

test('changing project trust requires a fresh session rather than retaining earlier loaded project tools', { timeout: 10_000 }, async (t) => {
  const { request } = await setup(t);
  const first = await request('/v1/chat/completions', { method: 'POST', body: completion('First question') });
  assert.equal(first.status, 200);
  await first.json();
  const saved = await request('/api/config', { method: 'PUT', body: { projectTrust: 'allow' } });
  assert.equal(saved.status, 200);
  const followup = await request('/v1/chat/completions', { method: 'POST', body: completion('Follow-up'),
    headers: { 'x-session-id': first.headers.get('x-session-id') } });
  assert.equal(followup.status, 409);
  assert.equal((await followup.json()).error.code, 'session_configuration_changed');
});

test('session saving is a persistent boolean setting without changing API credentials or model selection', async (t) => {
  const apiKey = 'sk-session-saving-test';
  const { request, configStore, dataDir } = await setup(t, { apiKey });
  assert.equal((await (await request('/api/config')).json()).saveSessions, false);
  for (const saveSessions of [true, false]) {
    const saved = await request('/api/config', { method: 'PUT', body: { saveSessions } });
    assert.equal(saved.status, 200);
    const config = await saved.json();
    assert.equal(config.saveSessions, saveSessions);
    assert.equal(config.apiKeyConfigured, true);
    assert.equal(Object.hasOwn(config, 'apiKey'), false);
    for (const key of ['model', 'effort', 'contextWindow']) assert.equal(Object.hasOwn(config, key), false);
    const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
    await reloaded.load();
    assert.equal(reloaded.value.saveSessions, saveSessions);
    assert.equal(reloaded.value.apiKey, apiKey);
  }
  const before = await readFile(configStore.path, 'utf8');
  for (const saveSessions of ['true', 'false', 0, 1, null, {}, []]) {
    const response = await request('/api/config', { method: 'PUT', body: { saveSessions } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /saveSessions.*boolean/);
    assert.equal(await readFile(configStore.path, 'utf8'), before);
    assert.equal(configStore.value.saveSessions, false);
    assert.equal(configStore.value.apiKey, apiKey);
  }
  const response = await request('/v1/chat/completions', { method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: completion('REQUEST_METADATA:', { model: 'fake/plain-model', reasoning_effort: 'none' }) });
  assert.equal(response.status, 200);
  const metadata = JSON.parse((await response.json()).choices[0].message.content);
  assert.equal(metadata.model, 'fake/plain-model');
  assert.equal(metadata.effort, 'off');
});

test('session-saving changes require fresh sessions and expose each session persistence metadata', async (t) => {
  const { request } = await setup(t);
  const openSession = async () => {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion() });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get('x-session-id');
  };
  const getSession = async (id) => {
    const { sessions } = await (await request('/api/sessions')).json();
    return sessions.find(session => session.id === id);
  };
  const continueSession = (id) => request('/v1/chat/completions', { method: 'POST',
    headers: { 'x-session-id': id }, body: completion('Next turn') });

  const ephemeralId = await openSession();
  const ephemeral = await getSession(ephemeralId);
  assert.equal(ephemeral.saveSessions, false);
  assert.equal(ephemeral.sessionFile, null);
  assert.equal((await request('/api/config', { method: 'PUT', body: { saveSessions: true } })).status, 200);
  const oldEphemeral = await continueSession(ephemeralId);
  assert.equal(oldEphemeral.status, 409);
  assert.equal((await oldEphemeral.json()).error.code, 'session_configuration_changed');

  const persistentId = await openSession();
  const persistent = await getSession(persistentId);
  assert.equal(persistent.saveSessions, true);
  assert.equal(typeof persistent.sessionFile, 'string');
  assert.match(persistent.sessionFile, /fake-session-\d+\.jsonl$/);
  const persistedTurn = await continueSession(persistentId);
  assert.equal(persistedTurn.status, 200);
  assert.equal((await persistedTurn.json()).choices[0].message.content, 'Hello from Pi (turn 2)');
  assert.equal((await getSession(persistentId)).sessionFile, persistent.sessionFile);

  assert.equal((await request('/api/config', { method: 'PUT', body: { saveSessions: false } })).status, 200);
  const oldPersistent = await continueSession(persistentId);
  assert.equal(oldPersistent.status, 409);
  assert.equal((await oldPersistent.json()).error.code, 'session_configuration_changed');
  assert.equal((await getSession(persistentId)).saveSessions, true);
  assert.equal((await getSession(ephemeralId)).saveSessions, false);
  const newEphemeral = await getSession(await openSession());
  assert.equal(newEphemeral.saveSessions, false);
  assert.equal(newEphemeral.sessionFile, null);
});

test('Skills setting upgrades legacy configuration safely and persists only boolean updates', async (t) => {
  const apiKey = 'sk-skills-config-test';
  const { request, configStore, dataDir } = await setup(t, {
    apiKey, saveSessions: true, projectTrust: 'allow', maxSessions: 11,
  });
  const legacy = JSON.parse(await readFile(configStore.path, 'utf8'));
  delete legacy.enableSkills;
  const legacyContents = JSON.stringify(legacy);
  await writeFile(configStore.path, legacyContents, { mode: 0o600 });
  await configStore.load();
  const { enableSkills: _enableSkills, ...unchangedSettings } = configStore.value;
  assert.equal((await (await request('/api/config')).json()).enableSkills, false);
  assert.equal(await readFile(configStore.path, 'utf8'), legacyContents);

  for (const enableSkills of [true, false]) {
    const saved = await request('/api/config', { method: 'PUT', body: { enableSkills } });
    assert.equal(saved.status, 200);
    const config = await saved.json();
    assert.equal(config.enableSkills, enableSkills);
    assert.equal(config.apiKeyConfigured, true);
    assert.equal(Object.hasOwn(config, 'apiKey'), false);
    for (const key of ['model', 'effort', 'contextWindow']) assert.equal(Object.hasOwn(config, key), false);
    const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
    await reloaded.load();
    assert.deepEqual(reloaded.value, { ...unchangedSettings, enableSkills });
  }
  const before = await readFile(configStore.path, 'utf8');
  for (const enableSkills of ['true', 'false', 0, 1, null, {}, []]) {
    const response = await request('/api/config', { method: 'PUT', body: { enableSkills } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /enableSkills.*boolean/);
    assert.equal(await readFile(configStore.path, 'utf8'), before);
    assert.deepEqual(configStore.value, { ...unchangedSettings, enableSkills: false });
  }
});

test('Skills changes require fresh sessions and reach Pi without disabling registered tools', async (t) => {
  const { request } = await setup(t);
  const openSession = async (expected) => {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion('SKILLS_METADATA:') });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(JSON.parse(result.choices[0].message.content), { enableSkills: expected });
    const id = response.headers.get('x-session-id');
    const { sessions } = await (await request('/api/sessions')).json();
    assert.deepEqual(new Set(sessions.find(session => session.id === id).tools), new Set(['read']));
    return id;
  };
  let id = await openSession(false);
  for (const enableSkills of [true, false]) {
    assert.equal((await request('/api/config', { method: 'PUT', body: { enableSkills } })).status, 200);
    const previous = await request('/v1/chat/completions', { method: 'POST',
      headers: { 'x-session-id': id }, body: completion('SKILLS_METADATA:') });
    assert.equal(previous.status, 409);
    assert.equal((await previous.json()).error.code, 'session_configuration_changed');
    id = await openSession(enableSkills);
  }
});

test('Capabilities settings upgrade old configuration and validate updates atomically', async (t) => {
  const apiKey = 'sk-capabilities-config-test';
  const { request, configStore, dataDir } = await setup(t, { apiKey, enableSkills: true, saveSessions: true });
  const legacy = JSON.parse(await readFile(configStore.path, 'utf8'));
  for (const key of ['toolOverrides', 'enableExtensions', 'extensionOverrides']) delete legacy[key];
  await writeFile(configStore.path, JSON.stringify(legacy), { mode: 0o600 });
  await configStore.load();
  const defaults = await (await request('/api/config')).json();
  assert.deepEqual(defaults.toolOverrides, {});
  assert.equal(defaults.enableExtensions, true);
  assert.deepEqual(defaults.extensionOverrides, {});
  const values = { toolOverrides: { bash: true, read: false }, enableExtensions: false,
    extensionOverrides: { [join(dataDir, 'fixture.mjs')]: false, 'builtin:fixture': true } };
  const response = await request('/api/config', { method: 'PUT', body: values });
  assert.equal(response.status, 200);
  const config = await response.json();
  for (const key of Object.keys(values)) assert.deepEqual(config[key], values[key]);
  assert.equal(config.apiKeyConfigured, true);
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
  const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
  await reloaded.load();
  assert.deepEqual(reloaded.value, { ...legacy, ...values });

  const tooManyTools = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`tool_${index}`, true]));
  const tooManyExtensions = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`builtin:fixture_${index}`, true]));
  const before = await readFile(configStore.path, 'utf8');
  for (const patch of [
    { enableExtensions: 'false' }, { enableExtensions: 0 }, { enableExtensions: null },
    { toolOverrides: null }, { toolOverrides: [] }, { toolOverrides: 'bash' },
    { toolOverrides: { bash: 'true' } }, { toolOverrides: { '*': false } },
    { toolOverrides: { 'bash,read': true } }, { toolOverrides: tooManyTools },
    { extensionOverrides: null }, { extensionOverrides: [] }, { extensionOverrides: 'fixture' },
    { extensionOverrides: { 'builtin:fixture': 1 } }, { extensionOverrides: { 'relative/fixture.mjs': false } },
    { extensionOverrides: { 'builtin:bad/name': false } }, { extensionOverrides: tooManyExtensions },
  ]) {
    const invalid = await request('/api/config', { method: 'PUT', body: patch });
    assert.equal(invalid.status, 400, JSON.stringify(patch));
    await invalid.json();
    assert.equal(await readFile(configStore.path, 'utf8'), before);
    assert.deepEqual(configStore.value, reloaded.value);
  }
});

test('Capabilities report disabled bash and refresh tool policy after saving overrides', async (t) => {
  const { request } = await setup(t);
  const initialResponse = await request('/api/capabilities');
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.ok(Array.isArray(initial.extensions));
  const bash = initial.tools.find(tool => tool.name === 'bash');
  assert.equal(bash.enabled, false);
  assert.equal(bash.active, false);
  assert.equal(bash.defaultEnabled, false);
  assert.equal(typeof bash.description, 'string');
  assert.equal(typeof bash.reason, 'string');
  const read = initial.tools.find(tool => tool.name === 'read');
  assert.equal(read.enabled, true);
  assert.equal(read.active, true);
  assert.equal(read.defaultEnabled, true);
  assert.ok(initial.tools.some(tool => tool.name === 'fixture_inactive'));

  assert.equal((await request('/api/config', { method: 'PUT', body: { toolOverrides: { bash: true, read: false } } })).status, 200);
  const updated = await (await request('/api/capabilities')).json();
  assert.equal(updated.tools.find(tool => tool.name === 'bash').enabled, true);
  assert.equal(updated.tools.find(tool => tool.name === 'bash').active, true);
  assert.equal(updated.tools.find(tool => tool.name === 'read').enabled, false);
  assert.equal(updated.tools.find(tool => tool.name === 'read').active, false);
  const { pi } = await (await request('/api/status')).json();
  assert.deepEqual(new Set(pi.tools), new Set(['bash']));
  assert.ok(pi.availableTools.includes('read'));
});

test('Capabilities discover project extensions without importing them and reflect individual and master switches', async (t) => {
  const { request, dataDir } = await setup(t, { projectTrust: 'allow' });
  const extensionDir = join(dataDir, '.pi', 'extensions');
  await mkdir(extensionDir, { recursive: true });
  const path = join(extensionDir, 'catalog-fixture.js');
  const canary = join(dataDir, 'extension-import-canary.txt');
  await writeFile(path, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(canary)}, 'executed');
export default function () {}
`);
  const getExtension = async () => {
    const response = await request('/api/capabilities');
    assert.equal(response.status, 200);
    const result = await response.json();
    const extension = result.extensions.find(extension => extension.path === path);
    assert.ok(extension, 'Project extension should appear in the catalogue');
    assert.equal(extension.id, path);
    assert.equal(extension.scope, 'project');
    await assert.rejects(readFile(canary), { code: 'ENOENT' });
    return extension;
  };
  const initial = await getExtension();
  assert.equal(initial.configuredEnabled, true);
  assert.equal(initial.enabled, true);
  assert.equal((await request('/api/config', { method: 'PUT', body: { extensionOverrides: { [path]: false } } })).status, 200);
  const individual = await getExtension();
  assert.equal(individual.configuredEnabled, true);
  assert.equal(individual.enabled, false);
  assert.equal((await request('/api/config', { method: 'PUT', body: { extensionOverrides: { [path]: true }, enableExtensions: false } })).status, 200);
  const master = await getExtension();
  assert.equal(master.configuredEnabled, true);
  assert.equal(master.enabled, false);
});

test('Capabilities changes require fresh sessions while equivalent map order preserves a conversation', async (t) => {
  const { request } = await setup(t);
  const openSession = async () => {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion() });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get('x-session-id');
  };
  const continueSession = (id) => request('/v1/chat/completions', { method: 'POST',
    headers: { 'x-session-id': id }, body: completion('Next turn') });
  let id = await openSession();
  for (const patch of [
    { toolOverrides: { bash: true, read: false } },
    { enableExtensions: false },
    { extensionOverrides: { 'builtin:fixture-a': false, 'builtin:fixture-b': true } },
  ]) {
    assert.equal((await request('/api/config', { method: 'PUT', body: patch })).status, 200);
    const previous = await continueSession(id);
    assert.equal(previous.status, 409);
    assert.equal((await previous.json()).error.code, 'session_configuration_changed');
    id = await openSession();
  }
  const reordered = { toolOverrides: { read: false, bash: true },
    extensionOverrides: { 'builtin:fixture-b': true, 'builtin:fixture-a': false } };
  assert.equal((await request('/api/config', { method: 'PUT', body: reordered })).status, 200);
  const continued = await continueSession(id);
  assert.equal(continued.status, 200);
  assert.equal((await continued.json()).choices[0].message.content, 'Hello from Pi (turn 2)');
});
