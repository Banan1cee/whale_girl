'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

/** 只负责完整字节替换；序列化、目录、备份及失败策略仍由调用方决定。 */
function replaceFileAtomicSync(target, contents, encoding = 'utf8') {
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  let descriptor;
  let owned = false;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    owned = true;
    fs.writeFileSync(descriptor, contents, encoding);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    owned = false;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* 不用关闭错误覆盖原始失败 */ }
    }
    if (owned) {
      // 只清理由本次 exclusive open 创建的文件；清理失败不覆盖原始错误。
      try { fs.unlinkSync(temporary); } catch { /* 保留主错误 */ }
    }
  }
}

module.exports = { replaceFileAtomicSync };
