'use strict';

function aliasList(config, extraNames = []) {
  const aliases = (config.persona && config.persona.aliases) || [];
  const name = config.persona && config.persona.name;
  const extra = Array.isArray(extraNames) ? extraNames : [];
  return [...new Set([name, ...aliases, ...extra].map((x) => String(x || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function cleanIncomingForPersona(text, config, extraNames = []) {
  let s = String(text || '').replace(/\u2005/g, ' ').replace(/\u200b/g, '');
  const aliases = aliasList(config, extraNames);
  let hadAlias = false;
  // 系统生成的图片说明可能含角色名，但不代表用户真的点名。
  if (/^（对方/.test(s)) return { text: s.trim(), atMe: false, hadAlias: false };
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const atBoundary = '(?=$|[\\s，,：:！!~～…?？。\\-—])';
    const atRe = new RegExp(`@\\s*${escaped}${atBoundary}`, 'g');
    if (atRe.test(s)) { hadAlias = true; s = s.replace(atRe, ' '); }
    const bareBoundary = '(?=$|[\\s，,：:！!~～…?？。\\-—]|[你我他她它今明昨在有是想要能会可帮给跟来去看听说问怎为干做吃喝睡别快先再这那真太好还就又请把让])';
    const bareRe = new RegExp(`^\\s*${escaped}${bareBoundary}\\s*[，,：:！!~～\\-—]*\\s*`, 'g');
    if (bareRe.test(s)) { hadAlias = true; s = s.replace(bareRe, ''); }
    if (alias.length >= 2) {
      const midRe = new RegExp(`${escaped}(?![娘乐妹姐哥儿仔鲸鱼])\\s*[，,：:！!~～\\-—]*`, 'g');
      if (midRe.test(s)) { hadAlias = true; s = s.replace(midRe, ' ').replace(/[ \t]{2,}/g, ' ').trim(); }
    }
  }
  s = s.replace(/[ \t]{2,}/g, ' ').trim();
  return { text: s, atMe: hadAlias, hadAlias };
}

function splitBubbles(text, { maxChars = 120, maxBubbles = 2, preferSeparate = false } = {}) {
  const raw = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!raw) return [];
  const limit = Math.max(8, Number(maxChars) || 120);
  const maxN = Math.max(1, Math.floor(Number(maxBubbles) || 1));
  let separate = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let separator = '\n';
  if (separate.length === 1 && preferSeparate) {
    separate = raw.split(/(?<=[。！？!?；;])(?=\s*[^。！？!?；;\s])/);
    if (separate.length === 1) separate = raw.split(/(?<=，)(?=\s*\S)/);
    separator = '';
  }
  if (maxN > 1 && separate.length > 1) {
    const out = separate.slice(0, maxN - 1).concat(separate.slice(maxN - 1).join(separator)).map((line) => line.trim());
    if (out.every((line) => line.length <= limit)) return out;
  }
  const bubbles = Math.max(1, Math.min(maxN, Math.ceil(raw.length / Math.max(24, limit * 0.9))));
  if (raw.length <= limit) return [raw];
  const sentences = raw.match(/[^。！？!?～~…\n]+[。！？!?～~…\n]*/g) || [raw];
  const parts = sentences.map((p) => p.trim()).filter(Boolean);
  if (bubbles === 1) return [raw.length > limit ? raw.slice(0, Math.max(1, limit - 1)).trimEnd() + '…' : raw];
  const perBubble = Math.ceil(Math.min(raw.length, limit * bubbles) / bubbles);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (!cur) cur = p;
    else if ((cur + p).length <= perBubble || out.length === bubbles - 1) cur += p;
    else { out.push(cur); cur = p; }
    if (out.length === bubbles - 1 && cur.length > perBubble * 1.5) break;
  }
  if (cur) out.push(cur);
  return out.slice(0, bubbles).map((b) => {
    const hard = Math.max(1, Math.ceil(Math.min(raw.length, limit * bubbles) / bubbles) + 8);
    return b.length > hard ? b.slice(0, hard - 1).trimEnd() + '…' : b;
  });
}

module.exports = { aliasList, cleanIncomingForPersona, splitBubbles };
