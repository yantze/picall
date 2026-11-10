import { Fault, fail } from '../../../packages/tools/errors.js';
export { Fault, fail } from '../../../packages/tools/errors.js';
import { usageDelta as delta } from '../../../packages/core/results.js';
import { continueHistory } from '../../../packages/core/history.js';
import { appError } from '../../../packages/core/config.js';
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers });
export function errorResponse(error: unknown) {
  const e=error as {status?:number;code?:string;message?:string;param?:string};
  const status=e.status || 500, code=e.code || 'internal_error';
  return json({error:{code,message:e.code ? e.message || code : 'Internal service error',type:status===401?'authentication_error':status<500?'invalid_request_error':'api_error',param:e.param ?? null}},status);
}
export async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export type Message = { role: 'user' | 'assistant'; content: string };
export type Input = {
  messages: Message[];
  system?: string;
  model: string;
  stream: boolean;
  includeUsage: boolean;
};
export function normalize(raw: any, model: string, asyncRun = false): Input {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail('invalid_body');
  for (const k of [
    'tools',
    'tool_choice',
    'functions',
    'function_call',
    'response_format',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'stop',
    'seed',
    'presence_penalty',
    'frequency_penalty',
    'logprobs',
    'top_logprobs',
    'reasoning_effort',
  ])
    if (raw[k] != null) fail('unsupported_parameter');
  if (raw.n != null && raw.n !== 1) fail('unsupported_n');
  if (
    raw.temperature != null &&
    (typeof raw.temperature !== 'number' ||
      raw.temperature < 0 ||
      raw.temperature > 2)
  )
    fail('invalid_temperature');
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean')
    fail('invalid_stream');
  if (
    raw.stream_options !== undefined &&
    (!raw.stream_options ||
      typeof raw.stream_options !== 'object' ||
      Object.keys(raw.stream_options).some((k) => k !== 'include_usage') ||
      (raw.stream_options.include_usage !== undefined &&
        typeof raw.stream_options.include_usage !== 'boolean'))
  )
    fail('invalid_stream_options');
  if (raw.model !== undefined && raw.model !== model)
    fail('model_not_found', 404);
  const list = asyncRun
    ? [{ role: 'user', content: raw.prompt }]
    : raw.messages;
  if (!Array.isArray(list) || !list.length || list.length > 500)
    fail('invalid_messages');
  const messages: Message[] = [],
    system: string[] = [];
  for (const m of list) {
    if (
      !m ||
      m.tool_calls ||
      m.function_call ||
      !['user', 'assistant', 'system', 'developer'].includes(m.role)
    )
      fail('invalid_message');
    let content = m.content;
    if (
      Array.isArray(content) &&
      content.every((p) => p?.type === 'text' && typeof p.text === 'string')
    )
      content = content.map((p) => p.text).join('\n');
    if (typeof content !== 'string') fail('unsupported_content');
    if (['system', 'developer'].includes(m.role)) system.push(content);
    else messages.push({ role: m.role, content });
  }
  if (messages.at(-1)?.role !== 'user' || !messages.at(-1)?.content.trim())
    fail('invalid_final_message');
  return {
    messages,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    model,
    stream: !!raw.stream,
    includeUsage: !!raw.stream_options?.include_usage,
  };
}
export async function readBody(request: Request) {
  if (
    !/^application\/json(?:;|$)/i.test(
      request.headers.get('content-type') || '',
    )
  )
    throw appError('Content-Type must be application/json.',415);
  const reader = request.body?.getReader();
  if (!reader) throw appError('Request body must be a JSON object.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw appError('Request body exceeds 1 MiB.',413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw appError('Request body must be a JSON object.');
  }
}
export async function history(
  input: Input,
  previous?: { hashes: string[]; system: string; model: string },
): Promise<{ messages:Message[]; system:string }> {
  return continueHistory(input, previous, await Promise.all(input.messages.slice(0, -1).map(hash)));
}
export { completion } from '../../../packages/core/results.js';
export function usageDelta(current: any, before: any) { return delta(before, current); }
