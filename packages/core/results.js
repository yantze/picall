export function usageDelta(before, after) {
  const result = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, models: {} };
  for (const [key, value] of Object.entries(after?.models || {})) {
    const old = before?.models?.[key] || {}, diff = {};
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) diff[field] = Math.max(0, (value[field] || 0) - (old[field] || 0));
    if (value.cost?.source || value.cost?.total > 0) diff.cost = { total: Math.max(0, (value.cost.total || 0) - (old.cost?.total || 0)), source: value.cost.source || 'catalog_estimate' };
    result.prompt_tokens += diff.input + diff.cacheRead + diff.cacheWrite;
    result.completion_tokens += diff.output;
    result.models[key] = diff;
  }
  result.total_tokens = result.prompt_tokens + result.completion_tokens;
  return result;
}
export function inspectAnswer(answer, deadline) {
  if (answer?.timestamp > deadline) return { error: 'request_timeout' };
  if (!answer || answer.stopReason !== 'stop' || answer.content.some(part => part.type === 'toolCall')) return { error: answer?.stopReason === 'length' ? 'output_limit' : 'unanswered' };
  const content = answer.content.filter(part => part.type === 'text').map(part => part.text).join('');
  return content.trim() ? { content } : { error: 'unanswered' };
}
export function completion(id, model, content, usage, createdAt) {
  return { id, object: 'chat.completion', created: Math.floor(createdAt / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage };
}
