import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DurableRuntime } from '../src/durable-runtime.js';
import { SessionStore } from '../src/session-store.js';
import { ConfigStore } from '../src/config.js';
import { digest } from '../src/run-index.js';
import { setup, completion, mockServices, until } from './helpers.mjs';

test('concurrent sessions share one database; eviction, read-only details, paging and TTL remain isolated', async t => {
  const f = await setup(t);
  f.services.delay = 150;
  const a = await f.runtime.submit(completion('FIRST-SESSION'), { sessionId: 'first' });
  const b = await f.runtime.submit(completion('SECOND-SESSION'), { sessionId: 'second' });
  const running = await (await f.request('/api/sessions/second')).json();
  assert.equal(running.session.busy, true);
  await f.runtime.wait(a.id);
  await f.runtime.closeSession('first');
  assert.equal((await f.runtime.wait(b.id)).status, 'completed');
  assert.deepEqual(await readdir(join(f.dataDir, 'sessions')), []);
  assert.ok((await readdir(f.dataDir)).includes('sessions.sqlite'));
  await f.runtime.evict('second');
  const count = f.services.requests.length;
  const result = await (await f.request('/api/sessions/second')).json();
  assert.equal(f.runtime.handles.has('second'), false);
  assert.equal(f.services.requests.length, count);
  assert.match(JSON.stringify(result.items), /SECOND-SESSION/);
  assert.doesNotMatch(JSON.stringify(result.items), /FIRST-SESSION/);
  assert.ok(result.items.some(item => item.durationMs !== null && item.endedAt >= item.startedAt));
  assert.ok(result.items.every(item => item.timestamp > 0));
  const pages = []; let after = 0;
  do {
    const page = await (await f.request(`/api/sessions/second?limit=2&after=${after}`)).json();
    pages.push(...page.items); after = page.nextCursor;
  } while (after !== null);
  assert.deepEqual(pages, result.items);
  assert.equal((await f.request('/api/sessions/second?limit=101')).status, 400);
  assert.equal((await f.request('/api/sessions/second?after=-1')).status, 400);
  assert.equal((await f.request('/api/sessions/second?after=1e2')).status, 400);
  assert.equal((await f.request('/api/sessions/%ZZ')).status, 400);
  assert.equal((await f.request('/api/sessions/unknown')).status, 404);
  assert.equal((await f.request('/api/sessions/second', { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await f.request('/sessions/second')).status, 200);
  const old = Date.now() - 8 * 86400000;
  f.runtime.index.putSession({ ...f.runtime.index.session('first'), lastUsedAt: old });
  await f.runtime.index.cleanup(id => f.runtime.removeSession(id));
  assert.equal((await f.request('/api/sessions/first')).status, 404);
  assert.equal(await f.runtime.sessions.db.get('SELECT 1 FROM session_namespaces WHERE session_id=?', 'first'), undefined);
  const next = await f.runtime.submit(completion('continue'), { sessionId: 'second' });
  assert.equal((await f.runtime.wait(next.id)).status, 'completed');
});

// Create fixtures with the previous layout using the real SDK, including its
// internal IDs, documents and recovery state. No exported/shared data is used.
async function legacyFixture(t) {
  const services = await mockServices(t), dataDir = await mkdtemp(join(tmpdir(), 'picall-session-migration-'));
  const config = new ConfigStore({ dataDir }); await config.load();
  await config.update({ modelApiKey: 'migration-fixture', modelBaseUrl: services.base + '/v1', defaultModel: 'fixture-model', requestTimeoutSeconds: 30 });
  const args = { dataDir, getConfig: () => config.value, fetch: services.net };
  const old = new DurableRuntime(args);
  old.sessions = { open: async () => {}, close: async () => {}, openSession: async id => SqliteStorage.open(await openNodeSqliteDatabase(join(dataDir, 'sessions', digest(id) + '.sqlite')), { prefix: 'pi_' }) };
  await old.open();
  t.after(async () => { await old.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { services, dataDir, old, args };
}

test('legacy SQLite sessions migrate without replay, retain IDs/history and resume unfinished work', async t => {
  const f = await legacyFixture(t);
  const saved = await f.old.submit(completion('MIGRATE-ONCE'), { sessionId: 'saved', idempotencyKey: 'migration-key' });
  await f.old.wait(saved.id);
  f.services.delay = 1000;
  const active = await f.old.submit(completion('RECOVER-ME'), { sessionId: 'active' });
  await until(() => f.services.requests.length === 2);
  await f.old.close(); f.services.delay = 0;
  const path = join(f.dataDir, 'sessions', digest('saved') + '.sqlite');
  const original = await readFile(path);
  const source = new DatabaseSync(path, { readOnly: true });
  const entries = source.prepare('SELECT record FROM pi_entries ORDER BY id').all().map(row => JSON.parse(row.record));
  source.close();
  const runtime = new DurableRuntime(f.args); t.after(() => runtime.close()); await runtime.open();
  assert.equal((await runtime.wait(active.id)).status, 'completed');
  assert.equal(f.services.requests.filter(request => JSON.stringify(request.messages).includes('MIGRATE-ONCE')).length, 1);
  assert.equal((await runtime.submit(completion('MIGRATE-ONCE'), { idempotencyKey: 'migration-key' })).id, saved.id);
  const details = await runtime.details('saved', { after: 0, limit: 100 });
  assert.deepEqual(details.items.map(item => item.id), entries.map(entry => entry.id));
  assert.deepEqual(details.items.map(item => item.messages), entries.map(entry => entry.model || []));
  assert.deepEqual(await readFile(path), original);
  const next = await runtime.submit(completion('next message'), { sessionId: 'saved' });
  assert.equal((await runtime.wait(next.id)).status, 'completed');
  assert.ok((await runtime.details('saved', { after: 0, limit: 100 })).items.length > entries.length);
  await runtime.close();
  const again = new DurableRuntime(f.args); t.after(() => again.close()); await again.open();
  const count = f.services.requests.length;
  assert.equal((await again.get(next.id)).status, 'completed');
  assert.ok((await again.details('saved', { after: 0, limit: 100 })).items.length > entries.length, 'backup must not overwrite new shared records');
  assert.equal(f.services.requests.length, count);
});

test('migration rollback leaves no receipt or partial entries and retries from the original file', async t => {
  const f = await legacyFixture(t);
  const run = await f.old.submit(completion('ROLLBACK'), { sessionId: 'rollback' }); await f.old.wait(run.id); await f.old.close();
  const store = new SessionStore(f.dataDir); await store.open([]); t.after(() => store.close());
  const transaction = store.db.transaction.bind(store.db);
  store.db.transaction = fn => transaction(tx => fn({ ...Object.fromEntries(['exec', 'get', 'all', 'runCounted'].map(name => [name, tx[name].bind(tx)])), run: async (sql, ...params) => {
    await tx.run(sql, ...params);
    if (sql.startsWith('INSERT INTO session_namespaces')) throw Error('injected migration interruption');
  } }));
  await assert.rejects(store.ensure('rollback'), /injected migration interruption/);
  store.db.transaction = transaction;
  assert.equal(await store.db.get('SELECT 1 FROM session_namespaces'), undefined);
  assert.equal((await store.db.get(`SELECT count(*) AS count FROM s_${digest('rollback')}_entries`)).count, 0);
  await store.ensure('rollback');
  assert.ok((await store.items('rollback', { after: 0, limit: 50 })).items.length > 0);
  await store.ensure('rollback');
  assert.equal((await store.db.get('SELECT count(*) AS count FROM session_namespaces')).count, 1);
  await writeFile(join(f.dataDir, 'sessions', digest('empty') + '.sqlite'), '');
  await store.ensure('empty');
  assert.deepEqual((await store.items('empty', { after: 0, limit: 50 })).items, []);
});

test('item projection redacts configured credentials without rendering executable content', async t => {
  const f = await setup(t);
  const run = await f.runtime.submit(completion('<img src=x onerror=alert(1)> !literal-model-fixture'));
  await f.runtime.wait(run.id);
  const response = await (await f.request('/api/sessions/' + run.sessionId)).text();
  assert.doesNotMatch(response, /!literal-model-fixture/);
  assert.match(response, /\[REDACTED\]/);
  assert.match(response, /<img src=x onerror=alert\(1\)>/);
});

test('unsupported legacy schema fails startup and releases the writer; schema v1 remains migratable', async t => {
  const f = await legacyFixture(t);
  const run = await f.old.submit(completion('SCHEMA'), { sessionId: 'schema' }); await f.old.wait(run.id); await f.old.close();
  const path = join(f.dataDir, 'sessions', digest('schema') + '.sqlite');
  const setVersion = version => { const db = new DatabaseSync(path); db.prepare('UPDATE pi_durable_schema SET version=?').run(version); db.close(); };
  setVersion(99);
  const rejected = new DurableRuntime(f.args);
  await assert.rejects(rejected.open(), error => error.code === 'storage_version_mismatch');
  await rejected.close();
  setVersion(1);
  const accepted = new DurableRuntime(f.args); t.after(() => accepted.close()); await accepted.open();
  assert.equal((await accepted.get(run.id)).status, 'completed');
  assert.ok((await accepted.details('schema', { after: 0, limit: 50 })).items.length > 0);
  assert.equal(f.services.requests.length, 1);
});
