'use strict';

/**
 * 运行时组装（唯一的依赖注入点）：
 *   config / logger / store / llm / bot / gateways
 * 所有模块都从这里拿到依赖，不再各自 require 单例。
 */
const path = require('node:path');
const { ensureConfigFile, loadConfig } = require('./infra/config');
const { createLogger } = require('./infra/logger');
const { migrateOwnerName } = require('./infra/ownerName');
const { watchConfigFile } = require('./infra/configPatch');
const features = require('./infra/features');
const configSchema = require('./infra/configSchema');
const { describeError } = require('./infra/errors');
const { Store } = require('./memory/store');
const memoryBackup = require('./memory/backup');
const { recoverRestore } = require('./memory/backupRestore');
const mediaCache = require('./adapters/mediaCache');
const { DeepSeekClient } = require('./llm/client');
const { Bot } = require('./pipeline/bot');
const { createTrace } = require('./core/trace');
const { createGateways } = require('./adapters/gateway');
const personaStore = require('./persona/store');
const { StickerService } = require('./services/stickerService');
const stickersAdapter = require('./adapters/stickers');
const probe = require('./infra/probe');
const { Scheduler } = require('./infra/scheduler');
const { ContactsCache } = require('./services/contacts');
const { MomentsService } = require('./services/moments');
const { MomentsPublisher } = require('./services/momentsPublisher');
const { ReminderService } = require('./services/reminderService');
const { DiaryService } = require('./services/diary');
const { DigestService } = require('./services/digest');
const locationProbe = require('./services/location');
const { PluginHost } = require('./services/pluginHost');
const { createFeatureCapabilities } = require('./services/features');
const { createDurableStore } = require('./services/durableStore');
const { createStreamingChat } = require('./services/streamingChat');
const { sendDenial } = require('./core/wechatSendPolicy');

const VERSION = require('../package.json').version;

function createRuntime({ root = path.resolve(__dirname, '..'), env = process.env, loggerLevel } = {}) {
  const probeT0 = probe.now();   // 探针：createRuntime 整体耗时（listen 之前的关键路径）
  // 恢复中断事务必须早于配置读取和 Store 建目录；失败沿用构造失败语义，不能带着替代空树继续启动。
  recoverRestore(path.join(root, 'data'));
  ensureConfigFile(root);
  const config = loadConfig({ root, env });
  // 称呼只认一个真源：config.json 的 persona.ownerName。
  // 老版本把它存在 data/settings.json 的 userName 里，这里做一次迁移，之后设置接口和界面改的是同一个值。
  migrateOwnerName(config);
  // 加载主人在微信里调过的语态 / 能力（data/persona.json）
  personaStore.apply(config, personaStore.load(config));
  // 测试/自检可以传 WHALE_LOG_FILE='' 关掉文件日志：Windows 上'日志流没关'会把 data 目录占住，删不掉
  const logFileFromEnv = Object.prototype.hasOwnProperty.call(env || {}, 'WHALE_LOG_FILE') ? String(env.WHALE_LOG_FILE) : null;
  const logFile = logFileFromEnv === null ? config.paths.logFile : (logFileFromEnv || null);
  const logger = createLogger({
    level: loggerLevel || config.log.level,
    // 文件永远记 debug 全量：界面按 level 过滤，出问题回看文件时不能丢细节
    fileLevel: (config.log && config.log.fileLevel) || 'debug',
    file: logFile,
  });
  // 探针：事件循环延迟采样必须从 createRuntime 就开始 —— 同步迁移就堵在这里，
  // 放到 listen 之后再开会永远看不到那 10 秒。默认关，WHALE_PROBE_LOOP=1 才启动。
  const loopProbe = probe.startEventLoopProbe(logger);
  // 配置体检：非法值以前会被各处的 `Number(x) || 默认` 静默吃掉，
  // 用户在启动器或 config.json 里填错了也看不出来。这里启动时报一次，不阻断运行。
  try {
    const configErrors = configSchema.validate(config);
    if (configErrors.length) {
      logger.warn(
        'config.json 有 ' + configErrors.length + ' 项不合法（会按原值继续跑，建议修掉）：' +
          configSchema.formatErrors(configErrors)
      );
    }
  } catch { /* 校验失败不影响启动 */ }
  // 模块子日志：info 行首带 [memory] / [llm] 这种模块名，warn/error 仍由 logger 自己抓 file:line。
  // 测试里传进来的 logger 是桩对象、没有 child，这里兜一下，别让日志把启动搞挂。
  const child = (name) => (logger && typeof logger.child === 'function' ? logger.child(name) : logger);
  const store = new Store({
    file: config.paths.storeFile,
    // 关系卡份额（120 token）跟着 features.relations 走：关掉就并回 recent
    limits: { ...(config.memory || {}), relationsEnabled: features.isOn(config, 'relations') },
    // 记忆 v2 格式闸：默认关。切换 PR 会把默认值改成 true，并删掉 migrate.migrateIfNeeded。
    formatVersionEnforced: features.isOn(config, 'memoryV2'),
    logger: child('memory'),
  });
  // 启动时先「忘」一遍：太久没被想起、又不重要的记忆沉到归档，别一直占着检索位
  try {
    const swept = store.sweep();
    if (swept.archived || swept.evicted) {
      logger.info(`记忆清理：归档 ${swept.archived} 条、淘汰 ${swept.evicted} 条（归档共 ${store.archiveCount()} 条）`);
    }
  } catch (err) {
    logger.warn('记忆清理失败（不影响使用）：' + describeError(err));
  }
  // 每次启动留一份记忆快照：换目录/重装/误点重置都能捞回来
  try {
    const snap = features.isOn(config, 'memorySnapshot') ? memoryBackup.writeSnapshot(root, 'startup') : null;
    if (snap) logger.info('记忆快照：' + path.basename(String(snap)));
  } catch (err) {
    logger.warn('记忆快照失败（不影响使用）：' + describeError(err));
  }
  // 媒体缓存（图片/表情包/语音 wav）永不清理会越堆越大，启动时清一次
  try {
    if (features.isOn(config, 'mediaCleanup')) {
      const mediaDir = path.join(root, 'data', 'media-cache');
      const mc = mediaCache.cleanup(mediaDir, {
        maxAgeDays: Number((config.storage || {}).mediaKeepDays) || 7,
        maxTotalMB: Number((config.storage || {}).mediaMaxMB) || 500,
      });
      if (mc.removed) logger.info(`媒体缓存清理：删 ${mc.removed} 个文件，释放 ${mc.freedMB} MB`);
    }
  } catch (err) {
    logger.warn('媒体缓存清理失败（不影响使用）：' + describeError(err));
  }

  const runtime = { config, logger, store, startedAt: Date.now(), version: VERSION, loopProbe };
  runtime.child = child;
  // 进程内定时任务统一入口：日记 tick、记忆快照、朋友圈定时读取共用，
  // 关服务只需要 stopAll；请求超时/桥接轮询不归它管。
  runtime.scheduler = new Scheduler({ logger: child('scheduler') });

  // 长时间挂着也要有断点：每 30 分钟留一份（启动那份可能已经是几十小时前了）
  try {
    runtime.scheduler.every('memory.snapshot', 30 * 60 * 1000, () => {
      if (!features.isOn(runtime.config, 'memorySnapshot')) return;
      const file = memoryBackup.writeSnapshot(root, 'cron');
      if (file) logger.info('记忆快照（定时）：' + path.basename(String(file)));
    });
  } catch { /* 定时器起不来不影响主流程 */ }

  runtime.llm = new DeepSeekClient({ config, logger: child('llm') });
  runtime.diary = new DiaryService(config, {
    store,
    llm: runtime.llm,
    logger: child('diary'),
    scheduler: runtime.scheduler,
    // 日记写完要发给主人时，借用提醒的主动发送队列；runtime.reminders 在下面才创建，
    // 所以这里用闭包延迟取，真正发日记时它已经存在。
    // 这一条不走宿主能力：它是同进程内的回调装配（同步、无返回值、失败只记日志），
    // 而能力分发是异步的；套上去会在启动早期拿不到实现，反而丢日记。
    enqueue: (item) => runtime.reminders.enqueueNow(item),
  });
  runtime.diary.start();
  // 消息汇总：用户在启动器点「生成」时才跑，不占后台定时器，也不自动烧 token。
  runtime.digest = new DigestService(config, {
    store,
    llm: runtime.llm,
    logger: child('digest'),
  });
  // 记忆层用同一个模型做 episode 摘要/抽取（后台跑，不在回复热路径）
  store.llm = runtime.llm;
  // 判定链：为什么回 / 为什么不回。默认只记原因和状态；正文在 data/trace/raw 里留 24 小时，
  // 导出日志包时默认不带（要带得在启动器里手动勾选）。
  const trace = createTrace({
    dataDir: config.paths.dataDir,
    enabled: !(config.log && config.log.trace === false),
    raw: Boolean(config.log && config.log.traceRaw !== false),
  });
  runtime.trace = trace;
  runtime.bot = new Bot({ config, store, llm: runtime.llm, logger: child('pipeline'), trace, version: VERSION });
  // 主人问起日记时，聊天模型通过 [[diary:日期]] 标记读取；不给它直接塞全文。
  runtime.bot.diary = runtime.diary;
  // 本机所在地：后台探一次（Windows 定位服务优先，挂 VPN 也准），之后定期刷新。
  // 只放在内存里，给 <env> 块用；关掉 features.envContext 或 env.autoDetect=false 就完全不动。
  try {
    runtime.stopLocationProbe = locationProbe.startAutoProbe(config, { logger: child('env') });
  } catch (err) {
    logger.warn('所在地探测没起来（不影响聊天）：' + describeError(err));
  }
  // 表情包任务队列：内存态，重启不重放（避免把上一条没发出去的表情再补发一次）
  // store 用来记动作账：发了哪张、桥接确认没确认，下一轮提示词才看得见
  stickersAdapter.setProbeLogger(child('sticker'));   // 探针：让适配层也往同一份日志写
  runtime.stickerService = new StickerService(config, { store, logger: child('sticker') });
  runtime.bot.stickerService = runtime.stickerService;
  // 联系人缓存：桥接推上来的 wxid 清单，给启动器选择器和 care 白名单用
  runtime.contacts = new ContactsCache(config, { logger: child('contacts') });
  runtime.moments = new MomentsService({
    dir: path.join(config.paths.dataDir, 'moments'),
    logger: child('moments'),
    llm: runtime.llm,
    config,
    scheduler: runtime.scheduler,
  });
  runtime.bot.moments = runtime.moments;
  runtime.moments.startAutoRead();
  runtime.momentsPublisher = new MomentsPublisher({
    config, store, llm: runtime.llm, logger: child('moments'),
  });
  // 提醒：到点由桥接来取（/api/reminders/due），这里只管存和状态
  runtime.reminders = new ReminderService(config, {
    logger: child('reminder'),
    // 「刚聊过先跳过」规则要看会话最后一条消息的时间
    lastActiveAt: (wxid) => {
      const keys = [`wechat:u:${wxid}`, `wechat:g:${wxid}`];
      let last = 0;
      for (const key of keys) {
        try {
          const msgs = store.messages(key, 1);
          const ts = Number(msgs && msgs[0] && msgs[0].ts) || 0;
          if (ts > last) last = ts;
        } catch { /* 读不到就算了 */ }
      }
      return last;
    },
  });
  runtime.bot.reminders = runtime.reminders;
  // 启动扫描：已经过了提醒时间（连 5 分钟重试窗口都过了）的一律标过期，不再补发
  try {
    const swept = runtime.reminders.sweepStale();
    if (swept.expired) logger.info(`提醒清理：${swept.expired} 条已过期（过了提醒时间，不再补发）`);
  } catch (err) {
    logger.warn('提醒清理失败（不影响使用）：' + describeError(err));
  }
  // 启动：检测 30 分钟空闲的 episode 补写 L2；超过 3,200 token 的按需压缩。
  // 后台跑，不阻塞服务启动；原文已经在磁盘上，补写失败也只是晚一轮。
  try {
    store.startupRecovery({ llm: runtime.llm })
      .then((r) => {
        if (r && (r.episodesClosed || r.chats)) {
          logger.info(`记忆启动恢复：${r.chats} 个聊天，补写 ${r.episodesClosed || 0} 个 episode`);
        }
      })
      .catch((err) => logger.warn('记忆启动恢复失败（不影响聊天）：' + describeError(err)));
  } catch (err) {
    logger.warn('记忆启动恢复失败（不影响聊天）：' + describeError(err));
  }
  runtime.plugins = runtime.bot.plugins;
  runtime.capabilities = runtime.bot.capabilities;
  // 所有功能能力都登记到同一个 dispatcher：宿主内部调用与插件 host.call 走同一条口子。
  // 少登记一项就会让对应路由/插件在运行时报 host_capability_unknown，所以这里不做静默跳过。
  for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime))) {
    runtime.capabilities.defineHost(name, handler);
  }
  // 持久任务：数据目录可用时落到 data/host-tasks.jsonl。装配是同步且廉价的；
  // 重放放到下一轮事件循环，不阻塞 listen，失败只告警（任务记录仍在文件里）。
  if (config.paths && config.paths.dataDir) {
    try {
      const durableStore = createDurableStore({
        file: path.join(config.paths.dataDir, 'host-tasks.jsonl'),
        logger: child('capabilities'),
      });
      runtime.capabilities.attachDurableStore(durableStore);
      runtime.durableStore = durableStore;
      setImmediate(() => {
        Promise.resolve(runtime.capabilities.replayDurable())
          .then((summary) => {
            if (summary && (summary.replayed || summary.dropped || summary.kept)) {
              logger.info(`持久任务重放：完成 ${summary.replayed} 条，放弃 ${summary.dropped} 条，保留 ${summary.kept} 条`);
            }
          })
          .catch((err) => logger.warn('持久任务重放失败（不影响主流程）：' + describeError(err)));
      }).unref?.();
    } catch (err) {
      logger.warn('持久任务存储装配失败（不影响主流程）：' + describeError(err));
    }
  }
  runtime.pluginHost = new PluginHost(runtime);
  // 插件 Worker 只能经 host.call 回到宿主；宿主按 registry 校验声明、作用域和启用状态。
  runtime.plugins.hostCall = (name, input, flow, options) => runtime.pluginHost.call(name, input, flow, options);

  // 全聊天接管前先把宿主安全闸跑完：管理员魔咒、禁言/白名单、重复消息都留在宿主手里。
  // 这些情况不走插件，直接回退内置流程，避免替换者绕过身份与发送保护。
  // `receipt` 记录「消息是否已经被宿主接收入账」：去重占位一旦发生，后面任何失败
  // 都不能再回退内置流程，否则就是第二条接收路径。
  const chatPreflight = (input, msg, key, receipt) => {
    if (runtime.bot.isAdminSpellMessage?.(msg)) return { allowed: false, fallbackBuiltin: true };
    // 身份（管理员魔咒）在入口层判断；能不能发交给共享规则，和网关/桥接同一个形状。
    const denied = sendDenial(runtime.config, msg);
    if (denied) return { allowed: false, result: { action: 'ignore', reason: denied } };
    if (msg.msgId) {
      if (store.isDuplicate(key, msg.msgId)) {
        return { allowed: false, result: { action: 'ignore', reason: 'duplicate' } };
      }
      // 接管会跳过 Bot 的去重登记，必须在同会话串行队列里先占位，避免超时后重放。
      store.markSeen(key, msg.msgId);
    }
    receipt.received = true;
    return { allowed: true, input };
  };

  // 全接管的整段（插件调用 + 宿主结果阶段）也进同一会话队列：插件返回后还要
  // 落库、提交配额、拆气泡，只有和正常聊天共用一条链，两条消息才不会被后到的抢先。
  const takeoverChat = async (message, { localWechat = false, signal } = {}, key) => {
    let result;
    // builtin 返回的是宿主完整管线（管理员魔咒回退，或排队期间接管被撤下）的结果：
    // 它已经 finalize、落库、计过配额，不能再进一次结果阶段。用显式标记区分来源，
    // 完整结果另存，保住原 command/reason/mock 等字段。
    let hostHandled = false;
    let hostResult = null;
    const receipt = { received: false };
    try {
      result = await runtime.capabilities.invoke(
        'chat.handle@1',
        { message: runtime.bot.providerMessage(message), localWechat },
        { key: `handle:${key}`, scope: 'all', signal, preflight: input => chatPreflight(input, message, key, receipt),
          // 已经在同一会话队列里：管理魔咒的回退直接跑本轮，不能再排一次队。
          builtin: async () => {
            hostHandled = true;
            hostResult = await runtime.bot.handle(message, { localWechat, signal, alreadyQueued: true });
            // dispatcher 会按 chat.handle.output@1（additionalProperties:false）校验 builtin
            // 返回值；宿主结果里的 mock/commandType 等不属于插件契约，这里只回契约字段，
            // 完整结果由 hostResult 原样返回给调用方。
            const contract = { action: hostResult.action };
            if (typeof hostResult.reply === 'string') contract.reply = hostResult.reply;
            if (Array.isArray(hostResult.bubbles)) contract.bubbles = hostResult.bubbles;
            if (typeof hostResult.mention === 'string') contract.mention = hostResult.mention;
            if (typeof hostResult.reason === 'string') contract.reason = hostResult.reason;
            return contract;
          } },
      );
    } catch (failure) {
      const code = String((failure && failure.code) || '');
      // 断线/取消不是插件故障：按取消收尾，交给流式层静默结束，也不占配额。
      if (signal?.aborted || code === 'capability_aborted') {
        return { cancelled: true, action: 'ignore', reason: 'cancelled' };
      }
      // 内置流程已经跑完并落库/计过配额，再回退一次就是重复发送与重复计价。
      if (hostHandled) throw failure;
      // 授权失效：消息已经通过前置闸（去重占位），插件也可能已经执行过一部分；
      // 回退内置流程会重复接收、甚至和插件已产生的副作用重叠，只能 fail closed。
      // 只记 warn 并把原因带给调用方，不把它当成需要重试的宿主故障。
      if (code === 'grant_revoked' || code === 'capability_not_declared' || code === 'plugin_not_enabled') {
        runtime.logger.warn('全接管授权失效，按忽略收尾：' + describeError(failure));
        return { action: 'ignore', reason: 'capability_revoked' };
      }
      // 输出不合契约（含 reply 为空）：插件已经执行过，半成品不能下发，同样不回退。
      if (code === 'invalid_capability_output') {
        runtime.logger.warn('全接管输出不合契约，按忽略收尾：' + describeError(failure));
        return { action: 'ignore', reason: 'invalid_plugin_output' };
      }
      // 插件还没开始执行、宿主也还没占位（去重/禁言闸都没跑）：这些失败没有可重复的
      // 接收或发送副作用，回退内置流程是安全的，比把消息静默丢掉更稳。
      if (!receipt.received && (code === 'capability_queue_limit'
        || code === 'capability_owner_conflict' || code === 'invalid_capability_input')) {
        runtime.logger.warn('全接管调度失败（无副作用），回退内置流程：' + describeError(failure));
        return runtime.bot.handle(message, { localWechat, signal, alreadyQueued: true });
      }
      // 其余都是真实故障（进程退出、超时、插件报错、内置流程自身出错）：
      // 交给上层按错误收尾并留日志，不在这里吞成一条「忽略」。
      throw failure;
    }
    // 宿主已经处理完的结果原样返回：不再治理、不再落库、不再扣配额。
    if (hostHandled) return hostResult;
    if (signal?.aborted) return { cancelled: true, action: 'ignore', reason: 'cancelled' };
    if (!result || result.action !== 'reply') return { action: 'ignore', reason: (result && result.reason) || 'ignored' };
    // 只有真实插件输出才进宿主结果阶段；失败回退不在这里做。
    return runtime.bot.finishTakeoverReply(message, result, { signal });
  };

  const handleChat = (message, options = {}) => {
    if (!runtime.capabilities.hasProviders('chat.handle@1')) return runtime.bot.handle(message, options);
    const key = runtime.bot.sessionKey(message);
    return runtime.bot.queueSession(key, () => takeoverChat(message, options, key));
  };
  runtime.chat = Object.freeze({
    handle: handleChat,
    stream: createStreamingChat(runtime.bot, child('chat'), {
      takeOver: () => runtime.capabilities.hasProviders('chat.handle@1'),
      handle: handleChat,
    }),
  });
  runtime.gateways = createGateways({ config, bot: runtime.bot, logger: child('gateway'),
    chat: runtime.chat });

  // 新扩展点的生命周期通知（app.start@1 / app.stop@1）：
  // 按授权快照签名跟踪，一次授权只通知一次；用户运行中启用/更新插件后，由 server.js
  // 现有的 reconcile 回调补发，不新增第二个定时器。
  // 签名 = id + 安装包摘要 + 授权代次 + 授权字节摘要：停用/更新/重签都会换代。
  const flowStarts = new Map();   // 插件 id -> { signature, flow }；按 id 有界，新快照直接替换旧的
  const MAX_FLOW_STARTS = 512;
  let lifecycleStopping = false;

  const signatureOf = flow => [
    flow.id, flow.packageHash ?? flow.hash ?? '', flow.epoch ?? '', flow.authRevision ?? '',
  ].join('\u0000');

  const lifecyclePayload = flow => ({
    at: Date.now(),
    settings: flow && flow.settings && typeof flow.settings === 'object' && !Array.isArray(flow.settings)
      ? flow.settings : {},
  });

  // 只认仍然有效的授权快照：撤权/停用/更新/重签都会让旧 flow 失效。
  // 绝不拿旧快照“补执行”一次，否则等于让已撤回的插件再跑一遍。
  const currentLifecycleFlow = (flow, name) => {
    try {
      const fresh = runtime.plugins.current(flow);
      return fresh && fresh.provides && fresh.provides[name] ? fresh : null;
    } catch { return null; }
  };

  const syncPluginStarts = () => {
    if (lifecycleStopping) return;   // 停机已经进入 stop 语义：不再补发 start
    let providers = [];
    try { providers = runtime.capabilities.providers('app.start@1', 'all') || []; } catch { return; }
    for (const flow of providers) {
      try {
        const signature = signatureOf(flow);
        const known = flowStarts.get(flow.id);
        if (known && known.signature === signature) continue;
        // 先占位再调用：reconcile 每 500ms 触发一次，慢启动不能被重复通知。
        flowStarts.set(flow.id, { signature, flow });
        while (flowStarts.size > MAX_FLOW_STARTS) flowStarts.delete(flowStarts.keys().next().value);
        const current = currentLifecycleFlow(flow, 'app.start@1');
        if (!current) continue;   // 快照刚被撤权/更新：旧快照绝不晚执行
        Promise.resolve(runtime.capabilities.invoke('app.start@1', lifecyclePayload(current), { pluginId: current.id }))
          .catch(err => runtime.logger.warn('[app.start@1] 插件观察失败（不影响主流程）：' + describeError(err)));
      } catch (err) {
        runtime.logger.warn('[app.start@1] 生命周期装配失败（不影响主流程）：' + describeError(err));
      }
    }
  };

  // 正常停机：对仍然持有有效授权、且本进程确实通知过 start 的插件各发一次 stop，并 await。
  // 撤权优先：撤权/卸载/更新后的旧快照一律不执行（包括 stop），所以撤权之后
  // 不保证插件收到 app.stop@1——只保证不再运行它的旧代码。日志不打印 settings。
  const stopPluginLifecycles = async () => {
    if (lifecycleStopping) return;
    lifecycleStopping = true;
    const pending = [];
    for (const { flow } of [...flowStarts.values()]) {
      const current = currentLifecycleFlow(flow, 'app.stop@1');
      if (!current) continue;
      pending.push(Promise.resolve(runtime.capabilities.invoke('app.stop@1', lifecyclePayload(current), { pluginId: current.id }))
        .catch(err => runtime.logger.warn('[app.stop@1] 插件观察失败（不影响停机）：' + describeError(err))));
    }
    flowStarts.clear();
    await Promise.all(pending);
  };

  runtime.pluginLifecycle = Object.freeze({ sync: syncPluginStarts, stop: stopPluginLifecycles });

  const observeDispatched = (message, result) => {
    try {
      if (!result || result.__pluginDispatched || !runtime.capabilities.hasProviders('chat.dispatched@1', 'all')) return;
      const reply = result.action === 'reply';
      const sent = reply && result.ok !== false && Boolean(result.outbound && result.outbound.ok !== false);
      const payload = {
        message: runtime.bot.providerMessage(message),
        text: reply ? String(result.reply || '').slice(0, 16000) : '',
        action: reply ? 'reply' : 'ignore',
        sent,
      };
      if (!reply && result.reason) payload.reason = String(result.reason).slice(0, 80);
      void runtime.capabilities.invoke('chat.dispatched@1', payload, { key: runtime.bot.sessionKey(message) })
        .catch(err => runtime.logger.warn('[chat.dispatched] 观察者失败（不影响发送）：' + describeError(err)));
    } catch (err) {
      runtime.logger.warn('[chat.dispatched] 观察者装配失败（不影响发送）：' + describeError(err));
    }
  };
  for (const gateway of runtime.gateways.values()) {
    const originalHandle = gateway.handleInbound.bind(gateway);
    gateway.handleInbound = async (...args) => {
      const result = await originalHandle(...args);
      try {
        const message = runtime.bot.normalize(args[0]);
        // bot.handle 已经对 ignore 发过 observe 时，网关结果不能重复观察。
        if (result.action !== 'reply' && runtime.bot.consumeDispatchedIgnore?.(message)) return result;
        observeDispatched(message, result);
      } catch { /* 观察者不能影响网关结果 */ }
      return result;
    };
  }
  // 启动时就已授权的插件先通知一次；之后新启用的由 reconcile 回调补齐。
  syncPluginStarts();
  const stopPlugins = runtime.plugins.stop.bind(runtime.plugins);
  runtime.plugins.stop = async (...args) => {
    // 先 await 生命周期 stop（只发一次），再真正终止 worker，保证插件在停机前收到回调。
    await stopPluginLifecycles();
    return stopPlugins(...args);
  };

  const pluginAllowed = item => runtime.plugins.isApprovedIdHash(item.pluginId, item.pluginHash);
  runtime.reminders.pluginAllowed = pluginAllowed;
  runtime.stickerService.pluginAllowed = pluginAllowed;
  watchConfigFile(runtime);
  // 探针：createRuntime 结束 = server.js 可以 listen 的时刻，这条就是「启动被堵了多久」
  probe.emit(logger, 'info', `createRuntime 耗时=${probe.ms(probe.now() - probeT0)}ms（listen 之前）`);
  return runtime;
}

module.exports = { VERSION, createRuntime };
