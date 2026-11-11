import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WebTools,
  parseWebURL,
  boundedText,
  contentIssue,
  previewOffset
} from "../index.js";
import { createResearchTools, researchSystemPrompt } from '../index.js';
const env = {
  BRAVE_KEY: "b",
  TAVILY_KEY: "t",
  TINYFISH_KEY: "f",
  EXA_KEY: "e",
  BRAVE_BASE_URL: "https://brave.vastiny.com/res/v1",
  TAVILY_BASE_URL: "https://tavily.vastiny.com",
  HTTP_TOOLS: "[]"
};
function setup(net, extra = {}) {
  const map = /* @__PURE__ */ new Map();
  return {
    map,
    web: new WebTools(
      { ...env, ...extra },
      {
        get: async (k) => map.get(k),
        put: async (k, v) => {
          map.set(k, v);
        }
      },
      async () => ({ id: "run", deadline: Date.now() + 1e4 }),
      net
    )
  };
}
test("search follows Brave -> Tavily -> TinyFish and correct auth/contracts", async () => {
  const calls = [];
  const { web } = setup(async (url, init) => {
    calls.push([url, init]);
    return calls.length < 3 ? new Response("", { status: 429 }) : Response.json({
      results: [{ url: "https://example.com", title: "a", snippet: "b" }]
    });
  });
  const result = await web.search({ query: "q", page: 1 });
  assert.equal(result.provider, "tinyfish");
  assert.equal(new URL(calls[2][0]).searchParams.get("query"), "q");
  assert.equal(calls[0][1].headers["X-Subscription-Token"], "b");
  assert.equal(calls[1][1].headers.Authorization, "Bearer t");
  assert.equal(calls[2][1].headers["X-API-Key"], "f");
});
for (const status of [401, 403, 400])
  test(`search ${status} stops fallback`, async () => {
    let calls = 0;
    const { web } = setup(async () => {
      calls++;
      return new Response("", { status });
    });
    await assert.rejects(web.search({ query: "q" }));
    assert.equal(calls, 1);
  });
test("empty results and explicit Exa never trigger other providers", async () => {
  let calls = 0;
  const { web } = setup(async (url) => {
    calls++;
    assert.match(url, /exa/);
    return Response.json({ results: [] });
  });
  assert.equal(
    (await web.search({ query: "q", provider: "exa" })).results.length,
    0
  );
  assert.equal(calls, 1);
});
test("missing credential is explicit and abort stops fallback", async () => {
  let calls = 0;
  const { web } = setup(
    async () => {
      calls++;
      return Response.json({ results: [] });
    },
    { BRAVE_KEY: void 0 }
  );
  await assert.rejects(
    web.search({ query: "q" }),
    /missing_provider_credentials/
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(web.search({ query: "q" }, controller.signal));
  assert.equal(calls, 0);
});
test("fetch uses Jina then TinyFish with batch markdown contract and persistent find", async () => {
  const calls = [];
  const { web } = setup(async (url, init) => {
    calls.push(url);
    if (calls.length === 1) {
      assert.equal(init.headers["X-Proxy"], "none");
      assert.equal(init.headers.Authorization, "Bearer jina-fixture-key");
      return new Response("", { status: 503 });
    }
    assert.equal(init.headers["X-Proxy"], undefined);
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.urls, ["https://example.com/page"]);
    assert.equal(body.format, "markdown");
    return Response.json({
      results: [{ url: body.urls[0], text: "Useful body text" }],
      errors: []
    });
  }, { JINA_KEY: "jina-fixture-key" });
  const result = await web.content("https://example.com/page");
  assert.equal(result.provider, "tinyfish_fetch");
  assert.match(calls[0], /r.jina.ai/);
  assert.match(calls[1], /api.fetch.tinyfish/);
  assert.equal(
    (await web.stored({
      content_id: result.content_id,
      find: "body",
      limit: 6
    })).found,
    7
  );
});
test("a slow Jina body cannot block a complete fallback and only the winner is cached", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let jinaStarted, jinaAborted = false;
  const ready = new Promise(resolve => { jinaStarted = resolve; });
  const { web, map } = setup(async (url, init) => {
    calls.push(url);
    if (String(url).includes('r.jina.ai')) {
      // Headers can arrive promptly while the actual body stalls.
      return new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => {
          jinaAborted = true;
          controller.error(init.signal.reason);
        }, { once: true });
        jinaStarted();
      } }), { headers: { 'Content-Type': 'text/plain' } });
    }
    return Response.json({ results: [{ text: 'Complete fallback source' }] });
  });
  const pending = web.content('https://example.com/slow');
  await ready;
  t.mock.timers.tick(1999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.provider, 'tinyfish_fetch');
  assert.equal(result.text, 'Complete fallback source');
  assert.equal(jinaAborted, true);
  assert.deepEqual(map.get('calls:run'), { jina: 1, tinyfish_fetch: 1 });
  assert.equal([...map.keys()].filter(key => key.startsWith('content:')).length, 1);
  assert.equal((await web.content('https://example.com/slow')).content_id, result.content_id);
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 2);
});
test("a failed speculative fallback leaves the preferred reader able to finish", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, started, fallbackDone;
  const ready = new Promise(resolve => { started = resolve; });
  const fallback = new Promise(resolve => { fallbackDone = resolve; });
  const { web } = setup(async (url, init) => {
    if (String(url).includes('r.jina.ai')) {
      started();
      await new Promise(resolve => { release = resolve; });
      assert.equal(init.signal.aborted, false);
      return new Response('Preferred complete source');
    }
    if (!String(url).includes('api.fetch.tinyfish')) fallbackDone();
    return new Response('', { status: 503 });
  });
  const pending = web.content('https://example.com/slow');
  await ready;
  t.mock.timers.tick(2000);
  await fallback;
  release();
  assert.equal((await pending).provider, 'jina');
});
test("cancelling hedged content aborts every active reader and writes no cache", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  let firstStarted, secondStarted;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const second = new Promise(resolve => { secondStarted = resolve; });
  const { web, map } = setup(async (_url, init) => {
    signals.push(init.signal);
    if (signals.length === 1) firstStarted(); else secondStarted();
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const rejected = assert.rejects(web.content('https://example.com/cancel', controller.signal), { name: 'AbortError' });
  await first;
  t.mock.timers.tick(2000);
  await second;
  controller.abort();
  await rejected;
  assert.ok(signals.every(signal => signal.aborted));
  t.mock.timers.tick(10000);
  assert.equal(signals.length, 2);
  assert.ok([...map.keys()].every(key => key.startsWith('calls:')));
});
test("fast Jina avoids speculative requests; empty reader envelopes require fallback", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fast = setup(async () => new Response('Complete source'));
  assert.equal((await fast.web.content('https://example.com')).provider, 'jina');
  t.mock.timers.tick(10000);
  assert.deepEqual(fast.map.get('calls:run'), { jina: 1 });
  const empty = setup(async url => String(url).includes('r.jina.ai')
    ? new Response('Title: An SPA\nURL Source: https://example.com\nMarkdown Content:\n\n')
    : Response.json({ results: [{ text: 'Rendered article body' }] }));
  assert.equal((await empty.web.content('https://example.com')).provider, 'tinyfish_fetch');
});
test("slow remote readers allow HTTP to finish and missing TinyFish credentials are skipped", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const tinyfish of ['configured', undefined]) {
    let firstStarted, secondStarted;
    const first = new Promise(resolve => { firstStarted = resolve; });
    const second = new Promise(resolve => { secondStarted = resolve; });
    const signals = [];
    const { web, map } = setup(async (url, init) => {
      if (url === 'https://example.com/source') return new Response('Direct source body');
      signals.push(init.signal);
      if (signals.length === 1) firstStarted(); else secondStarted();
      await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }, { TINYFISH_KEY: tinyfish });
    const pending = web.content('https://example.com/source');
    await first;
    t.mock.timers.tick(2000);
    if (tinyfish) { await second; t.mock.timers.tick(2000); }
    assert.equal((await pending).provider, 'http');
    assert.ok(signals.every(signal => signal.aborted));
    assert.deepEqual(map.get('calls:run'), { jina: 1, ...(tinyfish ? { tinyfish_fetch: 1 } : {}), http: 1 });
  }
});
test("the run deadline aborts outstanding content attempts and never caches them", async () => {
  const signals = [];
  const { web, map } = setup(async (_url, init) => {
    signals.push(init.signal);
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const run = { id: 'run', deadline: Date.now() + 40 };
  web.scope = async () => run;
  // AbortSignal.timeout does not keep Node alive on its own.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(web.content('https://example.com/deadline'), { code: 'deadline_exceeded' });
    assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
    assert.ok([...map.keys()].every(key => key.startsWith('calls:')));
  } finally { clearTimeout(keepAlive); }
});
test("HTTP fallback follows redirects across arbitrary HTTP/HTTPS hosts and retains body limits", async () => {
  const urls = [];
  const { web } = setup(async (url) => {
    urls.push(url);
    if (urls.length < 3) return new Response("", { status: 503 });
    if (urls.length === 3)
      return new Response("", {
        status: 302,
        headers: { Location: "http://127.0.0.1:8080/redirected" }
      });
    return new Response("redirected source", {
      headers: { "Content-Type": "text/plain" }
    });
  });
  const result = await web.content("https://unlisted.example.org/source");
  assert.equal(result.provider, "http");
  assert.equal(result.text, "redirected source");
  assert.equal(urls[3], "http://127.0.0.1:8080/redirected");
  await assert.rejects(
    boundedText(
      new Response("x", {
        headers: { "Content-Length": String(3 * 1024 * 1024) }
      })
    ),
    /response_too_large/
  );
});
test("web URLs have no host, IP, port or whitelist restrictions", () => {
  for (const url of [
    "http://example.com",
    "https://127.1",
    "https://[::1]",
    "https://user:pass@localhost",
    "https://example.com:8443",
    "http://internal.local:8080/page",
    "https://unlisted.example.org"
  ])
    assert.ok(parseWebURL(url));
  assert.throws(() => parseWebURL("not-a-url"), /invalid_url/);
  assert.throws(
    () => parseWebURL("file:///etc/passwd"),
    /unsupported_url_scheme/
  );
});
test("deadline stops network activity", async () => {
  let calls = 0;
  const web = new WebTools(
    env,
    { get: async () => void 0, put: async () => {
    } },
    async () => ({ id: "r", deadline: Date.now() - 1 }),
    async () => {
      calls++;
      return new Response("");
    }
  );
  await assert.rejects(web.search({ query: "q" }), /deadline_exceeded/);
  assert.equal(calls, 0);
});
test("fallback preserves recency and domain exclusion with postfiltering", async () => {
  const requests = [];
  const { web } = setup(async (url, init) => {
    requests.push([url, init]);
    if (requests.length === 1) return new Response("", { status: 503 });
    return Response.json({
      results: [
        { url: "https://example.com/a" },
        { url: "https://blocked.example.com/a" },
        { url: "https://other.com/a" }
      ]
    });
  });
  const result = await web.search({
    query: "q",
    freshness: "pw",
    domains: ["example.com", "-blocked.example.com"]
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, "https://example.com/a");
  const body = JSON.parse(requests[1][1].body);
  assert.equal(body.time_range, "week");
  assert.deepEqual(body.exclude_domains, ["blocked.example.com"]);
});
test("explicit Exa carries date and domains without fallback", async () => {
  const { web } = setup(async (url, init) => {
    assert.equal(url, "https://api.exa.ai/search");
    const body = JSON.parse(init.body);
    assert.ok(body.startPublishedDate);
    assert.deepEqual(body.includeDomains, ["example.com"]);
    return Response.json({ results: [] });
  });
  await web.search({
    query: "q",
    provider: "exa",
    freshness: "pd",
    domains: ["example.com"]
  });
});
test("non-HTTP final URL and unsupported MIME stop fetch fallback", async () => {
  let calls = 0;
  const { web } = setup(async () => {
    calls++;
    return new Response("image", { headers: { "Content-Type": "image/png" } });
  });
  await assert.rejects(
    web.content("https://example.com"),
    /unsupported_content_type/
  );
  assert.equal(calls, 1);
  const second = setup(async () => {
    calls++;
    if (calls === 2) return new Response("", { status: 503 });
    return Response.json({
      results: [
        {
          url: "https://example.com",
          final_url: "file:///etc/passwd",
          text: "body"
        }
      ]
    });
  });
  await assert.rejects(
    second.web.content("https://example.com"),
    /unsupported_url_scheme/
  );
});
test("parallel managed tools retain both request counts and custom tools fail closed", async () => {
  const { web, map } = setup(
    async () => new Response("body", { headers: { "Content-Type": "text/plain" } })
  );
  await Promise.all([
    web.content("https://example.com/a"),
    web.content("https://example.com/b")
  ]);
  assert.equal(map.get("calls:run").jina, 2);
  assert.throws(
    () => setup(fetch, {
      HTTP_TOOLS: JSON.stringify([
        {
          name: "web_search",
          url: "https://example.com",
          description: "collision",
          parameters: { type: "object" }
        }
      ])
    }).web.registry(),
    /invalid_http_tool_config/
  );
  assert.throws(
    () => setup(fetch, {
      HTTP_TOOLS: JSON.stringify([
        {
          name: "lookup",
          url: "file:///etc/passwd",
          description: "bad URL",
          parameters: { type: "object" }
        }
      ])
    }).web.registry(),
    /unsupported_url_scheme/
  );
});
test("search failures include safe provider/status diagnostics and fallback trail", async () => {
  const { web } = setup(
    async () => new Response("provider response may contain secrets", { status: 429 })
  );
  await assert.rejects(web.search({ query: "q" }), (error) => {
    assert.equal(error.code, "provider_unavailable");
    assert.deepEqual(
      error.details.attempts.map((a) => [a.provider, a.upstream_status]),
      [
        ["brave", 429],
        ["tavily", 429],
        ["tinyfish", 429]
      ]
    );
    assert.doesNotMatch(error.message, /provider response may contain secrets/);
    return true;
  });
});
test("search previews stay small, preserve explicit count and cache all query parameters per run", async () => {
  const requests = [];
  const { web, map } = setup(async (url) => {
    const u = new URL(url);
    requests.push(u);
    return Response.json({
      web: {
        results: Array.from({ length: 10 }, (_, i) => ({
          url: `https://example.com/${i}`,
          title: "Source",
          description: "x".repeat(5e3)
        }))
      }
    });
  });
  const first = await web.search({ query: "q" });
  assert.equal(first.results.length, 3);
  assert.equal(requests[0].searchParams.get("count"), "3");
  assert.equal(first.results[0].snippet.length, 600);
  assert.deepEqual(
    await web.search({ query: "q", provider: "auto", count: 3, page: 1 }),
    first
  );
  const restored = new WebTools(
    env,
    {
      get: async (k) => map.get(k),
      put: async (k, v) => {
        map.set(k, v);
      }
    },
    async () => ({ id: "run", deadline: Date.now() + 1e4 }),
    async () => {
      throw Error("cached work must not reach the network");
    }
  );
  assert.deepEqual(await restored.search({ query: "q" }), first);
  assert.equal(requests.length, 1);
  assert.equal(
    (await web.search({ query: "q", count: 10 })).results.length,
    10
  );
  await web.search({ query: "q", page: 2 });
  await web.search({ query: "q", freshness: "pd" });
  await web.search({ query: "q", domains: ["example.com"] });
  assert.equal(requests.length, 5);
  const other = new WebTools(
    env,
    {
      get: async (k) => map.get(k),
      put: async (k, v) => {
        map.set(k, v);
      }
    },
    async () => ({ id: "another-run", deadline: Date.now() + 1e4 }),
    async () => {
      requests.push(new URL("https://example.com"));
      return Response.json({ web: { results: [] } });
    }
  );
  await other.search({ query: "q" });
  assert.equal(requests.length, 6);
});
test("short body previews retain full persisted text for tail lookup after reopening tools", async () => {
  let calls = 0;
  const body = "a".repeat(22e3) + "TAIL weather 15 degrees";
  const { web, map } = setup(async () => {
    calls++;
    return new Response(body, { headers: { "Content-Type": "text/plain" } });
  });
  const first = await web.content("https://example.com/article#one");
  assert.equal(first.text.length, 6e3);
  assert.equal(first.length, body.length);
  assert.equal(
    (await web.stored({ content_id: first.content_id })).text.length,
    4e3
  );
  const reopened = new WebTools(
    env,
    {
      get: async (k) => map.get(k),
      put: async (k, v) => {
        map.set(k, v);
      }
    },
    async () => ({ id: "run", deadline: Date.now() + 1e4 }),
    async () => {
      throw Error("duplicate fetch");
    }
  );
  assert.equal(
    (await reopened.content("https://example.com/article#two")).content_id,
    first.content_id
  );
  const tail = await reopened.stored({
    content_id: first.content_id,
    find: "TAIL"
  });
  assert.equal(tail.found, 22e3);
  assert.match(tail.text, /TAIL weather 15 degrees/);
  const missing = await reopened.stored({
    content_id: first.content_id,
    find: "absent phrase"
  });
  assert.equal(missing.found, -1);
  assert.equal(missing.text, "");
  assert.equal(
    (await reopened.stored({
      content_id: first.content_id,
      find: "absent phrase",
      offset: 0,
      limit: 12
    })).text,
    body.slice(0, 12)
  );
  assert.equal(
    (await reopened.stored({ content_id: first.content_id, limit: 2e4 })).text.length,
    2e4
  );
  assert.equal(calls, 1);
});
test("duplicate in-flight reads share a request without one cancelled reader cancelling the other", async () => {
  let calls = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const { web } = setup(async (_url, init) => {
    calls++;
    await ready;
    assert.equal(init.signal?.aborted, false);
    return new Response("Shared useful body", {
      headers: { "Content-Type": "text/plain" }
    });
  });
  const controller = new AbortController();
  const one = web.content("https://example.com/shared", controller.signal);
  const rejected = assert.rejects(one, (e) => e.name === "AbortError");
  const two = web.content("https://example.com/shared");
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await rejected;
  release();
  assert.equal((await two).text, "Shared useful body");
  assert.equal(calls, 1);
});
test("an abandoned shared read stops its network request and cannot cache a failed attempt", async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const { web } = setup(async (_url, init) => {
    calls++;
    if (calls > 1)
      return new Response("recovered", {
        headers: { "Content-Type": "text/plain" }
      });
    started();
    await new Promise(
      (_, reject) => init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true }
      )
    );
    throw Error("unreachable");
  });
  const controller = new AbortController();
  const rejected = assert.rejects(
    web.content("https://example.com/retry", controller.signal)
  );
  await ready;
  controller.abort();
  await rejected;
  assert.equal(
    (await web.content("https://example.com/retry")).text,
    "recovered"
  );
  assert.equal(calls, 2);
});
test("challenge detection rejects reader errors and challenge pages without rejecting articles about CAPTCHA", async () => {
  const blocked = "Title: Forbidden\nURL Source: https://example.com\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\nPlease verify you are human";
  assert.equal(contentIssue(blocked), "upstream_error_page");
  assert.equal(
    contentIssue(
      "Title: WEB \u5E94\u7528\u9632\u706B\u5899\nURL Source: http://example.com\nWarning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.\n\nMarkdown Content:\n\u5F53\u524D\u6B63\u5728\u5BF9\u8BBF\u95EE\u8BF7\u6C42\u8FDB\u884C\u4EBA\u673A\u8BC6\u522B\u68C0\u6D4B\uFF0C\u8BF7\u7A0D\u7B49\u7247\u523B\n\u5411\u53F3\u6ED1\u52A8\u586B\u5145\u62FC\u56FE"
    ),
    "access_challenge"
  );
  assert.equal(
    contentIssue(
      "<html><title>Just a moment...</title><body>Checking your browser</body></html>"
    ),
    "access_challenge"
  );
  assert.equal(
    contentIssue(
      'Title: Understanding CAPTCHA\nMarkdown Content:\nThis article quotes "Please verify you are human" and explains CAPTCHA.'
    ),
    void 0
  );
  assert.equal(
    contentIssue(
      "Title: Reader errors explained\nMarkdown Content:\nWarning: Target URL returned error 403: Forbidden\nThis is an example in a technical article."
    ),
    void 0
  );
  let calls = 0;
  const { web } = setup(async () => {
    calls++;
    return calls === 1 ? new Response(blocked) : Response.json({ results: [{ text: "Real weather data" }] });
  });
  assert.equal(
    (await web.content("https://example.com/weather")).provider,
    "tinyfish_fetch"
  );
  assert.equal(calls, 2);
});
test("a long reader navigation prelude is skipped without changing stored text or original offsets", async () => {
  const navigation = Array.from(
    { length: 40 },
    (_, i) => `[City ${i}](javascript:void(0); "City ${i}")`
  ).join("") + "\n[![Image](https://example.com/banner.png)](https://example.com/home)\n" + Array.from(
    { length: 50 },
    (_, i) => `[City ${i}](https://example.com/weather/some-very-long-navigation-path/${i})`
  ).join("\n");
  const body = `Title: Today
URL Source: https://example.com

Markdown Content:
${navigation}

09:30 report

# Today
Rain, 12-19 degrees
${"Forecast detail ".repeat(800)}`;
  const { web } = setup(async () => new Response(body));
  const doc = await web.content("https://example.com");
  assert.ok(doc.offset > 3e3);
  assert.match(doc.text, /09:30 report/);
  assert.match(doc.text, /Rain, 12-19 degrees/);
  assert.equal(doc.text, body.slice(doc.offset, doc.offset + 6e3));
  assert.equal(doc.length, body.length);
  const original = await web.stored({
    content_id: doc.content_id,
    offset: 0,
    limit: 2e4
  });
  assert.equal(original.text, body);
  assert.equal(
    previewOffset(
      "Title: Article\nMarkdown Content:\n# Article\n" + navigation
    ),
    0
  );
  assert.equal(previewOffset('{"temperature":16}'), 0);
  for (const beginning of [
    "```ts\nconst n = 1;\n```",
    "| city | weather |",
    "[One](https://example.com)\n# Today"
  ])
    assert.equal(
      previewOffset(
        "Title: Article\nMarkdown Content:\n" + beginning + "\n" + navigation
      ),
      0
    );
  assert.equal(
    previewOffset(
      "Title: Article\nMarkdown Content:\nA meaningful introduction " + "word ".repeat(30) + "\n" + navigation + "\n# Appendix"
    ),
    0
  );
});
test("exhausted blocked readers return a diagnostic failure and failed reads are not cached", async () => {
  let calls = 0;
  const { web } = setup(async (url) => {
    calls++;
    return String(url).includes("api.fetch.tinyfish") ? Response.json({ results: [{ text: "Please verify you are human." }] }) : new Response("Please verify you are human.");
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(web.content("https://example.com"), (e) => {
      assert.equal(e.code, "content_unavailable");
      assert.deepEqual(
        e.details.attempts.map((a) => a.reason),
        Array(3).fill("access_challenge")
      );
      return true;
    });
  assert.equal(calls, 6);
});

test('local factory registers JSON-schema tools and preserves per-prompt isolation with an injected store', async () => {
  const values = new Map();
  let runId = 'first-prompt';
  let calls = 0;
  const research = createResearchTools({ braveApiKey: 'local-secret' }, {
    scope: async () => ({ id: runId, deadline: Date.now() + 5000 }),
    store: { get: async key => values.get(key), put: async (key, value) => { values.set(key, value); } },
    fetch: async (url, init) => {
      calls++;
      assert.equal(init.headers['X-Subscription-Token'], 'local-secret');
      assert.equal(new URL(url).origin, 'https://brave.vastiny.com');
      return Response.json({ web: { results: [{ title: 'Forecast', url: 'https://example.com/weather', description: 'Rain' }] } });
    },
  });
  assert.deepEqual(research.tools.map(tool => tool.name), ['web_search', 'fetch_content', 'get_search_content']);
  for (const tool of research.tools) assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(research.tools[0].parameters.required, ['query']);
  const first = await research.tools[0].execute({ query: 'weather' });
  assert.deepEqual(await research.tools[0].execute({ query: 'weather' }), first);
  assert.equal(calls, 1);
  runId = 'second-prompt';
  const second = await research.tools[0].execute({ query: 'weather' });
  assert.notEqual(second.search_id, first.search_id);
  assert.equal(calls, 2);
  await assert.rejects(research.tools[2].execute({ search_id: first.search_id }), /search_not_found/);
  assert.match(research.systemPrompt, /untrusted data/);
  assert.equal(research.systemPrompt, researchSystemPrompt());
  assert.doesNotMatch(research.systemPrompt, /local-secret/);
});

test('local custom HTTP tools issue a bounded read-only GET and never follow redirects with parameters', async () => {
  let redirect = false;
  const calls = [];
  const research = createResearchTools({ httpTools: [{
    name: 'local_catalog', description: 'Read catalog data', url: 'http://127.0.0.1:9000/catalog?lang=zh',
    parameters: { type: 'object', properties: { term: { type: 'string' }, filters: { type: 'object' } }, required: ['term'] },
  }] }, {
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return redirect
        ? new Response('', { status: 302, headers: { location: 'https://other.example/search' } })
        : new Response('{"results":["result"]}', { headers: { 'content-type': 'application/json' } });
    },
  });
  const tool = research.tools.find(tool => tool.name === 'local_catalog');
  const result = await tool.execute({ term: 'a & b', filters: { available: true } });
  assert.equal(result.text, '{"results":["result"]}');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].url.searchParams.get('lang'), 'zh');
  assert.equal(calls[0].url.searchParams.get('term'), 'a & b');
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('filters')), { available: true });
  assert.equal(calls[0].init.headers, undefined);
  redirect = true;
  await assert.rejects(tool.execute({ term: 'query' }), /unsafe_redirect/);
  assert.equal(calls.length, 2);
});

