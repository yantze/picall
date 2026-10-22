import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../src/pi-rpc.js';

// Exercise the installed Pi executable and its actual tool loop without a paid
// provider or a user's credentials. Only the upstream model transport is fake.
test('bundled Pi applies context/effort and executes a complete tool loop', { timeout: 45_000 }, async () => {
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
    process.env.PI_CODING_AGENT_DIR = profile;
    const events = [];
    runtime = new PiRuntime({
      getConfig: () => ({ workdir: tmpdir(), model: 'picall-test/rpc-test', effort: 'medium', contextWindow: 32_000, requestTimeoutSeconds: 30 }),
      logger: { log: (_level, message, details) => events.push({ message, details }) },
    });
    assert.equal((await runtime.check()).available, true);
    assert.ok((await runtime.models()).some((model) => model.id === 'picall-test/rpc-test'));
    const session = await runtime.acquire({ systemPrompt: 'Picall integration marker: preserve the agent tools.' });
    const state = await session.worker.send({ type: 'get_state' });
    assert.equal(state.model.contextWindow, 32_000);
    assert.equal(state.thinkingLevel, 'medium');
    let streamed = '';
    const result = await session.run('Run bash to print picall-real-tool-ok and report completion.', { onText: (delta) => { streamed += delta; } });
    assert.equal(result.text, 'Real Pi completed the tool loop.');
    assert.equal(streamed, result.text);
    assert.deepEqual(result.usage, { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].tools.some((tool) => tool.function?.name === 'bash'));
    assert.ok(JSON.stringify(calls[0].messages).includes('Picall integration marker'));
    assert.ok(calls[1].messages.some((message) => message.role === 'tool' && message.content.includes('picall-real-tool-ok')));
    assert.ok(events.some((event) => event.message === 'Pi tool_execution_end.' && event.details.isError === false));
    assert.equal(session.busy, false);
  } finally {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(profile, { recursive: true, force: true });
  }
});
