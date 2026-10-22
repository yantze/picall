import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = fileURLToPath(new URL('../bin/picall.js', import.meta.url));
const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startCli(t, { flags = () => [], savedTrust, savedConfig = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'picall-cli-test-'));
  const profile = join(root, 'profile');
  const workdir = join(root, 'project');
  const dataDir = join(root, 'data');
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2500);
        exited.then(() => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(profile, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(workdir, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(workdir, '.pi', 'extensions', 'web-probe.js'), `export default function(pi) {
    pi.registerTool({ name: 'web_probe', label: 'Web probe', description: 'An isolated CLI fixture search tool.',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'fixture result' }] }; }
    });
  }\n`);
  const saved = { ...savedConfig, ...(savedTrust === undefined ? {} : { projectTrust: savedTrust }) };
  if (Object.keys(saved).length) await writeFile(join(dataDir, 'config.json'), JSON.stringify(saved), { mode: 0o600 });
  const port = await unusedPort();
  let output = '';
  let spawnError;
  child = spawn(process.execPath, [cli, '--host', '127.0.0.1', '--port', String(port), '--data-dir', dataDir, ...flags(workdir)], {
    cwd: workdir,
    env: { ...process.env, PI_CODING_AGENT_DIR: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', (error) => { spawnError = error; resolve(); });
  });
  const capture = (chunk) => { output = (output + chunk.toString()).slice(-16_384); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (true) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI exited before startup: ${output}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch { /* Startup has not reached listen() yet. */ }
    if (Date.now() >= deadline) throw new Error(`CLI did not become ready: ${output}`);
    await delay(25);
  }
  const get = async (path) => {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  return { get, workdir, profile };
}

test('CLI without --workdir keeps default trust and skips unapproved project tools', { timeout: 30_000 }, async (t) => {
  const { get, workdir, profile } = await startCli(t);
  const config = await get('/api/config');
  assert.equal(config.workdir, workdir);
  assert.equal(config.projectTrust, 'default');
  assert.equal(config.saveSessions, false);
  const { pi } = await get('/api/status');
  assert.equal(pi.available, true, pi.error);
  assert.equal(pi.agentDir, profile);
  assert.ok(!pi.tools.includes('web_probe'));
});

test('an explicit --workdir trusts the project and loads its actual tools without provider credentials', { timeout: 30_000 }, async (t) => {
  const { get, workdir, profile } = await startCli(t, { flags: (dir) => ['--workdir', dir] });
  const config = await get('/api/config');
  assert.equal(config.workdir, workdir);
  assert.equal(config.projectTrust, 'allow');
  const { pi } = await get('/api/status');
  assert.equal(pi.available, true, pi.error);
  assert.equal(pi.agentDir, profile);
  assert.ok(pi.tools.includes('web_probe'));
  assert.ok(pi.availableTools.includes('web_probe'));
});

test('explicit --workdir overrides a previously saved deny decision', { timeout: 30_000 }, async (t) => {
  const { get } = await startCli(t, { savedTrust: 'deny', flags: (dir) => ['--workdir', dir] });
  assert.equal((await get('/api/config')).projectTrust, 'allow');
  const { pi } = await get('/api/status');
  assert.equal(pi.available, true, pi.error);
  assert.ok(pi.tools.includes('web_probe'));
});

for (const projectTrust of ['deny', 'default']) {
  for (const trustFirst of [true, false]) {
    test(`explicit --project-trust ${projectTrust} overrides --workdir (${trustFirst ? 'before' : 'after'})`, { timeout: 30_000 }, async (t) => {
      const { get } = await startCli(t, { flags: (dir) => trustFirst
        ? ['--project-trust', projectTrust, '--workdir', dir]
        : ['--workdir', dir, '--project-trust', projectTrust] });
      assert.equal((await get('/api/config')).projectTrust, projectTrust);
      const { pi } = await get('/api/status');
      assert.equal(pi.available, true, pi.error);
      assert.ok(!pi.tools.includes('web_probe'));
    });
  }
}

for (const { saved, flags, expected } of [
  { saved: true, flags: [], expected: true },
  { saved: false, flags: ['--save-sessions'], expected: true },
  { saved: true, flags: ['--no-save-sessions'], expected: false },
  { saved: true, flags: ['--save-sessions', '--no-save-sessions'], expected: false },
  { saved: false, flags: ['--no-save-sessions', '--save-sessions'], expected: true },
]) {
  test(`CLI session saving ${flags.join(' ') || '(saved setting)'} overrides saved ${saved}`, { timeout: 30_000 }, async (t) => {
    const { get } = await startCli(t, { savedConfig: { saveSessions: saved }, flags: () => flags });
    assert.equal((await get('/api/config')).saveSessions, expected);
  });
}

test('CLI help documents both session-saving switches', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, '--help']);
  assert.equal(stderr, '');
  assert.match(stdout, /--save-sessions\b/);
  assert.match(stdout, /--no-save-sessions\b/);
});

for (const { saved, flags, expected } of [
  { saved: true, flags: [], expected: true },
  { saved: false, flags: ['--enable-skills'], expected: true },
  { saved: true, flags: ['--no-skills'], expected: false },
  { saved: true, flags: ['--enable-skills', '--no-skills'], expected: false },
  { saved: false, flags: ['--no-skills', '--enable-skills'], expected: true },
]) {
  test(`CLI Skills ${flags.join(' ') || '(saved setting)'} overrides saved ${saved}`, { timeout: 30_000 }, async (t) => {
    const { get } = await startCli(t, { savedConfig: { enableSkills: saved, saveSessions: true }, flags: () => flags });
    const config = await get('/api/config');
    assert.equal(config.enableSkills, expected);
    assert.equal(config.saveSessions, true);
  });
}

test('CLI Skills help documents enabling and disabling Skills', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, '--help']);
  assert.equal(stderr, '');
  assert.match(stdout, /--enable-skills\b/);
  assert.match(stdout, /--no-skills\b/);
});
