import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { createModelRuntime } from '../src/models';

test('DeepSeek survives model-reference lookup and uses native gateway BYOK without vendor credentials or wholesale fallback', async () => {
  let calls = 0;
  const AI = {
    run: async () => {
      throw new Error('DeepSeek must not use the Workers AI /run catalog');
    },
    fetch: async (url: string, init: RequestInit) => {
      calls++;
      assert.equal(
        url,
        'https://workers-binding.ai/ai-gateway/gateways/deepseek/deepseek/chat/completions',
      );
      const headers = new Headers(init.headers);
      assert.equal(headers.get('cf-aig-byok-alias'), 'default');
      assert.equal(headers.get('cf-aig-no-wholesale'), 'true');
      assert.equal(headers.get('authorization'), null);
      const input = JSON.parse(init.body as string);
      assert.equal(input.model, 'deepseek-flash');
      assert.equal(input.stream, true);
      assert.equal(input.max_tokens, 8192);
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'pong' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        },
      ];
      return new Response(
        chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  };
  const runtime = createModelRuntime({
    AI: AI as unknown as Ai,
    MODEL: 'deepseek-flash',
    AI_GATEWAY_ID: 'deepseek',
  });
  const models = createModels();
  models.setProvider(runtime.provider);
  const restored = models.getModel(runtime.model.provider, runtime.model.id);
  assert.ok(restored);
  const response = await models.completeSimple(restored, {
    messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  });
  assert.equal(response.stopReason, 'stop', response.errorMessage);
  assert.equal(response.content[0].type, 'text');
  assert.equal(response.usage.totalTokens, 3);
  assert.equal(calls, 1);
});
test('unsupported models and missing/invalid gateways fail explicitly', () => {
  assert.throws(
    () => createModelRuntime({ AI: {} as Ai, MODEL: 'other' }),
    /unsupported_model_configuration/,
  );
  assert.throws(
    () => createModelRuntime({ AI: {} as Ai, MODEL: 'deepseek-flash' }),
    /ai_gateway_required/,
  );
  assert.throws(
    () =>
      createModelRuntime({
        AI: {} as Ai,
        MODEL: 'deepseek-flash',
        AI_GATEWAY_ID: 'https://example.com',
      }),
    /invalid_ai_gateway/,
  );
});
