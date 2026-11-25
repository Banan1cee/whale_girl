'use strict';

const byId = id => document.getElementById(id);
const login = byId('login');
const dashboard = byId('dashboard');
const pairingKey = byId('key');
const preset = byId('preset');
const editor = byId('editor');
const nav = byId('launcher-nav');
const identityForm = byId('identity-form');
const modelForm = byId('model-form');
let providers = [];
const pages = new Map([
  ['status', '状态'], ['persona', '人设'], ['stickers', '表情包'], ['moments', '朋友圈'],
  ['voice', '语音发送'], ['reminders', '主动与提醒'], ['bridge', '微信桥接'],
  ['diagnostics', '诊断'], ['plugins', '插件市场'], ['settings', '设置'],
]);
const editablePages = new Set(['persona', 'reminders', 'bridge', 'settings']);
const reportPages = new Set(['stickers', 'moments', 'voice', 'reminders', 'bridge', 'plugins', 'settings']);
let selectedPage = 'status';
let diagnosticLines = [];
let stickerCategory = '';
const storageName = 'whaleConsolePairingKey';
let token = '';
let snapshot = null;
let busy = false;
let lastPresetList = '';
// 主机卡片数据独立于 /console/status：启动器没开时状态页其余部分仍要能刷新。
let host = null;
let hostError = '';

function storedToken(value) {
  for (const kind of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[kind];
      if (value === undefined) {
        const saved = storage.getItem(storageName);
        if (!saved) continue;
        if (kind === 'sessionStorage') storedToken(saved);
        return saved;
      }
      if (value) {
        storage.setItem(storageName, value);
        return value;
      }
      storage.removeItem(storageName);
    } catch {
      // 浏览器限制持久存储时，仍可在当前标签页配对。
    }
  }
  return '';
}

function notice(text = '', error = false) {
  const field = byId('feedback');
  field.textContent = text;
  field.hidden = !text;
  field.classList.toggle('error', error);
}

function bridgeStatus(bridge) {
  if (!bridge) return ['—', ''];
  if (!bridge.online) return ['离线', '电脑端可启动桥接'];
  if (bridge.accountOk === false) return ['账号待核验', '请在电脑端检查账号'];
  if (bridge.uia === false) return ['在线 · 有异常', '微信界面自动化异常'];
  return ['在线', bridge.lastSeen === null ? '' : '心跳 · ' + bridge.lastSeen + ' 秒前'];
}

function elapsed(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  if (days) return days + ' 天 ' + hours + ' 小时';
  if (hours) return hours + ' 小时 ' + minutes + ' 分';
  return minutes ? minutes + ' 分 ' + (seconds % 60) + ' 秒' : seconds + ' 秒';
}

function hostStateLabel(data) {
  // 只看 locked：LogonUI 进程在部分机器上解锁后仍常驻，不能拿它当锁屏判据。
  return data.locked ? '🔒 已锁屏' : '已登录';
}

function renderHost() {
  const offline = byId('host-offline');
  const panel = byId('host-panel');
  offline.textContent = hostError;
  offline.hidden = !hostError;
  // 卡片常驻：启动器没开时按钮也留在原地（render 里统一置灰），否则用户会以为
  // 「功能没了」，也分不清是没刷新还是压根没打开启动器。
  panel.hidden = false;
  if (!host) {
    byId('host-state').textContent = '—';
    byId('host-desktop').textContent = '—';
    byId('host-idle').textContent = '—';
    byId('host-kernel').textContent = '—';
    byId('host-keep-awake-state').textContent = '—';
    byId('host-auto-start-state').textContent = '—';
    byId('host-remote-launch-state').textContent = '—';
    byId('host-locked').hidden = true;
    byId('host-hint').hidden = true;
    byId('host-display-hint').hidden = true;
    return;
  }
  byId('host-state').textContent = hostStateLabel(host);
  byId('host-desktop').textContent = host.inputDesktop || '—';
  byId('host-idle').textContent = elapsed(host.idleSeconds);
  byId('host-kernel').textContent = host.kernelRunning
    ? (host.bridgeOnline ? '内核运行中 · 桥接在线' : '内核运行中 · 桥接离线') : '内核已停止';
  // 锁屏提示只在真的锁屏时出现；玩家可以忽略，但截图类功能确实会失效。
  byId('host-locked').hidden = !host.locked;
  const keepAwakeLabel = { off: '关（允许睡眠）', system: '防睡眠', display: '防关屏' };
  byId('host-keep-awake-state').textContent = keepAwakeLabel[host.keepAwake] || keepAwakeLabel.off;
  byId('host-auto-start-state').textContent = host.autoStart ? '开' : '关';
  byId('host-remote-launch-state').textContent = host.remoteProcessLaunch ? '开' : '关';
  byId('host-keep-awake').value = ['off', 'system', 'display'].includes(host.keepAwake) ? host.keepAwake : 'off';
  byId('host-remote-launch').checked = host.remoteProcessLaunch === true;
  byId('host-auto-start').checked = host.autoStart === true;
  // 管理员模式下启动器默认拒绝启动内核；只有「允许手机启动内核」才放行，与后端判断保持一致。
  byId('host-hint').hidden = !(host.processLaunchAllowed === false && host.remoteProcessLaunch !== true);
  // 笔记本上不提供远程开关屏幕（关屏通常等同进入待机），按钮直接隐藏并说明原因。
  const laptop = host.isLaptop === true;
  byId('host-wake-display').hidden = laptop;
  byId('host-display-off').hidden = laptop;
  byId('host-display-off').title = laptop ? '笔记本不支持远程关屏'
    : (host.displayOffBlocked ? (host.displayOffBlockedReason || '这台电脑不支持远程关屏。') : '关闭显示器（不锁屏）');
  const displayHint = byId('host-display-hint');
  const displayNote = laptop ? '笔记本上不提供远程开关屏幕：关屏通常等同进入待机，唤醒要重新登录。'
    : (host.displayOffBlocked ? (host.displayOffBlockedReason || '') : '');
  displayHint.textContent = displayNote;
  displayHint.hidden = !displayNote;
  byId('host-display-off').disabled = busy || !host || laptop || host.displayOffBlocked === true;
}

async function loadHost() {
  try {
    const result = await request(token, '/console/host');
    host = result?.data || null;
    hostError = host ? '' : '主机状态不可用。';
  } catch (error) {
    if (error.status === 401) throw error;
    host = null;
    hostError = error.message;
  }
  renderHost();
  // 启动器刚打开时不该让用户等下一轮 20 秒；失败状态下 5 秒补一次，恢复后自然停。
  if (hostError) scheduleHostRetry();
}

let hostRetryTimer = 0;
function scheduleHostRetry() {
  if (hostRetryTimer) return;
  hostRetryTimer = setTimeout(() => {
    hostRetryTimer = 0;
    if (token && hostError) loadHost().catch(() => {});
  }, 5000);
}

function render() {
  const paired = Boolean(token);
  login.hidden = paired;
  dashboard.hidden = !paired;
  byId('logout').hidden = !paired;
  byId('logout').disabled = busy;
  byId('connect').disabled = busy;
  byId('refresh').disabled = busy;
  const editable = Boolean(snapshot?.kernel || snapshot?.configurationAvailable);
  byId('load-editor').disabled = busy || !editable;
  byId('diagnostic-refresh').disabled = busy;
  byId('diagnostic-clear').disabled = busy || !diagnosticLines.length;
  byId('diagnostic-export').disabled = busy || !byId('diagnostic-status').textContent;
  byId('load-identity').disabled = busy || !editable;
  for (const control of identityForm.elements) control.disabled = busy || !editable;
  for (const control of modelForm.elements) control.disabled = busy || !editable;
  for (const button of document.querySelectorAll('[data-action]')) button.disabled = busy;
  for (const control of byId('page-summary').querySelectorAll('button, select, input, textarea')) {
    control.disabled = busy || control.dataset.unavailable === 'true';
  }
  for (const control of document.querySelectorAll('#host-panel button, #host-panel select, #host-panel input')) {
    control.disabled = busy || !host;
  }
  // 关屏按钮额外受电脑类型/策略限制：笔记本不显示，台式机开了「关屏锁定」策略时禁用。
  byId('host-display-off').disabled = busy || !host || host.isLaptop === true || host.displayOffBlocked === true;
  for (const button of nav.querySelectorAll('button')) button.disabled = busy;
  for (const control of editor.querySelectorAll('input, select, textarea, button')) control.disabled = busy || !editable;
  if (!paired) return;

  const kernel = snapshot?.kernel;
  const isOffline = Boolean(snapshot && !kernel);
  byId('offline').hidden = !isOffline || selectedPage !== 'status';
  byId('kernel').textContent = kernel ? '内核运行中' : isOffline ? '内核离线' : '状态未知';
  byId('kernel').classList.toggle('online', Boolean(kernel));
  byId('bot-name').textContent = kernel?.name || '鲸鲸';
  const provider = [kernel?.provider, kernel?.model].filter(Boolean).join(' / ');
  byId('model').textContent = kernel?.mock ? '模拟模式' : provider || '—';
  byId('uptime').textContent = elapsed(kernel?.uptime);
  byId('version').textContent = kernel?.version ? '版本 ' + kernel.version : '';
  const [bridge, detail] = bridgeStatus(snapshot?.bridge);
  byId('bridge').textContent = bridge;
  byId('bridge-detail').textContent = detail;

  const available = snapshot?.presets;
  const active = snapshot?.currentPreset;
  const current = available?.find(item => item.id === active);
  byId('current-persona').textContent = editable ? current?.name || active || '当前配置' : '—';

  const listKey = JSON.stringify([available ?? null, active ?? '', Boolean(kernel)]);
  if (lastPresetList !== listKey) {
    const previous = preset.value;
    const choices = (available || []).map(item =>
      new Option(item.version ? item.name + ' · ' + item.version : item.name, item.id));
    const prompt = choices.length ? '选择人设预设' : available ? '暂无可用预设' : '人设不可用';
    preset.replaceChildren(new Option(prompt, ''), ...choices);
    if (available?.some(item => item.id === previous)) preset.value = previous;
    lastPresetList = listKey;
  }
  preset.disabled = busy || !available?.length;
  byId('apply').disabled = preset.disabled || !preset.value || preset.value === active;
  byId('save-preset').disabled = busy || !kernel;
  byId('rename-preset').disabled = busy || !kernel || available?.find(item => item.id === preset.value)?.source !== 'user';
  byId('delete-preset').disabled = busy || !kernel || !preset.value || preset.value === active;

}

function setSnapshot(value) {
  snapshot = value;
  byId('updated').textContent = value
    ? '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · 每 20 秒自动刷新'
    : '尚未同步 · 每 20 秒自动重试';
}

function lock(message = '') {
  token = '';
  storedToken('');
  pairingKey.value = '';
  setSnapshot(null);
  host = null;
  hostError = '';
  renderHost();
  editor.replaceChildren();
  diagnosticLines = [];
  stickerCategory = '';
  identityForm.reset();
  identityForm.hidden = true;
  modelForm.reset();
  modelForm.hidden = true;
  providers = [];
  byId('diagnostic-log').textContent = '';
  byId('diagnostic-status').textContent = '';
  selectPage('status', false);
  byId('editor-status').hidden = true;
  notice(message, Boolean(message));
}

async function request(key, url, body) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) {
    throw new Error('请使用电脑上 Tailscale Serve 显示的 HTTPS 地址。');
  }
  const headers = { Authorization: 'Bearer ' + key };
  if (body) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), url === '/console/control' ? 44000 : body ? 36000 : 10000);
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    const result = await response.json();
    if (response.ok) return result;
    throw Object.assign(new Error(result.error || '请求失败。'), { status: response.status });
  } catch (error) {
    if (error.status) throw error;
    throw new Error(body
      ? '无法确认操作结果。请刷新状态后再试。'
      : '控制台没有响应。请确认电脑开着，且两台设备仍连接到同一专用网络。');
  } finally {
    clearTimeout(timeout);
  }
}

async function run(action, clearNotice = true) {
  if (busy) return;
  busy = true;
  if (clearNotice) notice();
  render();
  try {
    await action();
  } catch (error) {
    if (error.status === 401) lock(error.message);
    else notice(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

function refresh(manual) {
  return run(async () => {
    try {
      // 主机卡片与运行概览同一节奏刷新；主机失败只影响卡片本身，不拖垮整套状态。
      const [state] = await Promise.all([request(token, '/console/status'), loadHost()]);
      setSnapshot(state);
      if (byId('feedback').dataset.connectionError === 'true') notice();
      byId('feedback').dataset.connectionError = '';
    } catch (error) {
      byId('feedback').dataset.connectionError = 'true';
      setSnapshot(null);
      throw error;
    }
  }, manual);
}

async function change(url, body, successMessage) {
  await run(async () => {
    try {
      const result = await request(token, url, body);
      const statusError = result.statusError || (!result.kernel ? '当前无法连接鲸鲸内核。' : '');
      setSnapshot(result.statusError ? null : result);
      byId('feedback').dataset.connectionError = statusError ? 'true' : '';
      notice(statusError ? successMessage + ' ' + statusError : successMessage, Boolean(statusError));
    } catch (error) {
      if (error.status !== 401) {
        setSnapshot(await request(token, '/console/status').catch(() => null));
      }
      throw error;
    }
  });
}

function editorMessage(message) {
  const status = byId('editor-status');
  status.textContent = message;
  status.hidden = !message;
}

function createSettingRow(field) {
  const row = document.createElement('form');
  const label = document.createElement('label');
  const choice = field.type === 'select' || field.type === 'selectnum';
  const list = field.type === 'list';
  const input = document.createElement(choice ? 'select' : list ? 'textarea' : 'input');
  const button = document.createElement('button');
  const toggle = field.type === 'bool';
  row.className = 'setting-row';
  label.textContent = field.name;
  if (toggle) {
    input.type = 'checkbox';
    input.checked = field.value;
  } else if (choice) {
    for (const value of field.options) input.add(new Option(String(value), String(value)));
    input.value = String(field.value);
    input.required = true;
  } else if (list) {
    input.value = field.value.join('\n');
    input.rows = 3;
  } else if (field.type === 'number') {
    input.type = 'number';
    input.value = field.value;
    input.min = field.min;
    input.max = field.max;
    input.step = field.step === 1 ? '1' : 'any';
    input.required = true;
  } else {
    input.value = field.value;
    input.maxLength = field.max;
  }
  button.className = 'button secondary';
  button.type = 'submit';
  button.textContent = '保存';
  label.append(input);
  row.append(label);
  if (!toggle) row.append(button);
  let saved = field.value;
  function save() {
    run(async () => {
      let value = input.value;
      if (toggle) value = input.checked;
      if (list) value = input.value.split('\n').map(line => line.trim()).filter(Boolean);
      if (field.type === 'number') value = input.valueAsNumber;
      if (field.type === 'selectnum') value = Number(input.value);
      let result;
      try { result = await request(token, '/console/setting', { key: field.key, value }); }
      catch (error) { if (toggle) input.checked = saved; throw error; }
      saved = value;
      setSnapshot(result.statusError ? null : result);
      editorMessage(result.statusError ? '已保存。' + result.statusError : field.name + '已保存。');
    });
  }
  if (toggle) input.addEventListener('change', save);
  row.addEventListener('submit', event => { event.preventDefault(); save(); });
  return row;
}

async function loadEditor() {
  const result = await request(token, '/console/settings');
  const sections = (result.groups || []).filter(group => group.page === pages.get(selectedPage)).map(group => {
    const details = document.createElement('details');
    details.open = selectedPage !== 'settings';
    const summary = document.createElement('summary');
    summary.textContent = group.label;
    details.append(summary, ...group.fields.map(createSettingRow));
    return details;
  });
  editor.replaceChildren(...sections);
  editorMessage(sections.length ? '' : '电脑端暂未提供这些设置。');
}

function renderDiagnosticLog() {
  const errors = byId('diagnostic-errors').checked;
  byId('diagnostic-log').textContent = diagnosticLines
    .filter(line => !errors || line.level === 'e' || line.level === 'w')
    .map(line => `[${line.time}] ${line.source} ${line.level} ${line.text}`)
    .join('\n') || '暂无日志。';
}

async function loadDiagnostics() {
  const result = await request(token, '/console/diagnostics');
  const lines = [
    result.kernelReady ? '内核已就绪' : result.kernelRunning ? '内核尚未就绪' : '内核已停止',
    result.bridgeOnline ? '微信桥接在线' : result.bridgeRunning ? '正在连接微信' : '桥接已停止',
    result.wechatAccountVerified ? '微信账号已核验' : '',
    result.updateBlocked ? '启动器正在检查或等待更新' : '',
    result.processLaunchAllowed === false ? '管理员模式下请在电脑上启动或重启程序' : '',
  ];
  byId('diagnostic-status').textContent = lines.filter(Boolean).join(' · ');
  diagnosticLines = Array.isArray(result.logs) ? result.logs : [];
  renderDiagnosticLog();
}

async function loadIdentity() {
  const values = await request(token, '/console/identity');
  for (const [key, value] of Object.entries(values)) {
    const input = identityForm.elements.namedItem(key);
    if (input?.type === 'checkbox') input.checked = value;
    else if (input) input.value = value;
  }
  identityForm.hidden = false;
}

async function loadModelSettings() {
  const current = await request(token, '/console/model');
  providers = current.providers;
  const select = modelForm.elements.namedItem('provider');
  select.replaceChildren(...providers.map(option => new Option(option.label, option.id)));
  select.value = current.provider;
  modelForm.elements.namedItem('model').value = current.model;
  modelForm.elements.namedItem('baseUrl').value = current.baseUrl;
  modelForm.elements.namedItem('apiKey').value = '';
  modelForm.elements.namedItem('thinking').checked = current.thinking;
  byId('model-key-state').textContent = current.hasKey ? '已配置 Key，留空沿用。' : '当前未配置 Key。';
  modelForm.hidden = false;
}

async function runPageCommand(action, value, body) {
  const result = await request(token, '/console/page-command', { action, value, body });
  if (action !== 'read-moments') await loadPageSummary(selectedPage);
  notice(result.message);
}

function featureButton(title, action, primary = false, type = 'button') {
  const button = document.createElement('button');
  button.className = 'button ' + (primary ? 'primary' : 'secondary');
  button.type = type;
  button.textContent = title;
  if (action) button.addEventListener('click', action);
  return button;
}

function featureField(parent, title, control) {
  const label = document.createElement('label');
  label.textContent = title;
  label.append(control);
  parent.append(label);
  return control;
}

function featureInput(parent, title, value, type = 'text') {
  const input = document.createElement('input');
  input.type = type;
  if (type === 'checkbox') input.checked = Boolean(value);
  else input.value = value ?? '';
  return featureField(parent, title, input);
}

function featureGate(parent, title, note, initial, action, confirmation) {
  const gate = document.createElement('section');
  gate.className = 'feature-section feature-gate';
  const input = featureInput(gate, title, initial, 'checkbox');
  input.dataset.featureGate = action;
  const description = document.createElement('p');
  description.textContent = note;
  gate.append(description);
  parent.append(gate);
  input.addEventListener('change', () => {
    const enabled = input.checked;
    if (enabled && confirmation && !window.confirm(confirmation)) { input.checked = initial; return; }
    run(async () => {
      try { await runPageCommand(action, undefined, { enabled, confirm: Boolean(confirmation) }); }
      catch (error) { input.checked = initial; throw error; }
    });
  });
}

function featureSection(parent, title) {
  const section = document.createElement('section');
  section.className = 'feature-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);
  parent.append(section);
  return section;
}

function voicePanel(voice) {
  const panel = document.createElement('div');
  featureGate(panel, '启用语音发送（实验性）', '开关即时保存。关闭时停止新的语音任务并取消待处理任务。', voice.enabled, 'voice-toggle');
  if (!voice.enabled) return panel;

  const form = document.createElement('form');
  form.className = 'feature-form';
  panel.append(form);
  const reply = featureSection(form, '回复方式');
  const probability = featureInput(reply, '随机概率（0～100%）', voice.probability, 'number');
  Object.assign(probability, { min: 0, max: 100, step: 'any', required: true });
  const hotkey = featureInput(reply, '微信录音快捷键', voice.hotkey);
  hotkey.setAttribute('list', 'voice-hotkeys');
  const hotkeys = document.createElement('datalist');
  hotkeys.id = 'voice-hotkeys';
  hotkeys.append(...['Ctrl+Tab', 'Ctrl+Alt', 'Alt+=', 'Ctrl+Shift+F11', 'F11'].map(value => new Option(value, value)));
  reply.append(hotkeys);
  const timeout = featureInput(reply, '语音合成最长等待（5～90 秒）', voice.timeout, 'number');
  Object.assign(timeout, { min: 5, max: 90, step: 'any', required: true });
  const groups = featureInput(reply, '群聊可用', voice.groups, 'checkbox');
  const privateChats = featureInput(reply, '私聊可用', voice.privateChats, 'checkbox');

  const synthesis = featureSection(form, '模型与音色');
  const provider = featureField(synthesis, '语音厂商', document.createElement('select'));
  provider.name = 'provider';
  provider.append(...voice.profiles.map(profile => new Option(profile.label, profile.id)));
  provider.value = voice.provider;
  const keyLink = document.createElement('a');
  keyLink.textContent = '打开当前厂商的 Key 页面';
  keyLink.target = '_blank';
  keyLink.rel = 'noopener noreferrer';
  synthesis.append(keyLink);
  const key = featureInput(synthesis, '当前厂商 API Key（留空沿用已保存的 Key）', '', 'password');
  key.autocomplete = 'off';
  key.maxLength = 250;
  const credentials = () => ({ provider: provider.value, apiKey: key.value });
  synthesis.append(featureButton('测试 API Key 连接', () => run(async () => {
    const result = await request(token, '/console/page-command', { action: 'voice-check-key', body: credentials() });
    notice(result.message);
  })));
  const models = featureField(synthesis, '语音模型', document.createElement('select'));
  const voices = featureField(synthesis, '回复音色', document.createElement('select'));
  const instructions = featureInput(synthesis, '语气指令（可选）', voice.instructions);
  const search = featureInput(synthesis, '搜索其他音色', '', 'search');
  const advanced = document.createElement('details');
  const advancedTitle = document.createElement('summary');
  advancedTitle.textContent = '高级：手动填写模型 / 音色 ID';
  advanced.append(advancedTitle);
  synthesis.append(advanced);
  const model = featureInput(advanced, '模型 ID', voice.model);
  const sound = featureInput(advanced, '音色 ID', voice.voice);
  let modelOptions = [];
  let voiceOptions = [];

  function fillChoices(select, choices, selected, filter = '') {
    const query = filter.trim().toLowerCase();
    const visible = choices.filter(item => item.id === selected || (item.label + ' ' + item.id).toLowerCase().includes(query));
    select.replaceChildren(...visible.map(item => new Option(item.label, item.id)));
    if (selected && !visible.some(item => item.id === selected)) select.append(new Option(selected, selected));
    select.value = selected;
  }
  const fillSound = () => fillChoices(voices, voiceOptions, sound.value, search.value);
  const fillModel = () => fillChoices(models, modelOptions, model.value);

  function loadProvider() {
    const saved = voice.profiles.find(profile => profile.id === provider.value);
    if (!saved) return;
    const link = typeof saved.keyUrl === 'string' && saved.keyUrl.startsWith('https://') ? saved.keyUrl : '';
    keyLink.hidden = !link;
    keyLink.href = link || '#';
    key.placeholder = saved.hasKey ? '已保存 Key' : '请填写 Key';
    key.value = '';
    search.value = '';
    model.value = saved.model || '';
    sound.value = saved.voice || '';
    instructions.value = saved.instructions || '';
    modelOptions = saved.models || [];
    voiceOptions = saved.voices || [];
    fillModel();
    fillSound();
  }

  provider.addEventListener('change', loadProvider);
  search.addEventListener('input', fillSound);
  voices.addEventListener('change', () => { sound.value = voices.value; });
  models.addEventListener('change', () => { model.value = models.value; });
  model.addEventListener('change', fillModel);
  sound.addEventListener('change', fillSound);
  synthesis.append(featureButton('读取模型和音色', () => run(async () => {
    const result = await request(token, '/console/page-command', {
      action: 'voice-catalog', body: { ...credentials(), model: model.value },
    });
    modelOptions = result.models || [];
    voiceOptions = result.voices || [];
    fillModel();
    fillSound();
    notice('已读取模型和音色，当前选择已保留。');
  })));
  loadProvider();

  const audio = featureSection(form, '声卡与测试');
  const device = featureField(audio, '虚拟声卡播放端（例如 CABLE Input）', document.createElement('select'));
  function loadDevices(devices, selected) {
    device.replaceChildren(new Option('请选择电脑上的播放设备', ''), ...devices.map(item => new Option(item.label, item.id)));
    device.value = selected;
  }
  loadDevices(voice.devices, voice.device);
  audio.append(featureButton('刷新声卡', () => run(async () => {
    const current = await request(token, '/console/page', { page: 'voice' });
    loadDevices(current.voice.devices, device.value);
  })));

  const values = () => ({ ...credentials(), probability: probability.valueAsNumber, timeout: timeout.valueAsNumber,
    groups: groups.checked, privateChats: privateChats.checked, hotkey: hotkey.value, model: model.value,
    voice: sound.value, device: device.value, instructions: instructions.value });
  audio.append(featureButton('保存语音配置', null, true, 'submit'));
  const testStatus = document.createElement('p');
  const showTest = test => {
    testStatus.textContent = test?.running ? '正在发送测试语音，稍后点「查询试发结果」。' : (test?.message || '');
  };
  showTest(voice.test);
  audio.append(featureButton('发送测试语音到文件传输助手', () => {
    if (!form.reportValidity() || !window.confirm('保存本页设置，并向电脑微信的文件传输助手发送一条测试语音？')) return;
    const body = { ...values(), confirm: true };
    run(async () => {
      const result = await request(token, '/console/page-command', { action: 'voice-test', body });
      showTest({ running: true });
      notice(result.message);
    });
  }), featureButton('查询试发结果', () => run(async () => {
    showTest(await request(token, '/console/page-command', { action: 'voice-test-status' }));
  })), testStatus);
  const drivers = featureSection(form, '虚拟声卡驱动');
  drivers.append(featureButton('安装 VB-CABLE 官方驱动', () => {
    if (!window.confirm('在电脑上打开自带的官方驱动安装程序？请到电脑上确认。')) return;
    run(async () => {
      const result = await request(token, '/console/page-command', { action: 'voice-install-driver', body: { confirm: true } });
      notice(result.message);
    });
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const body = values();
    run(() => runPageCommand('voice-save', undefined, body));
  });
  return panel;
}
function marketPanel(market) {
  const panel = document.createElement('div');
  const mode = document.createElement('div');
  mode.className = 'actions';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索插件';
  search.setAttribute('aria-label', '搜索插件');
  let selected = '';
  let installed = false;
  for (const [label, showInstalled] of [['发现', false], ['已安装', true]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.textContent = label;
    button.dataset.installed = String(showInstalled);
    button.addEventListener('click', () => { installed = showInstalled; draw(); });
    mode.append(button);
  }
  const tabs = document.createElement('div');
  tabs.className = 'actions';
  tabs.setAttribute('aria-label', '插件分类');
  const listings = document.createElement('div');
  const categories = [['', '全部'], ['persona', '人格预设'], ['message', '消息插件'], ['tool', '功能工具']];
  const marketButton = (label, action, body, confirmation) => {
    const button = document.createElement('button');
    button.className = 'button secondary';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (confirmation && !window.confirm(confirmation)) return;
      run(() => runPageCommand(action, undefined, body));
    });
    return button;
  };
  const draw = () => {
    for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.kind === selected));
    for (const button of mode.children) button.setAttribute('aria-pressed', String(button.dataset.installed === String(installed)));
    const term = search.value.trim().toLocaleLowerCase();
    const items = market.items.filter(item => (!selected || item.kind === selected) && (!installed || item.installed) &&
      [item.label, item.author, item.description].some(text => String(text || '').toLocaleLowerCase().includes(term)));
    const cards = items.map(item => {
      const card = document.createElement('section');
      const title = document.createElement('h3');
      const meta = document.createElement('p');
      const description = document.createElement('p');
      const controls = document.createElement('div');
      controls.className = 'actions';
      title.textContent = item.label;
      meta.textContent = [item.author, item.version, item.enabled ? '已启用' : item.installed ? '已安装' : ''].filter(Boolean).join(' · ');
      description.textContent = item.description;
      if (item.canInstall) controls.append(marketButton(item.installed ? '更新' : '安装', 'market-install', { id: item.id }));
      if (item.installed) {
        if (item.fullAccess && !item.enabled) {
          const authorization = document.createElement('small');
          authorization.textContent = '请在电脑上确认并授权完整系统权限。';
          controls.append(authorization);
        } else {
          const confirmation = !item.enabled && item.kind === 'message' ? '允许这个插件按它的权限参与对话？' : '';
          controls.append(marketButton(item.enabled ? '停用' : '启用', 'market-enabled',
            { id: item.id, enabled: !item.enabled }, confirmation));
        }
        controls.append(marketButton('卸载', 'market-remove', { id: item.id }, '确定卸载此插件？插件设置和插件会话状态也会被清除。'));
      }
      card.append(title, meta, description, controls);
      return card;
    });
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.textContent = market.online ? '该分类暂无插件。' : '市场暂不可用，当前分类没有已安装的插件。';
      cards.push(empty);
    }
    listings.replaceChildren(...cards);
  };
  for (const [id, title] of categories) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'button secondary';
    tab.dataset.kind = id;
    tab.textContent = title;
    tab.addEventListener('click', () => { selected = id; draw(); });
    tabs.append(tab);
  }
  search.addEventListener('input', draw);
  panel.append(mode, search, tabs, listings);
  draw();
  return panel;
}

function reportButton(label, action, value, confirmation) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary';
  button.textContent = label;
  button.addEventListener('click', () => {
    if (confirmation && !window.confirm(confirmation)) return;
    run(action ? () => runPageCommand(action, value) : () => loadPageSummary(selectedPage));
  });
  return button;
}

function stickerCategoryButton(operation, label = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary';
  button.textContent = { add: '新建分类', rename: '改名', remove: '移除分类' }[operation];
  button.addEventListener('click', () => {
    const name = operation === 'remove' ? label : window.prompt('分类名称', label)?.trim();
    if (!name || (operation === 'remove' && !window.confirm('确定移除这个表情包分类？'))) return;
    const body = { action: operation, label: label || name, newLabel: name };
    run(() => runPageCommand('sticker-category', undefined, body));
  });
  return button;
}

function readStickerFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('无法读取选中的图片。'));
    reader.readAsDataURL(file);
  });
}

function stickerPanel(sticker) {
  const panel = document.createElement('div');
  featureGate(panel, '启用表情包', '开关即时保存。关闭时立即取消未发送的表情包任务。', sticker.enabled, 'sticker-toggle');
  const settings = featureSection(panel, '表情包设置');
  const folder = featureInput(settings, '目录（安装目录内的相对路径）', sticker.folder);
  folder.maxLength = 480;
  folder.placeholder = 'data/stickers';
  settings.append(featureButton('保存目录', () => run(() => runPageCommand('sticker-folder', undefined, { folder: folder.value }))));
  settings.append(featureButton('打开总目录', () => run(() => runPageCommand('sticker-open'))));
  const frequency = featureInput(settings, '表情包频率（0～100%）', sticker.frequency, 'number');
  Object.assign(frequency, { min: 0, max: 100, step: 1, required: true });
  const ensure = featureInput(settings, '没写标记也补一张（必发）', sticker.ensure, 'checkbox');
  settings.append(featureButton('保存频率', () => {
    if (frequency.reportValidity()) {
      run(() => runPageCommand('sticker-frequency', undefined, { frequency: frequency.valueAsNumber, ensure: ensure.checked }));
    }
  }));
  const collect = featureInput(settings, '自动收集收到的表情包', sticker.collect, 'checkbox');
  collect.addEventListener('change', () => run(async () => {
    try { await runPageCommand('sticker-collect', undefined, { enabled: collect.checked }); }
    catch (error) { collect.checked = sticker.collect; throw error; }
  }));
  settings.append(featureButton('打开电脑上的收集文件夹', () => run(() => runPageCommand('sticker-open-collected'))));
  if (!sticker.manageable) return panel;

  const library = featureSection(panel, '表情包库');
  const categories = featureField(library, '分类', document.createElement('select'));
  categories.append(...sticker.categories.map(item => new Option(item.label + ' · ' + item.count + ' 张', item.id)));
  if (sticker.categories.some(item => item.id === stickerCategory)) categories.value = stickerCategory;
  library.append(stickerCategoryButton('add'), featureButton('导入预设表情包', () => run(() => runPageCommand('import-stickers'))));
  const current = document.createElement('div');
  const fileList = document.createElement('div');
  library.append(current, fileList);

  function drawCategory() {
    stickerCategory = categories.value;
    const category = sticker.categories.find(item => item.id === stickerCategory);
    current.replaceChildren();
    fileList.replaceChildren();
    if (!category) return;
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(featureButton('打开本分类文件夹', () => run(() =>
      runPageCommand('sticker-open', undefined, { emotion: category.id }))));
    if (category.custom) actions.append(stickerCategoryButton('rename', category.label), stickerCategoryButton('remove', category.label));
    current.append(actions);
    const upload = featureInput(current, '上传图片（一次最多 5 张，单张 4 MB）', '', 'file');
    upload.multiple = true;
    upload.accept = 'image/png,image/gif,image/jpeg,image/webp';
    current.append(featureButton('上传图片', () => {
      const files = Array.from(upload.files);
      if (files.length < 1 || files.length > 5 || files.some(file => !file.size || file.size > 4 * 1024 * 1024)) {
        notice('请选择 1～5 张图片，每张不超过 4 MB。', true);
        return;
      }
      run(async () => {
        let uploaded = 0;
        try {
          for (const file of files) {
            await request(token, '/console/sticker-upload', { emotion: category.id, file: await readStickerFile(file) });
            uploaded++;
          }
        } finally {
          if (uploaded) await loadPageSummary('stickers');
        }
        notice('已上传 ' + uploaded + ' 张图片。');
      });
    }));
    for (const file of category.files) {
      const row = document.createElement('div');
      row.className = 'actions sticker-row';
      const title = document.createElement('span');
      title.textContent = file.name;
      const imageKey = { emotion: category.id, name: file.id };
      row.append(title, featureButton('预览', () => run(async () => {
        const response = await fetch('/console/sticker-image', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(imageKey), cache: 'no-store', signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('表情包图片不可用。');
        const image = document.createElement('img');
        image.className = 'sticker-preview';
        image.alt = file.name;
        const src = URL.createObjectURL(await response.blob());
        image.addEventListener('load', () => URL.revokeObjectURL(src), { once: true });
        image.addEventListener('error', () => URL.revokeObjectURL(src), { once: true });
        image.src = src;
        row.querySelector('img')?.remove();
        row.append(image);
      })), featureButton('删除', () => {
        if (window.confirm('删除「' + file.name + '」？')) {
          run(() => runPageCommand('sticker-delete', undefined, { ...imageKey, confirm: true }));
        }
      }));
      fileList.append(row);
    }
    render();
  }
  categories.addEventListener('change', drawCategory);
  drawCategory();

  const testing = featureSection(panel, '可选：真实消息测试');
  const chat = featureInput(testing, '接收会话', '');
  chat.placeholder = sticker.testChat;
  chat.maxLength = 160;
  testing.append(featureButton('排队测试发送', () => {
    if (!categories.value) { notice('请先选择分类。', true); return; }
    const recipient = chat.value.trim();
    if (window.confirm('向微信会话「' + (recipient || sticker.testChat) + '」发送一张测试表情包？')) {
      run(() => runPageCommand('sticker-send', undefined, { emotion: categories.value, chat: recipient || undefined, confirm: true }));
    }
  }, true));
  const pending = document.createElement('p');
  pending.textContent = '待发送：' + (sticker.pending ?? 0);
  testing.append(pending);
  for (const job of sticker.jobs) {
    const line = document.createElement('p');
    line.textContent = [job.filename, job.status].filter(Boolean).join(' · ');
    testing.append(line);
  }
  return panel;
}

function momentsPanel(moments) {
  const panel = document.createElement('div');
  featureGate(panel, '启用朋友圈发表（总开关）', '发表会操作电脑上的微信窗口。', moments.featureEnabled, 'moments-publish-toggle');
  const publish = featureSection(panel, '自动发表朋友圈（OCR 实验）');
  const automatic = featureInput(publish, '定时自动发表', moments.scheduled, 'checkbox');
  const withImage = featureInput(publish, '按情绪配一张图片', moments.withImage, 'checkbox');
  if (!moments.featureEnabled) automatic.dataset.unavailable = 'true';
  const interval = featureInput(publish, '每隔（小时）', moments.interval, 'number');
  Object.assign(interval, { min: '0.000001', step: 'any', required: true });
  const publishLimit = featureInput(publish, '每天最多（0 表示不限）', moments.publishLimit, 'number');
  Object.assign(publishLimit, { min: 0, step: 1, required: true });
  publish.append(featureButton('保存自动发表设置', () => {
    if (!interval.reportValidity() || !publishLimit.reportValidity()) return;
    if (automatic.checked && !window.confirm('按当前设置开启定时自动发表朋友圈？')) return;
    const body = { featureEnabled: moments.featureEnabled, enabled: automatic.checked, withImage: withImage.checked,
      interval: interval.valueAsNumber, maxPerDay: publishLimit.valueAsNumber, confirm: automatic.checked };
    run(() => runPageCommand('moments-publish-save', undefined, body));
  }, true));
  const publishStatus = document.createElement('p');
  const states = { idle: '暂无发表任务', generating: '正在生成', queued: '排队中', failed: '发表失败',
    unconfirmed: '已操作微信，请核对结果', state_error: '当前发表状态不可用' };
  publishStatus.textContent = [states[moments.status] || moments.status, moments.preview].filter(Boolean).join(' · ');
  publish.append(publishStatus);
  if (moments.online) {
    if (moments.featureEnabled) publish.append(featureButton('立即发表一条', () => {
      if (window.confirm('根据近期聊天生成并尝试发表一条朋友圈？')) {
        run(() => runPageCommand('moments-publish-now', undefined, { confirm: true, withImage: withImage.checked }));
      }
    }));
    for (const [emotion, label] of [['happy', '开心'], ['cute', '傲娇'], ['angry', '炸毛']]) {
      publish.append(featureButton(label + '图片目录', () => run(() => runPageCommand('moments-open-pictures', undefined, { emotion }))));
    }
  }
  const read = featureSection(panel, '读取本地缓存');
  const like = featureInput(read, '自动点赞（模型判断）', moments.autoLike, 'checkbox');
  const hours = featureField(read, '自动读取', document.createElement('select'));
  const intervals = [...new Set([0, 4, 6, 12, moments.hours])].sort((a, b) => a - b);
  hours.append(...intervals.map(value => new Option(value ? '每 ' + value + ' 小时' : '关闭', String(value))));
  hours.value = String(moments.hours);
  const limit = featureInput(read, '每日点赞上限', moments.likeLimit, 'number');
  Object.assign(limit, { min: 0, max: 20, step: 1, required: true });
  function savePolicy() {
    if (limit.reportValidity()) run(() => runPageCommand('moments-auto', undefined, {
      autoLike: like.checked, hours: Number(hours.value), limit: limit.valueAsNumber,
    }));
  }
  for (const control of [like, hours, limit]) control.addEventListener('change', savePolicy);
  if (!moments.online) return panel;

  const own = featureInput(read, '只看自己', false, 'checkbox');
  const keyword = featureInput(read, '正文关键词', '');
  const username = featureInput(read, '发布者内部 ID', '');
  const output = featureSection(panel, '读取及互动结果');
  const taskStatus = document.createElement('p');
  const results = document.createElement('div');
  let task = '';
  function showItems(items) {
    const rows = items.map(item => {
      const line = document.createElement('p');
      line.textContent = [item.nickname, item.text].filter(Boolean).join(' · ') || '无文字的动态';
      return line;
    });
    results.replaceChildren(...rows);
  }
  async function queue(action, body) {
    const result = await request(token, '/console/page-command', { action, body });
    task = result.id;
    taskStatus.textContent = result.message;
    check.dataset.unavailable = task ? 'false' : 'true';
  }
  read.append(featureButton('读取最近 20 条', () => run(() => queue('read-moments', {
    own: own.checked, keyword: keyword.value, username: username.value,
  })), true));
  const interaction = featureSection(panel, '手动互动');
  const publisher = featureInput(interaction, '发布者准确昵称', '');
  const action = featureField(interaction, '动作', document.createElement('select'));
  action.append(...[['like', '点赞'], ['unlike', '取消点赞'], ['comment', '评论'], ['reply', '回复评论']]
    .map(([id, label]) => new Option(label, id)));
  const content = featureInput(interaction, '评论内容 / 发布文案草稿', '');
  const replyTo = featureInput(interaction, '被回复者昵称（仅回复评论）', '');
  interaction.append(featureButton('执行所选互动', () => {
    if (!publisher.value.trim() || !keyword.value.trim()) { notice('请填写发布者昵称和正文关键词。', true); return; }
    if (window.confirm('在电脑微信执行「' + action.selectedOptions[0].text + '」？')) run(() => queue('moments-action', {
      operation: action.value, publisher: publisher.value, keyword: keyword.value,
      content: content.value, replyTo: replyTo.value, confirm: true,
    }));
  }), featureButton('复制文案', () => run(async () => {
    await navigator.clipboard.writeText(content.value);
    notice('文案已复制。');
  })));
  const check = featureButton('查询任务结果', () => run(async () => {
    const result = await request(token, '/console/page-command', { action: 'moments-result', value: task });
    taskStatus.textContent = result.message || ({ done: '读取完成', queued: '排队中', reading: '读取中' }[result.state] || result.state);
    if (result.state === 'done') showItems(result.items);
  }));
  check.dataset.unavailable = 'true';
  showItems(moments.latest);
  output.append(check, taskStatus, results);
  panel.append(output);
  return panel;
}

async function loadPageSummary(page) {
  const summary = byId('page-summary');
  const result = await request(token, '/console/page', { page }).catch(error => {
    if (error.status === 401 || !editablePages.has(page)) throw error;
    return { title: pages.get(page), rows: [error.message] };
  });
  const heading = document.createElement('h2');
  heading.textContent = result.title;
  const rows = result.rows.map(text => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    return paragraph;
  });
  if (result.voice) rows.push(voicePanel(result.voice));
  if (result.market) {
    const plugins = document.createElement('div');
    featureGate(plugins, '启用 JavaScript 插件（实验性，完整系统权限）', '每个插件还需单独授权。',
      result.javascriptPlugins, 'javascript-plugins-toggle', '允许已授权的 JavaScript 插件使用完整系统权限？');
    plugins.append(marketPanel(result.market));
    rows.push(plugins);
  }
  if (result.sticker) rows.push(stickerPanel(result.sticker));
  if (result.moments) rows.push(momentsPanel(result.moments));
  if (result.appearance) {
    const appearance = document.createElement('div');
    appearance.className = 'feature-section';
    for (const [setting, title] of [['dark', '深色模式'], ['monet', '从背景图自动取色（莫奈）'], ['halo', '文字描边']]) {
      const control = featureInput(appearance, title, result.appearance[setting], 'checkbox');
      control.addEventListener('change', () => run(async () => {
        try { await runPageCommand('appearance-save', undefined, { setting, enabled: control.checked }); }
        catch (error) { control.checked = result.appearance[setting]; throw error; }
      }));
    }
    rows.push(appearance);
  }
  if (result.accounts) {
    const form = document.createElement('form');
    const label = document.createElement('label');
    const select = document.createElement('select');
    label.textContent = '绑定账号';
    select.append(new Option('自动选择最近活跃账号', ''),
      ...result.accounts.map(account => new Option(account.label, account.id)));
    select.value = result.selectedAccount || '';
    label.append(select);
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'button secondary';
    save.textContent = '保存账号';
    form.append(label, save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(() => runPageCommand('switch-account', select.value));
    });
    rows.push(form);
  }
  if (result.reminders) {
    const statusText = { pending: '待发送', retrying: '等待重试', sending: '发送中', done: '已完成',
      cancelled: '已取消', failed: '发送失败', expired: '已过期', unconfirmed: '待确认' };
    for (const item of result.reminders) {
      const row = document.createElement('div');
      const description = document.createElement('p');
      const time = item.dueAt ? new Date(item.dueAt).toLocaleString('zh-CN') : '';
      description.textContent = [item.text, time, statusText[item.status] || item.status].filter(Boolean).join(' · ');
      row.append(description);
      if (item.cancelable) row.append(reportButton('取消提醒', 'cancel-reminder', item.id, '确定取消这条提醒？'));
      rows.push(row);
    }
  }
  if (result.diary) {
    const diary = document.createElement('section');
    const title = document.createElement('h3');
    title.textContent = '日记';
    const state = document.createElement('p');
    state.textContent = result.diary.message;
    const prompt = result.diary.sendsToOwner ? '按目前设置生成并发送日记给主人？' : '现在生成一篇日记？';
    diary.append(title, state);
    if (!result.diary.busy) diary.append(reportButton('立即写一篇', 'generate-diary', undefined, prompt));
    rows.push(diary);
  }
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.textContent = '暂无记录。';
    rows.push(empty);
  }
  const toolbar = document.createElement('div');
  toolbar.className = 'actions';
  toolbar.append(reportButton('刷新'));
  for (const command of (result.commands || [])) toolbar.append(reportButton(command.label, command.action));
  summary.replaceChildren(heading, toolbar, ...rows);
}

function selectPage(page, load = true) {
  selectedPage = page;
  for (const section of document.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== page;
  for (const button of nav.querySelectorAll('button')) {
    if (button.dataset.nav === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  byId('advanced-panel').hidden = !editablePages.has(page);
  byId('advanced-title').textContent = pages.get(page) + '设置';
  editor.replaceChildren();
  editorMessage('');
  const summary = byId('page-summary');
  summary.hidden = !reportPages.has(page);
  summary.replaceChildren();
  render();
  if (!load || !token) return;
  const editable = Boolean(snapshot?.kernel || snapshot?.configurationAvailable);
  if (page === 'diagnostics') run(loadDiagnostics);
  if (reportPages.has(page) || (editablePages.has(page) && editable)) {
    run(async () => {
      if (reportPages.has(page)) await loadPageSummary(page);
      if (page === 'persona' && editable) await loadIdentity();
      if (page === 'settings' && editable) await loadModelSettings();
      if (editablePages.has(page) && editable) await loadEditor();
    });
  }
}

for (const [page, title] of pages) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary';
  button.textContent = title;
  button.dataset.nav = page;
  button.addEventListener('click', () => selectPage(page));
  nav.append(button);
}
byId('load-editor').addEventListener('click', () => run(loadEditor));
byId('load-identity').addEventListener('click', () => run(loadIdentity));
identityForm.addEventListener('submit', event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(identityForm));
  for (const input of identityForm.querySelectorAll('input[type="checkbox"]')) values[input.name] = input.checked;
  run(async () => {
    await request(token, '/console/identity', values);
    notice('人设已保存。');
  });
});
modelForm.elements.namedItem('provider').addEventListener('change', event => {
  const selected = providers.find(option => option.id === event.target.value);
  if (!selected) return;
  modelForm.elements.namedItem('model').value = selected.model;
  modelForm.elements.namedItem('baseUrl').value = selected.baseUrl;
  modelForm.elements.namedItem('thinking').checked = selected.thinking;
});
modelForm.addEventListener('submit', event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(modelForm));
  values.thinking = modelForm.elements.namedItem('thinking').checked;
  if (!values.apiKey.trim()) delete values.apiKey;
  if (!values.baseUrl.trim()) delete values.baseUrl;
  run(async () => {
    await request(token, '/console/model', values);
    await loadModelSettings();
    notice('聊天模型已保存。');
  });
});
byId('diagnostic-refresh').addEventListener('click', () => run(loadDiagnostics));
byId('diagnostic-errors').addEventListener('change', renderDiagnosticLog);
byId('diagnostic-clear').addEventListener('click', () => {
  diagnosticLines = [];
  renderDiagnosticLog();
  render();
});
byId('diagnostic-export').addEventListener('click', () => {
  const text = [byId('diagnostic-status').textContent, byId('diagnostic-log').textContent].join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '鲸鲸诊断日志.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => run(async () => {
    const result = await request(token, '/console/control', { action: button.dataset.action });
    try { setSnapshot(await request(token, '/console/status')); }
    catch { setSnapshot(null); }
    notice(result.message);
  }));
}

async function hostCommand(body, fallbackMessage) {
  try {
    const result = await request(token, '/console/host-command', body);
    await loadHost();
    notice(result.message || fallbackMessage);
  } catch (error) {
    // 失败时按电脑端真实状态回填，避免开关停在「点了但没生效」的位置。
    await loadHost().catch(() => {});
    throw error;
  }
}

byId('host-keep-awake').addEventListener('change', () => run(() => {
  const mode = byId('host-keep-awake').value;
  const label = { off: '已关闭保活。', system: '已开启防睡眠。', display: '已开启防关屏。' }[mode];
  return hostCommand({ action: 'keep-awake', value: mode, confirm: true }, label);
}));

byId('host-wake-display').addEventListener('click', () => run(async () => {
  const result = await request(token, '/console/host-command', { action: 'wake-display' });
  notice(result.message || '已点亮屏幕。');
  await loadHost();
}));

// 关屏不是锁屏：只让显示器熄掉，会话仍在已登录状态；是否会被系统强制锁屏取决于电脑设置。
byId('host-display-off').addEventListener('click', () => run(async () => {
  const result = await request(token, '/console/host-command', { action: 'display-off' });
  notice(result.message || '已发送关屏指令。');
  await loadHost();
}));

byId('host-retry').addEventListener('click', () => run(async () => {
  await loadHost();
  notice(hostError ? '还是连不上启动器：请在电脑上确认鲸鲸启动器窗口没有关掉。' : '已重新读取主机状态。', Boolean(hostError));
}));

function bindHostToggle(id, action, question) {
  const input = byId(id);
  input.addEventListener('change', () => {
    const enabled = input.checked;
    if (!window.confirm(question)) { input.checked = !enabled; return; }
    run(() => hostCommand({ action, value: enabled, confirm: true }, enabled ? '已开启。' : '已关闭。'));
  });
}
bindHostToggle('host-remote-launch', 'remote-process-launch', '允许手机启动或重启电脑上的内核？');
bindHostToggle('host-auto-start', 'auto-start', '更改鲸鲸的开机自启设置？');

byId('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const key = pairingKey.value.trim();
  run(async () => {
    if (!/^[a-f0-9]{48}$/.test(key)) throw new Error('请粘贴电脑端的完整配对密钥。');
    const result = await request(key, '/console/status');
    token = key;
    storedToken(token);
    pairingKey.value = '';
    setSnapshot(result);
    // 配对成功后立刻填主机卡片，不用等下一轮 20 秒刷新。
    await loadHost().catch(() => {});
  });
});

byId('logout').addEventListener('click', () => {
  lock();
  render();
  pairingKey.focus();
});
byId('refresh').addEventListener('click', () => refresh(true));
preset.addEventListener('change', render);
function changePreset(action, body, value) {
  run(async () => {
    const result = await request(token, '/console/page-command', { action, body, value });
    setSnapshot(await request(token, '/console/status').catch(() => snapshot));
    notice(result.message);
  });
}
byId('save-preset').addEventListener('click', () => {
  const name = window.prompt('将当前人设另存为预设。请输入名称。')?.trim();
  if (name) changePreset('save-persona-preset', { name });
});
byId('rename-preset').addEventListener('click', () => {
  const item = snapshot?.presets?.find(option => option.id === preset.value);
  const name = window.prompt('预设新名称', item?.name || '')?.trim();
  if (name && item) changePreset('rename-persona-preset', { id: item.id, name });
});
byId('delete-preset').addEventListener('click', () => {
  if (preset.value && window.confirm('确定移除选中的人设预设？')) changePreset('delete-persona-preset', undefined, preset.value);
});
byId('persona-form').addEventListener('submit', event => {
  event.preventDefault();
  if (preset.value && !byId('apply').disabled) {
    change('/console/persona', { id: preset.value }, '人设已切换。');
  }
});

token = storedToken();
selectPage('status', false);
if (token) refresh(false);
document.addEventListener('visibilitychange', () => {
  if (token && !document.hidden) refresh(false);
});
setInterval(() => {
  if (token && !document.hidden) refresh(false);
}, 20000);
