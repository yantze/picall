import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { discoverExtensions } from '../src/extension-catalog.js';

async function fixture(t, globalSettings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'picall-extension-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workdir = join(root, 'project');
  const agentDir = join(root, 'profile');
  const globalExtension = join(agentDir, 'extensions', 'global.js');
  const projectExtension = join(workdir, '.pi', 'extensions', 'project.js');
  const marker = join(root, 'EXTENSION_EXECUTED');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await mkdir(join(workdir, '.pi', 'extensions'), { recursive: true });
  const code = `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'an extension was imported');
throw new Error('Catalog must not import extensions');
export default function () {};
`;
  await writeFile(globalExtension, code);
  await writeFile(projectExtension, code);
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify(globalSettings));
  const discover = options => discoverExtensions({ workdir, ...options }, { agentDir });
  return { root, workdir, agentDir, globalExtension, projectExtension, marker, settingsPath, code, discover };
}

test('extension discovery resolves local packages and builtins without executing code or changing settings', async (t) => {
  const f = await fixture(t);
  const packageRoot = join(f.root, 'fixture-package');
  await mkdir(packageRoot);
  const packageExtension = join(packageRoot, 'entry.js');
  await writeFile(packageExtension, f.code);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'fixture-extension', pi: { extensions: ['./entry.js'] },
  }));
  const settings = JSON.stringify({ packages: [packageRoot] });
  await writeFile(f.settingsPath, settings);
  const entries = await f.discover({ projectTrust: 'allow' });
  assert.deepEqual(entries.filter(entry => entry.path.startsWith('builtin:')).map(entry => entry.name),
    ['llama.cpp', 'codemode', 'tool-search', 'mcp']);
  for (const path of [f.globalExtension, f.projectExtension, packageExtension]) {
    const entry = entries.find(entry => entry.id === path);
    assert.ok(entry, path);
    assert.equal(entry.enabled, true);
    assert.equal(entry.configuredEnabled, true);
    assert.deepEqual(Object.keys(entry).sort(), ['configuredEnabled', 'enabled', 'id', 'name', 'origin', 'path', 'scope']);
    assert.equal(entry.id, await realpath(path));
  }
  assert.equal(entries.find(entry => entry.id === packageExtension).origin, 'package');
  assert.equal(entries.find(entry => entry.id === f.projectExtension).scope, 'project');
  assert.equal(await readFile(f.settingsPath, 'utf8'), settings);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('catalog preserves configured-disabled entries and applies exact boolean overrides and master switch', async (t) => {
  const f = await fixture(t, { extensions: ['-./extensions/global.js', '-builtin:mcp'] });
  const initial = await f.discover({ projectTrust: 'allow' });
  for (const id of [f.globalExtension, 'builtin:mcp']) {
    const entry = initial.find(entry => entry.id === id);
    assert.ok(entry);
    assert.equal(entry.configuredEnabled, false);
    assert.equal(entry.enabled, false);
  }
  const extensionOverrides = {
    [f.globalExtension]: true, 'builtin:mcp': true,
    [f.projectExtension]: false, 'builtin:codemode': 'false',
  };
  const overridden = await f.discover({ projectTrust: 'allow', extensionOverrides });
  assert.equal(overridden.find(entry => entry.id === f.globalExtension).enabled, true);
  assert.equal(overridden.find(entry => entry.id === 'builtin:mcp').enabled, true);
  assert.equal(overridden.find(entry => entry.id === f.projectExtension).enabled, false);
  assert.equal(overridden.find(entry => entry.id === 'builtin:codemode').enabled, true);
  assert.ok((await f.discover({ projectTrust: 'allow', extensionOverrides, enableExtensions: false })).every(entry => !entry.enabled));
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('untrusted project resources cannot be surfaced or enabled by a saved override', async (t) => {
  const f = await fixture(t);
  const extensionOverrides = { [f.projectExtension]: true };
  const assertNoProject = entries => {
    assert.ok(entries.some(entry => entry.id === f.globalExtension));
    assert.ok(!entries.some(entry => entry.scope === 'project' || entry.id === f.projectExtension));
  };
  assertNoProject(await f.discover({ extensionOverrides }));
  assertNoProject(await f.discover({ projectTrust: 'deny', extensionOverrides }));
  const trust = new ProjectTrustStore(f.agentDir);
  trust.set(f.workdir, true);
  assert.ok((await f.discover()).some(entry => entry.id === f.projectExtension));
  assertNoProject(await f.discover({ projectTrust: 'deny' }));
  trust.set(f.workdir, false);
  assertNoProject(await f.discover());
  assert.ok((await f.discover({ projectTrust: 'allow' })).some(entry => entry.id === f.projectExtension));
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});

test('catalog follows global default project trust and never installs missing package sources', async (t) => {
  const f = await fixture(t, {
    defaultProjectTrust: 'always',
    packages: ['git:https://github.com/picall-fixture/not-installed'],
  });
  assert.ok((await f.discover()).some(entry => entry.id === f.projectExtension));
  await assert.rejects(readFile(join(f.agentDir, 'git')), { code: 'ENOENT' });
  await writeFile(f.settingsPath, JSON.stringify({ defaultProjectTrust: 'never' }));
  assert.ok(!(await f.discover()).some(entry => entry.id === f.projectExtension));
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
});
