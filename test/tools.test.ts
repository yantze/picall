import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebTools, parseWebURL, boundedText } from '../src/tools';
const env = {
  BRAVE_KEY: 'b',
  TAVILY_KEY: 't',
  TINYFISH_KEY: 'f',
  EXA_KEY: 'e',
  BRAVE_BASE_URL: 'https://brave.vastiny.com/res/v1',
  TAVILY_BASE_URL: 'https://tavily.vastiny.com',
  HTTP_TOOLS: '[]',
};
function setup(net: any, extra: any = {}) {
  const map = new Map();
  return {
    map,
    web: new WebTools(
      { ...env, ...extra },
      {
        get: async (k) => map.get(k),
        put: async (k, v) => {
          map.set(k, v);
        },
      },
      async () => ({ id: 'run', deadline: Date.now() + 10000 }),
      net,
    ),
  };
}
test('search follows Brave -> Tavily -> TinyFish and correct auth/contracts', async () => {
  const calls: any[] = [];
  const { web } = setup(async (url: string, init: any) => {
    calls.push([url, init]);
    return calls.length < 3
      ? new Response('', { status: 429 })
      : Response.json({
          results: [{ url: 'https://example.com', title: 'a', snippet: 'b' }],
        });
  });
  const result = await web.search({ query: 'q', page: 1 });
  assert.equal(result.provider, 'tinyfish');
  assert.equal(new URL(calls[2][0]).searchParams.get('query'), 'q');
  assert.equal(calls[0][1].headers['X-Subscription-Token'], 'b');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer t');
  assert.equal(calls[2][1].headers['X-API-Key'], 'f');
});
for (const status of [401, 403, 400])
  test(`search ${status} stops fallback`, async () => {
    let calls = 0;
    const { web } = setup(async () => {
      calls++;
      return new Response('', { status });
    });
    await assert.rejects(web.search({ query: 'q' }));
    assert.equal(calls, 1);
  });
test('empty results and explicit Exa never trigger other providers', async () => {
  let calls = 0;
  const { web } = setup(async (url: string) => {
    calls++;
    assert.match(url, /exa/);
    return Response.json({ results: [] });
  });
  assert.equal(
    (await web.search({ query: 'q', provider: 'exa' })).results.length,
    0,
  );
  assert.equal(calls, 1);
});
test('missing credential is explicit and abort stops fallback', async () => {
  let calls = 0;
  const { web } = setup(
    async () => {
      calls++;
      return Response.json({ results: [] });
    },
    { BRAVE_KEY: undefined },
  );
  await assert.rejects(
    web.search({ query: 'q' }),
    /missing_provider_credentials/,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(web.search({ query: 'q' }, controller.signal));
  assert.equal(calls, 0);
});
test('fetch uses Jina then TinyFish with batch markdown contract and persistent find', async () => {
  const calls: string[] = [];
  const { web } = setup(async (url: string, init: any) => {
    calls.push(url);
    if (calls.length === 1) return new Response('', { status: 503 });
    const body = JSON.parse(init.body);
    assert.deepEqual(body.urls, ['https://example.com/page']);
    assert.equal(body.format, 'markdown');
    return Response.json({
      results: [{ url: body.urls[0], text: 'Useful body text' }],
      errors: [],
    });
  });
  const result = await web.content('https://example.com/page');
  assert.equal(result.provider, 'tinyfish_fetch');
  assert.match(calls[0], /r.jina.ai/);
  assert.match(calls[1], /api.fetch.tinyfish/);
  assert.equal(
    (
      await web.stored({
        content_id: result.content_id,
        find: 'body',
        limit: 6,
      })
    ).found,
    7,
  );
});
test('HTTP fallback follows redirects across arbitrary HTTP/HTTPS hosts and retains body limits', async () => {
  const urls: string[] = [];
  const { web } = setup(async (url: string) => {
    urls.push(url);
    if (urls.length < 3) return new Response('', { status: 503 });
    if (urls.length === 3)
      return new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1:8080/redirected' },
      });
    return new Response('redirected source', {
      headers: { 'Content-Type': 'text/plain' },
    });
  });
  const result = await web.content('https://unlisted.example.org/source');
  assert.equal(result.provider, 'http');
  assert.equal(result.text, 'redirected source');
  assert.equal(urls[3], 'http://127.0.0.1:8080/redirected');
  await assert.rejects(
    boundedText(
      new Response('x', {
        headers: { 'Content-Length': String(3 * 1024 * 1024) },
      }),
    ),
    /response_too_large/,
  );
});
test('web URLs have no host, IP, port or whitelist restrictions', () => {
  for (const url of [
    'http://example.com',
    'https://127.1',
    'https://[::1]',
    'https://user:pass@localhost',
    'https://example.com:8443',
    'http://internal.local:8080/page',
    'https://unlisted.example.org',
  ])
    assert.ok(parseWebURL(url));
  assert.throws(() => parseWebURL('not-a-url'), /invalid_url/);
  assert.throws(
    () => parseWebURL('file:///etc/passwd'),
    /unsupported_url_scheme/,
  );
});

test('deadline stops network activity', async () => {
  let calls = 0;
  const web = new WebTools(
    env,
    { get: async () => undefined, put: async () => {} },
    async () => ({ id: 'r', deadline: Date.now() - 1 }),
    async () => {
      calls++;
      return new Response('');
    },
  );
  await assert.rejects(web.search({ query: 'q' }), /deadline_exceeded/);
  assert.equal(calls, 0);
});
test('fallback preserves recency and domain exclusion with postfiltering', async () => {
  const requests: any[] = [];
  const { web } = setup(async (url: string, init: any) => {
    requests.push([url, init]);
    if (requests.length === 1) return new Response('', { status: 503 });
    return Response.json({
      results: [
        { url: 'https://example.com/a' },
        { url: 'https://blocked.example.com/a' },
        { url: 'https://other.com/a' },
      ],
    });
  });
  const result = await web.search({
    query: 'q',
    freshness: 'pw',
    domains: ['example.com', '-blocked.example.com'],
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://example.com/a');
  const body = JSON.parse(requests[1][1].body);
  assert.equal(body.time_range, 'week');
  assert.deepEqual(body.exclude_domains, ['blocked.example.com']);
});
test('explicit Exa carries date and domains without fallback', async () => {
  const { web } = setup(async (url: string, init: any) => {
    assert.equal(url, 'https://api.exa.ai/search');
    const body = JSON.parse(init.body);
    assert.ok(body.startPublishedDate);
    assert.deepEqual(body.includeDomains, ['example.com']);
    return Response.json({ results: [] });
  });
  await web.search({
    query: 'q',
    provider: 'exa',
    freshness: 'pd',
    domains: ['example.com'],
  });
});
test('non-HTTP final URL and unsupported MIME stop fetch fallback', async () => {
  let calls = 0;
  const { web } = setup(async () => {
    calls++;
    return new Response('image', { headers: { 'Content-Type': 'image/png' } });
  });
  await assert.rejects(
    web.content('https://example.com'),
    /unsupported_content_type/,
  );
  assert.equal(calls, 1);
  const second = setup(async () => {
    calls++;
    if (calls === 2) return new Response('', { status: 503 });
    return Response.json({
      results: [
        {
          url: 'https://example.com',
          final_url: 'file:///etc/passwd',
          text: 'body',
        },
      ],
    });
  });
  await assert.rejects(
    second.web.content('https://example.com'),
    /unsupported_url_scheme/,
  );
});
test('parallel managed tools retain both request counts and custom tools fail closed', async () => {
  const { web, map } = setup(
    async () =>
      new Response('body', { headers: { 'Content-Type': 'text/plain' } }),
  );
  await Promise.all([
    web.content('https://example.com/a'),
    web.content('https://example.com/b'),
  ]);
  assert.equal(map.get('calls:run').jina, 2);
  assert.throws(
    () =>
      setup(fetch, {
        HTTP_TOOLS: JSON.stringify([
          {
            name: 'web_search',
            url: 'https://example.com',
            description: 'collision',
            parameters: { type: 'object' },
          },
        ]),
      }).web.registry(),
    /invalid_http_tool_config/,
  );
  assert.throws(
    () =>
      setup(fetch, {
        HTTP_TOOLS: JSON.stringify([
          {
            name: 'lookup',
            url: 'file:///etc/passwd',
            description: 'bad URL',
            parameters: { type: 'object' },
          },
        ]),
      }).web.registry(),
    /unsupported_url_scheme/,
  );
});

test('search failures include safe provider/status diagnostics and fallback trail', async () => {
  const { web } = setup(
    async () =>
      new Response('provider response may contain secrets', { status: 429 }),
  );
  await assert.rejects(web.search({ query: 'q' }), (error: any) => {
    assert.equal(error.code, 'provider_unavailable');
    assert.deepEqual(
      error.details.attempts.map((a: any) => [a.provider, a.upstream_status]),
      [
        ['brave', 429],
        ['tavily', 429],
        ['tinyfish', 429],
      ],
    );
    assert.doesNotMatch(error.message, /provider response may contain secrets/);
    return true;
  });
});
