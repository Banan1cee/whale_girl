'use strict';

// 4 级 Node 模板。低级别整数/文本工具使用内置 Wasm 模板。
exports.providers = {
  'tool.run@1': async (input, { host }) => {
    if (input?.action === 'status') return host.call('status.read@1', {});
    const text = typeof input?.text === 'string' ? input.text : '';
    return { characters: [...text].length };
  },
};
