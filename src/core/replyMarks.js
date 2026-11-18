'use strict';

/** 两种控制语法共享有界行扫描，权限、动作次数和参数规则仍各自处理。 */
function scanMarks(input, { open, close, name, visit, preserveUnclosedProse = false }) {
  const text = String(input == null ? '' : input);
  const lower = text.toLowerCase();
  const kept = [];
  let from = 0;
  let search = 0;
  while (search < text.length) {
    const start = lower.indexOf(open, search);
    if (start < 0) break;
    let body = start + open.length;
    while (lower[body] === ' ' || lower[body] === '\t') body++;
    if (lower.slice(body, body + name.length) !== name) { search = start + open.length; continue; }
    body += name.length;
    // 未知的长名字不是控制命令，例如 [[stickers:...]] 和 ((silences:...))。
    if (/[a-z_]/i.test(lower[body] || '')) { search = body; continue; }
    let lineEnd = body;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') lineEnd++;
    const end = text.indexOf(close, body);
    const closed = end >= 0 && end < lineEnd;
    if (!closed && preserveUnclosedProse) {
      let separator = body;
      while (text[separator] === ' ' || text[separator] === '\t') separator++;
      if (text[separator] !== ':' && text[separator] !== '：') {
        // 没有分隔符的半截表情标记只移除前缀，后面的正文不算参数。
        kept.push(text.slice(from, start));
        from = search = separator;
        continue;
      }
    }
    const stop = closed ? end + close.length : lineEnd;
    kept.push(text.slice(from, start));
    visit(text.slice(body, closed ? end : lineEnd));
    from = stop;
    search = stop;
  }
  kept.push(text.slice(from));
  return kept.join('').trim();
}

function stripSilenceMark(input) {
  let minutes = 0;
  const text = scanMarks(input, { open: '((', close: '))', name: 'silence', visit(body) {
    const number = body.match(/(\d{1,3})/);
    if (!minutes && number && Number(number[1]) > 0) minutes = Number(number[1]);
  } });
  return { text, minutes };
}

function stripStickerMarks(input) {
  let category = '';
  let count = 0;
  const text = scanMarks(input, { open: '[[', close: ']]', name: 'sticker', preserveUnclosedProse: true, visit(body) {
    count++;
    const match = body.match(/^[ \t]*[:：]([^\r\n]*)$/);
    const candidate = match ? match[1].trim() : '';
    // 多余的控制标记也要隐藏，但不因此增加可执行动作或可选分类的范围。
    if (count <= 3 && !category && candidate.length >= 1 && candidate.length <= 40) category = candidate;
  } });
  return { text, category };
}

module.exports = { stripSilenceMark, stripStickerMarks };
