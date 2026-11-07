import { createAI } from 'agents/models/pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { fail } from './core';

export type ModelEnv = Pick<WorkerBindings, 'AI' | 'MODEL'> & {
  AI_GATEWAY_ID?: string;
};
export function supportsModel(id: string) {
  return (
    id.startsWith('@cf/') || id === 'deepseek-flash' || id === 'deepseek-v4-pro'
  );
}
export function createModelRuntime(env: ModelEnv) {
  if (!supportsModel(env.MODEL)) fail('unsupported_model_configuration', 503);
  const native =
    env.MODEL === 'deepseek-flash' || env.MODEL === 'deepseek-v4-pro';
  if (native && !env.AI_GATEWAY_ID) fail('ai_gateway_required', 503);
  const gateway = env.AI_GATEWAY_ID || 'default';
  if (!/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(gateway) || gateway.length > 64)
    fail('invalid_ai_gateway', 503);
  const ai = createAI({
    binding: env.AI,
    id: gateway,
    byokAlias: native ? 'default' : undefined,
  });
  if (!native) return { model: ai(env.MODEL), provider: ai.provider };

  // DeepSeek is not in this pinned version's Gateway unified-billing catalog.
  // Its vendor model preserves Pi's native wire metadata and uses AI.fetch
  // through the named gateway, which supplies the stored BYOK credential.
  const source =
    DEEPSEEK_MODELS[env.MODEL as 'deepseek-flash' | 'deepseek-v4-pro'];
  const model = ai({ ...source, maxTokens: 8192 });
  const headers = (extra?: Record<string, string | null>) => ({
    ...extra,
    'cf-aig-no-wholesale': 'true',
  });
  const provider = createProvider({
    id: model.provider,
    name: 'DeepSeek via Cloudflare AI Gateway',
    models: [model],
    auth: ai.provider.auth,
    api: {
      stream: (model, context, options) =>
        ai.stream(model, context, {
          ...options,
          maxTokens: Math.min(options?.maxTokens ?? 8192, 8192),
          headers: headers(options?.headers),
        }),
      streamSimple: (model, context, options) =>
        ai.streamSimple(model, context, {
          ...options,
          maxTokens: Math.min(options?.maxTokens ?? 8192, 8192),
          headers: headers(options?.headers),
        }),
    },
  });
  return { model, provider };
}
