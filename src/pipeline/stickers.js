'use strict';

function createStickerOps({ stickers }) {
  return {
  stickerFor(decision, text) {
    if (!stickers.isOn(this.config) || !this.stickerService) return null;
    if (decision && decision.error) {
      this.logger?.info('[sticker] stage=decision result=skip reason=reply_error');
      return null;
    }
    const msg = (decision && decision.msg) || {};
    if (msg.platform !== 'wechat' || !msg.chatId) return null;
    let category = decision && decision.stickerCategory;
    // 模型可能写中文名（开心/撒娇），统一成内部 key 再判断有没有图
    if (category) {
      const normalized = stickers.categoryFromName(this.config, category);
      if (normalized) category = normalized;
    }
    // 模型写了空分类/写错名字：换成家族里第一个有图的
    if (category && !stickers.isUsableCategory(this.config, category)) {
      category = stickers.resolveUsableCategory(this.config, category);
    }
    // 用户明确要，或这一轮命中提醒且开了“必发”：模型没写标记也补一张。
    // 必发只在命中提醒的轮次生效；严肃/求助轮次 demand 本来就是 false。
    if (!category) {
      const userText = String(msg.cleanText || msg.text || '');
      const rawEnsure = this.config.sticker && this.config.sticker.ensureSend;
      const ensure = rawEnsure === true || rawEnsure === 1 || /^(1|true|on|yes)$/i.test(String(rawEnsure || ''));
      const demanded = Boolean(decision && decision.stickerDemand);
      if (stickers.isStickerRequest(userText) || (ensure && demanded)) {
        category = stickers.categoryInText(this.config, userText)
          || (ensure && demanded ? stickers.moodCategory(this.config, userText + '\n' + String(text || '')) : '')
          || stickers.defaultCategory(this.config);
      }
    }
    if (!category) {
      this.logger?.info('[sticker] stage=decision result=skip reason=no_category_or_demand');
      return null;
    }
    if (decision) decision.stickerCategory = category;
    try {
      return this.stickerService.plan(msg, category);
    } catch (err) {
      if (this.logger) this.logger.warn('[sticker] stage=plan result=failed ' + describeError(err));
      return null;
    }
  },

  /**
   * 严肃场景的短窗口：按说话人记 15 分钟 / 连续 4 条普通消息，先到先解除。
   * 只影响“要不要催她带图”，不禁止模型自己写标记。
   * @returns {boolean} 这条消息是否仍处于严肃窗口
   */
  updateSeriousState(state, uid, text, nowMs) {
    const map = state.seriousByUser || (state.seriousByUser = {});
    const key = String(uid || '');
    for (const k of Object.keys(map)) {
      const entry = map[k];
      if (!entry || Number(entry.until || 0) < nowMs - 60 * 60 * 1000) delete map[k];
    }
    const entry = map[key];
    if (stickers.isSeriousText(text)) {
      map[key] = { until: nowMs + stickers.SERIOUS_WINDOW_MS, turns: 0 };
      return true;
    }
    if (!entry || nowMs >= Number(entry.until || 0)) {
      if (entry) delete map[key];
      return false;
    }
    if (stickers.isLivelyText(text)) {
      delete map[key];
      return false;
    }
    entry.turns = Number(entry.turns || 0) + 1;
    if (entry.turns >= stickers.SERIOUS_TURNS) {
      delete map[key];
      return false;
    }
    return true;
  },

  /**
   * 这一轮要不要在尾部提醒她“带一张”。
   * 明确索要优先；严肃窗口内不催；其余按 sticker.demandChance。
   */
  stickerDemandFor({ state, uid, text, nowMs } = {}) {
    // 总闸关着就不参与；有没有图交给 persona（图库空时不会出现表情包块，也不会加尾部提示）。
    if (!stickers.isOn(this.config)) return false;
    const clean = String(text || '');
    if (stickers.isStickerRequest(clean)) {
      if (state && uid) {
        const map = state.seriousByUser;
        if (map) delete map[String(uid)];
      }
      return true;
    }
    const serious = this.updateSeriousState(state || {}, uid, clean, nowMs);
    // 只拦真正的难过/求助；对喷和“认真讨论”不拦：讨论状态会持续 10 分钟，拿它当闸门会把整段闲聊都压成 0。
    if (serious) return false;
    const raw = Number(this.config.sticker && this.config.sticker.demandChance);
    const chance = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.7;
    return this.rng() < chance;
  }
  };
}

module.exports = { createStickerOps };
