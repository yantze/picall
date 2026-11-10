import { createAI } from 'agents/models/pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { fail } from './core';
import { createModels } from '@earendil-works/pi-ai/models';
import { createModelRuntime as openai, sanitizedStream, modelInfo } from '../../../packages/core/openai.js';
import type { CloudConfig } from './management';

export function configuredRuntime(env: ModelEnv, config: CloudConfig, guard: () => void) {
  if (config.modelProvider === 'openai-compatible') {
    const models = openai(config, guard);
    return { models, model: models.getModel('picall', config.defaultModel)! };
  }
  const runtime = createModelRuntime({ ...env, MODEL:config.defaultModel, AI_GATEWAY_ID:config.aiGatewayId, BYOK_ALIAS:config.byokAlias }, guard,
    {maxTokens:config.modelMaxTokens,contextWindow:config.modelContextWindow});
  const models = createModels(); models.setProvider(runtime.provider);
  return { models, model:runtime.model };
}
export function configuredModelInfo(env:ModelEnv,config:CloudConfig) {
  if(config.modelProvider==='openai-compatible')return modelInfo(config);
  const {model}=configuredRuntime(env,config,()=>{});
  return modelInfo({...config,modelMaxTokens:model.maxTokens,modelContextWindow:model.contextWindow});
}

export type ModelEnv = Pick<WorkerBindings, 'AI' | 'MODEL'> & {
  AI_GATEWAY_ID?: string;
  BYOK_ALIAS?: string;
};
export function supportsModel(id: string) {
  return (
    id.startsWith('@cf/') || id === 'deepseek-flash' || id === 'deepseek-v4-pro'
  );
}
export function createModelRuntime(env: ModelEnv, guard = () => {}, limits?:{maxTokens:number;contextWindow:number}) {
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
    byokAlias: native ? (env.BYOK_ALIAS || 'default') : undefined,
  });
  if (!native) {
    const sourceModel=ai(env.MODEL);
    const model=ai({...sourceModel,maxTokens:Math.min(limits?.maxTokens ?? sourceModel.maxTokens,sourceModel.maxTokens),contextWindow:Math.min(limits?.contextWindow ?? sourceModel.contextWindow,sourceModel.contextWindow)});
    const source = ai.provider;
    const provider = createProvider({ id:source.id, models:[model], auth:source.auth, api:{
      stream:(model,context,options)=>{guard();return sanitizedStream(ai.stream(model,context,{...options,maxTokens:Math.min(options?.maxTokens ?? model.maxTokens,model.maxTokens),maxRetries:0}),model);},
      streamSimple:(model,context,options)=>{guard();return sanitizedStream(ai.streamSimple(model,context,{...options,maxTokens:Math.min(options?.maxTokens ?? model.maxTokens,model.maxTokens),maxRetries:0}),model);},
    }});
    return { model, provider };
  }

  // DeepSeek is not in this pinned version's Gateway unified-billing catalog.
  // Its vendor model preserves Pi's native wire metadata and uses AI.fetch
  // through the named gateway, which supplies the stored BYOK credential.
  const source =
    DEEPSEEK_MODELS[env.MODEL as 'deepseek-flash' | 'deepseek-v4-pro'];
  const model = ai({ ...source, maxTokens:Math.min(limits?.maxTokens ?? 8192,source.maxTokens),contextWindow:Math.min(limits?.contextWindow ?? source.contextWindow,source.contextWindow) });
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
      stream: (model, context, options) => { guard(); return sanitizedStream(ai.stream(model, context, {
          ...options, maxRetries:0,
          maxTokens: Math.min(options?.maxTokens ?? model.maxTokens,model.maxTokens),
          headers: headers(options?.headers),
        }),model); },
      streamSimple: (model, context, options) => { guard(); return sanitizedStream(ai.streamSimple(model, context, {
          ...options, maxRetries:0,
          maxTokens: Math.min(options?.maxTokens ?? model.maxTokens,model.maxTokens),
          headers: headers(options?.headers),
        }),model); },
    },
  });
  return { model, provider };
}
