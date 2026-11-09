import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fingerprint } from './run-index.js';

const fields = ['modelBaseUrl', 'modelApiKey', 'defaultModel', 'modelContextWindow', 'modelMaxTokens', 'enableResearch',
  'maxToolRounds', 'requestTimeoutSeconds', 'additionalSystemPrompt', 'toolOverrides', 'braveApiKey', 'tavilyApiKey',
  'tinyfishApiKey', 'exaApiKey', 'jinaApiKey', 'braveBaseUrl', 'tavilyBaseUrl', 'httpTools'];
export const configFingerprint = config => fingerprint(Object.fromEntries(fields.map(field => [field, config[field] ?? null])));
export function modelInfo(config) {
  return { id: `picall/${config.defaultModel}`, provider: 'picall', name: config.defaultModel, contextWindow: config.modelContextWindow,
    maxTokens: config.modelMaxTokens, reasoning: false, reasoningEfforts: ['off'], input: ['text'] };
}
export function createModelRuntime(config, guard) {
  const model = { id: config.defaultModel, name: config.defaultModel, provider: 'picall', api: 'openai-completions',
    baseUrl: config.modelBaseUrl, reasoning: false, input: ['text'], contextWindow: config.modelContextWindow, maxTokens: config.modelMaxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(createProvider({ id: 'picall', models: [model], baseUrl: config.modelBaseUrl,
    auth: { apiKey: { name: 'PiCall configured key', resolve: async () => config.modelApiKey ? { auth: { apiKey: config.modelApiKey } } : undefined } },
    api: Object.fromEntries([['stream', stream], ['streamSimple', streamSimple]].map(([name, send]) => [name, (model, context, options) => {
      guard();
      const source = send(model, context, { ...options, maxTokens: config.modelMaxTokens, maxRetries: 0 });
      const safe = new AssistantMessageEventStream();
      const sanitize = message => {
        if (!message) return message;
        const result = { ...message };
        if (result.response) result.response = { status: result.response.status };
        if (result.errorMessage) {
          const status = /\b(401|402|403|408|429|5\d\d)\b/.exec(result.errorMessage)?.[1];
          result.errorMessage = status ? `Upstream model request failed (HTTP ${status})${status === '429' ? ': rate limit' : ''}.` : 'Upstream model network request failed.';
        }
        return result;
      };
      void (async () => {
        try {
          for await (const event of source) safe.push({ ...event, ...(event.partial ? { partial: sanitize(event.partial) } : {}),
            ...(event.message ? { message: sanitize(event.message) } : {}), ...(event.error ? { error: sanitize(event.error) } : {}) });
          safe.end(sanitize(await source.result()));
        } catch {
          const error = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'error',
            timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, errorMessage: 'Upstream model network request failed.' };
          safe.push({ type: 'error', reason: 'error', error }); safe.end(error);
        }
      })();
      return safe;
    }])),
  }));
  return models;
}
