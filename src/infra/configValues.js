'use strict';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on', '开']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '关']);

// undefined 表示非法输入，不能在保存前把它和合法 false / 0 混在一起。
function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return undefined;
}

function parseNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const number = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
}

module.exports = { parseBoolean, parseNumber };
