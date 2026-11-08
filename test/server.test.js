import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import { createApp } from '../src/server.js';
import { ConfigStore } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { PiRuntime } from '../src/pi-rpc.js';

const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const defaultAdditionalSystemPrompt = '按问题复杂度使用工具：简单事实优先一次搜索和一个权威来源，证据充分后立即回答；复杂研究按需补查。';
const completion = (content = 'Say hello', extra = {}) => ({
  model: 'fake/fake-model', messages: [{ role: 'user', content }], ...extra,
});

async function setup(t, settings = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'picall-test-'));
  const configStore = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
  await configStore.load();
  await configStore.update({ defaultModel: 'fake/fake-model', ...settings });
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

test('SSE returns only the completed answer, a final reason, usage when requested and [DONE]', async (t) => {
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
  assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content).length, 1);
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

test('the management HTTP API never returns saved model or search keys and omission preserves existing secrets', async t => {
  const { request, configStore } = await setup(t);
  const keys = { apiKey: 'pc-api-management-canary', modelApiKey: 'model-management-canary',
    braveApiKey: 'brave-management-canary', tavilyApiKey: 'tavily-management-canary',
    tinyfishApiKey: 'tinyfish-management-canary', exaApiKey: 'exa-management-canary', jinaApiKey: 'jina-management-canary' };
  const saved = await request('/api/config', { method: 'PUT', body: keys });
  assert.equal(saved.status, 200);
  for (const config of [await saved.json(), await (await request('/api/config')).json()]) {
    for (const [field, value] of Object.entries(keys)) {
      assert.equal(Object.hasOwn(config, field), false);
      assert.equal(config[`${field}Configured`], true);
      assert.ok(!JSON.stringify(config).includes(value));
    }
  }
  const unrelated = await request('/api/config', { method: 'PUT', body: { maxToolRounds: 6 } });
  assert.equal(unrelated.status, 200);
  for (const [field, value] of Object.entries(keys)) assert.equal(configStore.value[field], value);
  const cleared = await request('/api/config', { method: 'PUT', body: { modelApiKey: '', braveApiKey: '' } });
  assert.equal(cleared.status, 200);
  const result = await cleared.json();
  assert.equal(result.modelApiKeyConfigured, false);
  assert.equal(result.braveApiKeyConfigured, false);
  assert.equal(result.tavilyApiKeyConfigured, true);
  const logs = JSON.stringify(await (await request('/api/logs')).json());
  for (const value of Object.values(keys)) assert.ok(!logs.includes(value));
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

test('cross-site top-level navigation may open the UI without allowing cross-origin management APIs', async t => {
  const { request, base } = await setup(t);
  // fetch() rewrites Sec-Fetch-Mode to cors; use raw HTTP for browser navigation metadata.
  const navigate = (path, headers) => new Promise((resolve, reject) => {
    httpGet(base + path, { headers }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers), text: async () => content }));
      response.on('error', reject);
    }).on('error', reject);
  });
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const page = await navigate('/', navigation);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /PiCall/);
  for (const path of ['/api/config', '/api/status', '/api/key', '/app.js']) {
    const response = await navigate(path, navigation);
    assert.equal(response.status, 403, path);
  }
  for (const headers of [
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await navigate('/', headers)).status, 403);
  const update = await request('/api/config', { method: 'PUT', body: { maxSessions: 12 }, headers: navigation });
  assert.equal(update.status, 403);
  const unrelated = await navigate('/', { ...navigation, host: 'untrusted.example' });
  assert.equal(unrelated.status, 403);
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
    message: 'The model provider rejected or failed the request.', type: 'api_error', param: null, code: 'provider_error',
  });
  const failedRun = await (await request(`/v1/runs/${response.headers.get('x-run-id')}`)).json();
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.error.code, 'provider_error');
  assert.equal(Object.hasOwn(failedRun, 'completion'), false);
  assert.ok(!JSON.stringify(failedRun).includes('Fake provider failed'));
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
    message: 'The model provider rejected or failed the request.', type: 'api_error', param: null, code: 'provider_error',
  });
  assert.ok(!chunks.some((chunk) => chunk.choices?.some((choice) => choice.finish_reason === 'stop')));
});

test('disconnecting an SSE waiter leaves the task running and its final answer can be queried', async (t) => {
  const { request, runtime } = await setup(t);
  const response = await request('/v1/chat/completions', { method: 'POST', body: completion('SLOW: disconnect', { stream: true }) });
  assert.equal(response.status, 200);
  const runId = response.headers.get('x-run-id');
  const sessionId = response.headers.get('x-session-id');
  assert.ok(runId);
  assert.ok(sessionId);
  const reader = response.body.getReader();
  const firstFrame = new TextDecoder().decode((await reader.read()).value);
  assert.ok(!firstFrame.includes('Hello from Pi'), 'SSE must not expose unfinished assistant text');
  await reader.cancel();
  let finished;
  await waitUntil(async () => {
    finished = await (await request(`/v1/runs/${runId}`)).json();
    return finished.status === 'completed';
  });
  assert.equal(finished.completion.choices[0].message.content, 'Hello from Pi (turn 1)');
  assert.equal(finished.completion.id, runId);
  assert.equal(runtime.list().find(session => session.id === sessionId).busy, false);
  const continuation = await request('/v1/chat/completions', { method: 'POST',
    headers: { 'x-session-id': sessionId }, body: completion('Continue after disconnect') });
  assert.equal(continuation.status, 200);
  assert.equal((await continuation.json()).choices[0].message.content, 'Hello from Pi (turn 2)');
});

test('asynchronous submissions return persisted IDs and use the configured default model', async (t) => {
  const { request, configStore } = await setup(t);
  const accepted = await request('/v1/runs', { method: 'POST', body: { prompt: 'SLOW: async task' } });
  assert.equal(accepted.status, 202);
  const initial = await accepted.json();
  assert.equal(initial.id, accepted.headers.get('x-run-id'));
  assert.equal(initial.sessionId, accepted.headers.get('x-session-id'));
  assert.equal(initial.model, 'fake/fake-model');
  assert.equal(accepted.headers.get('location'), `/v1/runs/${initial.id}`);
  assert.ok(['pending', 'running'].includes(initial.status));
  const saved = JSON.parse(await readFile(join(configStore.dataDir, 'runs', `${initial.id}.json`), 'utf8'));
  assert.equal(saved.id, initial.id, '202 acceptance must follow the record being written to disk');
  assert.equal(Object.hasOwn(initial, 'inputFingerprint'), false);
  let finished;
  await waitUntil(async () => {
    const response = await request(`/v1/runs/${initial.id}`);
    assert.equal(response.status, 200);
    finished = await response.json();
    return finished.status === 'completed';
  });
  assert.equal(finished.completion.model, 'fake/fake-model');
  assert.equal(finished.completion.choices[0].message.content, 'Hello from Pi (turn 1)');
  assert.deepEqual(finished.completion.usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  for (const prompt of ['', '  ', null, 5]) {
    assert.equal((await request('/v1/runs', { method: 'POST', body: { prompt } })).status, 400);
  }
  const missing = await request('/v1/runs/missing-task');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'run_not_found');
});

test('Idempotency-Key reuses one task without needing the first response session ID and rejects changed input', async (t) => {
  const { request, runtime, configStore } = await setup(t);
  const options = { method: 'POST', body: { prompt: 'SLOW: original async prompt' }, headers: { 'idempotency-key': 'local-request-once' } };
  const [firstResponse, retryResponse] = await Promise.all([request('/v1/runs', options), request('/v1/runs', options)]);
  assert.equal(firstResponse.status, 202);
  assert.equal(retryResponse.status, 202);
  const [first, retry] = await Promise.all([firstResponse.json(), retryResponse.json()]);
  assert.equal(first.id, retry.id);
  assert.equal(first.sessionId, retry.sessionId);
  const stored = JSON.parse(await readFile(join(configStore.dataDir, 'runs', `${first.id}.json`), 'utf8'));
  assert.equal(Object.hasOwn(stored, 'idempotencyKey'), false);
  assert.ok(!JSON.stringify(stored).includes('local-request-once'), 'the raw idempotency token must not be persisted');
  const conflict = await request('/v1/runs', { ...options, body: { prompt: 'Different request' } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'idempotency_conflict');
  const wrongSession = await request('/v1/runs', { ...options,
    headers: { ...options.headers, 'x-session-id': 'another-session' } });
  assert.equal(wrongSession.status, 409);
  await waitUntil(async () => (await (await request(`/v1/runs/${first.id}`)).json()).status === 'completed');
  assert.equal(runtime.list().length, 1, 'duplicate admission must not create another Pi session');
  const completedRetry = await (await request('/v1/runs', options)).json();
  assert.equal(completedRetry.id, first.id);
  assert.equal(completedRetry.completion.choices[0].message.content, 'Hello from Pi (turn 1)');
  const independent = await (await request('/v1/runs', { method: 'POST', body: options.body })).json();
  assert.notEqual(independent.id, first.id, 'requests without an idempotency key create a new task');
});

for (const route of ['/v1/runs', '/v1/chat/completions']) {
  test(`idempotent ${route} retries retain the original model after defaults or available credentials change`, async t => {
    const { request, runtime } = await setup(t);
    const body = route === '/v1/runs' ? { prompt: 'Stable request with no model' }
      : { messages: [{ role: 'user', content: 'Stable request with no model' }] };
    const headers = { 'idempotency-key': 'stable-model-default' };
    const firstResponse = await request(route, { method: 'POST', body, headers });
    assert.equal(firstResponse.status, route === '/v1/runs' ? 202 : 200);
    const first = await firstResponse.json();
    const runId = first.id;
    let finished;
    await waitUntil(async () => {
      finished = await (await request(`/v1/runs/${runId}`)).json();
      return finished.status === 'completed';
    });
    assert.equal(finished.completion.model, 'fake/fake-model');
    assert.equal(finished.model, 'fake/fake-model');
    assert.equal(finished.completion.choices[0].message.content, 'Hello from Pi (turn 1)');
    assert.equal((await request('/api/config', { method: 'PUT',
      body: { defaultModel: 'fake/plain-model', modelApiKey: '' } })).status, 200);
    let discoveries = 0;
    runtime.models = async () => { discoveries++; return []; };
    const retriedResponse = await request(route, { method: 'POST', body, headers });
    assert.equal(retriedResponse.status, route === '/v1/runs' ? 202 : 200);
    const retry = await retriedResponse.json();
    assert.equal(retry.id, runId, 'retry must look up the raw request before resolving the current default model');
    const completion = route === '/v1/runs' ? retry.completion : retry;
    assert.deepEqual(completion, finished.completion);
    if (route === '/v1/runs') assert.equal(retry.model, 'fake/fake-model');
    assert.equal(discoveries, 0, 'an accepted request remains retrievable even when provider credentials disappear');
    assert.equal(runtime.list().length, 1, 'the retried request must not create another Pi worker or turn');
    if (route === '/v1/chat/completions') {
      const stream = await request(route, { method: 'POST', headers,
        body: { ...body, stream: true, stream_options: { include_usage: true } } });
      assert.equal(stream.status, 200);
      assert.equal(stream.headers.get('x-run-id'), runId);
      const chunks = (await stream.text()).split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map(line => JSON.parse(line.slice(6)));
      assert.ok(chunks.every(chunk => chunk.model === 'fake/fake-model'), 'replayed SSE metadata must retain the original model');
      assert.equal(chunks.flatMap(chunk => chunk.choices || []).map(choice => choice.delta?.content || '').join(''),
        finished.completion.choices[0].message.content);
      assert.equal(discoveries, 0, 'the transport preference must not change an existing task identity');
    }
    const changedBody = route === '/v1/runs' ? { prompt: 'Changed request' }
      : { messages: [{ role: 'user', content: 'Changed request' }] };
    const conflict = await request(route, { method: 'POST', body: changedBody, headers });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'idempotency_conflict');
    assert.equal(discoveries, 0, 'conflicts must also be resolved before consulting current providers');
    const newRequest = await request(route, { method: 'POST', body,
      headers: { 'idempotency-key': 'fresh-key-without-provider' } });
    assert.equal(newRequest.status, 404, 'a genuinely new request must still validate the current model');
    assert.equal(discoveries, 1);
  });
}

test('a disconnected JSON caller can retry before learning its session ID without repeating the turn', async (t) => {
  const { request, runtime } = await setup(t);
  const controller = new AbortController();
  const body = completion('SLOW: disconnected before response');
  const headers = { 'idempotency-key': 'lost-json-response' };
  const first = request('/v1/chat/completions', { method: 'POST', body, headers, signal: controller.signal });
  const firstAborted = assert.rejects(first, error => error.name === 'AbortError');
  await waitUntil(() => runtime.list().some(session => session.busy));
  controller.abort();
  await firstAborted;
  const response = await request('/v1/chat/completions', { method: 'POST', body, headers });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.id, response.headers.get('x-run-id'));
  assert.equal(result.choices[0].message.content, 'Hello from Pi (turn 1)');
  assert.equal(runtime.list().length, 1);
  const stored = await (await request(`/v1/runs/${result.id}`)).json();
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.completion, result);
});

test('the explicit cancel endpoint stops the task and a late model result cannot turn it into success', async (t) => {
  const { request, runtime } = await setup(t);
  const accepted = await request('/v1/runs', { method: 'POST', body: { prompt: 'SLOW: cancel this turn' } });
  assert.equal(accepted.status, 202);
  const run = await accepted.json();
  await waitUntil(() => runtime.list().some(session => session.busy));
  const cancelledResponse = await request(`/v1/runs/${run.id}/cancel`, { method: 'POST' });
  assert.equal(cancelledResponse.status, 200);
  const cancelled = await cancelledResponse.json();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error.code, 'request_cancelled');
  assert.equal(Object.hasOwn(cancelled, 'completion'), false);
  await waitUntil(() => !runtime.list().some(session => session.busy));
  await new Promise(resolve => setTimeout(resolve, 350));
  const after = await (await request(`/v1/runs/${run.id}`)).json();
  assert.equal(after.status, 'cancelled');
  assert.equal(Object.hasOwn(after, 'completion'), false);
  const again = await (await request(`/v1/runs/${run.id}/cancel`, { method: 'POST' })).json();
  assert.equal(again.status, 'cancelled');
});

test('run submission, lookup and cancellation enforce the API bearer and reject mismatched browsers', async (t) => {
  const apiKey = 'pc-run-auth-private';
  const { request } = await setup(t, { apiKey });
  const headers = { authorization: `Bearer ${apiKey}` };
  assert.equal((await request('/v1/runs', { method: 'POST', body: { prompt: 'Hello' } })).status, 401);
  const run = await (await request('/v1/runs', { method: 'POST', headers, body: { prompt: 'SLOW: authenticated' } })).json();
  assert.equal((await request(`/v1/runs/${run.id}`)).status, 401);
  assert.equal((await request(`/v1/runs/${run.id}/cancel`, { method: 'POST' })).status, 401);
  const cors = await request(`/v1/runs/${run.id}`, { headers: { ...headers, origin: 'https://client.example' } });
  assert.equal(cors.status, 200);
  assert.match(cors.headers.get('access-control-expose-headers'), /X-Run-Id/i);
  assert.equal((await request(`/v1/runs/${run.id}/cancel`, { method: 'POST', headers })).status, 200);
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

test('request selection uses the configured default model and rejects invalid models and effort levels', async (t) => {
  const { request, runtime } = await setup(t);
  const omitted = await request('/v1/chat/completions', { method: 'POST',
    body: { messages: [{ role: 'user', content: 'REQUEST_METADATA:' }] } });
  assert.equal(omitted.status, 200);
  const result = await omitted.json();
  assert.equal(result.model, 'fake/fake-model');
  assert.equal(JSON.parse(result.choices[0].message.content).model, 'fake/fake-model');
  const sessionsBefore = runtime.list().length;
  for (const body of [
    completion('hello', { model: '' }),
    completion('hello', { model: false }),
    completion('hello', { model: 'fake/plain-model', reasoning_effort: 'high' }),
    completion('hello', { model: 'fake/limited-model', reasoning_effort: 'medium' }),
    completion('hello', { reasoning_effort: 'xhigh' }),
    completion('hello', { context_window: 64000 }),
  ]) assert.equal((await request('/v1/chat/completions', { method: 'POST', body })).status, 400);
  assert.equal((await request('/v1/chat/completions', { method: 'POST', body: completion('hello', { model: 'pi' }) })).status, 404);
  assert.equal(runtime.list().length, sessionsBefore);
});

test('an omitted model prefers the managed gateway default while an explicit native model ID retains its provider', async t => {
  const { request, runtime } = await setup(t, { modelApiKey: 'managed-test-key', defaultModel: 'fake/fake-model' });
  const nativeId = 'fake/fake-model';
  const managedId = 'picall/fake/fake-model';
  runtime.models = async () => [nativeId, managedId].map(id => ({ id, reasoningEfforts: ['off'] }));
  const selections = [];
  runtime.acquire = async ({ sessionId, model }) => {
    selections.push(model);
    return { id: sessionId, model, run: async () => ({ text: model, finishReason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) };
  };
  const omitted = await request('/v1/chat/completions', { method: 'POST',
    body: { messages: [{ role: 'user', content: 'Use configured gateway' }] } });
  assert.equal(omitted.status, 200);
  const defaultResult = await omitted.json();
  assert.equal(defaultResult.model, managedId);
  assert.equal(defaultResult.choices[0].message.content, managedId);
  const explicit = await request('/v1/chat/completions', { method: 'POST',
    body: completion('Use explicit native provider', { model: nativeId }) });
  assert.equal(explicit.status, 200);
  const nativeResult = await explicit.json();
  assert.equal(nativeResult.model, nativeId);
  assert.equal(nativeResult.choices[0].message.content, nativeId);
  assert.deepEqual(selections, [managedId, nativeId]);
});

test('reasoning_effort null is equivalent to omission and preserves an existing session effort', async t => {
  const { request } = await setup(t);
  const omitted = await request('/v1/chat/completions', { method: 'POST',
    body: completion('REQUEST_METADATA: default null effort', { reasoning_effort: null }) });
  assert.equal(omitted.status, 200);
  const defaultResult = await omitted.json();
  const metadata = JSON.parse(defaultResult.choices[0].message.content);
  assert.equal(metadata.effort, 'medium');
  assert.equal(metadata.explicitEffort, false);
  const first = await request('/v1/chat/completions', { method: 'POST',
    body: completion('REQUEST_METADATA: explicit high effort', { reasoning_effort: 'high' }) });
  assert.equal(first.status, 200);
  await first.json();
  const continuation = await request('/v1/chat/completions', { method: 'POST',
    headers: { 'x-session-id': first.headers.get('x-session-id') },
    body: completion('REQUEST_METADATA: retain effort with null', { reasoning_effort: null }) });
  assert.equal(continuation.status, 200);
  const continuedMetadata = JSON.parse((await continuation.json()).choices[0].message.content);
  assert.equal(continuedMetadata.effort, 'high');
  assert.equal(continuedMetadata.explicitEffort, true);
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

async function systemPromptMetadata(response) {
  assert.equal(response.status, 200);
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const wire = await response.text();
    const records = wire.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
    assert.equal(records.at(-1), '[DONE]');
    const content = records.filter(record => record !== '[DONE]').map(record => JSON.parse(record))
      .flatMap(record => record.choices || []).map(choice => choice.delta?.content || '').join('');
    return JSON.parse(content);
  }
  return JSON.parse((await response.json()).choices[0].message.content);
}

test('Additional system prompt defaults upgrade legacy config without rewriting and validate atomic persistent updates', async (t) => {
  const apiKey = 'sk-additional-prompt-config-test';
  const { request, configStore, dataDir } = await setup(t, { apiKey, enableSkills: true, saveSessions: true,
    enableExtensions: false, toolOverrides: { bash: true } });
  const legacy = JSON.parse(await readFile(configStore.path, 'utf8'));
  delete legacy.additionalSystemPrompt;
  const legacyContents = JSON.stringify(legacy);
  await writeFile(configStore.path, legacyContents, { mode: 0o600 });
  await configStore.load();
  assert.equal((await (await request('/api/config')).json()).additionalSystemPrompt, defaultAdditionalSystemPrompt);
  assert.equal(await readFile(configStore.path, 'utf8'), legacyContents);

  for (const additionalSystemPrompt of ['CUSTOM_PROMPT_CONFIG_CANARY', '', 'x'.repeat(16384)]) {
    const response = await request('/api/config', { method: 'PUT', body: { additionalSystemPrompt } });
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.additionalSystemPrompt, additionalSystemPrompt);
    assert.equal(config.apiKeyConfigured, true);
    assert.equal(Object.hasOwn(config, 'apiKey'), false);
    const reloaded = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
    await reloaded.load();
    assert.deepEqual(reloaded.value, { ...legacy, additionalSystemPrompt });
  }
  const before = await readFile(configStore.path, 'utf8');
  const beforeValue = structuredClone(configStore.value);
  for (const additionalSystemPrompt of [null, false, 1, {}, [], 'x'.repeat(16385), 'invalid\0prompt']) {
    const response = await request('/api/config', { method: 'PUT', body: { additionalSystemPrompt } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /additionalSystemPrompt/);
    assert.equal(await readFile(configStore.path, 'utf8'), before);
    assert.deepEqual(configStore.value, beforeValue);
  }
});

test('Additional system prompt appends to client system and developer messages for JSON and SSE requests', async (t) => {
  const { request, logger } = await setup(t);
  const system = 'CLIENT_SYSTEM_CANARY_Keep answers concise.';
  const developer = 'CLIENT_DEVELOPER_CANARY_Use plain language.';
  for (const stream of [false, true]) {
    const response = await request('/v1/chat/completions', { method: 'POST', body: completion('SYSTEM_PROMPT_METADATA:', {
      stream, messages: [{ role: 'system', content: system }, { role: 'developer', content: developer },
        { role: 'user', content: 'SYSTEM_PROMPT_METADATA:' }],
    }) });
    assert.deepEqual(await systemPromptMetadata(response), {
      systemPrompt: `${system}\n\n${developer}\n\n${defaultAdditionalSystemPrompt}`, hasAppendSystemPrompt: true,
    });
  }
  const withoutClientSystem = await request('/v1/chat/completions', { method: 'POST', body: completion('SYSTEM_PROMPT_METADATA:') });
  assert.deepEqual(await systemPromptMetadata(withoutClientSystem), {
    systemPrompt: defaultAdditionalSystemPrompt, hasAppendSystemPrompt: true,
  });
  const logs = JSON.stringify(logger.history());
  assert.ok(!logs.includes(system));
  assert.ok(!logs.includes(developer));
});

test('Additional system prompt is appended once when a continued session omits client system instructions', async (t) => {
  const { request } = await setup(t);
  const clientSystem = 'SESSION_SYSTEM_CANARY_Answer in Chinese.';
  const body = completion('SYSTEM_PROMPT_METADATA:', { messages: [
    { role: 'system', content: clientSystem }, { role: 'user', content: 'SYSTEM_PROMPT_METADATA:' },
  ] });
  const first = await request('/v1/chat/completions', { method: 'POST', body });
  const id = first.headers.get('x-session-id');
  const expected = { systemPrompt: `${clientSystem}\n\n${defaultAdditionalSystemPrompt}`, hasAppendSystemPrompt: true };
  assert.deepEqual(await systemPromptMetadata(first), expected);
  for (const stream of [false, true]) {
    const response = await request('/v1/chat/completions', { method: 'POST', headers: { 'x-session-id': id },
      body: completion('SYSTEM_PROMPT_METADATA:', { stream }) });
    assert.deepEqual(await systemPromptMetadata(response), expected);
  }
});

test('Additional system prompt changes require new sessions and an empty value disables only the extra prompt', async (t) => {
  const { request, logger } = await setup(t);
  const clientSystem = 'CLIENT_PROMPT_PRESERVED_CANARY';
  const body = completion('SYSTEM_PROMPT_METADATA:', { messages: [
    { role: 'system', content: clientSystem }, { role: 'user', content: 'SYSTEM_PROMPT_METADATA:' },
  ] });
  const first = await request('/v1/chat/completions', { method: 'POST', body });
  const id = first.headers.get('x-session-id');
  await systemPromptMetadata(first);
  const additionalSystemPrompt = 'CUSTOM_ADDITIONAL_PROMPT_CANARY_Use at most two tool layers.';
  assert.equal((await request('/api/config', { method: 'PUT', body: { additionalSystemPrompt } })).status, 200);
  const outdated = await request('/v1/chat/completions', { method: 'POST', headers: { 'x-session-id': id },
    body: completion('SYSTEM_PROMPT_METADATA:') });
  assert.equal(outdated.status, 409);
  assert.equal((await outdated.json()).error.code, 'session_configuration_changed');
  const updated = await request('/v1/chat/completions', { method: 'POST', body });
  assert.deepEqual(await systemPromptMetadata(updated), {
    systemPrompt: `${clientSystem}\n\n${additionalSystemPrompt}`, hasAppendSystemPrompt: true,
  });

  assert.equal((await request('/api/config', { method: 'PUT', body: { additionalSystemPrompt: '' } })).status, 200);
  const clientOnly = await request('/v1/chat/completions', { method: 'POST', body });
  assert.deepEqual(await systemPromptMetadata(clientOnly), { systemPrompt: clientSystem, hasAppendSystemPrompt: true });
  const noSystem = await request('/v1/chat/completions', { method: 'POST', body: completion('SYSTEM_PROMPT_METADATA:', { stream: true }) });
  assert.deepEqual(await systemPromptMetadata(noSystem), { systemPrompt: '', hasAppendSystemPrompt: false });
  const logs = JSON.stringify(logger.history());
  assert.ok(!logs.includes(clientSystem));
  assert.ok(!logs.includes(additionalSystemPrompt));
});
