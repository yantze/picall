#!/usr/bin/env node
import { resolve } from 'node:path';
import { ConfigStore } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { DurableRuntime } from '../src/durable-runtime.js';
import { createApp } from '../src/server.js';
import { VERSION } from '../src/version.js';

const usage = `PiCall ${VERSION} — local Pi Durable research API

Usage: picall [--port 8787] [--host 127.0.0.1] [--data-dir DIR]
       picall --help | --version

Configure models, search keys and read-only HTTP tools in the local web UI.
Only loopback hosts are supported. Tasks and conversations persist in SQLite.
After restarting this process, unfinished tasks resume within their original deadline.
Coding Agent, external Pi extensions, MCP, Skills and native Pi CLI commands are removed.
The migration preserves gateway credentials and old task results; see README.md.
`;
async function main() {
  const args = process.argv.slice(2), options = {};
  let dataDir;
  const removed = ['pi', '--workdir', '--project-trust', '--save-sessions', '--no-save-sessions', '--enable-skills', '--no-skills', '--enable-extensions', '--no-extensions'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (['--help', '-h'].includes(flag)) { console.log(usage); return; }
    if (['--version', '-v'].includes(flag)) { console.log(VERSION); return; }
    if (removed.includes(flag)) throw new Error(`${flag} belongs to the removed Coding Agent runtime. Use the research configuration page; see README.md for migration.`);
    if (!['--host', '--port', '--data-dir'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}. Run picall --help.`);
    const value = args[++index];
    if (flag === '--host') options.host = value;
    if (flag === '--port') options.port = Number(value);
    if (flag === '--data-dir') dataDir = resolve(value);
  }
  const configStore = new ConfigStore({ dataDir, overrides: options });
  await configStore.load();
  const logger = new Logger({ dataDir: configStore.dataDir, consoleOutput: true });
  const runtime = new DurableRuntime({ dataDir: configStore.dataDir, getConfig: () => configStore.value, logger });
  const app = createApp({ configStore, runtime, logger });
  try { await app.ready; }
  catch (error) { await runtime.close(); logger.close(); throw error; }
  app.server.once('error', error => { console.error(`Cannot start PiCall: ${error.message}`); process.exitCode = 1; void app.close().catch(() => {}); });
  app.server.listen(configStore.value.port, configStore.value.host, () => {
    const host = configStore.value.host === '::1' ? '[::1]' : configStore.value.host;
    logger.log('info', 'PiCall listening', { host, port: configStore.value.port, runtime: 'pi-durable' });
    console.log(`\n  PiCall → http://${host}:${configStore.value.port}\n  API    → http://${host}:${configStore.value.port}/v1\n  Data   → ${configStore.dataDir}\n`);
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try { await app.close(); }
    catch { console.error('PiCall could not flush task storage during shutdown.'); process.exitCode = 1; }
    finally { logger.close(); }
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
