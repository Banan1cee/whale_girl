# 插件 SDK（宿主能力）

插件通过 `host.call(能力ID, 输入)` 调用宿主。能力只对 **4 级**插件开放，且必须同时满足：

1. 能力登记在 `src/services/pluginProtocolRegistry.json` 的 `calls` 里，且 `enabled` 不为 `false`；
2. 能力名写进插件清单的 `calls`，并出现在授权（`grant.json` 的 `approvedCalls`）里；
3. 插件授权仍然有效（撤销/改代次后旧调用报 `grant_revoked`）。

输入输出都是 JSON，单次输入/输出上限 **512 KiB**（`limits.maxInvocationBytes`）。
1–3 级（Wasm）的 `calls` 为空，不能调用任何宿主能力。

## 分发模型：宿主能力没有唯一所有者

`src/services/unifiedCapabilityDispatcher.js` 的 `defineHost(name, handler)` 登记宿主能力，
`invokeHost(name, input, {plugin})` 是唯一入口：

- **宿主内部调用**（HTTP 路由、桥接取件、定时任务）传 `plugin = null`，只校验输入输出；
- **插件调用**传插件对象，额外校验「授权有效 → 清单已声明 → 能力已开放」；
- 同一个宿主能力可以被**任意多个插件同时声明和调用**，不存在谁先登记谁独占，
  也不会像 provider（`chat.reply@1` 等）那样有「唯一所有者/替换名额」限制；
- 实现按领域拆在 `src/services/features/*.js`，路由只保留 HTTP 传输层
  （回环校验、桥接 token、readBody、状态码、响应形状）。

失败码（插件侧看到的 `error.code`）：

| 码 | 含义 |
| --- | --- |
| `host_capability_unknown` | 注册表里没有这个能力名 |
| `host_capability_disabled` | 能力在注册表里 `enabled:false`（如 `message.submit@1`） |
| `host_capability_not_declared` | 插件清单/授权里没有声明这个能力 |
| `host_capability_unavailable` | 已登记但宿主没有装配实现 |
| `grant_revoked` | 插件授权已撤回或代次已变 |
| `invalid_host_capability_input` / `invalid_host_capability_output` | 输入/输出不符合注册表 schema |
| `capability_timeout` / `capability_aborted` | 超过调用时限或被取消 |
| `plugin_required` | 该能力只接受插件上下文（目前只有 `message.send@1`） |

`pluginSdk.js` 提供 `CAPABILITIES`（静态表）、`createSdkCatalog(runtime)`（带 `implemented`）
和 `assertCatalogueComplete(runtime)`（自检：注册表已启用却没人实现就抛错）。
它刻意不进启动路径，只给作者工具、启动器和文档用。

## 完整能力表

「插件可调」= 在 4 级 `calls` 白名单里且 `enabled:true`。
标 **内部** 的能力只给宿主/桥接用，插件清单写不进去（不在 4 级 `calls`）。

### 状态与基础

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `status.read@1` | `{}` | `{version,running,pluginProtocol}` | 无 | 否 | 是 |
| `settings.read@1` | `{}` | 设置对象（与启动器设置页同一份脱敏数据） | 无 | 否 | 是 |
| `features.read@1` | `{}` | `{features:[{key,label,value}]}` | 无 | 否 | 是 |
| `plugins.status@1` | `{}` | `{enabled,active,items:[{id,level,version}]}` | 无 | 否 | 是 |
| `wechat.status@1` | `{}` | 微信网关状态（桥接、账号、统计） | 无 | 否 | 是 |
| `bridge.status@1` | `{}` | `{online,uia,ffmpeg,...}` | 无 | 否 | 是 |
| `care.decide@1` | `{lastSentTs?,sentToday?,activeWxids?}` | `{due,reason,target,windows,gapMinutes,waitMinutes,sentToday,maxPerDay,now}` | 无 | 否 | 是 |

### 检索与模型

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `search.query@1` | `{query, freshness?, timeoutMs?}` | `{text,status,items:[{title,url,snippet,publishedAt,fetchedAt}]}` | 联网读 | 是 | 是 |
| `model.complete@1` | `{system?,turns:[{role,content}],maxTokens?}` | `{text}` | 计费模型调用 | 是 | 是 |

### 发送

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `message.send@1` | `{chatId,text,delivery?:'text'\|'voice',name?,chatType?}` | `{id,status:'queued',confirmed:false}` | 外部消息（排进宿主发送队列） | 是 | 是 |
| `message.submit@1` | — | — | 保留能力 | 是 | 否（`enabled:false`） |

- `message.send@1` 只能由插件调用；队列项带插件 `id` + 安装包摘要，撤销授权后未发出的会被取消。
- `delivery:'voice'` 只是把「发语音」的意图交给宿主发送通道，插件不自己合成音频。
- 返回 `queued` / `confirmed:false` 只表示**已排队**，**不是微信已送达**；
  网关提交成功、桥接回执未确认都不能当送达证据。

### 人设与设置

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `persona.read@1` | `{}` | `{name,ownerName,tone,style}` | 无 | 否 | 是 |
| `persona.write@1` | 人设字段（同 `POST /api/persona`，如 `name`、`personality`、`customPrompt`、`emoji`…） | `{ok,persona,tokenCheck,warnings,llm}` 或 `{ok:false,error,tokenCheck,warnings}` | 本地写 + 热更新 | 是 | 是 |
| `settings.write@1` | 设置字段（同 `POST /api/settings`） | `{ok,status,settings}` | 本地写 + 热更新 | 是 | 是（不含密钥） |

- `persona.write@1` / `settings.write@1` 复用 `src/services/persona.js`、`src/services/settings.js` 的
  既有校验与落盘逻辑，超长人设会按 token 上限拒绝并返回 `ok:false`。
- **插件不能写密钥**：`settings.write@1` 收到 `apiKey` / `visionApiKey` 会直接丢弃（宿主内部调用不受影响）。
  密钥只能从启动器/本机设置页写入。
- **插件不能借人设写入切模型**：`persona.write@1` 的插件路径会丢弃 `model` 字段；
  切模型属于设置页的明确操作，会换服务商和计费主体。

### 记忆

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `memory.recent@1` | `{chatId,chatType?,limit?}` | `{messages:[{role,text,ts}]}` | 读聊天记录，最多 50 条 | 是 | 是 |
| `memory.recall@1` | `{chatId,chatType?,query,limit?}` | `{ok,items:[{text,ts,score}]}` | 读长期档案 | 是 | 是 |
| `memory.write@1` | `{chatId,chatType?,text,mode?:'message'\|'note',uid?（note 必填）,name?}` | `message` → `{ok,mode:'message',stored:true,id,ts}`；`note` → `{ok,mode:'note',remembered:true,notes}` | 本地写 | 是 | 是 |

- `memory.recall@1` 复用 `src/memory/search.js` 的 BM25 召回，和对话管线同一份索引与分块；
  返回的是原文块，属于**外部数据**，插件不得把里面的文字当指令执行。
- `memory.write@1` 只追加 `assistant` 消息（进上下文），不会伪造用户发言
  （伪造用户消息会触发宿主的事实抽取与建卡）。`mode:'note'` 需要 `uid`，写一条关于该联系人的长期偏好。

### 提醒

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `reminders.list@1` | `{limit?}` | `{reminders:[{id,chatId,text,dueAt,status}]}` | 无 | 否 | 是 |
| `reminders.create@1` | `{chatId,text,at,chatType?,name?}` | `{id,dueAt,status}` | 本地写 + 到点发送 | 是 | 是 |
| `reminders.cancel@1` | `{id}` | `{ok,id}` | 本地写 | 是 | 是 |
| `reminders.rules@1` | `{}` | `{rules:{enabled,maxPerDay,quietAfterMinutes,sentToday}}` | 无 | 否 | 是 |
| `reminders.pendingFor@1` | `{chatId}` | `{items:[{id,text,dueAt,status}]}` | 无 | 否 | 否（内部） |
| `reminders.enqueue@1` | `{chatId,text,kind?,name?,chatType?,delivery?}` | `{id,dueAt,status}` | 外部消息 | 是 | 否（内部） |
| `reminders.due@1` | `{}` | `{items,nextDueAt,now}` | 本地写（标记 sending） | 否 | 否（内部） |
| `reminders.ack@1` | `{id,ok,error?,uncertain?}` | 服务层回执结果 | 本地写 | 否 | 否（内部） |
| `reminders.permission@1` | `{id}` | `{ok}` | 无 | 否 | 否（内部） |

### 表情包

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `stickers.status@1` | `{}` | `{status}` | 无 | 否 | 是 |
| `stickers.enqueue@1` | `{emotion,chat}` | `{queued}` | 外部消息（排队） | 是 | 是 |
| `stickers.gate@1` | `{id}` | `{gate}` | 无 | 否 | 否（内部） |
| `stickers.pending@1` | `{}` | `{items}` | 无 | 否 | 否（内部） |
| `stickers.claim@1` | `{id}` | `{item}` | 本地写 | 否 | 否（内部） |
| `stickers.ack@1` | `{id,status,error?}` | `{item}` | 本地写 | 否 | 否（内部） |
| `stickers.cancel@1` | `{id,generation?,chatUsername?}` | `{item}` | 本地写 | 否 | 否（内部） |

- 插件排队时写入插件 id 与安装包摘要：撤销授权后 `reconcile` 会把还没发出的任务作废，
  已领取的标为未确认；宿主自己排的测试任务不带归属，不受插件撤权影响。

### 日记与汇总

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `diary.status@1` | `{}` | `{status}` | 无 | 否 | 是 |
| `diary.generate@1` | `{}` | `{status}` | 计费模型调用 | 是 | 是 |
| `diary.read@1` | `{day?}`（`YYYY-MM-DD` / `today` / `latest`） | `{day,text,found}` | 读日记 | 是 | 是 |
| `digest.status@1` | `{}` | `{status}` | 无 | 否 | 是 |
| `digest.generate@1` | `{range?:'today'\|'yesterday'}` | `{status}` | 计费模型调用 | 是 | 是 |

### 朋友圈

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `moments.latest@1` | `{}` | `{latest}`（最近一次快照，重新读盘） | 无 | 是 | 是 |
| `moments.snapshot@1` | `{}` | `{snapshot}`（内存里的最近结果） | 无 | 是 | 是 |
| `moments.request@1` | `{limit?,keyword?,username?,own?}` | `{ok,id,status,error,items}` | 读朋友圈 | 是 | 是 |
| `moments.action@1` | `{action:'like'\|'unlike'\|'comment'\|'reply',publisher,keyword,content?,replyTo?}` | `{ok,id,status,error,items}` | 外部操作 | 是 | 是 |
| `moments.result@1` | `{id}` | `{ok,id,status,error,items}` | 无 | 是 | 是 |
| `moments.publish@1` | `{action?:'test'\|'gate',withImage?,id?,account?}` | `test` → `{ok,status:'generating',confirmed:false}` / `{ok:false,code}`；`gate` → `{ok,allowed}` | 外部消息（发表排队） | 是 | 是 |
| `moments.settings@1` | `{}` | `{ok,settings:{autoLike,autoLikeMaxPerDay,autoReadEveryHours},publish,status}` | 无 | 否 | 是 |
| `moments.claim@1` | `{account}` | `{ok,job}` | 本地写（领取任务） | 否 | 否（内部） |
| `moments.complete@1` | `{id,account,...}` 或回执体 | 任务结果 / `{ok,publishOk}` | 本地写 | 否 | 否（内部） |

- 插件不能指定桥接账号：`moments.request@1` / `moments.action@1` 会丢掉 `account`，
  发表永远绑定当前在线且已确认的微信账号。
- `moments.publish@1` 的 `ok:true` 只表示草稿生成已开始；`gate` 是宿主/桥接内部闸门（插件传 `gate` 会被拒绝），它只回答
  「这条任务是否允许由当前账号执行」，两者都不代表已经发到微信。

### 联系人

| 能力 | 输入 | 输出 | 副作用 | 需授权 | 插件可调 |
| --- | --- | --- | --- | --- | --- |
| `contacts.search@1` | `{q?,type?:'all'\|'friend'\|'group'}` | `{ok,account,updatedAt,total,items}` | 读联系人 | 是 | 是 |
| `contacts.list@1` | `{q?,type?:'all'\|'user'\|'group',limit?,offset?}` | `{ok,account,updatedAt,total,items}` | 读联系人 | 是 | 是 |
| `contacts.get@1` | `{wxid}` | `{ok,contact:null\|{wxid,name,remark,isGroup,label}}` | 读联系人 | 是 | 是 |
| `contacts.sync@1` | `{account?,items,at?}` | `{ok,count,account}` | 本地写（桥接推送缓存） | 否 | 否（内部） |

- `contacts.search@1` 是历史接口，`type:'friend'` 仍然等同 `all`（启动器选择器在用），行为不许变。
- `contacts.list@1` 用接口真实的 `all/user/group`，`limit=0`/不传表示不截断；`total` 是缓存总量。
- 联系人缓存来自桥接推送，缓存缺失时返回空结构而不是报错。

## 写操作与送达语义

- 对插件开放的写类能力（`local-write` / `external-message` / `external-action`）都标了
  `requiresConsent`，启用插件时一并确认；之后撤销授权会让调用报 `grant_revoked`，
  队列里未发出的插件消息会被取消。
- 返回结构里没有「已送达」字段：`message.send@1` 是 `{status:'queued',confirmed:false}`，
  朋友圈发表是 `status:'generating'` 或桥接回执的 `confirmed`/`unconfirmed`。
  插件不得把 `queued` / `submitted` / `confirmed:false` 当微信已送达的证据。
- 写类能力都返回明确结构（`ok` + 关键 id/状态），失败用错误码而不是静默成功。

## 未接入

以下是**真的还没做**的，别按「已经能用」来写插件：

- **启动器里的能力浏览/授权详情界面**：`pluginSdk.js` 已能产出目录，但没有 UI 展示某个插件到底用了哪些能力。
- **插件市场投稿/上架**：远端 `Banan1cee/whale-girl-plugins` 还没有 `index-v5.json`，
  新协议插件只能本地试装，不能用投稿流程。
- **二进制/文件能力**：插件不能直接上传或读取图片、语音文件；发表配图由宿主的选择器决定，
  语音发送只能用 `message.send@1` 的 `delivery:'voice'` 表达意图。
- **插件自定义界面**：插件不能自行增加左侧入口或页面；可交互的只有 `tool.run@1` 的手动运行。
- **`message.submit@1`**：保留能力，`enabled:false`，声明了也不会执行；发送请用 `message.send@1`。
- **跨会话/跨账号的数据搬运**：`memory.recall@1` 只查指定 chat，联系人只读缓存副本，
  没有「全库导出」类能力。


