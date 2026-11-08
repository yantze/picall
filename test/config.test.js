import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config.js';

const secrets = {
  apiKey: 'pc-local-api-canary',
  modelApiKey: 'local-model-canary',
  braveApiKey: 'local-brave-canary',
  tavilyApiKey: 'local-tavily-canary',
  tinyfishApiKey: 'local-tinyfish-canary',
  exaApiKey: 'local-exa-canary',
  jinaApiKey: 'local-jina-canary',
};
const httpTool = {
  name: 'lookup_catalog', description: 'Read a catalog record', url: 'http://127.0.0.1:9000/catalog',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

async function storeFor(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'picall-config-test-'));
  const store = new ConfigStore({ dataDir, overrides: { workdir: dataDir } });
  await store.load();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return store;
}

test('all seven keys are write-only in public config, omitted updates retain them and explicit empty values clear them', async t => {
  const store = await storeFor(t);
  const initial = store.public();
  for (const field of Object.keys(secrets)) {
    assert.equal(Object.hasOwn(initial, field), false);
    assert.equal(initial[`${field}Configured`], false);
    assert.equal(initial[`${field}Preview`], '');
  }
  const saved = await store.update(secrets);
  for (const [field, key] of Object.entries(secrets)) {
    assert.equal(Object.hasOwn(saved, field), false);
    assert.equal(saved[`${field}Configured`], true);
    assert.equal(saved[`${field}Preview`], `••••${key.slice(-4)}`);
    assert.ok(!JSON.stringify(saved).includes(key));
  }
  await store.update({ requestTimeoutSeconds: 120 });
  for (const [field, key] of Object.entries(secrets)) assert.equal(store.value[field], key);
  const reloaded = new ConfigStore({ dataDir: store.dataDir, overrides: { workdir: store.dataDir } });
  await reloaded.load();
  for (const [field, key] of Object.entries(secrets)) assert.equal(reloaded.value[field], key);
  if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  const cleared = await store.update(Object.fromEntries(Object.keys(secrets).map(field => [field, ''])));
  for (const field of Object.keys(secrets)) {
    assert.equal(store.value[field], '');
    assert.equal(cleared[`${field}Configured`], false);
    assert.equal(cleared[`${field}Preview`], '');
  }
  assert.ok(!Object.values(secrets).some(key => JSON.stringify(cleared).includes(key)));
  const file = JSON.parse(await readFile(store.path, 'utf8'));
  for (const field of Object.keys(secrets)) assert.equal(file[field], '');
});

test('short provider keys never appear in full in their public previews', async t => {
  const store = await storeFor(t);
  const fields = Object.keys(secrets).filter(field => field !== 'apiKey');
  for (const key of ['!', 'ab', 'xyz', 'abcd']) {
    const saved = await store.update(Object.fromEntries(fields.map(field => [field, key])));
    for (const field of fields) {
      assert.equal(saved[`${field}Configured`], true);
      assert.equal(Object.hasOwn(saved, field), false);
      assert.equal(saved[`${field}Preview`], '••••');
      assert.ok(!saved[`${field}Preview`].includes(key));
      assert.equal(store.value[field], key, 'masking must not alter the stored credential');
    }
  }
});

test('gateway, research and custom HTTP configuration survives restart without a Cloudflare account', async t => {
  const store = await storeFor(t);
  const patch = {
    modelBaseUrl: 'http://localhost:1234/v1', modelApiKey: 'private-model-canary', defaultModel: 'local-model',
    modelContextWindow: 65536, modelMaxTokens: 4096,
    braveBaseUrl: 'https://brave.vastiny.com/res/v1', tavilyBaseUrl: 'https://tavily.vastiny.com',
    braveApiKey: 'private-search-canary', enableResearch: true, maxToolRounds: 8,
    httpTools: [httpTool],
  };
  await store.update(patch);
  const reloaded = new ConfigStore({ dataDir: store.dataDir, overrides: { workdir: store.dataDir } });
  await reloaded.load();
  for (const [field, value] of Object.entries(patch)) assert.deepEqual(reloaded.value[field], value);
  assert.equal(reloaded.public().modelApiKeyConfigured, true);
  assert.equal(reloaded.public().braveApiKeyConfigured, true);
  assert.equal(Object.hasOwn(reloaded.public(), 'modelApiKey'), false);
  assert.equal(reloaded.value.requestTimeoutSeconds, 300);
  assert.deepEqual(reloaded.value.httpTools[0].parameters.required, ['query']);
});

test('invalid URLs, keys, limits and custom schemas are rejected without changing saved or active configuration', async t => {
  const store = await storeFor(t);
  await store.update({ ...secrets, httpTools: [httpTool] });
  const before = await readFile(store.path, 'utf8');
  const active = structuredClone(store.value);
  const invalid = [
    { modelBaseUrl: 'file:///tmp/model' },
    { modelBaseUrl: 'https://user:secret@example.com/v1' },
    { modelBaseUrl: 'https://example.com/v1?api_key=secret' },
    { modelBaseUrl: 'https://example.com/v1#fragment' },
    { braveBaseUrl: 'not-a-url' },
    { tavilyBaseUrl: 'ftp://example.com' },
    { defaultModel: '' }, { defaultModel: 'a model' }, { defaultModel: null },
    { modelApiKey: 'key with spaces' }, { braveApiKey: 'line\nbreak' },
    { jinaApiKey: 123 }, { tavilyApiKey: 'x'.repeat(4097) },
    { modelContextWindow: 1023 }, { modelMaxTokens: 0 },
    { modelContextWindow: 1024, modelMaxTokens: 1025 },
    { maxToolRounds: 0 }, { maxToolRounds: 65 }, { maxToolRounds: 2.5 },
    { enableResearch: 'true' }, { modelApiKeyPreview: 'replacement' },
    { httpTools: {} }, { httpTools: [null] }, { httpTools: Array(33).fill(httpTool) },
    { httpTools: [{ ...httpTool, name: 'web_search' }] },
    { httpTools: [httpTool, httpTool] },
    { httpTools: [{ ...httpTool, name: 'UpperCase' }] },
    { httpTools: [{ ...httpTool, name: '_private_tool' }] },
    { httpTools: [{ ...httpTool, method: 'POST' }] },
    { httpTools: [{ ...httpTool, url: 'file:///etc/passwd' }] },
    { httpTools: [{ ...httpTool, url: 'http://user:password@localhost/catalog' }] },
    { httpTools: [{ ...httpTool, description: '' }] },
    { httpTools: [{ ...httpTool, parameters: null }] },
    { httpTools: [{ ...httpTool, parameters: { type: 'array', items: { type: 'string' } } }] },
    { httpTools: [{ ...httpTool, parameters: { type: 'object' } }] },
    { httpTools: [{ ...httpTool, parameters: { type: 'object', properties: [] } }] },
  ];
  for (const patch of invalid) {
    await assert.rejects(store.update(patch), error => error.status === 400, JSON.stringify(patch));
    assert.equal(await readFile(store.path, 'utf8'), before, 'a rejected update must not partially rewrite disk');
    assert.deepEqual(store.value, active, 'a rejected update must not partially change active values');
  }
});

test('serialized setting updates do not lose an independently saved credential', async t => {
  const store = await storeFor(t);
  await Promise.all([
    store.update({ modelApiKey: 'parallel-model-secret', modelBaseUrl: 'http://127.0.0.1:1234/v1' }),
    store.update({ braveApiKey: 'parallel-brave-secret', maxToolRounds: 4 }),
  ]);
  const persisted = JSON.parse(await readFile(store.path, 'utf8'));
  assert.equal(persisted.modelApiKey, 'parallel-model-secret');
  assert.equal(persisted.braveApiKey, 'parallel-brave-secret');
  assert.equal(persisted.modelBaseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(persisted.maxToolRounds, 4);
});

test('old config gains local gateway defaults on load without rewriting an existing file or credentials', async t => {
  const store = await storeFor(t);
  const legacy = { host: '127.0.0.1', port: 8787, workdir: store.dataDir, apiKey: 'pc-preserved-legacy',
    maxSessions: 12, model: 'removed-model', effort: 'high', contextWindow: 32000 };
  const original = JSON.stringify(legacy);
  await writeFile(store.path, original, { mode: 0o600 });
  await store.load();
  assert.equal(await readFile(store.path, 'utf8'), original);
  assert.equal(store.value.apiKey, legacy.apiKey);
  assert.equal(store.public().apiKeyConfigured, true);
  assert.equal(store.value.modelBaseUrl, 'https://api.deepseek.com/v1');
  assert.equal(store.value.defaultModel, 'deepseek-flash');
  assert.equal(store.value.maxToolRounds, 8);
  assert.equal(store.value.enableResearch, true);
  for (const field of ['model', 'effort', 'contextWindow']) assert.equal(Object.hasOwn(store.value, field), false);
});
