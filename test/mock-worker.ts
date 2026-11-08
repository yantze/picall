import production, { SearchSession as Base, RequestKey } from '../src/index';
import { WebTools } from '../src/tools';
export { RequestKey };
export class SearchSession extends Base {
  async onRequest(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/test-cleanup') {
      await this.ctx.storage.put('touched', 0);
      await this.onJob({ job: { fn: 'cleanup' } } as any);
      return new Response('expired');
    }
    if (path === '/test-expire') {
      const id = await this.ctx.storage.get<string>('active');
      const run: any = await this.ctx.storage.get('run:' + id);
      run.deadline = Date.now() - 1;
      await this.ctx.storage.put('run:' + id, run);
      await this.lifecycle.jobs.push({
        id: 'run',
        fn: 'drive',
        time: Date.now(),
      });
      return Response.json({ ok: true });
    }
    return super.onRequest(request);
  }
  constructor(ctx: any, env: any) {
    const fakeAI = {
      fetch: async (_url: string, init: RequestInit) =>
        fakeAI.run('deepseek-flash', JSON.parse(init.body as string), {
          signal: init.signal,
        }),
      run: async (_model: string, input: any, options: any) => {
        const prompt = JSON.stringify(input.messages);
        const delay =
          prompt.includes('heartbeat research') &&
          !input.messages.some((m: any) => m.role === 'tool')
            ? 16000
            : prompt.includes('slow')
              ? 3000
              : 0;
        if (delay)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            options.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(options.signal.reason);
              },
              { once: true },
            );
          });
        const count = input.messages.filter(
          (m: any) => m.role === 'tool',
        ).length;
        const call = (name: string, args: any, index = 0) => ({
          index,
          id: `call-${count}-${index}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        });
        let delta: any;
        if (
          count === 0 ||
          input.messages.some(
            (m: any) => m.role === 'user' && m.content === 'exhaust',
          )
        ) {
          delta = {
            content: 'Intermediate research plan',
            tool_calls: [call('web_search', { query: 'research' })],
          };
        } else if (count === 1) {
          const suffix = prompt.includes('toolpause') ? 'toolpause' : 'article';
          delta = {
            tool_calls: [
              call('fetch_content', { url: 'https://example.com/' + suffix }),
              call(
                'fetch_content',
                {
                  url:
                    'https://example.com/' +
                    (prompt.includes('cache exercise') ? suffix : 'second'),
                },
                1,
              ),
            ],
          };
        } else if (count === 3) {
          delta = {
            content: 'Intermediate follow-up',
            tool_calls: [
              call('web_search', {
                query: prompt.includes('cache exercise')
                  ? 'research'
                  : 'refined research',
              }),
            ],
          };
        } else
          delta = {
            content: 'Final answer [source](https://example.com/article)',
          };
        const chunks = [
          {
            choices: [
              {
                index: 0,
                delta,
                finish_reason: delta.tool_calls ? 'tool_calls' : 'stop',
              },
            ],
          },
          // Native Workers AI usage is terminal, not a per-delta tally.
          {
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ];
        const data =
          chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') +
          'data: [DONE]\n\n';
        return new Response(data, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    };
    super(ctx, { ...env, AI: fakeAI });
    this.web = new WebTools(
      this.env,
      this.ctx.storage,
      async () => {
        const id = await this.ctx.storage.get<string>('active');
        const run: any = await this.ctx.storage.get('run:' + id);
        return { id: run.id, deadline: run.deadline };
      },
      env.USE_GLOBAL_FETCH === '1'
        ? fetch
        : async (url: any) => {
            if (String(url).startsWith('https://r.jina.ai/')) {
              if (String(url).includes('toolpause'))
                await new Promise((resolve) => setTimeout(resolve, 3000));
              return new Response('Verified source body', {
                headers: { 'Content-Type': 'text/plain' },
              });
            }
            return Response.json({
              web: {
                results: [
                  {
                    url: 'https://example.com/article',
                    title: 'Source',
                    description: 'Summary',
                  },
                ],
              },
            });
          },
    );
    this.registry = this.web.registry();
  }
}
export default production;
