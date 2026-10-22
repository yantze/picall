'use strict';

const $ = (id) => document.getElementById(id);
const state = { config: null, status: null, models: [], logs: [], seenLogs: new Set(), paused: false, sessionId: null, controller: null, eventSource: null, toastTimer: null, logFloor: 0, latestLogTime: '' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `请求失败 (${response.status})`);
  return result;
}

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}

function baseUrl() {
  return `${location.origin}/v1`;
}

async function copy(value, description) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${description}已复制`);
  } catch {
    toast('无法访问剪贴板，请手动复制。', true);
  }
}

function showView(view, updateUrl = true) {
  const isLogs = view === 'logs';
  $('overview-view').hidden = isLogs;
  $('logs-view').hidden = !isLogs;
  $('breadcrumb-current').textContent = isLogs ? '实时日志' : '服务概览';
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (updateUrl) {
    const url = new URL(location.href);
    if (isLogs) url.searchParams.set('tab', 'logs'); else url.searchParams.delete('tab');
    history.pushState({}, '', url);
  }
  if (isLogs) renderLogs();
}

function updateCurl() {
  const body = { model: 'pi', messages: [{ role: 'user', content: 'Hello, Pi!' }], stream: true };
  const lines = [`curl ${baseUrl()}/chat/completions \\`, '  -H "Content-Type: application/json" \\'];
  if (state.config?.apiKeyConfigured) lines.push('  -H "Authorization: Bearer YOUR_API_KEY" \\');
  lines.push(`  -d '${JSON.stringify(body, null, 2)}'`);
  $('curl-example').textContent = lines.join('\n');
}

function applyConfig(config) {
  state.config = config;
  $('model').value = config.model || '';
  $('effort').value = config.effort || 'medium';
  $('context-window').value = config.contextWindow ?? '';
  $('max-sessions').value = config.maxSessions ?? 8;
  $('idle-timeout').value = config.idleTimeoutMinutes ?? 30;
  $('workdir').value = config.workdir || '';
  $('key-status').textContent = config.apiKeyConfigured ? '已启用' : '未启用';
  $('api-key').placeholder = config.apiKeyConfigured ? `当前 ${config.apiKeyPreview || '已设置'} · 留空保留` : '留空则无需密钥';
  $('disable-key').checked = false;
  $('api-key').disabled = false;
  $('endpoint').textContent = baseUrl();
  updateCurl();
}

function formatUptime(seconds) {
  seconds = Math.floor(seconds || 0);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

async function loadStatus() {
  try {
    const result = await api('/api/status');
    state.status = result;
    $('requests-total').textContent = String(result.requests?.total ?? 0);
    $('requests-active').textContent = String(result.requests?.active ?? 0);
    $('sessions-total').textContent = String(result.sessions?.total ?? 0);
    $('uptime').textContent = formatUptime(result.uptime);
    $('version').textContent = result.version ? `v${result.version}` : 'LOCAL';
    $('pi-version').textContent = result.pi?.available ? `Pi ${result.pi.version || '运行时已连接'}` : 'Pi 运行时尚未就绪';
    $('connection').replaceChildren(dot('green'), document.createTextNode('服务在线'));
    $('pi-notice').hidden = !!result.pi?.available;
    $('pi-notice').textContent = result.pi?.error || '未检测到可用的 Pi。请安装 Pi 并完成模型认证后，再发送请求。';
  } catch {
    $('connection').replaceChildren(dot('red'), document.createTextNode('连接已断开'));
  }
}

async function loadModels(userTriggered = false) {
  $('reload-models').disabled = true;
  try {
    const result = await api('/api/models');
    state.models = result.models || [];
    const fragment = document.createDocumentFragment();
    state.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.label = `${model.name || model.id}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k` : ''}`;
      fragment.append(option);
    });
    $('model-options').replaceChildren(fragment);
    $('model-help').textContent = result.error || (state.models.length ? `${state.models.length} 个可用模型。也可手动输入 provider/model。` : '暂无可用模型。请先通过 pi 完成模型认证，再刷新。');
    if (userTriggered) toast(result.error || `已加载 ${state.models.length} 个模型`, !!result.error);
  } catch (error) {
    $('model-help').textContent = error.message;
    if (userTriggered) toast(error.message, true);
  } finally {
    $('reload-models').disabled = false;
  }
}

async function saveConfig(event) {
  event.preventDefault();
  $('save-button').disabled = true;
  const patch = {
    model: $('model').value.trim(),
    effort: $('effort').value,
    contextWindow: $('context-window').value ? Number($('context-window').value) : null,
    maxSessions: Number($('max-sessions').value),
    idleTimeoutMinutes: Number($('idle-timeout').value),
  };
  if ($('disable-key').checked) patch.apiKey = '';
  else if ($('api-key').value) patch.apiKey = $('api-key').value;
  try {
    const config = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    if (patch.apiKey === '') $('api-key').value = '';
    state.sessionId = null;
    applyConfig(config);
    $('save-state').replaceChildren(dot('green'), document.createTextNode('已保存到本机'));
    toast('设置已保存，新会话将使用新配置。');
    await loadStatus();
  } catch (error) {
    toast(error.message, true);
  } finally {
    $('save-button').disabled = false;
  }
}

function dot(color) {
  const element = document.createElement('span');
  element.className = `dot ${color}`;
  return element;
}

async function loadSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    if (!sessions?.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-small';
      empty.textContent = '暂无会话。发送第一条请求开始。';
      $('session-list').replaceChildren(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    sessions.forEach((session) => {
      const row = document.createElement('div');
      row.className = 'session-item';
      row.append(dot(session.busy ? 'green' : ''));
      const detail = document.createElement('div');
      detail.className = 'session-detail';
      const id = document.createElement('code');
      id.textContent = session.id;
      id.title = session.id;
      const model = document.createElement('span');
      model.textContent = `${session.model || '默认模型'} · ${session.busy ? '执行中' : '空闲'}`;
      detail.append(id, model);
      const close = document.createElement('button');
      close.className = 'icon-button';
      close.textContent = '×';
      close.title = '结束会话';
      close.setAttribute('aria-label', `结束会话 ${session.id}`);
      close.addEventListener('click', async () => {
        close.disabled = true;
        try {
          await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
          if (state.sessionId === session.id) state.sessionId = null;
          await Promise.all([loadSessions(), loadStatus()]);
          toast('会话已结束');
        } catch (error) { toast(error.message, true); close.disabled = false; }
      });
      row.append(detail, close);
      fragment.append(row);
    });
    $('session-list').replaceChildren(fragment);
  } catch (error) {
    $('session-list').textContent = `会话读取失败：${error.message}`;
  }
}

function addLog(log) {
  const highestKnown = Math.max(state.logFloor, ...state.logs.map((item) => item.id));
  if (log.id <= highestKnown && log.time > state.latestLogTime) {
    // A new server starts its sequence at one. Keep ordinary reconnects intact.
    state.logs = [];
    state.seenLogs.clear();
    state.logFloor = 0;
    state.latestLogTime = '';
  }
  if (state.seenLogs.has(log.id) || log.id <= state.logFloor) return;
  state.seenLogs.add(log.id);
  if (log.time > state.latestLogTime) state.latestLogTime = log.time;
  state.logs.push(log);
  if (state.logs.length > 2000) {
    const removed = state.logs.splice(0, state.logs.length - 2000);
    removed.forEach((item) => state.seenLogs.delete(item.id));
  }
  $('log-count').textContent = String(state.logs.length);
  if (!state.paused && !$('logs-view').hidden) renderLogs();
}

function renderLogs() {
  const level = $('log-level').value;
  const search = $('log-search').value.toLocaleLowerCase();
  const logs = state.logs.filter((log) => (level === 'all' || level === log.level) && `${log.message} ${JSON.stringify(log.details || '')}`.toLocaleLowerCase().includes(search));
  const consoleEl = document.querySelector('.log-console');
  const wasNearBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 90;
  const fragment = document.createDocumentFragment();
  logs.forEach((log) => {
    const row = document.createElement('div');
    row.className = 'log-entry';
    const time = document.createElement('time');
    time.className = 'log-time';
    time.dateTime = log.time;
    const date = new Date(log.time);
    time.textContent = Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false });
    time.title = Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    const levelEl = document.createElement('span');
    const knownLevel = ['info', 'warn', 'error', 'debug'].includes(log.level) ? log.level : 'info';
    levelEl.className = `log-level ${knownLevel}`;
    levelEl.textContent = knownLevel.toUpperCase();
    const message = document.createElement('div');
    message.className = 'log-message';
    message.textContent = log.message;
    if (log.details != null && Object.keys(log.details).length) {
      const details = document.createElement('pre');
      details.className = 'log-details';
      details.textContent = JSON.stringify(log.details, null, 2);
      message.append(details);
    }
    row.append(time, levelEl, message);
    fragment.append(row);
  });
  $('log-entries').replaceChildren(fragment);
  $('log-empty').hidden = logs.length > 0;
  $('log-summary').textContent = `${logs.length} 条显示 / ${state.logs.length} 条日志${state.paused ? ' · 已暂停显示' : ''}`;
  if (wasNearBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

async function refreshLogHistory() {
  try {
    const { logs = [] } = await api('/api/logs');
    const highestSeen = Math.max(state.logFloor, ...state.logs.map((log) => log.id));
    const highestIncoming = Math.max(0, ...logs.map((log) => log.id));
    const knownTimes = new Map(state.logs.map((log) => [log.id, log.time]));
    const latestIncomingTime = logs.reduce((latest, log) => log.time > latest ? log.time : latest, '');
    const restarted = (highestSeen > 0 && highestIncoming < highestSeen && latestIncomingTime > state.latestLogTime)
      || logs.some((log) => knownTimes.has(log.id) && knownTimes.get(log.id) !== log.time);
    if (restarted) {
      state.logs = [];
      state.seenLogs.clear();
      state.logFloor = 0;
      state.latestLogTime = '';
    }
    logs.forEach(addLog);
    state.logs.sort((a, b) => a.id - b.id);
    $('log-count').textContent = String(state.logs.length);
    if (!state.paused) renderLogs();
  } catch { /* The stream retries independently; an offline service has no history. */ }
}

function connectLogs() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/logs/stream');
  state.eventSource = source;
  source.addEventListener('log', (event) => {
    try { addLog(JSON.parse(event.data)); } catch { /* Ignore incomplete events. */ }
  });
  source.onopen = () => {
    if (!state.paused) $('log-live').replaceChildren(dot('green'), document.createTextNode('实时更新'));
    void refreshLogHistory();
  };
  source.onerror = () => {
    if (!state.paused) $('log-live').replaceChildren(dot('red'), document.createTextNode('正在重连'));
  };
}

async function runPrompt(event) {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  if (!state.config) { toast('服务配置尚未加载，请稍后重试。', true); return; }
  if (state.config.apiKeyConfigured && !$('api-key').value) {
    toast('请在 API Key 输入框填写当前密钥后试运行。密钥不会由服务端返回。', true);
    $('api-key').focus();
    return;
  }
  state.controller = new AbortController();
  $('run-button').disabled = true;
  $('response-box').hidden = false;
  $('stop-button').hidden = false;
  $('response-output').textContent = '';
  $('response-meta').textContent = '正在连接 Pi…';
  const headers = { 'Content-Type': 'application/json' };
  if (state.config.apiKeyConfigured) headers.Authorization = `Bearer ${$('api-key').value}`;
  if (state.sessionId) headers['X-Session-Id'] = state.sessionId;
  const started = performance.now();
  try {
    const response = await fetch('/v1/chat/completions', { method: 'POST', headers, signal: state.controller.signal, body: JSON.stringify({ model: state.config.model || 'pi', messages: [{ role: 'user', content: prompt }], stream: true, stream_options: { include_usage: true } }) });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || `请求失败 (${response.status})`);
    }
    state.sessionId = response.headers.get('X-Session-Id') || state.sessionId;
    $('response-meta').textContent = 'Pi 正在执行任务…';
    if (!response.body) throw new Error('浏览器不支持流式响应');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let usage;
    function processFrame(frame) {
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error.message || 'Pi 执行失败');
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices || []) {
        if (choice.delta?.content) $('response-output').textContent += choice.delta.content;
      }
    }
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      const frames = pending.split('\n\n');
      pending = frames.pop() || '';
      frames.forEach(processFrame);
      if (done) { if (pending.trim()) processFrame(pending); break; }
    }
    const duration = ((performance.now() - started) / 1000).toFixed(1);
    $('response-meta').textContent = `完成 · ${duration}s${usage?.total_tokens ? ` · ${usage.total_tokens} tokens` : ''}${state.sessionId ? ` · 会话 ${state.sessionId.slice(0, 12)}` : ''}`;
    if (!$('response-output').textContent) $('response-output').textContent = '任务已完成，未返回文本内容。';
  } catch (error) {
    // A cancelled or failed Pi turn can invalidate the process lease. Start a
    // fresh conversation on the next attempt instead of reusing a tombstone.
    state.sessionId = null;
    if (error.name === 'AbortError') $('response-meta').textContent = '请求已停止';
    else { $('response-meta').textContent = `请求失败：${error.message}`; toast(error.message, true); }
  } finally {
    state.controller = null;
    $('run-button').disabled = false;
    $('stop-button').hidden = true;
    void Promise.all([loadStatus(), loadSessions()]);
  }
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
window.addEventListener('popstate', () => showView(new URL(location.href).searchParams.get('tab') === 'logs' ? 'logs' : 'overview', false));
$('config-form').addEventListener('submit', saveConfig);
$('reload-models').addEventListener('click', () => loadModels(true));
$('refresh-sessions').addEventListener('click', loadSessions);
$('refresh-button').addEventListener('click', () => { void refresh(); });
$('copy-endpoint').addEventListener('click', () => copy(baseUrl(), '接口地址'));
$('copy-curl').addEventListener('click', () => copy($('curl-example').textContent, '请求示例'));
$('show-key').addEventListener('click', () => {
  const shown = $('api-key').type === 'password';
  $('api-key').type = shown ? 'text' : 'password';
  $('show-key').setAttribute('aria-label', shown ? '隐藏密钥' : '显示密钥');
});
$('disable-key').addEventListener('change', () => { $('api-key').disabled = $('disable-key').checked; });
$('generate-key').addEventListener('click', async () => {
  try {
    const { apiKey } = await api('/api/key', { method: 'POST' });
    $('api-key').value = apiKey;
    $('api-key').type = 'text';
    $('show-key').setAttribute('aria-label', '隐藏密钥');
    $('disable-key').checked = false;
    $('api-key').disabled = false;
    toast('密钥已生成，保存设置后生效。请妥善保管。');
  } catch (error) { toast(error.message, true); }
});
$('playground-form').addEventListener('submit', runPrompt);
$('new-session').addEventListener('click', () => {
  state.sessionId = null;
  toast('下次请求将开启新会话。');
});
$('stop-button').addEventListener('click', () => state.controller?.abort());
$('log-level').addEventListener('change', renderLogs);
$('log-search').addEventListener('input', renderLogs);
$('pause-logs').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause-logs').textContent = state.paused ? '继续' : '暂停';
  $('log-live').classList.toggle('paused', state.paused);
  $('log-live').replaceChildren(dot(state.paused ? '' : 'green'), document.createTextNode(state.paused ? '已暂停显示' : '实时更新'));
  if (!state.paused) renderLogs();
});
$('clear-logs').addEventListener('click', () => {
  state.logFloor = Math.max(state.logFloor, ...state.logs.map((log) => log.id));
  state.logs = [];
  state.seenLogs.clear();
  $('log-count').textContent = '0';
  renderLogs();
});

async function refresh() {
  $('refresh-button').disabled = true;
  await Promise.all([loadStatus(), loadSessions()]);
  $('refresh-button').disabled = false;
}

async function init() {
  showView(new URL(location.href).searchParams.get('tab') === 'logs' ? 'logs' : 'overview', false);
  $('endpoint').textContent = baseUrl();
  try { applyConfig(await api('/api/config')); } catch (error) { toast(`无法加载配置：${error.message}`, true); }
  await Promise.all([refresh(), loadModels(), connectLogs()]);
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}

window.addEventListener('beforeunload', () => { state.eventSource?.close(); state.controller?.abort(); });
void init();
