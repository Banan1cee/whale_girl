# relay —— 微信接单中继

把 `bridge/`（微信桥接）接上「前台 AI + 干活 agent」，替代内核 `src/` 的聊天大脑。设计说明见
[`docs/接单中继.md`](../docs/接单中继.md)，模块接口见 [`CONTRACT.md`](CONTRACT.md)。

```
node relay/server.js            # 中继：监听 127.0.0.1:8790
bridge ──WHALE_BOT_URL──> relay ──dsh headless──> 前台 session / 工人 session
```

## 1. 前置条件

- Node ≥ 18（仓库自带 `runtime/node.exe` 也行）。
- 本机装有 DeepSeek Harness 桌面端：`relay` 借它自带的 `dsh` 跑 headless 会话，不额外装东西。
- 一个可用的 `DEEPSEEK_API_KEY`（headless 不读桌面端登录态，必须显式给）。
- 能跑的微信桥接（`bridge/`，需要登录着的微信）。

## 2. 配置

```bash
cp relay/config.example.json relay/config.json
```

改这几项就够了：

| 字段 | 说明 |
|---|---|
| `dsh.env.DEEPSEEK_API_KEY` | 必填；密钥只写在 `relay/config.json`（已 gitignore），不要提交 |
| `dsh.command` | 留空则自动探测：先找 `dsh` 命令，再用 `electronPath` 跑 `binPath`（asar 里的 CLI） |
| `stateRoot` | 运行状态放哪。留空 = `%LOCALAPPDATA%\wc-auto-accept-orders\state`；填相对路径则相对 `relay/` |
| `desk.timeoutMs` / `worker.timeoutMs` | 前台一轮 / 工人一轮的超时；工人默认 10 分钟 |
| `desk/worker.permissionMode` | `workspace-write`（有文件沙箱）或 `danger-full-access`（无沙箱） |
| `orders.bubbleChars` | 单条微信消息上限，超了就拆成多条 bubbles（默认 180） |
| `orders.confirmMode` | `frontdesk` 演示用；`owner` 生产用（老板 `#确认` 才开工） |
| `owner.chatId` | 老板的微信会话 id，填了才认 `#确认` 之类的指令 |
| `bridgeToken` | 和桥接配置里的 token 一致；留空则不做校验 |

验一下 CLI 探测：

```bash
node -e "console.log(require('./relay/lib/dsh').resolveDsh(require('./relay/config').loadConfig().dsh))"
```

### 关于 worker 的文件沙箱（踩过的坑，必读）

DSH 的 Windows 沙箱要在工作区目录上写 ACL 和低完整性标签。**实测只有 stateRoot 落在用户目录
（`C:\Users\<你>\...`）下面时这一步才成功**；放在 `D:` 盘、盘根目录下都会报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`，表现为沙箱里的 `echo` 都跑不了。

中继启动时会自检：

- stateRoot 在用户目录下 → 维持 `workspace-write`，worker 的 shell 在沙箱里跑；
- stateRoot 不在用户目录下 → 打印警告并让 worker 用 `danger-full-access`（没有文件沙箱，但能干活）。

所以：**想要沙箱就把 stateRoot 留空**（默认就在 `%LOCALAPPDATA%`）；把 stateRoot 指回仓库目录，就等于
放弃沙箱。这个取舍自己定，中继不会偷偷改。

## 3. 启动

```bash
node relay/server.js
```

看到 `relay 已启动` 与 `DSH 入口` 就算起来了。然后**让桥接指过来**（原来的内核/启动器不要再占着桥接）：

```powershell
# 先关掉正在跑的桥接（启动器里点停止，或 taskkill 掉 python.exe）
cd D:\whale-girl
$env:WHALE_BOT_URL = "http://127.0.0.1:8790/webhook/wechat"
.\runtime\python\python.exe -u examples\wechatauto_bridge.py
```

桥接启动后会打一行「已连上鲸鲸服务：http://127.0.0.1:8790」，就说明它连的是 relay 而不是内核。

## 4. 验证

```bash
curl http://127.0.0.1:8790/healthz
# {"ok":true,"up":true,"service":"whale-girl"}
```

然后用自己的小号给机器人发一句「在吗」。中继日志里会出现 `webhook 完成`，微信里会收到前台的回复。

## 5. 在 DeepSeek Harness 里看两个角色在干什么

前台和工人都是真的 DSH 会话，落在 `~/.dsh/sessions/` 下对应工作区里：

| 角色 | 工作区（GUI 里的分组名） | 内容 |
|---|---|---|
| 前台 | `relay/state/desk` | 每条客户消息、前台的思考和措辞 |
| 工人 | `relay/state/orders/<orderId>/workspace` | 派单内容、工具调用、产出的文件 |

**实测口径（重要）**：桌面端不会把这些目录自动注册成"工作区"，它们出现在左侧栏的 **「未分组」** 里，
标题是自动生成的、可能显示"未命名"。所以按下面的顺序找：

1. 桌面端 **Ctrl+R 刷新**（或重开会话列表）；
2. 左侧「未分组」里按时间找最新的几条（前台和工人的会话是这一两分钟内产生的）；
3. 想精确定位就用 session id 搜索：
   - 前台 session id：`<stateRoot>/desk.json` 里 `{ "<chat_id>": "session-..." }`
   - 工人 session id：`<stateRoot>/orders/<orderId>/order.json` 里的 `workerSessionId`
4. 打开后能看到这一轮完整的用户消息、思考、工具调用和输出；工人 session 的 cwd 就是该订单的 `workspace`。

如果只想看"谁对谁说了什么"，`thread.md` 比 GUI 更快（它把前台派单、工人汇报、前台转述按顺序记下来了）。

工人每轮的原始 NDJSON 事件另存于 `relay/state/orders/<orderId>/worker.jsonl`；给人看的对话在 `thread.md`。

## 6. 老板指令

只有 `owner.chatId` 那个会话发的才认：

| 指令 | 作用 |
|---|---|
| `#确认 ord-20261121-1a2b3c` | 放行派单（`confirmMode=owner` 时必须） |
| `#完成 ord-...` | 标记订单已交付 |
| `#暂停` / `#恢复` | 停/启自动回复（暂停时连发送闸门也关，适合人工接管） |
| `#状态` | 报当前订单、会话 id、待确认条数 |

## 7. 排障

| 现象 | 先看哪里 |
|---|---|
| 微信没回复，桥接日志说「未发送回复」 | 响应里没有 `action:'reply'`/`reply` 为空，或订单被暂停 |
| 微信没回复，桥接日志说「鲸鲸接口返回 HTTP 4xx」 | `bridgeToken` 和桥接不一致 |
| 回复是「刚卡了一下…」 | 前台轮失败了，看 relay 日志里的 `前台轮失败`（多半是 key 或 CLI 探测问题） |
| 一条消息等很久 | 工人轮在跑（默认最长 10 分钟）；`<stateRoot>/orders/<id>/thread.md` 能看到进度 |
| 工人报「shell 沙箱建不起来」 | stateRoot 不在用户目录；要么留空 stateRoot，要么接受 `danger-full-access` |
| 会话在 GUI 里找不到 | 工作区目录是否真的生成（`relay/state/desk`、`relay/state/orders/.../workspace`） |

## 8. 测试

逐个文件跑，全部离线、不联网、不需要 key：

```bash
node relay/tests/protocol.test.js    # 标记解析与微信话术清洗
node relay/tests/relay.test.js       # 一轮消息的编排顺序（假 dsh + 假订单库）
node relay/tests/dsh.test.js         # 驱动层（假 CLI）
node relay/tests/orders.test.js      # 订单落盘与锁
node relay/tests/compat.test.js      # 桥接契约
node relay/tests/server.test.js      # HTTP 入口联调（假 dsh）
```

## 9. 目录

```
relay/
  server.js          HTTP 入口：webhook + 内核契约的几个 /api/*
  config.js          配置装载（config.json + 环境变量）
  lib/relay.js       编排：去重、排队、前台轮、工人轮、状态推进
  lib/protocol.js    人设与任务单、三个【标记】的解析、微信话术清洗
  lib/dsh.js         dsh headless 驱动（进程、NDJSON、session 续接、超时）
  lib/orders.js      订单落盘（order.md / thread.md / events.jsonl / 锁）
  lib/compat.js      桥接会用到的内核接口
  state/             运行时状态（gitignore）
  tests/             离线测试
```
