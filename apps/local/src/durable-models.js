import { fingerprint } from './run-index.js';
export { createModelRuntime, modelInfo } from '../../../packages/core/openai.js';
const fields = ['modelBaseUrl', 'modelApiKey', 'defaultModel', 'modelContextWindow', 'modelMaxTokens', 'enableResearch',
  'maxToolRounds', 'requestTimeoutSeconds', 'additionalSystemPrompt', 'toolOverrides', 'braveApiKey', 'tavilyApiKey',
  'tinyfishApiKey', 'exaApiKey', 'jinaApiKey', 'braveBaseUrl', 'tavilyBaseUrl', 'httpTools'];
export const configFingerprint = config => fingerprint(Object.fromEntries(fields.map(field => [field, config[field] ?? null])));
