# tool-node（手动工具 + 模型示例）

卡片「设置 → 运行一次」触发的手动工具：统计字数，或让模型把一段文字缩成一句话。整目录复制后改 `id`/`name`/`author`。

| 项 | 值 |
| --- | --- |
| 等级 | 4（`node-full`，入口 `plugin.js`） |
| provides | `tool.run@1` tool/manual |
| calls | `["status.read@1", "model.complete@1"]` |
| dataAccess | 未声明（只读当前消息/会话内容才要 `chat.*` 授权，手动工具用不上） |

## 已知限制

- 只有卡片「运行一次」能触发，不能自己定时、不能监听消息。
- 输入是任意 JSON：类型自己校验，坏输入要返回有意义的 JSON，不要把异常抛成「插件坏了」。
- `model.complete@1` 联网且计费，字段是 `system`/`turns`/`maxTokens`（没有 `messages`），`turns` 最多 100 条；调用会计费。
- `status.read@1` 只读，拿不到聊天正文。
- 不发送消息：要发只能声明 `message.send@1`，且它返回的 `queued` 只表示已排队，不等于送达。
- `calls` 里没声明的能力一律调用失败（`host_capability_not_declared`），别动态探测。

## 校验

```bash
node scripts/plugin-cli.js validate examples/tool-node
node scripts/plugin-cli.js test examples/tool-node
node scripts/plugin-cli.js pack examples/tool-node --out tool-node-demo.zip
node scripts/plugin-cli.js trial examples/tool-node
```
