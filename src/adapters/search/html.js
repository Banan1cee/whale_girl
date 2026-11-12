'use strict';

function decodeEntities(s) {
  // 单次扫描解码：先解 &amp; 会造出新的 &#60;，第二遍再解就等于把用户输入
  // 双重反转义（CodeQL double-escaping 的成因）。这里一遍过，不回头。
  return String(s || '').replace(/&(?:(#x[0-9a-f]+|#\d+)|(nbsp|ensp|amp|lt|gt|quot|#39));/gi, (all, num, name) => {
    const key = String(name || '').toLowerCase();
    if (key === 'nbsp' || key === 'ensp') return ' ';
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === '#39') return "'";
    if (!num) return all;
    try {
      return String.fromCodePoint(num[1].toLowerCase() === 'x' ? parseInt(num.slice(2), 16) : Number(num.slice(1)));
    } catch { return all; }
  });
}

function stripTags(s) {
  // 结束标签允许空白（</script >），否则过滤后会残留脚本内容。
  return decodeEntities(String(s || '').replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function sourceUrl(raw, base) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    let url = new URL(decodeEntities(raw), base);
    if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u') || '';
      if (encoded.startsWith('a1')) url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    }
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return ''; }
}

module.exports = { decodeEntities, stripTags, sourceUrl };
