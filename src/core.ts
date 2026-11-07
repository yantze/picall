export class Fault extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function fail(code: string, status = 400): never {
  throw new Fault(code, status);
}
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers });
export function errorResponse(e: unknown) {
  return json(
    {
      error: {
        code: e instanceof Fault ? e.code : 'internal_error',
        message: e instanceof Fault ? e.code : 'Internal service error',
      },
    },
    e instanceof Fault ? e.status : 500,
  );
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
    fail('json_required', 415);
  const reader = request.body?.getReader();
  if (!reader) fail('invalid_body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024 * 1024) {
      await reader.cancel();
      fail('body_too_large', 413);
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
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail('invalid_json');
  }
}
export async function history(
  input: Input,
  previous?: { hashes: string[]; system: string; model: string },
) {
  let messages = input.messages;
  if (previous) {
    if (
      previous.model !== input.model ||
      (input.system !== undefined && input.system !== previous.system)
    )
      fail('session_configuration_conflict', 409);
    if (messages.length > 1) {
      const prefix = await Promise.all(messages.slice(0, -1).map(hash));
      if (JSON.stringify(prefix) !== JSON.stringify(previous.hashes))
        fail('session_history_conflict', 409);
      messages = messages.slice(-1);
    }
  }
  return { messages, system: input.system ?? previous?.system ?? '' };
}
export function completion(
  id: string,
  model: string,
  text: string,
  usage: unknown,
  created: number,
) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(created / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}
export function usageDelta(current: any, before: any) {
  let input = 0,
    output = 0;
  const models: Record<string, unknown> = {};
  for (const [name, u] of Object.entries(current.models || {}) as [
    string,
    any,
  ][]) {
    const b = before?.models?.[name] || {};
    const d: any = {};
    for (const k of [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'totalTokens',
    ])
      d[k] = (u[k] || 0) - (b[k] || 0);
    d.cost = {
      total: (u.cost?.total || 0) - (b.cost?.total || 0),
      source: u.cost?.source || 'catalog_estimate',
    };
    input += d.input + d.cacheRead + d.cacheWrite;
    output += d.output;
    models[name] = d;
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    models,
  };
}
