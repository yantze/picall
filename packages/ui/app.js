'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_ADDITIONAL_SYSTEM_PROMPT = '按问题复杂度使用工具：简单事实优先一次搜索和一个权威来源，证据充分后立即回答；复杂研究按需补查。';
const SECRET_FIELDS = { modelApiKey: 'model-api-key', braveApiKey: 'brave-api-key', tavilyApiKey: 'tavily-api-key', tinyfishApiKey: 'tinyfish-api-key', exaApiKey: 'exa-api-key', jinaApiKey: 'jina-api-key' };
const clearedSecrets = new Set();
let activeRequest = null;
const state = { config: null, status: null, models: [], logs: [], seenLogs: new Set(), paused: false, sessionId: null, controller: null, eventSource: null, toastTimer: null, logFloor: 0, latestLogTime: '', logConnected: false, toolRun: null,
  capabilityTools: null, capabilityError: '', capabilityRequest: 0,
  toolOverrides: Object.create(null), currentView: 'overview', settingsSection: 'general' };

function cloneOverrides(value) {
  const result = Object.create(null);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, enabled] of Object.entries(value)) if (typeof enabled === 'boolean') result[name] = enabled;
  }
  return result;
}

function overrideValue(overrides, name, fallback) {
  return Object.hasOwn(overrides, name) ? overrides[name] : fallback === true;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) { if (response.status===401 && result.error?.code==='management_login_required') { $('login-panel').hidden=false; state.eventSource?.close(); } throw new Error(result.error?.message || `请求失败 (${response.status})`); }
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

function writeRoute() {
  const url = new URL(location.href);
  if (state.currentView === 'overview') url.searchParams.delete('tab');
  else url.searchParams.set('tab', state.currentView);
  if (state.currentView === 'settings' && state.settingsSection !== 'general') url.searchParams.set('section', state.settingsSection);
  else url.searchParams.delete('section');
  if (url.href !== location.href) history.pushState({}, '', url);
}

function showSettingsTab(section, updateUrl = true, focus = false) {
  state.settingsSection = ['general', 'model', 'research', 'tools'].includes(section) ? section : 'general';
  document.querySelectorAll('[data-settings-section]').forEach((button) => {
    const selected = button.dataset.settingsSection === state.settingsSection;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== state.settingsSection; });
  $('capability-settings').hidden = state.settingsSection !== 'tools';
  if (updateUrl && state.currentView === 'settings') writeRoute();
}

function showView(view, updateUrl = true, section = state.settingsSection) {
  state.currentView = ['overview', 'logs', 'settings'].includes(view) ? view : 'overview';
  for (const name of ['overview', 'logs', 'settings']) $(name + '-view').hidden = name !== state.currentView;
  $('breadcrumb-current').textContent = { overview: '服务概览', logs: '实时日志', settings: '服务设置' }[state.currentView];
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.currentView;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (state.currentView === 'settings') showSettingsTab(section, false);
  if (updateUrl) writeRoute();
  if (state.currentView === 'logs') renderLogs();
}

function restoreRoute() {
  const params = new URL(location.href).searchParams;
  const view = params.get('tab');
  showView(view === 'settings' || view === 'logs' ? view : 'overview', false, params.get('section') || 'general');
}

function updateCurl() {
  const body = { model: $('model').value || state.config?.defaultModel || 'deepseek-flash', messages: [{ role: 'user', content: 'Hello, Pi!' }], stream: true };
  if ($('effort').value) body.reasoning_effort = $('effort').value;
  const lines = [`curl ${baseUrl()}/chat/completions \\`, '  -H "Content-Type: application/json" \\'];
  if (state.config?.apiKeyConfigured) lines.push('  -H "Authorization: Bearer YOUR_API_KEY" \\');
  const quotedBody = "'" + JSON.stringify(body, null, 2).replaceAll("'", "'\\''") + "'";
  lines.push(`  -d ${quotedBody}`);
  $('curl-example').textContent = lines.join('\n');
}

function applyConfig(config) {
  state.config = config;
  $('model-provider').value = config.modelProvider || 'openai-compatible';
  $('ai-gateway-id').value = config.aiGatewayId || 'deepseek';
  $('byok-alias').value = config.byokAlias || 'default';
  updateProviderFields();
  $('model-base-url').value = config.modelBaseUrl ?? 'https://api.deepseek.com/v1';
  $('default-model').value = config.defaultModel ?? 'deepseek-flash';
  $('model-context-window').value = config.modelContextWindow ?? 131072;
  $('model-max-tokens').value = config.modelMaxTokens ?? 8192;
  $('enable-research').checked = config.enableResearch !== false;
  $('budget-reminders').checked = config.budgetReminders !== false;
  $('research-budget-mode').value = config.researchBudgetMode || 'fixed';
  $('brave-base-url').value = config.braveBaseUrl ?? 'https://brave.vastiny.com/res/v1';
  $('tavily-base-url').value = config.tavilyBaseUrl ?? 'https://tavily.vastiny.com';
  $('max-tool-rounds').value = config.maxToolRounds ?? 8;
  $('request-timeout').value = config.requestTimeoutSeconds ?? 300;
  $('http-tools').value = JSON.stringify(config.httpTools ?? [], null, 2);
  $('http-tools').setCustomValidity('');
  clearedSecrets.clear();
  for (const [field, id] of Object.entries(SECRET_FIELDS)) {
    $(id).value = '';
    $(id).placeholder = config[`${field}Configured`] ? `当前 ${config[`${field}Preview`] || '已配置'} · 留空保留` : '未配置 · 可输入密钥';
    $(`${field}-status`).textContent = config[`${field}Configured`] ? '已配置' : '未配置';
  }
  $('max-sessions').value = config.maxSessions ?? 8;
  $('idle-timeout').value = config.idleTimeoutMinutes ?? 30;
  $('additional-system-prompt').value = config.additionalSystemPrompt ?? DEFAULT_ADDITIONAL_SYSTEM_PROMPT;
  validateAdditionalSystemPrompt();
  state.toolOverrides = cloneOverrides(config.toolOverrides);
  renderCapabilities();
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
    const cloud=result.deployment==='cloudflare';
    document.querySelectorAll('[data-local-only]').forEach(el=>{el.hidden=cloud;});
    document.querySelectorAll('[data-cloud-only]').forEach(el=>{el.hidden=!cloud;});
    $('disable-key').disabled=cloud;
    $('security-description').textContent=cloud?'云端管理 · 独立登录':'管理页面免登录 · 仅在可信本机使用';
    $('deployment-label').textContent=cloud?'Cloudflare Workers':'本地服务';
    $('requests-total').textContent = String(result.requests?.total ?? 0);
    $('requests-active').textContent = String(result.requests?.active ?? 0);
    $('sessions-total').textContent = String(result.sessions?.total ?? 0);
    $('uptime').textContent = formatUptime(result.uptime);
    $('version').textContent = result.version ? `v${result.version}` : 'LOCAL';
    $('pi-version').textContent = result.runtime?.available ? `Pi Durable ${result.runtime.version || '运行时已连接'}` : 'Pi 运行时尚未就绪';
    $('connection').replaceChildren(dot('green'), document.createTextNode('服务在线'));
    $('pi-notice').hidden = !!result.runtime?.available;
    $('pi-notice').textContent = result.runtime?.error || '本地 Durable 运行时尚未就绪，请检查存储状态。';
    renderRuntimeDiagnostics(result.runtime);
  } catch {
    $('connection').replaceChildren(dot('red'), document.createTextNode('连接已断开'));
  }
}

function validateAdditionalSystemPrompt() {
  const input = $('additional-system-prompt');
  input.setCustomValidity(input.value.includes('\0') ? '附加系统 Prompt 不可包含 NUL 字符。'
    : input.value.length > 16384 ? '附加系统 Prompt 最多包含 16,384 个字符。' : '');
}

async function loadCapabilities(userTriggered = false) {
  const request = ++state.capabilityRequest;
  $('refresh-capabilities').disabled = true;
  try {
    const result = await api('/api/capabilities');
    if (request !== state.capabilityRequest) return;
    state.capabilityError = typeof result.error === 'string' ? result.error : '';
    // Keep draft tool choices when a status refresh fails.
    if (Array.isArray(result.tools) && (!state.capabilityError || result.tools.length)) state.capabilityTools = result.tools;
    renderCapabilities();
    if (userTriggered) toast(state.capabilityError || '研究工具清单已刷新；待保存的选择已保留。', !!state.capabilityError);
  } catch (error) {
    if (request !== state.capabilityRequest) return;
    state.capabilityError = error.message;
    renderCapabilities();
    if (userTriggered) toast(error.message, true);
  } finally {
    if (request === state.capabilityRequest) $('refresh-capabilities').disabled = false;
  }
}

function capabilityEmpty(message) {
  const element = document.createElement('p');
  element.className = 'capability-empty';
  element.textContent = message;
  return element;
}

function renderCapabilities() {
  $('capability-error').hidden = !state.capabilityError;
  $('capability-error').textContent = state.capabilityError
    ? `${state.capabilityError} 已保存及待保存的选择仍保留；已有清单可能来自上次探测。` : '';
  $('capability-tool-count').textContent = state.capabilityTools ? String(state.capabilityTools.length) : '—';
  const tools = document.createDocumentFragment();
  for (const [index, tool] of (state.capabilityTools || []).entries()) {
    if (!tool || typeof tool.name !== 'string') continue;
    const hidden = tool.exposure === 'hidden';
    const row = document.createElement('div');
    row.className = `capability-row${hidden ? ' capability-hidden' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox'; input.id = `cap-tool-${index}`; input.dataset.toolName = tool.name;
    input.checked = !hidden && overrideValue(state.toolOverrides, tool.name, tool.enabled);
    input.disabled = hidden;
    input.setAttribute('aria-label', `允许工具 ${tool.name}`);
    input.addEventListener('change', () => { state.toolOverrides[tool.name] = input.checked; });
    const body = document.createElement('div'); body.className = 'capability-body';
    const heading = document.createElement('div'); heading.className = 'capability-entry-heading';
    const label = document.createElement('label'); label.htmlFor = input.id;
    const name = document.createElement('code'); name.textContent = tool.name; label.append(name);
    const badge = document.createElement('span'); badge.className = 'capability-badge';
    badge.textContent = tool.active ? '已启用' : '已关闭';
    heading.append(label, badge);
    const description = document.createElement('p'); description.className = 'capability-description';
    description.textContent = typeof tool.description === 'string' && tool.description ? tool.description : '未提供工具说明';
    const metadata = document.createElement('p'); metadata.className = 'capability-metadata';
    metadata.textContent = `默认${tool.defaultEnabled ? '允许' : '关闭'}${tool.exposure ? ` · exposure: ${tool.exposure}` : ''}`;
    body.append(heading, description, metadata);
    if (hidden || tool.reason) {
      const reason = document.createElement('p'); reason.className = 'capability-reason';
      reason.textContent = typeof tool.reason === 'string' && tool.reason ? tool.reason : 'Pi 将此工具标记为 hidden，不能通过此开关启用。';
      body.append(reason);
    }
    row.append(input, body); tools.append(row);
  }
  if (!tools.childNodes.length) tools.append(capabilityEmpty(state.capabilityError ? '工具信息暂不可用，已保存的工具选择仍保留。' : state.capabilityTools ? '本次探测没有返回工具。' : '正在读取工具清单…'));
  $('capability-tool-list').replaceChildren(tools);
}

function renderRuntimeDiagnostics(runtime = {}) {
  const tools = runtime.tools || [];
  $('tool-count').textContent = String(tools.length);
  $('tool-list').replaceChildren(...tools.map(name => { const item = document.createElement('code'); item.textContent = name; return item; }));
  $('tool-guidance').textContent = tools.length ? '仅注册研究工具；实际调用可在本轮记录中查看。' : '可在服务设置中启用研究工具。';
  $('runtime-version').textContent = runtime.version || '未就绪';
  $('runtime-storage').textContent = runtime.storage || 'sqlite';
  $('runtime-recovered').textContent = runtime.kind==='pi-harness' ? '已启用 · 按会话唤醒' : String(runtime.recoveredTasks || 0);
  $('runtime-available-tools').textContent = tools.join(' · ') || '无';
}

function observeToolLog(log) {
  const run = state.toolRun;
  if (!run?.sessionId || log.details?.sessionId !== run.sessionId) return;
  const timestamp = Date.parse(log.time);
  if (!Number.isFinite(timestamp) || timestamp < run.startedAt || (run.endedAt && timestamp > run.endedAt)) return;
  if (!['Tool started.', 'Tool completed.', 'Tool failed.'].includes(log.message) || typeof log.details.tool !== 'string') return;
  const eventKey = `${log.time}:${log.id}`;
  if (run.seen.has(eventKey)) return;
  run.seen.add(eventKey);
  const name = log.details.tool;
  if (log.message === 'Tool started.') {
    run.calls.push({ name, status: run.phase === 'running' ? 'running' : 'unconfirmed' });
  } else {
    const call = run.calls.find((item) => item.name === name && ['running', 'unconfirmed', 'cancelled'].includes(item.status));
    if (call) call.status = log.message === 'Tool failed.' ? 'error' : 'complete';
    else run.calls.push({ name, status: log.message === 'Tool failed.' ? 'error' : 'complete' });
  }
  renderToolRun();
}

function finishToolRun(phase) {
  const run = state.toolRun;
  if (!run) return;
  run.phase = phase;
  run.endedAt = Date.now();
  run.calls.forEach((call) => {
    if (call.status === 'running') call.status = phase === 'complete' ? 'unconfirmed' : 'cancelled';
  });
  renderToolRun();
}

function renderToolRun() {
  const run = state.toolRun;
  $('tool-run').hidden = !run;
  if (!run) { $('tool-run-list').replaceChildren(); return; }
  $('tool-run-count').textContent = `${run.calls.length} 次`;
  let note;
  if (run.phase === 'running') {
    note = run.calls.length ? '工具事件来自本轮会话的运行日志。' : '等待本轮工具调用事件；工具是否调用由 Pi 决定。';
    if (!state.logConnected) note += ' 日志通道正在重连，观测可能不完整。';
  } else if (run.calls.length) {
    note = run.phase === 'complete' ? '本轮已结束。以下为实际观测到的工具调用。' : '本轮已停止或执行失败，以下保留已观测的工具调用。';
  } else {
    note = `${run.phase === 'complete' ? '本轮已结束' : '本轮已停止或执行失败'}，未观察到工具调用事件；这不代表工具不可用。`;
  }
  if (run.calls.length > 30) note += ' 仅显示最近 30 次，完整事件可在日志页查看。';
  $('tool-run-note').textContent = note;
  const labels = { running: '执行中', complete: '已完成', error: '执行失败', cancelled: '已中断', unconfirmed: '状态未确认' };
  const fragment = document.createDocumentFragment();
  run.calls.slice(-30).forEach((call) => {
    const row = document.createElement('li');
    row.className = `tool-call ${call.status}`;
    const name = document.createElement('code');
    name.textContent = call.name;
    const status = document.createElement('span');
    status.textContent = labels[call.status];
    row.append(name, status);
    fragment.append(row);
  });
  $('tool-run-list').replaceChildren(fragment);
}

async function loadModels(userTriggered = false) {
  $('reload-models').disabled = true;
  try {
    const result = await api('/api/models');
    const selected = $('model').value;
    const selectedEffort = $('effort').value;
    const preferred = `picall/${state.config?.defaultModel || 'deepseek-flash'}`;
    state.models = [...(result.models || [])].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    const fragment = document.createDocumentFragment();
    state.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.id}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k` : ''}`;
      fragment.append(option);
    });
    if (!state.models.length) {
      const empty = document.createElement('option');
      empty.value = ''; empty.textContent = '暂无可用模型'; fragment.append(empty);
    }
    $('model').replaceChildren(fragment);
    if (state.models.some(model => model.id === selected)) $('model').value = selected;
    if ($('model').value !== selected) state.sessionId = null;
    $('model-count').textContent = String(state.models.length);
    $('model-help').textContent = result.error || (state.models.length ? `${state.models.length} 个可用模型。默认模型：${state.config?.defaultModel || '未设置'}，可在「服务设置 → 模型网关」修改。` : '暂无可用模型。请在「服务设置 → 模型网关」配置模型服务并保存，再刷新。');
    renderModelCatalog();
    updateRequestModel();
    if ($('effort').value !== selectedEffort) state.sessionId = null;
    if (userTriggered) toast(result.error || `已加载 ${state.models.length} 个模型`, !!result.error);
  } catch (error) {
    $('model-help').textContent = error.message;
    if (userTriggered) toast(error.message, true);
  } finally {
    $('reload-models').disabled = false;
  }
}

function renderModelCatalog() {
  const fragment = document.createDocumentFragment();
  for (const model of state.models) {
    const row = document.createElement('article'); row.className = 'model-entry'; row.setAttribute('role', 'listitem');
    const id = document.createElement('code'); id.textContent = model.id;
    const name = document.createElement('p'); name.className = 'model-entry-name'; name.textContent = model.name || model.id;
    const details = document.createElement('p'); details.className = 'model-entry-meta';
    details.textContent = `上下文 ${formatTokens(model.contextWindow)} · 最大输出 ${formatTokens(model.maxTokens)}`;
    const efforts = document.createElement('p'); efforts.className = 'model-entry-efforts';
    efforts.textContent = `推理级别：${model.reasoningEfforts?.join(' / ') || '未报告'}`;
    row.append(id, name, details, efforts); fragment.append(row);
  }
  $('model-catalog').replaceChildren(fragment);
}

function formatTokens(value) {
  return Number.isFinite(value) ? `${value.toLocaleString()} tokens` : '未报告';
}

function validateHttpTools() {
  let message = '';
  try {
    const tools = JSON.parse($('http-tools').value);
    if (!Array.isArray(tools)) message = '工具定义必须是 JSON 数组；无工具时填写 []。';
  } catch { message = '请输入有效 JSON；无工具时填写 []。'; }
  $('http-tools').setCustomValidity(message);
}

function validateModelCapacity() {
  const tooLarge = Number($('model-max-tokens').value) > Number($('model-context-window').value);
  $('model-max-tokens').setCustomValidity(tooLarge ? '最大输出不能超过上下文窗口。' : '');
}

function updateRequestModel() {
  const selected = state.models.find(model => model.id === $('model').value);
  const previous = $('effort').value;
  const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Pi 默认 · 不发送';
  const options = [defaultOption];
  for (const effort of selected?.reasoningEfforts || []) {
    const option = document.createElement('option'); option.value = effort; option.textContent = effort; options.push(option);
  }
  $('effort').replaceChildren(...options);
  if ((selected?.reasoningEfforts || []).includes(previous)) $('effort').value = previous;
  $('request-model-info').textContent = selected
    ? `模型上限：上下文 ${formatTokens(selected.contextWindow)} · 最大输出 ${formatTokens(selected.maxTokens)}。上下文窗口由 网页模型配置决定。`
    : '先在「服务设置 → 模型网关」配置服务，再刷新模型目录。';
  updateCurl();
}

async function saveConfig(event) {
  event.preventDefault();
  if (!state.config) { toast('配置尚未读取，无法安全保存。请刷新页面后重试。', true); return; }
  if (state.controller) { toast('请等待本轮完成或停止后，再保存设置。', true); return; }
  validateAdditionalSystemPrompt();
  validateHttpTools();
  validateModelCapacity();
  const form = $('config-form');
  if (!form.checkValidity()) {
    const invalid = Array.from(form.elements).find((element) => element.willValidate && !element.validity.valid);
    if (invalid) {
      const panel = invalid.closest('[data-settings-panel]');
      showView('settings', true, panel?.dataset.settingsPanel || 'general');
      let details = invalid.closest('details');
      while (details) { details.open = true; details = details.parentElement?.closest('details'); }
      invalid.focus();
      invalid.reportValidity();
    }
    return;
  }
  $('save-button').disabled = true;
  const patch = {
    maxSessions: Number($('max-sessions').value),
    idleTimeoutMinutes: Number($('idle-timeout').value),
    additionalSystemPrompt: $('additional-system-prompt').value,
    toolOverrides: cloneOverrides(state.toolOverrides),
    modelBaseUrl: $('model-base-url').value.trim(),
    defaultModel: $('default-model').value.trim(),
    modelContextWindow: Number($('model-context-window').value),
    modelMaxTokens: Number($('model-max-tokens').value),
    enableResearch: $('enable-research').checked,
    budgetReminders:$('budget-reminders').checked,
    researchBudgetMode:$('research-budget-mode').value,
    braveBaseUrl: $('brave-base-url').value.trim(),
    tavilyBaseUrl: $('tavily-base-url').value.trim(),
    maxToolRounds: Number($('max-tool-rounds').value),
    requestTimeoutSeconds: Number($('request-timeout').value),
    httpTools: JSON.parse($('http-tools').value),
  };
  if (state.config?.modelProvider) Object.assign(patch,{revision:state.config.revision,modelProvider:$('model-provider').value,aiGatewayId:$('ai-gateway-id').value.trim(),byokAlias:$('byok-alias').value.trim()});
  for (const [field, id] of Object.entries(SECRET_FIELDS)) {
    if ($(id).value) patch[field] = $(id).value;
    else if (clearedSecrets.has(field)) patch[field] = '';
  }
  if ($('disable-key').checked) patch.apiKey = '';
  else if ($('api-key').value) patch.apiKey = $('api-key').value;
  try {
    const config = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    if (patch.apiKey === '') $('api-key').value = '';
    state.sessionId = null;
    state.toolRun = null;
    renderToolRun();
    applyConfig(config);
    $('save-state').replaceChildren(dot('green'), document.createTextNode(state.config?.modelProvider?'已加密保存到云端':'已保存到本机'));
    toast('设置已保存，新会话将使用新配置。');
    await Promise.all([loadStatus(), loadCapabilities(), loadModels()]);
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
  observeToolLog(log);
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

let logPoll;
function connectLogs() {
  clearInterval(logPoll);
  if (state.status?.deployment==='cloudflare') { state.logConnected=true; void refreshLogHistory(); logPoll=setInterval(()=>{if(!document.hidden)void refreshLogHistory();},5000); return; }
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/logs/stream');
  state.eventSource = source;
  source.addEventListener('log', (event) => {
    try { addLog(JSON.parse(event.data)); } catch { /* Ignore incomplete events. */ }
  });
  source.onopen = () => {
    state.logConnected = true;
    renderToolRun();
    if (!state.paused) $('log-live').replaceChildren(dot('green'), document.createTextNode('实时更新'));
    void refreshLogHistory();
  };
  source.onerror = () => {
    state.logConnected = false;
    renderToolRun();
    if (!state.paused) $('log-live').replaceChildren(dot('red'), document.createTextNode('正在重连'));
  };
}

async function runPrompt(event) {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  if (!state.config) { toast('服务配置尚未加载，请稍后重试。', true); return; }
  if (!$('model').value) { toast('请先选择本次请求的模型。', true); return; }
  state.controller = new AbortController();
  activeRequest = { runId: null, cancelRequested: false, cancelPromise: null, controller: state.controller };
  const active = activeRequest;
  state.toolRun = { startedAt: Date.now(), endedAt: null, sessionId: state.sessionId, phase: 'running', calls: [], seen: new Set() };
  renderToolRun();
  $('run-button').disabled = true;
  $('new-session').disabled = true;
  $('save-button').disabled = true;
  $('model').disabled = true;
  $('effort').disabled = true;
  $('reload-models').disabled = true;
  $('response-box').hidden = false;
  $('stop-button').hidden = false;
  $('response-output').textContent = '';
  $('response-meta').textContent = '正在连接 Pi…';
  renderTimings();
  const headers = { 'Content-Type': 'application/json' };

  active.headers = headers;
  if (state.sessionId) headers['X-Session-Id'] = state.sessionId;
  const started = performance.now();
  let outcome = 'error';
  try {
    const request = { model: $('model').value, messages: [{ role: 'user', content: prompt }], stream: true, stream_options: { include_usage: true } };
    if ($('effort').value) request.reasoning_effort = $('effort').value;
    const response = await fetch('/api/playground', { method: 'POST', headers, signal: state.controller.signal, body: JSON.stringify(request) });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || `请求失败 (${response.status})`);
    }
    state.sessionId = response.headers.get('X-Session-Id') || state.sessionId;
    active.runId = response.headers.get('X-Run-Id');
    if (active.runId) {
      $('run-query-id').value = active.runId;
      try { localStorage.setItem('picall.lastRunId', active.runId); } catch { /* Optional task-ID memory. */ }
    }
    if (active.cancelRequested) {
      try {
        await cancelRun(active);
        throw new DOMException('Cancelled', 'AbortError');
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        active.cancelRequested = false;
      }
    }
    state.toolRun.sessionId = state.sessionId;
    state.logs.forEach(observeToolLog);
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
      if (chunk.error) throw Object.assign(new Error(chunk.error.message || '任务执行失败'), { code: chunk.error.code });
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
    outcome = 'complete';
  } catch (error) {
    // A cancelled or failed Pi turn can invalidate the process lease. Start a
    // fresh conversation on the next attempt instead of reusing a tombstone.
    state.sessionId = null;
    if (error.name === 'AbortError' || (active.cancelRequested && error.code === 'request_cancelled')) { outcome = 'cancelled'; $('response-meta').textContent = '请求已停止'; }
    else { $('response-meta').textContent = `请求失败：${error.message}`; toast(error.message, true); }
  } finally {
    finishToolRun(outcome);
    state.controller = null;
    activeRequest = null;
    $('run-button').disabled = false;
    $('new-session').disabled = false;
    $('save-button').disabled = false;
    $('model').disabled = false;
    $('effort').disabled = false;
    $('reload-models').disabled = false;
    $('stop-button').hidden = true;
    void Promise.all([loadStatus(), loadSessions()]);
  }
}

function cancelRun(active) {
  if (!active.runId) return Promise.resolve();
  if (!active.cancelPromise) active.cancelPromise = api(`/api/runs/${encodeURIComponent(active.runId)}/cancel`, { method: 'POST', headers: active.headers }).then(() => {
    active.controller.abort();
  }).catch(error => {
    active.cancelPromise = null;
    $('response-meta').textContent = `取消未确认：${error.message}。任务可能仍在后台执行。`;
    toast(`取消任务失败：${error.message}`, true);
    throw error;
  });
  return active.cancelPromise;
}

async function stopRun() {
  const active = activeRequest;
  if (!active) return;
  active.cancelRequested = true;
  $('stop-button').disabled = true;
  $('response-meta').textContent = active.runId ? '正在取消任务…' : '等待任务 ID 后取消…';
  try { await cancelRun(active); }
  catch { /* Keep waiting available so users can retry cancellation. */ }
  finally { $('stop-button').disabled = false; }
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
window.addEventListener('popstate', restoreRoute);
const settingsTabs = Array.from(document.querySelectorAll('[data-settings-section]'));
settingsTabs.forEach((button, index) => {
  button.addEventListener('click', () => showSettingsTab(button.dataset.settingsSection));
  button.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % settingsTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + settingsTabs.length - 1) % settingsTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = settingsTabs.length - 1;
    else return;
    event.preventDefault();
    showSettingsTab(settingsTabs[next].dataset.settingsSection, true, true);
  });
});
$('config-form').addEventListener('submit', saveConfig);
$('reload-models').addEventListener('click', () => loadModels(true));
$('model').addEventListener('change', () => { state.sessionId = null; updateRequestModel(); });
$('effort').addEventListener('change', () => { state.sessionId = null; updateCurl(); });
$('additional-system-prompt').addEventListener('input', validateAdditionalSystemPrompt);
$('http-tools').addEventListener('input', validateHttpTools);
$('model-context-window').addEventListener('input', validateModelCapacity);
$('model-max-tokens').addEventListener('input', validateModelCapacity);
document.querySelectorAll('[data-secret]').forEach((button) => {
  const field = button.dataset.secret;
  const input = $(SECRET_FIELDS[field]);
  button.addEventListener('click', () => {
    input.value = '';
    clearedSecrets.add(field);
    input.placeholder = '保存后清除 · 输入新密钥可替换';
    $(`${field}-status`).textContent = '待清除';
    toast('已标记清除，保存设置后生效。');
  });
  input.addEventListener('input', () => {
    if (input.value) {
      clearedSecrets.delete(field);
      $(`${field}-status`).textContent = '待保存';
    } else {
      $(`${field}-status`).textContent = clearedSecrets.has(field) ? '待清除' : state.config?.[`${field}Configured`] ? '已配置' : '未配置';
    }
  });
});
$('refresh-capabilities').addEventListener('click', () => loadCapabilities(true));
$('refresh-tools').addEventListener('click', async () => {
  $('refresh-tools').disabled = true;
  try { await loadStatus(); } finally { $('refresh-tools').disabled = false; }
});
$('refresh-sessions').addEventListener('click', loadSessions);
$('refresh-button').addEventListener('click', () => { void refresh(true); });
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
$('run-query-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('run-query-id').value.trim();
  if (!id) return;
  try {
    const headers = {};
    const run = await api(`/api/runs/${encodeURIComponent(id)}`, { headers });
    $('response-box').hidden = false;
    $('response-output').textContent = run.completion?.choices?.[0]?.message?.content || run.error?.message || '';
    $('response-meta').textContent = `${({pending:'已持久受理',running:'执行中，可稍后查询',completed:'完成',failed:'失败',cancelled:'已取消'})[run.status] || run.status} · ${run.id}`;
    renderTimings(run.timings);
  } catch (error) { toast(error.message, true); }
});
function renderTimings(timings) {
  $('timing-panel').hidden=!timings;
  const list=$('timing-list');list.replaceChildren();
  if(!timings)return;
  const seconds=value=>(Number(value || 0)/1000).toFixed(2)+'s';
  const row=(label,value)=>{const box=document.createElement('div'),term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=value;box.append(term,description);list.append(box);};
  row('模型请求',`${timings.model_requests} 次 · 已记录 ${seconds(timings.model_ms)}`);
  row('工具轮次',`${timings.tool_rounds} / ${timings.hard_limit || '—'}`);
  if(timings.incomplete_model_requests)row('未完整观测',`${timings.incomplete_model_requests} 次模型请求`);
  for(const [name,value] of Object.entries(timings.providers || {}))row(name,`${value.completed_requests} 次 · 响应头 ${seconds(value.headers_ms)} · 完整响应 ${seconds(value.elapsed_ms)}`);
}
try { $('run-query-id').value = localStorage.getItem('picall.lastRunId') || ''; } catch { /* Storage may be disabled. */ }
$('new-session').addEventListener('click', () => {
  renderTimings();
  state.sessionId = null;
  state.toolRun = null;
  renderToolRun();
  toast('下次请求将开启新会话。');
});
$('stop-button').addEventListener('click', stopRun);
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

async function refresh(includeCapabilities = false) {
  $('refresh-button').disabled = true;
  await Promise.all([loadStatus(), loadSessions(), ...(includeCapabilities && state.currentView === 'settings' ? [loadCapabilities()] : [])]);
  $('refresh-button').disabled = false;
}

async function init() {
  const auth=await api('/api/auth/status');
  if (auth.required && !auth.authenticated) { $('login-panel').hidden=false; $('management-token').focus(); return; }
  $('login-panel').hidden=true;
  restoreRoute();
  $('endpoint').textContent = baseUrl();
  try { applyConfig(await api('/api/config')); } catch (error) { toast(`无法加载配置：${error.message}`, true); }
  await refresh();
  await Promise.all([loadModels(), loadCapabilities(), connectLogs()]);
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}

window.addEventListener('beforeunload', () => { state.eventSource?.close(); state.controller?.abort(); });
void init().catch(error=>toast(error.message,true));

function updateProviderFields() {
  const mode=$('model-provider').value;
  $('gateway-fields').hidden=mode!=='cloudflare-ai-gateway';
  $('model-base-url').closest('.field').hidden=mode!=='openai-compatible';
  $('model-api-key').closest('.field').hidden=mode!=='openai-compatible';
}
$('model-provider').addEventListener('change',updateProviderFields);
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  try { await api('/api/auth/login',{method:'POST',body:JSON.stringify({token:$('management-token').value})}); $('management-token').value=''; location.reload(); }
  catch(error) { $('login-error').textContent=error.message; }
});
$('logout-button').addEventListener('click',async()=>{ await api('/api/auth/logout',{method:'POST'});location.reload(); });
