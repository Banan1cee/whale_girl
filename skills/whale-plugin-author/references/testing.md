# 校验与排查

校验器只读字节，**不执行插件代码**。所以「校验通过」只证明清单和包结构成立，行为要自己驱动处理器（§5）或试装。

## 1. 本地校验（在鲸鲸源码根目录）

```bash
node scripts/plugin-cli.js validate <目录或ZIP>
node scripts/plugin-cli.js test <目录或ZIP>
node scripts/plugin-cli.js pack <目录> --out <id>.zip
node scripts/plugin-cli.js trial <目录或ZIP>
node scripts/plugin-cli.js init <id> --template integer-tool|tool|reply-wasm|reply-enhancer|chat-takeover|scheduled-task
```

| 命令 | 检查什么 | 不检查什么 |
| --- | --- | --- |
| `validate` | 清单白名单/等级/入口/runtime、provides 的 mode/scope/intervalSeconds、calls 是否属该等级、dataAccess、settingsSchema、入口是否存在（ZIP 时还查条目与大小） | 不执行代码，不装包，不查行为 |
| `test` | 上面全部 + 4 级 `plugin.js` 的 CommonJS 语法 / 1–3 级 Wasm 的导入导出与等级限制 | 不运行处理器，不能证明行为 |
| `pack` | 只把 `plugin.json` 和该等级入口打进 ZIP（根目录两项），已存在同名 ZIP 时拒绝覆盖 | 不做市场校验 |
| `trial` | 静态模拟：等级名、provides 路由、`calls` 的 `requiresConsent`/`disabled`、dataAccess 披露、`chatConsentRequired`（只对 3 级计算，4 级恒为 `false`）、4 级需确认完整系统权限 | `executed`/`installed`/`authorizationGranted` 恒为 false |
| `init` | 从 `templates/plugins/` 生成清单+入口+README 的项目骨架；6 个模板：`integer-tool`（1 级）、`tool`（2 级，默认）、`reply-wasm`（3 级）、`reply-enhancer`/`chat-takeover`/`scheduled-task`（4 级） | 之后仍要自己改 id/名称/逻辑 |

- 项目目录里有 README、测试文件不影响 `validate`；**只有打包**才要求根目录就两个文件，`pack` 会自动只取两项。
- 想校验 ZIP：`validate <id>.zip`，它会查条目名、大小、CRC 与清单/入口是否匹配。
- `pack` 省略 `--out` 时写到**当前工作目录**下的 `<id>.zip`（不是插件目录）：别在仓库根直接跑，显式给 `--out`。
- `init` 生成的骨架带一份 `README.md`（模板来自 `templates/plugins/README.md`）；`examples/` 下四个示例也各带 `README.md`，可以直接照改。
- `validate`/`test`/`trial` 省略目标时等于校验**当前目录**；`pack` 同理，但它还要求当前目录是项目目录。
- 命令失败时退出码是 `1`，stderr 打一行 `插件 CLI：<原始错误>`，**stdout 没有 JSON**；成功时 stdout 才是 `{ok:true,...}`。脚本里按退出码判断，不要去找 `{ok:false}`：`pack` 目标已存在是 `插件 CLI：EEXIST: ...`，路径不存在是 `插件 CLI：ENOENT: ...`。

## 2. 市场校验（在市场仓库根目录）

```bash
node scripts/package.js plugins/<id>        # 产出 packages/<id>-<version>.zip 并打印 SHA-256
node scripts/build-index.js --check         # 目录是否与源码同步；漂移退出码 1
python validate.py --json                   # 完整市场校验，机器可读报告
```

- 市场目录（`index*.json`、`index-v5.json`）由 `build-index.js` 生成，**不要手改**；投稿只提交 `plugins/<id>/` 和 `packages/<id>-<version>.zip`。
- `validate.py` 检查：包内 `plugin.json` 与源码清单逐字节一致、ZIP 条目/大小/SHA-256、`provides`/`calls` 是否在 `protocol.json` 白名单内、settingsSchema、主题 token、以及展示元数据（`market.json`）。
- `market.json` 可选键只有 `readme`、`images`、`donation`：`readme` 是插件目录内的 `.md`（≤64 KiB）；`images` ≤8 张 png/jpg/gif、单张 ≤2 MiB，README 里引用的本地图必须在这里声明；`donation.afdian` 只接受 `https://afdian.com/a/<slug>`。
- `validate.py` 同样不执行插件；它不证明插件安全，也不证明行为正确。

## 3. 报错 → 原因 → 下一步

插件调用失败时，宿主给你的错误码是下面这些（没有的码就不要按名字猜）：

| 错误码 | 最可能原因 | 下一步 |
| --- | --- | --- |
| `invalid_plugin_manifest` | 清单有未知键/缺必填/版本或 id 不合法/JSON 重复键 | 对照 `protocol.md` §2 逐键删；用 `validate` 定位 |
| `manifest_calls_invalid` | `calls` 里有该等级不允许的能力 | 只能写 §4 名单里的；3 级必须 `[]` |
| `manifest_data_access_invalid` | `dataAccess` 值不在白名单，或没配 `chat.*` 提供者 | 写 `model.prompt`/`chat.history`，并声明对应 chat 能力 |
| `manifest_provider_invalid` | mode/scope 不合法、键不在该等级、描述符多字段 | 对照 `protocol.md` §3 |
| `settings_schema_invalid` | 用了白名单外的关键字（如 `default`）、根不是 object、注解超长 | 只保留 §2.1 允许的关键字 |
| `plugin_error` | 入口抛错、`exports.providers` 里没有对应键、输出不可序列化 | 本地 `node -e` 直接调处理器（§5），看真实异常 |
| `invalid_capability_output` | 返回多了/少了字段、`chat.handle@1` 的 `reply` 为空、state 非对象或超 8 KiB | 只返回 schema 里的字段；必填字段给有效值 |
| `invalid_capability_input` | 宿主传给你的输入不合 schema（通常意味着宿主版本与清单不匹配） | 检查 `minAppVersion`；把用到的字段对照注册表 schema |
| `input_limit` / `output_limit` | 单次调用输入/输出超过 512 KiB | 裁剪文本，别把整段历史塞进 state 或输出 |
| `capability_timeout` | 超过 `executionTimeoutMs`（默认 30s） | 拆小工作；不要在处理器里做长任务或重试风暴 |
| `capability_aborted` | 本轮被取消（用户撤回、断线、接管被撤） | 不要重试；按取消收尾 |
| `grant_revoked` | 停用、卸载、更新、改设置导致授权代次变化 | 等重新启用；不要重放旧请求 |
| `capability_owner_conflict` | 同一能力同一 scope 有两个 `replace` 提供者 | 只留一个 replace，其余改 enhance/observe |
| `capability_queue_limit` / `plugin_queue_limit` | 同一插件并发或排队超限（2 / 32） | 合并调用、降低频率 |
| `host_call_failed` | `host.call` 的能力内部失败或参数不合 schema | 对照该能力的输入 schema；写类能力不要盲目重试 |
| `host_capability_not_declared` | 调了没写进 `calls` 的能力 | 加声明；不要动态探测能力 |
| `host_capability_disabled` | 能力被注册表关闭（如 `message.submit@1`） | 换能力或去掉调用 |
| `host_capability_unavailable` | 宿主没装配这项能力 | 把它当可选：失败不影响主流程就吞掉并记日志 |
| `host_call_limit` | 单次调用超过 64 次 `host.call` 或 8 个并发 | 批量取数，别在循环里逐条调用 |
| `plugin_process_exit` / `plugin_process_error` | 插件进程崩溃或被宿主杀掉 | 检查内存/死循环/未捕获异常；`test` 查不出这类问题 |
| `plugin_not_enabled` | `tool.run@1`/`task.tick@1` 缺少插件上下文 | 只会在宿主内部调度出错时出现，作者侧一般看不到 |
| `invalid_plugin_ipc` | 宿主与 worker 的消息不合协议 | 不要自己 `process.send` 或改动 IPC 字段 |

补充：

- `gate`、`observe`、`enhance` 的失败会按 fail-open / 丢弃 / 退回上一层处理，**不一定报给你**；这就是「明明写了却没效果」的常见来源，先按 `gotchas.md` 第 6、8 条自查。
- 插件拿不到宿主日志；要排查就在处理器里返回带 `error` 字段的结果，或在本地直接调处理器。

## 4. 只有这些情况才读宿主代码

1. 上面所有码都排除完仍失败；
2. 要确认某能力的**真实字段**：先看 `src/services/pluginProtocolRegistry.json` 的 `providers`/`calls`/`schemas`/`levels`（唯一事实源），再看 `docs/插件协议.md`；
3. 要确认调用时机：看 `src/pipeline/bot.js` 里对应能力的调用点（例如 `applyPromptHooks`、`preReplyAction`）的最小片段。

最后才看 `unifiedCapabilityDispatcher.js`/`unifiedPluginRuntime.js` 的最小片段。不要通读宿主编排代码，也不要把「读源码」当成默认步骤。

## 5. 行为自测（不启动微信）

`test`/`validate`/`trial` 都不运行你的代码，行为只能自己驱动：

```bash
node -e "const p=require('./my-plugin/plugin.js').providers['chat.pre_reply@1'];
const out=p({message:{platform:'wechat',chatType:'group',chatId:'g1',senderId:'u1',text:'hi',atMe:false},localWechat:true,now:Date.now()},{settings:{},state:{}});
console.log(JSON.stringify(out));"
```

- 输入按 `protocol.md` §3 的字段手工构造；`ctx` 至少给 `{host:{call:async()=>({})}, settings:{}, state:{}}`。
- 对照 schema 自检：只输出该能力 schema 里的字段，必填字段不为空；`chat.handle@1` 的 `reply` 非空、`chat.generate@1` 的 `text` 非空。
- 需要宿主能力的处理器：把 `host.call` 换成记录参数的假函数，断言参数名与类型（尤其是 `model.complete@1` 用 `turns` 不是 `messages`）。
- 装到启动器后：工具类在卡片「设置 → 运行一次」里输入 JSON 看返回；聊天类用测试群/测试实例，先停用其它会改回复的插件（`replace` 冲突会让你的插件根本不执行）。
- 任何发送类结果都只算「已排队」。
