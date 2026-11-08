import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRuns } from '../src/runs.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(t, execute, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'picall-runs-test-'));
  const store = new LocalRuns({ dataDir, execute, ...options });
  await store.open();
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir, path: id => join(dataDir, 'runs', `${id}.json`) };
}

test('accepted task is on disk before execution, and completed results survive reopening', async t => {
  let path;
  const started = deferred();
  const gate = deferred();
  const fixture = await setup(t, async (input, { signal, sessionId, runId }) => {
    assert.deepEqual(input, { prompt: 'a private prompt', model: 'picall/model' });
    assert.equal(signal.aborted, false);
    const persisted = JSON.parse(await readFile(path(runId), 'utf8'));
    assert.equal(persisted.status, 'running');
    assert.equal(persisted.sessionId, sessionId);
    started.resolve();
    return gate.promise;
  });
  path = fixture.path;
  const accepted = await fixture.store.submit({ prompt: 'a private prompt', model: 'picall/model' }, { idempotencyKey: 'raw-private-key' });
  assert.equal(accepted.status, 'pending');
  assert.match(accepted.id, new RegExp(`^${accepted.sessionId}~`));
  await started.promise;
  const raw = await readFile(path(accepted.id), 'utf8');
  assert.ok(!raw.includes('a private prompt'));
  assert.ok(!raw.includes('raw-private-key'));
  assert.ok(!Object.hasOwn(accepted, 'inputFingerprint'));
  assert.equal((await stat(path(accepted.id))).mode & 0o777, 0o600);
  assert.equal((await stat(join(fixture.dataDir, 'runs'))).mode & 0o777, 0o700);
  const waiting = fixture.store.wait(accepted.id);
  gate.resolve({ id: 'completion-id', choices: [{ message: { content: 'final answer' } }], usage: { total_tokens: 30 } });
  const finished = await waiting;
  assert.equal(finished.status, 'completed');
  assert.equal(finished.completion.usage.total_tokens, 30);
  assert.deepEqual(await fixture.store.get(accepted.id), finished);
  const reopened = new LocalRuns({ dataDir: fixture.dataDir, execute() { assert.fail('completed execution must not resume'); } });
  await reopened.open();
  assert.deepEqual(await reopened.get(accepted.id), finished);
  const reused = await reopened.submit({ model: 'picall/model', prompt: 'a private prompt' }, { idempotencyKey: 'raw-private-key' });
  assert.equal(reused.id, accepted.id);
  await reopened.close();
});

test('concurrent retry without a session reuses the first durable task; conflicting input is rejected', async t => {
  const started = deferred();
  const gate = deferred();
  let calls = 0;
  const { store } = await setup(t, async () => { calls++; started.resolve(); return gate.promise; });
  const [first, retry] = await Promise.all([
    store.submit({ prompt: 'same request' }, { idempotencyKey: 'retry-token' }),
    store.submit({ prompt: 'same request' }, { idempotencyKey: 'retry-token' }),
  ]);
  assert.equal(first.id, retry.id);
  assert.equal(first.sessionId, retry.sessionId);
  await started.promise;
  assert.equal(calls, 1);
  assert.equal((await store.submit({ prompt: 'same request' }, { idempotencyKey: 'retry-token', sessionId: first.sessionId })).id, first.id);
  await assert.rejects(store.submit({ prompt: 'different' }, { idempotencyKey: 'retry-token' }), { code: 'idempotency_conflict', status: 409 });
  await assert.rejects(store.submit({ prompt: 'same request' }, { idempotencyKey: 'retry-token', sessionId: 'another' }), { code: 'idempotency_conflict', status: 409 });
  gate.resolve({ answer: 'done' });
  await store.wait(first.id);
  const independent = await store.submit({ prompt: 'same request' });
  assert.notEqual(independent.id, first.id);
  await store.wait(independent.id);
});

test('admission reserves a session immediately and releases it after completion', async t => {
  const gate = deferred();
  const { store } = await setup(t, async () => gate.promise);
  const requests = await Promise.allSettled([
    store.submit({ prompt: 'one' }, { sessionId: 'shared-session' }),
    store.submit({ prompt: 'two' }, { sessionId: 'shared-session' }),
  ]);
  assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = requests.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'session_busy');
  const id = requests.find(result => result.status === 'fulfilled').value.id;
  gate.resolve({ answer: 'finished' });
  await store.wait(id);
  const next = await store.submit({ prompt: 'three' }, { sessionId: 'shared-session' });
  assert.notEqual(next.id, id);
  assert.equal((await store.wait(next.id)).status, 'completed');
});

test('cancelling an HTTP wait does not cancel execution; another waiter gets the result', async t => {
  const started = deferred();
  const gate = deferred();
  let taskSignal;
  const { store } = await setup(t, async (_, { signal }) => { taskSignal = signal; started.resolve(); return gate.promise; });
  const run = await store.submit({ prompt: 'continue after disconnect' });
  await started.promise;
  const controller = new AbortController();
  const disconnected = store.wait(run.id, { signal: controller.signal });
  const alive = store.wait(run.id);
  controller.abort(new Error('HTTP disconnected'));
  await assert.rejects(disconnected, /HTTP disconnected/);
  assert.equal(taskSignal.aborted, false);
  gate.resolve({ answer: 'background work completed' });
  assert.equal((await alive).completion.answer, 'background work completed');
  assert.equal(store.waiters.size, 0);
});

test('explicit cancellation persists and cannot be overwritten by an abort-ignoring late result', async t => {
  const gate = deferred();
  const started = deferred();
  let taskSignal;
  const { store, path } = await setup(t, async (_, { signal }) => { taskSignal = signal; started.resolve(); return gate.promise; });
  const run = await store.submit({ prompt: 'cancel me' }, { sessionId: 'cancel-session' });
  await started.promise;
  const waiter = store.wait(run.id);
  const cancelled = await store.cancel(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(taskSignal.aborted, true);
  assert.equal((await waiter).error.code, 'request_cancelled');
  gate.resolve({ answer: 'too late' });
  await store.executions.get(run.id)?.promise;
  assert.equal((await store.get(run.id)).status, 'cancelled');
  assert.equal(JSON.parse(await readFile(path(run.id), 'utf8')).status, 'cancelled');
  assert.equal((await store.cancel(run.id)).status, 'cancelled');
});

test('reopening unfinished on-disk tasks reports process_interrupted without re-execution', async t => {
  const { store, dataDir, path } = await setup(t, async () => ({ done: true }));
  const run = await store.submit({ prompt: 'simulated crash' }, { idempotencyKey: 'recover-key' });
  await store.wait(run.id);
  await store.close();
  const crashed = JSON.parse(await readFile(path(run.id), 'utf8'));
  crashed.status = 'running';
  delete crashed.completion;
  await writeFile(path(run.id), JSON.stringify(crashed));
  const recovered = new LocalRuns({ dataDir, execute() { assert.fail('interrupted execution cannot resume automatically'); } });
  await recovered.open();
  const result = await recovered.get(run.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'process_interrupted');
  assert.equal(result.completion, undefined);
  assert.equal((await recovered.submit({ prompt: 'simulated crash' }, { idempotencyKey: 'recover-key' })).id, run.id);
  await recovered.close();
});

test('shutdown marks pending work interrupted before aborting and rejects new submissions', async t => {
  const started = deferred();
  const { store, path } = await setup(t, async (_, { signal }) => {
    started.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort with private upstream detail'))));
  });
  const run = await store.submit({ prompt: 'shutdown test' });
  await started.promise;
  const waiter = store.wait(run.id);
  await store.close();
  const interrupted = await waiter;
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error.code, 'process_interrupted');
  await store.executions.get(run.id)?.promise;
  assert.equal((await store.get(run.id)).error.code, 'process_interrupted');
  assert.ok(!(await readFile(path(run.id), 'utf8')).includes('private upstream detail'));
  await assert.rejects(store.submit({ prompt: 'later' }), { code: 'unavailable', status: 503 });
});

test('provider errors are sanitized but safe local validation retains code, status and parameter', async t => {
  const { store, path } = await setup(t, async input => {
    if (input.prompt === 'provider') throw Object.assign(new Error('Upstream leaked private-secret-value'), { code: 'provider_error', status: 502 });
    throw Object.assign(new Error('This model does not support effort high.'), { code: 'unsupported_effort', status: 400, param: 'reasoning_effort' });
  });
  const provider = await store.submit({ prompt: 'provider' });
  const failed = await store.wait(provider.id);
  assert.equal(failed.error.code, 'provider_error');
  assert.equal(failed.error.status, 502);
  assert.ok(!JSON.stringify(failed).includes('private-secret-value'));
  assert.ok(!(await readFile(path(provider.id), 'utf8')).includes('private-secret-value'));
  const local = await store.submit({ prompt: 'local' });
  assert.deepEqual((await store.wait(local.id)).error, { code: 'unsupported_effort', status: 400,
    message: 'This model does not support effort high.', param: 'reasoning_effort' });
});

test('expired completed tasks and their idempotency mappings are pruned on reopen', async t => {
  const { store, dataDir, path } = await setup(t, async () => ({ done: true }));
  const run = await store.submit({ prompt: 'old' }, { idempotencyKey: 'old-key' });
  await store.wait(run.id);
  await store.close();
  const saved = JSON.parse(await readFile(path(run.id), 'utf8'));
  saved.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await writeFile(path(run.id), JSON.stringify(saved));
  const reopened = new LocalRuns({ dataDir, execute: async () => ({ done: true }) });
  await reopened.open();
  await assert.rejects(reopened.get(run.id), { code: 'run_not_found', status: 404 });
  assert.deepEqual(await readdir(join(dataDir, 'runs')), []);
  const next = await reopened.submit({ prompt: 'old' }, { idempotencyKey: 'old-key' });
  assert.notEqual(next.id, run.id);
  await reopened.wait(next.id);
  await reopened.close();
});

test('identifiers and idempotency tokens are validated before writing task paths', async t => {
  const { store } = await setup(t, async () => ({ done: true }));
  await assert.rejects(store.submit({ prompt: 'x' }, { sessionId: '../../outside' }), { status: 400 });
  await assert.rejects(store.submit({ prompt: 'x' }, { idempotencyKey: '\n' }), { status: 400 });
  await assert.rejects(store.get('../../outside'), { status: 404 });
  await assert.rejects(store.cancel('unknown'), { status: 404 });
});

test('lookup uses original request identity, so resolved default-model changes reuse the old result after restart', async t => {
  let calls = 0;
  const { store, dataDir, path } = await setup(t, async input => {
    calls++;
    return { model: input.model, choices: [{ message: { content: 'original answer' } }] };
  });
  const identityInput = { messages: [{ role: 'user', content: 'same request' }] };
  const options = { idempotencyKey: 'stable-original-request', identityInput };
  assert.equal(await store.lookup(identityInput), undefined);
  assert.equal(await store.lookup(identityInput, options), undefined);
  const first = await store.submit({ ...identityInput, model: 'picall/model-a' }, options);
  assert.equal(first.model, 'picall/model-a');
  const completed = await store.wait(first.id);
  assert.equal((await store.lookup(identityInput, options)).id, first.id);
  const retry = await store.submit({ ...identityInput, model: 'picall/model-b' }, options);
  assert.equal(retry.id, first.id);
  assert.equal(retry.model, 'picall/model-a');
  assert.equal(calls, 1);
  const changed = { messages: [{ role: 'user', content: 'different request' }] };
  await assert.rejects(store.lookup(changed, options), { status: 409, code: 'idempotency_conflict' });
  await assert.rejects(store.submit({ ...changed, model: 'picall/model-b' }, { ...options, identityInput: changed }), { status: 409, code: 'idempotency_conflict' });
  await assert.rejects(store.lookup(identityInput, { ...options, sessionId: 'wrong-session' }), { status: 409, code: 'idempotency_conflict' });
  assert.equal((await store.lookup(identityInput, { ...options, sessionId: first.sessionId })).id, first.id);
  assert.equal(JSON.parse(await readFile(path(first.id), 'utf8')).model, 'picall/model-a');
  await store.close();
  const reopened = new LocalRuns({ dataDir, execute: async () => assert.fail('a completed retry must not execute') });
  await reopened.open();
  assert.deepEqual(await reopened.lookup(identityInput, options), completed);
  await reopened.close();
});

test('concurrent admissions with different resolved models but identical original identity start only once', async t => {
  let calls = 0;
  const { store } = await setup(t, async input => { calls++; return { model: input.model }; });
  const identityInput = { prompt: 'one HTTP request' };
  const options = { identityInput, idempotencyKey: 'concurrent-resolve' };
  const [first, retry] = await Promise.all([
    store.submit({ prompt: identityInput.prompt, model: 'picall/first-default' }, options),
    store.submit({ prompt: identityInput.prompt, model: 'picall/changed-default' }, options),
  ]);
  assert.equal(retry.id, first.id);
  assert.equal(retry.model, first.model);
  assert.equal((await store.wait(first.id)).completion.model, 'picall/first-default');
  assert.equal(calls, 1);
});

test('failure writing the initial running state terminates accepted waiters and releases the session', async t => {
  let executed = 0;
  const { store, path, dataDir } = await setup(t, async () => { executed++; return { answer: 'done' }; });
  const persist = store.persist.bind(store);
  let writes = 0;
  store.persist = async record => {
    if (++writes === 2) throw Object.assign(new Error('private disk path is full'), { code: 'ENOSPC' });
    return persist(record);
  };
  const run = await store.submit({ prompt: 'fails before execution' }, { sessionId: 'disk-start-session' });
  const failure = await store.wait(run.id, { signal: AbortSignal.timeout(1000) });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error.code, 'storage_error');
  assert.equal(failure.error.status, 507);
  assert.equal(failure.completion, undefined);
  assert.equal(executed, 0);
  assert.equal(store.activeSessions.has(run.sessionId), false);
  assert.ok(!JSON.stringify(failure).includes('private disk path'));
  assert.equal(JSON.parse(await readFile(path(run.id), 'utf8')).status, 'pending');
  store.persist = persist;
  const next = await store.submit({ prompt: 'retry after disk recovery' }, { sessionId: run.sessionId });
  assert.equal((await store.wait(next.id)).status, 'completed');
  await store.close();
  const reopened = new LocalRuns({ dataDir, execute: async () => assert.fail('a crashed task cannot resume') });
  await reopened.open();
  assert.equal((await reopened.get(run.id)).error.code, 'process_interrupted');
  await reopened.close();
});

test('failure saving a completed execution returns storage_error rather than an unsaved answer or a hanging wait', async t => {
  const started = deferred();
  const gate = deferred();
  let taskSignal;
  const { store, path } = await setup(t, async (_, { signal }) => {
    taskSignal = signal;
    started.resolve();
    return gate.promise;
  });
  const persist = store.persist.bind(store);
  store.persist = async record => {
    if (record.status === 'completed') throw Object.assign(new Error('private volume is unavailable'), { code: 'EACCES' });
    return persist(record);
  };
  const run = await store.submit({ prompt: 'execution finishes, disk fails' });
  await started.promise;
  const waiting = store.wait(run.id, { signal: AbortSignal.timeout(1000) });
  gate.resolve({ answer: 'must not be returned as a successful persisted result' });
  const failure = await waiting;
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error.code, 'storage_error');
  assert.equal(failure.error.status, 507);
  assert.equal(failure.completion, undefined);
  assert.equal(taskSignal.aborted, true);
  assert.equal(store.activeSessions.has(run.sessionId), false);
  assert.ok(!JSON.stringify(failure).includes('private volume'));
  assert.equal(JSON.parse(await readFile(path(run.id), 'utf8')).status, 'running');
  await store.executions.get(run.id)?.promise;
  assert.deepEqual(await store.get(run.id), failure);
});

test('cancellation persistence failure aborts execution, wakes waiters and explicitly rejects with 507', async t => {
  const started = deferred();
  const gate = deferred();
  let taskSignal;
  const { store } = await setup(t, async (_, { signal }) => {
    taskSignal = signal;
    started.resolve();
    return gate.promise;
  });
  const run = await store.submit({ prompt: 'cancel while storage fails' });
  await started.promise;
  store.persist = async () => { throw Object.assign(new Error('private disk failure'), { code: 'ENOSPC' }); };
  const waiter = store.wait(run.id, { signal: AbortSignal.timeout(1000) });
  await assert.rejects(store.cancel(run.id), { status: 507, code: 'storage_error' });
  const failure = await waiter;
  assert.equal(failure.error.code, 'storage_error');
  assert.equal(failure.status, 'failed');
  assert.equal(taskSignal.aborted, true);
  gate.resolve({ answer: 'late' });
  await store.executions.get(run.id)?.promise;
  assert.equal((await store.get(run.id)).error.code, 'storage_error');
});

test('shutdown storage failure still aborts and wakes every active task before reporting 507', async t => {
  const started = deferred();
  const gate = deferred();
  const signals = [];
  const { store } = await setup(t, async (_, { signal }) => {
    signals.push(signal);
    if (signals.length === 2) started.resolve();
    return gate.promise;
  });
  const first = await store.submit({ prompt: 'first active task' });
  const second = await store.submit({ prompt: 'second active task' });
  await started.promise;
  const waiting = [store.wait(first.id, { signal: AbortSignal.timeout(1000) }), store.wait(second.id, { signal: AbortSignal.timeout(1000) })];
  store.persist = async () => { throw Object.assign(new Error('private disk failure'), { code: 'EACCES' }); };
  await assert.rejects(store.close(), { code: 'storage_error', status: 507 });
  const results = await Promise.all(waiting);
  assert.ok(results.every(result => result.status === 'failed' && result.error.code === 'storage_error'));
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(store.activeSessions.size, 0);
  const executions = [...store.executions.values()].map(execution => execution.promise);
  gate.resolve({ answer: 'too late' });
  await Promise.all(executions);
  assert.equal((await store.get(first.id)).error.code, 'storage_error');
  assert.equal((await store.get(second.id)).error.code, 'storage_error');
});
