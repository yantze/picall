import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PROJECT_TRUST = ['default', 'allow', 'deny'];
export const DEFAULTS = Object.freeze({
  host: '127.0.0.1', port: 8787,
  apiKey: '', workdir: process.cwd(), maxSessions: 8, idleTimeoutMinutes: 30,
  requestTimeoutSeconds: 300, projectTrust: 'default', saveSessions: false,
});

export function appError(message, status = 400, code = 'invalid_request', param = null) {
  return Object.assign(new Error(message), { status, code, param });
}

function validate(values) {
  for (const key of Object.keys(values)) {
    if (!(key in DEFAULTS)) throw appError(`Unknown setting: ${key}`);
  }
  if (typeof values.host !== 'string' || !['127.0.0.1', 'localhost', '::1'].includes(values.host)) {
    throw appError('Management UI is local only; host must be 127.0.0.1, localhost, or ::1.');
  }
  for (const [key, min, max] of [['port', 1, 65535], ['maxSessions', 1, 64], ['idleTimeoutMinutes', 1, 1440], ['requestTimeoutSeconds', 5, 3600]]) {
    if (!Number.isInteger(values[key]) || values[key] < min || values[key] > max) throw appError(`${key} must be an integer between ${min} and ${max}.`);
  }
  if (!PROJECT_TRUST.includes(values.projectTrust)) throw appError('projectTrust must be default, allow, or deny.');
  if (typeof values.saveSessions !== 'boolean') throw appError('saveSessions must be a boolean.');
  if (typeof values.apiKey !== 'string' || (values.apiKey && (!/^[\x21-\x7e]{8,256}$/.test(values.apiKey)))) throw appError('API key must contain 8–256 visible ASCII characters (or be empty to disable authentication).');
  if (typeof values.workdir !== 'string' || !isAbsolute(values.workdir)) throw appError('workdir must be an absolute path.');
}

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
    let saved = {};
    try { saved = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read configuration ${this.path}: ${error.message}`); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved configuration must be a JSON object.');
    // Remove legacy gateway model defaults without changing other settings.
    const { model: _model, effort: _effort, contextWindow: _contextWindow, ...gatewaySettings } = saved;
    this.value = { ...DEFAULTS, ...gatewaySettings, ...this.overrides };
    validate(this.value);
    return this.value;
  }
  public() {
    const { apiKey, ...rest } = this.value;
    return { ...rest, apiKeyConfigured: Boolean(apiKey), apiKeyPreview: apiKey ? `••••${apiKey.slice(-4)}` : '' };
  }
  update(patch) {
    const operation = this.queue.then(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw appError('Settings must be a JSON object.');
      const allowed = ['apiKey', 'maxSessions', 'idleTimeoutMinutes', 'requestTimeoutSeconds', 'projectTrust', 'saveSessions'];
      for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw appError(`Setting is read-only or unknown: ${key}`);
      const next = { ...this.value, ...patch };
      validate(next);
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
