// Temporary scheduled probe for real cloud verification. Bind SESSIONS to the
// deployed SearchSession namespace. No public HTTP route or credentials needed.
// Supply a unique BENCHMARK_ID and an epoch-ms EXPIRES_AT before scheduling;
// remove the schedule and this temporary Worker after collecting its logs.
const prompts = [
  '今天杭州的天气怎么样？',
  '今天杭州的天气怎么样？',
  '今天杭州的天气怎么样？',
  '比较 Cloudflare Durable Objects 与 Workers KV 的一致性、延迟和适用场景。至少阅读两个官方页面，并补查一个容易混淆的限制，给出带来源的建议。',
];
const pending = (run) => ['accepted', 'running'].includes(run.status);

export default {
  async scheduled(_event, env) {
    const expires = Number(env.EXPIRES_AT);
    if (!Number.isFinite(expires) || Date.now() >= expires) return;
    if (!/^picall-perf-[a-z0-9-]+$/.test(env.BENCHMARK_ID))
      throw new Error('A unique benchmark ID is required');
    const started = Date.now();
    for (const [index, prompt] of prompts.entries()) {
      if (Date.now() >= expires || Date.now() - started >= 240000) return;
      // Stable per-case identities make duplicate cron invocations idempotent.
      const session = `${env.BENCHMARK_ID}-${index}`;
      const id = `${session}~00000000-0000-4000-8000-000000000001`;
      const stub = env.SESSIONS.getByName(session);
      const input = {
        messages: [{ role: 'user', content: prompt }],
        model: env.MODEL,
        stream: false,
        includeUsage: false,
      };
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(input)),
      );
      const fingerprint = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      let response = await stub.fetch('https://internal/submit', {
        method: 'POST',
        body: JSON.stringify({ id, session, input, fingerprint }),
      });
      if (!response.ok) {
        console.log(
          JSON.stringify({
            event: 'benchmark_request_failed',
            case_index: index,
            run_id: id,
            status: response.status,
          }),
        );
        return;
      }
      let run = await response.json();
      while (
        pending(run) &&
        Date.now() < expires &&
        Date.now() - started < 240000
      ) {
        response = await stub.fetch(
          'https://internal/wait?id=' + encodeURIComponent(id),
        );
        if (!response.ok) {
          console.log(
            JSON.stringify({
              event: 'benchmark_request_failed',
              case_index: index,
              run_id: id,
              status: response.status,
            }),
          );
          return;
        }
        run = await response.json();
      }
      console.log(
        JSON.stringify({
          event: 'benchmark_result',
          case_index: index,
          run_id: id,
          status: run.status,
          error: run.error,
          elapsed_ms: run.elapsed_ms,
          service_calls: run.service_calls,
          usage: run.usage,
          // Only these fixed public benchmark answers are logged, never user sessions.
          answer: run.completion?.choices?.[0]?.message?.content?.slice(
            0,
            12000,
          ),
        }),
      );
      if (pending(run)) return;
    }
    console.log(
      JSON.stringify({
        event: 'benchmark_complete',
        benchmark_id: env.BENCHMARK_ID,
      }),
    );
  },
};
