'use strict';

const secrets = new Set();
const secretField = /api.?key|token|secret|password|authorization|cookie|^key$|^spell$/i;

function registerSecrets(value, sensitive = false, seen = new Set()) {
  if (typeof value === 'string') {
    if (sensitive && value.length >= 4 && !/^\*+$/.test(value)) secrets.add(value);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    registerSecrets(child, sensitive || key.toLowerCase() === 'keys' || secretField.test(key), seen);
  }
}

function redactSecrets(value) {
  let text = String(value ?? '');
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('***');
    try { text = text.split(encodeURIComponent(secret)).join('***'); } catch { /* 无效 Unicode 仍按原值脱敏。 */ }
  }
  return text
    .replace(/\b(?:sk|brz|oc_sk|ak|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi, '***')
    .replace(/\bBearer\s+[^\s"'<>},]+/gi, 'Bearer ***')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '***')
    .replace(/((?:api[_ -]?key|access[_ -]?token|password|secret|authorization|[?&](?:key|token))\s*["']?\s*[:=]\s*["']?)[^\s"'&,}\]]+/gi, '$1***');
}

module.exports = { registerSecrets, redactSecrets };
