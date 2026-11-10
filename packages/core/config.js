const byteLength = value => new TextEncoder().encode(value).length;
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_ADDITIONAL_SYSTEM_PROMPT = '按问题复杂度使用工具：简单事实优先一次搜索和一个权威来源，证据充分后立即回答；复杂研究按需补查。';
export const SECRET_FIELDS = ['apiKey', 'modelApiKey', 'braveApiKey', 'tavilyApiKey', 'tinyfishApiKey', 'exaApiKey', 'jinaApiKey'];
export const DEFAULTS = Object.freeze({
  host: '127.0.0.1', port: 8787,
  configVersion: 2, apiKey: '', maxSessions: 8, idleTimeoutMinutes: 30,
  requestTimeoutSeconds: 300, toolOverrides: Object.freeze({}),
  additionalSystemPrompt: DEFAULT_ADDITIONAL_SYSTEM_PROMPT,
  modelBaseUrl: 'https://api.deepseek.com/v1', modelApiKey: '', defaultModel: 'deepseek-flash',
  modelContextWindow: 131072, modelMaxTokens: 8192,
  enableResearch: true, maxToolRounds: 8,
  braveApiKey: '', tavilyApiKey: '', tinyfishApiKey: '', exaApiKey: '', jinaApiKey: '',
  braveBaseUrl: 'https://brave.vastiny.com/res/v1', tavilyBaseUrl: 'https://tavily.vastiny.com',
  httpTools: Object.freeze([]),
});

export const canonicalOverrides = (value = {}) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

function validateOverrides(value, field, validName, maxBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 256 ||
      Object.entries(value).some(([name, enabled]) => !validName(name) || typeof enabled !== 'boolean') ||
      byteLength(JSON.stringify(value)) > maxBytes) {
    throw appError(`${field} must be an object with valid names and boolean values (at most 256 entries).`);
  }
}
export const normalizedConfig = value => ({ ...value,
  toolOverrides: canonicalOverrides(value.toolOverrides) });

export function appError(message, status = 400, code = 'invalid_request', param = null) {
  return Object.assign(new Error(message), { status, code, param });
}

export function validate(values) {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw appError(`Unknown setting: ${key}`);
  }
  if (typeof values.host !== 'string' || !['127.0.0.1', 'localhost', '::1'].includes(values.host)) {
    throw appError('Management UI is local only; host must be 127.0.0.1, localhost, or ::1.');
  }
  for (const [key, min, max] of [['port', 1, 65535], ['maxSessions', 1, 64], ['idleTimeoutMinutes', 1, 1440], ['requestTimeoutSeconds', 5, 3600]]) {
    if (!Number.isInteger(values[key]) || values[key] < min || values[key] > max) throw appError(`${key} must be an integer between ${min} and ${max}.`);
  }
  if (typeof values.additionalSystemPrompt !== 'string' || values.additionalSystemPrompt.length > 16384 || values.additionalSystemPrompt.includes('\0')) {
    throw appError('additionalSystemPrompt must be a string of at most 16384 characters without NUL characters.');
  }
  validateOverrides(values.toolOverrides, 'toolOverrides', name => /^[A-Za-z0-9_.:-]{1,256}$/.test(name), 32 * 1024);
  if (typeof values.apiKey !== 'string' || (values.apiKey && (!/^[\x21-\x7e]{8,256}$/.test(values.apiKey)))) throw appError('API key must contain 8–256 visible ASCII characters (or be empty to disable authentication).');
  for (const field of ['modelBaseUrl', 'braveBaseUrl', 'tavilyBaseUrl']) {
    let url;
    try { url = new URL(values[field]); } catch { throw appError(`${field} must be an HTTP(S) URL.`); }
    if (typeof values[field] !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw appError(`${field} must be an HTTP(S) base URL without credentials, query, or fragment.`);
  }
  for (const field of SECRET_FIELDS.filter(field => field !== 'apiKey')) {
    if (typeof values[field] !== 'string' || values[field].length > 4096 || /[\u0000-\u0020\u007f]/.test(values[field])) throw appError(`${field} must be a key without whitespace or control characters (or empty).`);
  }
  if (typeof values.defaultModel !== 'string' || !values.defaultModel || values.defaultModel.length > 256 || /[\s\u0000-\u001f\u007f]/.test(values.defaultModel)) throw appError('defaultModel must be a nonempty model ID without whitespace.');
  for (const [field, min, max] of [['modelContextWindow', 1024, 2000000], ['modelMaxTokens', 1, 200000], ['maxToolRounds', 1, 64]]) {
    if (!Number.isInteger(values[field]) || values[field] < min || values[field] > max) throw appError(`${field} must be an integer between ${min} and ${max}.`);
  }
  if (values.modelMaxTokens > values.modelContextWindow) throw appError('modelMaxTokens must not exceed modelContextWindow.');
  if (typeof values.enableResearch !== 'boolean') throw appError('enableResearch must be a boolean.');
  if (!Array.isArray(values.httpTools) || values.httpTools.length > 32 || byteLength(JSON.stringify(values.httpTools)) > 65536) throw appError('httpTools must be an array of at most 32 tools and 64 KiB.');
  const names = new Set(['web_search', 'fetch_content', 'get_search_content']);
  for (const tool of values.httpTools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool) || Object.keys(tool).some(key => !['name', 'description', 'url', 'parameters'].includes(key)) || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name)) throw appError('HTTP tools need unique lowercase names and only name, description, url, parameters fields.');
    names.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description || tool.description.length > 2000) throw appError('HTTP tools need a description of 1–2000 characters.');
    let url;
    try { url = new URL(tool.url); } catch { throw appError('HTTP tool URL must use HTTP(S).'); }
    if (typeof tool.url !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw appError('HTTP tool URL must use HTTP(S) without embedded credentials.');
    if (!tool.parameters || tool.parameters.type !== 'object' || !tool.parameters.properties || typeof tool.parameters.properties !== 'object' || Array.isArray(tool.parameters.properties)) throw appError('HTTP tool parameters must be a JSON Schema object with properties.');
  }
}
