export const MAX_TOOLS = 512;
export const MAX_TOOL_NAME_LENGTH = 256;

export function validToolName(name) {
  return typeof name === 'string' && name.length > 0 &&
    name.length <= MAX_TOOL_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(name);
}

// JSON tool names are dictionary keys, including names such as "constructor".
// Never consult inherited properties or copy them into Object.prototype.
export function parseToolOverrides(raw) {
  if (raw === undefined) return Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PICALL_TOOL_OVERRIDES must be a JSON object of tool names and booleans.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PICALL_TOOL_OVERRIDES must be a JSON object of tool names and booleans.');
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_TOOLS || entries.some(([name, enabled]) =>
    !validToolName(name) || typeof enabled !== 'boolean')) {
    throw new Error('PICALL_TOOL_OVERRIDES contains invalid tool names, values, or too many entries.');
  }
  return Object.assign(Object.create(null), parsed);
}

function operationName(name) {
  // MCP prefixes identify the server, not the operation: an "exec" server can
  // still provide a read-only search tool. Apply defaults to the operation name.
  const localName = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;
  return localName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const executionOperation = /(?:^|[^a-z0-9])(?:bash|powershell|pwsh|sh|zsh|fish|cmd|cmdexe|shell|terminal|exec|execute|run|command|codemode|code_mode|eval|evaluate|python|javascript)(?:$|[^a-z0-9])/;
const writeOperation = /(?:^|[^a-z0-9])(?:write|edit|patch|delete|remove|create|update|insert|append|prepend|replace|move|rename|mkdir|rmdir|unlink|rm|touch|copy|cp|mv|save|set|put|post|send|publish|commit|push|upload|install|uninstall)(?:$|[^a-z0-9])/;

// This controls named Pi tool calls. Allowed extensions and commands still run
// with the Pi process's permissions; this is not an operating-system sandbox.
export function toolPolicy(toolOrName, overrides = {}) {
  const tool = typeof toolOrName === 'string' ? { name: toolOrName } : toolOrName;
  const name = typeof tool?.name === 'string' ? tool.name : '';
  const annotations = tool?.annotations;
  const operation = operationName(name);
  let defaultEnabled = true;
  let reason = annotations?.readOnlyHint === true ?
    'The tool declares read-only behavior.' : 'Extension and unclassified tools are enabled by default.';

  if (executionOperation.test(operation)) {
    defaultEnabled = false;
    reason = 'Command and code execution tools are disabled by default.';
  } else if (writeOperation.test(operation)) {
    defaultEnabled = false;
    reason = 'Tools that modify files or external state are disabled by default.';
  } else if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) {
    defaultEnabled = false;
    reason = 'The tool declares that it may modify data.';
  }

  if (Object.hasOwn(overrides, name) && typeof overrides[name] === 'boolean') {
    return {
      enabled: overrides[name], defaultEnabled,
      reason: overrides[name] ? 'Explicitly enabled in PiCall settings.' : 'Explicitly disabled in PiCall settings.',
    };
  }
  return { enabled: defaultEnabled, defaultEnabled, reason };
}
