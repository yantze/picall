import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../src/pi-rpc.js';

// Exercise the installed Pi executable and its actual tool loop without a paid
// provider or a user's credentials. Only the upstream model transport is fake.
test('bundled Pi applies request effort, retains model context and executes a complete tool loop', { timeout: 45_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'picall-real-pi-'));
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      calls.push(data);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finishReason = null, usage) => response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-picall-test', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'rpc-test',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      })}\n\n`);
      chunk({ role: 'assistant' });
      if (calls.length === 1) {
        chunk({ tool_calls: [{ index: 0, id: 'call_local_bash', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command: "printf 'picall-real-tool-ok'" }),
        } }] });
        chunk({}, 'tool_calls', { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 });
      } else {
        chunk({ content: 'Real Pi completed the tool loop.' });
        chunk({}, 'stop', { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 });
      }
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  try {
    await writeFile(join(profile, 'models.json'), JSON.stringify({ providers: { 'picall-test': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      api: 'openai-completions', apiKey: 'local-test-fixture',
      models: [{ id: 'rpc-test', name: 'RPC Test', contextWindow: 128_000,
        maxTokens: 1024, reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    const savedSettings = JSON.stringify({ defaultProvider: 'picall-test', defaultModel: 'rpc-test', defaultThinkingLevel: 'low' });
    await writeFile(join(profile, 'settings.json'), savedSettings, { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = profile;
    const events = [];
    runtime = new PiRuntime({
      getConfig: () => ({ workdir: tmpdir(), requestTimeoutSeconds: 30 }),
      logger: { log: (_level, message, details) => events.push({ message, details }) },
    });
    assert.equal((await runtime.check()).available, true);
    const models = await runtime.models();
    const capabilities = models.find(model => model.id === 'picall-test/rpc-test');
    assert.equal(capabilities.contextWindow, 128_000);
    assert.equal(capabilities.maxTokens, 1024);
    assert.deepEqual(capabilities.reasoningEfforts, ['off', 'minimal', 'low', 'medium', 'high']);
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), savedSettings);
    const session = await runtime.acquire({ model: 'picall-test/rpc-test', effort: 'medium', systemPrompt: 'Picall integration marker: preserve the agent tools.' });
    const state = await session.worker.send({ type: 'get_state' });
    assert.equal(state.model.contextWindow, 128_000);
    assert.equal(state.thinkingLevel, 'medium');
    assert.ok(session.snapshot.tools.includes('bash'));
    assert.ok(session.snapshot.availableTools.includes('bash'));
    let streamed = '';
    const toolEvents = [];
    const result = await session.run('Run bash to print picall-real-tool-ok and report completion.', {
      onText: (delta) => { streamed += delta; }, onToolEvent: (event) => toolEvents.push(event),
    });
    assert.equal(result.text, 'Real Pi completed the tool loop.');
    assert.equal(streamed, result.text);
    assert.deepEqual(result.usage, { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].tools.some((tool) => tool.function?.name === 'bash'));
    assert.ok(JSON.stringify(calls[0].messages).includes('Picall integration marker'));
    assert.ok(calls[1].messages.some((message) => message.role === 'tool' && message.content.includes('picall-real-tool-ok')));
    assert.ok(events.some((event) => event.message === 'Pi tool_execution_end.' && event.details.isError === false));
    assert.deepEqual(toolEvents, [{ tool: 'bash', status: 'running' }, { tool: 'bash', status: 'completed' }]);
    assert.ok(!JSON.stringify(toolEvents).includes('picall-real-tool-ok'));
    assert.ok(!JSON.stringify(events).includes('picall-real-tool-ok'));
    assert.equal(session.busy, false);
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), savedSettings, 'per-request selection must not change Pi defaults');
  } finally {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(profile, { recursive: true, force: true });
  }
});

test('project tools are only loaded after explicit trust and diagnostics follow the current trust policy', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'picall-project-trust-'));
  const profile = join(root, 'profile');
  const workdir = join(root, 'project');
  const extensions = join(workdir, '.pi', 'extensions');
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  let runtime;
  try {
    await mkdir(profile, { recursive: true });
    await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, 'web-probe.js'), `export default function(pi) {
      pi.registerTool({ name: 'web_probe', label: 'Web probe', description: 'A local test search tool.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        async execute() { return { content: [{ type: 'text', text: 'local search fixture' }] }; }
      });
    }\n`);
    await writeFile(join(profile, 'models.json'), JSON.stringify({ providers: { 'picall-test': {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'local-test-fixture',
      models: [{ id: 'trust-test', name: 'Trust Test', contextWindow: 32_000, maxTokens: 1024,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = profile;
    const config = { workdir, projectTrust: 'default', requestTimeoutSeconds: 15 };
    runtime = new PiRuntime({ getConfig: () => config });
    for (const projectTrust of ['default', 'allow', 'deny', 'default']) {
      config.projectTrust = projectTrust;
      const diagnostic = await runtime.check();
      assert.equal(diagnostic.available, true, diagnostic.error);
      assert.equal(diagnostic.workdir, workdir);
      assert.equal(diagnostic.agentDir, profile);
      assert.equal(typeof diagnostic.offlineStartup, 'boolean');
      assert.ok(diagnostic.tools.includes('bash'));
      assert.ok(diagnostic.availableTools.includes('bash'));
      assert.equal(diagnostic.tools.includes('web_probe'), projectTrust === 'allow', `${projectTrust}: active tools`);
      assert.equal(diagnostic.availableTools.includes('web_probe'), projectTrust === 'allow', `${projectTrust}: available tools`);
      const session = await runtime.acquire({ model: 'picall-test/trust-test', effort: 'off' });
      assert.equal(session.snapshot.workdir, workdir);
      assert.equal(session.snapshot.agentDir, profile);
      assert.equal(typeof session.snapshot.offlineStartup, 'boolean');
      assert.equal(session.snapshot.tools.includes('web_probe'), projectTrust === 'allow', `${projectTrust}: session tools`);
      assert.equal(session.snapshot.availableTools.includes('web_probe'), projectTrust === 'allow', `${projectTrust}: session available tools`);
    }
  } finally {
    await runtime?.close();
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test('native Pi history is opt-in, survives shutdown and records multiple turns in one session file', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'picall-native-sessions-'));
  const profile = join(root, 'profile');
  const workdir = join(root, 'project');
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  const calls = [];
  let runtime;
  async function sessionFiles(directory = join(profile, 'sessions')) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await sessionFiles(path));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
    return files.sort();
  }
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      calls.push(data);
      const lastUser = JSON.stringify(data.messages.findLast(message => message.role === 'user')?.content);
      const toolCompleted = data.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('PERSISTED_TOOL_RESULT'));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-native-session-test', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'session-test',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      chunk({ role: 'assistant' });
      if (lastUser.includes('PERSISTED_USER_ONE') && !toolCompleted) {
        chunk({ tool_calls: [{ index: 0, id: 'call_saved_bash', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command: "printf 'PERSISTED_TOOL_RESULT'" }),
        } }] });
        chunk({}, 'tool_calls');
      } else {
        const text = lastUser.includes('PERSISTED_USER_TWO') ? 'PERSISTED_ASSISTANT_TWO'
          : lastUser.includes('PERSISTED_USER_ONE') ? 'PERSISTED_ASSISTANT_ONE' : 'TRANSIENT_ASSISTANT';
        chunk({ content: text });
        chunk({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(profile, { recursive: true });
    await mkdir(workdir, { recursive: true });
    await writeFile(join(profile, 'models.json'), JSON.stringify({ providers: { 'picall-test': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-fixture',
      models: [{ id: 'session-test', name: 'Session Test', contextWindow: 32_000, maxTokens: 1024,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = profile;
    const config = { workdir, projectTrust: 'deny', requestTimeoutSeconds: 20 };
    const selection = { model: 'picall-test/session-test', effort: 'off' };
    runtime = new PiRuntime({ getConfig: () => config });
    const transient = await runtime.acquire({ sessionId: 'transient', ...selection });
    assert.equal(transient.saveSessions, false, 'omitting the setting must not save provider transcripts');
    assert.equal(transient.sessionFile, null);
    assert.equal((await transient.run('TRANSIENT_USER_CANARY')).text, 'TRANSIENT_ASSISTANT');
    assert.ok(!(await transient.worker.send({ type: 'get_state' })).sessionFile);
    await runtime.closeSession(transient.id);
    assert.deepEqual(await sessionFiles(), [], 'default-off model requests must not write native sessions');
    await runtime.close();

    config.saveSessions = true;
    // Use a fresh runtime so neither probe can be satisfied by an earlier cache.
    runtime = new PiRuntime({ getConfig: () => config });
    assert.equal((await runtime.check()).available, true);
    assert.deepEqual(await sessionFiles(), [], 'health probes must always use --no-session');
    assert.ok((await runtime.models()).some(model => model.id === selection.model));
    assert.deepEqual(await sessionFiles(), [], 'model discovery must always use --no-session');
    assert.equal(calls.length, 1, 'diagnostic probes must not invoke the model');

    const saved = await runtime.acquire({ sessionId: 'saved-conversation', ...selection });
    assert.equal(saved.saveSessions, true);
    assert.equal(typeof saved.sessionFile, 'string');
    const nativeFile = saved.sessionFile;
    assert.equal((await saved.worker.send({ type: 'get_state' })).sessionFile, nativeFile);
    assert.equal((await saved.run('PERSISTED_USER_ONE: run bash and record its output.')).text, 'PERSISTED_ASSISTANT_ONE');
    assert.deepEqual(await sessionFiles(), [nativeFile]);
    const continued = await runtime.acquire({ sessionId: saved.id, ...selection });
    assert.equal(continued.sessionFile, nativeFile, 'the HTTP session identifier must keep the same native Pi session');
    assert.equal((await continued.run('PERSISTED_USER_TWO: continue this conversation.')).text, 'PERSISTED_ASSISTANT_TWO');
    assert.deepEqual(await sessionFiles(), [nativeFile]);
    const beforeShutdown = await readFile(nativeFile, 'utf8');
    const records = beforeShutdown.trim().split('\n').map(line => JSON.parse(line));
    const messages = records.filter(record => record.type === 'message').map(record => record.message);
    assert.equal(messages.filter(message => message.role === 'user').length, 2);
    assert.ok(messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('PERSISTED_USER_ONE')));
    assert.ok(messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('PERSISTED_USER_TWO')));
    assert.ok(messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('PERSISTED_ASSISTANT_ONE')));
    assert.ok(messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('PERSISTED_ASSISTANT_TWO')));
    assert.ok(messages.some(message => message.role === 'toolResult' && JSON.stringify(message.content).includes('PERSISTED_TOOL_RESULT')));
    assert.ok(!beforeShutdown.includes('TRANSIENT_USER_CANARY'));
    assert.equal(calls.length, 4, 'two persisted turns must include a real Pi tool execution and follow-up model call');

    config.saveSessions = false;
    await assert.rejects(runtime.acquire({ sessionId: saved.id, ...selection }), error => error.code === 'session_configuration_changed');
    await runtime.closeSession(saved.id);
    assert.equal(await readFile(nativeFile, 'utf8'), beforeShutdown, 'closing a worker must retain its native history');
    await runtime.close();
    runtime = new PiRuntime({ getConfig: () => config });
    assert.deepEqual(runtime.list(), [], 'a new service runtime must not automatically restore HTTP sessions');
    assert.equal((await runtime.check()).available, true);
    await runtime.models();
    assert.equal(await readFile(nativeFile, 'utf8'), beforeShutdown, 'a restarted service must retain prior Pi history');
    assert.deepEqual(await sessionFiles(), [nativeFile]);
  } finally {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});
