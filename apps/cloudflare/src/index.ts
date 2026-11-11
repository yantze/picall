import { DurableObject } from 'cloudflare:workers';
import { Lifecycle, type LifecycleJobContext } from 'agents/lifecycle';
import { PiHarness, type PiOperationResult } from 'agents/harness/pi';
import { configuredRuntime } from './models';
import { Management, equalSecret, type CloudConfig } from './management';
import { normalize as validateRequest, openAIModel } from '../../../packages/core/protocol.js';
import { identityFingerprint } from '../../../packages/core/identity.js';
import { inspectAnswer } from '../../../packages/core/results.js';
import { runFailure, errorEnvelope } from '../../../packages/core/errors.js';
import { createTelemetry, timingSnapshot } from '../../../packages/core/telemetry.js';
import { managementRoute } from './web';
import { routeAPI } from './http';
export { Management };

import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
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
export interface Env extends WorkerBindings, ToolEnv {
  API_BEARER: string;
  ADMIN_TOKEN: string;
  CONFIG_ENCRYPTION_KEY: string;
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
  timings?: ReturnType<typeof timingSnapshot>;
  nextHashes?: string[];
  version?: number; configHash?: string; updatedAt?: number; cancelRequested?: boolean; abortError?: { code:string };
};
type SessionHistory = { hashes: string[]; system: string; model: string };
const isPending = (run: Run) => ['accepted', 'running'].includes(run.status);
// Each key gets a durable coordinator. Its mapping exists before any session is contacted.
export class RequestKey extends DurableObject<Env> {
  async fetch(request: Request) {
    try {
      const data = (await request.json()) as { fingerprint:string; session?:string; version?:number; createdAt?:number; deadline?:number; configHash?:string };
      if (new URL(request.url).pathname === '/lookup') return json(await this.ctx.storage.get('key') || null);
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
          ...data, fingerprint: data.fingerprint,
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
  piStorage!: import('@earendil-works/pi-durable/storage/sqlite').SqliteStorage;
  modelRuntime?: ReturnType<typeof configuredRuntime>;
  executionConfig?: CloudConfig;
  currentRun?: Run;
  protected guard() {
    const run = this.currentRun;
    if (!run || run.cancelRequested || !isPending(run)) fail('request_cancelled', 499);
    if (Date.now() >= run.deadline) fail('request_timeout', 504);
  }
  web = new WebTools(this.env, this.ctx.storage, async () => {
    const id = await this.ctx.storage.get<string>('active');
    const run = id ? await this.ctx.storage.get<Run>('run:' + id) : undefined;
    if (!run || !['accepted', 'running'].includes(run.status))
      fail('no_active_run', 409);
    return { id: run.id, deadline: run.deadline };
  });
  registry = this.web.registry();
  harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.piStorage=storage;
      const config:CloudConfig = JSON.parse(await this.env.MANAGEMENT.getByName('global').getConfig());
      this.executionConfig = config;
      this.modelRuntime = configuredRuntime(this.env, config, () => this.guard());
      this.web.env = { ...this.web.env, ...toolEnv(config) };
      const telemetry=createTelemetry(this.web,{reminders:config.enableResearch && config.budgetReminders !== false,emit:event=>console.log(JSON.stringify(event))});
      this.registry = this.web.registry({ enabled:config.enableResearch, overrides:config.toolOverrides, guard:() => this.guard(),telemetry });
      const pi = await Harness.open(storage, { models:this.modelRuntime!.models, registry:this.registry, onWake,
        settings:{ retry:{enabled:true,maxRetries:2,baseDelayMs:1000,maxAgentDelayMs:10000}, restartLimit:5, afterFailedRun:'withdraw' },
      }, context);
      const id = await this.ctx.storage.get<string>('active');
      const run = id ? await this.ctx.storage.get<Run>('run:' + id) : undefined;
      this.currentRun = run;
      if (run && isPending(run)) {
        const code = run.cancelRequested ? run.abortError?.code || 'request_cancelled' : !run.version ? 'process_interrupted'
          : Date.now() >= run.deadline ? 'request_timeout' : run.configHash !== await executionFingerprint(config) ? 'session_configuration_changed' : undefined;
        if (code) {
          // PiHarness resumes immediately after this factory returns. Abort first.
          const receipt = await storage.submissionByRequest(ROOT_CONVERSATION_ID, run.id, BG);
          if (run.version && receipt?.status === 'done' && !run.cancelRequested) {
            // Do not let an expired supervisor overwrite an already committed answer.
          } else {
            await (await pi.root(BG)).abort(BG);
            run.status = code === 'request_cancelled' ? 'cancelled' : 'failed'; run.error = {code}; run.updatedAt=Date.now();
            run.timings=timingSnapshot(await this.ctx.storage.get('timings:' + run.id),true);
            await this.ctx.storage.transaction(async tx => { await tx.put('run:' + run.id, run); await tx.delete('active'); await tx.put('retired',true); });
          }
        }
      }
      return pi;
    },
    defaults: { maxTurns:8 },
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
    const expiry = await this.ctx.storage.get<number>('next-result-expiry');
    await this.lifecycle.jobs.push({
      id: 'cleanup',
      fn: 'cleanup',
      time: Math.min(Date.now() + TTL, expiry ?? Infinity),
    });
  }
  async onRequest(request: Request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/submit')
        return await this.locked(async () => {
          const { id, session, input, fingerprint, configHash, deadline, createdAt } =
            (await request.json()) as {
              id: string;
              session: string;
              input: Input;
              fingerprint: string; configHash:string; deadline:number; createdAt?:number;
            };
          const old = await this.ctx.storage.get<Run>('run:' + id);
          if (old) {
            if (old.fingerprint !== fingerprint)
              fail('idempotency_conflict', 409);
            await this.touch();
            if (old.status === 'accepted') await this.prepare(old);
            return json(await this.ctx.storage.get('run:' + id));
          }
          if (await this.ctx.storage.get('retired')) fail('session_expired',409);
          const active = await this.ctx.storage.get<string>('active');
          if (active) fail('session_busy', 409);
          if (this.executionConfig && await executionFingerprint(this.executionConfig) !== configHash) fail('session_configuration_changed',409);
          const sessionHash=await this.ctx.storage.get<string>('config-hash');
          if (sessionHash && sessionHash!==configHash) fail('session_configuration_changed',409);
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
            created: createdAt ?? Date.now(),
            deadline, version:2, configHash, updatedAt:Date.now(),
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
            await tx.put('config-hash',configHash);
          });
          this.currentRun = run;
          await this.touch();
          await this.prepare(run);
          return json(await this.ctx.storage.get('run:' + id));
        });
      const id = new URL(request.url).searchParams.get('id') || '';
      if (path === '/close') return this.locked(async()=>{
        if(await this.ctx.storage.get('active'))fail('session_busy',409);
        await this.ctx.storage.put('retired',true); return json({deleted:true});
      });
      if (path === '/wait')
        return json(await this.waitForRun(id, request.signal));
      if (path === '/cancel')
        return await this.locked(async () => {
          let run = await this.ctx.storage.get<Run>('run:' + id);
          if (!run) fail('run_not_found', 404);
          if (isPending(run) && await this.resolveCommitted(run)) return json(await this.ctx.storage.get('run:' + id));
          if (['accepted', 'running'].includes(run.status)) {
            run.cancelRequested=true; run.abortError={code:'request_cancelled'};
            await this.ctx.storage.put('run:' + id, run); this.currentRun=run;
            await this.harness.abort({ operationId: id });
            run.status = 'cancelled';
            run.error = { code: 'request_cancelled' };
            await this.finish(run);
          }
          await this.touch();
          return json(run);
        });
      if (path === '/result')
        return await this.locked(async () => {
          const run = await this.ctx.storage.get<Run>('run:' + id);
          if (!run) fail('run_not_found', 404);
          if(isPending(run))run.timings=timingSnapshot(await this.ctx.storage.get('timings:' + id));
          await this.touch();
          return json(run);
        });
      fail('not_found', 404);
    } catch (e) {
      return errorResponse(e);
    }
  }
  private async waitForRun(id: string, signal: AbortSignal) {
    const first = await this.locked(async () => {
      const run = await this.ctx.storage.get<Run>('run:' + id);
      if (!run) fail('run_not_found', 404);
      if (isPending(run)) await this.prepare(run);
      await this.touch();
      return run;
    });
    if (!isPending(first)) return first;
    const timer = new AbortController();
    const handle = setTimeout(
      () => timer.abort(),
      Math.max(1, Math.min(15000, first.deadline - Date.now())),
    );
    let result: PiOperationResult | undefined;
    try {
      // Waiting must not hold the admission/finalization lock: cancellation and
      // the durable deadline supervisor must remain able to settle this run.
      result = await this.harness.wait(id, {
        signal: AbortSignal.any([signal, timer.signal]),
      });
    } catch (e) {
      signal.throwIfAborted();
      if (!timer.signal.aborted) throw e;
    } finally {
      clearTimeout(handle);
    }
    signal.throwIfAborted();
    return this.locked(async () => {
      // Another waiter, cancellation or the supervisor may have won the race.
      const run = await this.ctx.storage.get<Run>('run:' + id);
      if (!run) fail('run_not_found', 404);
      if (isPending(run)) {
        if (result) await this.settle(run,result);
        else if (Date.now() >= run.deadline) {
          run.cancelRequested=true; run.abortError={code:'request_timeout'};
          await this.ctx.storage.put('run:' + id,run); this.currentRun=run;
          await this.harness.abort({ operationId: id });
          run.status = 'failed';
          run.error = { code: 'request_timeout' };
          await this.finish(run);
        }
      }
      return await this.ctx.storage.get<Run>('run:' + id) || run;
    });
  }
  private async settle(run: Run, result: PiOperationResult) {
    const latest = await this.ctx.storage.get<Run>('run:' + run.id);
    if (!latest || !isPending(latest) || latest.cancelRequested) return;
    if (result.status === 'done') {
      await this.harness.pi();
      const receipt = await this.piStorage.submissionByRequest(ROOT_CONVERSATION_ID, run.id, BG);
      const entry = receipt?.status === 'done' && receipt.answer !== undefined ? (await this.piStorage.entry(ROOT_CONVERSATION_ID, receipt.answer, BG))?.entry : undefined;
      const answer = entry?.model?.find((message:any) => message.role==='assistant');
      const checked = inspectAnswer(answer, run.deadline);
      if (checked.error) { run.status='failed'; run.error={code:checked.error}; }
      else { run.status='succeeded'; run.completion=checked.content; }
    } else { run.status='failed'; run.error={code:Date.now()>=run.deadline?'request_timeout':result.reason==='turn_limit'?'turn_limit':result.reason==='restart_limit'?'restart_limit':'provider_error'}; }
    await this.finish(run);
  }
  private async resolveCommitted(run:Run) {
    await this.harness.pi();
    const receipt=await this.piStorage.submissionByRequest(ROOT_CONVERSATION_ID,run.id,BG);
    if(receipt?.status!=='done' || run.cancelRequested)return false;
    await this.settle(run,await this.harness.wait(run.id)); return true;
  }
  private async prepare(run: Run) {
    if (run.status !== 'accepted') return;
    const pi = await this.harness.pi();
    const stored = await this.ctx.storage.get<Run>('run:' + run.id);
    if (!stored || !isPending(stored)) return;
    this.currentRun = run;
    this.guard();
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
      {
        instructions: [prepared.system,this.executionConfig!.additionalSystemPrompt].filter(Boolean).join('\n\n'),
        maxTurns: this.executionConfig!.maxToolRounds,
        thinkingLevel:'off',
        model: {
          provider: this.modelRuntime!.model.provider,
          modelId: this.modelRuntime!.model.id,
        },
      },
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
    run.elapsed_ms = Date.now() - run.created; run.updatedAt=Date.now(); this.currentRun=run;
    const total = await (await this.harness.pi()).usage(BG);
    run.usage = usageDelta(total, run.before ?? total);
    run.service_calls =
      (await this.ctx.storage.get<Record<string, number>>('calls:' + run.id)) ||
      {};
    run.timings=timingSnapshot(await this.ctx.storage.get('timings:' + run.id),true);
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
      if (run.status !== 'succeeded') await tx.put('retired',true);
      const next = await tx.get<number>('next-result-expiry');
      await tx.put('next-result-expiry', Math.min(next ?? Infinity, run.updatedAt! + TTL));
    });
    await this.env.MANAGEMENT.getByName('global').record(publicRun(run));
  }
  onJobError({ job }: LifecycleJobContext) {
    return { rescheduleAt: Date.now() + (job.fn === 'cleanup' ? 60000 : 1000) };
  }
  async onJob({ job }: LifecycleJobContext) {
    if (job.fn === 'cleanup')
      return this.locked(async () => {
        const touched = (await this.ctx.storage.get<number>('touched')) || 0;
        const active = await this.ctx.storage.get<string>('active');
        if (Date.now() - touched < TTL || active) {
          let next = Infinity;
          const records = await this.ctx.storage.list<Run>({ prefix:'run:' });
          for (const [key, run] of records) {
            if (isPending(run)) continue;
            const expiry = (run.updatedAt || run.created) + TTL;
            if (expiry > Date.now()) { next = Math.min(next, expiry); continue; }
            await this.ctx.storage.delete([key, 'calls:' + run.id, 'timings:' + run.id]);
            for (const family of ['cache', 'content', 'search']) {
              while (true) {
                const keys = [...(await this.ctx.storage.list({ prefix:family + ':' + run.id + ':', limit:8 })).keys()];
                if (!keys.length) break;
                await this.ctx.storage.delete(keys);
              }
            }
          }
          if (Number.isFinite(next)) await this.ctx.storage.put('next-result-expiry', next);
          else await this.ctx.storage.delete('next-result-expiry');
          return { rescheduleAt: Math.max(Date.now() + 1000, Math.min(touched + TTL, next)) };
        }
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
      const pi = await this.harness.pi();
      const receipt = await this.piStorage.submissionByRequest(ROOT_CONVERSATION_ID, run.id, BG);
      if (receipt?.status === 'done' && !run.cancelRequested) {
        const done = await this.harness.wait(run.id); await this.settle(run,done); return;
      }
      if (Date.now() >= run.deadline || run.cancelRequested) {
        run.cancelRequested=true; run.abortError ??= {code:'request_timeout'};
        await this.ctx.storage.put('run:' + id,run); this.currentRun=run;
        await this.harness.abort({ operationId: id });
        run.status = run.abortError.code === 'request_cancelled' ? 'cancelled' : 'failed';
        run.error = run.abortError;
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
      await this.settle(run, result);
    });
  }
}
export function publicRun(run: Run) {
  const code = run.error?.code === 'deadline_exceeded' ? 'request_timeout' : run.error?.code === 'cancelled' ? 'request_cancelled' : run.error?.code;
  return { id:run.id, sessionId:run.session, status:run.status==='accepted'?'pending':run.status==='succeeded'?'completed':run.status,
    createdAt:run.created, updatedAt:run.updatedAt || run.created, model:run.input.model,
    ...(run.completion && typeof run.completion==='object' ? {completion:run.completion}:{}),
    ...(code ? {error:runFailure(code)}:{}),
    ...(run.usage?{usage:run.usage}:{}), ...(run.elapsed_ms===undefined?{}:{elapsed_ms:run.elapsed_ms}), ...(run.service_calls?{service_calls:run.service_calls}:{}),
    ...(run.timings?{timings:run.timings}:{}),
  };
}
export function toolEnv(config: CloudConfig) {
  return { BRAVE_KEY:config.braveApiKey,TAVILY_KEY:config.tavilyApiKey,TINYFISH_KEY:config.tinyfishApiKey,EXA_KEY:config.exaApiKey,JINA_KEY:config.jinaApiKey,
    BRAVE_BASE_URL:config.braveBaseUrl,TAVILY_BASE_URL:config.tavilyBaseUrl,HTTP_TOOLS:JSON.stringify(config.httpTools) };
}
export async function executionFingerprint(config: CloudConfig) {
  const { apiKey,host,port,maxSessions,idleTimeoutMinutes,configVersion,budgetReminders,...execution } = config;
  return identityFingerprint({...execution,...(budgetReminders === false?{budgetReminders:false}:{})});
}
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export async function route(request:Request, env:Env):Promise<Response> {
  let response:Response;
  try {
    const path=new URL(request.url).pathname;
    if(path.startsWith('/v1/') && request.method==='OPTIONS') response=new Response(null,{status:204});
    else response=await managementRoute(request,env) || await routeAPI(request,env);
  } catch(error) { response=errorResponse(error); }
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');headers.set('Referrer-Policy','no-referrer');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if(new URL(request.url).pathname.startsWith('/v1/') && request.headers.has('origin')) {
    headers.set('Access-Control-Allow-Origin','*');headers.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, X-Session-Id, Idempotency-Key');headers.set('Access-Control-Expose-Headers','X-Session-Id,X-Run-Id');
  }
  return new Response(response.body,{status:response.status,headers});
}

export function streamResult(
  first: Run,
  get: (signal: AbortSignal) => Promise<Run>,
  headers: Record<string, string>,
  includeUsage: boolean,
  signal: AbortSignal,
) {
  let stopped = false;
  const disconnected = new AbortController();
  const waiting = AbortSignal.any([signal, disconnected.signal]);
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
            if (!stopped) run = await get(waiting);
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
                JSON.stringify({ ...errorEnvelope(publicRun(run).error!), id: run.id }) +
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
        disconnected.abort();
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
