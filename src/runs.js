import { mkdir, readdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUSES = new Set(['pending', 'running', ...TERMINAL]);
const MAX_RECORDS = 5000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const error = (message, status = 400, code = 'invalid_request') => Object.assign(new Error(message), { status, code });
const digest = value => createHash('sha256').update(value).digest('hex');
const storageError = () => error('Local task storage is unavailable. The task result could not be saved.', 507, 'storage_error');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function snapshot(record) {
  // The request, its fingerprint and the idempotency token never leave the store.
  const { id, sessionId, status, createdAt, updatedAt, model, completion, error: failure } = record;
  return structuredClone({ id, sessionId, status, createdAt, updatedAt,
    ...(model === undefined ? {} : { model }),
    ...(completion === undefined ? {} : { completion }), ...(failure === undefined ? {} : { error: failure }) });
}

function safeFailure(reason) {
  // Provider errors can contain URLs, request bodies and credentials. Keep a
  // machine-readable code, but use our own message rather than provider text.
  const code = typeof reason?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason.code) ? reason.code : 'run_failed';
  const messages = {
    request_cancelled: 'The task was cancelled.',
    request_timeout: 'The task exceeded its execution deadline.',
    turn_limit: 'The task exceeded its tool round limit.',
    model_unavailable: 'The configured model is unavailable.',
    model_not_found: 'The requested model is unavailable.',
    provider_error: 'The model provider rejected or failed the request.',
    process_interrupted: 'The local process stopped before the task completed. Submit a new task to retry.',
  };
  const localErrors = new Set(['invalid_request', 'unsupported_content', 'unsupported_parameter', 'unsupported_effort',
    'model_not_found', 'model_unavailable', 'session_history_conflict', 'session_configuration_changed', 'session_busy',
    'session_expired', 'session_limit', 'runtime_closed', 'output_limit']);
  const message = localErrors.has(code) && typeof reason?.message === 'string'
    ? reason.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024)
    : messages[code] || 'The task failed. Check the local operational logs.';
  const status = Number.isInteger(reason?.status) && reason.status >= 400 && reason.status <= 599
    ? reason.status : code === 'request_timeout' ? 504 : code === 'request_cancelled' ? 499 : 502;
  return { code, message, status, ...(localErrors.has(code) && typeof reason?.param === 'string'
    ? { param: reason.param.slice(0, 128) } : {}) };
}

/** Local asynchronous runs. Completed records survive restarts; Pi execution
 * itself does not resume after process termination. All state transitions share
 * one queue so cancellation, shutdown and late model results cannot overwrite
 * each other. HTTP waiters do not own the execution's AbortController. */
export class LocalRuns {
  constructor({ dataDir, execute, retentionDays = 7 } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || typeof execute !== 'function') throw new TypeError('LocalRuns requires dataDir and execute.');
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new TypeError('retentionDays must be positive.');
    this.directory = join(resolve(dataDir), 'runs');
    this.execute = execute;
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    this.records = new Map();
    this.keys = new Map();
    this.activeSessions = new Map();
    this.executions = new Map();
    this.waiters = new Map();
    this.queue = Promise.resolve();
    this.opening = null;
    this.closed = false;
  }

  locked(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  open() {
    if (!this.opening) this.opening = this.locked(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith('.json') || !RUN_ID.test(name.slice(0, -5))) continue;
        const raw = await readFile(join(this.directory, name), 'utf8');
        if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error('A saved task exceeds the storage limit.');
        let record;
        try { record = JSON.parse(raw); } catch { throw new Error('A saved task is not valid JSON.'); }
        if (!record || record.id !== name.slice(0, -5) || !SESSION_ID.test(record.sessionId) ||
            !STATUSES.has(record.status) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
            !SHA256.test(record.inputFingerprint) || (record.idempotencyHash !== undefined && !SHA256.test(record.idempotencyHash))) {
          throw new Error('A saved task has invalid metadata.');
        }
        if (!TERMINAL.has(record.status)) {
          record.status = 'failed';
          record.updatedAt = Date.now();
          record.error = safeFailure({ code: 'process_interrupted' });
          delete record.completion;
          await this.persist(record);
        }
        this.records.set(record.id, record);
        if (record.idempotencyHash) this.keys.set(record.idempotencyHash, record.id);
      }
      await this.cleanup();
      return this;
    });
    return this.opening;
  }

  async persist(record) {
    const file = join(this.directory, `${record.id}.json`);
    const temporary = join(this.directory, `${record.id}.${randomUUID()}.tmp`);
    const encoded = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw error('Task result exceeded the storage limit.', 502, 'output_limit');
    try {
      await writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } catch (failure) {
      await unlink(temporary).catch(() => {});
      throw failure;
    }
  }

  async cleanup() {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, record] of this.records) {
      if (!TERMINAL.has(record.status) || record.updatedAt >= cutoff) continue;
      await unlink(join(this.directory, `${id}.json`)).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
      this.records.delete(id);
      if (record.idempotencyHash && this.keys.get(record.idempotencyHash) === id) this.keys.delete(record.idempotencyHash);
    }
  }

  identity(input, { sessionId, idempotencyKey }) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('The task input must be an object.');
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw error('Invalid session ID.');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(idempotencyKey))) throw error('Idempotency-Key must contain 1–256 visible ASCII characters.');
    return { inputFingerprint: digest(JSON.stringify(canonical(input))),
      idempotencyHash: idempotencyKey === undefined ? undefined : digest(idempotencyKey) };
  }

  previous({ inputFingerprint, idempotencyHash }, sessionId) {
    if (!idempotencyHash || !this.keys.has(idempotencyHash)) return undefined;
    const record = this.records.get(this.keys.get(idempotencyHash));
    if (TERMINAL.has(record.status) && record.updatedAt < Date.now() - this.retentionMs) return undefined;
    if (record.inputFingerprint !== inputFingerprint || (sessionId !== undefined && sessionId !== record.sessionId)) {
      throw error('This Idempotency-Key was already used with different input or session.', 409, 'idempotency_conflict');
    }
    return snapshot(record);
  }

  async lookup(input, { sessionId, idempotencyKey } = {}) {
    if (idempotencyKey === undefined) return undefined;
    await this.open();
    return this.locked(() => this.previous(this.identity(input, { sessionId, idempotencyKey }), sessionId));
  }

  async submit(input, { sessionId, idempotencyKey, identityInput = input } = {}) {
    await this.open();
    return this.locked(async () => {
      if (this.closed) throw error('The task store is shutting down.', 503, 'unavailable');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('The task input must be an object.');
      const identity = this.identity(identityInput, { sessionId, idempotencyKey });
      const { inputFingerprint, idempotencyHash } = identity;
      await this.cleanup();
      const previous = this.previous(identity, sessionId);
      if (previous) return previous;
      if (this.records.size >= MAX_RECORDS) throw error('Local task storage is at capacity. Remove expired tasks before submitting more.', 503, 'run_limit');
      const selectedSession = sessionId || randomUUID();
      if (this.activeSessions.has(selectedSession)) throw error('This session is already processing a task.', 409, 'session_busy');
      const now = Date.now();
      const record = { id: `${selectedSession}~${randomUUID()}`, sessionId: selectedSession, status: 'pending', createdAt: now,
        updatedAt: now, inputFingerprint, ...(typeof input.model === 'string' ? { model: input.model } : {}),
        ...(idempotencyHash ? { idempotencyHash } : {}) };
      const request = structuredClone(input);
      try { await this.persist(record); }
      catch { throw storageError(); }
      this.records.set(record.id, record);
      if (idempotencyHash) this.keys.set(idempotencyHash, record.id);
      this.activeSessions.set(selectedSession, record.id);
      const controller = new AbortController();
      const execution = { controller, promise: null };
      this.executions.set(record.id, execution);
      // Schedule only after the accepted state is on disk. The execution never
      // extends the admission lock across a model or external HTTP request.
      execution.promise = this.start(record.id, request, execution).catch(() =>
        this.locked(() => this.storageFailure(record.id)));
      return snapshot(record);
    });
  }

  async start(id, input, execution) {
    let admitted = false;
    try {
      await this.locked(async () => {
        const record = this.records.get(id);
        if (!record || TERMINAL.has(record.status) || this.closed) return;
        const next = { ...record, status: 'running', updatedAt: Date.now() };
        try { await this.persist(next); }
        catch {
          this.storageFailure(id);
          throw storageError();
        }
        this.records.set(id, next);
        admitted = true;
      });
      if (!admitted) return;
      const completion = await this.execute(input, { signal: execution.controller.signal,
        sessionId: this.records.get(id).sessionId, runId: id });
      await this.finish(id, 'completed', { completion });
    } catch (failure) {
      await this.finish(id, 'failed', { error: safeFailure(failure) });
    } finally {
      if (this.executions.get(id) === execution) this.executions.delete(id);
    }
  }

  publish(record) {
    this.records.set(record.id, record);
    if (TERMINAL.has(record.status)) {
      this.activeSessions.delete(record.sessionId);
      const view = snapshot(record);
      for (const resolve of this.waiters.get(record.id) || []) resolve(structuredClone(view));
      this.waiters.delete(record.id);
      return view;
    }
    return snapshot(record);
  }

  storageFailure(id) {
    const previous = this.records.get(id);
    if (!previous || TERMINAL.has(previous.status)) return previous && snapshot(previous);
    const failed = { ...previous, status: 'failed', updatedAt: Date.now(),
      error: { code: 'storage_error', status: 507, message: storageError().message } };
    delete failed.completion;
    const view = this.publish(failed);
    this.executions.get(id)?.controller.abort();
    // Disk may still contain pending/running. On restart it will be reported as
    // process_interrupted; a live caller must never wait forever for that file.
    return view;
  }

  async terminal(id, status, result) {
    const previous = this.records.get(id);
    if (!previous || TERMINAL.has(previous.status)) return previous && snapshot(previous);
    const next = { ...previous, status, ...result, updatedAt: Date.now() };
    try { await this.persist(next); }
    catch {
      this.storageFailure(id);
      throw storageError();
    }
    return this.publish(next);
  }

  finish(id, status, result) {
    return this.locked(() => this.terminal(id, status, result));
  }

  async get(id) {
    await this.open();
    return this.locked(() => {
      if (typeof id !== 'string' || !RUN_ID.test(id) || !this.records.has(id)) throw error('Task not found.', 404, 'run_not_found');
      return snapshot(this.records.get(id));
    });
  }

  async cancel(id) {
    await this.get(id);
    try { return await this.finish(id, 'cancelled', { error: safeFailure({ code: 'request_cancelled' }) }); }
    finally { this.executions.get(id)?.controller.abort(); }
  }

  async wait(id, { signal } = {}) {
    await this.open();
    signal?.throwIfAborted();
    let stop;
    let abort;
    const result = new Promise((resolve, reject) => {
      stop = resolve;
      abort = () => reject(signal.reason || error('Waiting was cancelled.', 499, 'request_cancelled'));
    });
    // Install both the terminal-state read and listener while holding the same
    // lock as finish(), so a completion cannot be lost between them.
    await this.locked(() => {
      if (!this.records.has(id)) throw error('Task not found.', 404, 'run_not_found');
      const record = this.records.get(id);
      if (TERMINAL.has(record.status)) { stop(snapshot(record)); return; }
      let listeners = this.waiters.get(id);
      if (!listeners) this.waiters.set(id, listeners = new Set());
      listeners.add(stop);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await result; }
    finally {
      signal?.removeEventListener('abort', abort);
      const listeners = this.waiters.get(id);
      listeners?.delete(stop);
      if (!listeners?.size) this.waiters.delete(id);
    }
  }

  async close() {
    await this.open();
    await this.locked(async () => {
      if (this.closed) return;
      this.closed = true;
      let failure;
      for (const record of this.records.values()) {
        if (!TERMINAL.has(record.status)) {
          try { await this.terminal(record.id, 'failed', { error: safeFailure({ code: 'process_interrupted' }) }); }
          catch { failure = storageError(); }
        }
      }
      for (const execution of this.executions.values()) execution.controller.abort();
      if (failure) throw failure;
    });
    // An arbitrary execute implementation might ignore AbortSignal. The task
    // record is already terminal; such a late result cannot replace it.
  }
}
