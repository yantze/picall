#!/usr/bin/env node
// Deterministic JSONL Pi RPC peer. It never contacts a model provider.
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('1.4.0');
  process.exit(0);
}

const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
let selectedModel = argument('--model', 'fake/fake-model');
let thinkingLevel = argument('--thinking', selectedModel === 'fake/plain-model' ? 'off' : 'medium');
// Report persistence metadata without creating a session file in this fixture.
const sessionFile = process.argv.includes('--no-session') ? null : join(process.cwd(), `fake-session-${process.pid}.jsonl`);
let turn = 0;
let running = false;
let pendingTimer;
const model = (id = selectedModel.startsWith('fake/') ? selectedModel.slice(5) : selectedModel) => ({
  id,
  provider: 'fake',
  name: 'Fake Model',
  contextWindow: id === 'plain-model' ? 8192 : 32000,
  maxTokens: id === 'plain-model' ? 1024 : 4096,
  reasoning: id !== 'plain-model',
  ...(id === 'limited-model' ? { thinkingLevelMap: { minimal: null, medium: null, xhigh: 'xhigh' } } : {}),
  input: ['text'],
});
const emit = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
const response = (command, data = {}, success = true, error) => emit({
  type: 'response', id: command.id, command: command.type, success, data, ...(error ? { error } : {}),
});
const message = (text) => ({
  role: 'assistant', content: [{ type: 'text', text }],
  provider: 'fake', model: model().id, api: 'openai-completions',
  stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

function handle(command) {
  switch (command.type) {
    case 'get_available_models':
      response(command, { models: ['fake-model', 'plain-model', 'limited-model'].map(id => model(id)) });
      break;
    case 'get_available_thinking_levels':
      response(command, { levels: model().id === 'plain-model' ? ['off'] : model().id === 'limited-model'
        ? ['off', 'low', 'high', 'xhigh'] : ['off', 'minimal', 'low', 'medium', 'high'] });
      break;
    case 'get_state':
      emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'picall_runtime',
        statusText: JSON.stringify({ activeTools: ['read', 'bash'], availableTools: ['read', 'bash', 'fixture_inactive'] }) });
      response(command, { model: model(), thinkingLevel, isStreaming: running, sessionId: `fake-${process.pid}`, sessionFile, messages: [] });
      break;
    case 'set_model':
      selectedModel = `${command.provider}/${command.modelId}`;
      response(command, model());
      break;
    case 'set_thinking_level':
      thinkingLevel = command.level;
      response(command, { level: thinkingLevel });
      break;
    case 'abort':
      clearTimeout(pendingTimer);
      running = false;
      response(command);
      emit({ type: 'agent_settled', messages: [] });
      break;
    case 'prompt': {
      if (running) {
        response(command, {}, false, 'Agent already running');
        break;
      }
      running = true;
      turn += 1;
      response(command, { disposition: 'started' });
      emit({ type: 'agent_start' });
      const prompt = String(command.message || '');
      pendingTimer = setTimeout(() => {
        if (!running) return;
        if (prompt.includes('TOOL_EVENTS:')) {
          emit({ type: 'tool_execution_start', toolName: 'web_probe', toolCallId: 'fixture-tool-call',
            args: { query: 'PICALL_PRIVATE_TOOL_QUERY' } });
          emit({ type: 'tool_execution_update', toolName: 'web_probe', toolCallId: 'fixture-tool-call',
            partialResult: { content: [{ type: 'text', text: 'PICALL_PRIVATE_TOOL_RESULT' }] } });
          emit({ type: 'tool_execution_end', toolName: 'web_probe', toolCallId: 'fixture-tool-call',
            isError: prompt.includes('TOOL_FAIL'), result: { content: [{ type: 'text', text: 'PICALL_PRIVATE_TOOL_RESULT' }] } });
        }
        if (prompt.includes('FAIL_PROVIDER:')) {
          emit({ type: 'message_end', message: { ...message(''), stopReason: 'error', errorMessage: 'Fake provider failed' } });
          running = false;
          emit({ type: 'agent_settled', messages: [] });
          return;
        }
        const metadata = prompt.includes('REQUEST_METADATA:');
        const first = metadata ? JSON.stringify({ model: selectedModel, effort: thinkingLevel,
          explicitEffort: process.argv.includes('--thinking'), contextWindow: model().contextWindow }) : 'Hello';
        const second = metadata ? '' : prompt.includes('UNICODE:') ? ' line\u2028paragraph\u2029end' : ` from Pi (turn ${turn})`;
        emit({ type: 'message_start', message: message('') });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: first }, message: message(first) });
        // An agent_end is not final: Pi can continue after compaction/retries.
        emit({ type: 'agent_end', messages: [message(first)] });
        pendingTimer = setTimeout(() => {
          if (!running) return;
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: second }, message: message(first + second) });
          emit({ type: 'message_end', message: message(first + second) });
          running = false;
          emit({ type: 'agent_settled', messages: [message(first + second)] });
        }, 15);
      }, prompt.includes('SLOW:') ? 300 : 5);
      break;
    }
    default:
      response(command, {}, false, `Unsupported fake command: ${command.type}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  clearTimeout(pendingTimer);
  process.exit(0);
});
