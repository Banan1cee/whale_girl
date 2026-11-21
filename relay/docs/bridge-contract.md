# 微信桥接 ↔ relay 兼容契约

本文件回答一个问题：**bridge/（Python，只读上游）到底会对内核发哪些 HTTP 请求，relay 必须怎样回应才不会让它静默降级。**

依据是上游源码本身（`D:/whale-girl/bridge/`，与本 worktree 的 `bridge/` 同一份；下文的行号以 2026-11-21 这版为准），不是推测。内核对端的行为以 `src/http/routes/*.js`、`src/adapters/gateway.js` 为准。`relay/lib/compat.js` 就是按这些事实实现、由 `relay/tests/compat.test.js` 逐条锁住的。

---

## 0. 一句话结论

- 桥接一共会调 **20 个接口、21 处调用点**（vision 有两个调用点）。
- 真正影响业务的只有 6 个：`GET /healthz`、`POST /webhook/wechat`、`POST /api/wechat/send-permission`、`POST /api/vision`、`GET /api/care/due`、`POST /api/bridge/heartbeat`；其余是聊天之外的控制面，**必须有稳定回应，否则刷失败日志或功能停摆**。
- **回复必须写在 `POST /webhook/wechat` 的这一次 HTTP 响应里**：桥接没有异步推送通道（详见 §4.3）。
- `GET /healthz` 必须同时有 `ok:true`、`up:true`、`service:'whale-girl'` 三个字段，少一个桥接等 30 秒后**直接退出、不启动**。
- `POST /api/wechat/send-permission` 是**唯一的发送闸门**：不是 200 + `ok:true` + `allowed:true` 时，桥接会静默放弃发送（日志 10 分钟节流一次）。

---

## 1. 桥接 → 内核调用清单（20 个接口 / 21 处）

`base` = `bot_url` 去掉 `/webhook` 后缀；`bot_url` 默认 `http://127.0.0.1:<port>/webhook/wechat`，可用环境变量 `WHALE_BOT_URL` 覆盖（`bridge/config.py:55-66`）。

| # | 方法 路径 | 调用点 | 鉴权 | 请求 | 超时 | 期望响应 | 失败/降级行为 |
|---|---|---|---|---|---|---|---|
| 1 | GET `/healthz` | `config.py:77`（`wait_for_server`，启动时一次） | 无 | 无 | 每次 3s，最多约 30 次 | 200 且 `{ok:true, up:true, service:'whale-girl'}` | 30 秒等不到 → 打印「先在启动器点启动」并 `return 2`，**桥接进程退出** |
| 2 | POST `/webhook/wechat` | `receiver_mixin.py:789` | `x-whale-bridge: 1` + `x-bot-token`（配置了才带） | 见 §2 | `(10, None)`：连接 10s，**读超时无限** | 200 + JSON `ok:true`；`action:'reply'` 且有 `reply` | 非 200 → 记日志不回复（401/403 提示 token）；`ok!==true`/无 reply → 记「鲸鲸没接话」不发送 |
| 3 | POST `/api/wechat/send-permission` | `sender_mixin.py:427`（`send_policy_allows`，每次发送前；每气泡一次，引用/兜底路径会再调） | `x-whale-bridge` + `x-bot-token` | `{chatId, name}` | 3s | 200 + `{ok:true, allowed:true|false, reason?}` | 超时/非 200/`ok!==true`/`allowed!==true` → 本条发送直接放弃，日志 60s 节流「发言范围：内核未确认允许发送，已暂停」 |
| 4 | POST `/api/bridge/heartbeat` | `loop_mixin.py:392`（启动后每 20s） | 同上 | `{platform,uia,rest,listener,ffmpeg,account,account_wxid,account_nick,account_ok,account_why,account_guard,window}` | 8s | 任意 2xx；body 不解析（`raise_for_status`） | 第 1/3/10/60… 次失败各 warn 一次；桥接继续跑 |
| 5 | POST `/api/wechat/contacts/sync` | `loop_mixin.py:476`（启动时后台一次） | 同上 | `{account, at, items:[{wxid,name,remark,isGroup}], ≤5000 条}` | 15s | 200 即成功；body 不解析 | 只记日志「不影响收发消息」 |
| 6 | POST `/api/vision` | `receiver_mixin.py:406`（长截图 1~3 段）、`:508`（表情） | **无任何 header / token** | `{image: base64, mime, prompt}` | 120s | JSON；图片只读 `text`，表情要求 `ok` 非 false | 图片：失败 → 用占位文本继续走 webhook（会回一句「没取到图」）；表情：失败 → 整条消息不回话 |
| 7 | GET `/api/care/due` | `loop_mixin.py:50`（每 60s，仅 `care.enabled` 开时） | **无 token** | query `last=<ms>, sentToday=<n>, active=<逗号分隔 wxid>` | 15s | 读 `due`；false 时 `reason`；true 时 `target.{wxid,name,isGroup}` | 异常/非 JSON → 节流日志，60s 后再试 |
| 8 | GET `/api/care` | `loop_mixin.py:75`（`due=true` 后） | 无 | query `chat=<wxid>` | 40s | 读 `text`（空 = 不搭话） | 记日志，跳过这一轮 |
| 9 | POST `/api/care/sent` | `loop_mixin.py:105`（发送成功后回传，最多 3 次） | token | `{id(uuid), chat, text, group}` | 15s | 读 `ok` | 只 warn「已发送但写入上下文失败」，不重发 |
| 10 | GET `/api/reminders/due` | `reminder_watch.py:108`（经 `KernelApi`） | token | 无 | 10s（默认） | **必须 2xx + JSON 对象 + `ok===true`**，读 `items`、`nextDueAt(ms)` | 抛 `KernelApiError` → 每轮（≤30s）记「提醒调度出错」，提醒停摆 |
| 11 | POST `/api/reminders/ack` | `reminder_watch.py:105` | token | `{id, ok, error, uncertain?}` | 10s | `ok:true` | 本进程最多 3 次簿记重试；不重发微信正文 |
| 12 | POST `/api/reminders/permission` | `reminder_watch.py:85` | token | `{id}` | 3s | 读 `ok` 布尔 | false → 这条插件提醒不发 |
| 13 | GET `/api/stickers/gate` | `sticker_mixin.py:54`（仅 `features.stickers` 开） | token | query `id` | 3s | `{ok, enabled, generation, jobs:[{id,status,generation}]}` 全要 | 视为关闭/代际过期 → 取消发送 |
| 14 | POST `/api/stickers/claim` | `sticker_mixin.py:203` | token | `{id}` | 3s | `{ok:true, item:{id,generation,status:'sending',chat,chatUsername,path}}` | 领不到 → 不发送 |
| 15 | POST `/api/stickers/ack` | `sticker_mixin.py:218` | token | `{id, status, error}` | 8s | 200/404/409 均视为成功结束 | 节流日志，不影响已发出的消息 |
| 16 | POST `/api/stickers/cancel` | `sticker_mixin.py:237` | token | `{id, generation, chatUsername}` | 3s | `ok:true` + `item.status='cancelled'` 且 id/generation/chatUsername 匹配 | 记 `unconfirmed`，无副作用 |
| 17 | GET `/api/stickers/pending` | `sticker_mixin.py:257`（每 5s，仅总开关开时） | token | 无 | 3s | `{ok:true, items:[]}` | 关闭分支不会走到 |
| 18 | POST `/api/moments/claim` | `moments.py:73`（**启动即跑，每 5s 一次，无条件**） | token | `{account}` | 8s | 读 `job`；null = 没任务 | 非 200 → 继续每 5s 轮询（状态变化时才记一条日志） |
| 19 | POST `/api/moments/publish-gate` | `moments.py:95`（领到 publish 任务后） | token | `{id, account}` | 3s | `allowed===true` 才发 | false/异常 → 取消发表（`publishedStatus:'unconfirmed'`） |
| 20 | POST `/api/moments/complete` | `moments.py:123` | token | `{id, account, items 或 publishStatus/error}` | 8s | 200（状态码） | 非 200 → 状态变化时记一条日志 |

补充：
- 上表 `KernelApi`（`bridge/runtime_kernel_api.py`）会把**任何非 2xx、非 JSON、非对象、`ok!==true`** 都变成异常，所以 10~12 是最严格的一类；`send-permission`、`heartbeat`、`contacts/sync` 是手写请求，宽松一些。
- 桥接**没有**调用 `/api/status`、`/api/chat`、`/api/settings`、`/api/reminders`（列表）等启动器接口；这些不是兼容层义务。
- `GET /api/care/due` 与 `GET /api/care` 在桥接里**不带 token**，所以 relay 不能对它们做 token 校验（否则主动搭话全挂）。`POST /api/vision` 同理。

---

## 2. 入站 webhook 契约（桥接 → relay）

来源：`receiver_mixin.py:783`（payload 组装）、`:785-789`（headers/发送）。

### 2.1 字段

| 字段 | 类型 | 桥接是否总带 | 语义 / 实际取值 |
|---|---|---|---|
| `chat_id` | string | 是 | 微信会话 id：群为 `<xxx>@chatroom`，私聊为 `wxid_...`。**不是昵称/备注**，relay 不要拿去当显示名。 |
| `chat_type` | string | 是 | 只有 `'group'` / `'private'` 两种。 |
| `user_id` | string | 是 | 发送者 wxid；取不到时 `'unknown'`。 |
| `senderId` / `sender_id` | string | 是 | 与 `user_id` 相同（冗余，兼容内核的别名解析）。 |
| `senderName` / `nickname` | string | 是 | 发送者昵称/群名片；取不到时群聊 `'群友'`、私聊 `'微信好友'`。 |
| `text` | string | 是（空则不发） | 已经过桥接预处理（见 §2.3），**可能含换行**（连发合并）。 |
| `msg_id` | string | 是 | `<chat_id>:<shard>:<local_id>`；连发合并时 `local_id` 是多个 id 用 `|` 连接（如 `a|b|c`）。去重唯一键。 |
| `at_me` | boolean | 是 | 是否 @ 了她。**私聊恒为 false**（`mention.analyze` 在私聊传入空名字表）；群聊才是真判据（显示名/别名/账号昵称备注/群昵称，或 `atuserlist` 结构化证据）。 |
| `mentioned_names` | string[] | 是 | 这条消息 @ 到的其他人（最多 8 个，已剔除她自己、「所有人/全体成员」和群名）。私聊为空数组。 |
| `self_names` | string[] | 是 | 她当前可能被叫到的名字（人设名/别名/账号昵称/备注），已剔除 wxid/账号目录。群聊「没 @ 但叫了名字」的场景用。 |
| `chat_title` | string | 是 | 群名；私聊为 `''`。 |

**必填建议**：`chat_id`、`text`、`msg_id` 三个必须有；`chat_type` 决定群/私聊；其余给得越全，前台上下文越准。桥接实际总是在有 `text` 时才发，所以 relay 收到空 `text` 可以按 `ignore` 处理。

不会出现的字段：`token`（走 header）、`no_reply`、`reply_to_bot`、`data:{...}` 包装、`chatTitle` 等 camelCase 变体。relay 只需要读上面这张表。

### 2.2 `msg_id` 语义

- 由 `username:shard:local_id` 拼成，`shard` 是微信数据库分片，`local_id` 是库内消息 id。**同一条消息重试时 id 不变**，因此去重按整串比较（`relay/lib/relay.js` 已按 30 分钟 TTL 去重）。
- 连发合并（`merge_text_batch`，`receiver_mixin.py:901`）：同一个人连续纯文本会被合成**一条** webhook，`text` 用 `\n` 连接，`msg_id` 的 `local_id` 变成 `id1|id2|...`。relay 不能假设 `msg_id` 里只有两个 `:` 或只有一个 `|`。
- 桥接自己不会重发 webhook；重复只可能来自上游重试/人为重放，所以去重是防御性的。

### 2.3 特殊消息在 `text` 里长什么样

| 微信侧 | 桥接处理 | 发给 relay 的 `text` | 是否仍会发 webhook |
|---|---|---|---|
| 普通文本 | 修乱码；群消息去掉 `wxid_xxx:` 前缀 | 原文 | 是 |
| 连发多条文本 | 合并 | `行1\n行2…`，`msg_id` 含 `|` | 是 |
| 图片 | 下载/转码（wxgf→jpg）+ `/api/vision` | `（对方发了一张图片，图里是：<识别文本>）` | 是 |
| 图片（vision 关闭/取不到） | 占位 | `（对方发了一张图片，但这边没取到、也看不清。不要编造…）` | 是（占位文本按 msg_id 查重） |
| 语音 | 本地 ASR（不经 relay） | `（对方发了一条语音，说的是：<文字>）` | 识别成功才发；失败/超时/`voice.enabled=false` → **整条不发** |
| 表情/动画表情 | 本地解码 + `/api/vision` | `（对方发了一个表情包，画面是：<描述>）` | 识别成功才发；失败 → **整条不发** |
| 引用回复 | 解析 XML | `（引用<被引用者>「<原话>」）<这次打的字>`（多层引用最多再剥 2 层） | 有可读内容才发 |
| 链接/卡片 | 提 `<title>`/`<url>` | `分享了一个链接：<title> <url>` | 有 url 才发 |
| 视频号卡片 / finderfeed | 装死 | — | 否 |
| 被移出群 | 标记会话 | — | 否 |
| 拍一拍 | 跳过 | — | 否 |
| 系统通知 / 白名单外 / 过期消息 | 跳过 | — | 否 |

---

## 3. 出站 reply 契约（relay → 桥接）

来源：`receiver_mixin.py:790-895`。桥接只读下面这些字段，其它字段会被忽略。

### 3.1 字段

| 字段 | 类型 | 桥接读法 | 必须/建议 |
|---|---|---|---|
| `ok` | **boolean** | `data.get('ok') is not True` → 记「接口返回异常，未发送回复」并 return | **必须严格 `true`**（`1`/字符串不算） |
| `action` | string | 必须 `== 'reply'`；否则记「鲸鲸没接话」并 return | **必须 `'reply'`** |
| `reply` | string | 必须真值；是 `bubbles` 缺失/为空时的兜底；`str(data['reply'])` | **必须非空** |
| `bubbles` | string[] | 非数组 → `[reply]`；过滤掉非字符串和空白项；过滤后为空 → `[reply]`；逐个发送 | 可选，强烈建议给（见 §3.2） |
| `mention` | string | 群里第一条消息用真 @；正文若以 `@名字` 开头会先去前缀再发，@ 失败回退普通文本并补 `@名字` | 可选；只在 `chat_type='group'` 生效 |
| `stickerOnly` | boolean | `true` → 只发 sticker、不发文字（`features.stickers` 开时才处理） | 可选；**为 true 时必须带 `sticker`**，否则桥接直接 return（客户什么都收不到） |
| `sticker` | object | `{id, generation, chatUsername, …}`；开关打开时先 `/api/stickers/claim` 再发 | 可选；relay 不实现表情包就不会出现 |
| `separateText` | boolean | `true` → 跳过语音回复决策（文字照发） | 可选；relay 不需要 |
| `commandType` | string | 有值时跳过语音回复；`admin_spell` 时不做引用回复 | 可选；relay 不需要 |
| `error` | 任意真值 | 有值时跳过语音回复（文字照发），日志标 skip | 可选 |
| `mock` | boolean | `true` 时只在日志里提醒一次「服务端是演示模式」 | 可选 |
| `skipped` | string | `== 'adapter_disabled'` 时记「微信网关未开启」并 return | 只对内核网关有意义；relay 不要返回 |
| `outbound` | object | **不读** | 不要为它费心 |
| `reason` | string | 仅用于日志（`鲸鲸没接话：… 原因=…`） | 可选，建议给 |

### 3.2 `bubbles` 元素结构与限制

- **元素必须是字符串**；空串/纯空白/非字符串都会被丢掉。全部被丢掉时退回 `[reply]`。
- 每个元素 = **一条独立的微信消息**，桥接按顺序逐条调用 `send_text`，每条之间固定 `sleep(0.6)`。第一条可选引用（`wechat.quoteReply=true` 时）或真 @（`mention`）。
- 每条气泡都会各自过一次 `/api/wechat/send-permission`（`send_policy_allows` 在 `send_text` 内部），所以气泡越多，控制面请求越多。
- **桥接侧没有条数上限、也没有单条长度截断**；限制来自内核/人设的拆分策略：`chat.privateMaxChars`（默认 140，范围 20~4000）、`chat.groupMaxChars`（默认 70）、`chat.maxBubbles`（默认 2，范围 1~12）。
- relay 当前（`relay/lib/relay.js`）只返回 `{ok, action, reply}`，`reply` 由 `cleanForWeChat` 截到 `orders.maxReplyChars`（默认 1200），**没有 `bubbles`** → 桥接会把它当**一条 1200 字的消息**发送。后台零焦点通道按字符打字（默认 ~40ms/字），一条 1200 字的消息光是输入就要约 48 秒，远超普通回复的体感，也更容易触发桥接的发送看门狗/预算判断。建议 relay 按 `chat.groupMaxChars/privateMaxChars` 拆成 2~4 条 `bubbles`，单条控制在 100~200 字。

### 3.3 硬约束：回复必须在这一个 HTTP 响应里

确认过源码：桥接**没有**入站 HTTP 服务或异步推送消费端。
- 唯一 `listen` 是 `app.py:49` 的单实例锁 socket（只 bind 不处理业务）。
- 发送链路全在 `receiver_mixin.on_message_inner` 的同一个请求栈里：`LOCAL_HTTP.post(bot_url, timeout=(10, None))` 拿到响应后，才按 `bubbles` 逐条发。
- 因此：
  1. relay **不能**先回 200、再异步把回复发到别处——桥接不监听任何地址；
  2. 也**不能**分多个 HTTP 响应（桥接一次只读一个响应体）；
  3. 多段表达只能用 `bubbles` 数组，或文字 + `sticker` 字段；
  4. relay 任何异常路径都**必须**最终写一个合法 JSON（`relay/lib/relay.js` 已用 `FALLBACK_REPLY` 兜底，正确做法）。
- 桥接读超时为 `None`（`timeout=(10, None)`）：relay 不响应，**该会话的处理线程会永久阻塞**，同一会话后续消息全部排队；其它会话仍并发（默认 `wechat.pipelineWorkers=4`）。只有重启桥接才能恢复。所以 relay 的每一轮都必须有超时兜底并写响应。

---

## 4. features / config 开关的真实键名与关闭后的行为

桥接读的是同一份 `config.json`（`gateway.wechat.inboundToken` 等），热更新由 `loop_mixin.config_watch` 每 5 秒查 mtime。下表键名以 `bridge/runtime_config.py` 为准（与内核 `src/infra/configSchema.js` 一致）。

| 配置键 | 桥接常量/读取处 | 默认 | 关掉后是否还会调用对应接口 |
|---|---|---|---|
| `gateway.wechat.inboundToken` | `runtime_config.inbound_token` → `x-bot-token` | `'change-me-wechat'` | 空 token 时桥接只打警告、不带头；relay 若配了 `bridgeToken` 必须与它一致，否则 403（发送静默全停） |
| `care.enabled` | `CARE_ENABLED`（`runtime_config.py:97`） | `true` | **false 时不请求** `/api/care/due`、`/api/care`、`/api/care/sent`（线程仍每 60s 醒一次，直接 continue） |
| `care.onlyMaster` / `care.allowGroups` / `care.allowOthers` | `CARE_*`（:98-100） | true/false/false | **桥接侧已不参与判定**（3.9 起判定只在服务端）；改它们不会减少/增加调用 |
| `care.quietAfterMinutes` | `CARE_QUIET_MIN` | 20 | 只决定 `/api/care/due` 的 `active` 参数（最近活跃会话），不改变是否调用 |
| `features.stickers` | `STICKER_TEST_ON`（:102） | `false` | **false 时 /api/stickers/* 一次都不调**（不轮询 pending、忽略 webhook 里的 sticker/stickerOnly） |
| `sticker.collectReceived` | `STICKER_COLLECT`（:103） | false | 只决定是否本地保存收到的表情原图，无接口 |
| `voice.enabled` | `VOICE_ENABLED`（:105） | true | 只控本地 ASR（第三方服务商，不经 relay）。关闭时语音消息识别为空 → **整条消息不会发 webhook** |
| `wechat.quoteReply` | `QUOTE_REPLY`（:87） | false | 只控本地 UIA 引用回复，无 relay 接口；开启后每次引用发送会多一次 `send-permission` |
| `wechat.backgroundSend` / `wechat.bgSend.*` | `BACKGROUND_SEND`/`BG_SEND`（:88-89） | true | 本地发送通道，无 relay 接口 |
| `wechat.keyboardFallback` | `KEYBOARD_FALLBACK`（:88） | true | 本地兜底发送通道，无 relay 接口 |
| `wechat.accountGuard` | `ACCOUNT_GUARD`（:92） | true | 本地账号闸，无 relay 接口 |
| `wechat.pipelineWorkers` / `pipelineQueueLimit` | 调度参数 | 4 / 8 | 决定 webhook 并发数与单会话积压；relay 必须能扛多会话并发 |
| `chat.messageSettleMs` / `chat.groupMaxBatchWaitMs` | 批次合并窗口 | 1500 / 5000 | 影响连发合并（`text` 多行、`msg_id` 含 `|`） |
| `wechat.ignoreSenders` / `dbDir` / `account` / `windowHwnd` / `staleAfterSec` | 本地 | — | 无 relay 接口 |
| `moments.*` | **桥接无开关** | — | `MomentsReader` 启动即运行（`app.py:346`），**每 5s** `POST /api/moments/claim`，无论配置如何 |
| `reminder.enabled` | **桥接无开关** | — | `REMINDER_RUNNER` 启动即运行（`app.py:309`），`GET /api/reminders/due`：有下一条时睡到点，否则 30s 一轮 |
| `features.*` 其它 | relay 不认 | — | 与桥接无关 |

结论：**不要用「关掉 moments/reminders」来假设桥接不再请求**——它照发；只有 `features.stickers` 和 `care.enabled` 能真正让桥接停止对应调用。

---

## 5. `relay/lib/compat.js` 的覆盖表

`createCompat({ config }).handle({method, path, query, body, headers})` → `{status, json}` 或 `null`（不认领，交给 server.js 404）。

| 方法 路径 | compat 响应 | 桥接侧效果 |
|---|---|---|
| GET `/healthz` | 200 `{ok:true,up:true,service:'whale-girl'}` | 通过 `wait_for_server` |
| POST `/api/wechat/send-permission` | 200 `{ok:true,allowed:true}`；`config.owner.paused` 或 `RELAY_PAUSED=1/true` 时 `{ok:true,allowed:false,reason:'paused'}` | 允许/暂停发送（人工接管） |
| POST `/api/bridge/heartbeat` | 200 `{ok:true,online:true,serverTime}` | 桥接在线状态 |
| POST `/api/wechat/contacts/sync` | 200 `{ok:true,count,account,updatedAt}` | 启动器联系人选择器（relay 不使用） |
| POST `/api/vision` | 200 `{ok:false,error:'vision disabled'}` | 图片走占位文本；表情整条跳过 |
| GET `/api/care/due` | 200 `{ok:true,due:false,reason:'disabled',target:null,…}` | 不主动搭话 |
| GET `/api/care` | 200 `{ok:true,text:''}` | 不生成搭话 |
| POST `/api/care/sent` | 200 `{ok:true}` | 无副作用 |
| GET `/api/reminders/due` | 200 `{ok:true,items:[],nextDueAt:0}` | 提醒线程每 30s 空转，不发提醒 |
| POST `/api/reminders/ack` | 200 `{ok:true,item:null}` | 无 |
| POST `/api/reminders/permission` | 200 `{ok:false}` | 插件提醒不发 |
| POST `/api/moments/claim` | 200 `{ok:true,job:null}` | 每 5s 空转 |
| POST `/api/moments/publish-gate` | 200 `{ok:true,allowed:false}` | 发表取消 |
| POST `/api/moments/complete` | 200 `{ok:true}` | 无 |
| GET `/api/stickers/gate` | 200 `{ok:true,enabled:false,generation:'disabled',jobs:[]}` | 表情包关闭 |
| GET `/api/stickers/pending` | 200 `{ok:true,items:[]}` | 无任务 |
| POST `/api/stickers/claim` / `ack` / `cancel` | 200 `{ok:true,item:null}` | 不发送 |
| 其它 `/api/care*`、`/api/moments*`、`/api/stickers*`、`/api/reminders*` | 200 `{ok:true,disabled:true}` | 永不 500/404 |
| 未知路径、`POST /webhook/wechat` | `null` | server.js 404；webhook 由 `relay/lib/relay.js` 产生回复 |

鉴权：`config.bridgeToken` 非空时，对上表里「桥接会带 token」的接口（send-permission、heartbeat、contacts/sync、care/sent、reminders*、stickers*、moments*）按内核规则校验（header `x-bot-token`/`x-bot-signature`、query `token`、body `token/verify_token/signature` 任一匹配），失败 403。`/healthz`、`/api/vision`、`/api/care/due`、`/api/care` 不校验（桥接本来就不带 token）。`bridgeToken` 留空时完全不校验（本地演示）。

**与内核的有意偏差**（都写在代码注释里）：
1. 关闭功能返回「200 + ok/空数组」而不是内核的 404——桥接对 404 只会反复记失败日志，功能仍然是停的。
2. `/api/vision` 关闭态固定 200 `ok:false`（内核真失败时可能 4xx/5xx）；契约要求不得 500。
3. `bridgeToken` 为空时不校验（内核 `verifyToken` 对空 token 一律拒绝）。本机 relay 默认无 token，如果照搬内核行为，桥接会 403 → 静默停发。
4. `/api/bridge/heartbeat` 不校验 `platform`（内核未知平台返回 404）；桥接永远发 `wechat`。
5. `POST /webhook/wechat` 不认领：回复必须由 `relay.js` 生成，compat 不产生业务回复。

---

## 6. 坑与风险（按严重度）

**P0（缺了就整条链路不可用）**

1. `/healthz` 三字段严格匹配，任何字段缺失/类型不对（`up:'true'` 也不行）都会让桥接等 30 秒后**退出**。启动顺序必须 relay 先起、桥接后起（桥接只在启动时等一次）。
2. `send-permission` 是硬闸且只等 3 秒：relay 里绝不能在这条路径上做任何慢操作（模型调用、磁盘大 IO）。不是 `200+ok+allowed` 时桥接**静默停发**，日志 600 秒才一条，排查极难。已实测 paused 时返回 `allowed:false` 是唯一该出现的 `false`。
3. `webhook` 必须同步给 `action:'reply'` + 非空 `reply` + 严格 boolean `ok:true`；读超时无限，relay 挂住会永久卡住该会话（同会话串行），只有重启桥接能恢复。relay 的兜底回复是对的，不要改成 204/空 body。
4. bridge 日志节流默认 600 秒（`engine.log_throttled`）：联调时一次失败后 10 分钟内看不到第二次，容易误判「桥接没调用」。看 `data/bridge.log` 时注意被折叠计数。

**P1（影响体验/成本）**

5. relay 现在只回 `reply`（无 bubbles、最长 1200 字）：单条长消息在零焦点通道逐字输入很慢（~40ms/字），建议拆 2~4 条短气泡，单条 100~200 字。
6. `at_me` 在**私聊恒为 false**：relay 若用 `at_me` 判断「要不要回」，私聊会全部不回。正确做法：私聊默认回，群聊才看 `at_me`（或 `mentioned_names`/`self_names`）。
7. `relay/lib/relay.js` 目前不区分 `chat_type`、也不看 `at_me`：群里任何消息（哪怕没 @ 她）都会触发前台/工人一轮，成本与打扰都会放大。要不要收紧是产品决策，但至少不要把它误当成「桥接已经过滤过」。
8. 群消息 `mention`：要给**群昵称/显示名**，不要给 wxid；@ 失败桥接会退回普通文本（并在正文前加 `@名字`），不会丢消息。
9. 连发合并会把多条文本合成一条 `text`（含换行）和含 `|` 的 `msg_id`；前台提示词和去重都要能处理，不能假设一行一条。

**P2（噪音/局部功能）**

10. `GET /api/reminders/due` 若 404：桥接每 ≤30 秒记一条「提醒调度出错」（不节流），提醒功能缺失但不影响聊天；compat 已兜底。
11. `POST /api/moments/claim` 若 404：桥接每 5 秒请求一次、只在状态变化时记日志；compat 已兜底。
12. `/api/vision` 没有 token，但请求体最大约 11MB（8MB 图片 base64；长截图会切成 1~3 段逐个发）；`relay/server.js` 的 `MAX_BODY=32MB` 够用，但反向代理/别的壳若有更小 body 限制会截断成 400 → 图片降级为占位文本。
13. token 不一致：403 → 桥接按 token 不匹配处理，所有发送静默失败。`relay/config.json → bridgeToken` 必须等于桥接 `config.json → gateway.wechat.inboundToken`（或两边都留空做本地演示）。
14. `stickerOnly:true` 不带 `sticker`：桥接直接 return，客户收不到任何东西。relay 若以后接表情包，这两个字段必须成对出现。
15. `/api/care/due`、`/api/care` 不需要 token：relay 如果对全部 `/api/*` 强制校验，会先把主动搭话/识图打死。compat 已按接口区分。

**启动顺序/联调注意**

16. `WHALE_BOT_URL` 决定 `base`：`http://127.0.0.1:8790/webhook/wechat` → healthz 是 `http://127.0.0.1:8790/healthz`。relay 端口改了要同步改桥接环境变量。
17. 桥接启动时若 `data/server-port.txt` 存在会优先用里面的端口（内核遗留机制）；relay 没有这个文件，桥接会退回 `config.server.port`。用 `WHALE_BOT_URL` 最稳。
18. **离线假 CLI**：`relay/config.json → dsh.command` 只接受一个可执行文件路径（不会按命令行拆分参数），假 CLI 要用 `runTurn({command, argsPrefix})` 注入，或把它包装成 `.cmd` 再填进去。

---

## 7. 实测数据（2026-11-21，本机 Windows，Node v22）

方法：临时 config（`bridgeToken` 用测试值、state 放系统临时目录）+ 真实 `relay/server.js`（端口 18790），用 Node `fetch` 按桥接相同的 header/body/query 打点；每个端点重复 5~50 次，取平均/p95/max。桥接侧的超时值来自 §1 表。

| 端点 | 次数 | 平均 | p95 | max | 响应体 | 形状 |
|---|---|---|---|---|---|---|
| GET /healthz | 50 | 1.40ms | 1.86ms | 39.02ms | 44B | `{ok:true,up:true,service:'whale-girl'}` |
| POST /api/wechat/send-permission | 50 | 0.74ms | 0.95ms | 3.19ms | 26B | `{ok:true,allowed:true}` |
| POST /api/bridge/heartbeat | 20 | 0.73ms | 0.92ms | 0.99ms | 52B | `{ok:true,online:true,serverTime}` |
| POST /api/wechat/contacts/sync（200 条） | 10 | 1.04ms | 1.17ms | 1.17ms | 69B | `{ok:true,count:200,account,updatedAt}` |
| POST /api/vision（1MB base64） | 5 | 8.12ms | 9.42ms | 9.42ms | 38B | `{ok:false,error:'vision disabled'}` |
| GET /api/care/due | 20 | 0.46ms | 0.62ms | 1.12ms | 144B | `{ok:true,due:false,reason:'disabled',…}` |
| GET /api/care | 20 | 0.40ms | 0.62ms | 0.65ms | 34B | `{ok:true,text:'',mock:false}` |
| POST /api/care/sent | 10 | 0.93ms | 1.18ms | 1.18ms | 11B | `{ok:true}` |
| GET /api/reminders/due | 20 | 0.48ms | 0.65ms | 1.07ms | 56B | `{ok:true,items:[],nextDueAt:0,now}` |
| POST /api/reminders/ack | 10 | 0.61ms | 0.77ms | 0.77ms | 23B | `{ok:true,item:null}` |
| POST /api/reminders/permission | 10 | 0.94ms | 1.12ms | 1.12ms | 12B | `{ok:false}` |
| POST /api/moments/claim | 20 | 0.74ms | 1.02ms | 1.26ms | 22B | `{ok:true,job:null}` |
| POST /api/moments/publish-gate | 10 | 0.86ms | 1.21ms | 1.21ms | 27B | `{ok:true,allowed:false}` |
| POST /api/moments/complete | 10 | 0.86ms | 0.99ms | 0.99ms | 11B | `{ok:true}` |
| GET /api/stickers/gate | 10 | 0.54ms | 0.65ms | 0.65ms | 61B | `{ok:true,enabled:false,generation:'disabled',jobs:[]}` |
| GET /api/stickers/pending | 10 | 0.59ms | 0.89ms | 0.89ms | 22B | `{ok:true,items:[]}` |
| POST /api/stickers/claim/ack/cancel | 各 10 | 0.64~0.96ms | ≤1.99ms | 1.99ms | 23B | `{ok:true,item:null}` |
| GET /api/moments/latest（前缀兜底） | 1 | 0.75ms | — | — | 27B | `{ok:true,disabled:true}` |
| GET /api/status（未知路径） | 1 | 0.67ms | — | — | 53B | 404 `{ok:false,error:'not found',path}` |

- 全部契约接口 p95 < 2ms；唯一例外是 1MB vision 请求体（~8~9ms，主要是读 body + JSON 解析，桥接自己的超时是 120s，余量极大）。
- 暂停开关实测：另起一个 `RELAY_PAUSED=1` 的 relay，`POST /api/wechat/send-permission` 返回 `{"ok":true,"allowed":false,"reason":"paused"}`，`/healthz` 仍正常。
- 真实 webhook 探测（relay + dsh 启动但缺模型 Key）：`200 {ok:true,action:'reply',reply:'刚卡了一下，我确认完马上回你。'}`，耗时约 2.5 秒（其中 ~2.4s 是 dsh 进程启动 + 失败，不是 relay 本身）；同 `msg_id` 重放 → `{ok:true,action:'ignore'}`，约 5ms。说明：**桥接只依赖 `ok/action/reply` 三个字段，没有 `bubbles` 也能正常发送**（会当一条消息）。
- 常驻请求量：heartbeat 每 20s、care/due 每 60s、moments/claim 每 5s、reminders/due 每 30s（无任务时）→ 约 0.45~0.5 req/s；单请求 <1ms，对 relay 无压力。

---

## 8. 怎么复现

- 单元测试：`node relay/tests/compat.test.js`（35 个用例，覆盖本文 §1/§3/§5 的每个字段与状态码、paused 与环境变量现读、token 三种携带方式、畸形输入不抛异常、关闭功能绝不 500）。
- 端到端 HTTP 打点：用临时 config 起 `RELAY_CONFIG=... node relay/server.js`，再按 §7 的 header/body 用 `fetch` 访问；不要用真实 token，本仓库不提交探测脚本。
- 真实桥接联调：先用 `curl http://127.0.0.1:8790/healthz` 确认三字段，再设 `WHALE_BOT_URL=http://127.0.0.1:8790/webhook/wechat` 启动桥接；微信里发一条私聊消息，relay 日志应出现 `webhook 完成 action=reply`。
