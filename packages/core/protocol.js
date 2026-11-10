import { appError, EFFORTS } from './config.js';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => p?.type === 'text' && typeof p.text === 'string')) return content.map(p => p.text).join('\n');
  throw appError('Only text message content is supported.', 400, 'unsupported_content');
}
export function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw appError('Request body must be a JSON object.');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim())) throw appError('model must be a nonempty model ID.', 400, 'invalid_request', 'model');
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 500) throw appError('messages must contain 1–500 messages.');
  const messages = [];
  const system = [];
  for (const message of input.messages) {
    if (!message || !['user', 'assistant', 'system', 'developer'].includes(message.role) || message.tool_calls || message.function_call) throw appError('Supported message roles: system, developer, user, assistant. Pi manages tools internally.');
    const content = textContent(message.content);
    if (message.role === 'system' || message.role === 'developer') system.push(content);
    else messages.push({ role: message.role, content });
  }
  if (messages.at(-1)?.role !== 'user' || !messages.at(-1).content.trim()) throw appError('The final message must be a nonempty user message.');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') throw appError('stream must be a boolean.');
  if (input.n !== undefined && input.n !== 1) throw appError('Only n=1 is supported.');
  // Keep the existing text API's sampling-field compatibility policy.
  if (input.temperature !== undefined && input.temperature !== null &&
      (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
    throw appError('temperature must be a number between 0 and 2, or null.', 400, 'invalid_request', 'temperature');
  }
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'response_format', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'logprobs', 'top_logprobs', 'seed', 'presence_penalty', 'frequency_penalty', 'context_window', 'contextWindow']) {
    if (input[key] !== undefined && input[key] !== null) throw appError(`${key} is not supported by this research gateway.`, 400, 'unsupported_parameter', key);
  }
  if (input.reasoning_effort !== undefined && input.reasoning_effort !== null && input.reasoning_effort !== 'none' && !EFFORTS.includes(input.reasoning_effort)) throw appError('Unsupported reasoning_effort.');
  if (input.stream_options !== undefined && (!input.stream_options || typeof input.stream_options !== 'object' || Array.isArray(input.stream_options) || Object.keys(input.stream_options).some(k => k !== 'include_usage') || (input.stream_options.include_usage !== undefined && typeof input.stream_options.include_usage !== 'boolean'))) throw appError('Only stream_options.include_usage (boolean) is supported.');
  return { messages, systemPrompt: system.join('\n\n'), hasSystemPrompt: system.length > 0 };
}
export function openAIModel(model) {
  return { id: model.id, object: 'model', created: 0, owned_by: model.provider,
    name: model.name, context_window: model.contextWindow ?? null, max_output_tokens: model.maxTokens,
    reasoning: model.reasoning, supported_reasoning_efforts: model.reasoningEfforts, input_modalities: model.input };
}
