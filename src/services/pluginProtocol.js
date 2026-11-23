'use strict';

const registry = require('./pluginProtocolRegistry.json');
const decoder = new TextDecoder('utf-8', { fatal: true });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = message => Object.assign(new Error(message), { code: 'invalid_plugin_manifest' });

function parseStrict(raw) {
  let text;
  try { text = decoder.decode(raw); } catch { throw fail('manifest_not_utf8'); }
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++; };
  function string() {
    if (text[cursor] !== '"') throw fail('manifest_json_invalid');
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') { cursor++; continue; }
      if (char === '"') {
        try { return JSON.parse(text.slice(start, cursor)); } catch { throw fail('manifest_json_invalid'); }
      }
    }
    throw fail('manifest_json_invalid');
  }
  function value() {
    whitespace();
    if (text[cursor] === '{') {
      cursor++;
      const result = {};
      const keys = new Set();
      whitespace();
      if (text[cursor] === '}') { cursor++; return result; }
      while (cursor < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw fail('manifest_duplicate_key:' + key);
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ':') throw fail('manifest_json_invalid');
        result[key] = value();
        whitespace();
        const delimiter = text[cursor++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') throw fail('manifest_json_invalid');
      }
      throw fail('manifest_json_invalid');
    }
    if (text[cursor] === '[') {
      cursor++;
      const result = [];
      whitespace();
      if (text[cursor] === ']') { cursor++; return result; }
      while (cursor < text.length) {
        result.push(value());
        whitespace();
        const delimiter = text[cursor++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') throw fail('manifest_json_invalid');
      }
      throw fail('manifest_json_invalid');
    }
    if (text[cursor] === '"') return string();
    const rest = text.slice(cursor);
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[0];
    if (!token) throw fail('manifest_json_invalid');
    cursor += token.length;
    try { return JSON.parse(token); } catch { throw fail('manifest_json_invalid'); }
  }
  const result = value();
  whitespace();
  if (cursor !== text.length) throw fail('manifest_json_invalid');
  return result;
}

function compareVersion(left, right) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+){2,3}$/.test(value)) return null;
    return value.split('.').map(Number);
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

const descriptorKeys = rule => ['mode', 'scope', ...(rule.intervalSeconds ? ['intervalSeconds'] : [])];

function validateProviderInterval(rule, descriptor) {
  const value = descriptor.intervalSeconds;
  const range = rule.intervalSeconds;
  return range ? Number.isInteger(value) && value >= range.min && value <= range.max : value === undefined;
}

function validateManifestShape(manifest) {
  if (!isObject(manifest)) throw fail('manifest_must_be_object');
  const policy = registry.manifest;
  if (Object.keys(manifest).some(key => !policy.allowed.includes(key))) throw fail('manifest_unknown_field');
  if (policy.required.some(key => !own(manifest, key))) throw fail('manifest_missing_field');
  const level = Number.isInteger(manifest.level) && registry.levels[manifest.level];
  if (!level || manifest.format !== registry.format || manifest.runtime !== level.runtime || manifest.entry !== level.entry) {
    throw fail('manifest_format_unsupported');
  }
  if (typeof manifest.id !== 'string' || manifest.id.length > policy.maxIdLength
    || !new RegExp(policy.idPattern).test(manifest.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(manifest.id)) {
    throw fail('manifest_id_invalid');
  }
  for (const [field, max] of [['name', policy.maxNameLength], ['author', policy.maxAuthorLength]]) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim() || manifest[field].trim().length > max) throw fail(`manifest_${field}_invalid`);
  }
  if (typeof manifest.description !== 'string' || manifest.description.length > policy.maxDescriptionLength) throw fail('manifest_description_invalid');
  if (compareVersion(manifest.version, '0.0.0') === null || compareVersion(manifest.minAppVersion, '0.0.0') === null) throw fail('manifest_version_invalid');
  if (manifest.maxAppVersion !== undefined && compareVersion(manifest.maxAppVersion, manifest.minAppVersion) < 0) throw fail('manifest_app_range_invalid');
  if (manifest.appEpoch !== undefined && ![1, 2].includes(manifest.appEpoch)) throw fail('manifest_app_epoch_invalid');
  if (manifest.appCompatibility !== undefined) {
    if (!Array.isArray(manifest.appCompatibility) || manifest.appCompatibility.length < 1 || manifest.appCompatibility.length > 2) throw fail('manifest_app_compatibility_invalid');
    const epochs = new Set();
    for (const range of manifest.appCompatibility) {
      if (!isObject(range) || Object.keys(range).some(key => !['appEpoch', 'minAppVersion', 'maxAppVersion'].includes(key))
        || ![1, 2].includes(range.appEpoch) || epochs.has(range.appEpoch)
        || compareVersion(range.minAppVersion, '0.0.0') === null
        || range.maxAppVersion !== undefined && compareVersion(range.maxAppVersion, range.minAppVersion) < 0) {
        throw fail('manifest_app_compatibility_invalid');
      }
      epochs.add(range.appEpoch);
    }
  }
  if (!isObject(manifest.provides)) throw fail('manifest_provider_invalid');
  const providerNames = Object.keys(manifest.provides);
  // 0 级是纯数据主题：没有执行能力，也不允许声明任何 provider。
  if (manifest.level === 0 ? providerNames.length !== 0 : providerNames.length === 0) throw fail('manifest_provider_invalid');
  for (const [name, descriptor] of Object.entries(manifest.provides)) {
    const rule = registry.providers[name];
    if (!own(registry.providers, name) || !level.providers.includes(name) || !isObject(descriptor) || Object.keys(descriptor).some(key => !descriptorKeys(rule).includes(key))
      || !rule.modes.includes(descriptor.mode) || !rule.scopes.includes(descriptor.scope)) throw fail('manifest_provider_invalid');
    if (!validateProviderInterval(rule, descriptor)) throw fail('manifest_provider_interval_invalid');
  }
  if (manifest.level === 0 && manifest.settingsSchema !== undefined) throw fail('manifest_settings_schema_invalid');
  if (!Array.isArray(manifest.calls) || new Set(manifest.calls).size !== manifest.calls.length
    || manifest.calls.some(name => typeof name !== 'string' || !level.calls.includes(name))) throw fail('manifest_calls_invalid');
  const allowedData = level.dataAccess || [];
  if (manifest.dataAccess !== undefined) {
    if (!Array.isArray(manifest.dataAccess) || new Set(manifest.dataAccess).size !== manifest.dataAccess.length
      || manifest.dataAccess.some(name => !allowedData.includes(name))
      || !own(manifest.provides, 'chat.reply@1')) throw fail('manifest_data_access_invalid');
  }
  if (manifest.settingsSchema !== undefined) validateSettingsSchema(manifest.settingsSchema);
  if (manifest.executionTimeoutMs !== undefined && (!Number.isInteger(manifest.executionTimeoutMs)
    || manifest.executionTimeoutMs < registry.limits.minExecutionTimeoutMs || manifest.executionTimeoutMs > registry.limits.maxExecutionTimeoutMs)) {
    throw fail('manifest_timeout_invalid');
  }
  return manifest;
}

/**
 * settingsSchema 的展示注解（title / description）的共享校验。
 * 长度与控制字符范围都取自注册表，供运行时、作者 CLI 与启动器安装校验保持一致；
 * 注解只影响展示，不参与设置值的校验，也不授予任何能力。
 */
function annotationError(name, value) {
  const annotations = registry.settingsSchema.annotations;
  const limit = annotations && annotations[name];
  if (!Number.isInteger(limit) || limit < 0 || !Array.isArray(annotations.forbiddenRanges)) {
    return `${name} 注解策略不可用`;
  }
  if (typeof value !== 'string') return `${name} 必须是字符串`;
  const points = [...value].map(char => char.codePointAt(0));
  for (const range of annotations.forbiddenRanges) {
    if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
      return `${name} 注解策略不可用`;
    }
    if (points.some(point => point >= range[0] && point <= range[1])) return `${name} 不能包含控制字符`;
  }
  if (name === 'title' && !value.trim()) return 'title 不能为空';
  if ([...value].length > limit) return `${name} 不能超过 ${limit} 个字符`;
  return null;
}

function validateSettingsSchema(schema, depth = 0) {
  const policy = registry.settingsSchema;
  if (depth >= policy.maxDepth || !isObject(schema)
    || Object.keys(schema).some(key => !policy.supportedKeywords.includes(key))
    || !policy.allowedTypes.includes(schema.type) || depth === 0 && schema.type !== 'object') throw fail('settings_schema_invalid');
  for (const name of ['title', 'description']) {
    if (schema[name] !== undefined && annotationError(name, schema[name])) throw fail('settings_schema_invalid');
  }
  if (schema.properties !== undefined) {
    if (schema.type !== 'object' || !isObject(schema.properties)) throw fail('settings_schema_invalid');
    for (const child of Object.values(schema.properties)) validateSettingsSchema(child, depth + 1);
  }
  if (schema.required !== undefined && (schema.type !== 'object' || !Array.isArray(schema.required)
    || new Set(schema.required).size !== schema.required.length || schema.required.some(key => typeof key !== 'string' || !own(schema.properties || {}, key)))) {
    throw fail('settings_schema_invalid');
  }
  if (schema.additionalProperties !== undefined && (schema.type !== 'object' || typeof schema.additionalProperties !== 'boolean')) throw fail('settings_schema_invalid');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length
    || new Set(schema.enum.map(item => JSON.stringify(item))).size !== schema.enum.length)) throw fail('settings_schema_invalid');
  const numeric = schema.type === 'integer' || schema.type === 'number';
  const string = schema.type === 'string';
  const array = schema.type === 'array';
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && (!numeric || !Number.isFinite(schema[key]))) throw fail('settings_schema_invalid');
  for (const key of ['minLength', 'maxLength']) if (schema[key] !== undefined && (!string || !Number.isInteger(schema[key]) || schema[key] < 0)) throw fail('settings_schema_invalid');
  for (const key of ['minItems', 'maxItems']) if (schema[key] !== undefined && (!array || !Number.isInteger(schema[key]) || schema[key] < 0)) throw fail('settings_schema_invalid');
  if (array && schema.items !== undefined) validateSettingsSchema(schema.items, depth + 1);
  return true;
}

function validateSchemaValue(value, schema, depth = 0) {
  if (depth > registry.settingsSchema.maxDepth) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.type === 'object') {
    if (!isObject(value)) return false;
    if (schema.required?.some(key => !own(value, key))) return false;
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (!own(properties, key)) { if (schema.additionalProperties === false) return false; }
      else if (!validateSchemaValue(item, properties[key], depth + 1)) return false;
    }
    return true;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || schema.minItems !== undefined && value.length < schema.minItems
      || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    return !schema.items || value.every(item => validateSchemaValue(item, schema.items, depth + 1));
  }
  if (schema.type === 'string') return typeof value === 'string'
    && (schema.minLength === undefined || [...value].length >= schema.minLength)
    && (schema.maxLength === undefined || [...value].length <= schema.maxLength);
  if (schema.type === 'integer') return Number.isSafeInteger(value)
    && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
    && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}

function validateSettings(settings, schema) {
  if (!isObject(settings) || Buffer.byteLength(JSON.stringify(settings)) > registry.limits.maxSettingsBytes) throw fail('invalid_plugin_settings');
  if (schema !== undefined && !validateSchemaValue(settings, schema)) throw fail('invalid_plugin_settings');
  return settings;
}

function validateManifest(raw, { appVersion, appEpoch = 1, entryBytes } = {}) {
  if (!Buffer.isBuffer(raw) || raw.length > registry.limits.maxManifestBytes) throw fail('manifest_size_invalid');
  const manifest = validateManifestShape(parseStrict(raw));
  if (entryBytes !== undefined && (!Buffer.isBuffer(entryBytes) || entryBytes.length === 0
    || entryBytes.length > registry.levels[manifest.level].maxEntryBytes)) throw fail('entry_size_invalid');
  const epoch = manifest.appEpoch ?? 1;
  const app = appVersion || require('../../package.json').version;
  if (manifest.appCompatibility) {
    if (!manifest.appCompatibility.some(range => range.appEpoch === appEpoch
      && compareVersion(app, range.minAppVersion) >= 0
      && (range.maxAppVersion === undefined || compareVersion(app, range.maxAppVersion) <= 0))) throw fail('app_version_incompatible');
  } else if (epoch !== appEpoch || compareVersion(app, manifest.minAppVersion) < 0
    || manifest.maxAppVersion !== undefined && compareVersion(app, manifest.maxAppVersion) > 0) throw fail('app_version_incompatible');
  return manifest;
}

module.exports = { registry, parseStrict, validateManifest, validateProviderInterval, validateSettings, validateSettingsSchema, validateSchemaValue, compareVersion, annotationError };
