import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../src/pi-rpc.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'picall-tool-policy-'));
  const profile = join(root, 'profile');
  const workdir = join(root, 'project');
  const extensions = join(workdir, '.pi', 'extensions');
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  const state = { root, profile, workdir, extensions, requests: [], toolCalls: [], extraRuntimes: [] };
  let runtime;
  const server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      state.requests.push(data);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-tool-policy-test', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'policy-test',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      chunk({ role: 'assistant' });
      if (!data.messages.some(message => message.role === 'tool') && state.toolCalls.length) {
        chunk({ tool_calls: state.toolCalls.map((call, index) => ({
          index, id: `fixture_call_${index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })) });
        chunk({}, 'tool_calls');
      } else {
        chunk({ content: 'Tool policy fixture completed.' });
        chunk({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  t.after(async () => {
    await Promise.all([runtime?.close(), ...state.extraRuntimes.map(item => item.close())]);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(profile, { recursive: true });
  await mkdir(extensions, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(profile, 'models.json'), JSON.stringify({ providers: { 'picall-test': {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-fixture',
    models: [{ id: 'policy-test', name: 'Tool Policy Test', contextWindow: 32_000, maxTokens: 1024,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });
  process.env.PI_CODING_AGENT_DIR = profile;
  state.config = { workdir, projectTrust: 'allow', requestTimeoutSeconds: 20 };
  runtime = new PiRuntime({ getConfig: () => state.config });
  state.runtime = runtime;
  state.acquire = (options = {}) => runtime.acquire({ model: 'picall-test/policy-test', effort: 'off', ...options });
  return state;
}

async function absent(path, explanation) {
  await assert.rejects(readFile(path), { code: 'ENOENT' }, explanation);
}

test('default command and mutation tools are unavailable and explicit overrides permit real temporary writes', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const writePath = join(f.workdir, 'direct-write.txt');
  const bashPath = join(f.workdir, 'direct-bash.txt');
  const editPath = join(f.workdir, 'direct-edit.txt');
  const powershellPath = join(f.workdir, 'direct-powershell.txt');
  await writeFile(editPath, 'ORIGINAL');
  await writeFile(join(f.extensions, 'command-probe.js'), `import { writeFileSync } from 'node:fs';
    export default function(pi) {
      pi.registerTool({ name: 'powershell', label: 'PowerShell fixture', description: 'Command fixture.',
        parameters: { type: 'object', properties: {} },
        async execute() { writeFileSync(${JSON.stringify(powershellPath)}, 'POWERSHELL_RAN'); return { content: [{ type: 'text', text: 'done' }] }; }
      });
    }\n`);
  f.toolCalls = [
    { name: 'write', args: { path: writePath, content: 'WRITE_ALLOWED' } },
    { name: 'bash', args: { command: `printf 'BASH_ALLOWED' > '${bashPath.replace(/'/g, "'\\''")}'` } },
    { name: 'edit', args: { path: editPath, oldText: 'ORIGINAL', newText: 'EDIT_RAN' } },
    { name: 'powershell', args: {} },
  ];
  const denied = await f.acquire();
  for (const name of ['write', 'edit', 'bash', 'powershell']) {
    assert.ok(denied.snapshot.availableTools.includes(name), `${name} must remain visible in the tool catalog`);
    assert.ok(!denied.snapshot.tools.includes(name), `${name} must not be active by default`);
    const details = denied.snapshot.toolDetails.find(tool => tool.name === name);
    assert.equal(details.enabled, false);
    assert.equal(details.active, false);
    assert.equal(details.defaultEnabled, false);
  }
  await denied.run('Exercise the local fixture tools.');
  const firstRequest = f.requests[0];
  for (const name of ['write', 'edit', 'bash', 'powershell']) {
    assert.ok(!firstRequest.tools.some(tool => tool.function?.name === name), `${name} must not be declared to the model`);
  }
  await absent(writePath, 'a model that requests a disabled write must not create a file');
  await absent(bashPath, 'a model that requests disabled bash must not execute the command');
  await absent(powershellPath, 'a model that requests disabled PowerShell must not execute it');
  assert.equal(await readFile(editPath, 'utf8'), 'ORIGINAL');
  await f.runtime.closeSession(denied.id);

  f.config.toolOverrides = { write: true, bash: true };
  f.toolCalls = f.toolCalls.slice(0, 2);
  const enabled = await f.acquire();
  assert.ok(enabled.snapshot.tools.includes('write'));
  assert.ok(enabled.snapshot.tools.includes('bash'));
  await enabled.run('Exercise the explicitly enabled local tools.');
  assert.equal(await readFile(writePath, 'utf8'), 'WRITE_ALLOWED');
  assert.equal(await readFile(bashPath, 'utf8'), 'BASH_ALLOWED');
  assert.equal(await readFile(editPath, 'utf8'), 'ORIGINAL');
});

test('a read-only parent tool cannot bypass a disabled nested write', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const nestedPath = join(f.workdir, 'nested-write.txt');
  await writeFile(join(f.extensions, 'parent-probe.js'), `export default function(pi) {
    pi.registerTool({ name: 'parent_probe', label: 'Read-only parent fixture', description: 'Read-only fixture that requests a nested operation.',
      annotations: { readOnlyHint: true }, parameters: { type: 'object', properties: {} },
      async execute(_id, _args, signal, _update, ctx) {
        const outcome = await ctx.executeTool('write', { path: ${JSON.stringify(nestedPath)}, content: 'NESTED_WRITE_ALLOWED' }, { signal });
        return { content: [{ type: 'text', text: JSON.stringify({ nestedError: outcome.isError, result: outcome.result.content }) }] };
      }
    });
  }\n`);
  f.toolCalls = [{ name: 'parent_probe', args: {} }];
  const denied = await f.acquire();
  assert.ok(denied.snapshot.tools.includes('parent_probe'));
  assert.ok(!denied.snapshot.tools.includes('write'));
  assert.ok(denied.snapshot.availableTools.includes('write'));
  await denied.run('Run the parent fixture.');
  await absent(nestedPath, 'nested ctx.executeTool calls must pass through the same permission check');
  assert.ok(f.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('"nestedError":true')));
  await f.runtime.closeSession(denied.id);

  f.config.toolOverrides = { write: true };
  const enabled = await f.acquire();
  await enabled.run('Run the parent fixture with write explicitly enabled.');
  assert.equal(await readFile(nestedPath, 'utf8'), 'NESTED_WRITE_ALLOWED');
  assert.ok(f.requests.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('"nestedError":false')));

  await writeFile(nestedPath, 'PARENT_DISABLED_SENTINEL');
  f.config.toolOverrides = { write: true, parent_probe: false };
  const parentDisabled = await f.acquire();
  assert.ok(parentDisabled.snapshot.availableTools.includes('parent_probe'));
  assert.ok(!parentDisabled.snapshot.tools.includes('parent_probe'));
  const details = parentDisabled.snapshot.toolDetails.find(tool => tool.name === 'parent_probe');
  assert.equal(details.defaultEnabled, true);
  assert.equal(details.enabled, false);
  await parentDisabled.run('Try the explicitly disabled parent fixture.');
  assert.equal(await readFile(nestedPath, 'utf8'), 'PARENT_DISABLED_SENTINEL');
});

test('disabled extensions are never imported while permitted MCP and the internal runtime keep working', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const topLevelCanary = join(f.root, 'top-level-import.txt');
  const factoryCanary = join(f.root, 'factory-run.txt');
  const selectedExtension = join(f.extensions, 'canary-extension.js');
  await writeFile(selectedExtension, `import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(topLevelCanary)}, 'imported\\n');
    export default function(pi) {
      appendFileSync(${JSON.stringify(factoryCanary)}, 'factory\\n');
      pi.registerTool({ name: 'extension_canary_probe', label: 'Canary fixture', description: 'Read-only fixture tool.',
        annotations: { readOnlyHint: true }, parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'canary fixture' }] }; }
      });
    }\n`);
  const mcpFixture = join(f.root, 'mcp-fixture.mjs');
  await writeFile(mcpFixture, `import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin });
    lines.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'picall-fixture', version: '1.0.0' } };
      else if (request.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Read-only fixture ping.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
      else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'MCP_FIXTURE_OK' }] };
      else result = {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  await writeFile(join(f.profile, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [mcpFixture], exposure: 'direct', timeout: 5,
  } } }));
  f.config.extensionOverrides = { [selectedExtension]: false };
  const diagnostic = await f.runtime.check();
  assert.equal(diagnostic.available, true, diagnostic.error);
  assert.ok(diagnostic.availableTools.includes('read'));
  assert.ok(!diagnostic.availableTools.includes('extension_canary_probe'));
  await f.runtime.models();
  await absent(topLevelCanary, 'discovery must not import a disabled extension');
  await absent(factoryCanary, 'a disabled extension factory must not run');
  f.toolCalls = [{ name: 'mcp__fixture__ping', args: {} }];
  const mcpSession = await f.acquire();
  await mcpSession.run('Run the local MCP ping fixture.');
  assert.ok(f.requests[0].tools.some(tool => tool.function?.name === 'mcp__fixture__ping'));
  assert.ok(f.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('MCP_FIXTURE_OK')));
  await absent(topLevelCanary);
  await absent(factoryCanary);
  await f.runtime.closeSession(mcpSession.id);

  f.config.extensionOverrides = { [selectedExtension]: true };
  const enabled = await f.acquire();
  assert.ok(enabled.snapshot.availableTools.includes('extension_canary_probe'));
  assert.ok((await readFile(topLevelCanary, 'utf8')).length > 0);
  assert.ok((await readFile(factoryCanary, 'utf8')).length > 0);
  await f.runtime.close();
  const topLevelBeforeDisable = await readFile(topLevelCanary, 'utf8');
  const factoryBeforeDisable = await readFile(factoryCanary, 'utf8');
  f.config.enableExtensions = false;
  const disabledRuntime = new PiRuntime({ getConfig: () => f.config });
  f.extraRuntimes.push(disabledRuntime);
  const onlyInternal = await disabledRuntime.check();
  assert.equal(onlyInternal.available, true, onlyInternal.error);
  assert.ok(onlyInternal.availableTools.includes('read'));
  assert.ok(!onlyInternal.availableTools.includes('extension_canary_probe'));
  assert.ok(!onlyInternal.availableTools.includes('codemode'));
  assert.ok(!onlyInternal.availableTools.includes('tool_search'));
  assert.equal(await readFile(topLevelCanary, 'utf8'), topLevelBeforeDisable, 'master-disable must prevent module import');
  assert.equal(await readFile(factoryCanary, 'utf8'), factoryBeforeDisable, 'master-disable must prevent factory execution');
});
