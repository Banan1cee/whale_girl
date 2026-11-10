'use strict';

/**
 * 人设预设：assets/personas/ 下一个风格一个文件（persona-standard.json、persona-tieba.json…）。
 * 只读；列表按 order（攻击力从低到高）排。
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;
const MARKET_FILE = /^([a-z][a-z0-9-]{0,47})\.persona\.json$/;
const MARKET_ID_PREFIX = 'market-';

function dirFor(config) {
  const root = (config && config.paths && config.paths.root) || path.resolve(__dirname, '..', '..');
  return path.join(root, 'assets', 'personas');
}

function marketDir(config) {
  return path.join(config?.paths?.dataDir || path.join(path.dirname(path.dirname(dirFor(config))), 'data'), 'plugins');
}

function marketPreset(config, name) {
  const match = MARKET_FILE.exec(name);
  if (!match) return null;
  try {
    const dir = marketDir(config);
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(path.dirname(dir)).isDirectory()) return null;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 192 * 1024) return null;
    const data = readFile(file);
    if (typeof data?.customPrompt !== 'string' || !data.customPrompt.trim() || data.customPrompt.length > 24000 ||
        typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) return null;
    return { id: MARKET_ID_PREFIX + match[1], file: name, name: data.name,
      version: String(data.version || '').slice(0, 40), description: String(data.description || '').slice(0, 600),
      customPrompt: data.customPrompt };
  } catch { return null; }
}

/** 列出可用的预设文件（按 order 从小到大；没写 order 的排在后面，再按版本号） */
function list(config) {
  const dir = dirFor(config);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch { /* 市场预设独立于内置目录 */ }
  const out = [];
  for (const name of names) {
    const data = readFile(path.join(dir, name));
    if (!data) continue;
    const id = String(data.id || name.replace(/\.json$/i, ''));
    const version = String(data.version || '');
    // order 是「列表里的位置」，按攻击力从低到高排；没写就排到最后
    const order = Number.isFinite(Number(data.order)) && data.order !== '' && data.order != null
      ? Number(data.order) : 1e9;
    out.push({
      id,
      file: name,
      version,
      order,
      name: String(data.name || ''),
      description: String(data.description || ''),
      chars: String(data.customPrompt || '').length,
    });
  }
  try {
    for (const name of fs.readdirSync(marketDir(config))) {
      const item = marketPreset(config, name);
      if (item && !out.some(preset => preset.id === item.id)) {
        const { customPrompt, ...metadata } = item;
        out.push({ ...metadata, order: 1e9, chars: customPrompt.length });
      }
    }
  } catch { /* 插件目录通常在首次安装前不存在 */ }
  return out.sort((a, b) => a.order - b.order
    || a.version.localeCompare(b.version, 'en', { numeric: true })
    || a.id.localeCompare(b.id));
}

function readFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** 读一个人设预设；找不到返回 null */
function load(config, id) {
  const key = String(id || '').trim();
  if (!key || !ID_RE.test(key)) return null;
  for (const item of list(config)) {
    if (item.id === key || item.file === key || item.file === key + '.json') {
      if (item.id.startsWith(MARKET_ID_PREFIX) && MARKET_FILE.test(item.file))
        return marketPreset(config, item.file);
      const data = readFile(path.join(dirFor(config), item.file));
      if (data) return { ...data, id: item.id, file: item.file };
    }
  }
  return null;
}

/** 预设里允许写进人设的字段（不认识的字段忽略，避免带进乱七八糟的东西） */
function toPatch(preset) {
  if (!preset) return null;
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
  if (preset.preset) patch.preset = str(preset.preset, 20);
  if (preset.text) patch.text = str(preset.text, 300);
  if (preset.age) patch.age = Math.max(1, Math.min(120, Number(preset.age) || 23));
  if (preset.privateMaxChars) patch.privateMaxChars = Math.max(40, Math.min(800, Number(preset.privateMaxChars)));
  if (preset.groupMaxChars) patch.groupMaxChars = Math.max(20, Math.min(300, Number(preset.groupMaxChars)));
  if (preset.historyTurns) patch.historyTurns = Math.max(4, Math.min(120, Number(preset.historyTurns)));
  if (preset.groupHistoryTurns) patch.groupHistoryTurns = Math.max(2, Math.min(100, Number(preset.groupHistoryTurns)));
  if (preset.maxBubbles) patch.maxBubbles = Math.max(1, Math.min(8, Number(preset.maxBubbles)));
  return Object.keys(patch).length ? patch : null;
}

module.exports = { list, load, toPatch, dirFor };
