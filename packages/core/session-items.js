import { SECRET_FIELDS, appError } from './config.js';

export function itemPagination(params) {
  const number = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw appError(`Invalid ${name}.`, 400, 'invalid_request');
    return value;
  };
  return { after: number('after', 0, 0, Number.MAX_SAFE_INTEGER), limit: number('limit', 50, 1, 100) };
}

// Only application-derived prefixes may be passed here; all user values are bound.
export function itemQuery(prefix) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) throw new Error('Invalid storage prefix');
  return `SELECT e.record, t.record AS task FROM ${prefix}entries e LEFT JOIN ${prefix}tasks t
    ON t.id=json_extract(e.record,'$.byTaskId') WHERE e.id>? ORDER BY e.id LIMIT ?`;
}

export function itemPage(rows, { limit }, config = {}) {
  const secrets = SECRET_FIELDS.map(field => config[field]).filter(value => typeof value === 'string' && value.length);
  const redact = value => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;
  const items = rows.slice(0, limit).map(row => {
    const entry = JSON.parse(row.record), task = row.task ? JSON.parse(row.task) : null;
    const startedAt = timestamp(task?.startedAt), endedAt = timestamp(task?.endedAt);
    return {
      id: entry.id, conversationId: entry.conversationId, kind: entry.kind, taskId: entry.byTaskId ?? null,
      messages: redact(entry.model || []),
      timestamp: timestamp(entry.model?.find(message => timestamp(message.timestamp))?.timestamp) ?? startedAt,
      startedAt, endedAt, durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      taskStatus: task?.state?.status ?? null,
    };
  });
  return { items, nextCursor: rows.length > limit ? items.at(-1).id : null };
}
