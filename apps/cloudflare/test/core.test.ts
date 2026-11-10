import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, history, hash, usageDelta, readBody } from '../src/core';
const model = '@cf/zai-org/glm-5.3-flash';
test('text normalization and rejection of client tools', () => {
  assert.equal(
    normalize(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
      },
      model,
    ).messages[0].content,
    'hello',
  );
  for (const value of [
    { tools: [] },
    { messages: [{ role: 'user', content: [{ type: 'image_url' }] }] },
    { model: 'other' },
    { stream: 'yes' },
  ])
    assert.throws(() =>
      normalize(
        { messages: [{ role: 'user', content: 'hi' }], ...value },
        model,
      ),
    );
});
test('history accepts only next input or exact full history', async () => {
  const messages: any = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'answer' },
  ];
  const previous = {
    hashes: await Promise.all(messages.map(hash)),
    system: 's',
    model,
  };
  assert.equal(
    (
      await history(
        normalize(
          { messages: [...messages, { role: 'user', content: 'next' }] },
          model,
        ),
        previous,
      )
    ).messages.length,
    1,
  );
  assert.equal(
    (
      await history(
        normalize({ messages: [{ role: 'user', content: 'next' }] }, model),
        previous,
      )
    ).system,
    's',
  );
  await assert.rejects(
    history(
      normalize(
        {
          messages: [
            { role: 'user', content: 'changed' },
            { role: 'user', content: 'next' },
          ],
        },
        model,
      ),
      previous,
    ),
    (error:any) => error.code === 'session_history_conflict',
  );
});
test('usage sums every model and subtracts prior run including cache', () => {
  const priced=usageDelta({models:{a:{cost:{total:0.5}}}},{models:{a:{cost:{total:0.2}}}});
  assert.deepEqual(priced.models.a.cost,{total:0.3,source:'catalog_estimate'});
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(
        usageDelta(
          {
            models: {
              a: { input: 30, output: 10, cacheRead: 5 },
              b: { input: 2, output: 3 },
            },
          },
          { models: { a: { input: 10, output: 4 } } },
        ),
      ).filter(([k]) => k !== 'models'),
    ),
    { prompt_tokens: 27, completion_tokens: 9, total_tokens: 36 },
  );
});
test('body limit applies without content-length', async () => {
  await assert.rejects(
    readBody(
      new Request('https://example.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'a'.repeat(1024 * 1024) }),
      }),
    ),
    (error:any) => error.status === 413,
  );
});
