# 鲸鲸插件

先编辑 `plugin.json` 中的名称、作者和说明；所有处理器写在 CommonJS `plugin.js` 的 `exports.providers`，键要与清单的 `provides` 一致。这些是 4 级 Node 模板。回调接收 `(input, { host })`；需要宿主能力时再声明并调用能力，例如 `await host.call('status.read@1', {})`。搜索会实际联网，模型调用可能产生费用；默认模板不声明它们，也不发送消息。

在鲸鲸源码根目录运行，把 `<项目>` 换成生成的目录：

```text
node scripts/plugin-cli.js validate <项目>
node scripts/plugin-cli.js test <项目>
node scripts/plugin-cli.js pack <项目> --out <项目.zip>
node scripts/plugin-cli.js trial <项目.zip>
```

`validate` 检查清单和包结构；`test` 额外检查语法，但不运行处理器，不能证明实际行为。`pack` 只打包根目录的 `plugin.json` 和 `plugin.js`，不会覆盖已有 ZIP。`trial` 模拟路由和授权提示，不运行插件、不取得实际授权、不安装包。JSON 输出不包含聊天或账户数据。

实际执行需要在鲸鲸启动器从本地安装并明确确认完整系统权限；Node 插件不是沙箱。`chat-takeover` 示例会接管其适用范围内的聊天；对示例未处理的消息返回 `ignore`，鲸鲸不会再处理它们。只为你信任的代码确认启用，初次试装请使用测试环境。本地检查不是市场审核，不能证明插件安全。
