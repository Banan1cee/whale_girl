'use strict';

function createAdmin({ isVerifiedOwner, nameMatches, personaStore, saveSettings, tagName }) {
/** 管理员能用的全部命令：魔咒验证成功后直接回这份清单，配「帮助」也用它 */
function adminCommandList() {
  return [
    '状态',
    '改名 <新名字>',
    '上下文 20 / 上下文 短|中|长',
    '主动 开|关 / 观点 开|关 / 互怼 开|关',
    '长度 私聊 120 / 回复 短一点|长一点',
    '颜文字 关|少|正常|多',
    '能力 链接 开|关 / 能力 主动接话 开|关',
    '禁言 群名 / 禁言列表 / 解除禁言 群名',
    '改模型 <模型名>',
    '演示模式 开|关',
    '重置记忆 / 清空所有记忆',
    '恢复默认',
    '退出管理',
  ];
}

const admin = {
  unlockAdminSpell(msg, key, state, spell, nowMs) {
    if (msg.platform !== 'wechat' || msg.chatType !== 'private' || !isVerifiedOwner(this.config, msg)) {
      return null;
    }
    const minutes = Math.max(1, Math.min(1440, Number(this.config.admin?.minutes) || 30));
    state.adminUntil = nowMs + minutes * 60000;
    state.adminUser = msg.senderId;
    // 只认本次运行中真正验证过的口令，旧存档里的计时器不能恢复权限。
    this._adminSpellGrants.set(state, spell);
    this._adminGrantsByKey.set(key, { spell, senderId: msg.senderId, until: state.adminUntil });
    this.store.markDirty(key);
    return {
      action: 'command', commandType: 'admin_spell', key, msg, atMe: true, reason: 'admin',
      text: `管理员魔咒已生效（${minutes} 分钟内有效）。可以发送：\n` + adminCommandList().join('\n'),
    };
  },

  /**
   * 管理权限的唯一入口：绑定 ID 的主人在本微信私聊发送过口令，
   * 且本次运行里该会话确实验证成功（不看存档里的旧计时器）。
   * 没配置口令时任何管理命令都不执行 —— 「必须有管理员魔咒才可以」。
   */
  adminSpellActive(msg, state, nowMs) {
    const spell = String((this.config.admin && this.config.admin.spell) || '').trim();
    if (!spell) return false;
    if (msg.platform !== 'wechat' || msg.chatType !== 'private') return false;
    return state.adminUser === msg.senderId
      && Number(state.adminUntil) > nowMs
      && this._adminSpellGrants.get(state) === spell;
  },

  /** 清空记忆会重建会话 state；把仍在有效期内的授权接回新 state（用户主动退出/过期的不复活）。 */
  restoreAdminGrant(key, state, msg, spell, nowMs) {
    const grant = this._adminGrantsByKey.get(key);
    if (!grant) return;
    if (grant.until <= nowMs || grant.spell !== spell) {
      this._adminGrantsByKey.delete(key);
      return;
    }
    if (state.adminUser || grant.senderId !== msg.senderId) return;
    state.adminUser = grant.senderId;
    state.adminUntil = grant.until;
    this._adminSpellGrants.set(state, spell);
  },

  /** 管理员命令。返回 decision，或 null 表示继续走普通聊天流程。 */
  handleAdmin({ msg, clean, key, state, isMaster, nowMs }) {
    // 不接受昵称兜底或上游传来的 isMaster 标记作为管理凭据。
    isMaster = isVerifiedOwner(this.config, msg);
    const adminCfg = this.config.admin || {};
    const spell = String(adminCfg.spell || '').trim();
    const text = String((clean && clean.text) || '').trim();
    this.restoreAdminGrant(key, state, msg, spell, nowMs);
    const say = (msgText, commandType = 'admin') => ({
      action: 'command', commandType, key, msg, atMe: true, reason: 'admin', text: msgText,
    });

    // 主人身份只是必要条件，真正的凭据是本次运行里验证过的魔咒。
    // 以前的 allowAll 能让任何人在群里改人设/模型，和「必须有魔咒」冲突，已不再参与授权。
    const adminOk = isMaster && this.adminSpellActive(msg, state, nowMs);
    if (!adminOk) {
      const looksControl =
        /(禁言|解禁|静音)/.test(text) ||
        /^(?:别|不要|停止)(?:再)?(?:在)?\s*.+?群/.test(text) ||
        /^让\s*.+?群\s*(?:闭嘴|安静)/.test(text) ||
        /^(?:管理帮助|管理状态|查看状态|状态|重置记忆|清空所有记忆|恢复默认|恢复人设|清空设定|退出管理|结束管理|关闭管理|收起魔咒)$/.test(text) ||
        /^(?:改名|改名为|改名成|改名字|名字改成|上下文|记忆长度|记忆条数|主动|主动关心|主动找话题|观点|立场|主见|互怼|骂主人|顶嘴|允许顶嘴|长度|字数|颜文字|能力|主动接话|群聊主动接话|演示模式|改模型|换模型|禁言列表|群聊禁言|禁言名单|黑名单)(?:\s|$|[:：])/.test(text);
      if (looksControl) {
        return say(spell
          ? '管理命令需要先在本微信私聊发送管理员魔咒。'
          : '还没有配置管理员魔咒，请先在启动器「设置」里设置后再用管理命令。', 'admin_hint');
      }
      return null;
    }
    const remainingText = '不限时';

    // —— 群禁言（让某个群安静） ——
    const groupDenial = () => {
      if (!isMaster) return say('群禁言只能由已绑定微信 ID 的主人操作。', 'admin_hint');
      if (!spell) return null;
      if (msg.platform === 'wechat' && msg.chatType === 'private' && state.adminUser === msg.senderId &&
          state.adminUntil > nowMs && this._adminSpellGrants.get(state) === spell) return null;
      return say('请主人先在微信私聊发送管理员魔咒，再在同一私聊发送禁言或解禁命令。', 'admin_hint');
    };
    let mg;
    // 允许「你/请/帮我」开头，允许「暂时/先」前缀
    const mt = String(text).replace(/^(?:你|请|麻烦|帮我|能不能|可不可以|可以|先|暂时)+/, '').trim();
    if (/^(?:禁言列表|群聊禁言|禁言名单|黑名单)$/.test(text)) {
      const denied = groupDenial();
      if (denied) return denied;
      const list = (this.config.group && this.config.group.mutedGroups) || [];
      return say(list.length ? '当前禁言：' + list.map((x) => (x === '*' ? '所有群' : x)).join('、') : '现在没有禁言的群。');
    }
    if ((mg = mt.match(/^(?:别|不要|停止|暂时不要)(?:再)?(?:在)?\s*(.+?)\s*(?:那个)?群(?:里|中|里面)?\s*(?:说话|发言|说)(?:了|啦|啊|呀|吧|嘛)?[。.!！~～]*$/))
        || (mg = mt.match(/^(?:禁言|屏蔽)\s*(.+?)$/))
        || (mg = mt.match(/^把\s*(.+?)\s*(?:群)?\s*禁言$/))
        || (mg = mt.match(/^让\s*(.+?)\s*(?:群)?\s*闭嘴$/))) {
      const g = String(mg[1]).replace(/[「」"'“”]/g, '').trim();
      if (g) {
        const denied = groupDenial();
        if (denied) return denied;
        const list = Array.isArray(this.config.group.mutedGroups) ? this.config.group.mutedGroups.slice() : [];
        if (!list.some((x) => nameMatches(x, g))) list.push(g);
        personaStore.save(this.config, { mutedGroups: list });
        this.logger && this.logger.info('[admin] 群禁言：' + tagName(g));
        return say(`好，以后不在「${g}」群里说话了。（想恢复就发：解除禁言 ${g}）`);
      }
    }
    if (/^(?:所有群禁言|全部群禁言|只在私聊说话)$/.test(text)) {
      const denied = groupDenial();
      if (denied) return denied;
      personaStore.save(this.config, { mutedGroups: ['*'] });
      return say('好，所有群都不说话了，只陪你私聊。');
    }
    // 全解分支要排在单群解禁前面（M23）：以前它排在后面，「允许所有群」「解除禁言 所有群」
    // 会被下面单群那条 `(.+?)` 先吞掉（「所有群」被当成群名），全解分支永远走不到。
    if (/^(?:解除所有群禁言|解除所有禁言|取消所有禁言|全部恢复|允许所有群)$/.test(mt)
        || /^(?:解除禁言|取消禁言|解开禁言|解禁)[\s]*(?:(?:所有|全部)(?:个)?(?:群|群聊)?)?[。.!！~～]*$/.test(mt)) {
      const denied = groupDenial();
      if (denied) return denied;
      personaStore.save(this.config, { mutedGroups: [] });
      return say('所有群的禁言都解开了。');
    }
    if ((mg = mt.match(/^(?:解除禁言|取消禁言|允许)\s*(.+?)(?:了|啦|啊|吧|嘛)?[。.!！~～]*$/))
        || (mg = mt.match(/^解禁\s*(.+?)$/))
        || (mg = mt.match(/^解开\s*(.+?)\s*(?:群)?\s*的?禁言$/))
        || (mg = mt.match(/^解除对\s*(.+?)\s*的?禁言$/))
        || (mg = mt.match(/^让\s*(.+?)\s*(?:群)?\s*(?:可以|能)\s*说话$/))
        || (mg = mt.match(/^(?:恢复|放开)\s*(?!默认|语态|人设)(.+?)\s*(?:群)?\s*(?:说话)?$/))) {
      const denied = groupDenial();
      if (denied) return denied;
      const g = String(mg[1]).replace(/[「」"'“”]/g, '').trim();
      // '*'（所有群禁言）不归单群解禁管：放行一个群不能顺手把全禁言清掉
      const list = (Array.isArray(this.config.group.mutedGroups) ? this.config.group.mutedGroups : [])
        .filter((x) => x === '*' || !nameMatches(x, g));
      personaStore.save(this.config, { mutedGroups: list });
      return say(`好，「${g}」群恢复说话了。`);
    }

    // —— 上下文长度 / 主动与观点开关 ——
    let mm2;
    if ((mm2 = text.match(/^(?:上下文|记忆长度|记忆条数)\s*(\d{1,3})$/))) {
      const n = Math.max(6, Math.min(120, Number(mm2[1])));
      const groupN = Math.min(n, 100);
      personaStore.save(this.config, { historyTurns: n, groupHistoryTurns: groupN });
      return say(`上下文长度改成 ${n} 条（群聊 ${groupN} 条）。`);
    }
    if ((mm2 = text.match(/^上下文\s*(短|中|长)$/))) {
      const map = { 短: 16, 中: 48, 长: 96 };
      const n = map[mm2[1]];
      const groupN = Math.min(n, 100);
      personaStore.save(this.config, { historyTurns: n, groupHistoryTurns: groupN });
      return say(`上下文调成「${mm2[1]}」：私聊 ${n} 条、群聊 ${groupN} 条。`);
    }
    if ((mm2 = text.match(/^(?:主动|主动关心|主动找话题)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { proactive: on });
      return say(on ? '好，会主动关心你、接话题。' : '好，不主动找话题了，你问什么答什么。');
    }
    if ((mm2 = text.match(/^(?:观点|立场|主见)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { opinions: on });
      return say(on ? '好，会有自己的看法，也敢不同意你。' : '好，不输出立场，顺着你说。');
    }
    if ((mm2 = text.match(/^(?:互怼|骂主人|顶嘴|允许顶嘴)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm2[1]);
      personaStore.save(this.config, { masterRoast: on });
      return say(on
        ? '行，那你骂我我就回嘴了，不带脏字那种。'
        : '好，那我挨骂就受着，不还口了。');
    }

    // —— 长短 / 颜文字 / 能力（微信里直接调，持久保存） ——
    let mm;
    if ((mm = text.match(/^(?:长度|字数)\s*(私聊|群聊)\s*([0-9]{2,4})$/))) {
      const n = Math.max(20, Math.min(600, Number(mm[2])));
      const patch = mm[1] === '私聊' ? { privateMaxChars: n } : { groupMaxChars: n };
      personaStore.save(this.config, patch);
      return say(`${mm[1]}回复上限改成 ${n} 字了。`);
    }
    if (/^回复\s*(短一点|再短点|长一点|再长点)$/.test(text)) {
      const shorter = /短/.test(text);
      const d = this.config.chat;
      const pv = shorter ? Math.max(40, Math.round(d.privateMaxChars * 0.7)) : Math.min(400, Math.round(d.privateMaxChars * 1.3));
      const gv = shorter ? Math.max(20, Math.round(d.groupMaxChars * 0.7)) : Math.min(150, Math.round(d.groupMaxChars * 1.3));
      personaStore.save(this.config, { privateMaxChars: pv, groupMaxChars: gv });
      return say(`好，${shorter ? '短' : '长'}一点：私聊 ${pv} 字、群聊 ${gv} 字。`);
    }
    if ((mm = text.match(/^颜文字\s*(关|少|正常|多)$/))) {
      personaStore.save(this.config, { emoji: mm[1] });
      return say(`颜文字用量：${mm[1]}。`);
    }
    if ((mm = text.match(/^能力\s*(链接|链接阅读|主动接话|群聊主动接话)\s*(开|打开|关|关闭)$/))) {
      const on = /开/.test(mm[2]);
      if (/链接/.test(mm[1])) {
        personaStore.save(this.config, { links: on });
        return say(`链接阅读已${on ? '打开' : '关闭'}。`);
      }
      personaStore.save(this.config, { freeChat: on });
      return say(`群聊主动接话已${on ? '打开' : '关闭'}。`);
    }
    if (/^(恢复默认|恢复人设|清空设定)$/.test(text)) {
      personaStore.clear(this.config);
      this.logger && this.logger.info('[admin] 人设与能力恢复默认');
      return say('人设和能力的自定义都清空了，恢复默认。');
    }

    if (/^(状态|管理状态|查看状态)$/.test(text)) {
      const s = this.store.summary();
      const mock = this.llm.isMock;
      const muted = this.config.group.mutedGroups || [];
      return say(
        `管理员在线（${remainingText}）｜模型：${mock ? '演示模式' : this.llm.providerLabel + ' · ' + this.llm.model}` +
        `｜记忆：${s.sessions} 个聊天 / ${s.messages} 条消息` +
        `｜上下文：${this.config.chat.historyTurns} 条` +
        `｜主动${this.config.persona.proactive === false ? '关' : '开'}/观点${this.config.persona.opinions === false ? '关' : '开'}` +
        `｜长短：私聊${this.config.chat.privateMaxChars}/群聊${this.config.chat.groupMaxChars}字` +
        `｜禁言群：${muted.length ? muted.map((x) => (x === '*' ? '所有群' : x)).join('、') : '无'}` +
        `｜链接：${!this.config.links || this.config.links.enabled !== false ? '开' : '关'}`
      );
    }
    if (/^(管理)?帮助$/.test(text)) {
      return say('管理员命令：\n' + adminCommandList().join('\n'));
    }
    if (/^演示模式\s*(开|打开|关|关闭|关掉)$/.test(text)) {
      const on = /开/.test(text);
      try { saveSettings(this.config, { mock: on }); } catch { /* 测试环境无路径 */ }
      this.llm.reload();
      this.logger && this.logger.info(`[admin] 演示模式 ${on ? '开' : '关'}`);
      return say(on ? '演示模式已打开：接下来用内置台词，不调用模型。' : `演示模式已关闭：用真模型 ${this.llm.model} 说话。`);
    }
    const m = text.match(/^(?:改模型|换模型|模型)\s+([A-Za-z0-9._\-\/:]{2,60})$/);
    if (m) {
      const model = m[1];
      // deepseek-* 自动切到 DeepSeek 官方接口，qwen-* 切回百炼，省得还要单独改服务商
      const lower = model.toLowerCase();
      let provider = '';
      let baseUrl = '';
      if (lower.startsWith('deepseek')) { provider = 'deepseek'; baseUrl = 'https://api.deepseek.com'; }
      else if (lower.startsWith('qwen') || lower.startsWith('qwq')) { provider = 'qwen'; baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; }
      else if (lower.startsWith('glm')) { provider = 'zhipu'; baseUrl = 'https://open.bigmodel.cn/api/paas/v4'; }
      try {
        saveSettings(this.config, provider ? { provider, model, baseUrl, mock: false } : { model, mock: false });
      } catch { /* ignore */ }
      this.llm.reload();
      this.logger && this.logger.info(`[admin] 模型切到 ${model}${provider ? '（服务商 ' + provider + '）' : ''}`);
      return say(`模型已切到 ${model}（服务：${this.llm.providerLabel}）。`);
    }
    // 「接 deepseek / 用千问 / 切智谱」：切换服务商，Key 从各自存档里取
    const providerAlias = {
      ds: 'deepseek', deepseek: 'deepseek', 深度求索: 'deepseek',
      qwen: 'qwen', 千问: 'qwen', 通义: 'qwen', 通义千问: 'qwen',
      glm: 'zhipu', zhipu: 'zhipu', 智谱: 'zhipu',
      siliconflow: 'siliconflow', 硅基: 'siliconflow', 硅基流动: 'siliconflow',
      ollama: 'ollama', 本地: 'ollama',
    };
    // 前缀必须带「接/用/切到/换成/切换到」（M25）：以前整段可省，
    // 「本地」「千问」这种普通词命中就静默切走 LLM 并落盘
    const pm = text.match(/^(?:接|用|切到|换成|切换到)\s*([A-Za-z\u4e00-\u9fff]{1,12})(?:\s*(?:chat|v3|flash|plus))?$/i);
    if (pm) {
      const target = providerAlias[pm[1].toLowerCase()] || providerAlias[pm[1]];
      if (target) {
        const preset = { deepseek: ['https://api.deepseek.com', 'deepseek-flash'], qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-flash'], zhipu: ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.7-flash'], siliconflow: ['https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V4.1-Flash'], ollama: ['http://127.0.0.1:11434/v1', 'qwen3:8b'] }[target];
        try { saveSettings(this.config, { provider: target, baseUrl: preset[0], model: preset[1], mock: false }); } catch { /* ignore */ }
        this.llm.reload();
        this.logger && this.logger.info(`[admin] 切到服务商 ${target}`);
        const ok = !this.llm.isMock;
        return say(ok
          ? `好，切到 ${this.llm.providerLabel}，模型 ${this.llm.model}。`
          : `好，切到 ${this.llm.providerLabel} 了，但还没有这个服务的 Key：去设置页填，或把 Key 发我。`);
      }
    }
    if (/^(?:群聊)?主动接话\s*(开|打开|关|关闭|关掉)$/.test(text)) {
      const on = /开/.test(text);
      // 以前只改内存（this.config.group.freeChat = on），重启就丢；
      // 照「能力 主动接话」的写法补落盘（M24）
      personaStore.save(this.config, { freeChat: on });
      this.config.group.freeChat = on;
      this.logger && this.logger.info(`[admin] 群聊主动接话 ${on ? '开' : '关'}`);
      return say(on ? '群聊主动接话已打开（按概率接话，仍受冷却限制）。' : '群聊主动接话已关闭。');
    }
    // 长别名先独立识别，后缀为空时也不能回退到短前缀。
    const rename = text.match(/^(?:改名为|改名成|改名字|名字改成|改名)/);
    if (rename) {
      const raw = text.slice(rename[0].length).replace(/^\s*[:：]?\s*/, '');
      const name = String(raw).replace(/^[「『"'“”]+|[」』"'“”]+$/g, '').replace(/[。.!！~～\s]+$/, '').trim();
      if (!name || name.length > 20 || /[\r\n]/.test(name) || /^(?:了|吧|吗|呢|啊|呀|啦|嘛|哦|么)$/.test(name)) {
        return say('没听清新名字。直接发「改名 小鱼」这样，1~20 个字。', 'rename_invalid');
      }
      personaStore.save(this.config, { name });
      this.logger && this.logger.info('[admin] 改名：' + textMeta(name));
      return say(`好，以后我就叫「${name}」了。群里的 @ 判定会在配置热更新后跟上。`);
    }
    if (/^重置记忆$/.test(text)) {
      if (!isMaster) return say('只有已绑定发送者 ID 的主人才能清空记忆。', 'permission_denied');
      const ok = this.store.resetSession(key);
      if (!ok) {
        this.logger && this.logger.warn('[memory] 清空会话失败：文件被占用或权限不足');
        return say('删除失败：记忆文件可能正被占用，请稍后再试。', 'reset_failed');
      }
      return say('这个聊天的记忆已清空。');
    }
    if (/^清空所有记忆$/.test(text)) {
      if (!isMaster) return say('只有已绑定发送者 ID 的主人才能清空记忆。', 'permission_denied');
      this.store.resetAll();
      return say('所有聊天的记忆已清空。');
    }
    if (/禁言|群.*(别说|不要|安静)|不要在.*群/.test(text)) {
      return say('这句我没听明白。改成「禁言 鼠标」或者「别在鼠标群说话」试试。');
    }
    if (/^(退出管理|结束管理|关闭管理|收起魔咒)$/.test(text)) {
      this._adminSpellGrants.delete(state);
      this._adminGrantsByKey.delete(key);
      state.adminUntil = 0;
      state.adminUser = '';
      this.store.markDirty(key);
      this.logger && this.logger.info('[admin] 管理员权限已关闭');
      return say('管理员权限已关闭。');
    }
    return null;
  }
};

  return { ...admin, adminCommandList };
}

module.exports = { createAdmin };
