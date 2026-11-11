import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod, readdir, readFile, rm, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appError } from './config.js';

export const terminal = run => ['completed', 'failed', 'cancelled'].includes(run.status);
export const digest = value => createHash('sha256').update(value).digest('hex');
import { canonical } from '../../../packages/core/identity.js';
export { canonical } from '../../../packages/core/identity.js';
export const fingerprint = input => digest(JSON.stringify(canonical(input)));
export const publicRun = run => structuredClone(Object.fromEntries(Object.entries(run).filter(([key]) =>
  ['id', 'sessionId', 'status', 'createdAt', 'updatedAt', 'model', 'completion', 'error', 'elapsed_ms', 'service_calls', 'usage', 'timings'].includes(key))));
export const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const runPattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
const TTL = 7 * 86400000;

export class RunIndex {
  constructor(dataDir) { this.directory = resolve(dataDir); this.closed = false; }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, 'sessions'), { recursive: true, mode: 0o700 });
    // A separate rollback-journal SQLite transaction is an OS-released lifetime
    // lock. A killed process cannot leave a stale PID lock or a live second writer.
    const lockPath = join(this.directory, '.writer.sqlite');
    const file = await open(lockPath, 'a', 0o600); await file.close(); await chmod(lockPath, 0o600);
    try {
      this.lock = new DatabaseSync(lockPath);
      this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch {
      this.lock?.close(); this.lock = null;
      throw appError('Another PiCall process owns this data directory.', 409, 'data_dir_locked');
    }
    try {
      const path = join(this.directory, 'index.sqlite');
      const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600);
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, key_hash TEXT UNIQUE, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);`);
      const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema-version');
      if (version && version.value !== '1') throw appError('Unsupported task index schema version.', 507, 'storage_version_mismatch');
      this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('schema-version', '1');
      await this.importLegacy();
    } catch (error) { this.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { const row = this.db.prepare('SELECT value FROM runs WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; }
  session(id) { const row = this.db.prepare('SELECT value FROM sessions WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; }
  sessions() { return this.db.prepare('SELECT value FROM sessions').all().map(row => JSON.parse(row.value)); }
  all() { return this.db.prepare('SELECT value FROM runs').all().map(row => JSON.parse(row.value)); }
  active(sessionId) { return this.db.prepare('SELECT value FROM runs WHERE session_id=?').all(sessionId).map(row => JSON.parse(row.value)).find(run => !terminal(run)); }
  put(run) {
    this.db.prepare('INSERT INTO runs(id,session_id,key_hash,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(run.id, run.sessionId, run.keyHash || null, JSON.stringify(run));
  }
  putSession(session) {
    this.db.prepare('INSERT INTO sessions(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(session.id, JSON.stringify(session));
  }
  lookup(input, { sessionId, idempotencyKey } = {}) {
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionPattern.test(sessionId))) throw appError('Invalid session ID.');
    if (idempotencyKey === undefined) return undefined;
    if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(idempotencyKey)) throw appError('Invalid Idempotency-Key.');
    const row = this.db.prepare('SELECT value FROM runs WHERE key_hash=?').get(digest(idempotencyKey));
    if (!row) return undefined;
    const run = JSON.parse(row.value);
    if (terminal(run) && run.updatedAt < Date.now() - TTL) return undefined;
    if (run.fingerprint !== fingerprint(input) || (sessionId !== undefined && run.sessionId !== sessionId)) throw appError('This Idempotency-Key was used with different input or session.', 409, 'idempotency_conflict');
    return run;
  }
  stage(input, identity, options, configHash, timeoutMs) {
    return this.transaction(() => {
      const previous = this.lookup(identity, options);
      if (previous) return { run: previous, duplicate: true };
      if (this.all().length >= 5000) throw appError('Local task storage is at capacity.', 503, 'run_limit');
      const sessionId = options.sessionId || randomUUID();
      if (!sessionPattern.test(sessionId)) throw appError('Invalid session ID.');
      if (this.active(sessionId)) throw appError('This session is processing a task.', 409, 'session_busy');
      const existing = this.session(sessionId);
      if (existing?.retired || existing?.legacy) throw appError('This session has expired. Start a new session.', 409, 'session_expired');
      if (existing && existing.configHash !== configHash) throw appError('Execution configuration changed. Start a new session.', 409, 'session_configuration_changed');
      const now = Date.now();
      const run = { id: `${sessionId}~${randomUUID()}`, sessionId, model: input.model, status: 'pending', createdAt: now, updatedAt: now,
        deadline: now + timeoutMs, configHash, fingerprint: fingerprint(identity), input: structuredClone(input),
        ...(options.idempotencyKey === undefined ? {} : { keyHash: digest(options.idempotencyKey) }) };
      this.putSession(existing || { id: sessionId, configHash, createdAt: now, lastUsedAt: now, model: input.model });
      this.put(run);
      return { run, duplicate: false };
    });
  }
  async importLegacy() {
    if (this.db.prepare('SELECT value FROM meta WHERE key=?').get('legacy-v1')) return;
    let names = [];
    try { names = await readdir(join(this.directory, 'runs')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !runPattern.test(name.slice(0, -5))) continue;
      const raw = await readFile(join(this.directory, 'runs', name), 'utf8');
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw appError('Legacy task exceeds the storage limit.', 507, 'migration_failed');
      let old;
      try { old = JSON.parse(raw); } catch { throw appError('Legacy task is invalid JSON.', 507, 'migration_failed'); }
      if (old.id !== name.slice(0, -5) || !sessionPattern.test(old.sessionId) || !Number.isFinite(old.updatedAt)) throw appError('Legacy task metadata is invalid.', 507, 'migration_failed');
      records.push({ ...old, fingerprint: old.inputFingerprint, keyHash: old.idempotencyHash, legacy: true,
        ...(!terminal(old) ? { status: 'failed', error: { code: 'process_interrupted', status: 502, message: 'The legacy Pi task has no Durable checkpoint. Submit a new task.' } } : {}) });
    }
    this.transaction(() => {
      for (const run of records) {
        if (!this.get(run.id)) this.put(run);
        if (!this.session(run.sessionId)) this.putSession({ id: run.sessionId, legacy: true, retired: true, createdAt: run.createdAt, lastUsedAt: run.updatedAt, model: run.model });
      }
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('legacy-v1', 'complete');
    });
  }
  async cleanup(closeSession) {
    const cutoff = Date.now() - TTL;
    for (const session of this.sessions()) {
      if (session.lastUsedAt >= cutoff || this.active(session.id)) continue;
      await closeSession(session.id);
      const path = join(this.directory, 'sessions', digest(session.id) + '.sqlite');
      for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
      this.transaction(() => {
        this.db.prepare('DELETE FROM runs WHERE session_id=?').run(session.id);
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
      });
    }
    this.transaction(() => {
      for (const run of this.all()) if (terminal(run) && run.updatedAt < cutoff) this.db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } finally { this.lock?.close(); }
  }
}
