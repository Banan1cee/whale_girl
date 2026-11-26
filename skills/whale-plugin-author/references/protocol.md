# whale-plugin/1 协议要点

事实源：宿主 `src/services/pluginProtocolRegistry.json`（等级、清单白名单、扩展点、宿主能力、schema、限额）。市场仓库的 `protocol.json` 是它的副本；两者冲突时以宿主注册表为准，并把差异报给维护者。

## 1. 等级

入口格式决定等级，不能自选。

| 等级 | runtime | 入口 | 扩展点 | calls |
| --- | --- | --- | --- | --- |
| 0 | `theme-data` | `theme.json` | 无（纯数据主题） | 必须 `[]` |
| 1 | `wasm-restricted` | `plugin.wasm` | `tool.run@1` | 必须 `[]` |
| 2 | `wasm-restricted` | `plugin.wasm` | `tool.run@1` | 必须 `[]` |
| 3 | `wasm-restricted` | `plugin.wasm` | `tool.run@1`、`chat.received@1`、`chat.pre_reply@1`、`chat.prompt@1`、`chat.before_send@1`、`chat.reply@1` | 必须 `[]` |
| 4 | `node-full` | `plugin.js` | `tool.run@1`、`chat.received@1`、`chat.pre_reply@1`、`chat.prompt@1`、`chat.before_send@1`、`chat.reply@1`、`chat.generate@1`、`chat.handle@1`、`chat.search@1`、`task.tick@1`、`chat.dispatched@1`、`app.start@1`、`app.stop@1` | 38 项（§4） |

- 1 级：`run` 返回整数就是结果。
- 2–3 级：`run` 必须返回 `0`，结果通过 `output_byte` 写 UTF-8；2 级工具收到原始文本，3 级聊天能力收到 JSON 信封（§6）。
- 4 级：Node，完整系统权限（不是沙箱），回调签名见 §3.1。

## 2. 清单（plugin.json）

必需键：`format`（固定 `"whale-plugin/1"`）、`level`、`id`、`name`、`author`、`version`、`minAppVersion`、`description`、`entry`、`runtime`、`provides`、`calls`。

可选键：`maxAppVersion`、`appEpoch`、`appCompatibility`、`dataAccess`、`settingsSchema`、`executionTimeoutMs`、`compat`。

- 清单是**严格**的：出现白名单外的键、重复键、非 UTF-8、超 32 KiB，整包拒绝。
- `id`：`^[a-z][a-z0-9-]{0,47}$`，不能是 Windows 保留名（`con`/`prn`/`aux`/`nul`/`com1`…）。
- `name` ≤80 字符、`author` ≤80 字符（去掉首尾空白后不能为空）、`description` ≤600 字符。
- `version`/`minAppVersion`：3–4 段数字（`1.0.0` 或 `4.3.0.1`）；`minAppVersion` 是宿主版本下限。
- `entry`/`runtime` 必须与等级一致（见 §1）。
- `executionTimeoutMs`：100–120000，默认 30000。
- `provides`：能力 ID → `{"mode": "...", "scope": "..."}`；`task.tick@1` 另可带 `intervalSeconds`（1–86400）。不能有其他键。
- `calls`：宿主能力 ID 数组，不得重复，且必须是**该等级**允许的名单（4 级见 §4）。没写的不能调。
- `dataAccess`：只允许 `chat.history`/`model.prompt`，且只有 3/4 级可写；写了就必须在 `provides` 里声明至少一个「声明了数据访问」的 `chat.*` 能力，否则 `manifest_data_access_invalid`。

### 2.1 settingsSchema

JSON Schema 子集，根必须是 `object`，深度 ≤8，只允许这些关键字：`type`、`properties`、`required`、`additionalProperties`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`title`、`description`。

- 类型只允许 `object`/`string`/`integer`/`number`/`boolean`。
- `title` ≤40 字符、`description` ≤200 字符，不能含控制字符或双向文本标记；`title` 不能是空串。
- **没有 `default`**：设置了也不会被接受，宿主不注入默认值，代码里自己兜（`settings.x ?? 默认`）。
- 安装时设置初值是 `{}`，必须先满足 schema；用 `required` 卡一个没人填过的字段会让插件装上就不可用，所以默认值走代码而不是 `required`。
- 设置上限 64 KiB；改设置会让授权代次变化，旧代次上排队的结果会被丢弃。

### 2.2 授权与确认

- 0 级：启用即应用，没有执行体也没有授权确认。
- 1–2 级：启用即写授权，没有额外确认。
- 3 级：声明会读当前消息的聊天能力（`chat.received@1`、`chat.pre_reply@1`、`chat.prompt@1`、`chat.before_send@1`、`chat.reply@1`）时，启用需要确认「聊天访问」；只声明 `tool.run@1` 不需要。
- 4 级：启用要逐项确认「完整系统权限」（Node 不是沙箱）；`calls` 里 `requiresConsent: true` 的能力会在确认框里逐项列出；写了 `dataAccess` 也会披露具体数据范围。**4 级不再单独要「聊天访问」确认**：observe/gate/enhance 读当前消息（含 `chat.received@1` 拿到的每一条消息）都由这一项「完整系统权限」整体覆盖，`trial` 输出的 `chatConsentRequired` 因此对 4 级恒为 `false`（它只对 3 级计算）。真正逐项列出、要你单独同意的只有 `calls`。
- 授权绑定安装包摘要、清单/入口字节、授权代次与设置快照：改设置、换版本、停用再启用都会换代次，旧代次上还没回来的调用结果会被丢弃。

### 2.3 message 子对象

`message` 是宿主投影出来的固定结构，不是原始微信消息：

`platform`（≤24）、`chatType`（`private`/`group`）、`chatId`（≤120）、`senderId`（≤120）、`senderName`（≤80）、`text`（≤16000）、`atMe`、`replyToBot`、`msgId`（≤200）、`chatTitle`（≤160）。

`message` 还有一个可选子字段 `mentionedNames`：≤4 个名字，每个 ≤40 字符，只有名字没有 id，空数组表示没在叫别人。它只出现在下面这些能力的 `message` 里（`chat.generate@1`、`chat.search@1` 的 `message` 由宿主另行精简构造，没有它）：

| 额外字段 | 只在这些扩展点上出现 |
| --- | --- |
| `mentionedNames` | `chat.pre_reply@1`、`chat.prompt@1`、`chat.before_send@1`、`chat.reply@1`、`chat.received@1`、`chat.dispatched@1`、`chat.handle@1` |

所有输入输出都是 `additionalProperties: false`：多给字段与少给必填字段一样会被判不合契约。

## 3. 扩展点（provides）

| 扩展点 | mode | scope | 输入 | 输出 | 什么时候被调用 |
| --- | --- | --- | --- | --- | --- |
| `tool.run@1` | tool | manual | 任意 JSON | 任意 JSON | 卡片「设置 → 运行一次」；单插件触发 |
| `chat.received@1` | observe | all | `message`, `localWechat`, `state` | {}（空对象） | 宿主基础检查（去重/禁言/静音/白名单）通过后、触发判定前；返回值丢弃 |
| `chat.pre_reply@1` | gate | all | `message`, `localWechat`, `state`, `now`, `lastBot` | `action`, `reason`, `state` | 触发判定之后、生成之前；多个提供者按插件 id 顺序问 |
| `chat.prompt@1` | enhance | all | `system`, `message`, `history`, `state`, `now`, `lastBot` | `system`, `state` | system 组装完成、生成之前 |
| `chat.before_send@1` | enhance | all | `message`, `text`, `state`, `now`, `lastBot` | `text`, `state` | 回复草稿已确定、`finalize` 之后，交给网关之前 |
| `chat.reply@1` | observe/enhance/replace | all | `message`, `text`, `system`, `history`, `output`, `state`, `now`, `lastBot` | `text`, `state` | 草稿生成后、`before_send` 之前 |
| `chat.generate@1` | replace | all | `message`, `system`, `turns` | `text` | 决定要回之后，替代本轮整段生成 |
| `chat.handle@1` | replace | all | `localWechat`, `message` | `action`, `reply`, `bubbles`, `mention`, `reason` | 整段接管：插件自己决定回不回、回什么 |
| `chat.search@1` | replace/enhance | all | `message`, `previous` | `text`, `items`, `status` | 普通回复的搜索阶段（宿主原生联网可用时不会走到） |
| `task.tick@1` | schedule | all | `scheduledAt`, `now`, `settings` | 任意 JSON | 按 `intervalSeconds` 周期调用 |
| `chat.dispatched@1` | observe | all | `message`, `text`, `action`, `sent`, `reason` | {}（空对象） | 发送或忽略之后；失败只记日志 |
| `app.start@1` | observe | all | `at`, `settings` | {}（空对象） | 运行时装配完成时（listen 之前）；运行中新启用/重签的插件在 reconcile 周期内补发一次 |
| `app.stop@1` | observe | all | `at`, `settings` | {}（空对象） | 正常停机时；只发给本进程通知过 start 且授权仍有效的插件 |

### 3.1 各 mode 的语义

- `replace`：同一能力同一 scope 只能有一个提供者，第二个直接 `capability_owner_conflict`（在调用任何插件之前就判）。
- `enhance`：按插件 id 顺序依次执行，每个拿到原始输入 + 上一层结果（`chat.search@1` 叫 `previous`，其余叫 `output`），返回完整新输出。失败时只有 `sideEffect` 为 `none`/`network-read` 的能力会退回上一层继续，其余把错误交给宿主。
- `observe`：按 id 顺序执行，返回值丢弃，失败只记日志。
- `gate`：按 id 顺序执行，`pass` 继续问下一个；第一个非 `pass` 生效并结束。插件报错/超时按 `pass` 处理（fail-open）；要「不回」必须显式返回 `skip`。
- 4 级 Node 回调签名：`(input, ctx) => output`；`ctx` = `{ host, signal, settings, state }`，`host.call(能力, 输入)` 只对清单 `calls` 里声明过的能力有效，`signal` 是 AbortSignal，`settings` 是授权时的设置快照（**不填默认值**），`state` 见 §3.3。

### 3.2 dataAccess：system、history 与 generate 的 turns

- 只有 `chat.prompt@1`、`chat.reply@1`、`chat.before_send@1`、`chat.generate@1` 的输入带会话上下文，**每个插件按自己的 `dataAccess` 单独发放**：要读或改 `system` 声明 `["model.prompt"]`；要读会话历史声明 `["chat.history"]`。3 级和 4 级同一规则。
- `chat.generate@1` 的会话内容放在必填数组 `turns` 里（每项 `{role, content}`，≤100 条），**不是 `history`**；同一个 `chat.history` 授权同时控制它。没授权时 `turns` 被清空成 `[]`：`turns` 是 schema 必填字段，不能整段删除，保留 `[]` 是为了不改变输入形状、让未授权的 replace 生成仍能运行；`message` 照常发放，授权后才拿到完整 turns。
- 没声明的提供者仍会被调用，但输入里没有 `system`/`history`（`chat.generate@1` 是 `turns: []`），enhance 信封里上一层结果中的同名字段也被删除；它返回的 `system`/`history` 会被宿主按字段换回上一层值（上一层没有就删掉）。所以未授权插件既读不到也改不动，**也无法用空字符串清空提示词**。
- `now`/`lastBot` 不受 `dataAccess` 裁剪：它们只在这四个聊天能力（`chat.pre_reply@1`、`chat.prompt@1`、`chat.before_send@1`、`chat.reply@1`）的输入里发放；`chat.generate@1`、`chat.handle@1` 的输入没有这两个字段。`lastBot` 本身就是宿主收口后的受控投影（见 §3.4）。
- 返回不合输出 schema（例如缺必填 `system`）会报 `invalid_capability_output`，`chat.prompt@1` 这类 `sideEffect: none` 的能力按失败降级，保留上一层提示词。
- 清单只接受旧词 `model.prompt`/`chat.history`；运行时也接受 `system-prompt`/`conversation-history` 作为等价授权，但作者写旧词最稳。

### 3.3 state：插件 × 会话的跨轮状态

- **可写**的只有 `chat.pre_reply@1`、`chat.prompt@1`、`chat.before_send@1`、`chat.reply@1` 这四个能力的输出。
- `chat.received@1` 的输入 schema 里确实有可选 `state` 字段（§3 表格按 schema 列出来了），但它在 received 上**拿不到也写不回**：宿主只给上面四个能力注入 `state`（received 的输入里没有这个字段、`ctx.state` 是 `undefined`），而 received 的输出 schema 是 `empty-object`（`{"type":"object","properties":{},"required":[],"additionalProperties":false}`），多给任何字段都会按 `invalid_capability_output` 判失败、结果只记日志丢弃。所以 observe 不能用来计数或记状态，要跨轮记忆只能写插件数据目录（`gotchas.md` 第 4、18 条）。
- **输入** `state` 由宿主注入（首次 `{}`），作者只读；**输出**里省略 `state` 表示不修改，给出普通对象表示完整替换；超 8 KiB、非对象或输出其他字段不合契约时整次调用按 `invalid_capability_output` 处理，且这次 `state` 不保存。
- 作用域：插件安装包摘要 × `platform`/`chatType`/`chatId`；同 id 更新（包摘要变化）从空状态开始，跨平台同 chatId 不串。单插件最多 200 个会话，超出按最近最少使用淘汰。
- 停用/卸载/更新会清除（这是内存里的 `state`，不是插件数据目录里的文件）；内核重启后丢失。需要长期数据就写插件数据目录，边界见 `gotchas.md` 第 18 条。

### 3.4 now 与 lastBot

- `now`：宿主毫秒时间戳，只出现在上述四个带 state 的聊天能力里；不要自己 `Date.now()`，否则和宿主时间/时区不一致。
- **例外**：`chat.received@1`、`chat.handle@1` 的输入**没有 `now`**（注册表 `chat.received.input@1`、`chat.handle.input@1` 的字段表里都没有它），这两处需要时间只能用本机 `Date.now()`，并在 README 的「已知限制」里写明：时间取自插件进程所在机器的时钟与时区，和宿主时间可能有偏移。同样，凡是输入里没有 `now` 的能力（`chat.generate@1`、`chat.search@1`）都按这条处理。
- `lastBot`：宿主内本会话最后一条助手回复的受控投影，`{text, at, targetId}` 或 `null`；`text` ≤4000、`targetId` 是当时被回复的发送者 id（≤120），三个字段都必填。它不是整条数据库记录，也不是跨会话历史；没有上一条回复时是 `null`。

### 3.5 各能力的额外约束

- `chat.pre_reply@1` 的 `action` 只能是 `pass`/`skip`/`wake`，`reason` ≤80；`wake` 能让本来不回复的消息开口，`pass` 保持宿主原判定。
- `chat.reply@1`：`replace` 独占；`observe` 拿不到改写权；`enhance` 的上一层结果在 `output`。
- `chat.handle@1`：`action:'reply'` 时 `reply` 必须非空（空串会被判 `invalid_capability_output`）；`bubbles` 只是建议，宿主会重新拆气泡并套字数上限与安全兜底；`mention` 交给桥接，失败会退回普通文本。
- `chat.generate@1`：`text` 为空会让宿主把本轮按忽略收尾（不发消息）。
- `chat.search@1`：输出必须同时有 `text`、`items`、`status`；`items` 每项是 `{title, url, snippet, publishedAt?, fetchedAt?}`，`status` 取 `ok`/`empty`/`failed`。
- `task.tick@1`：输入里的 `settings` 就是授权时的设置；没有 `state`，每次调用都是新进程。
- `app.start@1` / `app.stop@1`：`payload` 都是 `{at, settings}`，`settings` 是授权时的快照，返回值丢弃、失败只记日志，改不了启动/停机结果。
  - `app.start@1` 在运行时装配完成时触发（当前实现里 **listen 之前**）：不要假设端口/网络已经可用；此时需要宿主数据只能走已声明的 `host.call`。
  - 同一授权快照只通知一次；用户运行中启用插件或改设置（换了授权代次）后，由宿主现有的 reconcile 周期（约 500ms）补发一次。单次失败不会自动重试，要等下一个授权快照。
  - `app.stop@1` 只在正常停机时发，且只发给本进程确实通知过 start、授权仍然有效的插件；宿主会等所有 stop 回调完成后再终止插件 worker，重复停机不会重复通知。
  - **撤权优先**：停用/卸载/更新/改设置后旧授权快照立即失效，宿主不会再补 start，也不会对旧快照执行 stop。所以**撤权之后不保证插件收到 `app.stop@1`**，只保证不再运行它的旧代码。不要用 stop 来做「必须执行」的清理（比如解绑外部账号），清理要幂等并在下次 start 时自愈。
  - 两次回调是各自独立的进程调用，模块变量不跨 start/stop 共享；要留状态就写插件数据目录。

## 4. 宿主能力（calls，只有 4 级能声明）

注册表里共 51 项能力，但 4 级清单**只能声明下面 38 项**（不在名单里的写在 `calls` 会让清单校验失败）。按风险分组，声明越少越安全。

- 只读、无副作用：`status.read@1`、`settings.read@1`、`features.read@1`、`persona.read@1`、`reminders.list@1`、`reminders.rules@1`、`stickers.status@1`、`care.decide@1`、`digest.status@1`、`plugins.status@1`、`moments.snapshot@1`、`moments.result@1`、`moments.settings@1`、`wechat.status@1`、`bridge.status@1`
- 读隐私数据（需在启用确认里逐项同意）：`memory.recent@1`、`memory.recall@1`、`contacts.search@1`、`contacts.get@1`、`contacts.list@1`、`diary.status@1`、`diary.read@1`、`moments.latest@1`、`moments.request@1`
- 联网或计费：`search.query@1`（联网）、`model.complete@1`、`digest.generate@1`、`diary.generate@1`（计费）
- 写入或外发：`message.send@1`、`persona.write@1`、`settings.write@1`、`memory.write@1`、`reminders.create@1`、`reminders.cancel@1`、`stickers.enqueue@1`、`moments.action@1`、`moments.publish@1`
- 保留不可用：`message.submit@1`（可以声明，调用永远得到 `host_capability_disabled`）

- 不能在 `calls` 里声明的 13 项（注册表有、但当前等级不开放，写了会 `manifest_calls_invalid`）：`reminders.enqueue@1`、`reminders.due@1`、`reminders.ack@1`、`reminders.permission@1`、`reminders.pendingFor@1`、`stickers.gate@1`、`stickers.pending@1`、`stickers.claim@1`、`stickers.ack@1`、`stickers.cancel@1`、`moments.claim@1`、`moments.complete@1`、`contacts.sync@1`。

- `message.send@1`：输入 `{chatId, text, delivery?, name?, chatType?}`；`delivery:"voice"` 是让宿主用文本合成语音发，不能上传音频文件；返回 `{id, status:'queued', confirmed:false}` 只表示已排队，真正能不能发还要过宿主发送策略（禁言/白名单/额度）。
- `message.submit@1`：注册表里 `enabled:false`，可以写进 `calls` 但永远不执行，调用会得到 `host_capability_disabled`。
- 宿主能力失败时插件拿到的是统一错误码（见 `testing.md`，例如 `host_call_failed`），不要按内部实现分支。

## 5. 限额

| 键 | 限额 |
| --- | --- |
| `maxPackageBytes` | 16 MiB |
| `maxManifestBytes` | 32 KiB |
| `maxEntryBytes` | 8 MiB |
| `maxSettingsBytes` | 64 KiB |
| `maxInvocationBytes` | 512 KiB |
| `maxInstalledPlugins` | 16 |
| `maxConcurrentInvocations` | 2 |
| `maxQueuedInvocations` | 32 |
| `maxCallsPerInvocation` | 64 |
| `maxConcurrentCallsPerInvocation` | 8 |
| `minExecutionTimeoutMs` | 100 |
| `maxExecutionTimeoutMs` | 120000 |

- 入口大小按等级收紧：0 级 64 KiB、1–3 级 512 KiB（见 §1 与注册表 `levels`）。
- 单次调用指一次 provider 调用：输入和输出各自 ≤`maxInvocationBytes`；`state` 另有 8 KiB 上限。
- KiB / MiB 按 1024 进制。

## 6. Wasm 入口（1–3 级）

- 导出 `run() -> i32`，导入集合只允许模块名 `whale_plugin`（或旧别名 `whale`）下的 `input_size()`、`input_byte(i)`、`output_byte(i)`（1 级不含 `output_byte`）。
- 1 级：**不能导入 `output_byte`**，`run` 的整数返回值就是结果。
- 2–3 级：`run` 必须返回 `0`，结果通过 `output_byte` 逐字节写出 UTF-8；2 级 `tool.run@1` 收到用户输入的原始文本（不是 JSON）。
- 3 级聊天能力收到信封：`{"capability": "...", "input": {...}, "settings": {...}, "state": {...}}`；输出是按该能力 schema 的 JSON。
- `compat: "api3"`（只限 3 级）：改用旧信封 `{api:3, hook, message, now, lastBot, state, settings, decision, text?, system?, history?}`，输入字段直接摊平在信封顶层，返回 `{action|text|system, state?}` 由宿主投影到新 schema。hook 名映射：`chat.pre_reply@1`→`chat.pre_reply`、`chat.prompt@1`→`chat.prompt`、`chat.reply@1`→`chat.reply`、`chat.before_send@1`→`chat.before_send`、`chat.received@1`→`chat.received`（**旧宿主本来就派发过同名 `chat.received` hook**，这里不是新造名字：已实现该 hook 的旧字节码照常收到调用，未实现的收到未知 hook 应自行忽略；返回值一律按 observe 丢弃）。声明了 `tool.run@1` 的 compat 插件会在运行时报错，`compat` 只能服务这五个聊天能力。
- 本仓库不附带 WAT 编译工具链；写 Wasm 需要作者自备（如 `wat2wasm`）。能用 4 级解决的任务不要仅为「更安全」硬做 Wasm——4 级的权限确实更大，但 1–3 级拿不到宿主能力。

## 7. 市场侧

- 市场目录由 `scripts/build-index.js` 生成，作者只提交 `plugins/<id>/` 与 `packages/<id>-<version>.zip`，不要手改 `index*.json`。
- 同一 id 不能同时出现在旧 Api 目录与 `index-v5` 里；迁移时沿用 id 才能保留老用户设置。
- 包内 `plugin.json` 必须与源码 `plugins/<id>/plugin.json` 逐字节一致（含 BOM/换行），所以永远用打包脚本，不手改 ZIP。
