#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileFunction } = require('node:vm');
const { inflateRawSync } = require('node:zlib');
const registry = require('../src/services/pluginProtocolRegistry.json');
const { files, limits } = registry;
const { compileRestricted } = require('../src/services/unifiedWasm');
const { parseStrict, validateManifest, annotationError } = require('../src/services/pluginProtocol');
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'plugins');
const TEMPLATE = {
  'integer-tool': [1, 'tool.run@1', 'tool', 'manual', [], '整数工具'],
  tool: [2, 'tool.run@1', 'tool', 'manual', [], '文本工具'],
  'reply-wasm': [3, 'chat.reply@1', 'enhance', 'all', [], '回复草稿增强'],
  'reply-enhancer': [4, 'chat.reply@1', 'enhance', 'all', [], 'Node 回复增强'],
  'chat-takeover': [4, 'chat.handle@1', 'replace', 'all', [], 'Node 聊天接管'],
  'scheduled-task': [4, 'task.tick@1', 'schedule', 'all', ['status.read@1'], 'Node 定时任务'],
};
const manifestRules = registry.manifest;
const ID = new RegExp(manifestRules.idPattern);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const owns = Object.hasOwn;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const distinct = value => Array.isArray(value) && new Set(value).size === value.length;
const text = value => typeof value === 'string' && value.trim().length > 0;
const pluginId = value => typeof value === 'string' && value.length <= manifestRules.maxIdLength
  && ID.test(value) && !RESERVED.test(value);
const version = value => typeof value === 'string' && /^\d+(?:\.\d+){2,3}$/.test(value)
  && value.split('.').every(part => Number(part) <= 2147483647);

function compareVersion(left, right) {
  const leftParts = left.split('.').map(Number), rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index++) {
    const delta = (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
    if (delta !== 0) return delta;
  }
  return 0;
}
const boundedInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const label = value => JSON.stringify(value);

function unknownFields(value, allowed, field) {
  check(object(value), `${field} 必须是对象`);
  for (const key of Object.keys(value)) {
    check(allowed.includes(key), `${field} 含未知字段 ${label(key)}`);
  }
}

function schemaAcceptsType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return Number.isFinite(value);
  return typeof value === type;
}

function settingsSchema(schema, depth = 1) {
  const rules = registry.settingsSchema;
  const field = 'settingsSchema';
  check(depth <= rules.maxDepth, `${field} 超出最大嵌套深度`);
  unknownFields(schema, rules.supportedKeywords, field);
  for (const name of ['title', 'description']) {
    if (!owns(schema, name)) continue;
    const problem = annotationError(name, schema[name]);
    check(!problem, `${field}.${name}: ${problem}`);
  }
  check(rules.allowedTypes.includes(schema.type), `${field}.type 不受支持`);
  check(depth !== 1 || schema.type === 'object', `${field} 的根节点必须是对象类型`);
  for (const key of Object.keys(schema)) {
    if (['properties', 'required', 'additionalProperties'].includes(key)) {
      check(schema.type === 'object', `${field}.${key} 仅适用于对象`);
    }
    if (['minimum', 'maximum'].includes(key)) {
      check(['integer', 'number'].includes(schema.type) && Number.isFinite(schema[key]), `${field}.${key} 必须是数值型界限`);
    }
    if (['minLength', 'maxLength'].includes(key)) {
      check(schema.type === 'string' && Number.isSafeInteger(schema[key]) && schema[key] >= 0,
        `${field}.${key} 必须是字符串长度界限`);
    }
  }
  if (owns(schema, 'enum')) {
    check(schema.type !== 'object' && distinct(schema.enum) && schema.enum.length > 0
      && schema.enum.every(value => schemaAcceptsType(value, schema.type)), `${field}.enum 值无效`);
  }
  if (owns(schema, 'properties')) {
    check(object(schema.properties), `${field}.properties 必须是对象`);
    for (const child of Object.values(schema.properties)) settingsSchema(child, depth + 1);
  }
  if (owns(schema, 'required')) {
    check(distinct(schema.required) && schema.required.every(key => typeof key === 'string'
      && owns(schema.properties ?? {}, key)), `${field}.required 必须列出已声明且不重复的属性`);
  }
  if (owns(schema, 'additionalProperties')) {
    check(typeof schema.additionalProperties === 'boolean', `${field}.additionalProperties 必须是布尔值`);
  }
  check(!(schema.minimum > schema.maximum) && !(schema.minLength > schema.maxLength), `${field} 的界限倒置`);
}

function manifestFrom(raw) {
  let source, manifest;
  try { source = decoder.decode(raw); }
  catch { throw new Error('plugin.json 必须是 UTF-8'); }
  try { manifest = parseStrict(raw); }
  catch (error) {
    const key = String(error.message).startsWith('manifest_duplicate_key:') ? error.message.slice(23) : '';
    throw new Error(key ? `plugin.json 重复键 ${key}` : 'plugin.json 必须是无重复键的合法 JSON');
  }
  // JSON.parse 会覆盖重复键，因此 parseStrict 保留每个对象的键集合并拒绝歧义。
  const errors = {
    manifest_unknown_field: 'plugin.json 含未知字段',
    manifest_missing_field: 'plugin.json 缺少必填字段',
    manifest_duplicate_key: 'plugin.json 含重复键',
    manifest_json_invalid: 'plugin.json 不是合法 JSON',
    manifest_not_utf8: 'plugin.json 必须是 UTF-8',
    manifest_format_unsupported: 'format 或等级对应的 runtime/entry 不匹配',
    manifest_id_invalid: '插件 id 无效或使用了保留名称',
    manifest_name_invalid: 'name 必须非空且不超过 80 字符',
    manifest_author_invalid: 'author 必须非空且不超过 80 字符',
    manifest_description_invalid: 'description 长度超限',
    manifest_version_invalid: 'version 或 minAppVersion 格式无效',
    manifest_app_range_invalid: 'maxAppVersion 小于 minAppVersion',
    manifest_app_epoch_invalid: 'appEpoch 只能是 1 或 2',
    manifest_app_compatibility_invalid: 'appCompatibility 声明无效',
    manifest_providers_invalid: 'provides 必须至少声明一项',
    manifest_provider_invalid: 'provider 超出该等级或模式/作用域不受支持',
    manifest_provider_interval_invalid: 'intervalSeconds 超出范围',
    manifest_calls_invalid: 'calls 超出该等级或含重复项',
    manifest_timeout_invalid: 'executionTimeoutMs 超出范围',
    settings_schema_invalid: 'settingsSchema 不受支持',
    invalid_plugin_settings: '设置不符合作者 schema',
  };
  let checked;
  const unknown = Object.keys(manifest).filter(key => !manifestRules.allowed.includes(key));
  if (unknown.length) throw new Error(`plugin.json 含未知字段 ${unknown.join('、')}`);
  // 先跑带具体字段名的同源 schema 校验，作者能看到是哪个注解/字段不合法，而不是统一报错。
  if (manifest.level === 0 && owns(manifest, 'settingsSchema')) throw new Error('0 级纯数据主题不允许 settingsSchema');
  if (owns(manifest, 'settingsSchema') && object(manifest.settingsSchema)) settingsSchema(manifest.settingsSchema);
  try { checked = validateManifest(Buffer.from(source)); }
  catch (error) {
    if (error.code === 'manifest_duplicate_key' || /duplicate/i.test(error.message)) throw new Error(errors.manifest_duplicate_key);
    throw new Error(errors[error.message] || error.message);
  }
  const level = registry.levels[checked.level];
  for (const [key, expected] of Object.entries({ format: registry.format, runtime: level.runtime, entry: level.entry })) {
    check(manifest[key] === expected, `${key} 必须是 ${expected}`);
  }
  check(pluginId(manifest.id), '插件 id 必须是有效的小写短横线标识且不能使用保留名称');
  for (const [key, max] of Object.entries({ name: manifestRules.maxNameLength, author: manifestRules.maxAuthorLength })) {
    check(text(manifest[key]) && manifest[key].trim().length <= max, `${key} 必须是非空且长度不超过 ${max} 的字符串`);
  }
  check(typeof manifest.description === 'string' && manifest.description.length <= manifestRules.maxDescriptionLength,
    `description 必须是长度不超过 ${manifestRules.maxDescriptionLength} 的字符串`);
  for (const key of ['version', 'minAppVersion', 'maxAppVersion'].filter(key => owns(manifest, key))) {
    check(version(manifest[key]), `${key} 必须是三段或四段数字版本号`);
  }
  if (owns(manifest, 'maxAppVersion')) {
    check(compareVersion(manifest.maxAppVersion, manifest.minAppVersion) >= 0, 'maxAppVersion 不得小于 minAppVersion');
  }
  check(object(manifest.provides) && (manifest.level === 0
    ? Object.keys(manifest.provides).length === 0
    : Object.keys(manifest.provides).length > 0), 'provides 必须符合该等级（0 级必须为空，其余至少一项）');
  check(Object.keys(manifest.provides).every(name => level.providers.includes(name)), 'provider 超出该权限等级');
  check(manifest.calls.every(name => level.calls.includes(name)), 'host call 超出该权限等级');
  for (const [name, descriptor] of Object.entries(manifest.provides)) {
    check(level.providers.includes(name), `未知 provider ${label(name)}`);
    const rule = registry.providers[name];
    const field = `provides[${label(name)}]`;
    unknownFields(descriptor, ['mode', 'scope', ...(rule.intervalSeconds ? ['intervalSeconds'] : [])], field);
    check(rule.modes.includes(descriptor.mode), `${field}.mode 不受支持`);
    check(rule.scopes.includes(descriptor.scope), `${field}.scope 不受支持`);
    if (owns(descriptor, 'intervalSeconds')) {
      check(boundedInt(descriptor.intervalSeconds, rule.intervalSeconds.min, rule.intervalSeconds.max), `${field}.intervalSeconds 超出范围`);
    }
  }
  check(distinct(manifest.calls) && manifest.calls.every(name => typeof name === 'string' && level.calls.includes(name)),
    'calls 必须是已注册能力的数组，且不得重复');
  if (owns(manifest, 'executionTimeoutMs')) {
    check(boundedInt(manifest.executionTimeoutMs, limits.minExecutionTimeoutMs, limits.maxExecutionTimeoutMs), 'executionTimeoutMs 超出范围');
  }
  return manifest;
}

function regularFile(filename, max) {
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && stat.size <= max, `${path.basename(filename)} 不是普通文件或超出大小限制`);
  const raw = fs.readFileSync(filename);
  check(raw.length <= max, `${path.basename(filename)} 超出大小限制`);
  return raw;
}

function readProject(directory) {
  check(fs.lstatSync(directory).isDirectory(), '项目路径必须是普通目录');
  const raw = regularFile(path.join(directory, files.manifest), limits.maxManifestBytes);
  const manifest = manifestFrom(raw);
  return { [files.manifest]: raw, [manifest.entry]: regularFile(path.join(directory, manifest.entry), registry.levels[manifest.level].maxEntryBytes) };
}

function minimalWasm(level) {
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  const parts = [0, 97, 115, 109, 1, 0, 0, 0];
  if (level === 1) {
    return Buffer.from([...parts, ...section(1, [1, 96, 0, 1, 127]), ...section(3, [1, 0]),
      ...section(7, [1, 3, 114, 117, 110, 0, 0]), ...section(10, [1, 4, 0, 65, 42, 11])]);
  }
  const text = Buffer.from(level === 3 ? '{"text":""}' : '');
  const moduleName = Buffer.from('whale_plugin');
  const importName = Buffer.from('output_byte');
  const imports = [1, moduleName.length, ...moduleName, importName.length, ...importName, 0, 0];
  const type = [2, 96, 1, 127, 0, 96, 0, 1, 127];
  const exports = [1, 3, 114, 117, 110, 0, 1];
  const writes = [...text].flatMap(byte => [65, ...(byte < 64 ? [byte] : [(byte & 127) | 128, byte >> 7]), 16, 0]);
  const body = [0, ...writes, 65, 0, 11];
  return Buffer.from([...parts, ...section(1, type), ...section(2, imports), ...section(3, [1, 1]),
    ...section(7, exports), ...section(10, [1, body.length, ...body])]);
}

function init(id, template = 'tool') {
  check(pluginId(id), 'init 需要有效的插件 id');
  check(owns(TEMPLATE, template), `未知模板 ${label(template)}`);
  const [levelId, capability, mode, scope, calls, description] = TEMPLATE[template];
  const level = registry.levels[levelId];
  const interval = registry.providers[capability]?.intervalSeconds;
  const manifest = {
    format: registry.format, level: levelId, id, name: id, author: 'Your Name', version: '1.0.0',
    minAppVersion: require('../package.json').version, description,
    entry: level.entry, runtime: level.runtime,
    provides: { [capability]: { mode, scope, ...(interval ? { intervalSeconds: 60 } : {}) } }, calls,
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  manifestFrom(bytes);
  const templateFile = path.join(TEMPLATE_DIR, `${template}.js`);
  const entry = level.entry.endsWith('.wasm') ? minimalWasm(levelId) : fs.readFileSync(templateFile);
  const guide = fs.readFileSync(path.join(TEMPLATE_DIR, 'README.md'));
  fs.mkdirSync(id);
  fs.writeFileSync(path.join(id, files.manifest), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(id, level.entry), entry, { flag: 'wx' });
  fs.writeFileSync(path.join(id, 'README.md'), guide, { flag: 'wx' });
  return { ok: true, directory: id, template };
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_DESCRIPTOR = 0x08074b50;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const ENTRY_LIMITS = { [files.manifest]: limits.maxManifestBytes, ...Object.fromEntries(Object.values(registry.levels).map(level => [level.entry, level.maxEntryBytes])) };
const ZIP_ENTRY_NAMES = [files.manifest, ...Object.values(registry.levels).map(level => level.entry)];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function packZip(entries) {
  check(Object.keys(entries).length === 2 && Object.hasOwn(entries, files.manifest)
    , 'ZIP 必须包含两项文件');
  const entryNames = Object.keys(entries).filter(name => name !== files.manifest);
  const manifest = manifestFrom(entries[files.manifest]);
  check(entryNames.length === 1 && entryNames[0] === manifest.entry, 'ZIP 等级入口无效');
  let localSize = 0;
  const locals = [], directory = [];
  for (const nameText of Object.keys(entries)) {
    const name = Buffer.from(nameText, 'utf8');
    const data = entries[nameText];
    const metadata = Buffer.alloc(26);
    metadata.writeUInt16LE(20, 0);
    metadata.writeUInt16LE(0x800, 2);
    metadata.writeUInt16LE(0x21, 8);
    metadata.writeUInt32LE(crc32(data), 10);
    metadata.writeUInt32LE(data.length, 14);
    metadata.writeUInt32LE(data.length, 18);
    metadata.writeUInt16LE(name.length, 22);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL);
    metadata.copy(local, 4);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL);
    central.writeUInt16LE(20, 4);
    metadata.copy(central, 6);
    central.writeUInt32LE(localSize, 42);
    locals.push(local, name, data);
    directory.push(central, name);
    localSize += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localSize, 16);
  check(localSize + central.length + end.length <= limits.maxPackageBytes, 'ZIP 超出大小限制');
  return Buffer.concat([...locals, central, end]);
}

function checkZipExtra(bytes, cursor, end, error) {
  while (cursor < end) {
    check(cursor + 4 <= end, error);
    const kind = bytes.readUInt16LE(cursor);
    check(kind !== 0x7075 && kind !== 0x0001, error);
    cursor += 4 + bytes.readUInt16LE(cursor + 2);
  }
  check(cursor === end, error);
}

function readZip(zip) {
  const end = zip.length - 22;
  const malformed = '无效或不支持的 ZIP 结构';
  check(end >= 0 && zip.readUInt32LE(end) === ZIP_END && zip.readUInt16LE(end + 20) === 0
    && zip.readUInt32LE(end + 4) === 0, malformed);
  const count = zip.readUInt16LE(end + 10);
  check(count === 2 && zip.readUInt16LE(end + 8) === count,
    'ZIP 根目录必须且只能包含 plugin.json 和一个等级对应的入口文件');
  const start = zip.readUInt32LE(end + 16);
  check(start + zip.readUInt32LE(end + 12) === end, malformed);
  const ranges = [];
  const entries = Object.create(null);
  let cursor = start;
  for (let entry = 0; entry < count; entry++) {
    check(cursor + 46 <= end && zip.readUInt32LE(cursor) === ZIP_CENTRAL, malformed);
    const flag = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const expanded = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const nameAt = cursor + 46;
    const local = zip.readUInt32LE(cursor + 42);
    const attributes = zip.readUInt32LE(cursor + 38);
    check(zip.readUInt16LE(cursor + 34) === 0 && !(attributes & 0x10)
      && [0, 0x8000].includes((attributes >>> 16) & 0xf000), malformed);
    const extraStart = nameAt + nameLength;
    const extraEnd = extraStart + zip.readUInt16LE(cursor + 30);
    cursor = extraEnd + zip.readUInt16LE(cursor + 32);
    check(cursor <= end, malformed);
    checkZipExtra(zip, extraStart, extraEnd, malformed);
    const name = zip.toString('latin1', nameAt, nameAt + nameLength);
    check(owns(ENTRY_LIMITS, name) && ZIP_ENTRY_NAMES.includes(name) && !owns(entries, name), 'ZIP 含非法或重复文件名；入口必须和清单等级一致');
    check(expanded <= ENTRY_LIMITS[name], `${name} 展开后超出大小限制`);
    check(!(flag & ~0x80e) && (method === 0 || method === 8) && (method !== 0 || compressed === expanded), malformed);
    check(local + 30 <= start && zip.readUInt32LE(local) === ZIP_LOCAL, malformed);
    const contentAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const contentEnd = contentAt + compressed;
    check(contentEnd <= start && zip.readUInt16LE(local + 6) === flag && zip.readUInt16LE(local + 8) === method
      && zip.readUInt16LE(local + 26) === nameLength
      && zip.toString('latin1', local + 30, local + 30 + nameLength) === name, malformed);
    checkZipExtra(zip, local + 30 + nameLength, contentAt, malformed);
    let next = contentEnd;
    const sizesMatch = offset => zip.readUInt32LE(offset) === crc && zip.readUInt32LE(offset + 4) === compressed
      && zip.readUInt32LE(offset + 8) === expanded;
    if (flag & 8) {
      if (next + 16 <= start && zip.readUInt32LE(next) === ZIP_DESCRIPTOR && sizesMatch(next + 4)) next += 16;
      else { check(next + 12 <= start && sizesMatch(next), malformed); next += 12; }
    } else check(sizesMatch(local + 14), malformed);
    ranges.push({ name, start: local, end: next });
    const payload = zip.subarray(contentAt, contentEnd);
    const data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(expanded, 1) });
    check(data.length === expanded && crc32(data) === crc, `${name} 的 ZIP 长度或校验和不匹配`);
    entries[name] = data;
  }
  const manifestEntry = entries[files.manifest];
  check(manifestEntry, 'ZIP 缺少插件清单');
  const expectedEntry = manifestFrom(manifestEntry).entry;
  ranges.sort((left, right) => left.start - right.start);
  check(cursor === end && ranges.length === 2
    && ranges[0].name === files.manifest && ranges[1].name === expectedEntry
    && ranges[0].start === 0 && ranges[0].end === ranges[1].start
    && ranges[1].end === start, malformed);
  return entries;
}

function inspect(target, { syntax = false, projectOnly = false } = {}) {
  const directory = fs.lstatSync(target).isDirectory();
  check(!projectOnly || directory, 'pack 的输入必须是项目目录');
  const entries = directory ? readProject(target) : readZip(regularFile(target, limits.maxPackageBytes));
  const manifest = manifestFrom(entries[files.manifest]);
  const entry = entries[manifest.entry];
  check(entry, 'ZIP 或项目入口与等级不匹配');
  if (manifest.level === 0) {
    // 主题是纯数据：CLI 只做静态 JSON 检查，不编译、不执行；完整 token/对比度由启动器校验。
    let theme;
    try { theme = JSON.parse(decoder.decode(entry)); }
    catch { throw new Error('theme.json 必须是合法 UTF-8 JSON'); }
    if (!object(theme) || theme.schema !== 1 || typeof theme.id !== 'string' || theme.id !== manifest.id)
      throw new Error('theme.json 必须包含 schema:1 且 id 与插件清单一致');
    return { manifest, entries };
  }
  if (manifest.level !== 4) {
    try { compileRestricted(entry, manifest.level); }
    catch { throw new Error(`${manifest.entry} Wasm 模块或导入不符合该等级`); }
    return { manifest, entries };
  }
  let source;
  try { source = decoder.decode(entry); }
  catch { throw new Error('plugin.js 必须是 UTF-8 文本'); }
  check(source.trim().length > 0, 'plugin.js 不能为空');
  if (syntax) {
    try {
      compileFunction(source.replace(/^#![^\r\n]*/, ''), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: 'plugin.js' });
    } catch { throw new Error('plugin.js 存在 CommonJS 语法错误'); }
  }
  return { manifest, entries };
}

function trial(manifest) {
  return {
    ok: true, id: manifest.id, simulated: true, executed: false, installed: false,
    authorizationGranted: false, level: manifest.level, permissionName: registry.levelNames[manifest.level],
    nodeAccessConfirmationRequired: manifest.level === 4,
    chatConsentRequired: manifest.level === 3 && Object.hasOwn(manifest.provides, 'chat.reply@1'),
    routes: Object.entries(manifest.provides).map(([capability, descriptor]) => ({ capability, ...descriptor })),
    calls: manifest.calls.map(capability => ({
      capability,
      status: registry.calls[capability].enabled === false ? 'unavailable' : 'declared',
      requiresConsent: registry.calls[capability].requiresConsent === true,
    })),
  };
}

const USAGE = `用法：node scripts/plugin-cli.js <命令>
  init <id> [--template ${Object.keys(TEMPLATE).join('|')}]
  validate [项目目录或ZIP]
  test [项目目录或ZIP]
  pack [项目目录] [--out <ZIP>]
  trial [项目目录或ZIP]`;

function main([command, argument, ...options]) {
  if (command === 'init') {
    check(!options.length || options.length === 2 && options[0] === '--template', '用法：init <id> [--template <template>]');
    return init(argument, options[1]);
  }
  if (['validate', 'test', 'trial', 'pack'].includes(command)) {
    if (command === 'pack' && argument === '--out') [argument, options] = [undefined, [argument, ...options]];
    const outputOption = command === 'pack' && options.length === 2 && options[0] === '--out';
    check(!options.length || outputOption, USAGE);
    const { manifest, entries } = inspect(argument ?? '.', { syntax: command === 'test' || command === 'pack', projectOnly: command === 'pack' });
    if (command === 'trial') return trial(manifest);
    if (command === 'pack') {
      const filename = options[1] ?? `${manifest.id}.zip`;
      check(/\.zip$/i.test(filename), '输出文件名必须以 .zip 结尾');
      fs.writeFileSync(filename, packZip(entries), { flag: 'wx' });
      return { ok: true, id: manifest.id, filename };
    }
    return { ok: true, id: manifest.id, ...(command === 'test' ? { executed: false, syntaxChecked: true } : {}) };
  }
  throw new Error(USAGE);
}

try {
  if (process.argv.length === 2 || ['--help', '-h'].includes(process.argv[2])) console.log(USAGE);
  else console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(`插件 CLI：${error.message}`);
  process.exitCode = 1;
}

