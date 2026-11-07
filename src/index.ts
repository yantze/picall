import { DurableObject } from 'cloudflare:workers';
import { Lifecycle, type LifecycleJobContext } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import { createAI } from 'agents/models/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  Fault,
  fail,
  json,
  errorResponse,
  hash,
  normalize,
  readBody,
  history,
  completion,
  usageDelta,
  type Input,
} from './core';
import { WebTools, type ToolEnv } from './tools';
export interface Env extends ToolEnv {
  AI: Ai;
  MODEL: string;
  API_BEARER: string;
  SESSIONS: DurableObjectNamespace;
  KEYS: DurableObjectNamespace;
}
const TTL = 7 * 86400000;
type Run = {
  id: string;
  session: string;
  input: Input;
  fingerprint: string;
  created: number;
  deadline: number;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  before?: any;
  completion?: any;
  error?: { code: string };
  usage?: any;
  elapsed_ms?: number;
  service_calls?: Record<string, number>;
  nextHashes?: string[];
};
type SessionHistory = { hashes: string[]; system: string; model: string };
// Each key gets a durable coordinator. Its mapping exists before any session is contacted.
export class RequestKey extends DurableObject<Env> {
  async fetch(request: Request) {
    try {
      const data = (await request.json()) as {
        fingerprint: string;
        session?: string;
      };
      const record = await this.ctx.storage.transaction(async (tx) => {
        const old = await tx.get<{
          fingerprint: string;
          session: string;
          run: string;
        }>('key');
        if (old) {
          if (
            old.fingerprint !== data.fingerprint ||
            (data.session && data.session !== old.session)
          )
            fail('idempotency_conflict', 409);
          return old;
        }
        const session = data.session || crypto.randomUUID();
        const value = {
          fingerprint: data.fingerprint,
          session,
          run: session + '~' + crypto.randomUUID(),
        };
        await tx.put('key', value);
        await tx.setAlarm(Date.now() + TTL);
        return value;
      });
      return json(record);
    } catch (e) {
      return errorResponse(e);
    }
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
export class SearchSession extends DurableObject<Env> {
  ai = createAI({ binding: this.env.AI });
  web = new WebTools(this.env, this.ctx.storage, async () => {
    const id = await this.ctx.storage.get<string>('active');
    const run = id ? await this.ctx.storage.get<Run>('run:' + id) : undefined;
    if (!run || !['accepted', 'running'].includes(run.status))
      fail('no_active_run', 409);
    return { id: run.id, deadline: run.deadline };
  });
  registry = this.web.registry();
  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        { models, registry: this.registry, onWake },
        context,
      );
    },
    defaults: {
      model: this.ai(this.env.MODEL as `@cf/${string}`),
      maxTurns: 8,
    },
  });
  lifecycle = Lifecycle.install(this).use(this.harness);
  private gate: Promise<unknown> = Promise.resolve();
  // DOs allow interleaving across awaits; serialize admission, settlement and cancellation.
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.gate.then(fn);
    this.gate = task.catch(() => {});
    return task;
  }
  async onStart() {
    const active = await this.ctx.storage.get<string>('active');
    if (active)
      await this.lifecycle.jobs.push({
        id: 'run',
        fn: 'drive',
        time: Date.now(),
      });
  }
  private async touch() {
    await this.ctx.storage.put('touched', Date.now());
    await this.lifecycle.jobs.push({
      id: 'cleanup',
      fn: 'cleanup',
      time: Date.now() + TTL,
    });
  }
  async onRequest(request: Request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/submit')
        return await this.locked(async () => {
          const { id, session, input, fingerprint } =
            (await request.json()) as {
              id: string;
              session: string;
              input: Input;
              fingerprint: string;
            };
          const old = await this.ctx.storage.get<Run>('run:' + id);
          if (old) {
            if (old.fingerprint !== fingerprint)
              fail('idempotency_conflict', 409);
            await this.touch();
            return json(old);
          }
          const active = await this.ctx.storage.get<string>('active');
          if (active) fail('session_busy', 409);
          const previous =
            await this.ctx.storage.get<SessionHistory>('history');
          const prepared = await history(input, previous);
          const run: Run = {
            id,
            session,
            input: {
              ...input,
              messages: prepared.messages,
              system: prepared.system,
            },
            fingerprint,
            created: Date.now(),
            deadline: Date.now() + 300000,
            status: 'accepted',
          };
          // Commit staging plus recovery job before Pi submission; operationId closes the crash gap.
          await this.lifecycle.jobs.push({
            id: 'run',
            fn: 'drive',
            time: Date.now(),
          });
          await this.ctx.storage.transaction(async (tx) => {
            await tx.put('run:' + id, run);
            await tx.put('active', id);
          });
          await this.touch();
          await this.prepare(run);
          return json(await this.ctx.storage.get('run:' + id));
        });
      const id = new URL(request.url).searchParams.get('id') || '';
      if (path === '/cancel')
        return await this.locked(async () => {
          const run = await this.ctx.storage.get<Run>('run:' + id);
          if (!run) fail('run_not_found', 404);
          if (['accepted', 'running'].includes(run.status)) {
            await this.harness.abort({ operationId: id });
            run.status = 'cancelled';
            run.error = { code: 'cancelled' };
            await this.finish(run);
          }
          await this.touch();
          return json(run);
        });
      if (path === '/result')
        return await this.locked(async () => {
          const run = await this.ctx.storage.get<Run>('run:' + id);
          if (!run) fail('run_not_found', 404);
          await this.touch();
          return json(run);
        });
      fail('not_found', 404);
    } catch (e) {
      return errorResponse(e);
    }
  }
  private async prepare(run: Run) {
    if (run.status !== 'accepted') return;
    const pi = await this.harness.pi();
    const previous = await this.ctx.storage.get<SessionHistory>('history');
    const prepared = await history(run.input, previous);
    run.before ??= await pi.usage(BG);
    run.nextHashes = [
      ...(previous?.hashes || []),
      ...(await Promise.all(prepared.messages.map(hash))),
    ];
    // Save baseline before first model call; retries keep it.
    await this.ctx.storage.put('run:' + run.id, run);
    const conversation = await this.harness.conversation('1');
    await conversation.configure(
      { instructions: prepared.system, maxTurns: 8 },
      BG,
    );
    const prompt =
      prepared.messages.length === 1
        ? prepared.messages[0].content
        : 'Continue the conversation:\n' +
          prepared.messages
            .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
            .join('\n');
    await this.harness.submit(prompt, {
      operationId: run.id,
      whenBusy: 'reject',
    });
    run.status = 'running';
    await this.ctx.storage.put('run:' + run.id, run);
  }
  private async finish(run: Run) {
    run.elapsed_ms = Date.now() - run.created;
    const total = await (await this.harness.pi()).usage(BG);
    run.usage = usageDelta(total, run.before ?? total);
    run.service_calls =
      (await this.ctx.storage.get<Record<string, number>>('calls:' + run.id)) ||
      {};
    if (run.status === 'succeeded') {
      run.completion = completion(
        run.id,
        run.input.model,
        run.completion,
        run.usage,
        run.created,
      );
      const hashes = [
        ...(run.nextHashes || []),
        await hash(run.completion.choices[0].message),
      ];
      // Refuse oversized full histories rather than silently validating a truncated prefix.
      await this.ctx.storage.put('history', {
        hashes,
        system: run.input.system || '',
        model: run.input.model,
      });
    }
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('run:' + run.id, run);
      await tx.delete('active');
    });
  }
  onJobError({ job }: LifecycleJobContext) {
    return { rescheduleAt: Date.now() + (job.fn === 'cleanup' ? 60000 : 1000) };
  }
  async onJob({ job }: LifecycleJobContext) {
    if (job.fn === 'cleanup')
      return this.locked(async () => {
        const touched = (await this.ctx.storage.get<number>('touched')) || 0;
        if (Date.now() - touched < TTL) return { rescheduleAt: touched + TTL };
        // Close Pi before deleting its tables; lifecycle rearms its own alarm.
        await this.harness.dispose();
        await this.ctx.storage.deleteAll();
        // Reset cached SQLite/lifecycle handles after dropping every table.
        this.ctx.abort('Session expired');
      });
    return this.locked(async () => {
      const id = await this.ctx.storage.get<string>('active');
      if (!id) return;
      const run = await this.ctx.storage.get<Run>('run:' + id);
      if (!run) return;
      if (Date.now() >= run.deadline) {
        await this.harness.abort({ operationId: id });
        run.status = 'failed';
        run.error = { code: 'deadline_exceeded' };
        await this.finish(run);
        return;
      }
      await this.prepare(run);
      let result;
      try {
        result = await this.harness.wait(id, {
          signal: AbortSignal.timeout(50),
        });
      } catch {
        return { rescheduleAt: Math.min(Date.now() + 1000, run.deadline) };
      }
      if (Date.now() >= run.deadline) {
        run.status = 'failed';
        run.error = { code: 'deadline_exceeded' };
      } else if (result.status === 'done') {
        run.status = 'succeeded';
        run.completion = result.text || '';
      } else {
        run.status = 'failed';
        run.error = { code: result.reason || 'unanswered' };
      }
      await this.finish(run);
    });
  }
}
function publicRun(run: Run) {
  return {
    id: run.id,
    session_id: run.session,
    status: run.status,
    created_at: run.created,
    deadline: run.deadline,
    ...(run.completion ? { completion: run.completion } : {}),
    ...(run.error ? { error: run.error } : {}),
    usage: run.usage,
    elapsed_ms: run.elapsed_ms,
    service_calls: run.service_calls,
  };
}
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export async function route(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.API_BEARER) fail('api_auth_not_configured', 503);
    if (!env.MODEL.startsWith('@cf/')) fail('workers_ai_model_required', 503);
    const supplied = request.headers.get('authorization') || '';
    if ((await hash(supplied)) !== (await hash('Bearer ' + env.API_BEARER)))
      fail('invalid_api_key', 401);
    const url = new URL(request.url);
    if (url.pathname === '/v1/models' && request.method === 'GET')
      return json({
        object: 'list',
        data: [
          {
            id: env.MODEL,
            object: 'model',
            created: 0,
            owned_by: 'cloudflare',
          },
        ],
      });
    const asyncRun = url.pathname === '/v1/runs';
    if (
      request.method === 'POST' &&
      (asyncRun || url.pathname === '/v1/chat/completions')
    ) {
      const input = normalize(await readBody(request), env.MODEL, asyncRun);
      const explicit = request.headers.get('x-session-id') || undefined;
      if (explicit && !sessionPattern.test(explicit))
        fail('invalid_session_id');
      const fingerprint = await hash(input);
      const key = request.headers.get('idempotency-key');
      if (key !== null && (!key.length || key.length > 256))
        fail('invalid_idempotency_key');
      let session = explicit || crypto.randomUUID(),
        id = session + '~' + crypto.randomUUID();
      if (key) {
        const mapping = await env.KEYS.getByName(await hash(key)).fetch(
          'https://internal/key',
          {
            method: 'POST',
            body: JSON.stringify({ fingerprint, session: explicit }),
          },
        );
        if (!mapping.ok) return mapping;
        const data = (await mapping.json()) as any;
        session = data.session;
        id = data.run;
      }
      const stub = env.SESSIONS.getByName(session);
      const accepted = await stub.fetch('https://internal/submit', {
        method: 'POST',
        body: JSON.stringify({ id, session, input, fingerprint }),
      });
      if (!accepted.ok) return accepted;
      const headers = {
        'X-Session-Id': session,
        'X-Run-Id': id,
        'Cache-Control': 'no-store',
      };
      const first = (await accepted.json()) as Run;
      if (asyncRun) return json(publicRun(first), 202, headers);
      const get = async () => {
        const r = await stub.fetch(
          'https://internal/result?id=' + encodeURIComponent(id),
        );
        if (!r.ok) throw new Fault('result_unavailable', 502);
        return (await r.json()) as Run;
      };
      if (input.stream)
        return sse(first, get, headers, input.includeUsage, request.signal);
      let run = first;
      while (['accepted', 'running'].includes(run.status)) {
        await pause(request.signal);
        run = await get();
      }
      return run.status === 'succeeded'
        ? json(run.completion, 200, headers)
        : json(
            { error: run.error, id },
            run.status === 'cancelled' ? 409 : 502,
            headers,
          );
    }
    const match = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/cancel)?$/);
    if (
      match &&
      ((!match[2] && request.method === 'GET') ||
        (match[2] && request.method === 'POST'))
    ) {
      const id = decodeURIComponent(match[1]);
      const [session, uuid, ...extra] = id.split('~');
      if (!sessionPattern.test(session) || !uuid || extra.length)
        fail('invalid_run_id');
      const response = await env.SESSIONS.getByName(session).fetch(
        `https://internal/${match[2] ? 'cancel' : 'result'}?id=${encodeURIComponent(id)}`,
        { method: match[2] ? 'POST' : 'GET' },
      );
      if (!response.ok) return response;
      return json(publicRun((await response.json()) as Run), 200, {
        'X-Session-Id': session,
        'X-Run-Id': id,
        'Cache-Control': 'no-store',
      });
    }
    fail('not_found', 404);
  } catch (e) {
    return errorResponse(e);
  }
}
function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function sse(
  first: Run,
  get: () => Promise<Run>,
  headers: Record<string, string>,
  includeUsage: boolean,
  signal: AbortSignal,
) {
  let stopped = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string) => {
          if (!stopped) controller.enqueue(new TextEncoder().encode(s));
        };
        const chunk = (
          delta: unknown,
          finish_reason: string | null = null,
        ) => ({
          id: first.id,
          object: 'chat.completion.chunk',
          created: Math.floor(first.created / 1000),
          model: first.input.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
        try {
          let run = first;
          let heartbeat = 0;
          while (!stopped && ['accepted', 'running'].includes(run.status)) {
            if (Date.now() - heartbeat >= 15000) {
              send(': heartbeat\n\n');
              heartbeat = Date.now();
            }
            await pause(signal);
            if (!stopped) run = await get();
          }
          if (stopped) return;
          if (run.status === 'succeeded') {
            send(
              'data: ' +
                JSON.stringify(
                  chunk({
                    role: 'assistant',
                    content: run.completion.choices[0].message.content,
                  }),
                ) +
                '\n\n',
            );
            send('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n');
            if (includeUsage)
              send(
                'data: ' +
                  JSON.stringify({
                    ...chunk({}),
                    choices: [],
                    usage: run.usage,
                  }) +
                  '\n\n',
              );
          } else
            send(
              'data: ' +
                JSON.stringify({ error: run.error, id: run.id }) +
                '\n\n',
            );
          send('data: [DONE]\n\n');
          controller.close();
        } catch {
          if (!stopped) {
            try {
              controller.close();
            } catch {}
          }
        }
      },
      cancel() {
        stopped = true;
      },
    }),
    {
      headers: {
        ...headers,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    },
  );
}
export default { fetch: route };
