import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { canonicalOverrides, DEFAULT_ADDITIONAL_SYSTEM_PROMPT } from './config.js';
import { discoverExtensions } from './extension-catalog.js';
import { toolPolicy } from './tool-policy.js';

const extensionPath = fileURLToPath(new URL('./extensions/runtime.mjs', import.meta.url));
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOOLS = 512;
const MAX_TOOL_NAME_LENGTH = 256;

// Only application-managed settings cross the child-process boundary. A hash
// participates in probe/session identity, so rotated credentials and endpoint
// changes cannot silently reuse a worker with stale configuration.
const LOCAL_FIELDS = ['modelBaseUrl', 'modelApiKey', 'defaultModel', 'modelContextWindow', 'modelMaxTokens',
  'enableResearch', 'maxToolRounds', 'requestTimeoutSeconds', 'braveApiKey', 'tavilyApiKey',
  'tinyfishApiKey', 'exaApiKey', 'jinaApiKey', 'braveBaseUrl', 'tavilyBaseUrl', 'httpTools'];
function localConfig(config) {
  return Object.fromEntries(LOCAL_FIELDS.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
}
function localConfigKey(config) {
  return createHash('sha256').update(JSON.stringify(localConfig(config))).digest('hex');
}

function toolNames(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((name) => typeof name === 'string' &&
    name.length > 0 && name.length <= MAX_TOOL_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(name)))]
    .slice(0, MAX_TOOLS).sort();
}

function runtimeContext(workdir, command) {
  const configuredDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const agentDir = resolve(workdir, configuredDir === '~' ? homedir() : configuredDir.replace(/^~[/\\]/, `${homedir()}/`));
  return {
    workdir,
    agentDir,
    offlineStartup: command?.args?.includes('--offline') || /^(1|true|yes)$/i.test(process.env.PI_OFFLINE || ''),
  };
}

function copySnapshot(value) {
  return { ...value, tools: [...value.tools], availableTools: [...value.availableTools], toolDetails: (value.toolDetails || []).map(tool => ({ ...tool })) };
}

function copyModel(value) {
  return { ...value, reasoningEfforts: [...value.reasoningEfforts], input: [...value.input] };
}

function failure(message, status = 502, code = 'pi_error') {
  return Object.assign(new Error(message), { status, code });
}

function bundledCommand() {
  // Resolve through the package's public export, then use its declared CLI.
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  return { file: process.execPath, args: [join(dirname(entry), 'bundle', 'cli.js')], packagePath: join(dirname(entry), '..', 'package.json') };
}

class RpcWorker extends EventEmitter {
  constructor(command, { cwd, model, effort, systemPrompt, additionalSystemPrompt = DEFAULT_ADDITIONAL_SYSTEM_PROMPT, projectTrust, saveSessions = false, enableSkills = false, toolOverrides = {}, selectedExtensions, managedConfig = {}, logger }) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.buffer = '';
    this.stderr = '';
    this.context = runtimeContext(cwd, command);
    this.metadata = { activeTools: [], availableTools: [], toolDetails: [] };
    this.metadataKnown = false;
    const args = [...command.args, '--mode', 'rpc', '--extension', extensionPath];
    if (selectedExtensions !== undefined) {
      args.push('--no-extensions');
      for (const path of selectedExtensions) args.push('--extension', path);
    }
    if (!saveSessions) args.push('--no-session');
    if (!enableSkills) args.push('--no-skills');
    if (projectTrust === 'allow') args.push('--approve');
    if (projectTrust === 'deny') args.push('--no-approve');
    if (model) args.push('--model', model);
    if (effort) args.push('--thinking', effort);
    const appendSystemPrompt = [systemPrompt, additionalSystemPrompt].filter(Boolean).join('\n\n');
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
    this.child = spawn(command.file, args, {
      cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PICALL_TOOL_OVERRIDES: JSON.stringify(toolOverrides),
        PICALL_LOCAL_CONFIG: JSON.stringify(managedConfig), PICALL_MODEL_API_KEY: managedConfig.modelApiKey || '' },
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

  snapshot() {
    return { ...this.context, tools: [...this.metadata.activeTools], availableTools: [...this.metadata.availableTools], toolDetails: this.metadata.toolDetails.map(tool => ({ ...tool })) };
  }

  assertMetadata() {
    if (!this.metadataKnown) throw failure('Pi did not report its tool registry. Restart PiCall and check its runtime extension.', 502, 'runtime_metadata_unavailable');
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
        if (record.method === 'setStatus' && record.statusKey === 'picall_failure') {
          // Only fixed codes enter the API; extension/provider payloads stay out.
          try {
            const code = JSON.parse(record.statusText)?.code;
            if (['turn_limit', 'deadline_exceeded'].includes(code)) this.emit('record', { type: 'picall_failure', code });
          } catch { /* Ignore malformed optional status records. */ }
          continue;
        }
        if (record.method === 'setStatus' && record.statusKey === 'picall_runtime') {
          try {
            if (typeof record.statusText !== 'string' || record.statusText.length > 2 * 1024 * 1024) throw new Error('Invalid runtime status.');
            const metadata = JSON.parse(record.statusText);
            if (!Array.isArray(metadata.activeTools) || !Array.isArray(metadata.availableTools)) throw new Error('Invalid runtime status.');
            const activeTools = toolNames(metadata.activeTools);
            const availableTools = toolNames(metadata.availableTools);
            const knownNames = new Set(availableTools);
            const toolDetails = (Array.isArray(metadata.toolDetails) ? metadata.toolDetails : []).filter(tool => tool && knownNames.has(tool.name)).slice(0, MAX_TOOLS).map(tool => ({
              name: tool.name, description: typeof tool.description === 'string' ? tool.description.slice(0, 512) : '',
              enabled: tool.enabled === true, active: activeTools.includes(tool.name),
              exposure: ['direct', 'model-only', 'codemode', 'deferred', 'hidden'].includes(tool.exposure) ? tool.exposure : 'direct',
              defaultEnabled: tool.defaultEnabled === true, reason: typeof tool.reason === 'string' ? tool.reason.slice(0, 256) : '',
            }));
            this.metadata = { activeTools, availableTools, toolDetails };
            this.metadataKnown = true;
            this.emit('record', { type: 'picall_runtime', ...this.metadata });
          } catch {
            this.logger?.log('warn', 'Pi returned invalid runtime tool metadata.', { code: 'invalid_runtime_metadata' });
          }
          continue;
        }
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
    this.workers = new Set();
    this.probeQueue = Promise.resolve();
    this.closed = false;
    this.housekeeping = setInterval(() => { void this.reap(); }, 60_000);
    this.housekeeping.unref();
  }

  getCommand() { return this.command || bundledCommand(); }

  probeKey() {
    const config = this.getConfig();
    return JSON.stringify({ ...runtimeContext(config.workdir || process.cwd(), this.command), projectTrust: config.projectTrust || 'default', enableSkills: config.enableSkills === true,
      toolOverrides: canonicalOverrides(config.toolOverrides || {}), enableExtensions: config.enableExtensions !== false, extensionOverrides: canonicalOverrides(config.extensionOverrides || {}),
      managedConfig: localConfigKey(config) });
  }

  enqueueProbe(task) {
    const result = this.probeQueue.then(task, task);
    this.probeQueue = result.then(() => {}, () => {});
    return result;
  }

  async check() {
    const key = this.probeKey();
    if (this.checkCache?.key === key && Date.now() - this.checkCache.at < 30_000) return copySnapshot(this.checkCache.value);
    if (this.checkInFlight?.key === key) return copySnapshot(await this.checkInFlight.promise);
    const promise = this.enqueueProbe(() => this.performCheck()).then((value) => {
      this.checkCache = { key, at: Date.now(), value };
      return value;
    }).finally(() => { if (this.checkInFlight?.promise === promise) this.checkInFlight = null; });
    this.checkInFlight = { key, promise };
    return copySnapshot(await promise);
  }

  async performCheck() {
    let worker;
    let version = null;
    const context = runtimeContext(this.getConfig().workdir || process.cwd(), this.command);
    try {
      if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
      const command = this.getCommand();
      version = command.packagePath ? JSON.parse(await readFile(command.packagePath, 'utf8')).version : 'custom';
      worker = await this.createWorker({ saveSessions: false });
      this.probeWorkers.add(worker);
      await worker.send({ type: 'get_state' });
      worker.assertMetadata();
      return { available: true, version, error: null, ...worker.snapshot() };
    } catch (error) {
      return { available: false, version, error: error.message, tools: [], availableTools: [], ...context };
    } finally { await worker?.close(); this.probeWorkers.delete(worker); }
  }

  async createWorker(options) {
    const config = this.getConfig();
    const settings = { ...config, ...options };
    let selectedExtensions;
    if (settings.enableExtensions === false) selectedExtensions = [];
    else if (Object.keys(settings.extensionOverrides || {}).length) {
      selectedExtensions = (await this.extensions(settings)).filter(extension => extension.enabled).map(extension => extension.path);
    }
    if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
    const worker = new RpcWorker(this.getCommand(), { cwd: config.workdir || process.cwd(), projectTrust: config.projectTrust || 'default',
      enableSkills: config.enableSkills === true, toolOverrides: config.toolOverrides || {}, additionalSystemPrompt: config.additionalSystemPrompt ?? DEFAULT_ADDITIONAL_SYSTEM_PROMPT,
      logger: this.logger, ...options, selectedExtensions, managedConfig: localConfig(settings) });
    this.workers.add(worker);
    worker.once('failure', () => this.workers.delete(worker));
    return worker;
  }

  async extensions(config = this.getConfig()) {
    try { return await discoverExtensions({ ...config, workdir: config.workdir || process.cwd() }); }
    catch { throw failure('Could not discover configured Pi extensions. Check Pi package and project configuration.', 503, 'extension_discovery_failed'); }
  }

  async capabilities() {
    const [probe, extensions] = await Promise.allSettled([this.check(), this.extensions()]);
    const snapshot = probe.status === 'fulfilled' ? probe.value : undefined;
    const config = this.getConfig();
    const tools = snapshot?.toolDetails?.length ? snapshot.toolDetails : (snapshot?.availableTools || []).map(name => ({
      name, description: '', active: snapshot.tools.includes(name), exposure: 'direct', ...toolPolicy(name, config.toolOverrides || {}),
    }));
    const errors = [probe.status === 'rejected' || !snapshot?.available ? snapshot?.error || 'Pi tool discovery is unavailable.' : null,
      extensions.status === 'rejected' ? 'Pi extension discovery is unavailable.' : null].filter(Boolean);
    return { tools, extensions: extensions.status === 'fulfilled' ? extensions.value : [], ...(errors.length ? { error: errors.join(' ') } : {}) };
  }

  async models() {
    const key = this.probeKey();
    if (this.modelsCache?.key === key && Date.now() - this.modelsCache.at < 10_000) return this.modelsCache.value.map(copyModel);
    if (this.modelsInFlight?.key === key) return (await this.modelsInFlight.promise).map(copyModel);
    const promise = this.enqueueProbe(() => this.performModels()).then((value) => {
      this.modelsCache = { key, at: Date.now(), value };
      return value;
    }).finally(() => { if (this.modelsInFlight?.promise === promise) this.modelsInFlight = null; });
    this.modelsInFlight = { key, promise };
    return (await promise).map(copyModel);
  }

  async performModels() {
    let worker;
    try {
      if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
      worker = await this.createWorker({ saveSessions: false });
      this.probeWorkers.add(worker);
      const data = await worker.send({ type: 'get_available_models' });
      return (data?.models || []).map((model) => ({
        id: `${model.provider}/${model.id}`,
        provider: model.provider,
        name: model.name || model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens ?? null,
        reasoning: Boolean(model.reasoning),
        // Same helper as Pi's get_available_thinking_levels RPC, without
        // changing its current model or writing its saved settings.
        reasoningEfforts: getSupportedThinkingLevels(model),
        input: Array.isArray(model.input) ? [...model.input] : [],
      }));
    } finally { await worker?.close(); this.probeWorkers.delete(worker); }
  }

  async acquire(options = {}) {
    if (this.closed) throw failure('Pi runtime is shutting down.', 503, 'runtime_closed');
    const config = this.getConfig();
    const id = options.sessionId || randomUUID();
    const existing = this.sessions.get(id);
    const settings = {
      model: options.model ?? existing?.settings.model ?? '',
      effort: options.effort ?? existing?.settings.effort ?? null,
      systemPrompt: options.systemPrompt || '',
      additionalSystemPrompt: config.additionalSystemPrompt ?? DEFAULT_ADDITIONAL_SYSTEM_PROMPT,
      workdir: config.workdir || process.cwd(),
      projectTrust: config.projectTrust || 'default',
      saveSessions: config.saveSessions === true,
      enableSkills: config.enableSkills === true,
      toolOverrides: canonicalOverrides(config.toolOverrides || {}),
      enableExtensions: config.enableExtensions !== false,
      extensionOverrides: canonicalOverrides(config.extensionOverrides || {}),
      managedConfig: localConfigKey(config),
    };
    if (this.retiredIds.has(id)) throw failure('This session has expired or was closed. Use a new session ID to start a conversation.', 409, 'session_expired');
    if (existing) {
      if (existing.busy) throw failure('This session is already processing a request.', 409, 'session_busy');
      if (existing.worker.closed) {
        this.retire(existing);
        throw failure('This Pi session has exited; start a new session.', 409, 'session_expired');
      }
      if (JSON.stringify(existing.settings) !== JSON.stringify(settings)) {
        throw failure('Model, provider credentials, search settings, effort, system prompt, working directory, project trust, session saving, Skills, tools, or extensions changed. Start a new session.', 409, 'session_configuration_changed');
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
      saveSessions: settings.saveSessions, sessionFile: null, enableSkills: settings.enableSkills,
      worker: null,
      run: (prompt, runOptions) => this.run(session, prompt, runOptions),
    };
    Object.defineProperties(session, {
      tools: { enumerable: true, get: () => session.worker?.snapshot().tools || [] },
      availableTools: { enumerable: true, get: () => session.worker?.snapshot().availableTools || [] },
      snapshot: { enumerable: true, get: () => session.worker?.snapshot() || { ...runtimeContext(settings.workdir, this.command), tools: [], availableTools: [] } },
    });
    this.sessions.set(id, session);
    try {
      session.worker = await this.createWorker(settings);
      if (this.sessions.get(id) !== session) throw failure('Pi session was closed during startup. Use a new session ID.', 409, 'session_expired');
      session.worker.on('failure', () => { this.retire(session); });
      const state = await session.worker.send({ type: 'get_state' });
      session.worker.assertMetadata();
      session.sessionFile = settings.saveSessions ? state?.sessionFile || null : null;
      if (settings.saveSessions && !session.sessionFile) throw failure('Pi did not enable session saving. Check its session storage configuration.', 502, 'session_persistence_unavailable');
      if (!state?.model) throw failure('Pi has no available model. Configure a provider with pi /login or its API-key environment variable.', 503, 'model_unavailable');
      session.model = `${state.model.provider}/${state.model.id}`;
      if (settings.model && session.model !== settings.model) throw failure(`Pi selected ${session.model} instead of the requested ${settings.model}. Use a model ID from /v1/models.`, 400, 'model_unavailable');
      const levels = await session.worker.send({ type: 'get_available_thinking_levels' });
      if (settings.effort !== null && levels?.levels && !levels.levels.includes(settings.effort)) throw failure(`This model does not support effort ${settings.effort}. Supported: ${levels.levels.join(', ')}.`, 400, 'unsupported_effort');
      if (settings.effort !== null && state.thinkingLevel !== settings.effort) throw failure('Pi did not apply the requested reasoning effort.', 502, 'effort_not_applied');
      this.logger?.log('info', 'Pi session created.', { sessionId: id, model: session.model, saveSessions: session.saveSessions, sessionFile: session.sessionFile, enableSkills: session.enableSkills });
      return session;
    } catch (error) {
      this.retire(session);
      await session.worker?.close();
      throw error;
    }
  }

  async run(session, prompt, { signal, onText, onReasoning, onToolEvent } = {}) {
    const worker = session.worker;
    let lastAssistant;
    let outputBytes = 0;
    let settledAborted = false;
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
      onRecord = (record) => {
        try {
          if (record.type === 'message_update') {
            const update = record.assistantMessageEvent;
            if (['text_delta', 'thinking_delta'].includes(update?.type) && update.delta) countOutput(update.delta);
          }
          if (record.type === 'message_end' && record.message?.role === 'assistant') {
            lastAssistant = record.message;
            const current = lastAssistant.usage;
            if (current) {
              usage.prompt_tokens += (current.input || 0) + (current.cacheRead || 0) + (current.cacheWrite || 0);
              usage.completion_tokens += current.output || 0;
              usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
            }
          }
          if (record.type === 'picall_failure') throw failure(record.code === 'turn_limit' ?
            'The request reached its configured tool-round limit.' : 'The request exceeded its deadline.',
          record.code === 'turn_limit' ? 422 : 504, record.code);
          if (record.type === 'tool_execution_start' || record.type === 'tool_execution_end') {
            const tool = toolNames([record.toolName])[0];
            if (tool) {
              this.logger?.log(record.isError ? 'warn' : 'info', `Pi ${record.type}.`, { sessionId: session.id, tool, isError: record.isError });
              onToolEvent?.({ tool, status: record.type === 'tool_execution_start' ? 'running' : record.isError ? 'failed' : 'completed' });
            }
          }
          if (record.type === 'agent_settled') { settledAborted = record.aborted === true; resolveRun(); }
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
      if (lastAssistant?.stopReason === 'error') throw failure('The model provider rejected or failed the request.', 502, 'provider_error');
      if (settledAborted || lastAssistant?.stopReason === 'aborted') throw failure('Pi aborted the request.', 499, 'request_cancelled');
      if (!lastAssistant || lastAssistant.stopReason !== 'stop' ||
          lastAssistant.content?.some(part => part.type === 'toolCall')) {
        throw failure(lastAssistant?.stopReason === 'length' ? 'The model exhausted its output limit before completing an answer.' :
          'Pi settled without a completed answer.', 502, lastAssistant?.stopReason === 'length' ? 'output_limit' : 'unanswered');
      }
      const text = (lastAssistant.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
      if (!text.trim()) throw failure('Pi settled without a completed text answer.', 502, 'unanswered');
      if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw failure('Pi output exceeded the 8 MiB request limit.', 502, 'output_limit');
      onText?.(text);
      return { text, usage, finishReason: 'stop' };
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
    return [...this.sessions.values()].map(({ id, model, busy, createdAt, lastUsedAt, tools, availableTools, saveSessions, sessionFile, enableSkills }) => ({ id, model, busy, createdAt, lastUsedAt, tools, availableTools, saveSessions, sessionFile, enableSkills }));
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
    this.sessions.clear();
    await Promise.all([...this.workers].map(worker => worker.close()));
  }
}
