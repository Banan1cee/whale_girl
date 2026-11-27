'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { actions, appRoot, launcherControl } = require('./launcher-control');
const consoleInstance = createHash('sha256').update(path.resolve(__dirname).toUpperCase()).digest('hex');

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.png', ['icon.png', 'image/png']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-180.png', ['icon-180.png', 'image/png']],
].map(([url, [file, mime]]) => [url, { mime, body: readFileSync(path.join(__dirname, 'public', file)) }]));

const identityFields = new Map([
  ['name', 40], ['age', 24], ['job', 80], ['appearance', 400],
  ['personality', 500], ['background', 1000], ['customPrompt', 24000],
  ['newBehavior', true], ['proactive', false], ['opinions', false], ['masterRoast', false], ['ownerName', 80],
]);

const settings = new Map([
  ['freeChat', { path: '/api/config', payload: value => ({ patch: { 'group.freeChat': value } }) }],
  ['proactiveCare', { path: '/api/features', payload: value => ({ key: 'proactiveCare', value }) }],
]);

const configGroups = [
  ['设置', '群聊', [
    ['group.requireAt', '必须 @ 她才回', 'bool'],
    ['group.freeChat', '允许她自己插话', 'bool'],
    ['group.freeChatChance', '插话概率', 0, 1, 0.01],
    ['group.cooldownSec', '两次回复冷却（秒）', 0, 3600, 1],
    ['group.maxRepliesPerMinute', '每分钟最多回几条', 5, 30, 1],
    ['group.masterAlwaysReply', '主人在群里说话永远回', 'bool'],
    ['group.engagedMinutes', '接话后保持参与（分钟）', 1, 1440, 1],
    ['group.silentMinutes', '冷场多久算结束（分钟）', 1, 10080, 1],
    ['group.muteDefaultMinutes', '免打扰默认时长（分钟）', 1, 1440, 1],
    ['chat.messageSettleMs', '连续消息等待（毫秒）', 0, 10000, 1],
    ['chat.groupMaxBatchWaitMs', '群聊最多等待（毫秒）', 0, 60000, 1],
  ]],
  ['设置', '微信 · 数据与管道', [
    ['wechat.staleAfterSec', '多久没消息算去忙（秒）', 60, 86400, 1],
    ['wechat.ignoreSenders', '这些会话永不回复（一行一个）', 'list', 250],
    ['wechat.pipelineWorkers', '同时处理几个会话', 1, 8, 1],
    ['wechat.pipelineQueueLimit', '单个会话最多积压几条', 1, 32, 1],
  ]],
  ['人设', '上下文与记忆', [
    ['chat.historyTurns', '私聊上下文轮数', 2, 800, 1],
    ['chat.groupHistoryTurns', '群聊上下文轮数', 2, 800, 1],
    ['chat.privateMaxChars', '私聊回复长度', 20, 4000, 1],
    ['chat.groupMaxChars', '群聊回复长度', 20, 4000, 1],
    ['chat.maxBubbles', '每次回复最多消息条数', 1, 12, 1],
  ]],
  ['设置', 'API 接入 · 对话', [
    ['deepseek.temperature', '模型温度', 0, 2, 0.01],
    ['deepseek.maxTokens', '模型最大输出 Token', 16, 32768, 1],
  ]],
  ['主动与提醒', '主动搭话', [
    ['care.enabled', '开启主动搭话', 'bool'],
    ['care.onlyMaster', '只给主人主动搭话', 'bool'],
    ['care.allowGroups', '允许群聊主动搭话', 'bool'],
    ['care.allowOthers', '允许向其他人主动搭话', 'bool'],
    ['care.everyMinutes', '每隔多少分钟检查', 1, 1440, 1],
    ['care.jitterMinutes', '时间浮动（分钟）', 0, 180, 1],
    ['care.maxPerDay', '每天最多主动搭话', 0, 50, 1],
    ['care.quietAfterMinutes', '聊过后至少等多久（分钟）', 0, 1440, 1],
  ]],
  ['主动与提醒', '提醒', [
    ['reminder.enabled', '开启提醒', 'bool'],
    ['reminder.maxPerDay', '每日提醒上限', 0, 200, 1],
    ['reminder.quietAfterMinutes', '提醒间隔（分钟）', 0, 1440, 1],
  ]],
  ['主动与提醒', '日记', [
    ['diary.enabled', '开启日记', 'bool'],
    ['diary.sendToOwner', '写完发给主人', 'bool'],
    ['diary.time', '自动写日记时间（小时:分钟）', 'text', 5],
  ]],
  ['设置', 'API 接入 · 语音识别', [
    ['voice.enabled', '开启语音识别', 'bool'],
    ['voice.maxSeconds', '语音时长上限（秒）', 1, 600, 1],
  ]],
  ['设置', '联网与链接', [
    ['websearch.city', '搜索城市', 'text', 40],
    ['websearch.timeoutMs', '搜索超时（毫秒）', 1000, 30000, 1],
    ['links.enabled', '解析聊天里的链接', 'bool'],
    ['links.timeoutMs', '链接超时（毫秒）', 1000, 30000, 1],
    ['links.cacheMinutes', '链接缓存（分钟）', 0, 1440, 1],
    ['websearch.api.enabled', '启用外部搜索 API', 'bool'],
    ['websearch.api.followChat', '搜索 API 跟随聊天模型', 'bool'],
    ['websearch.semanticRoute', '由模型判断是否联网', 'bool'],
  ]],
  ['设置', '对话与维护', [
    ['features.envContext', '提供环境信息', 'bool'],
    ['features.relations', '加载群聊关系', 'bool'],
    ['features.groupAddressGuard', '群聊发言对象检查', 'bool'],
    ['features.fightQuoteCheck', '反击原话核对', 'bool'],
    ['features.staticSystem', '稳定提示词前缀', 'bool'],
    ['features.memorySnapshot', '自动记忆快照', 'bool'],
    ['features.mediaCleanup', '启动时清理媒体缓存', 'bool'],
  ]],
  ['设置', '高级', [
    ['memory.dialogueBudget', '对话预算（token）', 1000, Number.MAX_SAFE_INTEGER, 1],
    ['env.timezone', '时区', 'text', 80],
    ['server.port', '本机端口', [8787, 9191, 1919, 7878]],
    ['log.level', '日志级别', ['debug', 'info', 'error']],
    ['storage.mediaKeepDays', '媒体缓存保留几天', 0, 90, 1],
    ['storage.mediaMaxMB', '媒体缓存上限（MB）', 0, 10000, 1],
  ]],
  ['微信桥接', '发送方式', [
    ['wechat.accountGuard', '双开守卫', 'bool'],
    ['wechat.backgroundSend', '后台发送', 'bool'],
    ['wechat.keyboardFallback', '键盘兜底', 'bool'],
    ['wechat.bgSend.fallbackToForeground', '失败时使用前台兜底', 'bool'],
    ['wechat.bgSend.unhideWindow', '托盘时自动开窗', 'bool'],
    ['wechat.bgSend.verify', '发送后回读确认', 'bool'],
    ['wechat.bgSend.stripUnencodable', '跳过 GBK 编不了的字符', 'bool'],
  ]],
  ['微信桥接', '微信发言范围', [
    ['wechat.whitelistOnly', '仅允许白名单会话发言', 'bool'],
    ['care.whitelist', '允许发言的会话（一行一个）', 'list', 250],
    ['group.mutedGroups', '静音群聊（一行一个，填 * 静音全部）', 'list', 250],
  ]],
];

function acceptsSetting(value, kind, max, step) {
  if (kind === 'bool') return typeof value === 'boolean';
  if (kind === 'text') return typeof value === 'string' && value.length <= max;
  if (kind === 'list') return Array.isArray(value) && value.length <= max &&
    value.every(item => typeof item === 'string' && item.length <= 120);
  if (Array.isArray(kind)) return kind.includes(value);
  return Number.isFinite(value) && value >= kind && value <= max && (step !== 1 || Number.isInteger(value));
}

for (const [, , fields] of configGroups) {
  for (const [key, , min, max, step] of fields) {
    settings.set(key, {
      path: '/api/config',
      payload: value => ({ patch: { [key]: value } }),
      accepts: value => acceptsSetting(value, min, max, step),
    });
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

function authorized(req, expected) {
  const value = Buffer.from(req.headers.authorization || '');
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseBody(req, maxSize = 4096) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    req.resume();
    throw fail(415, '请使用 JSON 提交。');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= maxSize) chunks.push(chunk);
      else reject(fail(413, '请求内容太长。'));
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > maxSize) return;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch {
        reject(fail(400, '无法读取请求内容。'));
      }
    });
  });
}

const cleanText = (value, limit = 128) => typeof value === 'string' ? value.slice(0, limit) : '';
const boolean = value => typeof value === 'boolean' ? value : null;
const groupTrueValues = new Set(['true', '1', 'yes', 'on', '开']);
const groupFalseValues = new Set(['false', '0', 'no', 'off', '关']);

function groupBoolean(value, fallback) {
  // 与鲸鲸内核读取群聊开关的规则保持一致。
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (groupTrueValues.has(normalized)) return true;
  if (!normalized || groupFalseValues.has(normalized)) return false;
  return fallback;
}

function editableConfig(config) {
  if (!config) return null;
  return configGroups.map(([page, label, fields]) => ({
    page,
    label,
    fields: fields.flatMap(([key, name, min, max, step]) => {
      const value = key.split('.').reduce((part, segment) => part?.[segment], config);
      if (value === undefined || value === null) return [];
      if (min === 'bool') return [{ key, name, type: 'bool', value: groupBoolean(value, false) }];
      if (min === 'text') return typeof value === 'string' ? [{ key, name, type: min, max, value }] : [];
      if (min === 'list') return Array.isArray(value) ? [{ key, name, type: min, max, value }] : [];
      if (Array.isArray(min)) {
        const numeric = typeof min[0] === 'number';
        return [{ key, name, type: numeric ? 'selectnum' : 'select', options: min, value }];
      }
      if (typeof value !== 'number' && typeof value !== 'string') return [];
      const number = typeof value === 'string' && !value.trim() ? NaN : Number(value);
      return Number.isFinite(number) ? [{ key, name, type: 'number', min, max, step, value: number }] : [];
    }),
  })).filter(section => section.fields.length);
}
const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const items = (value, limit = 30) => Array.isArray(value) ? value.slice(0, limit) : [];
const validPresetId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/i.test(value);
const stickerFileBytes = 4 * 1024 * 1024;
const stickerField = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
const momentItems = value => items(value, 20).map(item => ({
  nickname: cleanText(item.nickname, 120), text: cleanText(item.text, 1200),
}));

function project(status, presets, persona, features) {
  const gateway = status.gateways?.find(item => item.platform === 'wechat');
  const feature = name => boolean(features?.features?.find(item => item.key === name)?.value);
  return {
    kernel: {
      name: cleanText(status.name), version: cleanText(status.version, 32),
      model: cleanText(status.model), provider: cleanText(status.providerLabel || status.provider),
      uptime: count(status.uptimeSec), mock: status.mock === true,
    },
    bridge: gateway ? {
      online: gateway.bridge?.online === true,
      uia: boolean(gateway.bridge?.uia),
      accountOk: boolean(gateway.bridge?.accountOk),
      lastSeen: count(gateway.bridge?.lastSeenSec),
    } : null,
    currentPreset: cleanText(persona?.persona?.sourcePreset, 160),
    presets: Array.isArray(presets?.presets) && persona ? presets.presets
      .filter(item => validPresetId(item.id))
      .map(item => ({ id: item.id, name: cleanText(item.name) || item.id, version: cleanText(item.version, 32),
        source: ['user', 'market', 'builtin'].includes(item.source) ? item.source : '' }))
      : null,
    settings: {
      freeChat: status.group ? groupBoolean(status.group.freeChat, false) : null,
      requireAt: status.group ? groupBoolean(status.group.requireAt, true) : null,
      proactiveCare: feature('proactiveCare'),
    },
  };
}

function createConsole({ token, whalePort = 8787, controlLauncher = launcherControl, managedOffline = false,
  discoverWhalePort = false }) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Invalid console pairing key');
  if (!Number.isInteger(whalePort) || whalePort < 1 || whalePort > 65535) throw new Error('Invalid Whale Girl port');
  const expected = Buffer.from('Bearer ' + token);
  let writing = false;
  const offlineReads = new Set(['/api/config', '/api/persona', '/api/persona/presets', '/api/features',
    '/api/settings', '/api/reminders', '/api/moments/settings', '/api/moments/publish-settings']);
  const offlineWrites = new Set(['/api/config', '/api/persona', '/api/persona/preset', '/api/features', '/api/settings',
    '/api/moments/settings', '/api/moments/publish-settings']);

  function kernelPort() {
    let port = whalePort;
    if (discoverWhalePort) {
      try {
        const configured = Number(readFileSync(path.join(appRoot, 'data', 'server-port.txt'), 'utf8'));
        if (Number.isInteger(configured) && configured >= 1 && configured <= 65535) port = configured;
      } catch { /* 内核未启动时还没有端口记录。 */ }
    }
    return port;
  }

  async function whale(url, payload) {
    const signal = AbortSignal.timeout(payload ? (url === '/api/wechat/accounts/refresh' ? 32000 : 25000) : 3500);
    let response, result;
    try {
      response = await fetch('http://127.0.0.1:' + kernelPort() + url, {
        method: payload ? 'POST' : 'GET',
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (managedOffline && error.cause?.code === 'ECONNREFUSED' &&
          (payload ? offlineWrites : offlineReads).has(url)) {
        let fallback;
        try {
          fallback = await controlLauncher(payload ? 'configuration-save' : 'configuration-read',
            { path: url, body: payload });
        } catch (failure) { throw fail(503, failure.message); }
        if (fallback?.ok && fallback.data?.ok === true) return fallback.data;
        throw fail(409, fallback?.error || '启动器无法处理离线设置。');
      }
      if (payload) throw fail(503, '无法确认保存结果。请刷新状态后再试。');
      if (error.cause?.code === 'ECONNREFUSED') {
        throw Object.assign(fail(503, '无法连接鲸鲸内核。'), { kernelOffline: true });
      }
      if (signal.aborted) throw fail(504, '鲸鲸内核状态请求超时，请稍后刷新。');
      throw fail(503, '无法读取鲸鲸内核状态，请在电脑端检查内核或端口设置。');
    }
    if (!response.ok) {
      throw fail(502, payload
        ? '鲸鲸拒绝了这项操作。请在电脑端查看详情。'
        : '鲸鲸内核状态接口返回错误（HTTP ' + response.status + '）。请在电脑端检查内核或端口设置。');
    }
    try {
      result = await response.json();
    } catch {
      if (payload) throw fail(503, '无法确认保存结果。请刷新状态后再试。');
      if (signal.aborted) throw fail(504, '鲸鲸内核状态请求超时，请稍后刷新。');
      throw fail(502, '鲸鲸内核状态响应无法读取，请在电脑端检查内核或端口设置。');
    }
    if (result?.ok !== true) {
      throw fail(502, payload
        ? '鲸鲸拒绝了这项操作。请在电脑端查看详情。'
        : '鲸鲸内核未返回有效状态，请在电脑端检查内核。');
    }
    return result;
  }

  async function stickerReport() {
    const [featureState, config] = await Promise.all([whale('/api/features'), whale('/api/config')]);
    const enabled = featureState.features?.find(item => item.key === 'stickers')?.value === true;
    const library = enabled ? await whale('/api/stickers/status').catch(error => {
      if (!error.kernelOffline) throw error;
      return null;
    }) : null;
    const stored = config.config?.sticker || {};
    const chance = Number(stored.demandChance ?? 0.7);
    return { title: '表情包', rows: [], sticker: {
      enabled, manageable: Boolean(library), folder: cleanText(stored.dir, 480),
      frequency: Math.round(Math.min(1, Math.max(0, Number.isFinite(chance) ? chance : 0.7)) * 100),
      ensure: groupBoolean(stored.ensureSend, false), collect: groupBoolean(stored.collectReceived, false),
      testChat: cleanText(library?.testChat || stored.testChat || '文件传输助手', 160),
      pending: count(library?.pending),
      jobs: items(library?.jobs, 20).map(job => ({ filename: cleanText(job.filename), status: cleanText(job.status) })),
      categories: items(library?.emotions, 200).map(item => ({
        id: cleanText(item.key, 80), label: cleanText(item.label, 80), count: count(item.count),
        custom: typeof item.key === 'string' && item.key.startsWith('x:'),
        files: items(item.items, 1000).filter(file => stickerField(file.id, 420)).map(file => ({
          id: file.id, name: cleanText(file.name, 160),
        })),
      })),
    } };
  }

  async function stickerImage(req, res) {
    const { emotion, name } = await parseBody(req);
    if (!stickerField(emotion, 80) || !stickerField(name, 420)) throw fail(400, '表情包无效。');
    const query = new URLSearchParams({ emotion, name });
    const signal = AbortSignal.timeout(8000);
    const image = await fetch('http://127.0.0.1:' + kernelPort() + '/api/stickers/image?' + query,
      { redirect: 'error', signal }).catch(() => null);
    const type = image?.headers.get('content-type');
    if (!image?.ok || !['image/gif', 'image/png', 'image/jpeg', 'image/webp'].includes(type)) {
      await image?.body?.cancel();
      throw fail(404, '表情包图片不可用。');
    }
    const parts = [];
    let bytes = 0;
    for await (const part of image.body) {
      bytes += part.length;
      if (bytes > 8 * 1024 * 1024) throw fail(413, '图片超过手机预览上限。');
      parts.push(part);
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(Buffer.concat(parts, bytes));
  }

  async function uploadSticker(req) {
    const { emotion, file } = await parseBody(req, Math.ceil(stickerFileBytes * 4 / 3) + 4096);
    if (!stickerField(emotion, 80) || !stickerField(file?.name, 240) || typeof file?.data !== 'string') {
      throw fail(400, '请先选择分类和图片。');
    }
    await whale('/api/stickers/upload', { emotion, files: [{ name: file.name, data: file.data }] });
    return { message: '图片已上传。' };
  }

  async function momentsReport() {
    const [policy, publish, latest] = await Promise.all([whale('/api/moments/settings'), whale('/api/moments/publish-settings'),
      whale('/api/moments/latest').catch(() => null)]);
    return { title: '朋友圈', rows: [], moments: {
      online: Boolean(latest), autoLike: policy.autoLike === true, hours: count(policy.autoReadEveryHours) ?? 0,
      likeLimit: count(policy.autoLikeMaxPerDay) ?? 0, featureEnabled: publish.featureEnabled === true,
      scheduled: publish.enabled === true, withImage: publish.withImage === true,
      interval: publish.interval, publishLimit: count(publish.maxPerDay) ?? 1,
      status: cleanText(publish.status, 60), preview: cleanText(publish.preview, 1200),
      latest: momentItems(latest?.snapshot?.items),
    } };
  }

  async function currentWechatAccount() {
    const { gateways } = await whale('/api/status');
    return cleanText(gateways?.find(item => item.platform === 'wechat')?.bridge?.account, 120);
  }

  async function dashboard() {
    const status = await whale('/api/status').catch(error => {
      if (error.kernelOffline) return null;
      throw error;
    });
    if (!status && !managedOffline) return { kernel: null };
    const [presets, persona, features] = await Promise.all([
      whale('/api/persona/presets').catch(() => null),
      whale('/api/persona').catch(() => null),
      whale('/api/features').catch(() => null),
    ]);
    if (status) return project(status, presets, persona, features);
    const config = await whale('/api/config').catch(() => null);
    return { ...project({ group: config?.config?.group }, presets, persona, features), kernel: null,
      configurationAvailable: Boolean(config) };
  }

  async function editor() {
    const response = await whale('/api/config');
    return { groups: editableConfig(response.config) };
  }

  async function launcherFeature(action, data) {
    let result;
    try { result = await controlLauncher(action, data); }
    catch (error) { throw fail(503, error.message); }
    if (!result?.ok) throw fail(409, result?.error || '电脑端无法完成操作。');
    return result;
  }

  // 锁屏、空闲、保活这些只有启动器问得到；内核状态只做叠加，内核没开时主机卡片仍要能用。
  async function hostReport() {
    const [launcher, status] = await Promise.all([
      controlLauncher('host-state', {}).catch(() => null),
      whale('/api/status').catch(() => null),
    ]);
    if (!launcher?.ok || !launcher.data) throw fail(503, '启动器未运行，主机状态不可用。');
    const state = launcher.data;
    const gateway = status?.gateways?.find(item => item.platform === 'wechat');
    return {
      ok: true,
      data: {
        locked: state.locked === true,
        inputDesktop: cleanText(state.inputDesktop, 120),
        logonUI: state.logonUI === true,
        // 启动器给的是前台窗口句柄（数字）；旧版若给标题字符串也照原样截断，不丢数据。
        foreground: typeof state.foreground === 'number' && Number.isFinite(state.foreground)
          ? state.foreground : cleanText(state.foreground, 240),
        idleSeconds: count(state.idleSeconds),
        sessionId: Number.isInteger(state.sessionId) ? state.sessionId : null,
        keepAwake: ['off', 'system', 'display'].includes(state.keepAwake) ? state.keepAwake : 'off',
        remoteProcessLaunch: state.remoteProcessLaunch === true,
        autoStart: state.autoStart === true,
        processLaunchAllowed: state.processLaunchAllowed === true,
        hostname: cleanText(state.hostname, 120),
        uptimeSeconds: count(state.uptimeSeconds),
        kernelRunning: Boolean(status),
        // 内核能回 /api/status 就说明已就绪；没回就保持 false，不阻塞主机卡片。
        kernelReady: Boolean(status),
        bridgeRunning: gateway?.enabled === true || gateway?.bridge?.online === true,
        bridgeOnline: gateway?.bridge?.online === true,
        // 笔记本 / 「关屏锁定」策略下远程关屏会变成锁屏，前端据此禁用按钮并给出原因。
        isLaptop: state.isLaptop === true,
        displayOffBlocked: state.displayOffBlocked === true,
        displayOffBlockedReason: cleanText(state.displayOffBlockedReason, 300),
        displayControl: state.displayControl === true,
      },
    };
  }

  async function hostCommand(req) {
    const { action, value, confirm } = await parseBody(req, 8192);
    const modes = new Set(['off', 'system', 'display']);
    if (action === 'remote-process-launch') throw fail(403, '请在电脑端更改「允许手机启动内核」。');
    if (!['keep-awake', 'wake-display', 'display-off', 'display-control', 'auto-start'].includes(action)) {
      throw fail(400, '未知的主机操作。');
    }
    // 除点亮/关闭屏幕外都会改变电源或开机行为，必须由前端二次确认后再提交。
    if (action !== 'wake-display' && action !== 'display-off' && confirm !== true) throw fail(400, '这个操作需要二次确认。');
    let forwarded;
    if (action === 'keep-awake') {
      if (!modes.has(value)) throw fail(400, '保活模式无效。');
      forwarded = ['host-keep-awake', { mode: value }];
    } else if (action === 'wake-display') {
      forwarded = ['host-wake-display', {}];
    } else if (action === 'display-off') {
      forwarded = ['host-display-off', {}];
    } else {
      if (typeof value !== 'boolean') throw fail(400, '开关状态无效。');
      forwarded = ['host-config', action === 'auto-start' ? { autoStart: value } : { displayControl: value }];
    }
    let result;
    // 启动器原始异常（连接失败、超时）对手机用户没有意义，统一换成能指导操作的话术。
    try { result = await controlLauncher(...forwarded); }
    catch { throw fail(503, '启动器未运行，主机状态不可用。'); }
    if (!result || typeof result !== 'object') throw fail(502, '启动器没有返回结果。');
    if (result.ok !== true) throw fail(409, cleanText(result.error, 200) || '电脑端无法完成这项主机操作。');
    return result;
  }

  async function pageReport(page) {
    switch (page) {
      case 'stickers': return stickerReport();
      case 'moments': return momentsReport();
      case 'reminders': {
        const [result, diary] = await Promise.all([whale('/api/reminders'), whale('/api/diary').catch(() => null)]);
        return { title: '提醒列表', rows: [], diary: diary ? {
          busy: diary.status === 'running', sendsToOwner: diary.sendToOwner === true,
          message: cleanText(diary.message, 140),
        } : null, reminders: items(result.items).map(item => ({
          id: cleanText(item.id, 120),
          text: cleanText(item.text, 500),
          dueAt: count(item.dueAt),
          status: cleanText(item.status, 30),
          cancelable: ['pending', 'retrying'].includes(item.status),
        })) };
      }
      case 'bridge': {
        const result = await whale('/api/wechat/accounts');
        return { title: '微信账号', rows: [],
          accounts: items(result.accounts).filter(item => typeof item.account === 'string').map(item => ({
            id: cleanText(item.account),
            label: cleanText(item.nick || item.account),
          })),
          selectedAccount: cleanText(result.current || result.wanted),
          commands: [{ action: 'refresh-accounts', label: '刷新账号' }] };
      }
      case 'plugins': {
        const [market, featureState] = await Promise.all([launcherFeature('market-read'), whale('/api/features')]);
        return { title: '插件市场', rows: [], market,
          javascriptPlugins: featureState.features?.find(item => item.key === 'javascriptPlugins')?.value === true };
      }
      case 'voice': {
        const voice = await launcherFeature('voice-read');
        return { title: '语音发送', rows: [], voice };
      }
      case 'settings': return { title: '外观', rows: [], appearance: await launcherFeature('appearance-read') };
      default: throw fail(400, '没有这个页面。');
    }
  }

  async function pageCommand(req) {
    const { action, value, body } = await parseBody(req, 8192);
    const cleanId = typeof value === 'string' && value.length <= 120;
    switch (action) {
      case 'sticker-toggle':
        if (typeof body?.enabled !== 'boolean') throw fail(400, '开关状态无效。');
        await whale('/api/features', { key: 'stickers', value: body.enabled });
        return { message: body.enabled ? '表情包已开启。' : '表情包已关闭。' };
      case 'sticker-collect':
        if (typeof body?.enabled !== 'boolean') throw fail(400, '开关状态无效。');
        await whale('/api/config', { patch: { 'sticker.collectReceived': body.enabled } });
        return { message: '表情包收集设置已保存。' };
      case 'sticker-frequency':
        if (!Number.isInteger(body?.frequency) || body.frequency < 0 || body.frequency > 100 || typeof body.ensure !== 'boolean') {
          throw fail(400, '表情包频率无效。');
        }
        await whale('/api/config', { patch: { 'sticker.demandChance': body.frequency / 100, 'sticker.ensureSend': body.ensure } });
        return { message: '表情包频率已保存。' };
      case 'sticker-folder': {
        const folder = typeof body?.folder === 'string' ? body.folder.trim() : null;
        if (folder === null || (folder !== '' && (!stickerField(folder, 480) || /[:*?<>|"\x7f]/.test(folder) ||
            /^[\\/]/.test(folder) || folder.split(/[\\/]/).some(part => part === '.' || part === '..' || /[ .]$/.test(part))))) {
          throw fail(400, '请输入安装目录内的相对路径，例如 data/stickers。');
        }
        await whale('/api/config', { patch: { 'sticker.dir': folder } });
        return { message: '表情包目录已保存。' };
      }
      case 'sticker-send':
        if (!stickerField(body?.emotion, 80) || body.confirm !== true ||
            (body.chat !== undefined && !stickerField(body.chat, 160))) throw fail(400, '请确认分类和接收会话。');
        await whale('/api/stickers/test', { emotion: body.emotion, chat: body.chat });
        return { message: '测试表情包已排队，请在微信核对结果。' };
      case 'sticker-delete':
        if (!stickerField(body?.emotion, 80) || !stickerField(body?.name, 420) || body.confirm !== true) {
          throw fail(400, '请确认要删除的表情包。');
        }
        await whale('/api/stickers/delete', { emotion: body.emotion, name: body.name });
        return { message: '表情包已删除。' };
      case 'sticker-open':
        if (body?.emotion !== undefined && !stickerField(body.emotion, 80)) throw fail(400, '分类无效。');
        return launcherFeature(action, body || {});
      case 'sticker-open-collected':
        return launcherFeature(action, {});
      case 'import-stickers':
        await whale('/api/stickers/import-presets', {});
        return { message: '预置表情包已导入。' };
      case 'sticker-category': {
        const { action: operation, label, newLabel } = body || {};
        if (!['add', 'rename', 'remove'].includes(operation) || typeof label !== 'string' ||
            !label.trim() || label.length > 80 || (operation === 'rename' &&
              (typeof newLabel !== 'string' || !newLabel.trim() || newLabel.length > 80))) {
          throw fail(400, '表情包分类名称或操作无效。');
        }
        await whale('/api/stickers/category', { action: operation, label, newLabel });
        return { message: '表情包分类已保存。' };
      }
      case 'generate-diary': {
        const result = await whale('/api/diary/generate', {});
        return { message: cleanText(result.message, 140) || '已提交日记生成任务。' };
      }
      case 'save-persona-preset':
      case 'rename-persona-preset': {
        const id = body?.id;
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const rename = action === 'rename-persona-preset';
        if (!name || name.length > 40 || (rename && !validPresetId(id))) throw fail(400, '预设名称或编号无效。');
        await whale(rename ? '/api/persona/preset/rename' : '/api/persona/preset/save', rename ? { id, name } : { name });
        return { message: '人设预设已保存。' };
      }
      case 'delete-persona-preset':
        if (!validPresetId(value)) throw fail(400, '预设编号无效。');
        await whale('/api/persona/preset/delete', { id: value });
        return { message: '人设预设已移除。' };
      case 'javascript-plugins-toggle':
        if (typeof body?.enabled !== 'boolean' || (body.enabled && body.confirm !== true)) throw fail(400, '请确认 JavaScript 插件权限。');
        await whale('/api/features', { key: 'javascriptPlugins', value: body.enabled });
        return { message: body.enabled ? 'JavaScript 插件总开关已开启。' : 'JavaScript 插件总开关已关闭。' };
      case 'moments-auto': {
        const { autoLike, hours, limit } = body || {};
        if (typeof autoLike !== 'boolean' || !Number.isInteger(hours) || hours < 0 || hours > 24 ||
            !Number.isInteger(limit) || limit < 0 || limit > 20) throw fail(400, '自动读取或点赞参数无效。');
        await whale('/api/moments/settings', { autoLike, autoReadEveryHours: hours, autoLikeMaxPerDay: limit });
        return { message: '朋友圈自动读取与点赞设置已保存。' };
      }
      case 'moments-publish-toggle':
        if (typeof body?.enabled !== 'boolean') throw fail(400, '开关状态无效。');
        await whale('/api/moments/publish-settings', { featureEnabled: body.enabled });
        return { message: body.enabled ? '朋友圈发表总开关已开启。' : '朋友圈发表总开关已关闭。' };
      case 'moments-publish-save': {
        const { featureEnabled, enabled, withImage, interval, maxPerDay, confirm } = body || {};
        if (typeof featureEnabled !== 'boolean' || typeof enabled !== 'boolean' || typeof withImage !== 'boolean' ||
            !Number.isFinite(interval) || interval <= 0 || !Number.isSafeInteger(maxPerDay) || maxPerDay < 0 ||
            (enabled && (!featureEnabled || confirm !== true))) throw fail(400, '请确认定时发表设置。');
        await whale('/api/moments/publish-settings', { featureEnabled, enabled, withImage, interval, maxPerDay });
        return { message: '朋友圈自动发表设置已保存。' };
      }
      case 'moments-publish-now':
        if (body?.confirm !== true || typeof body.withImage !== 'boolean') throw fail(400, '请确认立即发表。');
        await whale('/api/moments/publish-test', { confirm: true, withImage: body.withImage });
        return { message: '已提交发表任务，请刷新状态查看结果。' };
      case 'moments-open-pictures': return launcherFeature(action, body);
      case 'read-moments': {
        const result = await whale('/api/moments/read', { limit: 20, keyword: cleanText(body?.keyword, 100),
          username: cleanText(body?.username, 120), own: body?.own === true, account: await currentWechatAccount() });
        return { id: result.id, message: '已请求读取朋友圈。' };
      }
      case 'moments-action': {
        const operation = body?.operation;
        const publisher = cleanText(body?.publisher, 120).trim(), keyword = cleanText(body?.keyword, 100).trim();
        const content = cleanText(body?.content, 1000), replyTo = cleanText(body?.replyTo, 120);
        if (!['like', 'unlike', 'comment', 'reply'].includes(operation) || !publisher || !keyword || body.confirm !== true) {
          throw fail(400, '请确认朋友圈操作、发布者昵称和关键词。');
        }
        const result = await whale('/api/moments/action', { action: operation, publisher, keyword, content, replyTo,
          account: await currentWechatAccount() });
        return { id: result.id, message: '已提交朋友圈互动任务。' };
      }
      case 'moments-result': {
        if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw fail(400, '任务编号无效。');
        const result = await whale('/api/moments/result?id=' + encodeURIComponent(value));
        return { state: cleanText(result.status, 32), message: cleanText(result.error, 300), items: momentItems(result.items) };
      }
      case 'cancel-reminder':
        if (!cleanId || !value) throw fail(400, '提醒编号无效。');
        await whale('/api/reminders/cancel', { id: value });
        return { message: '提醒已取消。' };
      case 'switch-account':
        if (!cleanId) throw fail(400, '微信账号无效。');
        await whale('/api/wechat/account', { account: value });
        return { message: '微信账号已保存，等待桥接重新连接。' };
      case 'refresh-accounts': {
        const result = await whale('/api/wechat/accounts/refresh', {});
        if (result.refreshed === false) throw fail(502, '刷新微信账号失败，请查看诊断。');
        return { message: '微信账号已刷新。' };
      }
      case 'voice-toggle':
        if (typeof body?.enabled !== 'boolean') throw fail(400, '开关状态无效。');
        return launcherFeature(action, { enabled: body.enabled });
      case 'voice-save':
      case 'voice-check-key':
      case 'voice-catalog':
      case 'voice-test':
      case 'voice-test-status':
      case 'voice-install-driver':
      case 'appearance-save':
      case 'market-install':
      case 'market-enabled':
      case 'market-remove':
        return launcherFeature(action, body);
      default: throw fail(400, '未知操作。');
    }
  }

  async function identity(req) {
    if (req.method === 'GET') {
      const { persona } = await whale('/api/persona');
      return Object.fromEntries([...identityFields].map(([key, rule]) => [key, typeof rule === 'boolean'
        ? groupBoolean(persona?.[key], rule) : cleanText(persona?.[key], rule)]));
    }
    const data = await parseBody(req, 144000);
    const entries = Object.entries(data);
    if (entries.length === 0 || entries.some(([key, value]) => {
      const rule = identityFields.get(key);
      return typeof rule === 'boolean' ? typeof value !== 'boolean' :
        !rule || typeof value !== 'string' || value.length > rule;
    })) {
      throw fail(400, '人设字段不正确或超出字数限制。');
    }
    if (writing) throw fail(409, '有一项更改正在保存，请稍后再试。');
    writing = true;
    try {
      await whale('/api/persona', data);
      return { saved: true };
    } finally { writing = false; }
  }

  async function modelSettings(req) {
    if (req.method === 'GET') {
      const current = await whale('/api/settings');
      const visibleUrl = value => {
        try {
          const url = new URL(value);
          if (url.username || url.password || url.search || url.hash) return '';
          return cleanText(value, 300);
        } catch { return ''; }
      };
      return {
        provider: cleanText(current.provider),
        model: cleanText(current.model, 80),
        baseUrl: visibleUrl(current.baseUrl),
        hasKey: current.hasKey === true,
        thinking: current.thinking === true,
        providers: Object.entries(current.providers || {}).map(([id, option]) => ({
          id: cleanText(id, 32),
          label: cleanText(option.label),
          model: cleanText(option.model, 80),
          baseUrl: visibleUrl(option.baseUrl),
          thinking: option.thinking === true,
        })),
      };
    }
    const body = await parseBody(req);
    const limits = new Map([['provider', 32], ['model', 80], ['baseUrl', 300], ['apiKey', 250]]);
    const entries = Object.entries(body);
    if (!entries.length || entries.some(([key, value]) => key === 'thinking' ? typeof value !== 'boolean' :
      !limits.has(key) || typeof value !== 'string' || value.length > limits.get(key))) {
      throw fail(400, '模型设置无效。');
    }
    if (writing) throw fail(409, '有一项更改正在保存，请稍后再试。');
    writing = true;
    try {
      if (body.baseUrl) {
        let target;
        try { target = new URL(body.baseUrl); }
        catch { throw fail(400, '请输入有效的模型接口地址。'); }
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
        if (target.username || target.password || target.search || target.hash ||
            !(target.protocol === 'https:' || (loopback && target.protocol === 'http:'))) {
          throw fail(400, '请填写不带账号和查询参数的 HTTPS 接口地址。本机接口可使用 HTTP。');
        }
        const current = await whale('/api/settings');
        let previous;
        try { previous = new URL(current.baseUrl).origin; } catch { /* 未配置地址 */ }
        if (target.origin !== previous && !body.apiKey?.trim()) {
          throw fail(400, '修改模型接口站点时，请填写这个站点的 API Key，或在电脑上完成设置。');
        }
      }
      await whale('/api/settings', body);
      return { saved: true };
    } finally { writing = false; }
  }

  async function update(req, isPersona) {
    const data = await parseBody(req);
    if (writing) throw fail(409, '有一项更改正在保存，请稍后再试。');
    writing = true;
    try {
      if (isPersona) {
        if (!validPresetId(data.id)) throw fail(400, '请选择一个有效的人设预设。');
        await whale('/api/persona/preset', { id: data.id });
      } else {
        const setting = settings.get(data.key);
        if (!setting || !(setting.accepts?.(data.value) ?? typeof data.value === 'boolean')) {
          throw fail(400, '这个设置不支持远程修改，或该值超出范围。');
        }
        await whale(setting.path, setting.payload(data.value));
      }
    } finally {
      writing = false;
    }
  }

  return http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    headers(res);
    const url = req.url;
    const asset = assets.get(url);
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': asset.mime });
      return res.end(req.method === 'HEAD' ? undefined : asset.body);
    }
    const isDashboard = req.method === 'GET' && url === '/console/status';
    const isEditor = req.method === 'GET' && url === '/console/settings';
    const isDiagnosis = req.method === 'GET' && url === '/console/diagnostics';
    const isControl = req.method === 'POST' && url === '/console/control';
    const isPage = req.method === 'POST' && url === '/console/page';
    const isPageCommand = req.method === 'POST' && url === '/console/page-command';
    // 主机端点同样属于配对 Key 之后的能力，必须先登记再进鉴权白名单，否则会先落到 404。
    const isHost = req.method === 'GET' && url === '/console/host';
    const isHostCommand = req.method === 'POST' && url === '/console/host-command';
    const isStickerImage = req.method === 'POST' && url === '/console/sticker-image';
    const isStickerUpload = req.method === 'POST' && url === '/console/sticker-upload';
    const isIdentity = ['GET', 'POST'].includes(req.method) && url === '/console/identity';
    const isModelSettings = ['GET', 'POST'].includes(req.method) && url === '/console/model';
    const isPairingCheck = req.method === 'HEAD' && url === '/console/pairing';
    const isPersona = req.method === 'POST' && url === '/console/persona';
    const isSetting = req.method === 'POST' && url === '/console/setting';
    if (!(isDashboard || isEditor || isDiagnosis || isControl || isPage || isPageCommand || isIdentity ||
        isModelSettings || isPairingCheck || isPersona || isSetting || isStickerImage || isStickerUpload ||
        isHost || isHostCommand)) {
      req.resume();
      return json(res, 404, { error: '页面不存在。' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' || !authorized(req, expected)) {
      req.resume();
      return json(res, 401, { error: '配对密钥无效。请复制电脑端当前显示的密钥。' });
    }
    if (isPairingCheck) {
      res.writeHead(204, { 'X-Whale-Console-Instance': consoleInstance });
      return res.end();
    }
    (async () => {
      if (isDashboard) return json(res, 200, await dashboard());
      if (isEditor) return json(res, 200, await editor());
      if (isPage) return json(res, 200, await pageReport((await parseBody(req)).page));
      if (isPageCommand) return json(res, 200, await pageCommand(req));
      if (isHost) return json(res, 200, await hostReport());
      if (isHostCommand) return json(res, 200, await hostCommand(req));
      if (isStickerUpload) return json(res, 200, await uploadSticker(req));
      if (isStickerImage) return await stickerImage(req, res);
      if (isIdentity) return json(res, 200, await identity(req));
      if (isModelSettings) return json(res, 200, await modelSettings(req));
      if (isDiagnosis || isControl) {
        const action = isDiagnosis ? 'diagnostics' : (await parseBody(req)).action;
        // host-* 也在 actions 白名单里（启动器通道统一校验），但它们是主机卡片专用的
        // 带参动作，不能从只传一个 action 的 /console/control 进来。
        if (!actions.has(action) || (isControl && (action === 'diagnostics' || action.startsWith('host-'))))
          return json(res, 400, { error: '未知操作。' });
        let result;
        try { result = await controlLauncher(action); }
        catch (error) { return json(res, 503, { error: error.message }); }
        return json(res, result?.ok ? 200 : 409, result || { error: '启动器没有返回结果。' });
      }
      await update(req, isPersona);
      const snapshot = await dashboard().catch(error => ({
        statusError: error.status ? error.message : '无法刷新鲸鲸内核状态。',
      }));
      return json(res, 200, { saved: true, ...snapshot });
    })().catch(error => json(res, error.status || 500, { error: error.status ? error.message : '控制台暂时无法处理请求。' }));
  });
}

if (require.main === module) {
  const guided = process.platform === 'win32' && process.argv.includes('--windows-guide');
  const token = guided ? process.env.WHALE_CONSOLE_PAIRING_KEY : randomBytes(24).toString('hex');
  delete process.env.WHALE_CONSOLE_PAIRING_KEY;
  const port = Number(process.env.WHALE_CONSOLE_PORT || 8790);
  const whalePort = Number(process.env.WHALE_KERNEL_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === whalePort) {
    throw new Error('Invalid console port. The console and kernel must use different ports.');
  }
  if (typeof fetch !== 'function') throw new Error('Use Node.js 18 or later.');
  const server = createConsole({ token, whalePort, managedOffline: guided,
    discoverWhalePort: guided && !process.env.WHALE_KERNEL_PORT });
  server.on('error', error => {
    console.error('Unable to start the console:', error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    if (guided) {
      const url = 'http://127.0.0.1:' + port;
      console.log('鲸鲸远程控制台：' + url);
      console.log('配对 Key：' + token);
      console.log('请把上面的 Key 粘贴到浏览器，并保持本窗口开启。');
      const browser = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
      browser.on('error', () => console.log('请在浏览器打开 ' + url));
      browser.unref();
      return;
    }
    console.log('Whale Girl Remote Console');
    console.log('On this computer: http://127.0.0.1:' + port);
    console.log('Pairing key: ' + token);
    console.log('Phone access: tailscale serve ' + port + ' (run in a second terminal)');
    console.log('Keep this window open. Press Ctrl+C to stop.');
  });
}

module.exports = { createConsole };
