'use strict';

const registry = require('./pluginProtocolRegistry.json');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonSafe = value => {
  try { return JSON.stringify(value) !== undefined; } catch { return false; }
};

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some(item => matchesType(value, item));
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'json': return jsonSafe(value);
    default: return false;
  }
}

function matchesSchema(value, schemaNameOrObject, depth = 0) {
  if (depth > 16) return false;
  let schema = schemaNameOrObject;
  if (typeof schema === 'string') schema = registry.schemas[schema];
  if (!isObject(schema)) return false;
  if (schema.$ref !== undefined) {
    const name = String(schema.$ref).replace(/^#\/schemas\//, '');
    if (!Object.hasOwn(registry.schemas, name)) return false;
    return matchesSchema(value, registry.schemas[name], depth + 1);
  }
  if (!matchesType(value, schema.type)) return false;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && value.some(item => !matchesSchema(item, schema.items, depth + 1))) return false;
  }
  if (isObject(value)) {
    if (schema.required && schema.required.some(key => !Object.hasOwn(value, key))) return false;
    const props = schema.properties || {};
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(props, key))) return false;
    for (const [key, child] of Object.entries(props)) {
      if (Object.hasOwn(value, key) && !matchesSchema(value[key], child, depth + 1)) return false;
    }
  }
  return true;
}

function validate(schemaNameOrObject, value, code = 'invalid_contract_data') {
  if (!matchesSchema(value, schemaNameOrObject)) {
    const failure = new Error(code);
    failure.code = code;
    throw failure;
  }
  return value;
}

function validateSettings(value, schema) {
  if (!isObject(value) || !isObject(schema) || !matchesSchema(value, schema)) {
    const failure = new Error('invalid_plugin_settings');
    failure.code = 'invalid_plugin_settings';
    throw failure;
  }
  return value;
}

module.exports = { matchesSchema, validate, validateSettings };
