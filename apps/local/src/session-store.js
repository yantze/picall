import { DatabaseSync } from 'node:sqlite';
import { chmod, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { digest } from './run-index.js';
import { appError } from './config.js';
import { itemQuery, itemPage } from '../../../packages/core/session-items.js';

// Pi Durable 1.5 schema versions 1 and 2 have the same columns. Version 2 only
// widens a task status constraint. Keep the target's current schema version.
const tables = ['durable_metadata', 'record_ids', 'conversations', 'entries', 'tasks', 'submissions', 'documents', 'document_revisions'];
const prefixFor = id => `s_${digest(id)}_`;

export class SessionStore {
  constructor(directory) { this.directory = directory; }
  async open(sessions) {
    const path = join(this.directory, 'sessions.sqlite');
    const file = await open(path, 'a', 0o600); await file.close(); await chmod(path, 0o600);
    this.db = await openNodeSqliteDatabase(path);
    await this.db.exec('PRAGMA synchronous=FULL');
    await this.db.exec('CREATE TABLE IF NOT EXISTS session_namespaces (session_id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, migrated INTEGER NOT NULL)');
    // One adapter owns the connection and serializes transactions across all
    // Harnesses. Closing a borrowed storage must never close that connection.
    this.borrowed = Object.fromEntries(['exec', 'run', 'get', 'all', 'runCounted', 'transaction'].map(name => [name, (...args) => this.db[name](...args)]));
    this.borrowed.close = async () => {};
    for (const session of sessions) if (!session.legacy) await this.ensure(session.id);
  }
  async ensure(id) {
    const prefix = prefixFor(id);
    if (await this.db.get('SELECT 1 FROM session_namespaces WHERE session_id=?', id)) return prefix;
    const path = join(this.directory, 'sessions', digest(id) + '.sqlite');
    let legacy;
    try { await stat(path); legacy = new DatabaseSync(path, { readOnly: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      if (legacy) {
        legacy.exec('BEGIN');
        if (!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()) {
          // The old process can die after creating the file but before schema initialization.
          legacy.close(); legacy = undefined;
        } else {
          const version = legacy.prepare('SELECT version FROM pi_durable_schema').get()?.version;
          if (![1, 2].includes(version)) throw appError('Unsupported legacy session schema.', 507, 'storage_version_mismatch');
        }
      }
      const storage = await SqliteStorage.open(this.borrowed, { prefix });
      await storage.close(BG);
      await this.db.transaction(async tx => {
        if (legacy) {
          for (const table of tables) {
            await tx.run(`DELETE FROM ${prefix}${table}`);
            const columns = legacy.prepare(`PRAGMA table_info(pi_${table})`).all().map(column => column.name);
            if (!columns.length || columns.some(column => !/^[a-z_]+$/.test(column))) throw appError('Invalid legacy session schema.', 507, 'migration_failed');
            const insert = `INSERT INTO ${prefix}${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
            for (const row of legacy.prepare(`SELECT * FROM pi_${table}`).iterate()) await tx.run(insert, ...columns.map(column => row[column]));
          }
        }
        // Committed with the data. Interrupted migrations are safely retryable;
        // once marked, retained legacy backups are never imported again.
        await tx.run('INSERT INTO session_namespaces(session_id,prefix,migrated) VALUES(?,?,?)', id, prefix, legacy ? 1 : 0);
      });
    } finally { legacy?.close(); }
    return prefix;
  }
  async openSession(id) {
    const prefix = await this.ensure(id);
    // Reopen after migration to load the imported next_id/next_seq counters.
    return SqliteStorage.open(this.borrowed, { prefix });
  }
  async items(id, page, config) {
    // Inspection does not instantiate or resume a Harness.
    if (!await this.db.get('SELECT 1 FROM session_namespaces WHERE session_id=?', id)) return { items: [], nextCursor: null };
    const rows = await this.db.all(itemQuery(prefixFor(id)), page.after, page.limit + 1);
    return itemPage(rows, page, config);
  }
  async remove(id) {
    const prefix = prefixFor(id);
    await this.db.transaction(async tx => {
      for (const table of [...tables, 'durable_schema']) await tx.run(`DROP TABLE IF EXISTS ${prefix}${table}`);
      await tx.run('DELETE FROM session_namespaces WHERE session_id=?', id);
    });
  }
  async close() { if (this.db) { const db = this.db; this.db = null; await db.close(); } }
}
