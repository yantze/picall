import { chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Harness, createRegistry, defineDoc, defineDocFamily, UsageDoc } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { RunIndex, publicRun, terminal, digest, fingerprint, runPattern } from './run-index.js';
import { configFingerprint, createModelRuntime, modelInfo } from './durable-models.js';
import { createResearchTools, researchSystemPrompt } from './web/tools.js';
import { appError } from './config.js';

const copy = value => JSON.parse(JSON.stringify(value));
const definition = (kind, initial) => ({ kind, version: 1, scope: 'session', initial, checkpointWhen: () => true });
const SessionDoc = defineDoc(definition('picall.session', () => ({ hashes: [], count: 0, system: '', model: '' })));
const RunDoc = defineDocFamily({ ...definition('picall.run', seed => seed), family: true });
const CacheDoc = defineDocFamily({ ...definition('picall.web', () => ({ data: {} })), family: true });
const errors = {
  request_cancelled: [499, 'The task was cancelled.'], request_timeout: [504, 'The task exceeded its original execution deadline.'],
  session_configuration_changed: [409, 'Execution configuration changed. Submit a new task with a new session.'],
  provider_error: [502, 'The model provider rejected or failed the request.'], turn_limit: [422, 'The task reached its tool-round limit.'],
  output_limit: [502, 'The model exhausted its output limit before completing an answer.'], unanswered: [502, 'The task ended without a completed answer.'],
  restart_limit: [502, 'The task exceeded its crash recovery limit.'], storage_error: [507, 'Local task storage is unavailable.'],
};
const failure = code => ({ code, status: errors[code]?.[0] || 502, message: errors[code]?.[1] || 'The task failed. Check local operational logs.' });
const safeError = error => errors[error?.code] ? failure(error.code) : error?.status >= 400 && error.status < 500
  ? { code: error.code || 'invalid_request', status: error.status, message: String(error.message).slice(0, 1024) } : failure('storage_error');
const text = content => typeof content === 'string' ? content : content.map(part => part.text).join('\n');
function inputContext(input) {
  return { messages: input.messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => ({ role: message.role, content: text(message.content) })),
    system: input.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => text(message.content)).join('\n\n'),
    explicitSystem: input.messages.some(message => ['system', 'developer'].includes(message.role)) };
}
function usageDelta(before, after) {
  const result = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, models: {} };
  for (const [key, value] of Object.entries(after?.models || {})) {
    const old = before?.models?.[key] || {};
    const diff = {};
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) diff[field] = Math.max(0, (value[field] || 0) - (old[field] || 0));
    result.prompt_tokens += diff.input + diff.cacheRead + diff.cacheWrite;
    result.completion_tokens += diff.output;
    result.models[key] = diff;
  }
  result.total_tokens = result.prompt_tokens + result.completion_tokens;
  return result;
}

export class DurableRuntime {
  constructor({ dataDir, getConfig, logger, fetch: net, checkpoint = async () => {} } = {}) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.net = net;
    this.checkpoint = checkpoint;
    this.index = new RunIndex(dataDir);
    this.handles = new Map();
    this.openings = new Map();
    this.drivers = new Map();
    this.waiters = new Map();
    this.gate = Promise.resolve();
    this.closing = false;
    this.recovered = 0;
  }
  locked(fn) { const pending = this.gate.then(fn); this.gate = pending.catch(() => {}); return pending; }
  open() {
    if (this.closing) return Promise.reject(appError('Runtime is closed.', 503, 'unavailable'));
    if (!this.opening) this.opening = (async () => {
      await this.index.open();
      try {
        if (this.closing) throw appError('Runtime is closing.', 503, 'unavailable');
        await this.index.cleanup(id => this.evict(id));
        await this.pump();
        if (this.closing) throw appError('Runtime is closing.', 503, 'unavailable');
        this.housekeeping = setInterval(() => {
          void this.locked(async () => { await this.reap(); await this.index.cleanup(id => this.evict(id)); await this.pump(); }).catch(() => this.logger?.log('error', 'Durable maintenance failed.', { code: 'storage_error' }));
        }, 60000);
        this.housekeeping.unref();
        return this;
      } catch (error) { await this.closeHandles(); this.index.close(); throw error; }
    })();
    return this.opening;
  }
  async models() { const config = this.getConfig(); return config.modelApiKey ? [modelInfo(config)] : []; }
  async check() {
    await this.open();
    return { kind: 'pi-durable', available: !this.closing && !this.storageError, ...(this.storageError ? { error: 'Local task storage is unavailable. Restart to recover.' } : {}), version: '1.5.0', storage: 'sqlite', recovery: true, recoveredTasks: this.recovered,
      tools: (await this.capabilities()).tools.filter(tool => tool.enabled).map(tool => tool.name) };
  }
  async capabilities() {
    const config = this.getConfig();
    const tools = config.enableResearch ? createResearchTools(config).tools.map(tool => ({ name: tool.name, description: tool.description,
      enabled: config.toolOverrides?.[tool.name] !== false, defaultEnabled: true, active: config.toolOverrides?.[tool.name] !== false })) : [];
    return { runtime: { kind: 'pi-durable' }, tools };
  }
  list() {
    if (!this.index.db || this.index.closed) return [];
    return this.index.sessions().filter(session => !session.retired).map(session => ({ ...session,
      busy: Boolean(this.index.active(session.id)), loaded: this.handles.has(session.id) })).map(({ configHash, ...session }) => session);
  }
  async lookup(input, options = {}) {
    await this.open();
    const run = this.index.lookup(input, options);
    if (!run) return undefined;
    if (terminal(run) || run.submissionId) return publicRun(run);
    // A concurrent retry must wait for the first admission's Durable commit,
    // rather than acknowledge only the index/outbox half of the operation.
    return this.locked(async () => {
      await this.pump();
      const latest = this.index.get(run.id);
      if (!terminal(latest) && !latest.submissionId) throw appError('Admission is pending recovery. Retry with the same Idempotency-Key.', 503, 'unavailable');
      return publicRun(latest);
    });
  }
  async submit(input, options = {}) {
    await this.open();
    return this.locked(async () => {
      if (this.closing) throw appError('Service is shutting down.', 503, 'unavailable');
      if (this.storageError) throw appError('Restart the service to recover task storage.', 507, 'storage_error');
      const identity = options.identityInput || input;
      const previous = this.index.lookup(identity, options);
      if (previous) return publicRun(previous);
      await this.index.cleanup(id => this.evict(id));
      const config = structuredClone(this.getConfig());
      if (!config.modelApiKey) throw appError('Configure a model API key in the local settings page.', 503, 'model_unavailable');
      if (![config.defaultModel, `picall/${config.defaultModel}`].includes(input.model || config.defaultModel)) throw appError('The requested model is unavailable.', 404, 'model_not_found');
      if (!['off', 'none', undefined, null].includes(input.reasoning_effort)) throw appError('This configured model supports only off reasoning effort.', 400, 'unsupported_effort');
      if (options.sessionId && this.index.active(options.sessionId)) throw appError('This session is processing a task.', 409, 'session_busy');
      const active = this.index.all().filter(run => !terminal(run));
      if (active.length >= config.maxSessions) throw appError('All execution slots are busy.', 503, 'session_limit');
      const prepared = { model: `picall/${config.defaultModel}`,
        messages: input.messages.map(message => ({ role: message.role, content: text(message.content) })) };
      const oldSession = options.sessionId && this.index.session(options.sessionId);
      if (oldSession && !oldSession.retired && !oldSession.legacy && oldSession.configHash === configFingerprint(config) && !this.index.active(oldSession.id)) {
        const handle = await this.handle(oldSession.id, config);
        const meta = await handle.harness.snapshot(SessionDoc, BG);
        if (meta?.count) this.prepareHistory(prepared, meta);
      }
      const { run, duplicate } = this.index.stage(prepared, identity, options, configFingerprint(config), config.requestTimeoutSeconds * 1000);
      if (duplicate) return publicRun(run);
      try {
        await this.checkpoint('index-stored', run.id);
        await this.admit(run, config);
        this.drive(run.id);
        return publicRun(this.index.get(run.id));
      } catch (error) {
        if (error.code && error.status < 500) { await this.finish(run.id, 'failed', safeError(error)); throw error; }
        this.notify(run.id, undefined, appError('Task admission could not be persisted.', 507, 'storage_error'));
        throw appError('Task admission could not be persisted. Retry with the same Idempotency-Key.', 507, 'storage_error');
      }
    });
  }
  async handle(sessionId, config) {
    if (this.handles.has(sessionId)) return this.handles.get(sessionId);
    if (this.openings.has(sessionId)) return this.openings.get(sessionId);
    const pending = this.openHandle(sessionId, config).finally(() => this.openings.delete(sessionId));
    this.openings.set(sessionId, pending);
    return pending;
  }
  async openHandle(sessionId, config) {
    const path = join(this.index.directory, 'sessions', digest(sessionId) + '.sqlite');
    const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600);
    const database = await openNodeSqliteDatabase(path);
    await database.exec('PRAGMA synchronous=FULL');
    const storage = await SqliteStorage.open(database, { prefix: 'pi_' });
    const handle = { sessionId, config: structuredClone(config), active: this.index.active(sessionId), storage, lastUsed: Date.now(), timer: null };
    const guard = () => {
      if (this.closing) throw appError('Runtime is closing.', 503, 'runtime_closed');
      const run = handle.active && this.index.get(handle.active.id);
      if (!run || terminal(run) || run.cancelRequested) throw appError('Task was cancelled.', 499, 'request_cancelled');
      if (Date.now() >= run.deadline) throw appError('Deadline exceeded.', 504, 'request_timeout');
    };
    const store = {
      get: async key => {
        const id = key.split(':')[1];
        const cache = await handle.harness.snapshot(CacheDoc, id, BG);
        return cache?.data[key];
      },
      put: async (key, value) => {
        const id = key.split(':')[1];
        await handle.harness.commit(async tx => { (await tx.doc(CacheDoc, id, null)).data[key] = copy(value); }, BG);
      },
    };
    const research = createResearchTools(config, { store, scope: async () => { guard(); return { id: handle.active.id, deadline: handle.active.deadline }; }, ...(this.net ? { fetch: this.net } : {}) });
    const registry = createRegistry();
    registry.install({ name: 'picall-research',
      tools: config.enableResearch ? research.tools.filter(tool => config.toolOverrides?.[tool.name] !== false).map(tool => ({ ...tool, replay: 'safe',
        execute: async (args, _api, context) => {
          guard();
          await this.checkpoint('tool-start', handle.active.id);
          this.logger?.log('info', 'Tool started.', { sessionId, runId: handle.active.id, tool: tool.name });
          try {
            const result = await tool.execute(args, context.abortSignal);
            this.logger?.log('info', 'Tool completed.', { sessionId, runId: handle.active.id, tool: tool.name });
            return { output: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (error) {
            this.logger?.log('warn', 'Tool failed.', { sessionId, runId: handle.active.id, tool: tool.name, code: error.code || 'tool_error' });
            if (context.abortSignal?.aborted) throw error;
            return { isError: true, output: [{ type: 'text', text: JSON.stringify({ error: { code: error.code || 'tool_error' } }) }] };
          }
        },
      })) : [],
      sections: config.enableResearch ? [{ key: 'research', tag: false, render: () => researchSystemPrompt() }] : [],
    });
    try {
      handle.harness = await Harness.open(storage, { registry, models: createModelRuntime(config, guard),
        settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000, maxAgentDelayMs: 10000 }, restartLimit: 5, afterFailedRun: 'withdraw' },
        onReport: report => { if (report.kind === 'storage_failed') this.storageError = true; this.logger?.log('warn', 'Durable runtime report.', { kind: report.kind, reason: report.reason }); },
      }, BG);
      handle.root = await handle.harness.root(BG);
      this.handles.set(sessionId, handle);
      return handle;
    } catch (error) { await storage.close(BG); throw error; }
  }
  prepareHistory(input, meta) {
    const parsed = inputContext(input);
    const system = parsed.explicitSystem ? parsed.system : meta.system;
    let messages = parsed.messages;
    if (meta.count) {
      if (system !== meta.system || meta.model !== input.model) throw appError('Session instructions or model changed. Start a new session.', 409, 'session_configuration_changed');
      if (messages.length > 1) {
        if (messages.length !== meta.count + 1 || JSON.stringify(messages.slice(0, meta.count).map(fingerprint)) !== JSON.stringify(meta.hashes)) throw appError('Session history does not match.', 409, 'session_history_conflict');
        messages = messages.slice(meta.count);
      }
    }
    return { system, messages };
  }
  async admit(run, config) {
    const handle = await this.handle(run.sessionId, config);
    handle.active = run;
    const existing = await handle.storage.submissionByRequest(handle.root.id, run.id, BG);
    if (!existing) {
      const meta = await handle.harness.snapshot(SessionDoc, BG) || { hashes: [], count: 0, system: '', model: '' };
      const { system, messages } = this.prepareHistory(run.input, meta);
      const prompt = messages.length === 1 ? messages[0].content : 'Continue this conversation:\n\n' + messages.map(message => `<${message.role}>\n${message.content}\n</${message.role}>`).join('\n\n');
      await handle.root.configure({ model: { provider: 'picall', modelId: config.defaultModel }, maxTurns: config.maxToolRounds,
        instructions: [system, config.additionalSystemPrompt].filter(Boolean).join('\n\n'), thinkingLevel: 'off' }, BG);
      run.submissionId = await handle.harness.commit(async tx => {
        const before = copy(await tx.doc(UsageDoc, handle.root.id));
        const id = await handle.root.submit(tx, { type: 'input', content: prompt, requestId: run.id, whenBusy: 'reject' });
        const data = await tx.doc(RunDoc, run.id, { before, nextHashes: [...meta.hashes, ...messages.map(fingerprint)], nextCount: meta.count + messages.length,
          system, model: run.model, deadline: run.deadline, createdAt: run.createdAt });
        data.submissionId = id;
        return id;
      }, BG);
    } else run.submissionId = existing.id;
    await this.checkpoint('durable-submitted', run.id);
    run.status = 'running'; run.updatedAt = Date.now();
    this.index.put(run);
    handle.lastUsed = Date.now();
    clearTimeout(handle.timer);
    handle.timer = setTimeout(() => { void this.cancelWith(run.id, failure('request_timeout')).catch(() => this.notify(run.id, undefined, appError('Storage failure.', 507, 'storage_error'))); }, Math.max(1, run.deadline - Date.now()));
    handle.timer.unref();
    handle.harness.resume();
  }
  drive(id) {
    if (this.drivers.has(id) || this.closing) return;
    const promise = this.execute(id).catch(error => {
      if (!this.closing) { this.storageError = true; this.logger?.log('error', 'Durable task supervision failed.', { runId: id, code: error.code || 'storage_error' }); this.notify(id, undefined, appError('Task storage is unavailable. Restart the service to recover.', 507, 'storage_error')); }
    }).finally(() => {
      this.drivers.delete(id);
      if (!this.closing) void this.locked(() => this.pump()).catch(() => { this.storageError = true; });
    });
    this.drivers.set(id, promise);
  }
  async execute(id) {
    const run = this.index.get(id);
    const handle = this.handles.get(run.sessionId);
    const submission = await handle.harness.submission(run.submissionId, BG);
    if (!submission) throw appError('Missing persisted submission.', 507, 'storage_error');
    const settled = await submission.wait(BG);
    if (this.closing) return;
    await this.checkpoint('answer-settled', id);
    await this.locked(() => this.finalize(id, handle, settled));
  }
  async finalize(id, handle, settled) {
    const run = this.index.get(id);
    if (terminal(run) || this.closing) return;
    if (run.cancelRequested) return;
    if (settled.status !== 'done') {
      if (Date.now() >= run.deadline) return this.stop(id, failure('request_timeout'));
      const code = settled.reason === 'turn_limit' ? 'turn_limit' : settled.reason === 'restart_limit' ? 'restart_limit' : 'provider_error';
      return this.finish(id, 'failed', failure(code));
    }
    const entry = (await handle.storage.entry(handle.root.id, settled.answer, BG))?.entry;
    const answer = entry?.model?.find(message => message.role === 'assistant');
    if (answer && answer.timestamp > run.deadline) return this.stop(id, failure('request_timeout'));
    if (!answer || answer.stopReason !== 'stop' || answer.content.some(part => part.type === 'toolCall')) return this.finish(id, 'failed', failure(answer?.stopReason === 'length' ? 'output_limit' : 'unanswered'));
    const content = answer.content.filter(part => part.type === 'text').map(part => part.text).join('');
    if (!content.trim()) return this.finish(id, 'failed', failure('unanswered'));
    const data = await handle.harness.snapshot(RunDoc, id, BG);
    const usage = usageDelta(data.before, await handle.harness.snapshot(UsageDoc, handle.root.id, BG));
    const completion = { id, object: 'chat.completion', created: Math.floor(run.createdAt / 1000), model: run.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage };
    await handle.harness.commit(async tx => {
      const record = await tx.doc(RunDoc, id, null);
      if (record.completed) return;
      const meta = await tx.doc(SessionDoc);
      meta.hashes = [...data.nextHashes, fingerprint({ role: 'assistant', content })].slice(-500);
      meta.count = data.nextCount + 1; meta.system = data.system; meta.model = data.model;
      record.completed = true;
    }, BG);
    await this.checkpoint('before-finalize', id);
    const cache = await handle.harness.snapshot(CacheDoc, id, BG);
    run.service_calls = cache?.data[`calls:${id}`] || {};
    this.index.put(run);
    await this.finish(id, 'completed', undefined, completion);
  }
  async finish(id, status, error, completion) {
    const old = this.index.get(id);
    if (!old || terminal(old)) return old && publicRun(old);
    const run = { ...old, status, updatedAt: Date.now(), elapsed_ms: Date.now() - old.createdAt, ...(error ? { error } : {}), ...(completion ? { completion } : {}) };
    const handle = this.handles.get(run.sessionId);
    if (handle) {
      const cache = await handle.harness.snapshot(CacheDoc, id, BG);
      run.service_calls = cache?.data[`calls:${id}`] || {};
      const data = await handle.harness.snapshot(RunDoc, id, BG);
      if (data?.before) run.usage = completion?.usage || usageDelta(data.before, await handle.harness.snapshot(UsageDoc, handle.root.id, BG));
    }
    delete run.input;
    this.index.transaction(() => {
      this.index.put(run);
      const session = this.index.session(run.sessionId);
      this.index.putSession({ ...session, lastUsedAt: Date.now(), ...(status === 'completed' ? {} : { retired: true }) });
    });
    if (handle) { clearTimeout(handle.timer); handle.lastUsed = Date.now(); }
    this.logger?.log(error ? 'warn' : 'info', 'Task settled.', { runId: id, sessionId: run.sessionId, status, code: error?.code, elapsed_ms: run.elapsed_ms, usage: completion?.usage });
    this.notify(id, publicRun(run));
    return publicRun(run);
  }
  async get(id) { await this.open(); if (!runPattern.test(id) || !this.index.get(id)) throw appError('Task not found.', 404, 'run_not_found'); return publicRun(this.index.get(id)); }
  async wait(id, { signal } = {}) {
    await this.open();
    signal?.throwIfAborted();
    const run = await this.get(id);
    if (terminal(run)) return run;
    return new Promise((resolve, reject) => {
      const listener = { resolve, reject };
      const clean = () => { signal?.removeEventListener('abort', abort); this.waiters.get(id)?.delete(listener); if (!this.waiters.get(id)?.size) this.waiters.delete(id); };
      const abort = () => { clean(); reject(appError('Waiting was cancelled; execution continues.', 499, 'request_cancelled')); };
      listener.resolve = value => { clean(); resolve(value); }; listener.reject = error => { clean(); reject(error); };
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id).add(listener);
      signal?.addEventListener('abort', abort, { once: true });
      const latest = this.index.get(id);
      if (this.storageError && !terminal(latest)) listener.reject(appError('Restart to recover task storage.', 507, 'storage_error'));
      else if (terminal(latest)) listener.resolve(publicRun(latest));
      else if (signal?.aborted) abort();
    });
  }
  notify(id, value, error) { for (const listener of [...(this.waiters.get(id) || [])]) error ? listener.reject(error) : listener.resolve(value); }
  async cancel(id) { return this.cancelWith(id, failure('request_cancelled')); }
  async cancelWith(id, error) { await this.open(); return this.locked(() => this.stop(id, error)); }
  async stop(id, error) {
    let run = this.index.get(id);
    if (!run) throw appError('Task not found.', 404, 'run_not_found');
    if (terminal(run) && !run.needsAbort) return publicRun(run);
    const handle = await this.handle(run.sessionId, structuredClone(this.getConfig()));
    handle.active = run;
    if (!run.cancelRequested) {
      const settled = await handle.storage.submissionByRequest(handle.root.id, run.id, BG);
      if (settled?.status === 'done') {
        const entry = (await handle.storage.entry(handle.root.id, settled.answer, BG))?.entry;
        const answer = entry?.model?.find(message => message.role === 'assistant');
        if (answer && answer.timestamp <= run.deadline) {
          await this.finalize(id, handle, settled);
          return publicRun(this.index.get(id));
        }
      }
    }
    run = { ...run, cancelRequested: true, needsAbort: true, abortError: error };
    this.index.put(run);
    await this.checkpoint('cancel-intent', id);
    handle.active = run;
    await handle.root.abort(BG);
    run.needsAbort = false;
    this.index.put(run);
    return this.finish(id, error.code === 'request_cancelled' ? 'cancelled' : 'failed', error);
  }
  async pump() {
    if (this.closing) return;
    const pending = this.index.all().filter(run => !terminal(run) || run.needsAbort);
    for (const run of pending) {
      if (this.drivers.has(run.id)) continue;
      const config = structuredClone(this.getConfig());
      const handle = await this.handle(run.sessionId, config);
      handle.active = run;
      const existing = await handle.storage.submissionByRequest(handle.root.id, run.id, BG);
      if (existing?.status === 'done' && !run.cancelRequested) {
        await this.finalize(run.id, handle, existing); continue;
      }
      const error = run.cancelRequested ? run.abortError || failure('request_cancelled') : Date.now() >= run.deadline ? failure('request_timeout')
        : configFingerprint(config) !== run.configHash ? failure('session_configuration_changed') : undefined;
      if (error) { await this.stop(run.id, error); continue; }
      if (this.drivers.size >= config.maxSessions) {
        clearTimeout(handle.timer);
        handle.timer = setTimeout(() => { void this.cancelWith(run.id, failure('request_timeout')).catch(() => {}); }, Math.max(1, run.deadline - Date.now()));
        handle.timer.unref();
        continue;
      }
      await this.admit(run, config);
      this.recovered++;
      this.logger?.log('info', 'Task recovery scheduled.', { runId: run.id, sessionId: run.sessionId });
      this.drive(run.id);
    }
  }
  async evict(id) {
    const handle = this.handles.get(id);
    if (!handle) return;
    clearTimeout(handle.timer);
    try { await handle.harness.close(BG); }
    finally { this.handles.delete(id); }
  }
  async reap() {
    const cutoff = Date.now() - this.getConfig().idleTimeoutMinutes * 60000;
    for (const [id, handle] of this.handles) if (handle.lastUsed < cutoff && !this.index.active(id)) await this.evict(id);
  }
  async closeSession(id) {
    await this.open();
    return this.locked(async () => {
      const session = this.index.session(id);
      if (!session) throw appError('Session not found.', 404, 'session_not_found');
      if (this.index.active(id)) throw appError('Session is busy.', 409, 'session_busy');
      await this.evict(id);
      this.index.putSession({ ...session, retired: true });
    });
  }
  async closeHandles() {
    const results = await Promise.allSettled([...this.handles.keys()].map(id => this.evict(id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.housekeeping);
    await this.opening?.catch(() => {});
    await this.gate;
    try {
      let closingError;
      try { await this.closeHandles(); } catch (error) { closingError = error; }
      await Promise.allSettled([...this.drivers.values()]);
      if (closingError) throw closingError;
    } finally {
      for (const id of [...this.waiters.keys()]) this.notify(id, undefined, appError('Service stopped. Query the run after restart.', 503, 'unavailable'));
      this.index.close();
    }
  }
}
