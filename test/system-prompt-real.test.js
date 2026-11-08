import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../src/pi-rpc.js';
import { Logger } from '../src/logger.js';

// Keep this literal independent of the implementation so punctuation and the
// runtime fallback are checked against the requested default.
const DEFAULT_ADDITION = '按问题复杂度使用工具：简单事实优先一次搜索和一个权威来源，证据充分后立即回答；复杂研究按需补查。';
const NATIVE_PREFIX = 'You are an expert coding assistant operating inside pi, a coding agent harness.';

function systemText(request) {
  return request.messages.filter(message => message.role === 'system').map(message =>
    typeof message.content === 'string' ? message.content
      : message.content.map(part => part.text || '').join('\n')).join('\n\n');
}

function occurrences(text, marker) {
  return text.split(marker).length - 1;
}

function assertAppended(system, client, addition) {
  assert.ok(system.includes(NATIVE_PREFIX), 'the Pi agent system prompt must remain intact');
  assert.equal(occurrences(system, client), 1, 'client instructions must not be duplicated');
  assert.ok(system.indexOf(NATIVE_PREFIX) < system.indexOf(client));
  const addendum = system.match(/<addendum>\n([\s\S]*?)\n<\/addendum>/)?.[1];
  assert.ok(addendum?.includes(client), 'client instructions must reach the actual system addendum');
  if (addition) {
    assert.equal(occurrences(system, addition), 1, 'configured instructions must not be duplicated');
    assert.ok(system.indexOf(client) < system.indexOf(addition), 'gateway instructions must follow client instructions');
    assert.ok(addendum.endsWith(addition), 'configured text must be last in the appended instructions');
  }
}

test('additional system prompt reaches the real Pi model without replacing native or client instructions', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'picall-system-prompt-'));
  const profile = join(root, 'profile');
  const workdir = join(root, 'project');
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  const calls = [];
  let runtime;
  let logger;
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-system-prompt-test', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'system-test',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      chunk({ role: 'assistant', content: 'Local system prompt fixture completed.' });
      chunk({}, 'stop');
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
      models: [{ id: 'system-test', name: 'System Prompt Test', contextWindow: 32_000, maxTokens: 1024,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }), { mode: 0o600 });
    const savedSettings = JSON.stringify({ defaultProvider: 'picall-test', defaultModel: 'system-test', defaultThinkingLevel: 'off' });
    await writeFile(join(profile, 'settings.json'), savedSettings, { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = profile;
    const config = { workdir, projectTrust: 'deny', requestTimeoutSeconds: 20 };
    logger = new Logger({ dataDir: join(root, 'operational-logs') });
    runtime = new PiRuntime({ getConfig: () => config, logger });
    const selection = { model: 'picall-test/system-test', effort: 'off' };
    async function run(session, prompt) {
      const before = calls.length;
      const result = await session.run(prompt);
      assert.equal(result.text, 'Local system prompt fixture completed.');
      assert.equal(calls.length, before + 1, 'only the local mock provider should receive a model request');
      return systemText(calls.at(-1));
    }

    const defaultClient = 'PICALL_DEFAULT_CLIENT_SYSTEM_CANARY';
    const defaultSession = await runtime.acquire({ ...selection, systemPrompt: defaultClient });
    const defaultSystem = await run(defaultSession, 'Check the default system prompt.');
    assertAppended(defaultSystem, defaultClient, DEFAULT_ADDITION);
    await runtime.closeSession(defaultSession.id);

    config.additionalSystemPrompt = '';
    const emptyClient = 'PICALL_EMPTY_CLIENT_SYSTEM_CANARY';
    const emptySession = await runtime.acquire({ ...selection, systemPrompt: emptyClient });
    const emptySystem = await run(emptySession, 'Check the explicitly disabled addition.');
    assertAppended(emptySystem, emptyClient, '');
    assert.ok(!emptySystem.includes(DEFAULT_ADDITION), 'only an explicitly empty string disables the default addition');
    await runtime.closeSession(emptySession.id);

    const customClient = 'PICALL_CUSTOM_CLIENT_SYSTEM_CANARY';
    const configuredAddition = 'PICALL_CONFIG_SYSTEM_CANARY\nKeep these private fixture instructions after the client instructions.';
    config.additionalSystemPrompt = configuredAddition;
    const first = await runtime.acquire({ sessionId: 'custom-prompt-session', ...selection, systemPrompt: customClient });
    const firstSystem = await run(first, 'First turn with the configured addition.');
    assertAppended(firstSystem, customClient, configuredAddition);
    assert.ok(!firstSystem.includes(DEFAULT_ADDITION), 'a custom addition must replace the fallback text');
    const continued = await runtime.acquire({ sessionId: first.id, ...selection, systemPrompt: customClient });
    const secondSystem = await run(continued, 'Second turn in the same conversation.');
    assert.equal(continued.id, first.id);
    assertAppended(secondSystem, customClient, configuredAddition);

    const changedAddition = 'PICALL_CHANGED_SYSTEM_CANARY';
    config.additionalSystemPrompt = changedAddition;
    await assert.rejects(runtime.acquire({ sessionId: first.id, ...selection, systemPrompt: customClient }),
      error => error.status === 409 && error.code === 'session_configuration_changed');
    const fresh = await runtime.acquire({ ...selection, systemPrompt: customClient });
    const changedSystem = await run(fresh, 'Use the updated addition in a new conversation.');
    assertAppended(changedSystem, customClient, changedAddition);
    assert.ok(!changedSystem.includes(configuredAddition));
    assert.equal(calls.length, 5);

    await runtime.close();
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), savedSettings, 'request system prompts must not rewrite Pi defaults');
    assert.ok(logger.history().length > 0, 'the redaction check must inspect actual operational records');
    for (const exposed of [JSON.stringify(logger.history()), await readFile(logger.path, 'utf8')]) {
      for (const marker of [DEFAULT_ADDITION, defaultClient, emptyClient, customClient, 'PICALL_CONFIG_SYSTEM_CANARY', configuredAddition, changedAddition]) {
        assert.ok(!exposed.includes(marker), 'system prompt content must not appear in operational logs');
      }
    }
  } finally {
    await runtime?.close();
    logger?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});
