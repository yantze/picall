#!/usr/bin/env node
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { PiRuntime } from '../src/pi-rpc.js';
import { createApp } from '../src/server.js';
import { VERSION } from '../src/version.js';

const usage = `PiCall ${VERSION} — local Pi-powered OpenAI API

Usage: picall [--port 8787] [--host 127.0.0.1] [--workdir DIR] [--data-dir DIR]
              [--project-trust default|allow|deny] [--save-sessions | --no-save-sessions]
              [--enable-skills | --no-skills]
              [--enable-extensions | --no-extensions]
       picall pi [Pi CLI options]
       picall --help | --version

The management UI has no login. Only loopback hosts are supported.
Configure model base URL, API key, default model and research services in the web UI.
Native Pi providers, extensions, skills and MCP configuration remain optional.
An explicit --workdir trusts that project's configuration, extensions and MCP.
Without --workdir, saved trust settings apply. --project-trust can override this.
Use --save-sessions to keep requests, replies and tool results in Pi's session files.
Saving is off by default. --no-save-sessions overrides a saved enabled setting.
Skills are off by default (--no-skills). Use --enable-skills to load Pi's skills.
Extensions are on by default. Use --no-extensions to disable external extensions.
Write and command tools are off by default; select individual tools in the web UI.
Use the bundled Pi CLI for login: picall pi (then type /login)
`;
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'pi') {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const child = spawn(process.execPath, [join(dirname(entry), 'bundle', 'cli.js'), ...args.slice(1)], { stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
    return;
  }
  const options = {};
  let dataDir;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') { console.log(usage); return; }
    if (flag === '--version' || flag === '-v') { console.log(VERSION); return; }
    if (flag === '--save-sessions' || flag === '--no-save-sessions') {
      options.saveSessions = flag === '--save-sessions';
      continue;
    }
    if (flag === '--enable-skills' || flag === '--no-skills') {
      options.enableSkills = flag === '--enable-skills';
      continue;
    }
    if (flag === '--enable-extensions' || flag === '--no-extensions') {
      options.enableExtensions = flag === '--enable-extensions';
      continue;
    }
    if (!['--port', '--host', '--workdir', '--data-dir', '--project-trust'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}. Run picall --help.`);
    const value = args[++i];
    if (flag === '--port') options.port = Number(value);
    if (flag === '--host') options.host = value;
    if (flag === '--workdir') options.workdir = resolve(value);
    if (flag === '--data-dir') dataDir = resolve(value);
    if (flag === '--project-trust') options.projectTrust = value;
  }
  if (options.workdir !== undefined && options.projectTrust === undefined) {
    options.projectTrust = 'allow';
  }
  options.workdir = await realpath(options.workdir || process.cwd());
  if (!(await stat(options.workdir)).isDirectory()) throw new Error('workdir must be a directory.');
  const configStore = new ConfigStore({ dataDir, overrides: options });
  await configStore.load();
  const logger = new Logger({ dataDir: configStore.dataDir, consoleOutput: true });
  const runtime = new PiRuntime({ getConfig: () => configStore.value, logger });
  const app = createApp({ configStore, runtime, logger });
  await app.ready;
  app.server.once('error', error => { console.error(`Cannot start PiCall: ${error.message}`); process.exitCode = 1; void app.close(); });
  app.server.listen(configStore.value.port, configStore.value.host, () => {
    logger.log('info', 'PiCall listening', { host: configStore.value.host, port: configStore.value.port });
    const host = configStore.value.host === '::1' ? '[::1]' : configStore.value.host;
    console.log(`\n  PiCall  →  http://${host}:${configStore.value.port}\n  API     →  http://${host}:${configStore.value.port}/v1\n  Workdir →  ${configStore.value.workdir}\n`);
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    logger.log('info', 'Shutting down');
    try { await app.close(); }
    catch { console.error('PiCall could not persist all task states during shutdown.'); process.exitCode = 1; }
    finally { logger.close(); }
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
