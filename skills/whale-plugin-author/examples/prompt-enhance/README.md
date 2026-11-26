# prompt-enhance（提示词补一句示例）

在本轮系统提示词末尾追加一句风格要求，句子内容可以在插件卡片设置里改。整目录复制后改 `id`/`name`/`author`。

| 项 | 值 |
| --- | --- |
| 等级 | 4（`node-full`，入口 `plugin.js`） |
| provides | `chat.prompt@1` enhance/all |
| calls | `[]` |
| dataAccess | `["model.prompt"]`（读 `system` 的许可） |

## 已知限制

- 少了 `dataAccess: ["model.prompt"]`：插件照旧被调用，但输入没有 `system`、返回的 `system` 也会被换回上一层——不报错，也不生效。
- `settingsSchema` 不注入默认值：`settings.suffix` 可能是 `undefined`，默认值写在代码里。
- 返回的 `system` 是**完整的新值**（enhance 语义），上限 64000 字符；只拼一句时保留上一层内容。
- 多层 enhance 按插件 id 顺序执行，上一层结果在 `output` 里，需要时读它再改。
- 只改提示词，不改回复正文；改正文用 `chat.reply@1`/`chat.before_send@1`。
- 看不到会话历史（那要 `dataAccess: ["chat.history"]`）。

## 校验

```bash
node scripts/plugin-cli.js validate examples/prompt-enhance
node scripts/plugin-cli.js test examples/prompt-enhance
node scripts/plugin-cli.js pack examples/prompt-enhance --out prompt-enhance.zip
node scripts/plugin-cli.js trial examples/prompt-enhance
```
