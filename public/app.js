'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_ADDITIONAL_SYSTEM_PROMPT = '每一次 turn 中，和工具的交互层数最大是 2 次。';
const state = { config: null, status: null, models: [], logs: [], seenLogs: new Set(), paused: false, sessionId: null, controller: null, eventSource: null, toastTimer: null, logFloor: 0, latestLogTime: '', logConnected: false, toolRun: null,
  capabilityTools: null, capabilityExtensions: null, capabilityError: '', capabilityRequest: 0,
  toolOverrides: Object.create(null), extensionOverrides: Object.create(null), currentView: 'overview', settingsSection: 'general' };

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

function writeRoute() {
  const url = new URL(location.href);
  if (state.currentView === 'overview') url.searchParams.delete('tab');
  else url.searchParams.set('tab', state.currentView);
  if (state.currentView === 'settings' && state.settingsSection !== 'general') url.searchParams.set('section', state.settingsSection);
  else url.searchParams.delete('section');
  if (url.href !== location.href) history.pushState({}, '', url);
}

function showSettingsTab(section, updateUrl = true, focus = false) {
  state.settingsSection = ['general', 'tools', 'extensions'].includes(section) ? section : 'general';
  document.querySelectorAll('[data-settings-section]').forEach((button) => {
    const selected = button.dataset.settingsSection === state.settingsSection;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== state.settingsSection; });
  $('capability-settings').hidden = state.settingsSection === 'general';
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
  const body = { model: $('model').value || 'provider/model', messages: [{ role: 'user', content: 'Hello, Pi!' }], stream: true };
  if ($('effort').value) body.reasoning_effort = $('effort').value;
  const lines = [`curl ${baseUrl()}/chat/completions \\`, '  -H "Content-Type: application/json" \\'];
  if (state.config?.apiKeyConfigured) lines.push('  -H "Authorization: Bearer YOUR_API_KEY" \\');
  const quotedBody = "'" + JSON.stringify(body, null, 2).replaceAll("'", "'\\''") + "'";
  lines.push(`  -d ${quotedBody}`);
  $('curl-example').textContent = lines.join('\n');
}

function applyConfig(config) {
  state.config = config;
  $('max-sessions').value = config.maxSessions ?? 8;
  $('idle-timeout').value = config.idleTimeoutMinutes ?? 30;
  $('save-sessions').checked = config.saveSessions === true;
  $('enable-skills').checked = config.enableSkills === true;
  $('additional-system-prompt').value = config.additionalSystemPrompt ?? DEFAULT_ADDITIONAL_SYSTEM_PROMPT;
  validateAdditionalSystemPrompt();
  $('enable-extensions').checked = config.enableExtensions !== false;
  state.toolOverrides = cloneOverrides(config.toolOverrides);
  state.extensionOverrides = cloneOverrides(config.extensionOverrides);
  renderCapabilities();
  $('workdir').value = config.workdir || '';
  $('project-trust').value = config.projectTrust || 'default';
  updateProjectTrustHelp();
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
    renderRuntimeDiagnostics(result.pi);
  } catch {
    $('connection').replaceChildren(dot('red'), document.createTextNode('连接已断开'));
  }
}

function updateProjectTrustHelp() {
  const value = $('project-trust').value;
  $('project-trust-help').textContent = {
    default: '遵循 Pi 已保存的项目资源信任。显式 --workdir 启动时默认自动选择 allow；未信任时，项目扩展与 MCP 可能不会加载。',
    allow: '信任当前工作目录，允许加载并执行该项目配置的扩展与 MCP。显式 --workdir 启动会自动启用；手动修改后须保存，新会话生效。',
    deny: '忽略当前工作目录的项目资源，不加载其中的扩展与 MCP；用户级配置仍由 Pi 管理。',
  }[value];
  $('project-trust-help').classList.toggle('trust-allow', value === 'allow');
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
    // Runtime startup can fail while extension discovery still succeeds. Keep
    // the last tool snapshot and every draft override in that case.
    if (Array.isArray(result.tools) && (!state.capabilityError || result.tools.length)) state.capabilityTools = result.tools;
    if (Array.isArray(result.extensions)) state.capabilityExtensions = result.extensions;
    renderCapabilities();
    if (userTriggered) toast(state.capabilityError || '工具与扩展清单已刷新；待保存的选择已保留。', !!state.capabilityError);
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
  $('capability-extension-count').textContent = state.capabilityExtensions ? String(state.capabilityExtensions.length) : '—';
  $('extension-master-note').hidden = $('enable-extensions').checked;
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
    badge.textContent = hidden ? 'hidden · 无法启用' : tool.active ? '模型直出' : '未直出';
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
  const extensions = document.createDocumentFragment();
  for (const [index, extension] of (state.capabilityExtensions || []).entries()) {
    if (!extension || typeof extension.id !== 'string') continue;
    const row = document.createElement('div'); row.className = 'capability-row';
    const input = document.createElement('input'); input.type = 'checkbox';
    input.id = `cap-extension-${index}`; input.dataset.extensionId = extension.id;
    input.checked = overrideValue(state.extensionOverrides, extension.id, extension.configuredEnabled);
    input.setAttribute('aria-label', `加载扩展 ${extension.name || extension.id}`);
    input.addEventListener('change', () => { state.extensionOverrides[extension.id] = input.checked; });
    const body = document.createElement('div'); body.className = 'capability-body';
    const heading = document.createElement('div'); heading.className = 'capability-entry-heading';
    const label = document.createElement('label'); label.htmlFor = input.id;
    const name = document.createElement('code'); name.textContent = extension.name || extension.id; label.append(name);
    const badge = document.createElement('span'); badge.className = 'capability-badge';
    badge.textContent = `Pi 原配置：${extension.configuredEnabled ? '启用' : '关闭'}`;
    heading.append(label, badge);
    const path = document.createElement('p'); path.className = 'capability-path';
    path.textContent = typeof extension.path === 'string' ? extension.path : extension.id;
    const metadata = document.createElement('p'); metadata.className = 'capability-metadata';
    const origin = [extension.scope, extension.origin].filter((value) => typeof value === 'string' && value).join(' · ');
    metadata.textContent = `${origin ? `${origin} · ` : ''}探测策略：${extension.enabled ? '启用' : '关闭'}`;
    body.append(heading, path, metadata); row.append(input, body); extensions.append(row);
  }
  if (!extensions.childNodes.length) extensions.append(capabilityEmpty(state.capabilityExtensions ? '未发现可管理的扩展。' : state.capabilityError ? '扩展信息暂不可用，已保存的扩展选择仍保留。' : '正在读取扩展清单…'));
  $('capability-extension-list').replaceChildren(extensions);
}

function renderRuntimeDiagnostics(pi = {}) {
  const hasTools = pi.available !== false && Array.isArray(pi.tools);
  const tools = hasTools ? pi.tools.filter((name) => typeof name === 'string') : [];
  const availableTools = pi.available !== false && Array.isArray(pi.availableTools) ? pi.availableTools.filter((name) => typeof name === 'string') : null;
  $('tool-count').textContent = hasTools ? String(tools.length) : '—';
  const fragment = document.createDocumentFragment();
  if (tools.length) {
    tools.forEach((name) => {
      const tag = document.createElement('code');
      tag.className = 'tool-chip';
      tag.textContent = name;
      fragment.append(tag);
    });
  } else {
    const empty = document.createElement('span');
    empty.className = 'small-muted';
    empty.textContent = hasTools ? '当前没有启用工具' : '尚未获取工具名单';
    fragment.append(empty);
  }
  $('tool-list').replaceChildren(fragment);
  const builtins = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
  const onlyBasicTools = hasTools && tools.length > 0 && tools.every((name) => builtins.has(name));
  if (onlyBasicTools) {
    $('tool-guidance').textContent = `当前仅显示 Pi 基础工具。独立搜索 / 浏览工具通常由 MCP 或扩展提供；${tools.includes('bash') ? 'bash 可使用 curl 发起 HTTP 请求，Skill 也可指导其联网' : '启用 bash 后也可通过它发起 HTTP 请求'}。项目工具需确认 Pi 项目资源信任。`;
  } else if (!hasTools) {
    $('tool-guidance').textContent = pi.error || '尚未获取 Pi RPC 工具信息。请刷新诊断；模型的自述不能代替实际工具名单。';
  } else {
    $('tool-guidance').textContent = '以上为 Pi RPC 实际启用的工具。独立搜索 / 浏览工具由扩展或 MCP 提供；工具名称本身不能证明网络可用性。';
  }
  $('runtime-version').textContent = pi.version || '未获取';
  $('runtime-workdir').textContent = pi.workdir || state.config?.workdir || '未获取';
  $('runtime-agent-dir').textContent = pi.agentDir || '未获取';
  $('runtime-offline').textContent = typeof pi.offlineStartup === 'boolean' ? `${pi.offlineStartup ? '启用' : '未启用'}（不据此判断工具能否联网）` : '未获取';
  $('runtime-available-tools').textContent = availableTools ? (availableTools.join(' · ') || '无') : '未获取';
}

function observeToolLog(log) {
  const run = state.toolRun;
  if (!run?.sessionId || log.details?.sessionId !== run.sessionId) return;
  const timestamp = Date.parse(log.time);
  if (!Number.isFinite(timestamp) || timestamp < run.startedAt || (run.endedAt && timestamp > run.endedAt)) return;
  if (!['Pi tool_execution_start.', 'Pi tool_execution_end.'].includes(log.message) || typeof log.details.tool !== 'string') return;
  const eventKey = `${log.time}:${log.id}`;
  if (run.seen.has(eventKey)) return;
  run.seen.add(eventKey);
  const name = log.details.tool;
  if (log.message === 'Pi tool_execution_start.') {
    run.calls.push({ name, status: run.phase === 'running' ? 'running' : 'unconfirmed' });
  } else {
    const call = run.calls.find((item) => item.name === name && ['running', 'unconfirmed', 'cancelled'].includes(item.status));
    if (call) call.status = log.details.isError ? 'error' : 'complete';
    else run.calls.push({ name, status: log.details.isError ? 'error' : 'complete' });
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
    state.models = result.models || [];
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
    $('model-help').textContent = result.error || (state.models.length ? `${state.models.length} 个 Pi 可用模型。此处只读展示，不设置服务默认模型。` : '暂无可用模型。请先通过 picall pi 完成模型认证，再刷新。');
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
    ? `Pi 模型上限：上下文 ${formatTokens(selected.contextWindow)} · 最大输出 ${formatTokens(selected.maxTokens)}。上下文窗口由 Pi 的模型配置决定。`
    : '先配置 Pi 的模型认证，再刷新模型目录。';
  updateCurl();
}

async function saveConfig(event) {
  event.preventDefault();
  if (!state.config) { toast('配置尚未读取，无法安全保存。请刷新页面后重试。', true); return; }
  if (state.controller) { toast('请等待本轮完成或停止后，再保存设置。', true); return; }
  validateAdditionalSystemPrompt();
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
    saveSessions: $('save-sessions').checked,
    enableSkills: $('enable-skills').checked,
    additionalSystemPrompt: $('additional-system-prompt').value,
    enableExtensions: $('enable-extensions').checked,
    toolOverrides: cloneOverrides(state.toolOverrides),
    extensionOverrides: cloneOverrides(state.extensionOverrides),
    projectTrust: $('project-trust').value,
  };
  if ($('disable-key').checked) patch.apiKey = '';
  else if ($('api-key').value) patch.apiKey = $('api-key').value;
  try {
    const config = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    if (patch.apiKey === '') $('api-key').value = '';
    state.sessionId = null;
    state.toolRun = null;
    renderToolRun();
    applyConfig(config);
    $('save-state').replaceChildren(dot('green'), document.createTextNode('已保存到本机'));
    toast('设置已保存，新会话将使用新配置。');
    await Promise.all([loadStatus(), loadCapabilities()]);
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
      if (session.saveSessions) {
        const file = document.createElement('code');
        file.className = 'session-file';
        file.textContent = session.sessionFile || 'Pi 会话保存已开启，等待文件路径';
        file.title = session.sessionFile || 'Pi 返回会话文件路径后显示';
        file.setAttribute('aria-label', session.sessionFile ? `Pi 会话文件：${session.sessionFile}` : 'Pi 会话文件路径尚未返回');
        detail.append(file);
      }
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

function connectLogs() {
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
  if (state.config.apiKeyConfigured && !$('api-key').value) {
    toast('请在 API Key 输入框填写当前密钥后试运行。密钥不会由服务端返回。', true);
    $('api-key').focus();
    return;
  }
  state.controller = new AbortController();
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
  const headers = { 'Content-Type': 'application/json' };
  if (state.config.apiKeyConfigured) headers.Authorization = `Bearer ${$('api-key').value}`;
  if (state.sessionId) headers['X-Session-Id'] = state.sessionId;
  const started = performance.now();
  let outcome = 'error';
  try {
    const request = { model: $('model').value, messages: [{ role: 'user', content: prompt }], stream: true, stream_options: { include_usage: true } };
    if ($('effort').value) request.reasoning_effort = $('effort').value;
    const response = await fetch('/v1/chat/completions', { method: 'POST', headers, signal: state.controller.signal, body: JSON.stringify(request) });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || `请求失败 (${response.status})`);
    }
    state.sessionId = response.headers.get('X-Session-Id') || state.sessionId;
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
    outcome = 'complete';
  } catch (error) {
    // A cancelled or failed Pi turn can invalidate the process lease. Start a
    // fresh conversation on the next attempt instead of reusing a tombstone.
    state.sessionId = null;
    if (error.name === 'AbortError') { outcome = 'cancelled'; $('response-meta').textContent = '请求已停止'; }
    else { $('response-meta').textContent = `请求失败：${error.message}`; toast(error.message, true); }
  } finally {
    finishToolRun(outcome);
    state.controller = null;
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
$('project-trust').addEventListener('change', updateProjectTrustHelp);
$('additional-system-prompt').addEventListener('input', validateAdditionalSystemPrompt);
$('refresh-capabilities').addEventListener('click', () => loadCapabilities(true));
$('enable-extensions').addEventListener('change', () => { $('extension-master-note').hidden = $('enable-extensions').checked; });
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
$('new-session').addEventListener('click', () => {
  state.sessionId = null;
  state.toolRun = null;
  renderToolRun();
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

async function refresh(includeCapabilities = false) {
  $('refresh-button').disabled = true;
  await Promise.all([loadStatus(), loadSessions(), ...(includeCapabilities && state.currentView === 'settings' ? [loadCapabilities()] : [])]);
  $('refresh-button').disabled = false;
}

async function init() {
  restoreRoute();
  $('endpoint').textContent = baseUrl();
  try { applyConfig(await api('/api/config')); } catch (error) { toast(`无法加载配置：${error.message}`, true); }
  await Promise.all([refresh(), loadModels(), loadCapabilities(), connectLogs()]);
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}

window.addEventListener('beforeunload', () => { state.eventSource?.close(); state.controller?.abort(); });
void init();
