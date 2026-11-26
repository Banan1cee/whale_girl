# 踩坑清单（都是读宿主代码才发现的）

按「现象 → 原因 → 做法」写。协议本身（等级、字段、限额）看 `protocol.md`，这里是文档没直说、但一定会踩到的行为。

1. **`ctx.settings` 不是 `input.settings`**
   现象：设置项在卡片里填好了，处理器里 `input.settings` 却是 `undefined`。
   原因：Node worker 的调用约定是 `(input, { host, signal, settings, state })`，设置只在第二参；只有 `task.tick@1` 的输入按能力 schema 自带 `settings`。
   做法：一律从第二参取 `settings`，再自己兜默认值。

2. **`settingsSchema` 不填默认值，`required` 会让插件装上就不可用**
   现象：代码里 `settings.mode` 是 `undefined`；或者加了 `required` 后插件在卡片里像没装上。
   原因：schema 只描述约束，宿主不注入默认值；安装时设置初值是 `{}`，宿主读到不合 schema 的设置就当作插件不可用。
   做法：去掉 `required`，默认值写代码里（`settings.mode ?? 'default'`）。

3. **入口导出：`exports.providers` 和 `module.exports = { providers }` 都行，包一层别的就不行**
   现象：`plugin_error`，卡片能启用但一调用就失败。
   原因：worker 读的是 `module.exports.providers`，找不到函数就报错。
   做法：`exports.providers = {...}`，或 `module.exports = { providers: {...} }`；不要写成 `module.exports = { 'tool.run@1': fn }`。

4. **每次调用都是新进程**
   现象：模块级缓存、定时器、单例在下次调用时全没了；`__dirname` 写文件写到安装目录。
   原因：Node 插件按调用拉起独立 worker，`cwd` 是插件数据目录，`__dirname` 是安装目录。
   做法：跨调用缓存写 `process.cwd()` 下；不要依赖模块变量；第三方依赖打不进包，别 `require` 它们。数据目录的容量与清理边界见第 18 条。

5. **`task.tick@1` 没有 state，而且不会并发**
   现象：定时任务里模块变量存进度，下一次 tick 拿不到；担心两轮撞车。
   原因：tick 输入只有 `scheduledAt`/`now`/`settings`，state 通道只对四个聊天能力开放；调度器在上一轮没跑完时直接跳过这一轮。
   做法：进度落盘到工作目录并加锁文件，或用设置（改设置会重签授权，慎用）。

6. **gate 的 fail-open：异常不是 `skip`**
   现象：插件把消息判错了，结果还是照常回复；或者插件崩了但聊天没停。
   原因：gate 报错、超时、输出不合契约都按 `pass` 处理，宿主不想让坏插件吞掉主人消息。
   做法：要「不回」显式返回 `{action:'skip'}`；错误自己记日志。

7. **`wake` 有效，但只在宿主基础检查通过之后**
   现象：群友没 @ 她、她本来不回复，以为 gate 收不到；或者以为 wake 没用。
   原因：gate 在宿主去重/禁言/静音/白名单/管理魔咒之后、触发判定之后调用，`wake` 会把「本来不回」改写成回；被基础检查挡下的消息根本不会问插件。
   做法：想主动接话用 `wake`；想连被禁言的消息都看，只能先让 `chat.received@1` observe（它也拿不到被拦下的消息）。

8. **`dataAccess` 没声明时插件照样被调用，但读不到也改不动**
   现象：提示词插件「没生效」，或者日志里没有错误；生成插件拿到的 `turns` 是空数组。
   原因：宿主按每个插件自己的 `dataAccess` 递归删除顶层与 enhance 信封里的 `system`/`history`；`chat.generate@1` 的历史在 `turns`，没授权时被清成 `[]`（保留字段）；返回的同名字段又被换回上一层值。
   做法：要读/改就声明 `["model.prompt"]`/`["chat.history"]`；只做别的逻辑就完全别碰这些字段。不要指望「返回空 system」能清空提示词——只会被回收，或者因缺必填字段判 `invalid_capability_output` 后降级。`now`/`lastBot` 不受这条影响：它们在 pre_reply/prompt/before_send/reply 的输入里始终发放（generate/handle 没有）。

9. **`dataAccess` 只认旧词，而且要挂在 `chat.*` 能力上**
   现象：`manifest_data_access_invalid`。
   原因：清单只接受 `chat.history`/`model.prompt`（运行时也接受 `conversation-history`/`system-prompt` 作为等价授权，但清单不收）；且必须同时声明一个带数据访问的 `chat.*` 提供者，只有 `tool.run@1` 时写 `dataAccess` 会被拒。
   做法：写旧词，和 `chat.prompt@1`/`chat.reply@1`/`chat.before_send@1`/`chat.generate@1` 一起用。

10. **`message.submit@1` 永远不可用，`message.send@1` 的 `voice` 只能合成**
    现象：调 `message.submit@1` 得到 `host_capability_disabled`；想发自己录的音频发不出去。
    原因：`message.submit@1` 在注册表里是 `enabled:false` 的保留能力；`message.send@1` 的 `delivery:"voice"` 只是让宿主用文本合成语音，没有音频上传通道。
    做法：发文本用 `message.send@1`，需要语音就把文案交给它；不要把 `queued` 当送达，也不要承诺「已作为你的录音发出」。

11. **`chat.handle@1` 的 `bubbles` 不直接下发，`mention` 也不保证**
    现象：插件精心拆好的气泡被重新拆过；@ 没生效。
    原因：接管结果仍走宿主 `finalize`（配额、字数上限、安全兜底、拆气泡只有一份实现）；`mention` 交给桥接，`send_at` 失败会退回普通文本。
    做法：只给 `reply`，气泡交给宿主；要 @ 人就把名字放进 `mention` 并接受「可能降级成纯文本」。

12. **`chat.generate@1` 的 `turns` 已含本轮消息**
    现象：模型把同一个问题回答两遍，或者回复里出现「你刚才问了两遍」。
    原因：宿主的 `turns` 已经包含当前这条用户消息（群聊还带发言人标签），再追加 `message.text` 就重复了。
    做法：直接转发 `turns`；想加指令就加在 `system` 里。

13. **`compat: "api3"` 只服务 3 级的五个聊天能力**
    现象：声明了 compat 的 3 级插件能装上，一调用就 `plugin_error`。
    原因：api3 信封只对 `chat.pre_reply@1`/`chat.prompt@1`/`chat.reply@1`/`chat.before_send@1`/`chat.received@1` 有定义；`tool.run@1` 没有旧信封，`chat.received` 的返回值按 observe 丢弃。
    做法：compat 插件只声明这五个；工具类不要写 `compat`。

14. **1 级不能有 `output_byte`，2–3 级必须返回 0**
    现象：`plugin.wasm ... 导入不符合该等级`，或 `wasm_error`。
    原因：1 级只有整数返回值，编译期就拒绝 `output_byte`；2–3 级非 0 返回码被当失败。
    做法：1 级删掉输出导入；2–3 级 `run` 结尾 `i32.const 0`。

15. **state 只在完整输出通过校验后才保存**
    现象：返回了 `{text, state}` 但下次调用 state 还是旧的；或者 `action` 写错后 state 没动。
    原因：宿主先校验整个输出（含 state 本身），再落库；非法输出、授权失效、取消都不会写。
    做法：把 state 当成「这次调用成功才生效」；省略表示不修改，给了就完整替换，≤8 KiB。

16. **`lastBot` 是受控投影，不是历史记录**
    现象：想从 `lastBot` 拿整条记录或更早的对话，字段不全。
    原因：它只有 `{text, at, targetId}` 或 `null`，是本会话最后一条助手回复；`now` 是宿主时间戳。
    做法：需要更多上下文就用 `dataAccess: ["chat.history"]` 拿 `history`，或自己用 state 记摘要；时间优先用 `now`（`chat.received@1`、`chat.handle@1` 的输入没有 `now`，见 `protocol.md` §3.4 的例外）。

17. **改设置会让授权代次变化**
    现象：用户在设置里改了一个值，上一轮排队的结果被丢弃，插件像重启了一次。
    原因：授权绑定设置快照，改设置即重签；旧代次的结果按失效处理。
    做法：处理器要容忍「刚启用/刚改设置」的冷启动；不要假设上一轮的内存或排队结果还在。

18. **插件数据目录没有配额，也没有清理保证**
    现象：插件往 `process.cwd()` 里越写越多，几个月后占了很大空间；或者以为卸载会顺手清掉。
    原因：数据目录在插件安装目录下的 `data`（进程 `cwd` 就是它）。注册表 `limits` 里没有任何数据目录配额，CLI 也没有清数据目录的命令；卸载只回收清单、入口、`settings.json`、授权与安装包，**不递归删插件自己写的文件**（宿主有意避免删除链接目标或用户文件），更新同 id 也不清 `data`。所以「有没有上限」「卸载会不会清」都不能假设。
    做法：长期数据自己限大小（单文件上限、条目数上限、超限就停写并在返回值里说明），并在 README 写清清理方式（比如设置里加一个「清空数据」的工具动作，或让用户手删）。不要把删数据写进 `app.stop@1`——撤权之后不保证收到它（第 17 条、`protocol.md` §3.5）。

19. **`chat.received@1` 是每条消息触发一次，代价按消息条数乘**
    现象：处理器里同步读写一整个 JSON 或发一次网络请求，小群没事，大群把回复拖慢甚至超时。
    原因：消息通过宿主基础检查（且没被静音）后，每条都会 observe 一次；`executionTimeoutMs` 只按单次调用算，不按「每秒多少条」算。observe 失败只记日志，不会告诉你「拖慢了」。
    做法：先做便宜过滤再动 I/O——`message.chatType`、群白名单、`atMe`/`replyToBot`、必要时文本长度；写盘改成追加一行或按小时分桶，别每次重写整份文件；重活（汇总、调模型）交给 `task.tick@1` 批量做。不要把「必须准确」的逻辑只放在这里：这条通道失败会被静默丢弃。
