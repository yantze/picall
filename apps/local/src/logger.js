import { EventEmitter } from 'node:events';
import { mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately log operational metadata only: never request bodies or credentials.
export class Logger extends EventEmitter {
  constructor({ dataDir, consoleOutput = false } = {}) {
    super();
    this.setMaxListeners(100);
    this.items = [];
    this.nextId = 1;
    this.consoleOutput = consoleOutput;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      this.path = join(dataDir, 'picall.log');
    }
  }
  log(level, message, details) {
    const item = { id: this.nextId++, time: new Date().toISOString(), level, message };
    if (details) item.details = details;
    this.items.push(item);
    if (this.items.length > 1000) this.items.shift();
    if (this.path) {
      try {
        try { if (statSync(this.path).size > 5 * 1024 * 1024) renameSync(this.path, `${this.path}.1`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        appendFileSync(this.path, JSON.stringify(item) + '\n', { mode: 0o600 });
      } catch { /* A full log volume must not interrupt an in-flight completion. */ }
    }
    if (this.consoleOutput) process.stderr.write(`${item.time} ${level.toUpperCase()} ${message}${details ? ` ${JSON.stringify(details)}` : ''}\n`);
    this.emit('log', item);
    return item;
  }
  history() { return [...this.items]; }
  close() { this.removeAllListeners(); }
}
