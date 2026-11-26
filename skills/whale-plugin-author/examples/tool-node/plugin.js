'use strict';

// 卡片「运行一次」的输入是任意 JSON：{"text":"你好"} 统计字数，{"action":"summarize","text":"..."} 调模型。
// calls 里声明了才能 host.call；没声明会得到 host_capability_not_declared。
exports.providers = {
  'tool.run@1': async (input, { host }) => {
    const text = typeof input?.text === 'string' ? input.text : '';
    if (input?.action === 'status') return host.call('status.read@1', {});
    if (input?.action === 'summarize') {
      // model.complete 的字段是 system / turns / maxTokens；turns 是 [{role, content}]，没有 messages。
      const out = await host.call('model.complete@1', {
        system: '把用户给的内容缩成一句不超过 40 字的话，只输出这句话。',
        turns: [{ role: 'user', content: text.slice(0, 16000) }],
        maxTokens: 200,
      });
      return { summary: String(out?.text || '').trim() };
    }
    return { characters: [...text].length, bytes: Buffer.byteLength(text, 'utf8') };
  },
};
