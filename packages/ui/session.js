const $ = id => document.getElementById(id);

export function sessionStatusLabel(session) {
  if (session.busy) return session.status === 'pending' ? '等待执行' : '执行中';
  if (session.retired && session.status === 'completed') return '已关闭';
  return ({completed:'已完成',failed:'失败',cancelled:'已取消',closed:'已关闭'})[session.status] || '历史记录';
}

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

export function createSessionPanel(api, onContinue, onCopy) {
  let id = null, pages = 1, visible = false, request = null, timer;
  let resumable = false, observed = '';
  const nodes = new Map();
  $('time-heading').textContent = `记录时间（${Intl.DateTimeFormat().resolvedOptions().timeZone}）/ 执行耗时`;
  const panel = document.querySelector('.session-records-panel');
  function stop() {
    clearTimeout(timer);
    request?.abort(); request = null;
    panel.setAttribute('aria-busy', 'false');
    $('refresh-records').disabled = false; $('load-more').disabled = false;
  }
  function select(nextId) {
    if (id === nextId) return;
    stop(); id = nextId; pages = 1; nodes.clear(); resumable = false; observed = '';
    $('continue-session').disabled = true;
    $('session-items').replaceChildren(); $('item-count').textContent = '';
    $('session-id').textContent = id || '';
    $('session-placeholder').hidden = Boolean(id); $('session-records').hidden = !id;
    $('session-error').hidden = true; $('items-empty').hidden = true; $('load-more').hidden = true;
    $('session-meta').textContent = id ? '正在读取会话…' : '';
    if (visible) void refresh();
  }
  function setVisible(value) {
    if (visible === value) return;
    visible = value;
    if (visible) void refresh(); else stop();
  }
  function observe(session) {
    if (!session || session.id !== id) return;
    const signature = JSON.stringify([session.lastRunId,session.busy,session.status,session.retired]);
    if (signature === observed) return;
    observed = signature;
    if (visible) void refresh();
  }
  async function refresh(extra = false) {
    if (!visible || !id || request) return;
    clearTimeout(timer);
    const controller = new AbortController(); request = controller;
    const currentId = id;
    $('refresh-records').disabled = true; $('load-more').disabled = true;
    panel.setAttribute('aria-busy', 'true');
    let active = false;
    try {
      let after = 0, payload, all = [], loaded = 0;
      const target = pages + (extra ? 1 : 0);
      for (let page = 0; page < target; page++) {
        payload = await api(`/api/sessions/${encodeURIComponent(currentId)}?after=${after}&limit=50`, { signal: controller.signal, cache: 'no-store' });
        if (controller.signal.aborted || request !== controller) return;
        all.push(...payload.items); loaded++;
        if (payload.nextCursor === null) break;
        after = payload.nextCursor;
      }
      pages = loaded; active = payload.session.busy;
      const session = payload.session;
      resumable = !active && !session.retired && !session.legacy && session.status === 'completed';
      $('continue-session').disabled = !resumable;
      $('continue-session').title = resumable ? '使用原 session ID 发送下一条消息' : active ? '等待当前任务结束后继续' : '此历史仅供查看，请新建会话';
      $('session-meta').textContent = `${session.model || '默认模型'} · ${sessionStatusLabel(session)}${active ? ' · 自动刷新' : resumable ? ' · 可使用原 ID 继续' : ''}`;
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
      $('items-empty').hidden = all.length !== 0;
      $('item-count').textContent = `已显示 ${all.length} 条 item${payload.nextCursor !== null ? ' · 还有更多记录' : ''}`;
      $('load-more').hidden = payload.nextCursor === null;
      $('session-error').hidden = true;
    } catch (error) {
      if (controller.signal.aborted || request !== controller) return;
      const message = error.status === 401 ? '请登录后重试' : error.status === 404 ? '会话不存在或已过期' : error.message;
      $('session-error').textContent = `会话读取失败：${message}。可点击「刷新记录」重试。`;
      $('session-error').hidden = false;
      $('session-meta').textContent = '读取失败';
      resumable = false; $('continue-session').disabled = true;
      // Retry transient failures on an open panel, keeping the last good rows.
      active = error.status !== 401 && error.status !== 404;
    } finally {
      if (request === controller) {
        request = null; panel.setAttribute('aria-busy', 'false');
        $('refresh-records').disabled = false; $('load-more').disabled = false;
        if (active && visible && !document.hidden) timer = setTimeout(() => void refresh(), 2000);
      }
    }
  }
  $('refresh-records').addEventListener('click', () => void refresh());
  $('continue-session').addEventListener('click', () => { if (id && resumable) onContinue(id); });
  $('copy-session-id').addEventListener('click', () => { if (id) void onCopy(id); });
  $('load-more').addEventListener('click', () => void refresh(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (visible) void refresh(); });
  window.addEventListener('beforeunload', stop);
  return { select, setVisible, refresh, observe };
}
