'use strict';

/**
 * 人设预设：内置（assets/personas/）、插件市场（data/plugins/*.persona.json）、
 * 用户自建（data/personas/*.json）三个来源。
 *
 * 内置和插件市场目录不直接删除：用户点删除时写进 data/personas/_hidden.json，
 * 只在列表里隐藏；插件卸载后重新安装会生成新文件（mtime/size 变了），
 * 自动解除隐藏，避免「重装插件后预设永远回不来」。
 */
const fs = require('node:fs');
const path = require('node:path');
const { portableFields } = require('./portable');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;
const MARKET_FILE = /^([a-z][a-z0-9-]{0,47})\.persona\.json$/;
const MARKET_ID_PREFIX = 'market-';
const USER_PREFIX = 'user-';
const USER_FILE = /^user-[a-z0-9-]{1,60}\.json$/i;
const HIDDEN_FILE = '_hidden.json';
const MAX_USER_BYTES = 256 * 1024;
const MAX_MARKET_BYTES = 192 * 1024;
const MAX_NAME = 40;
const MAX_DESCRIPTION = 300;
const USER_ORDER = 9000;

function dirFor(config) {
  const root = (config && config.paths && config.paths.root) || path.resolve(__dirname, '..', '..');
  return path.join(root, 'assets', 'personas');
}

function dataDirFor(config) {
  if (config && config.paths && config.paths.dataDir) return config.paths.dataDir;
  const root = (config && config.paths && config.paths.root) || path.resolve(__dirname, '..', '..');
  return path.join(root, 'data');
}

function marketDir(config) {
  return path.join(dataDirFor(config), 'plugins');
}

function userDir(config) {
  return path.join(dataDirFor(config), 'personas');
}

function hiddenFile(config) {
  return path.join(userDir(config), HIDDEN_FILE);
}

function readFile(file, maxBytes = MAX_USER_BYTES) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function writeFileAtomic(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------------------------- 删除标记 ---------------------------- */

function readHidden(config) {
  const data = readFile(hiddenFile(config), 64 * 1024);
  const items = data && data.items && typeof data.items === 'object' && !Array.isArray(data.items)
    ? data.items : {};
  return { version: 1, items: { ...items } };
}

function writeHidden(config, hidden) {
  writeFileAtomic(hiddenFile(config), JSON.stringify(hidden, null, 2) + '\n');
}

/** 内置永远保持隐藏；市场预设文件换了（重装/升级）就自动恢复显示 */
function visibleUnderHidden(config, item, hidden, changed) {
  const mark = hidden.items[item.id];
  if (!mark) return true;
  if (item.source !== 'market') return false;
  const unchanged = Number(mark.mtimeMs) === Number(item.mtimeMs) && Number(mark.size) === Number(item.size);
  if (unchanged) return false;
  delete hidden.items[item.id];
  changed.value = true;
  return true;
}

function marketPreset(config, name) {
  const match = MARKET_FILE.exec(name);
  if (!match) return null;
  try {
    const dir = marketDir(config);
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(path.dirname(dir)).isDirectory()) return null;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_MARKET_BYTES) return null;
    const data = readFile(file, MAX_MARKET_BYTES);
    const hasIdentity = data?.schemaVersion === 1 && (typeof data.personaName === 'string' || typeof data.personality === 'string');
    if (typeof data?.customPrompt !== 'string' || (!data.customPrompt.trim() && !hasIdentity) || data.customPrompt.length > 24000 ||
        typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) return null;
    return {
      schemaVersion: 1,
      id: MARKET_ID_PREFIX + match[1],
      file: name,
      source: 'market',
      name: data.name,
      version: String(data.version || '').slice(0, 40),
      description: String(data.description || '').slice(0, 600),
      ...portableFields(data),
      ...portableFields(readFile(path.join(userDir(config), MARKET_ID_PREFIX + match[1] + '.json')) || {}, { local: true }),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch { return null; }
}

function userPreset(config, name) {
  if (!USER_FILE.test(name)) return null;
  try {
    const file = path.join(userDir(config), name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_USER_BYTES) return null;
    const data = readFile(file, MAX_USER_BYTES);
    if (!data || typeof data.name !== 'string' || !data.name.trim()) return null;
    return {
      ...data,
      // 用户文件的 id 一律以文件名为准，避免手改文件冒充内置/市场预设
      id: name.replace(/\.json$/i, ''),
      file: name,
      source: 'user',
      name: String(data.name || '').slice(0, MAX_NAME),
      description: String(data.description || '').slice(0, MAX_DESCRIPTION),
      updatedAt: Number(data.updatedAt) || stat.mtimeMs,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch { return null; }
}

/** 列出可用预设：用户自建 → 内置 → 插件市场；已删除的按标记过滤 */
function list(config) {
  const hidden = readHidden(config);
  const changed = { value: false };
  const out = [];

  const userNames = [];
  try {
    userNames.push(...fs.readdirSync(userDir(config)).filter((f) => USER_FILE.test(f)));
  } catch { /* 首次保存前目录不存在 */ }
  for (const name of userNames) {
    const item = userPreset(config, name);
    if (!item) continue;
    // 用户文件是物理删除，不需要隐藏标记；清掉同名旧标记防脏数据
    if (hidden.items[item.id]) {
      delete hidden.items[item.id];
      changed.value = true;
    }
    out.push(item);
  }

  let builtinNames = [];
  try {
    builtinNames = fs.readdirSync(dirFor(config)).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch { /* 市场预设独立于内置目录 */ }
  for (const name of builtinNames) {
    const data = readFile(path.join(dirFor(config), name));
    if (!data) continue;
    const id = String(data.id || name.replace(/\.json$/i, ''));
    if (!ID_RE.test(id)) continue;
    const version = String(data.version || '');
    // order 是「列表里的位置」，按攻击力从低到高排；没写就排到最后
    const order = Number.isFinite(Number(data.order)) && data.order !== '' && data.order != null
      ? Number(data.order) : 1e9;
    const item = {
      id,
      file: name,
      source: 'builtin',
      version,
      order,
      name: String(data.name || ''),
      description: String(data.description || ''),
      chars: String(data.customPrompt || '').length,
    };
    if (!visibleUnderHidden(config, item, hidden, changed)) continue;
    out.push(item);
  }

  try {
    for (const name of fs.readdirSync(marketDir(config))) {
      const item = marketPreset(config, name);
      if (!item || out.some((preset) => preset.id === item.id)) continue;
      if (!visibleUnderHidden(config, item, hidden, changed)) continue;
      const { customPrompt, ...metadata } = item;
      out.push({ ...metadata, order: 1e9, chars: String(customPrompt || '').length });
    }
  } catch { /* 插件目录通常在首次安装前不存在 */ }

  if (changed.value) {
    try { writeHidden(config, hidden); } catch { /* 标记写不进去不影响本次列表 */ }
  }

  const rank = { user: 0, builtin: 1, market: 2 };
  return out.sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9)
    || (a.source === 'user'
      ? (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || a.id.localeCompare(b.id)
      : 0)
    || a.order - b.order
    || a.version.localeCompare(b.version, 'en', { numeric: true })
    || a.id.localeCompare(b.id));
}

/** 读一个人设预设；找不到或已删除返回 null */
function load(config, id) {
  const key = String(id || '').trim();
  if (!key || !ID_RE.test(key)) return null;
  const item = list(config).find((preset) => preset.id === key || preset.file === key || preset.file === key + '.json');
  if (!item) return null;
  if (item.source === 'market') return marketPreset(config, item.file);
  const dir = item.source === 'user' ? userDir(config) : dirFor(config);
  const data = readFile(path.join(dir, item.file));
  if (!data) return null;
  const override = item.source === 'builtin'
    ? readFile(path.join(userDir(config), 'builtin-overrides', item.id + '.json')) : null;
  const fields = override?.schemaVersion === 1 ? {
    ...override, name: data.name, description: data.description, version: data.version,
  } : data;
  return { ...fields, id: item.id, file: item.file, source: item.source };
}

/** 当前配置快照：只拿身份、提示词和长度，不含模型/Key/群配置/记忆 */
function fromConfig(config) {
  const p = (config && config.persona) || {};
  const c = (config && config.chat) || {};
  const out = {
    schemaVersion: 1,
    personaName: String(p.name || '').trim().slice(0, 40),
    age: Math.max(1, Math.min(120, Number(p.age) || 23)),
    job: String(p.job || '').trim().slice(0, 80),
    appearance: String(p.appearance || '').trim().slice(0, 400),
    personality: String(p.personality || '').trim().slice(0, 500),
    background: String(p.background || '').trim().slice(0, 500),
    customPrompt: String(p.customPrompt || '').trim(),
    emoji: String(p.emojiLevel || '正常').trim(),
    ownerName: String(p.ownerName || '你').trim(),
    aliases: Array.isArray(p.aliases) ? p.aliases.slice() : [],
    masterRoast: p.masterRoast === true,
    proactive: p.proactive !== false,
    opinions: p.opinions !== false,
  };
  if (!['关', '少', '正常', '多'].includes(out.emoji)) out.emoji = '正常';
  for (const key of ['privateMaxChars', 'groupMaxChars', 'historyTurns', 'groupHistoryTurns', 'maxBubbles', 'discussionMaxChars', 'emojiChance']) {
    const n = Number(c[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanDescription(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_DESCRIPTION);
}

function newUserId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${USER_PREFIX}${stamp}-${rand}`;
}

/**
 * 把当前人设保存成用户预设；传 id 时更新已有的自建预设。
 * @returns {{ok:boolean, error?:string, preset?:object}}
 */
function saveUser(config, { id = '', name = '', description = '' } = {}) {
  let presetId = String(id || '').trim();
  const updating = Boolean(presetId);
  let previous = null;
  if (updating) {
    if (!ID_RE.test(presetId) || !presetId.toLowerCase().startsWith(USER_PREFIX)) {
      return { ok: false, error: '只能更新自己保存的预设' };
    }
    const file = path.join(userDir(config), presetId + '.json');
    if (!fs.existsSync(file)) return { ok: false, error: '这个自建预设已经不存在了' };
    previous = readFile(file);
    if (!previous) return { ok: false, error: '自建预设文件读不出来' };
  } else {
    presetId = newUserId();
  }

  const title = cleanName(name) || cleanName(previous?.name);
  if (!title) return { ok: false, error: '给预设起个名字（1~40 个字）' };

  const now = Date.now();
  const preset = {
    ...fromConfig(config),
    id: presetId,
    name: title,
    description: cleanDescription(description) || cleanDescription(previous?.description),
    version: String(previous?.version || '1').slice(0, 40),
    source: 'user',
    order: USER_ORDER,
    createdAt: Number(previous?.createdAt) || now,
    updatedAt: now,
  };
  if (!preset.description) delete preset.description;

  const file = path.join(userDir(config), presetId + '.json');
  try {
    writeFileAtomic(file, JSON.stringify(preset, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: '预设保存失败：' + ((err && err.message) || err) };
  }
  return { ok: true, preset: { ...preset, file: path.basename(file), mtimeMs: now } };
}

/** 保存人设后同步对应的本地预设，内置和市场原件保留用于升级。 */
function updateFromConfig(config, id) {
  const key = String(id || '').trim();
  if (/^market-[a-z][a-z0-9-]{0,47}$/.test(key)) {
    // 只改本地副本，不触碰下载包；停用时条目消失，重新启用仍保留用户修改。
    if (!marketPreset(config, key.slice(MARKET_ID_PREFIX.length) + '.persona.json')) return false;
    writeFileAtomic(path.join(userDir(config), key + '.json'), JSON.stringify(fromConfig(config), null, 2) + '\n');
    return true;
  }
  if (!key.toLowerCase().startsWith(USER_PREFIX)) {
    if (!ID_RE.test(key) || !list(config).some(item => item.id === key && item.source === 'builtin')) return false;
    const file = path.join(userDir(config), 'builtin-overrides', key + '.json');
    writeFileAtomic(file, JSON.stringify(fromConfig(config), null, 2) + '\n');
    return true;
  }
  const file = path.join(userDir(config), key + '.json');
  const previous = readFile(file);
  if (!previous) return false;
  const result = saveUser(config, { id: key, name: previous.name, description: previous.description });
  return Boolean(result.ok);
}

function resetMarketCopy(config, id) {
  const key = String(id || '').trim();
  if (!/^market-[a-z][a-z0-9-]{0,47}$/.test(key) || !marketPreset(config, key.slice(7) + '.persona.json'))
    return { ok: false, error: '市场人设不存在或未启用' };
  try {
    const file = path.join(userDir(config), key + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (err) { return { ok: false, error: '删除本地副本失败：' + err.message }; }
}

/**
 * 删除预设。内置/市场写隐藏标记，自建物理删除；正在使用的预设拒绝删除。
 * @returns {{ok:boolean, error?:string, kind?:string, id?:string}}
 */
function removePreset(config, id, { currentId = '' } = {}) {
  const key = String(id || '').trim();
  if (!key || !ID_RE.test(key)) return { ok: false, error: '预设 id 不合法' };
  if (currentId && key.toLowerCase() === String(currentId).trim().toLowerCase()) {
    return { ok: false, error: '正在使用这个预设，先切换到别的人设再删' };
  }
  const item = list(config).find((preset) => preset.id === key);
  if (!item) return { ok: false, error: '预设不存在或已删除' };

  if (item.source === 'user') {
    try {
      fs.unlinkSync(path.join(userDir(config), item.file));
    } catch (err) {
      return { ok: false, error: '删除预设失败：' + ((err && err.message) || err) };
    }
    return { ok: true, kind: 'user', id: key };
  }

  const hidden = readHidden(config);
  hidden.items[key] = {
    source: item.source,
    at: Date.now(),
    ...(item.source === 'market' ? { mtimeMs: item.mtimeMs, size: item.size } : {}),
  };
  try {
    writeHidden(config, hidden);
  } catch (err) {
    return { ok: false, error: '删除预设失败：' + ((err && err.message) || err) };
  }
  return { ok: true, kind: item.source, id: key };
}

/** 当前生效的预设来源：builtin / market / user；手写人设返回空串 */
function sourceOf(config, id) {
  const key = String(id || '').trim();
  if (!key) return '';
  const item = list(config).find((preset) => preset.id === key || preset.file === key + '.json');
  return item ? item.source : '';
}

/** 重命名自建预设：只改标题，不动人设内容和当前生效配置 */
function renamePreset(config, id, name) {
  const key = String(id || '').trim();
  if (!key || !ID_RE.test(key) || !key.toLowerCase().startsWith(USER_PREFIX)) {
    return { ok: false, error: '只能重命名自己保存的预设' };
  }
  const title = cleanName(name);
  if (!title) return { ok: false, error: '名字要 1~40 个字' };
  const file = path.join(userDir(config), key + '.json');
  const data = readFile(file);
  if (!data) return { ok: false, error: '这个自建预设已经不存在了' };
  const next = { ...data, id: key, name: title, updatedAt: Date.now() };
  try {
    writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: '重命名失败：' + ((err && err.message) || err) };
  }
  return { ok: true, preset: { ...next, file: path.basename(file) } };
}

/** 预设里允许写进人设的字段（不认识的字段忽略，避免带进乱七八糟的东西） */
function toPatch(preset) {
  if (!preset) return null;
  preset = require('./legacy').upgradeLegacyPersona(preset);
  const patch = {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  // preset.name 是「这一版预设的标题」（如「鲸鲸 v1：像群友一样聊天」），
  // 绝不能写进 persona.name —— 那会把她的名字改成预设标题。
  // 预设真想改名时用单独的 personaName 字段。
  if (preset.personaName) patch.name = str(preset.personaName, 40);
  if (preset.appearance) patch.appearance = str(preset.appearance, 400);
  if (preset.personality) patch.personality = str(preset.personality, 500);
  if (preset.background) patch.background = str(preset.background, 500);
  if (preset.customPrompt) patch.customPrompt = String(preset.customPrompt).trim();
  if (preset.emoji && ['关', '少', '正常', '多'].includes(String(preset.emoji))) patch.emoji = String(preset.emoji);
  if (preset.age) patch.age = Math.max(1, Math.min(120, Number(preset.age) || 23));
  if (preset.job) patch.job = str(preset.job, 80);
  if (preset.privateMaxChars) patch.privateMaxChars = Math.max(40, Math.min(800, Number(preset.privateMaxChars)));
  if (preset.groupMaxChars) patch.groupMaxChars = Math.max(20, Math.min(300, Number(preset.groupMaxChars)));
  if (preset.historyTurns) patch.historyTurns = Math.max(4, Math.min(120, Number(preset.historyTurns)));
  if (preset.groupHistoryTurns) patch.groupHistoryTurns = Math.max(2, Math.min(100, Number(preset.groupHistoryTurns)));
  if (preset.maxBubbles) patch.maxBubbles = Math.max(1, Math.min(8, Number(preset.maxBubbles)));
  const portable = portableFields(preset, { local: true });
  for (const key of ['ownerName', 'aliases', 'masterRoast', 'proactive', 'opinions', 'emojiChance', 'discussionMaxChars']) {
    if (Object.hasOwn(portable, key)) patch[key] = portable[key];
  }
  // 新包允许显式空值，切换时不能残留上一份人设的正文与外观。
  if (preset.schemaVersion === 1 || preset.source === 'user' || preset.source === 'market') {
    for (const key of ['job', 'appearance', 'personality', 'background', 'customPrompt']) {
      if (Object.hasOwn(portable, key)) patch[key] = portable[key];
    }
    for (const key of ['historyTurns', 'groupHistoryTurns']) if (Object.hasOwn(portable, key)) patch[key] = portable[key];
  }
  return Object.keys(patch).length ? patch : null;
}

module.exports = {
  list,
  load,
  toPatch,
  dirFor,
  userDir,
  fromConfig,
  saveUser,
  updateFromConfig,
  resetMarketCopy,
  removePreset,
  renamePreset,
  sourceOf,
  USER_PREFIX,
};
