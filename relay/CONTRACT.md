# relay 目录契约（设计与分工的唯一准绳）

本文件是 `relay/` 的实现契约。所有实现必须按此接口对齐；改动接口先改本文件并在 PR 说明里写清。

## 1. 目标

把 whale-girl 换成一个"接单员工"：

- **前台 AI**（desk）：唯一对客户说话的角色。收需求、澄清、报价只转述老板口径、转达进度、转达问题时一次问全。
- **干活 agent**（worker）：DeepSeek Harness 的 session，真正写代码/出方案，只和前台说话，不直接对客户。
- **中继**（relay）：微信桥接（`bridge/`）与本项目之间的 HTTP 服务。桥接只认 `WHALE_BOT_URL`，所以 relay 顶替 `src/` 内核的位置。

前台与 worker 都用 `dsh headless` 的**持久 session**：每轮一个进程，`--session-id` 续接。session 落在
`~/.dsh/sessions/<workspace>`，可在 DeepSeek Harness 桌面端的对应工作区里打开查看完整对话（含思考与工具调用）。

## 2. 运行形态

```
微信 ── bridge/（不改） ──HTTP──> relay/server.js ──spawn──> dsh headless（前台 session）
                                      │                        └─ 返回纯文本
                                      └──spawn──> dsh headless（worker session，cwd=订单工作区）
```

- 默认端口 `8790`（`relay/config.json → port`，或环境变量 `RELAY_PORT`）。
- 零 npm 运行时依赖、CommonJS、Node ≥ 18。测试用 `node relay/tests/xxx.test.js` 逐文件跑。
- 状态根目录 `relay/state/`（gitignore），可用 `RELAY_STATE` 覆盖。

## 3. 状态布局

```
relay/state/
  desk/                        前台 session 的 cwd（一个工作区，多个客户只是不同 session）
  orders/index.json            { "ord-20261121-1a2b": {status, chatId, sessionId, createdAt, updatedAt} }
  orders/<orderId>/order.json  订单元数据（单一读写点）
  orders/<orderId>/order.md    需求/验收/口径的单一事实来源（前台与 worker 都读）
  orders/<orderId>/thread.md   给人和 GUI 看的对话记录（前台轮次 + worker 轮次）
  orders/<orderId>/events.jsonl 结构化事件（入站、轮次开始结束、状态变更）
  orders/<orderId>/worker.jsonl worker 的原始 NDJSON 事件（审计用）
  orders/<orderId>/workspace/  worker 的 cwd（workspace-write 边界）
  orders/<orderId>/deliverables/ worker 交付物
```

订单状态机：`intake`（前台澄清）→ `working`（worker 干活）→ `delivered`（已交付）。
`intake → working` 的放行由 `config.json → orders.confirmMode` 决定：
`frontdesk`（前台标记即放行，演示用）/ `owner`（老板在微信发 `#确认 <orderId>` 才放行，生产用）。

## 4. 模块接口（谁调用谁、返回什么）

### relay/lib/sdk.js —— 常驻 DSH 运行时（一个工作目录一个进程）

为什么不是 headless：headless 是「一轮一个进程」，进程退出后再想给它补充信息只能重开一轮。
SDK 运行时是常驻的，一个进程里能开很多 session，而且 `session/prompt` 走的是 `agent.followup()`，
可以在工人干活期间继续往里排消息（下一轮开始前送到），这是「客户中途插话」的实现基础。

协议：stdio 上按换行分帧的 JSON-RPC 2.0。

```js
resolveRuntime(configDsh) -> { command, args, source, profile }
createRuntime({ cwd, model, dsh, resolved, log }) -> {
  start(),                                  // spawn + initialize（provider=deepseek-official）
  prompt(sessionId, text, permission, { resume }),   // 排入一条用户消息；resume=true 先 session/resume
  waitTurn(sessionId, turnBefore, timeoutMs),        // 等「这一轮结束」，返回 boolean
  state(sessionId),                          // { running, turn, step, lastTool, lastAssistant, lastReason, injected }
  close(), request(method, params)
}
```

事件词表（`session.event` 里 event.type）：`turn/start`、`step/start`、`assistant/message`、
`tool/call`、`tool/result`、`turn/end`、`agent/inbox/spliced`、`session/title`；
状态走 `session.status {sessionId, status:'running'|'idle'}`。

模型：API key 路由只认 `deepseek-flash` 与 `deepseek-v4-pro`。前台用 flash（快），工人用 pro（能扛活）。

权限：会话级 preset，用 `session/query` 发 `/permission <preset>` 设置；SDK 会话默认是 workspace-write。

### relay/lib/agents.js —— 把运行时包装成两个角色

```js
createAgents({ config, log }) -> {
  deskTurn({ chatId, sessionId, prompt, timeoutMs }) -> { ok, sessionId, text, error, timedOut, durationMs }
  workerEval({ orderId, cwd, sessionId, prompt, timeoutMs }) -> { ok, sessionId, text, error }
  workerStart({ orderId, cwd, sessionId, prompt }) -> { ok, sessionId }   // 只排队，不等待
  workerInject(orderId, text) -> { ok }                                  // 运行中插话
  workerState(orderId) -> { running, turn, step, lastTool, lastAssistant, injected }
  workerWaitTurn(orderId, turnBefore, timeoutMs) -> { ok, turn, text, running }
  workerSessionOf(orderId), close()
}
```

硬性要求：前台一个常驻进程（session 按客户粘住）；工人一个订单一个常驻进程（cwd = 订单工作区）；
`workerStart` 绝不等待；`workerInject` 绝不等待；日志只打长度和状态，不打正文。
### relay/lib/orders.js —— 只负责落盘

```js
ensureOrder({ chatId, nickname }) -> order        // 已有该 chat 的未关闭订单则复用
findOpenOrderByChat(chatId) -> order|null
loadOrder(orderId) -> order
updateOrder(orderId, patch) -> order              // status/title/sessionId/...
appendEvent(orderId, { type, ... })
appendWorkerEvents(orderId, events)
appendThread(orderId, markdown)                   // thread.md
readOrderMd(orderId) / writeOrderMd(orderId, text) / appendRequirement(orderId, lines)
paths(orderId) -> {dir, workspace, deliverables, ...}
withOrderLock(orderId, fn) -> Promise             // 同一订单串行，防两个 worker 进程同跑
```

order 对象至少包含：`orderId, chatId, status, title, deskSessionId, workerSessionId, createdAt, updatedAt`。

### relay/lib/compat.js —— 顶替 `src/` 内核的 HTTP 契约

```js
handle({ method, path, query, body, headers }) -> { status, json } | null   // null = 不认领，交给 404
```

必须认领（桥接会真调用）：

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/healthz` | `{ok:true, up:true, service:'whale-girl'}`（bridge `wait_for_server` 要这三个字段） |
| POST | `/api/wechat/send-permission` | `{ok:true, allowed:true}`（这是唯一的发送闸门） |
| POST | `/api/bridge/heartbeat` | `{ok:true}` |
| POST | `/api/wechat/contacts/sync` | `{ok:true}` |
| POST | `/api/vision` | 无视觉能力时 `{ok:false, error:'vision disabled'}`，不得 500 |

关闭功能后仍需不 500：`/api/care*`、`/api/moments*`、`/api/stickers*`、`/api/reminders*` 一律 `{ok:true}` 或空列表。

### relay/lib/protocol.js —— 自然语言轮次协议（不引入 JSON 协议）

前台输出用三个可选标记，解析必须容错（缺标记就用全文）：

```
【回复客户】……     必填，发给客户的话
【派单】……         可选，要求 worker 做的事
【需求更新】……     可选，追加到 order.md 的需求/验收条目
```

worker 输出：

```
【给前台】……       给前台的汇报（缺标记 = 全文）
【需要确认】……     要客户确认的问题（多条一行一个，前台一次问全）
【产出】……         交付物路径
```

### relay/server.js / relay/lib/relay.js —— 编排（Lead 负责）

`handleIncoming(body) -> { action:'reply', reply, bubbles }`，并在内部完成：去重（`msg_id`）、同会话串行、
订单状态推进、调前台/worker、写 thread/events。

## 5. 配置

`relay/config.example.json`（入库）与 `relay/config.json`（gitignore，含密钥）：

```json
{
  "port": 8790,
  "stateRoot": "",                       // 留空 = %LOCALAPPDATA%\wc-auto-accept-orders\state（沙箱只在这里可用）
  "dsh": {
    "command": "",                      // 留空则自动探测（electron-run-as-node + app.asar 里的 bin.js，或 PATH 上的 dsh）
    "electronPath": "D:/DeepSeek Harness/DeepSeek Harness.exe",
    "binPath": "D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "env": { "DEEPSEEK_API_KEY": "sk-..." }
  },
  "desk": { "timeoutMs": 120000, "permissionMode": "workspace-write", "fallbackPermissionMode": "danger-full-access", "approvalPolicy": "never" },
  "worker": { "timeoutMs": 600000, "permissionMode": "workspace-write", "fallbackPermissionMode": "danger-full-access", "approvalPolicy": "never" },
  "orders": { "confirmMode": "frontdesk", "maxReplyChars": 1200, "bubbleChars": 180 }
}
```

## 6. 分工与文件所有权（不要越界改别人的文件）

| 归属 | 文件 |
|---|---|
| Lead | `relay/CONTRACT.md`、`relay/server.js`、`relay/lib/relay.js`、`relay/lib/protocol.js`、`relay/config.example.json`、`relay/.gitignore`、`relay/README.md`、根 `.gitignore`、`docs/` |
| sdk-driver | `relay/lib/sdk.js`、`relay/lib/agents.js`（运行时与角色包装） |
| order-store | `relay/lib/orders.js`、`relay/tests/orders.test.js` |
| bridge-compat | `relay/lib/compat.js`、`relay/tests/compat.test.js`、`relay/docs/bridge-contract.md` |

实验脚本放 `/tmp`，不要提交。任何人**不要**跑 git 写操作（commit/push/branch），由 Lead 统一提交。

## 7. 验收（Lead 会逐条跑）

1. `node relay/tests/dsh.test.js`、`orders.test.js`、`compat.test.js` 各自通过，且不依赖真实 LLM。
2. 离线联调：`RELAY_STATE=/tmp/relay-state node relay/server.js` + 假 CLI（`dsh.command` 指向 fake-dsh），
   `curl -X POST /webhook/wechat` 能拿到 `{ok:true, action:'reply', reply:'…'}`。
3. 真机联调：真实 `dsh headless` 跑一轮前台、一轮 worker，session 出现在 `~/.dsh/sessions/` 对应工作区。
4. 桥接联调：`WHALE_BOT_URL=http://127.0.0.1:8790` 启动桥接，微信里收到回复。
5. `node scripts/privacy-scan.js .` 与 `node scripts/release-check.js` 不因 relay 报错。
