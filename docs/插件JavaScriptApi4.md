# JavaScript 插件 API 4

适用：鲸鲸 4.1.2 起的 JavaScript 插件。旧 Api 1/2 工具、Api 3 Wasm 消息插件与人设包继续支持。
此功能发布前仅供开发测试，以 GitHub Releases 实际版本为准。

## 安装、授权与更新

在插件市场打开「启用 JavaScript 插件（实验性）」总开关，安装插件，再逐个确认完整系统权限并启用。
默认关闭；安装或保存设置不会执行插件。所有配置与手动操作位于插件卡片「设置」。

同 ID、同作者且更高版本直接更新，无须卸载：替换代码，保留设置、会话状态和插件数据目录。
更新撤回旧授权，新版默认停用，重新启用后才运行。更换 ID 视为新插件。
插件作者负责兼容旧设置和迁移旧状态，建议存储 `schemaVersion` 并先备份再迁移。
不能用作者显示名证明真实身份，请核对下载来源及源码。市场更新拒绝跨作者接管同一 ID。

JavaScript **不是沙箱**。插件以当前 Windows 用户权限执行，可以访问网络、文件、系统命令、聊天、记忆和主程序全部 API。
只启用信任的作者。扫描、签名、上架不保证安全。停止受管理的进程不能撤销已完成的操作，
也不能保证停止插件自行启动的独立系统服务。卸载会删除宿主管理的设置和会话状态，
插件数据目录及其在其他位置自行创建的文件需要用户核对后删除。

## 插件包

ZIP 根目录仅两个文件：`plugin.json` 和 `plugin.js`。包上限 16 MiB，代码上限 8 MiB，UTF-8、CommonJS。
不自动运行 npm 安装脚本。可在开发机用 Node.js 生态构建依赖，将依赖打包进单个 `plugin.js`，
把 `whale` 及 Node 内置模块标为 external。宿主没有预装任意 npm 库。

```json
{
  "Id": "my-search", "Name": "我的搜索", "Author": "作者",
  "Version": "1.0.0", "MinAppVersion": "4.1.2", "Description": "按需检索并注入回复",
  "ResultLabel": "结果", "Api": 4, "Kind": "message",
  "Hooks": ["chat.search", "chat.search_result"],
  "Permissions": ["system.full"], "ExecutionTimeoutMs": 30000, "IntervalSeconds": 60
}
```

`Kind` 为 `message` 或 `tool`。每次调用超时 100–120000 ms，默认 30000；定时间隔 1–86400 秒，默认 60。
每个插件在独立 Node 子进程中串行执行，最多 16 个启用插件、2 个并行调用，单进程堆内存 256 MiB。
异常或超时降级回宿主原流程并暂停该插件 30 秒。Wasm 的旧预算和权限保持原样。
这些限制用于减少卡死，不是对完整系统权限代码的安全隔离。

## 扩展点与输入

消息顺序：`chat.received` → `chat.pre_reply` → `chat.search` → `chat.search_result` →
`chat.prompt` → `chat.generate` → `chat.reply` → `chat.before_send` → `chat.dispatched`。
原有 Wasm 扩展先执行，同阶段 JavaScript 按 ID 排序。宿主账号校验、黑白名单、输入草稿保护继续生效。

另有 `app.start`、`app.stop`、`timer.tick`、`tool.run`。
启动/定时在内核运行时工作；不承诺电脑休眠和内核停止期间执行或补跑。
`app.stop` 最多留 300 ms 做本地清理，撤权后不能再调用 SDK。

```js
const whale = require('whale');
exports.hooks = {
  'chat.search': async ctx => {
    if (!/查一下|搜索/.test(ctx.message.text)) return {};
    const search = await whale.search(ctx.message.text, { timeoutMs: 8000 });
    return { search }; // 提供结果时替代本轮宿主默认搜索；返回 {} 则沿用宿主
  },
  'chat.prompt': async ctx => ({ system: ctx.system + '\n回答时注明联网资料来源。' }),
  'timer.tick': async ctx => ({ state: { ticks: (ctx.state.ticks || 0) + 1 } }),
};
exports.run = async ctx => whale.capabilities(); // tool.run，也可放进 hooks
```

输入含 `api/hook/key/now/settings/state`，消息扩展另含 `message/history/lastBot/search/webText`。
`search` 提供结构化资料，标题、URL、摘要、检索时间及可确认的发布时间；未知发布时间为 null。
`state` 按插件与会话隔离，单份 64 KiB、最多 200 份，输出 `{state: {...}}` 后原子保存。
模块全局变量仅当前进程有效，持久文件写 `whale.paths.pluginData`；更新保留该目录。

允许输出：`chat.pre_reply` 的 `{action:'wake'|'skip'|'pass'}`；提示词阶段 `{system}`；
生成和回复阶段 `{text}`；两个检索阶段 `{search}`。发送提交阶段是观察点，不可再次改写本轮已提交正文。
`tool.run` 接受任意 JSON 输入并返回 JSON，入口为卡片「设置 → 运行一次」。

## SDK 与主程序 API

- `await whale.capabilities()`：获取方法、扩展点和当前所有 `/api/*` 路由。
- `await whale.api('/api/status')`；`await whale.api('/api/config', {method:'POST',body:{patch:{...}}})`：
  访问本机内核全部现有 API，无额外端点白名单。只接受本内核 `/api/` 地址，凭据不会发往外站或重定向。
  常用接口与请求格式见主仓库 `src/http/routes/`；返回 `{status,ok,body}`，不要把 HTTP 成功当成任务完成。
- `await whale.search(query, {freshness:'yesterday',dateRange:{start:'2026-11-12',end:'2026-11-12'},timeZone:'Asia/Shanghai',timeoutMs:8000})`：
  显式执行宿主搜索，使用独立调用预算，不受旧 Wasm 300 ms 限制。日期用于查询提示，
  搜索引擎可能不给发布日期，不能保证穷尽指定日期，也不能把抓取时间当成发布时间；插件需核对来源。
- `await whale.model({system:'...',turns:[{role:'user',content:'...'}],maxTokens:2000})`：调用当前配置模型，产生正常模型费用。
  自选模型或服务可以直接用 Node 的 `fetch`/`https`，密钥放本地设置，不放源码和日志。
- `await whale.sendText(chatId,text,{name,chatType})`、`sendVoice(...)`、`sendImage(chatId,file,{name})`：
  向现有桥接队列提交任务。语音需启用并配置语音发送；图片需启用表情包并满足格式与 4 MiB 限制。
  返回 `{id,status:'queued',confirmed:false}`；通过 `await whale.delivery(id)` 查询状态。
  `submitted` 表示发送通道已提交，**不表示微信已送达**；图片仅数据库确认后为 `confirmed`。
  未确认不自动重发；总开关关闭、插件停用或更新会取消尚未执行的任务。
- `whale.paths`：`pluginData/appData/appRoot`；`whale.context` 获取当前调用上下文。

这些发送便利方法继续走既有账号校验和会话保护，不能用于绕过草稿保护。
完整权限插件也能直接使用系统与其他接口，用户须了解并信任实际代码。
内核 API 与 SDK 单次输入/输出上限 512 KiB；大文件请使用 Node 文件接口，避免通过 IPC 传输。

## 投稿与兼容

公开市场使用独立 `index-v4.json`，旧客户端不会误装 Api 4。
提交源码、固定源码 commit、发布账号与数值 ID、包 SHA-256，遵守市场校验和完整权限披露。
投稿流水线必须隔离执行 JavaScript；不要把有秘密凭据的维护者环境用于运行陌生插件。
安装后请先在测试账号验证，勿对真实联系人盲目重试发送。
