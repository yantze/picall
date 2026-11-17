const $ = id => document.getElementById(id);
const id = decodeURIComponent(location.pathname.slice('/sessions/'.length));
$('session-id').textContent = id;
document.title = `${id} · 会话记录 · PiCall`;
$('time-heading').textContent = `记录时间（${Intl.DateTimeFormat().resolvedOptions().timeZone}）/ 执行耗时`;
let pages = 1, busy = false, timer, previous = '';
const nodes = new Map();

function preview(item) {
  const parts = item.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content || []).map(part => {
    if (part.type === 'toolCall') return `${part.name}(${JSON.stringify(part.arguments)})`;
    return part.text || part.thinking || `[${part.type}]`;
  }));
  const text = parts.join('\n') || '此 item 没有消息正文，展开查看记录信息。';
  return text.length > 220 ? text.slice(0, 220) + '…' : text;
}
function row(item) {
  const li = document.createElement('li'); li.className = 'item-row'; li.dataset.id = item.id;
  const content = document.createElement('div'); content.className = 'item-content';
  const label = document.createElement('div'); label.className = 'item-label';
  const key = document.createElement('code'); key.textContent = `#${item.id}`;
  const kind = document.createElement('span'); kind.textContent = [item.kind, ...new Set(item.messages.map(message => message.toolName || message.role))].join(' · ');
  label.append(key, kind);
  const excerpt = document.createElement('p'); excerpt.className = 'item-preview'; excerpt.textContent = preview(item);
  const detail = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '查看 item 记录';
  const data = document.createElement('pre'); data.textContent = JSON.stringify(item, null, 2);
  detail.append(summary, data); content.append(label, excerpt, detail);
  const timing = document.createElement('div'); timing.className = 'item-time';
  const time = document.createElement('time');
  if (item.timestamp !== null) {
    const date = new Date(item.timestamp); time.dateTime = date.toISOString();
    time.textContent = date.toLocaleString('zh-CN', { hourCycle: 'h23' }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
  } else time.textContent = '记录时间未知';
  const elapsed = document.createElement('strong');
  elapsed.textContent = item.durationMs === null ? (item.startedAt !== null && item.taskStatus !== 'terminal' ? '执行中' : '耗时未知') : `${item.durationMs.toLocaleString('zh-CN')} ms`;
  const task = document.createElement('small'); task.textContent = item.taskId === null ? '无执行任务' : `任务 #${item.taskId}`;
  timing.append(time, elapsed, task); li.append(content, timing); return li;
}

async function refresh(extra = false) {
  if (busy) return;
  busy = true; clearTimeout(timer);
  $('refresh').disabled = true; $('load-more').disabled = true;
  let active = false;
  try {
    let after = 0, payload, all = [], loaded = 0;
    const target = pages + (extra ? 1 : 0);
    for (let page = 0; page < target; page++) {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}?after=${after}&limit=50`, { cache: 'no-store' });
      payload = await response.json();
      if (!response.ok) {
        $('login-link').hidden = response.status !== 401;
        throw new Error(response.status === 401 ? '请先登录控制台，再返回此页面。' : response.status === 404 ? '会话不存在或已过期。' : payload.error?.message || '读取失败');
      }
      all.push(...payload.items); loaded++;
      if (payload.nextCursor === null) break;
      after = payload.nextCursor;
    }
    pages = loaded; active = payload.session.busy;
    const session = payload.session;
    $('session-meta').textContent = `${session.model || '默认模型'} · ${session.retired ? '已结束' : active ? '执行中 · 自动刷新' : '空闲'} `;
    const serialized = JSON.stringify(all);
    if (serialized !== previous) {
      const seen = new Set();
      for (const item of all) {
        seen.add(item.id);
        const saved = nodes.get(item.id), value = JSON.stringify(item);
        if (saved?.value === value) continue;
        const element = row(item);
        if (saved) { element.querySelector('details').open = saved.element.querySelector('details').open; saved.element.replaceWith(element); }
        else $('session-items').append(element);
        nodes.set(item.id, { element, value });
      }
      for (const [key, saved] of nodes) if (!seen.has(key)) { saved.element.remove(); nodes.delete(key); }
      previous = serialized;
    }
    $('items-empty').hidden = all.length !== 0;
    $('item-count').textContent = `已显示 ${all.length} 条 item${payload.nextCursor !== null ? ' · 还有更多记录' : ''}`;
    $('load-more').hidden = payload.nextCursor === null;
    $('session-error').hidden = true; $('login-link').hidden = true;
  } catch (error) {
    $('session-error').textContent = `会话读取失败：${error.message}。可点击「刷新记录」重试。`;
    $('session-error').hidden = false;
    $('session-meta').textContent = '读取失败';
  } finally {
    busy = false; $('refresh').disabled = false; $('load-more').disabled = false;
    if (active) timer = setTimeout(() => { if (!document.hidden) void refresh(); }, 2000);
  }
}
$('refresh').addEventListener('click', () => void refresh());
$('load-more').addEventListener('click', () => void refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh();
