import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolOverrides, toolPolicy } from '../src/tool-policy.js';
import picallRuntimeExtension from '../src/extensions/runtime.mjs';

test('file mutation and arbitrary command tools are disabled by default', () => {
  for (const name of ['write', 'edit', 'bash', 'powershell', 'apply_patch', 'delete_file',
    'exec', 'run_command', 'shell', 'terminal', 'codemode', 'applyPatch',
    'mcp__filesystem__write_file', 'mcp__remote__runCommand']) {
    assert.equal(toolPolicy(name).enabled, false, name);
    assert.equal(toolPolicy(name).defaultEnabled, false, name);
  }
});

test('unknown and search extensions remain enabled without verified mutation hints', () => {
  for (const name of ['read', 'grep', 'web_search', 'fetch', 'inspect_document',
    'mcp__exec__search', 'mcp__write__fetch']) {
    assert.equal(toolPolicy(name).enabled, true, name);
  }
  assert.equal(toolPolicy({ name: 'lookup', annotations: { readOnlyHint: true } }).enabled, true);
});

test('explicit mutation annotations disable tools even with conflicting read-only hints', () => {
  assert.equal(toolPolicy({ name: 'custom_tool', annotations: { readOnlyHint: false } }).enabled, false);
  assert.equal(toolPolicy({ name: 'custom_tool', annotations: { destructiveHint: true, readOnlyHint: true } }).enabled, false);
  assert.equal(toolPolicy({ name: 'bash', annotations: { readOnlyHint: true } }).enabled, false);
});

test('explicit settings override defaults while preserving the reported default', () => {
  assert.deepEqual({ ...toolPolicy('bash', { bash: true }), reason: undefined },
    { enabled: true, defaultEnabled: false, reason: undefined });
  assert.equal(toolPolicy('web_search', { web_search: false }).enabled, false);
  assert.equal(toolPolicy({ name: 'remote', annotations: { destructiveHint: true } }, { remote: true }).enabled, true);
});

test('override dictionaries do not inherit policy or mutate prototypes', () => {
  assert.equal(toolPolicy('bash', Object.create({ bash: true })).enabled, false);
  assert.equal(toolPolicy('constructor').enabled, true);
  const overrides = parseToolOverrides('{"__proto__":false,"constructor":false,"bash":true}');
  assert.equal(Object.getPrototypeOf(overrides), null);
  assert.equal(toolPolicy('__proto__', overrides).enabled, false);
  assert.equal(toolPolicy('constructor', overrides).enabled, false);
  assert.equal(toolPolicy('bash', overrides).enabled, true);
  assert.equal(Object.prototype.bash, undefined);
});

test('invalid serialized policies fail closed without echoing their values', () => {
  for (const raw of ['', '{', 'null', '[]', 'true', '{"bash":"secret-value"}',
    '{"":true}', '{"bad\\u0000name":true}', JSON.stringify({ ['x'.repeat(257)]: true }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`tool${index}`, true])))]) {
    assert.throws(() => parseToolOverrides(raw), (error) => {
      assert.match(error.message, /PICALL_TOOL_OVERRIDES/);
      assert.ok(!error.message.includes('secret-value'));
      return true;
    });
  }
  assert.equal(Object.keys(parseToolOverrides()).length, 0);
  assert.equal(Object.keys(parseToolOverrides('{}')).length, 0);
});

function runtimeFixture(overrides, tools, initialActive) {
  const handlers = new Map();
  let active = [...initialActive];
  let metadata;
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
    on: (name, handler) => { handlers.set(name, handler); },
  };
  const previous = process.env.PICALL_TOOL_OVERRIDES;
  try {
    process.env.PICALL_TOOL_OVERRIDES = JSON.stringify(overrides);
    picallRuntimeExtension(pi);
  } finally {
    if (previous === undefined) delete process.env.PICALL_TOOL_OVERRIDES;
    else process.env.PICALL_TOOL_OVERRIDES = previous;
  }
  const context = { ui: { setStatus: (_name, value) => { metadata = JSON.parse(value); } } };
  return { handlers, context, tools, pi, get metadata() { return metadata; } };
}

test('runtime preserves native exposure and only activates explicit direct/model-only opt-ins', () => {
  const fixture = runtimeFixture({ optional: true, hidden: true, deferred: true, bash: true }, [
    { name: 'write', exposure: 'direct' },
    { name: 'bash', exposure: 'direct' },
    { name: 'web_search', exposure: 'direct', description: 'x'.repeat(1000) },
    { name: 'optional', exposure: 'model-only' },
    { name: 'idle', exposure: 'direct' },
    { name: 'hidden', exposure: 'hidden' },
    { name: 'deferred', exposure: 'deferred' },
  ], ['write', 'web_search']);
  fixture.handlers.get('session_start')({}, fixture.context);
  assert.deepEqual(fixture.pi.getActiveTools(), ['web_search', 'bash', 'optional']);
  assert.equal(fixture.metadata.toolDetails.find((tool) => tool.name === 'write').enabled, false);
  assert.equal(fixture.metadata.toolDetails.find((tool) => tool.name === 'idle').enabled, true);
  assert.equal(fixture.metadata.toolDetails.find((tool) => tool.name === 'idle').active, false);
  assert.equal(fixture.metadata.toolDetails.find((tool) => tool.name === 'web_search').description.length, 500);
  fixture.pi.setActiveTools(['write', 'web_search']);
  fixture.handlers.get('before_agent_start')({}, fixture.context);
  assert.ok(!fixture.pi.getActiveTools().includes('write'));
});

test('runtime gates nested and late-registered tools using current annotations', () => {
  const fixture = runtimeFixture({ edit: true }, [], []);
  const invoke = (toolName) => fixture.handlers.get('tool_call')({
    toolName, toolCallId: 'parent/1', parentToolCallId: 'parent', input: {},
  });
  assert.equal(invoke('write').block, true);
  assert.equal(invoke('bash').block, true);
  assert.equal(invoke('edit'), undefined);
  assert.equal(invoke('late_tool'), undefined);
  fixture.tools.push({ name: 'late_tool', annotations: { readOnlyHint: false }, exposure: 'deferred' });
  assert.equal(invoke('late_tool').block, true);
});

test('invalid worker policy prevents runtime registration and metadata reporting', () => {
  const previous = process.env.PICALL_TOOL_OVERRIDES;
  let registered = false;
  try {
    process.env.PICALL_TOOL_OVERRIDES = '{"bash":"invalid"}';
    assert.throws(() => picallRuntimeExtension({ on: () => { registered = true; } }),
      /PICALL_TOOL_OVERRIDES/);
    assert.equal(registered, false);
  } finally {
    if (previous === undefined) delete process.env.PICALL_TOOL_OVERRIDES;
    else process.env.PICALL_TOOL_OVERRIDES = previous;
  }
});
