import { randomUUID } from 'node:crypto';
import { createResearchTools, researchSystemPrompt } from '../web/tools.js';

// This extension is bundled with PiCall and is loaded even when external Pi
// extensions are disabled. It never reads or modifies a user's Pi profile.
export function installLocalResearch(pi) {
  const config = JSON.parse(process.env.PICALL_LOCAL_CONFIG || '{}');
  if (config.modelApiKey && config.modelBaseUrl && config.defaultModel) {
    pi.registerProvider('picall', {
      name: 'PiCall configured endpoint',
      baseUrl: config.modelBaseUrl,
      api: 'openai-completions',
      // Environment interpolation treats arbitrary user keys as literal values:
      // a leading ! or $ inside the key must never become command syntax.
      apiKey: '$PICALL_MODEL_API_KEY',
      models: [{
        id: config.defaultModel, name: config.defaultModel, reasoning: false,
        input: ['text'], contextWindow: config.modelContextWindow || 131072,
        maxTokens: config.modelMaxTokens || 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
      }],
    });
  }

  const cache = new Map();
  let run = { id: randomUUID(), deadline: 0 };
  let turn = 0;
  let countedTurn = -1;
  let rounds = 0;
  let active = false;
  const maxRounds = config.maxToolRounds || 8;
  const scope = async () => run;
  const research = config.enableResearch === true ? createResearchTools(config, {
    scope,
    store: { get: async key => cache.get(key), put: async (key, value) => { cache.set(key, value); } },
  }) : null;

  for (const tool of research?.tools || []) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: tool.parameters,
    annotations: { readOnlyHint: true },
    async execute(_id, args, signal) {
      try {
        const result = await tool.execute(args, signal);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'tool_error';
        // Do not leak provider payloads or credentials through model errors.
        return { content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }], isError: true };
      }
    },
  });

  pi.on('before_agent_start', event => {
    // Automatic retry/recovery may start another low-level agent run before
    // settlement. Its budget and cache belong to the same HTTP prompt.
    if (!active) {
      run = { id: randomUUID(), deadline: Date.now() + (config.requestTimeoutSeconds || 300) * 1000 };
      cache.clear();
      turn = 0;
      countedTurn = -1;
      rounds = 0;
      active = true;
    }
    if (research) return { systemPrompt: `${event.systemPrompt}\n\n${researchSystemPrompt()}` };
  });
  pi.on('agent_settled', () => { active = false; });
  pi.on('turn_start', () => { turn++; });
  pi.on('tool_call', (_event, ctx) => {
    if (countedTurn !== turn) { rounds++; countedTurn = turn; }
    const code = Date.now() >= run.deadline ? 'deadline_exceeded' : rounds > maxRounds ? 'turn_limit' : null;
    if (code) {
      ctx.ui.setStatus('picall_failure', JSON.stringify({ code }));
      ctx.abort();
      return { block: true, reason: code };
    }
  });
}
