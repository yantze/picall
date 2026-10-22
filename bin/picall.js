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
       picall pi [Pi CLI options]
       picall --help | --version

The management UI has no login. Only loopback hosts are supported.
Pi uses its normal provider credentials, extensions, skills and MCP configuration.
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
    if (!['--port', '--host', '--workdir', '--data-dir'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}. Run picall --help.`);
    const value = args[++i];
    if (flag === '--port') options.port = Number(value);
    if (flag === '--host') options.host = value;
    if (flag === '--workdir') options.workdir = resolve(value);
    if (flag === '--data-dir') dataDir = resolve(value);
  }
  options.workdir = await realpath(options.workdir || process.cwd());
  if (!(await stat(options.workdir)).isDirectory()) throw new Error('workdir must be a directory.');
  const configStore = new ConfigStore({ dataDir, overrides: options });
  await configStore.load();
  const logger = new Logger({ dataDir: configStore.dataDir, consoleOutput: true });
  const runtime = new PiRuntime({ getConfig: () => configStore.value, logger });
  const app = createApp({ configStore, runtime, logger });
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
    await app.close(); logger.close();
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
