import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const bindings = {
  API_BEARER: 'test-only',
  MODEL: '@cf/zai-org/glm-5.3-flash',
  BRAVE_BASE_URL: 'https://brave.vastiny.com/res/v1',
  TAVILY_BASE_URL: 'https://tavily.vastiny.com',
  BRAVE_KEY: 'mock',
  TINYFISH_KEY: 'mock',
  HTTP_TOOLS: '[]',
};
const options = (persist: string, extra: Record<string, string> = {}) => ({
  ...convertV4MiniflareOptions({
    modules: [{ type: 'ESModule' as const, path: 'test-dist/mock-worker.js' }],
    compatibilityDate: '2026-11-07',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { ...bindings, ...extra },
    durableObjects: {
      SESSIONS: { className: 'SearchSession', useSQLite: true },
      KEYS: { className: 'RequestKey', useSQLite: true },
    },
    name: 'picall-runtime-test',
    durableObjectsPersist: persist,
  }),
  resourcePersistencePath: persist,
});
const headers = {
  Authorization: 'Bearer test-only',
  'Content-Type': 'application/json',
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function req(
  mf: Miniflare,
  path: string,
  body?: unknown,
  extra: any = {},
) {
  return mf.dispatchFetch('https://test' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function settled(mf: Miniflare, id: string) {
  for (let i = 0; i < 140; i++) {
    const r = await req(mf, '/v1/runs/' + id);
    const data: any = await r.json();
    if (!['accepted', 'running'].includes(data.status)) return data;
    await wait(150);
  }
  throw new Error('run did not settle');
}
test(
  'workerd: API auth, durable tool loop, idempotency, JSON/SSE, history and restart',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'picall-test-'));
    let mf = new Miniflare(options(dir));
    try {
      assert.equal(
        (await mf.dispatchFetch('https://test/v1/models')).status,
        401,
      );
      assert.equal((await req(mf, '/v1/models')).status, 200);
      const accepted = await req(
        mf,
        '/v1/runs',
        { prompt: 'research' },
        { 'Idempotency-Key': 'same' },
      );
      assert.equal(accepted.status, 202, await accepted.clone().text());
      const first: any = await accepted.json();
      assert.ok(first.id);
      const duplicate: any = await (
        await req(
          mf,
          '/v1/runs',
          { prompt: 'research' },
          { 'Idempotency-Key': 'same' },
        )
      ).json();
      assert.equal(duplicate.id, first.id);
      assert.equal(
        (
          await req(
            mf,
            '/v1/runs',
            { prompt: 'different' },
            { 'Idempotency-Key': 'same' },
          )
        ).status,
        409,
      );
      const result = await settled(mf, first.id);
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(
        result.completion.choices[0].message.content,
        'Final answer [source](https://example.com/article)',
      );
      assert.equal(result.usage.total_tokens, 60);
      assert.deepEqual(result.service_calls, { brave: 2, jina: 2 });
      const chat = await req(
        mf,
        '/v1/chat/completions',
        { messages: [{ role: 'user', content: 'next' }] },
        { 'X-Session-Id': first.session_id },
      );
      assert.equal(chat.status, 200, await chat.clone().text());
      const continued: any = await chat.json();
      assert.match(continued.choices[0].message.content, /Final answer/);
      assert.equal(continued.usage.total_tokens, 15);
      assert.equal(
        (
          await req(
            mf,
            '/v1/chat/completions',
            {
              messages: [
                { role: 'user', content: 'wrong' },
                { role: 'assistant', content: 'wrong' },
                { role: 'user', content: 'next' },
              ],
            },
            { 'X-Session-Id': first.session_id },
          )
        ).status,
        409,
      );
      const stream = await req(mf, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'research' }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const sse = await stream.text();
      assert.match(sse, /chat.completion.chunk/);
      assert.match(sse, /\[DONE\]/);
      assert.doesNotMatch(sse, /Intermediate research plan/);
      assert.match(sse, /total_tokens/);
      const disconnected = await req(mf, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'research' }],
        stream: true,
      });
      const runId = disconnected.headers.get('x-run-id')!;
      const reader = disconnected.body!.getReader();
      await reader.read();
      await reader.cancel();
      assert.equal((await settled(mf, runId)).status, 'succeeded');
      await mf.dispose();
      mf = new Miniflare(options(dir));
      const recovered: any = await (
        await req(mf, '/v1/runs/' + first.id)
      ).json();
      assert.deepEqual(recovered.completion, result.completion);
      const again: any = await (
        await req(
          mf,
          '/v1/runs',
          { prompt: 'research' },
          { 'Idempotency-Key': 'same' },
        )
      ).json();
      assert.equal(again.id, first.id);
      const ns = await mf.getDurableObjectNamespace('SESSIONS');
      try {
        await ns
          .get(ns.idFromName(first.session_id))
          .fetch('https://internal/test-cleanup');
      } catch {}
      assert.equal((await req(mf, '/v1/runs/' + first.id)).status, 404);
      const fresh = await req(
        mf,
        '/v1/runs',
        { prompt: 'research' },
        { 'X-Session-Id': first.session_id },
      );
      assert.equal(fresh.status, 202, await fresh.clone().text());
    } finally {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  'workerd: same-session concurrency, explicit cancellation and turn limit are failures',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'picall-failure-'));
    const mf = new Miniflare(options(dir));
    try {
      const response = await req(mf, '/v1/runs', { prompt: 'slow' });
      const run: any = await response.json();
      assert.equal(response.status, 202);
      assert.equal(
        (
          await req(
            mf,
            '/v1/runs',
            { prompt: 'next' },
            { 'X-Session-Id': run.session_id },
          )
        ).status,
        409,
      );
      const cancel = await req(mf, '/v1/runs/' + run.id + '/cancel', {});
      assert.equal(cancel.status, 200);
      assert.equal(((await cancel.json()) as any).status, 'cancelled');
      const exhausted: any = await (
        await req(mf, '/v1/runs', { prompt: 'exhaust' })
      ).json();
      const result = await settled(mf, exhausted.id);
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.equal(result.error.code, 'turn_limit');
      assert.equal(result.completion, undefined);
      assert.ok(result.usage.total_tokens >= 8 * 15);
    } finally {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'workerd: interrupted model resumes from SQLite and expired task cannot succeed',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'picall-resume-'));
    let mf = new Miniflare(options(dir));
    try {
      const first: any = await (
        await req(
          mf,
          '/v1/runs',
          { prompt: 'slow research' },
          { 'Idempotency-Key': 'resume' },
        )
      ).json();
      assert.ok(first.id);
      await mf.dispose();
      mf = new Miniflare(options(dir));
      const recovered = await settled(mf, first.id);
      assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered));
      const paused: any = await (
        await req(mf, '/v1/runs', { prompt: 'toolpause research' })
      ).json();
      await wait(300);
      await mf.dispose();
      mf = new Miniflare(options(dir));
      assert.equal((await settled(mf, paused.id)).status, 'succeeded');
      const second: any = await (
        await req(mf, '/v1/runs', { prompt: 'slow timeout' })
      ).json();
      const ns = await mf.getDurableObjectNamespace('SESSIONS');
      await ns
        .get(ns.idFromName(second.session_id))
        .fetch('https://internal/test-expire');
      const result = await settled(mf, second.id);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'deadline_exceeded');
      assert.equal(result.completion, undefined);
    } finally {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'workerd: DeepSeek BYOK gateway runs managed tools and final-only JSON/SSE',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'picall-deepseek-'));
    const mf = new Miniflare(
      options(dir, { MODEL: 'deepseek-flash', AI_GATEWAY_ID: 'deepseek' }),
    );
    try {
      const models: any = await (await req(mf, '/v1/models')).json();
      assert.equal(models.data[0].id, 'deepseek-flash');
      const response = await req(mf, '/v1/chat/completions', {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'research' }],
      });
      assert.equal(response.status, 200, await response.clone().text());
      const data: any = await response.json();
      assert.equal(data.model, 'deepseek-flash');
      assert.equal(
        data.choices[0].message.content,
        'Final answer [source](https://example.com/article)',
      );
      assert.equal(data.usage.total_tokens, 60);
      const streamed = await req(mf, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'research' }],
        stream: true,
      });
      const text = await streamed.text();
      assert.match(text, /Final answer/);
      assert.doesNotMatch(text, /Intermediate research/);
      assert.match(text, /\[DONE\]/);
      assert.equal(
        (
          await req(mf, '/v1/chat/completions', {
            model: '@cf/zai-org/glm-5.3-flash',
            messages: [{ role: 'user', content: 'hello' }],
          })
        ).status,
        404,
      );
    } finally {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'workerd: managed tools use the real global fetch receiver',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'picall-global-fetch-'));
    let outbound = 0;
    const config = options(dir, { USE_GLOBAL_FETCH: '1' });
    const mf = new Miniflare({
      ...config,
      workers: config.workers.map((worker) => ({
        ...worker,
        dev: {
          ...worker.dev,
          outboundService: {
            type: 'fetcher' as const,
            handler: async (request: Request) => {
              outbound++;
              if (new URL(request.url).hostname === 'r.jina.ai')
                return new Response('Source body', {
                  headers: { 'Content-Type': 'text/plain' },
                });
              return Response.json({
                web: {
                  results: [
                    { url: 'https://example.com/article', title: 'Source' },
                  ],
                },
              });
            },
          },
        },
      })),
    });
    try {
      const accepted: any = await (
        await req(mf, '/v1/runs', { prompt: 'research' })
      ).json();
      const run = await settled(mf, accepted.id);
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
      assert.equal(outbound, 4, JSON.stringify(run));
      assert.deepEqual(run.service_calls, { brave: 2, jina: 2 });
      const cached: any = await (
        await req(mf, '/v1/runs', { prompt: 'cache exercise' })
      ).json();
      const cachedRun = await settled(mf, cached.id);
      assert.equal(cachedRun.status, 'succeeded', JSON.stringify(cachedRun));
      assert.equal(
        outbound,
        6,
        'duplicate search and parallel reads must reuse managed results',
      );
      assert.deepEqual(cachedRun.service_calls, { brave: 1, jina: 1 });
    } finally {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'workerd: concurrent long waits settle once and do not block cancellation',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'picall-wait-'));
    const mf = new Miniflare(options(dir));
    try {
      const started: any = await (
        await req(mf, '/v1/runs', { prompt: 'slow' })
      ).json();
      const ns = await mf.getDurableObjectNamespace('SESSIONS');
      const stub = ns.get(ns.idFromName(started.session_id));
      const one = stub.fetch('https://internal/wait?id=' + started.id);
      const two = stub.fetch('https://internal/wait?id=' + started.id);
      await wait(100);
      const before = Date.now();
      const cancelled: any = await (
        await req(mf, '/v1/runs/' + started.id + '/cancel', {})
      ).json();
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(
        Date.now() - before < 1500,
        'long wait must not hold the cancellation lock',
      );
      const results = (await Promise.all([
        one.then((r) => r.json()),
        two.then((r) => r.json()),
      ])) as any[];
      assert.ok(
        results.every((r) => r.status === 'cancelled' && !r.completion),
      );
      const body = { messages: [{ role: 'user', content: 'research' }] };
      const responses = await Promise.all([
        req(mf, '/v1/chat/completions', body, {
          'Idempotency-Key': 'parallel-wait',
        }),
        req(mf, '/v1/chat/completions', body, {
          'Idempotency-Key': 'parallel-wait',
        }),
      ]);
      assert.equal(responses[0].status, 200);
      const completions: any[] = await Promise.all(
        responses.map((r) => r.json()),
      );
      assert.deepEqual(completions[0], completions[1]);
      assert.equal(completions[0].usage.total_tokens, 60);
      const followUp = await req(
        mf,
        '/v1/chat/completions',
        {
          messages: [
            ...body.messages,
            completions[0].choices[0].message,
            { role: 'user', content: 'next' },
          ],
        },
        { 'X-Session-Id': responses[0].headers.get('x-session-id') },
      );
      assert.equal(followUp.status, 200, await followUp.clone().text());
    } finally {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
