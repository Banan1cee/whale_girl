# gate-quiet-hours（安静时段示例）

群聊在 23:00–08:00 没人叫她就保持安静，其它时间交回宿主判断。整目录复制后改 `id`/`name`/`author`。

| 项 | 值 |
| --- | --- |
| 等级 | 4（`node-full`，入口 `plugin.js`） |
| provides | `chat.pre_reply@1` gate/all |
| calls | `[]`（只读当前消息，不需要宿主能力） |
| dataAccess | 未声明（gate 拿不到 `system`/`history`，也不需要） |

## 已知限制

- 只能看到通过宿主基础检查的消息：去重、禁言、静音、白名单、管理魔咒在后面处理的消息不会问到你。
- 抛异常等于 `pass`（fail-open）：想「不回」必须显式返回 `{action:'skip'}`。
- 多个 gate 按插件 id 顺序问，第一个非 `pass` 生效。
- 时段用输入里的 `now`（宿主毫秒时间戳）换算成本地小时，跟着运行机器的时区走。
- 私聊直接 `pass`；`atMe`/`replyToBot` 的消息也不会被压掉。
- 返回 `wake` 能让本来不回复的消息开口，但前置基础检查仍然拦得住。

## 校验

```bash
node scripts/plugin-cli.js validate examples/gate-quiet-hours
node scripts/plugin-cli.js test examples/gate-quiet-hours
node scripts/plugin-cli.js pack examples/gate-quiet-hours --out gate-quiet-hours.zip
node scripts/plugin-cli.js trial examples/gate-quiet-hours
```
