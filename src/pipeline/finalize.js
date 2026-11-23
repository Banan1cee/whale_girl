'use strict';

function createFinalizer({ persona, LIMITS, isEcho, stripInternalTimestamps, stripSilenceMark, stripStickerMarks, textMeta, describeError }) {
  return {
  finalize(decision, text, { error = false, deferStore = false } = {}) {
    text = stripInternalTimestamps(text);
    // 模型主动退场标记 [[silence:分钟]]：先解析并从正文剥掉，再走后面的格式清理。
    const silenceMark = stripSilenceMark(text);
    text = silenceMark.text;
    if (silenceMark.minutes) this.applyModelSilence(decision, silenceMark.minutes);
    // 表情包标记 [[sticker:分类]]：发哪一类由模型决定。标记必须从正文里剥干净，
    // 没闭合的半截也要清掉，绝不能漏给用户看到（也不能因此吞掉正文）。
    const stickerMark = stripStickerMarks(text);
    if (stickerMark.category && decision) decision.stickerCategory = stickerMark.category;
    text = stickerMark.text;
    // 正文里的 emoji 剥出来，单独发一条
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu;
    const foundEmoji = (text.match(emojiRe) || []).join('');
    if (foundEmoji) text = text.replace(emojiRe, '').replace(/[ \t]+$/g, '').trim();
    // 去掉波浪号、句号、感叹号，像真人打字一样干净
    text = text.replace(/[~～]+/g, '').replace(/[。！!]+/g, '。').replace(/[ \t]{2,}/g, ' ').trim();
    // 脏话换成年轻人的说法。
    // 「草」只在整句被当成语气词时才软化：草 / 草，/ 草！ 都要换，
    // 但「草莓」「草地」「草案」这类正常词不能动（以前 ^草 一网打尽，草莓都变我去莓）。
    // 用前瞻保留后面的标点，替换后读起来才是「我去，明天见」而不是「我去明天见」。
    text = text.replace(/我操|我靠|草泥马|操你/g, '我去').replace(/卧槽|卧超|我超|我焯|我擦/g, '我去，').replace(/^草(?=[，,。！!？?…、\s]|$)/g, '我去');
    // 弱模型爱说客服话，直接掐掉（免费模型尤其明显）
    const serviceTone = /(有什么(我)?能?可以?帮(你|您)的?吗?|需要我帮(你|您)|希望(这)?能帮到你|还有什么可以帮|作为一个(?:AI|语言模型)|随时告诉我)/;
    if (serviceTone.test(text)) {
      const kept = text.split(/[，,。；;\n]/).map((s) => s.trim()).filter((s) => s && !serviceTone.test(s)).join('，').trim();
      if (kept.length >= 2) text = kept;
    }
    // 对方没聊吃的，就别把话题硬拐到米饭上；整条都在说饭就干脆不发
    const riceRe = /(大白饭|白米饭|米饭)/;
    const foodTopic = /(吃|饭|饿|干饭|外卖|好吃|零食|宵夜|早餐|午餐|午饭|晚餐|晚饭|食堂|菜|煮|炒|泡面|下厨|厨)/;
    const userText = String((decision && decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
    if (riceRe.test(text) && !foodTopic.test(userText)) {
      const kept = text.split(/[，,。；;\n]/).map((s) => s.trim()).filter((s) => s && !riceRe.test(s)).join('，').trim();
      text = kept.length >= 2 ? kept : '';
    }
    if (!decision || !decision.key || !text) return [];
    // handle() 要用最终文本当 reply，清理后的正文和气泡才会一致。
    decision.finalText = text;
    // 最后的兜底：还在复读就整句重来，不能把别人的话或自己上一句原样发回去
    const heardList = (decision && decision.heardList) || [String((decision && decision.msg && (decision.msg.cleanText || decision.msg.text)) || '')];
    const ownList = (decision && decision.ownList) || [];
    if (heardList.some((h) => isEcho(text, h)) || ownList.some((h) => isEcho(text, h))) {
      const line = this.rng() < 0.5 ? '你说呢' : '这话我听着都替你尴尬';
      text = line;
      decision.finalText = text;
    }
    const msg = decision.msg || {};
    if (msg.isMaster) {
      const roastOn = Boolean(this.config.persona && this.config.persona.masterRoast);
      // 只有主人真的在数落她时才互怼；主人说「我生气了」这种要哄
      const masterSaid = String((decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
      const scolded = /(笨|傻|蠢|演我|废物|垃圾|烦|滚|闭嘴|特么|没用|不行|慢|搞错|到底|说了几遍)/.test(masterSaid);
      const rude = roastOn
        ? /(你妈|你爹|你他妈|他妈|傻逼|婊|操你|去死)/
        : /(你妈|你爹|你他妈|他妈|傻逼|狗东西|废物|滚蛋|滚出去|闭上你的嘴|没教养)/;
      const apology = /(对不起|抱歉|我错了|我知道错了|我知错|是我不对|下次一定|是我没做好|我会努力)/;
      const tooHostile = /(你算老几|贵物|小丑|废物|滚蛋|滚出去|闭嘴)/;
      const pickRoast = () => {
        const lines = persona.MASTER_ROAST_LINES || [];
        return lines.length ? lines[Math.floor(this.rng() * lines.length)] : '主人你骂我也没用，活儿还得我干';
      };
      // 已经按 ID 认证过主人，就不许再把 TA 当外人：
      // 模型偶尔还会顺着旧语气说「不是」「冒充」「就一个名字罢了」，直接改成认下来
      const denyMaster = /(不是你的?主人|不是你就对|冒充|自封|没你这号|认主系统|系统.{0,6}不认|不认你|就一个名字|光说没用|凭什么信你)/;
      if (denyMaster.test(text)) {
        this.logger && this.logger.warn('对主人说了否认身份的话，改掉：' + textMeta(text));
        text = '是我主人啊，这还用问。';
        decision.finalText = text;
      }
      if (rude.test(text)) {
        this.logger && this.logger.warn('对主人回嘴越线，改掉：' + textMeta(text));
        text = roastOn && scolded ? pickRoast() : '主人你骂我我也得听着，这次是我没做好';
        decision.finalText = text;
      } else if (roastOn && scolded && (apology.test(String(text)) || tooHostile.test(String(text)))) {
        // 主人在数落她，她却在道歉、或者骂得像仇人，换成撒泼式回嘴
        this.logger && this.logger.warn('主人让互怼，但语气不对，换掉：' + textMeta(text));
        text = pickRoast();
        decision.finalText = text;
      }
    }
    // 群聊输出兜底必须在落库之前：安全正文要同时成为 reply/done.text、气泡和持久化正文。
    // 以前只在气泡阶段替换，结果 reply 和落库仍是原文（同一轮公开输出不一致）。
    if (typeof this.guardGroupText === 'function') {
      const guarded = this.guardGroupText(decision, text);
      if (guarded.leak) {
        text = guarded.text;
        decision.finalText = text;
      }
    }
    // 写库失败照常返回 bubbles：话已经生成了，不能因为落库失败把回复丢了。
    // 日记标记只存占位符，避免把整篇日记又写进聊天记忆。
    const hasDiaryMark = /\[\[diary:[^\]]{1,32}\]\]/i.test(text);
    const storeText = hasDiaryMark
      ? text.replace(/\[\[diary:[^\]]{1,32}\]\]/gi, '（读取日记）')
      : text;
    const persist = () => {
      try {
        const saved = this.store.appendMessage(decision.key, {
          role: 'assistant',
          name: this.config.persona.name,
          replyToUserId: msg.senderId,
          text: storeText,
          ts: this.now().getTime(),
          error,
        });
        if (!error && saved?.seq && decision.nativeLinkCalls) {
          const token = Symbol();
          saved[this.nativeLinkTag] = token;
          this.nativeLinkHistory.delete(decision.key);
          if (this.nativeLinkHistory.size >= 16) this.nativeLinkHistory.delete(this.nativeLinkHistory.keys().next().value);
          this.nativeLinkHistory.set(decision.key, { token, calls: decision.nativeLinkCalls, expires: this.now().getTime() + 1800000 });
        }
      } catch (err) {
        this.logger && this.logger.error('写入回复失败（照常发送）：' + describeError(err));
      }
      if (!error && decision.generatedTitle) {
        try { this.store.setGeneratedTitle?.(decision.key, decision.generatedTitle); }
        catch (err) { this.logger?.warn('保存会话标题失败：' + describeError(err)); }
      }
      // 每轮一个 checkpoint：重启后能知道停在哪、episode 有没有关
      try {
        this.store.checkpoint(decision.key);
      } catch (err) {
        this.logger && this.logger.error('写 checkpoint 失败（照常发送）：' + describeError(err));
      }
    };
    // 普通回复保持原顺序：先落库再算气泡（气泡清空时也留下记录）。
    // 全接管传 deferStore：等确认还有气泡再落库，避免「清理后没正文」仍留下助手记录。
    if (!deferStore) persist();
    if (hasDiaryMark) {
      const expanded = this.expandDiaryMark(decision, text);
      if (expanded !== text) {
        text = expanded;
        decision.finalText = text;
        decision.diaryExpanded = Boolean(msg.isMaster && msg.chatType === 'private');
      }
    }
    const isGroup = msg.chatType === 'group';
    // 命令路径以前在这里直接 return [text]，刚剥出来的 foundEmoji（🫧 这种）直接丢了（M28）
    if (decision.action === 'command') {
      // 延迟落库时命令路径同样有可发内容（text 已在前面判过非空）。
      if (deferStore) persist();
      return foundEmoji ? [text, foundEmoji] : [text];
    }
    const maxBubbles = Math.max(1, Number(this.config.chat.maxBubbles) || 2);
    const hard = LIMITS.maxOutputHard || 4000;
    const normalMaxChars = Math.max(20, Math.min(Number(isGroup ? this.config.chat.groupMaxChars : this.config.chat.privateMaxChars) || LIMITS.maxOutputNormal, hard));
    const maxChars = msg.discussion
      ? Math.min(normalMaxChars, Math.max(20, Number(this.config.chat.discussionMaxChars) || LIMITS.maxOutputDiscussion))
      : normalMaxChars;
    // 字数设置约束整轮正文，不能因分句、多气泡或讨论模式而放大。
    if (!decision.diaryExpanded && Array.from(text).length > maxChars) {
      text = Array.from(text).slice(0, maxChars - 1).join('').trimEnd() + '…';
      decision.finalText = text;
    }
    const preferSeparate = Boolean(msg.separateRequested);
    let bubbles;
    if (decision.diaryExpanded) {
      // 日记原文是存档内容，不按聊天短句切分/截断，原样发一条。
      bubbles = text ? [text] : [];
    } else if (decision.action === 'reply' && !preferSeparate && !text.includes('\n')) {
      // 按逗号/句号拆成几条短消息，每条不带标点
      const clauses = (text.match(/[^，。！？!?；;\n]+/g) || [])
        .map((s) => s.trim().replace(/^[，。！？!?；;]+|[，。！？!?；;~～…]+$/g, ''))
        .filter(Boolean);
      if (clauses.length > 1 && clauses.length <= maxBubbles) {
        bubbles = clauses;
      } else {
        bubbles = persona.splitBubbles(text, { maxChars, maxBubbles })
          .map((b) => String(b || '').trim().replace(/[~～]+$/g, '').replace(/[。！!…]+$/g, ''))
          .filter(Boolean);
      }
    } else {
      bubbles = persona.splitBubbles(text, { maxChars, maxBubbles, preferSeparate });
      if (decision.action === 'reply') {
        bubbles = bubbles.map((b) => b.replace(/[~～]+$/g, '').replace(/[。！!…]+$/g, '')).filter(Boolean);
      }
    }
    // 仅当本轮确实拆出了多段文字时，保留用户要求的文字发送方式。
    decision.separateText = preferSeparate && bubbles.length > 1;
    // emoji / 颜文字单独一条发，不粘在句末。
    // 以前回加和「颜文字用量」概率绑在一起（M28）：chance=0（关/吵架模式）时模型自带的
    // emoji 被剥掉就再也回不来。现在解耦：模型自带的 emoji 无论概率多少都按原设计
    // 回加成单独一条气泡，只有「随机补表情」才看概率。
    const chance = persona.emojiChanceFor(this.config);
    let extra = decision.diaryExpanded ? '' : (foundEmoji || '');
    if (!decision.diaryExpanded && !error && decision.action === 'reply' && !extra && chance > 0 && this.rng() <= chance) {
      // 颜文字和 emoji 各一半，这样「颜文字用量」调高后真的能看到颜文字
      extra = this.rng() < 0.5
        ? persona.kaomojiPick(this.rng)
        : ['🐋', '🥺', '😭', '✨', '💧', '🫧', '🍚'][Math.floor(this.rng() * 7)];
    }
    // 表情在正文截断后追加，必须连同合并时的空格一起占用整轮字数。
    const extraChars = Array.from(extra).length + (bubbles.length >= maxBubbles ? 1 : 0);
    const replyChars = bubbles.reduce((count, bubble) => count + Array.from(bubble).length, 0);
    if (extra && replyChars + extraChars <= maxChars) {
      // 遵守 maxBubbles：气泡已经满了就并到最后一条，别偷偷多发一条
      if (bubbles.length < maxBubbles) bubbles.push(extra);
      else if (bubbles.length) bubbles[bubbles.length - 1] = (bubbles[bubbles.length - 1] + ' ' + extra).trim();
    }
    // 全接管：确认确实有可发气泡后才落库（普通路径已在前面落库，这里不重复）。
    if (deferStore && bubbles.length) persist();
    return bubbles;
  }
  };
}

module.exports = { createFinalizer };
