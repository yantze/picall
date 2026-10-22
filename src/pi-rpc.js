import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const extensionPath = fileURLToPath(new URL('./extensions/context-window.mjs', import.meta.url));
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function failure(message, status = 502, code = 'pi_error') {
  return Object.assign(new Error(message), { status, code });
}

function bundledCommand() {
  // Resolve through the package's public export, then use its declared CLI.
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return { file: process.execPath, args: [join(dirname(entry), 'bundle', 'cli.js')], packagePath: join(dirname(entry), '..', 'package.json') };
}

class RpcWorker extends EventEmitter {
  constructor(command, { cwd, model, effort, contextWindow, systemPrompt, logger }) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.buffer = '';
    this.stderr = '';
    const args = [...command.args, '--mode', 'rpc', '--no-session'];
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (contextWindow) args.push('--extension', extensionPath);
    this.child = spawn(command.file, args, {
      cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PICALL_CONTEXT_WINDOW: contextWindow ? String(contextWindow) : '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdin.on('error', (error) => this.fail(failure(`Pi RPC input closed: ${error.message}`)));
    this.child.on('error', (error) => this.fail(failure(`Could not start Pi: ${error.message}`, 503, 'pi_unavailable')));
    this.child.on('exit', (code, signal) => {
      // Extension/provider stderr can contain credentials and prompt payloads.
      // Keep it out of both API errors and ordinary application logs.
      if (!this.closed) this.logger?.log('error', 'Pi process exited.', { exitCode: code, signal });
      this.fail(failure(`Pi exited (${signal || code}). Check Pi's provider and extension configuration.`, 502, 'pi_exited'));
    });
    this.logger = logger;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }

  onData(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        this.fail(failure('Pi RPC record exceeded the 16 MiB limit.', 502, 'pi_protocol_error'));
        void this.close();
        return;
      }
      let record;
      try { record = JSON.parse(line); } catch {
        this.fail(failure('Pi returned an invalid JSONL protocol record.', 502, 'pi_protocol_error'));
        void this.close();
        return;
      }
      if (record.type === 'response' && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id);
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.success) pending.resolve(record.data);
        else pending.reject(failure(record.error || `${record.command} failed.`, 502, 'pi_command_error'));
      } else if (record.type === 'extension_ui_request') {
        // An HTTP agent has no interactive dialog. Explicitly cancel rather than
        // allowing extensions to wait indefinitely for an absent terminal.
        if (['select', 'confirm', 'input', 'editor'].includes(record.method)) {
          this.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
          this.logger?.log('warn', 'Cancelled a Pi extension dialog in headless mode.', { method: record.method });
        }
        this.emit('record', record);
      } else {
        this.emit('record', record);
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_RECORD_BYTES) {
      this.fail(failure('Pi RPC record exceeded the 16 MiB limit.', 502, 'pi_protocol_error'));
      void this.close();
    }
  }

  write(record) {
    if (this.closed) return false;
    return this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  send(command, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(this.error || failure('Pi is not running.'));
    const id = `picall-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(failure(`Pi did not acknowledge ${command.type} within ${timeoutMs / 1000}s.`, 504, 'pi_timeout'));
      }, timeoutMs) : null;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...command, id });
    });
  }

  async close() {
    this.fail(failure('Pi session was closed.', 503, 'session_closed'));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch { /* exited */ }
    };
    kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 750);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export class PiRuntime {
  constructor({ getConfig, logger, command } = {}) {
    this.getConfig = getConfig || (() => ({}));
    this.logger = logger;
    this.command = command;
    this.sessions = new Map();
    this.retiredIds = new Map();
    this.probeWorkers = new Set();
    this.probeQueue = Promise.resolve();
    this.closed = false;
    this.housekeeping = setInterval(() => { void this.reap(); }, 60_000);
    this.housekeeping.unref();
  }

  getCommand() { return this.command || bundledCommand(); }

  enqueueProbe(task) {
    const result = this.probeQueue.then(task, task);
    this.probeQueue = result.then(() => {}, () => {});
    return result;
  }

  async check() {
    const key = this.getConfig().workdir || process.cwd();
    if (this.checkCache?.key === key && Date.now() - this.checkCache.at < 30_000) return this.checkCache.value;
    if (this.checkInFlight?.key === key) return this.checkInFlight.promise;
    const promise = this.enqueueProbe(() => this.performCheck()).then((value) => {
      this.checkCache = { key, at: Date.now(), value };
      return value;
    }).finally(() => { if (this.checkInFlight?.promise === promise) this.checkInFlight = null; });
    this.checkInFlight = { key, promise };
    return promise;
  }

  async performCheck() {
    let worker;
    try {
      if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
      const command = this.getCommand();
      const version = command.packagePath ? JSON.parse(await readFile(command.packagePath, 'utf8')).version : 'custom';
      worker = this.createWorker({});
      this.probeWorkers.add(worker);
      await worker.send({ type: 'get_state' });
      return { available: true, version, error: null };
    } catch (error) {
      return { available: false, version: null, error: error.message };
    } finally { await worker?.close(); this.probeWorkers.delete(worker); }
  }

  createWorker(options) {
    const config = this.getConfig();
    return new RpcWorker(this.getCommand(), { cwd: config.workdir || process.cwd(), logger: this.logger, ...options });
  }

  async models() {
    const key = this.getConfig().workdir || process.cwd();
    if (this.modelsCache?.key === key && Date.now() - this.modelsCache.at < 10_000) return this.modelsCache.value.map((model) => ({ ...model }));
    if (this.modelsInFlight?.key === key) return (await this.modelsInFlight.promise).map((model) => ({ ...model }));
    const promise = this.enqueueProbe(() => this.performModels()).then((value) => {
      this.modelsCache = { key, at: Date.now(), value };
      return value;
    }).finally(() => { if (this.modelsInFlight?.promise === promise) this.modelsInFlight = null; });
    this.modelsInFlight = { key, promise };
    return (await promise).map((model) => ({ ...model }));
  }

  async performModels() {
    let worker;
    try {
      if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
      worker = this.createWorker({});
      this.probeWorkers.add(worker);
      const data = await worker.send({ type: 'get_available_models' });
      return (data?.models || []).map((model) => ({
        id: `${model.provider}/${model.id}`,
        provider: model.provider,
        name: model.name || model.id,
        contextWindow: model.contextWindow,
        reasoning: Boolean(model.reasoning),
      }));
    } finally { await worker?.close(); this.probeWorkers.delete(worker); }
  }

  async acquire(options = {}) {
    if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
    const config = this.getConfig();
    const settings = {
      model: options.model ?? config.model ?? '',
      effort: options.effort ?? config.effort ?? 'medium',
      contextWindow: options.contextWindow ?? config.contextWindow ?? null,
      systemPrompt: options.systemPrompt || '',
      workdir: config.workdir || process.cwd(),
    };
    const id = options.sessionId || randomUUID();
    if (this.retiredIds.has(id)) throw failure('This session has expired or was closed. Use a new session ID to start a conversation.', 409, 'session_expired');
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.busy) throw failure('This session is already processing a request.', 409, 'session_busy');
      if (existing.worker.closed) {
        this.retire(existing);
        throw failure('This Pi session has exited; start a new session.', 409, 'session_expired');
      }
      if (JSON.stringify(existing.settings) !== JSON.stringify(settings)) {
        throw failure('Model, effort, context window, system prompt, or working directory changed. Start a new session.', 409, 'session_configuration_changed');
      }
      existing.busy = true;
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= (config.maxSessions || 8)) {
      const idle = [...this.sessions.values()].filter((session) => !session.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      while (this.sessions.size >= (config.maxSessions || 8) && idle.length) {
        const evicted = idle.shift();
        this.retire(evicted);
        void evicted.worker?.close();
        this.logger?.log('info', 'Evicted an idle Pi session at capacity.', { sessionId: evicted.id });
      }
      if (this.sessions.size >= (config.maxSessions || 8)) throw failure('All Pi session slots are busy. Retry after an active request finishes.', 503, 'session_limit');
    }
    // Reserve synchronously before startup so two requests for the same ID cannot
    // accidentally create two Pi agents with different conversation state.
    const session = {
      id, model: settings.model, busy: true, createdAt: Date.now(), lastUsedAt: Date.now(), settings,
      worker: null,
      run: (prompt, runOptions) => this.run(session, prompt, runOptions),
    };
    this.sessions.set(id, session);
    try {
      session.worker = this.createWorker(settings);
      session.worker.on('failure', () => { this.retire(session); });
      const state = await session.worker.send({ type: 'get_state' });
      if (!state?.model) throw failure('Pi has no available model. Configure a provider with pi /login or its API-key environment variable.', 503, 'model_unavailable');
      session.model = `${state.model.provider}/${state.model.id}`;
      if (settings.model && session.model !== settings.model) throw failure(`Pi selected ${session.model} instead of the requested ${settings.model}. Use a model ID from /v1/models.`, 400, 'model_unavailable');
      if (settings.contextWindow && state.model.contextWindow !== settings.contextWindow) throw failure('Pi did not apply the configured context window.', 502, 'context_window_not_applied');
      const levels = await session.worker.send({ type: 'get_available_thinking_levels' });
      if (levels?.levels && !levels.levels.includes(settings.effort)) throw failure(`This model does not support effort ${settings.effort}. Supported: ${levels.levels.join(', ')}.`, 400, 'unsupported_effort');
      if (state.thinkingLevel && state.thinkingLevel !== settings.effort) {
        await session.worker.send({ type: 'set_thinking_level', level: settings.effort });
      }
      this.logger?.log('info', 'Pi session created.', { sessionId: id, model: session.model });
      return session;
    } catch (error) {
      this.retire(session);
      await session.worker?.close();
      throw error;
    }
  }

  async run(session, prompt, { signal, onText, onReasoning } = {}) {
    const worker = session.worker;
    let text = '';
    let lastAssistant;
    let assistantDelta = '';
    let pendingBreak = false;
    let outputBytes = 0;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let timer;
    let abort;
    let onRecord;
    let onFailure;
    try {
      if (signal?.aborted) throw failure('The request was cancelled.', 499, 'request_cancelled');
      let resolveRun;
      let rejectRun;
      const completed = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
      // A completion can fail while the prompt acknowledgment is still pending.
      completed.catch(() => {});
      const countOutput = (delta) => {
        outputBytes += Buffer.byteLength(delta);
        if (outputBytes > MAX_OUTPUT_BYTES) throw failure('Pi output exceeded the 8 MiB request limit.', 502, 'output_limit');
      };
      const emitText = (delta) => {
        countOutput(delta);
        if (pendingBreak) { pendingBreak = false; text += '\n\n'; onText?.('\n\n'); }
        text += delta;
        assistantDelta += delta;
        onText?.(delta);
      };
      onRecord = (record) => {
        try {
          if (record.type === 'message_start' && record.message?.role === 'assistant') {
            assistantDelta = '';
            pendingBreak = text.length > 0;
          }
          if (record.type === 'message_update') {
            const update = record.assistantMessageEvent;
            if (update?.type === 'text_delta' && update.delta) emitText(update.delta);
            if (update?.type === 'thinking_delta' && update.delta) { countOutput(update.delta); onReasoning?.(update.delta); }
          }
          if (record.type === 'message_end' && record.message?.role === 'assistant') {
            lastAssistant = record.message;
            if (!assistantDelta && !['error', 'aborted'].includes(lastAssistant.stopReason)) {
              const fallbackText = (lastAssistant.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
              if (fallbackText) emitText(fallbackText);
            }
            const current = lastAssistant.usage;
            if (current) {
              usage.prompt_tokens += (current.input || 0) + (current.cacheRead || 0) + (current.cacheWrite || 0);
              usage.completion_tokens += current.output || 0;
              usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
            }
          }
          if (record.type === 'tool_execution_start' || record.type === 'tool_execution_end') {
            this.logger?.log(record.isError ? 'warn' : 'info', `Pi ${record.type}.`, { sessionId: session.id, tool: record.toolName, isError: record.isError });
          }
          if (record.type === 'agent_settled') resolveRun();
        } catch (error) { rejectRun(error); void worker.close(); }
      };
      onFailure = (error) => rejectRun(error);
      abort = () => {
        rejectRun(failure('The request was cancelled.', 499, 'request_cancelled'));
        void worker.close();
      };
      worker.on('record', onRecord);
      worker.on('failure', onFailure);
      signal?.addEventListener('abort', abort, { once: true });
      const timeoutMs = (this.getConfig().requestTimeoutSeconds || 300) * 1000;
      timer = setTimeout(() => {
        rejectRun(failure(`Pi did not complete the request within ${timeoutMs / 1000}s.`, 504, 'request_timeout'));
        void worker.close();
      }, timeoutMs);
      timer.unref();
      const accepted = await worker.send({ type: 'prompt', message: prompt }, 0);
      if (accepted?.disposition !== 'handled') await completed;
      else {
        const state = await worker.send({ type: 'get_state' });
        if (state?.isStreaming || state?.isCompacting) await completed;
      }
      if (lastAssistant?.stopReason === 'error') throw failure(lastAssistant.errorMessage || 'The model request failed.', 502, 'provider_error');
      if (lastAssistant?.stopReason === 'aborted') throw failure('Pi aborted the request.', 499, 'request_cancelled');
      return { text, usage, finishReason: lastAssistant?.stopReason === 'length' ? 'length' : 'stop' };
    } catch (error) {
      this.retire(session);
      await worker.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (onRecord) worker.off('record', onRecord);
      if (onFailure) worker.off('failure', onFailure);
      session.busy = false;
      session.lastUsedAt = Date.now();
    }
  }

  list() {
    return [...this.sessions.values()].map(({ id, model, busy, createdAt, lastUsedAt }) => ({ id, model, busy, createdAt, lastUsedAt }));
  }

  retire(session) {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    this.retiredIds.set(session.id, Date.now());
    while (this.retiredIds.size > 1000) this.retiredIds.delete(this.retiredIds.keys().next().value);
  }

  async closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw failure('Session not found.', 404, 'session_not_found');
    if (session.busy) throw failure('This session is processing a request.', 409, 'session_busy');
    this.retire(session);
    await session.worker?.close();
    this.logger?.log('info', 'Pi session closed.', { sessionId: id });
  }

  async reap() {
    const cutoff = Date.now() - (this.getConfig().idleTimeoutMinutes || 30) * 60_000;
    await Promise.all([...this.sessions.values()].filter((session) => !session.busy && session.lastUsedAt < cutoff).map((session) => this.closeSession(session.id).catch(() => {})));
  }

  async close() {
    this.closed = true;
    clearInterval(this.housekeeping);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all([...sessions.map((session) => session.worker?.close()), ...[...this.probeWorkers].map((worker) => worker.close())]);
  }
}
