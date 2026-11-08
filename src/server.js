import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appError, EFFORTS } from './config.js';
import { VERSION } from './version.js';
import { LocalRuns } from './runs.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function errorBody(error) {
  const status = error.status || 502;
  return { error: { message: status >= 500 && !error.code ? 'Internal service error. See operational logs.' : error.message,
    type: status === 401 ? 'authentication_error' : status < 500 ? 'invalid_request_error' : 'api_error',
    param: error.param ?? null, code: error.code || 'internal_error' } };
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw appError('Content-Type must be application/json.', 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw appError('Request body exceeds 1 MiB.', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw appError('Request body must be a JSON object.'); }
}
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => p?.type === 'text' && typeof p.text === 'string')) return content.map(p => p.text).join('\n');
  throw appError('Only text message content is supported.', 400, 'unsupported_content');
}
function normalize(input) {
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 500) throw appError('messages must contain 1–500 messages.');
  const messages = [];
  const system = [];
  for (const message of input.messages) {
    if (!message || !['user', 'assistant', 'system', 'developer'].includes(message.role) || message.tool_calls || message.function_call) throw appError('Supported message roles: system, developer, user, assistant. Pi manages tools internally.');
    const content = textContent(message.content);
    if (message.role === 'system' || message.role === 'developer') system.push(content);
    else messages.push({ role: message.role, content });
  }
  if (messages.at(-1)?.role !== 'user' || !messages.at(-1).content.trim()) throw appError('The final message must be a nonempty user message.');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') throw appError('stream must be a boolean.');
  if (input.n !== undefined && input.n !== 1) throw appError('Only n=1 is supported.');
  // Pi RPC does not expose per-prompt sampling controls. Accept the OpenAI
  // temperature field for client compatibility, keeping Pi's model defaults.
  if (input.temperature !== undefined && input.temperature !== null &&
      (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
    throw appError('temperature must be a number between 0 and 2, or null.', 400, 'invalid_request', 'temperature');
  }
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'response_format', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'logprobs', 'top_logprobs', 'seed', 'presence_penalty', 'frequency_penalty', 'context_window', 'contextWindow']) {
    if (input[key] !== undefined && input[key] !== null) throw appError(`${key} is not supported by the Pi RPC gateway.`, 400, 'unsupported_parameter', key);
  }
  if (input.reasoning_effort !== undefined && input.reasoning_effort !== null && input.reasoning_effort !== 'none' && !EFFORTS.includes(input.reasoning_effort)) throw appError('Unsupported reasoning_effort.');
  if (input.stream_options !== undefined && (!input.stream_options || typeof input.stream_options !== 'object' || Array.isArray(input.stream_options) || Object.keys(input.stream_options).some(k => k !== 'include_usage') || (input.stream_options.include_usage !== undefined && typeof input.stream_options.include_usage !== 'boolean'))) throw appError('Only stream_options.include_usage (boolean) is supported.');
  return { messages, systemPrompt: system.join('\n\n'), hasSystemPrompt: system.length > 0 };
}
const messageHash = message => createHash('sha256').update(JSON.stringify(message)).digest('hex');
function openAIModel(model) {
  return { id: model.id, object: 'model', created: 0, owned_by: model.provider,
    name: model.name, context_window: model.contextWindow ?? null, max_output_tokens: model.maxTokens,
    reasoning: model.reasoning, supported_reasoning_efforts: model.reasoningEfforts, input_modalities: model.input };
}
function promptFor(messages) {
  if (messages.length === 1) return messages[0].content;
  return 'Continue this conversation. Previous messages are provided as context:\n\n' + messages.map(m => `<${m.role}>\n${m.content}\n</${m.role}>`).join('\n\n');
}
function safeHost(req) {
  try {
    const u = new URL(`http://${req.headers.host}`);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  return req.headers.origin === `http://${req.headers.host}`;
}
function authorized(req, apiKey) {
  if (!apiKey) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApp({ configStore, runtime, logger }) {
  const started = Date.now();
  const metrics = { total: 0, active: 0, failed: 0 };
  const conversations = new Map();
  const connections = new Set();
  const logClients = new Set();
  let closing = false;
  const runs = new LocalRuns({ dataDir: configStore.dataDir, execute: executeCompletion });
  const ready = runs.open();
  // Route handlers await startup too, so corrupt persisted state fails visibly.
  ready.catch(() => {});
  async function prepare(input) {
    normalize(input);
    if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim())) throw appError('model must be a nonempty model ID.', 400, 'invalid_request', 'model');
    const requested = input.model || configStore.value.defaultModel;
    const models = await runtime.models();
    const exact = models.find(model => model.id === requested);
    const managed = models.find(model => model.id === `picall/${requested}`);
    const selected = input.model === undefined ? managed || exact : exact || managed;
    if (!selected) throw appError(`Model is unavailable: ${requested}. Configure the model gateway in the local settings page, or use /v1/models.`, 404, 'model_not_found', 'model');
    const effort = input.reasoning_effort === 'none' ? 'off' : input.reasoning_effort ?? undefined;
    if (effort !== undefined && !selected.reasoningEfforts.includes(effort)) throw appError(`This model does not support reasoning_effort ${effort}. Supported: ${selected.reasoningEfforts.join(', ')}.`, 400, 'unsupported_effort', 'reasoning_effort');
    return { ...input, model: selected.id };
  }
  async function submit(input, options) {
    normalize(input);
    const previous = await runs.lookup(input, options);
    if (previous) return previous;
    return runs.submit(await prepare(input), { ...options, identityInput: input });
  }
  async function executeCompletion(input, { signal, sessionId, runId }) {
    const normalized = normalize(input);
    const liveIds = new Set(runtime.list().map(session => session.id));
    for (const id of conversations.keys()) if (!liveIds.has(id)) conversations.delete(id);
    const previous = conversations.get(sessionId);
    let promptMessages = normalized.messages;
    const systemPrompt = normalized.hasSystemPrompt ? normalized.systemPrompt : previous?.systemPrompt || '';
    if (previous && normalized.messages.length > 1) {
      const prefix = normalized.messages.slice(0, previous.count).map(messageHash);
      if (normalized.messages.length !== previous.count + 1 || JSON.stringify(prefix) !== JSON.stringify(previous.hashes)) throw appError('Session history does not match. Send only the next user message or the unchanged full history; use a new X-Session-Id to branch.', 409, 'session_history_conflict');
      promptMessages = normalized.messages.slice(previous.count);
    }
    const session = await runtime.acquire({ sessionId, model: input.model, systemPrompt, effort: input.reasoning_effort === 'none' ? 'off' : input.reasoning_effort ?? undefined });
    const created = Math.floor(Date.now() / 1000);
    logger.log('info', 'Completion started', { requestId: runId, sessionId, model: session.model });
    const result = await session.run(promptFor(promptMessages), { signal });
    const newMessages = [...(previous ? promptMessages : normalized.messages), { role: 'assistant', content: result.text }];
    const hashes = [...(previous?.hashes || []), ...newMessages.map(messageHash)].slice(0, 500);
    conversations.set(session.id, { hashes, count: (previous?.count || 0) + newMessages.length, systemPrompt });
    logger.log('info', 'Completion finished', { requestId: runId, sessionId, usage: result.usage });
    return { id: runId, object: 'chat.completion', created, model: session.model || input.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: result.finishReason || 'stop' }], usage: result.usage };
  }
  function admissionOptions(req) {
    const sessionId = req.headers['x-session-id'];
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId))) throw appError('X-Session-Id must be 1–128 letters, digits, dots, underscores, or hyphens.');
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(idempotencyKey))) throw appError('Idempotency-Key must contain 1–256 visible ASCII characters.');
    return { sessionId, idempotencyKey };
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      await ready;
      if (!safeHost(req)) throw appError('Untrusted Host header.', 403, 'forbidden');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      if (closing) throw appError('Service is shutting down.', 503, 'unavailable');
      if (path.startsWith('/api/') || assets.has(path)) {
        if (!sameOrigin(req)) throw appError('Cross-origin management access is forbidden.', 403, 'forbidden');
      }
      if (path.startsWith('/v1/')) {
        if (!sameOrigin(req) && !configStore.value.apiKey) throw appError('Set an API key before enabling cross-origin API requests.', 403, 'forbidden');
        if (req.headers.origin) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Session-Id, Idempotency-Key');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id, X-Run-Id');
        }
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (!authorized(req, configStore.value.apiKey)) throw appError('Invalid or missing API key.', 401, 'invalid_api_key');
      }
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok', version: VERSION });
      if (req.method === 'GET' && assets.has(path)) {
        const [file, mime] = assets.get(path);
        const content = await readFile(publicDir + file);
        res.writeHead(200, { 'Content-Type': mime }); res.end(content); return;
      }
      if (path === '/api/config' && req.method === 'GET') return json(res, 200, configStore.public());
      if (path === '/api/config' && req.method === 'PUT') {
        const patch = await body(req);
        const result = await configStore.update(patch);
        logger.log('info', 'Settings saved', { fields: Object.keys(patch) });
        return json(res, 200, result);
      }
      if (path === '/api/key' && req.method === 'POST') return json(res, 200, { apiKey: `pc-${randomBytes(24).toString('base64url')}` });
      if (path === '/api/status' && req.method === 'GET') {
        const pi = await runtime.check();
        const sessions = runtime.list();
        const { workdir, projectTrust, saveSessions, enableSkills, enableExtensions } = configStore.value;
        return json(res, 200, { version: VERSION, uptime: Math.floor((Date.now() - started) / 1000), pi,
          sessions: { total: sessions.length, busy: sessions.filter(s => s.busy).length }, requests: metrics,
          config: { workdir, projectTrust, saveSessions, enableSkills, enableExtensions }, authRequired: Boolean(configStore.value.apiKey) });
      }
      if (path === '/api/models' && req.method === 'GET') {
        try { return json(res, 200, { models: await runtime.models() }); }
        catch (error) { return json(res, 200, { models: [], error: error.message }); }
      }
      if (path === '/api/capabilities' && req.method === 'GET') return json(res, 200, await runtime.capabilities());
      if (path === '/v1/models' && req.method === 'GET') {
        const models = await runtime.models();
        return json(res, 200, { object: 'list', data: models.map(openAIModel) });
      }
      if (path.startsWith('/v1/models/') && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(path.slice('/v1/models/'.length)); }
        catch { throw appError('Invalid model ID.'); }
        const model = (await runtime.models()).find(model => model.id === id);
        if (!model) throw appError(`Model is unavailable: ${id}. Use /v1/models to discover models configured in Pi.`, 404, 'model_not_found', 'model');
        return json(res, 200, openAIModel(model));
      }
      if (path === '/api/sessions' && req.method === 'GET') return json(res, 200, { sessions: runtime.list() });
      if (path.startsWith('/api/sessions/') && req.method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/api/sessions/'.length));
        await runtime.closeSession(id); conversations.delete(id);
        return json(res, 200, { deleted: true });
      }
      if (path === '/api/logs' && req.method === 'GET') return json(res, 200, { logs: logger.history() });
      if (path === '/api/logs/stream' && req.method === 'GET') {
        if (logClients.size >= 20) throw appError('Too many log streams.', 429, 'rate_limit');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n'); logClients.add(res);
        const listener = item => { if (!res.destroyed && !res.write(`event: log\ndata: ${JSON.stringify(item)}\n\n`)) res.destroy(); };
        logger.on('log', listener);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); logger.off('log', listener); logClients.delete(res); });
        return;
      }
      const runRoute = /^\/v1\/runs\/([^/]+)(\/cancel)?$/.exec(path);
      if (runRoute && req.method === 'GET' && !runRoute[2]) return json(res, 200, await runs.get(runRoute[1]));
      if (runRoute && req.method === 'POST' && runRoute[2]) return json(res, 200, await runs.cancel(runRoute[1]));
      if (path === '/v1/runs' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw appError('prompt must be nonempty text.');
        const input = { messages: [{ role: 'user', content: data.prompt }], ...(data.model === undefined ? {} : { model: data.model }) };
        const run = await submit(input, admissionOptions(req));
        res.setHeader('X-Session-Id', run.sessionId);
        res.setHeader('X-Run-Id', run.id);
        res.setHeader('Location', `/v1/runs/${run.id}`);
        return json(res, 202, run);
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        metrics.total++; metrics.active++;
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', disconnect);
        let heartbeat;
        let requestId;
        try {
          const input = await body(req);
          normalize(input);
          // Stream preference does not change the durable task identity.
          const { stream, stream_options, ...task } = input;
          const run = await submit(task, admissionOptions(req));
          requestId = run.id;
          res.setHeader('X-Session-Id', run.sessionId);
          res.setHeader('X-Run-Id', run.id);
          const created = Math.floor(Date.now() / 1000);
          const chunk = (delta, finishReason = null, usage) => ({ id: requestId, object: 'chat.completion.chunk', created, model: run.model || run.completion?.model || input.model,
            choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
          if (stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
            heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          }
          const finished = await runs.wait(run.id, { signal: controller.signal });
          if (finished.status !== 'completed') throw Object.assign(new Error(finished.error?.message || 'Run did not complete.'), { code: finished.error?.code || 'run_failed', status: finished.error?.status || 502, param: finished.error?.param });
          const result = finished.completion;
          if (stream) {
            res.write(`data: ${JSON.stringify(chunk({ content: result.choices[0].message.content }))}\n\n`);
            res.write(`data: ${JSON.stringify(chunk({}, result.choices[0].finish_reason))}\n\n`);
            if (stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created, model: result.model, choices: [], usage: result.usage })}\n\n`);
            res.end('data: [DONE]\n\n');
          } else json(res, 200, result);
        } catch (error) {
          metrics.failed++;
          logger.log('warn', 'Completion failed', { requestId, code: error.code || 'internal_error', status: error.status || 502 });
          if (!res.destroyed) {
            if (res.headersSent) { res.write(`data: ${JSON.stringify(errorBody(error))}\n\n`); res.end('data: [DONE]\n\n'); }
            else json(res, error.status || 502, errorBody(error));
          }
        } finally { clearInterval(heartbeat); res.off('close', disconnect); metrics.active--; }
        return;
      }
      throw appError('Route not found.', 404, 'not_found');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, errorBody(error));
      else res.end();
    }
  });
  server.requestTimeout = 15000; // Receive request body; Pi execution has its own timeout.
  server.headersTimeout = 10000;
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  async function close() {
    if (closing) return;
    closing = true;
    for (const res of logClients) res.end();
    let shutdownError;
    try { await runs.close(); } catch (error) { shutdownError = error; }
    try { await runtime.close(); } catch (error) { shutdownError ||= error; }
    await new Promise(resolve => {
      server.close(resolve);
      for (const socket of connections) socket.destroy();
    });
    if (shutdownError) throw shutdownError;
  }
  return { server, close, ready };
}
