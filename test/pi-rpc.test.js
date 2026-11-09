import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PiRuntime } from '../src/pi-rpc.js';

const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

function createRuntime(t, overrides = {}, options = {}) {
  const config = { workdir: process.cwd(),
    maxSessions: 8, idleTimeoutMinutes: 30, requestTimeoutSeconds: 5, ...overrides };
  const runtime = new PiRuntime({ getConfig: () => config, command: { file: process.execPath, args: [fakePi] }, ...options });
  t.after(() => runtime.close());
  return runtime;
}

test('RPC discovers models and handles Unicode separators inside JSONL strings', async (t) => {
  const runtime = createRuntime(t);
  assert.equal((await runtime.check()).available, true);
  assert.equal((await runtime.models())[0].id, 'fake/fake-model');
  const session = await runtime.acquire({});
  let streamed = '';
  const result = await session.run('UNICODE:', { onText: (delta) => { streamed += delta; } });
  assert.equal(result.text, 'Hello line\u2028paragraph\u2029end');
  assert.equal(streamed, result.text);
});

test('aborting a request discards its session so incomplete turns cannot be reused', async (t) => {
  const runtime = createRuntime(t);
  const session = await runtime.acquire({ sessionId: 'cancel-me' });
  const controller = new AbortController();
  const pending = session.run('SLOW: please wait', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error.code === 'request_cancelled');
  assert.deepEqual(runtime.list(), []);
  assert.equal(session.busy, false);
});

test('an already-aborted request releases the reserved session', async (t) => {
  const runtime = createRuntime(t);
  const session = await runtime.acquire({ sessionId: 'already-aborted' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.run('Do not run', { signal: controller.signal }), (error) => error.code === 'request_cancelled');
  assert.deepEqual(runtime.list(), []);
});

test('model failures produce errors rather than successful empty completions', async (t) => {
  const runtime = createRuntime(t);
  const session = await runtime.acquire({});
  await assert.rejects(session.run('FAIL_PROVIDER:'), (error) => error.code === 'provider_error' && error.status === 502);
  assert.deepEqual(runtime.list(), []);
});

test('a startup exit exposes only allowlisted diagnostics and never retries unrelated conflicts', async t => {
  const logs = [];
  const script = `console.error('PRIVATE_PROMPT_CANARY ' + process.env.PICALL_MODEL_API_KEY);
    console.error('Error: Tool "web_search" conflicts with https://secret.example/?key=DO_NOT_EXPOSE');
    console.error('Error: Tool "PRIVATE_LOCAL_API_CANARY" conflicts with registered extension');
    process.exit(1);`;
  const runtime = createRuntime(t, { modelApiKey: 'PRIVATE_MODEL_CANARY', apiKey: 'PRIVATE_LOCAL_API_CANARY' }, {
    logger: { log: (level, message, details) => logs.push({ level, message, details }) },
    command: { file: process.execPath, args: ['-e', script, '--'] },
  });
  const status = await runtime.check();
  assert.equal(status.available, false);
  assert.ok(status.error.includes('Tool "web_search" conflicts'));
  assert.equal(logs.filter(item => item.message === 'Pi process exited.').length, 1);
  const exposed = JSON.stringify({ status, logs });
  for (const value of ['PRIVATE_PROMPT_CANARY', 'PRIVATE_MODEL_CANARY', 'PRIVATE_LOCAL_API_CANARY', 'DO_NOT_EXPOSE', 'https://secret.example']) assert.ok(!exposed.includes(value));
  assert.deepEqual((await runtime.extensions()).filter(entry => entry.autoDisabled), []);
});

test('capacity rejects busy sessions, evicts idle sessions and preserves expired-session identity', async (t) => {
  const runtime = createRuntime(t, { maxSessions: 1 });
  const session = await runtime.acquire({ sessionId: 'retained' });
  await assert.rejects(runtime.acquire({ sessionId: 'another' }), (error) => error.code === 'session_limit');
  await session.run('Hello');
  await assert.rejects(runtime.acquire({ sessionId: 'retained', effort: 'high' }), (error) => error.code === 'session_configuration_changed');
  const replacement = await runtime.acquire({ sessionId: 'another' });
  assert.deepEqual(runtime.list().map((entry) => entry.id), ['another']);
  await assert.rejects(runtime.acquire({ sessionId: 'retained' }), (error) => error.code === 'session_expired');
  assert.equal((await replacement.run('Hello again')).text, 'Hello from Pi (turn 1)');
  await runtime.closeSession('another');
  await assert.rejects(runtime.acquire({ sessionId: 'another' }), (error) => error.code === 'session_expired');
  const fresh = await runtime.acquire({ sessionId: 'fresh' });
  assert.equal((await fresh.run('New context')).text, 'Hello from Pi (turn 1)');
});

test('tool failure notifications expose names and states without query arguments or result content', { timeout: 10_000 }, async (t) => {
  const logs = [];
  const runtime = createRuntime(t, {}, { logger: { log: (level, message, details) => logs.push({ level, message, details }) } });
  const session = await runtime.acquire({});
  const notifications = [];
  await session.run('TOOL_EVENTS: TOOL_FAIL', { onToolEvent: (event) => notifications.push(event) });
  assert.deepEqual(notifications, [{ tool: 'web_probe', status: 'running' }, { tool: 'web_probe', status: 'failed' }]);
  assert.ok(logs.some((entry) => entry.message === 'Pi tool_execution_end.' && entry.details.isError === true));
  const exposed = JSON.stringify({ logs, notifications });
  assert.ok(!exposed.includes('PICALL_PRIVATE_TOOL_QUERY'));
  assert.ok(!exposed.includes('PICALL_PRIVATE_TOOL_RESULT'));
});

test('shutdown after a worker starts but before adoption leaves no Pi process', async (t) => {
  const runtime = createRuntime(t);
  let worker;
  const createWorker = runtime.createWorker.bind(runtime);
  runtime.createWorker = async options => {
    worker = await createWorker(options);
    await runtime.close();
    return worker;
  };
  await assert.rejects(runtime.acquire({ sessionId: 'shutdown-before-adoption' }), error => error.code === 'session_expired');
  assert.deepEqual(runtime.list(), []);
  assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null, 'the unadopted worker must exit');
});

test('shutdown during extension discovery prevents a late Pi process from starting', async (t) => {
  const runtime = createRuntime(t, { extensionOverrides: { 'builtin:mcp': false } });
  const discovery = Promise.withResolvers();
  runtime.extensions = () => discovery.promise;
  const pending = runtime.acquire({ sessionId: 'shutdown-during-discovery' });
  const rejected = assert.rejects(pending, error => error.code === 'runtime_closed');
  await runtime.close();
  discovery.resolve([]);
  await rejected;
  assert.deepEqual(runtime.list(), []);
});
