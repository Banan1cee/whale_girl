'use strict';

function createPromptStage({ persona, features, envInfo, memoryBudget, momentsIntent, separateReplyRe, describeError }) {
  return async function buildPromptDecision(bot, input) {
    const { msg, key, clean, atMe, isGroup, isMaster, mentionedNames, voiceRequested, now, nowMs, session, profile, displayName, appended, triggerResult, linkText, discussion, state, relationsOn, modelInfo, trimScale } = input;
    // mem 必须可重新赋值：超硬上限时会原地换成「没有记忆块」的版本（见下面 catch）。
    // 从 input 解构成 const 会让那次赋值抛 TypeError，结果整条消息被当成超预算拒掉。
    let mem = input.mem;
    const notes = mem.notes || [];
    if (notes.length && msg.senderId) {
      try {
        bot.store.touchNotes(key, msg.senderId, notes, nowMs);
      } catch { /* 「提过几次」没记上不影响这轮回复 */ }
    }
    // mem.recent 已经按 3,200 token 预算裁过；刚写入的当前消息先去掉，由 buildTurns 统一拼一次
    const history = mem.recent || [];
    const currentSeq = appended && appended.seq;
    const historyForTurns = (currentSeq && history.length && history[history.length - 1].seq === currentSeq)
      ? history.slice(0, -1)
      : history;
    const groupParticipants = isGroup
      ? [...new Set(history.filter((m) => m.role === 'user' && m.name).map((m) => String(m.name)))].slice(-16)
      : [];
    // 群聊风格：从最近消息估计群友的句子长度和常用梗，让她跟着学
    let groupStyleText = '';
    if (isGroup) {
      try {
        const terms = persona.slangTerms ? persona.slangTerms(bot.config) : [];
        const others = history.filter((m) => m.role !== 'assistant' && m.text).slice(-30);
        const avg = others.length ? Math.round(others.reduce((n, m) => n + String(m.text).length, 0) / others.length) : 0;
        const joined = others.map((m) => String(m.text)).join(' ');
        const hits = terms
          .map((t) => [t, joined.split(t).length - 1])
          .filter((pair) => pair[1] > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map((pair) => pair[0]);
        if (avg) groupStyleText = `这个群平均每句约 ${avg} 个字${hits.length ? '，最近常用：' + hits.join('、') : ''}。`;
      } catch { /* ignore */ }
    }
    // 旧版对喷状态（fight/fightDirty/fightOnMaster/fightTarget）已删除：
    // 被骂不再触发最大火力提示、靶子点名或强制回怼。

    // 表情包节奏：明确索要优先；严肃窗口按说话人存，只决定“要不要催”，不禁止模型自己发。
    // 只有微信通道才有表情包能力；其它渠道（QQ 等）不参与，免得白算一次随机。
    msg.stickerDemand = msg.platform === 'wechat'
      ? bot.stickerDemandFor({
        state,
        uid: msg.senderId,
        text: clean.text || '',
        nowMs,
      })
      : false;

    // 这一轮的环境 / 桥接状态：
    //   envBlock 是稳定信息（系统、时区、所在地），跟着静态块进 system，逐字节不变；
    //   bridgeLine 每轮都可能变（掉线/恢复），塞进「本轮状态」的尾部，不打碎前缀缓存。
    const envBlock = envInfo.systemBlock(bot.config, bot.version);
    const turnState = { envBlock, bridgeLine: envInfo.bridgeLine(msg) };

    // 动作账本也是记忆的一部分：读不出来就不带，别把整条回复拖死
    let recentEvents = [];
    try { recentEvents = bot.store.events(key, 12) || []; } catch { recentEvents = []; }
    // 提示词拆成两块：system 只放静态人设/规则/日期，尾部放这一轮会变的东西
    // （心情、说话人、字数、@、梗、联网资料、动作账本……），前缀缓存才不会被每轮打断。
    const promptParts = persona.buildPromptParts({
      config: bot.config,
      msg: { ...msg, senderName: displayName, chatTitle: msg.chatTitle || session.title, isMaster, atMe, addressedToBot: Boolean(atMe || msg.replyToBot), mentionedNames, groupParticipants, linkText, discussion, groupStyleText, voiceRequested, replyToName: msg.replyToName, ts: nowMs },
      profile,
      // 记忆不再进 system：人物卡/事件/摘要统一放最后一条 user 消息（mem.block）
      notes: [],
      noteReminders: [],
      sessionSummary: '',
      // 外部动作账本：她做过什么（发表情包、交给桥接、读链接、联网），
      // 不塞进去她就永远不知道自己的副作用，只能编。
      events: recentEvents,
      now,
      envBlock,
    });
    let system = promptParts.system;
    // 日记是「按需读取」的存档，不是每轮都塞全文。只给主人私聊这段工具说明，
    // 模型据此知道可以输出 [[diary:日期]]，由 finalize 替换成文件内容。
    if (bot.diary && isMaster && !isGroup) {
      system += '\n\n【日记工具】你有一份自己的日记存档，可以读取。' +
        '主人问起日记、某天聊了什么、或让你回忆时，可以在回复最后单独写 [[diary:YYYY-MM-DD]] 或 [[diary:latest]]；' +
        '系统会把标记替换成那天的日记原文。不要编造日记内容，也不要在普通聊天里主动提这个标记。';
    }
    // 桥接状态接在本轮状态最后一行；旧行为路径（tail 为空）也照样带上
    const maxBubbles = Number(bot.config.chat.maxBubbles) || 2;
    msg.separateRequested = maxBubbles > 1 && separateReplyRe.test(clean.text || '');
    const separateHint = msg.separateRequested ? '本轮对方要求分开发送。把不同要点各写一行，最多 ' + maxBubbles + ' 行。' : '';
    const tail = [promptParts.tail, turnState.bridgeLine, separateHint].filter(Boolean).join('\n');
    // 主人问起朋友圈时，先尝试补一次最新读取；读不到就用旧快照，并在上下文里说明。
    if (bot.moments && isMaster && !isGroup && momentsIntent(clean.text)
        && typeof bot.moments.ensureFresh === 'function') {
      try {
        const account = String((bot.config.wechat && bot.config.wechat.account) || '').trim();
        await bot.moments.ensureFresh({ account });
      } catch { /* 读不到不影响正常回复 */ }
    }
    // 记忆块 = 人物卡/事件/摘要 + 关系卡 + 朋友圈快照。
    // 朋友圈只在「主人私聊」且这轮确实问到朋友圈时加入，绝不下沉到群聊或普通聊天。
    let momentsBlock = '';
    if (bot.moments && isMaster && !isGroup && momentsIntent(clean.text)) {
      try { momentsBlock = bot.moments.contextBlock(); } catch { momentsBlock = ''; }
    }
    const memoryBlock = [mem.block, mem.relationsBlock, momentsBlock].filter(Boolean).join('\n\n');
    const turns = bot.buildTurns({ ...msg, ts: nowMs }, historyForTurns, memoryBlock, tail);

    // 预算：system 只测量，不裁剪；dialogueBudget 默认 5,500，给裁剪窗口用。
    // 硬上限看**真实输入估算**（system + 实际 turns），不再拿 system + 预算上限冒充。
    let promptBudget;
    const buildBudgetFor = (turnsToUse, withRelations) => memoryBudget.buildBudget(system, {
      dialogueBudget: bot.config && bot.config.memory && bot.config.memory.dialogueBudget,
      // 关系卡开着就从 recent 里切出 120 token，预算口径和 Store 的分片保持一致
      relations: withRelations,
      turns: turnsToUse,
    });
    try {
      promptBudget = memoryBudget.assertWithinHardLimit(buildBudgetFor(turns, relationsOn));
    } catch (err) {
      // 超硬上限以前直接 ignore（只有一行 error 日志，用户看到的是「她突然不回话」）。
      // 现在先丢掉记忆块 + 关系块（用 recentOnlyContext）重算一次，仍超才拒绝。
      let retried = null;
      if (!mem.memoryFailed) {
        try {
          const plain = bot.recentOnlyContext(key, { isGroup });
          const recent = plain.recent || [];
          const curSeq = appended && appended.seq;
          const plainHistory = (curSeq && recent.length && recent[recent.length - 1].seq === curSeq)
            ? recent.slice(0, -1)
            : recent;
          const plainTurns = bot.buildTurns({ ...msg, ts: nowMs }, plainHistory, '', tail);
          retried = memoryBudget.assertWithinHardLimit(buildBudgetFor(plainTurns, false));
          // decision.turns 引用的就是这个数组：原地换成「没有记忆块」的版本
          turns.length = 0;
          turns.push(...plainTurns);
          mem = { ...plain, memoryTokens: 0 };
        } catch {
          retried = null;
        }
      }
      if (!retried) {
        bot.logger && bot.logger.error(
          `单轮输入超硬上限，拒绝调用模型：system≈${err.budget ? err.budget.systemTokens : '?'} token`
          + `（${describeError(err)}）`
        );
        return { action: 'ignore', reason: 'input_budget_exceeded', key, msg, atMe };
      }
      promptBudget = retried;
      bot.logger && bot.logger.warn('单轮输入超硬上限，已丢掉记忆块/关系块重算预算后继续');
    }
    // 只把计数挂到 decision / Bot 上，供日志和内部 status 用；不打印记忆正文
    const applied = bot.calibrationEngine().apply(promptBudget.estimatedPromptTokens, modelInfo);
    promptBudget.calibrationScale = applied.scale;
    promptBudget.calibratedPromptTokens = applied.calibrated;
    promptBudget.calibrationN = applied.n;
    bot.lastBudget = {
      ...promptBudget,
      memoryTokens: mem.memoryTokens || 0,
      summaryTokens: mem.summaryTokens || 0,
      recentTokens: mem.recentTokens || 0,
      relationsTokens: mem.relationsTokens || 0,
      tokenScale: trimScale,
    };
    promptBudget = bot.lastBudget;
    if (bot.logger) {
      bot.logger.debug(
        `记忆预算：system=${promptBudget.systemTokens} dialogue=${promptBudget.dialogueBudget} `
        + `input=${promptBudget.estimatedPromptTokens} calibrated=${promptBudget.calibratedPromptTokens} `
        + `recent=${promptBudget.recentTokens}`
      );
    }

    if (bot.llm.isMock) {
      const text = persona.mockReply({
        text: clean.text,
        userName: displayName,
        chatType: msg.chatType,
        notes,
        rng: bot.rng,
      });
      return { action: 'reply', key, msg, atMe, system, tail, turns, mock: true, text, reason: triggerResult.reason, turnState, budget: promptBudget };
    }
    return { action: 'reply', key, msg, atMe, system, tail, turns, mock: false, reason: triggerResult.reason, turnState, budget: promptBudget };
  };
}

module.exports = { createPromptStage };
