import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { DEFAULTS, SECRET_FIELDS, validate, normalizedConfig, appError } from '../../../packages/core/config.js';
export * from '../../../packages/core/config.js';

export class ConfigStore {
  constructor({ dataDir = process.env.PICALL_DATA_DIR || join(homedir(), '.picall'), overrides = {} } = {}) {
    this.dataDir = resolve(dataDir);
    this.path = join(this.dataDir, 'config.json');
    this.overrides = overrides;
    this.value = { ...DEFAULTS, ...overrides };
    this.queue = Promise.resolve();
  }
  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let saved = {}, original;
    try { original = await readFile(this.path, 'utf8'); saved = JSON.parse(original); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read configuration ${this.path}: ${error.message}`); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved configuration must be a JSON object.');
    const legacy = ['workdir', 'projectTrust', 'saveSessions', 'enableSkills', 'enableExtensions', 'extensionOverrides', 'model', 'effort', 'contextWindow'];
    if (original && saved.configVersion !== 2) {
      try { await writeFile(join(this.dataDir, 'config.v0.7.backup.json'), original, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const gatewaySettings = Object.fromEntries(Object.entries(saved).filter(([key]) => !legacy.includes(key)));
    if (saved.configVersion > 2) throw new Error('This configuration was written by a newer PiCall version.');
    this.value = { ...DEFAULTS, ...gatewaySettings, ...this.overrides, configVersion: 2 };
    validate(this.value);
    this.value = normalizedConfig(this.value);
    return this.value;
  }
  public() {
    const rest = { ...this.value };
    for (const field of SECRET_FIELDS) {
      const key = rest[field];
      delete rest[field];
      rest[`${field}Configured`] = Boolean(key);
      rest[`${field}Preview`] = key ? `••••${key.length > 4 ? key.slice(-4) : ''}` : '';
    }
    return rest;
  }
  update(patch) {
    const operation = this.queue.then(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw appError('Settings must be a JSON object.');
      const allowed = Object.keys(DEFAULTS).filter(key => !['host', 'port', 'configVersion'].includes(key));
      for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw appError(`Setting is read-only or unknown: ${key}`);
      const merged = { ...this.value, ...patch };
      validate(merged);
      const next = normalizedConfig(merged);
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, this.path);
      await chmod(this.path, 0o600);
      this.value = next;
      return this.public();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
