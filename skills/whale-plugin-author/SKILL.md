---
name: whale-plugin-author
description: 按 whale-plugin/1 制作、打包、校验鲸鲸启动器插件与主题（0–4 级）。从 examples 复制完整项目即可安装，不必读宿主源码；只有校验失败时才按 testing.md 的排查表去看指定文件。
argument-hint: "[plugin-id]"
license: MIT
metadata:
  author: whale-girl
  version: 1.1.0
---

# 鲸鲸插件制作

目标产物：一个能安装、能过 `validate`/`test`/`pack`、能过市场校验的包，根目录只有 `plugin.json` 和该等级入口。

- 清单字段、等级、扩展点、宿主能力、限额、失败码：`references/protocol.md`
- 能直接复制的配方与四个完整项目：`references/recipes.md`
- 校验命令、排错表、不启动微信的自测：`references/testing.md`
- 只有读代码才知道的坑：`references/gotchas.md`
- 完整项目目录：`examples/theme-minimal`（0 级）、`examples/gate-quiet-hours`（gate）、`examples/prompt-enhance`（prompt）、`examples/tool-node`（工具 + 模型），每个目录都带一份 `README.md`

## 先定三件事

1. **等级**由入口格式决定，不能自选：纯外观 → 0；整数或纯文本工具 → 1/2；要读当前消息或改回复文本 → 3（Wasm）；要联网、调模型、发消息、定时、全接管、写文件 → 4（Node）。
2. **provides**：只声明真正实现的扩展点，`mode`/`scope` 必须在 `protocol.md` §3 允许值内。
3. **calls**：4 级才可声明，只写真的会调用的，且必须是 `protocol.md` §4 的 38 项之一；3 级必须 `[]`。

## 硬规则

- 包根目录只有 `plugin.json` + 该等级入口（0 = `theme.json`，1–3 = `plugin.wasm`，4 = `plugin.js`）；README、图片、测试不进包。
- 清单键只允许 `protocol.md` §2 的白名单，多一个未知键整包拒绝。
- 0 级 `provides` 必须是 `{}`，不得写 `settingsSchema` 或 `dataAccess`；3 级 `calls` 必须 `[]`。
- `provides` 的键与 `exports.providers` 的键逐字相同。
- 插件不监听端口、不请求 `/api/*`、不自己读配置文件；宿主数据只能走已声明的 `host.call(能力, 输入)`。
- 要读或改 `system` 必须声明 `dataAccess: ["model.prompt"]`，要读会话历史声明 `["chat.history"]`（`chat.generate@1` 的历史在 `turns`，没授权时是 `[]`）；没声明的增强者既读不到也改不动，宿主按字段回收，不会让你清空提示词。
- 同一 id 更新必须升 `version`，`author` 不变。
- `message.send@1` 返回 `queued` / `confirmed:false` 只表示已排队，不是微信已送达；`message.submit@1` 声明了也永远不可用。

## 工作流

```text
选等级 → 复制最接近的 examples/ 目录（或 init 生成骨架）→ 改清单和入口 → validate → test → pack → trial → 市场校验 → 报告等级/provides/calls/差异
```

命令都在鲸鲸源码根目录执行（详见 `testing.md`）：

```bash
node scripts/plugin-cli.js init <id> --template integer-tool|tool|reply-wasm|reply-enhancer|chat-takeover|scheduled-task
node scripts/plugin-cli.js validate <目录或ZIP>
node scripts/plugin-cli.js test <目录或ZIP>
node scripts/plugin-cli.js pack <目录> --out <id>.zip
node scripts/plugin-cli.js trial <目录或ZIP>
```

- `init` 的 6 个模板：`integer-tool`（1 级整数工具）、`tool`（2 级文本工具，省略 `--template` 时的默认）、`reply-wasm`（3 级回复增强）、`reply-enhancer`（4 级回复增强）、`chat-takeover`（4 级全接管）、`scheduled-task`（4 级定时，自带 `status.read@1`）。
- `init` 生成的骨架带 `README.md`；`examples/` 下四个示例也各带一份，照它改成自己的（等级 / provides / calls / dataAccess / 已知限制）。
- `pack` 省略 `--out` 时写到**当前工作目录**下的 `<id>.zip`：在源码根直接跑会把 ZIP 落在根目录，务必显式给 `--out`（或先 `cd` 到自己的工程目录）。

## 常见需求 → 声明

「等级」是允许的最低–最高等级，`provides` 列给出 mode/scope（格式 `能力 mode/scope`）。

| 需求 | 等级 | provides | 备注 |
| --- | --- | --- | --- |
| 纯数据主题 | 0 | 无 | 只改颜色、字体、圆角、间距 |
| 整数或纯文本工具 | 1–4 | `tool.run@1` tool/manual | 卡片「运行一次」触发 |
| 收到消息先观察 | 3–4 | `chat.received@1` observe/all | 宿主基础检查后、触发判定前，返回值丢弃 |
| 回复前拦截 | 3–4 | `chat.pre_reply@1` gate/all | 返回 pass/skip/wake |
| 改系统提示词 | 3–4 | `chat.prompt@1` enhance/all | 需 `dataAccess: ["model.prompt"]` |
| 发送前最后改文本 | 3–4 | `chat.before_send@1` enhance/all | 在拆气泡之前 |
| 改写回复草稿 | 3–4 | `chat.reply@1` enhance/all | observe/enhance/replace 三选一 |
| 替换本轮生成 | 4 | `chat.generate@1` replace/all | 要真生成需 `model.complete@1` + dataAccess |
| 全接管回复 | 4 | `chat.handle@1` replace/all | 返回 reply 非空或 ignore |
| 替换或补充检索结果 | 4 | `chat.search@1` replace/all | 也有 enhance（拿 `previous`） |
| 定时任务 | 4 | `task.tick@1` schedule/all | 还要在 provides 里写 `intervalSeconds` |
| 发送结果回调 | 4 | `chat.dispatched@1` observe/all | 只读，不能改发送结果 |
| 启停回调 | 4 | `app.start@1` observe/all | 装配完成时（listen 前）/正常停机；`app.stop@1` 同理，撤权后不保证收到 |

## 什么时候才读宿主代码

只有三种情况，按 `testing.md` §4 的顺序读（先注册表，再协议文档，最后最小片段）：

1. 校验或市场报错，排查表都排除了仍失败；
2. 要确认某个能力的**真实字段**（以 `src/services/pluginProtocolRegistry.json` 的 schema 为准）；
3. 行为与预期不符，要确认调用时机。

不要通读宿主编排代码，也不要为绕过校验去改宿主或市场校验器。

## 交付前自检

- [ ] `validate`、`test` 通过，`pack` 出的 ZIP 根目录只有两个文件
- [ ] ZIP 里的 `plugin.json` 与源文件逐字节一致（用 `pack`，不要手改 ZIP）
- [ ] 声明的每个 provider 都在 `exports.providers` 里实现，每个 `calls` 都真的用到
- [ ] 3 级 `calls` 为 `[]`；需要 system/history 的已写 `dataAccess`
- [ ] 设置项没有 `default`，代码里用 `settings.x ?? 默认`
- [ ] README 写清等级、provides、calls、dataAccess 与已知限制
- [ ] 没有密钥、账号、聊天内容进包
