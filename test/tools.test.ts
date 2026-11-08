import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebTools,
  parseWebURL,
  boundedText,
  contentIssue,
  previewOffset,
} from '../src/tools';
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

test('search previews stay small, preserve explicit count and cache all query parameters per run', async () => {
  const requests: URL[] = [];
  const { web, map } = setup(async (url: string) => {
    const u = new URL(url);
    requests.push(u);
    return Response.json({
      web: {
        results: Array.from({ length: 10 }, (_, i) => ({
          url: `https://example.com/${i}`,
          title: 'Source',
          description: 'x'.repeat(5000),
        })),
      },
    });
  });
  const first = await web.search({ query: 'q' });
  assert.equal(first.results.length, 3);
  assert.equal(requests[0].searchParams.get('count'), '3');
  assert.equal(first.results[0].snippet.length, 600);
  assert.deepEqual(
    await web.search({ query: 'q', provider: 'auto', count: 3, page: 1 }),
    first,
  );
  const restored = new WebTools(
    env,
    {
      get: async (k) => map.get(k),
      put: async (k, v) => {
        map.set(k, v);
      },
    },
    async () => ({ id: 'run', deadline: Date.now() + 10000 }),
    async () => {
      throw Error('cached work must not reach the network');
    },
  );
  assert.deepEqual(await restored.search({ query: 'q' }), first);
  assert.equal(requests.length, 1);
  assert.equal(
    (await web.search({ query: 'q', count: 10 })).results.length,
    10,
  );
  await web.search({ query: 'q', page: 2 });
  await web.search({ query: 'q', freshness: 'pd' });
  await web.search({ query: 'q', domains: ['example.com'] });
  assert.equal(requests.length, 5);
  const other = new WebTools(
    env,
    {
      get: async (k) => map.get(k),
      put: async (k, v) => {
        map.set(k, v);
      },
    },
    async () => ({ id: 'another-run', deadline: Date.now() + 10000 }),
    async () => {
      requests.push(new URL('https://example.com'));
      return Response.json({ web: { results: [] } });
    },
  );
  await other.search({ query: 'q' });
  assert.equal(requests.length, 6);
});

test('short body previews retain full persisted text for tail lookup after reopening tools', async () => {
  let calls = 0;
  const body = 'a'.repeat(22000) + 'TAIL weather 15 degrees';
  const { web, map } = setup(async () => {
    calls++;
    return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
  });
  const first = await web.content('https://example.com/article#one');
  assert.equal(first.text.length, 6000);
  assert.equal(first.length, body.length);
  assert.equal(
    (await web.stored({ content_id: first.content_id })).text.length,
    4000,
  );
  const reopened = new WebTools(
    env,
    {
      get: async (k) => map.get(k),
      put: async (k, v) => {
        map.set(k, v);
      },
    },
    async () => ({ id: 'run', deadline: Date.now() + 10000 }),
    async () => {
      throw Error('duplicate fetch');
    },
  );
  assert.equal(
    (await reopened.content('https://example.com/article#two')).content_id,
    first.content_id,
  );
  const tail = await reopened.stored({
    content_id: first.content_id,
    find: 'TAIL',
  });
  assert.equal(tail.found, 22000);
  assert.match(tail.text, /TAIL weather 15 degrees/);
  assert.equal(
    (await reopened.stored({ content_id: first.content_id, limit: 20000 })).text
      .length,
    20000,
  );
  assert.equal(calls, 1);
});

test('duplicate in-flight reads share a request without one cancelled reader cancelling the other', async () => {
  let calls = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { web } = setup(async (_url: string, init: RequestInit) => {
    calls++;
    await ready;
    assert.equal(init.signal?.aborted, false);
    return new Response('Shared useful body', {
      headers: { 'Content-Type': 'text/plain' },
    });
  });
  const controller = new AbortController();
  const one = web.content('https://example.com/shared', controller.signal);
  const rejected = assert.rejects(one, (e: any) => e.name === 'AbortError');
  const two = web.content('https://example.com/shared');
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await rejected;
  release();
  assert.equal((await two).text, 'Shared useful body');
  assert.equal(calls, 1);
});

test('an abandoned shared read stops its network request and cannot cache a failed attempt', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const { web } = setup(async (_url: string, init: RequestInit) => {
    calls++;
    if (calls > 1)
      return new Response('recovered', {
        headers: { 'Content-Type': 'text/plain' },
      });
    started();
    await new Promise((_, reject) =>
      init.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason),
        { once: true },
      ),
    );
    throw Error('unreachable');
  });
  const controller = new AbortController();
  const rejected = assert.rejects(
    web.content('https://example.com/retry', controller.signal),
  );
  await ready;
  controller.abort();
  await rejected;
  assert.equal(
    (await web.content('https://example.com/retry')).text,
    'recovered',
  );
  assert.equal(calls, 2);
});

test('challenge detection rejects reader errors and challenge pages without rejecting articles about CAPTCHA', async () => {
  const blocked =
    'Title: Forbidden\nURL Source: https://example.com\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\nPlease verify you are human';
  assert.equal(contentIssue(blocked), 'upstream_error_page');
  assert.equal(
    contentIssue(
      'Title: WEB 应用防火墙\nURL Source: http://example.com\nWarning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.\n\nMarkdown Content:\n当前正在对访问请求进行人机识别检测，请稍等片刻\n向右滑动填充拼图',
    ),
    'access_challenge',
  );
  assert.equal(
    contentIssue(
      '<html><title>Just a moment...</title><body>Checking your browser</body></html>',
    ),
    'access_challenge',
  );
  assert.equal(
    contentIssue(
      'Title: Understanding CAPTCHA\nMarkdown Content:\nThis article quotes "Please verify you are human" and explains CAPTCHA.',
    ),
    undefined,
  );
  assert.equal(
    contentIssue(
      'Title: Reader errors explained\nMarkdown Content:\nWarning: Target URL returned error 403: Forbidden\nThis is an example in a technical article.',
    ),
    undefined,
  );
  let calls = 0;
  const { web } = setup(async () => {
    calls++;
    return calls === 1
      ? new Response(blocked)
      : Response.json({ results: [{ text: 'Real weather data' }] });
  });
  assert.equal(
    (await web.content('https://example.com/weather')).provider,
    'tinyfish_fetch',
  );
  assert.equal(calls, 2);
});

test('a long reader navigation prelude is skipped without changing stored text or original offsets', async () => {
  const navigation = Array.from(
    { length: 50 },
    (_, i) =>
      `[City ${i}](https://example.com/weather/some-very-long-navigation-path/${i})`,
  ).join('\n');
  const body = `Title: Today\nURL Source: https://example.com\n\nMarkdown Content:\n${navigation}\n\n09:30 report\n\n# Today\nRain, 12-19 degrees\n${'Forecast detail '.repeat(800)}`;
  const { web } = setup(async () => new Response(body));
  const doc = await web.content('https://example.com');
  assert.ok(doc.offset > 3000);
  assert.match(doc.text, /09:30 report/);
  assert.match(doc.text, /Rain, 12-19 degrees/);
  assert.equal(doc.text, body.slice(doc.offset, doc.offset + 6000));
  assert.equal(doc.length, body.length);
  const original = await web.stored({
    content_id: doc.content_id,
    offset: 0,
    limit: 20000,
  });
  assert.equal(original.text, body);
  assert.equal(
    previewOffset(
      'Title: Article\nMarkdown Content:\n# Article\n' + navigation,
    ),
    0,
  );
  assert.equal(previewOffset('{"temperature":16}'), 0);
  for (const beginning of [
    '```ts\nconst n = 1;\n```',
    '| city | weather |',
    '[One](https://example.com)\n# Today',
  ])
    assert.equal(
      previewOffset(
        'Title: Article\nMarkdown Content:\n' + beginning + '\n' + navigation,
      ),
      0,
    );
  assert.equal(
    previewOffset(
      'Title: Article\nMarkdown Content:\nA meaningful introduction ' +
        'word '.repeat(30) +
        '\n' +
        navigation +
        '\n# Appendix',
    ),
    0,
  );
});

test('exhausted blocked readers return a diagnostic failure and failed reads are not cached', async () => {
  let calls = 0;
  const { web } = setup(async (url: string) => {
    calls++;
    return String(url).includes('api.fetch.tinyfish')
      ? Response.json({ results: [{ text: 'Please verify you are human.' }] })
      : new Response('Please verify you are human.');
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(web.content('https://example.com'), (e: any) => {
      assert.equal(e.code, 'content_unavailable');
      assert.deepEqual(
        e.details.attempts.map((a: any) => a.reason),
        Array(3).fill('access_challenge'),
      );
      return true;
    });
  assert.equal(calls, 6);
});
