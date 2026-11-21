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

### relay/lib/dsh.js —— 只负责“跑一轮 DSH”，不关心业务

```js
resolveDsh() -> { command, args: string[], source }   // 找不到 CLI 时 throw，message 必须可操作
runTurn({
  cwd,                  // string，必填；决定 workspace 与 session 分组
  prompt,               // string，必填；走 stdin
  sessionId,            // string|null；null = 新 session，非空 = 续接
  permissionMode,       // 'workspace-write' | 'read-only' | null
  approvalPolicy,       // 'never' | null（headless 一律 'never'，避免无人应答卡死）
  addDirs,              // string[]，可选
  timeoutMs,            // 默认 180000
  env,                  // 额外环境变量（DEEPSEEK_API_KEY 等）
  onEvent,              // (event) => void，逐行回调，可选
}) -> Promise<{
  ok,                   // true 当且仅当 进程 exit 0 且 final.reason.kind === 'completed'
  sessionId,            // 本次 session（新开就是新建的，续接就是传入的）
  text,                 // final.text（trim 过）
  reason,               // final.reason 原样
  events,               // 解析后的所有事件
  timedOut, durationMs, stderrTail, error,
}>
```

硬性要求：超时必须杀掉**整棵进程树**（Windows 用 `taskkill /T /F`）；日志只打长度不打印正文；`--json` 与非 `--json` 都不能污染 stdout 解析。

实现偏差（已核实，按此为准）：

1. `resolveDsh(configDsh)` 收 `config.dsh` 段；另外支持 `RELAY_DSH_COMMAND/ELECTRON/BIN` 环境变量、PATH 上的 `dsh`、
   桌面端默认安装位置兜底；返回值多两个字段 `electron` / `shell`。
2. `runTurn` 额外接受 `opts.command` / `opts.argsPrefix`（测试注入假 CLI）与 `opts.dsh`（透传已解析的启动方式）。
3. 失败时若传了 `sessionId`，返回的 `sessionId` 就是传入值（表示「这轮是续接的」）；调用方只应把 `ok=true` 的
   结果当作「这一轮真的落盘了」，但 sessionId 本身在失败轮也可能有效（用于崩溃后续接）。

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
| dsh-driver | `relay/lib/dsh.js`、`relay/tests/dsh.test.js`、`relay/tests/fixtures/fake-dsh.js` |
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
