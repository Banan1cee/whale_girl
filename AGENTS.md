# AGENTS.md —— 给 AI / 自动化协作者的项目约定

本文件是进入这个仓库时的默认约定。任务书 / 用户当次指令与这里冲突时，以任务书 / 当次指令为准；
它们没写到的部分，按下面来，不要每次再问。

## 插件任务入口

- 4.3.0 起只有一种可执行插件协议 **whale-plugin/1**，规范见 `docs/插件协议.md`。旧 Api 1/2/3/4 可执行插件不再运行（卡片只显示和卸载），纯数据人设包继续支持。
- 修改插件清单、权限或执行入口前，先看 `docs/插件协议.md`。包只含 `plugin.json` 和对应等级的入口（1–3 级 `plugin.wasm`，4 级 `plugin.js`）。宿主、启动器和作者 CLI 以 `src/services/pluginProtocolRegistry.json` 为等级、能力、模式、作用域及输入输出 schema 的唯一来源。
- 作者工具：`npm run plugin -- init|validate|test|pack|trial`，模板在 `templates/plugins/`。validate/test/trial 都是静态检查，不执行插件代码，不安装、不授权。
- 授权绑定安装包摘要、清单与入口原始字节、授权代次、批准的 provider/call 和设置快照；改设置即重签，旧代次迟到结果丢弃。Node 插件以完整系统权限运行，**不是沙箱**，启用必须逐个确认。
- 插件回到宿主只能走 `host.call`，且必须是清单声明、宿主启用的能力（见 `docs/插件SDK.md` 的全量表；`message.submit@1` 是保留能力，发送用 `message.send@1`）。不要新增通用 `/api/*` 代理。
- 功能通信只有一个入口：`runtime.capabilities.invokeHost(能力名, 输入)`。HTTP 路由、桥接取件和插件 `host.call` 都走它，能力实现在 `src/services/features/*`；路由只保留传输层（回环校验、桥接 token、readBody、状态码、二进制流）。新增功能＝先在 `pluginProtocolRegistry.json` 登记能力，再写 handler，最后让路由/插件调用它；不要在路由里直接调服务层再另开一套 SDK。
- 内核同进程里的内部装配（如日记把正文交给提醒发送队列、Bot 拼提示词时同步读日记）保留直连：它们要同步语义或只是回调装配，套异步能力层会改行为。这条边界写在这里，别被后来的“统一”顺手改坏。
- 所有插件配置、手动运行、授权都在插件卡片的「设置」。插件不得自行加左侧入口；手动执行只允许 `tool.run@1`。
- 远端 `Banan1cee/whale-girl-plugins` 目前没有 `index-v5.json`，新协议只能本地试装；不要在文档或 UI 里写成已可投稿/已上架。市场仓库同步 schema、校验与 CI 是独立任务。
- 插件投稿 PR 只发到 `Banan1cee/whale-girl-plugins:main`；制作插件只授权独立插件目录。人设预设可直接分享本地 ZIP。
- 网关提交结果不是微信已送达；插件的 `queued`/`submitted` 同样不能当送达证据。

## 1. UI 改动的默认落点：**EXE，不是 WebUI**

本项目说「UI / 界面 / 设置项 / 加个开关 / 加个按钮 / 改个文案」，**默认指启动器 EXE**。

- 默认改 `launcher/`（WPF：`launcher/Views/*.xaml` + `*.xaml.cs`），成品是仓库根目录的 `WhaleLauncher.exe`。
- 内核**不再提供网页界面**（4.0.2 删除了 `web/` 与 `src/http/static.js`；浏览器打开 `127.0.0.1:8787` 只会拿到 404 JSON）。
  启动器与桥接只走 HTTP API（`/api/*`），这些接口一个都不能删。
- 不要顺手往仓库里加 `web/` 或静态文件服务；确实要恢复网页界面，等任务书明确写。
- 安全闸（CSRF / Origin / 远程 token）与 `web/` 是两回事：网页没了，这些闸更要留着。

### 改完 launcher 必须重新发布 EXE

只改源码不重发 EXE，用户是看不到的。发布命令：

```powershell
dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher/publish `
  -p:PublishSingleFile=true -p:SelfContained=false
Copy-Item launcher/publish/WhaleLauncher.exe .\WhaleLauncher.exe -Force
```

- 本机没有 .NET SDK 时：只提交源码，并在回复里明确写「EXE 待发布」，**不要**假装 EXE 已更新。
- CI 的 `tests.yml` 会 `dotnet build` 校验 launcher 编译；`installer.yml` 在 `test/**` 分支构建安装包（不含正式发布）。
- 详细打包 / 签名流程见 `CONTRIBUTING.md` 第四节和 `docs/打包与签名.md`。

## 2. 代码与测试

- CommonJS、**零 npm 运行时依赖**、Node ≥ 18；不要引入需要 `npm install` 的运行时依赖。
- 每个行为改动配一条能复现它的测试；修 bug 要「修复前失败、修复后通过」。
- 测试逐文件跑：`node tests/xxx.test.js`。
  （沙箱里 `node --test "tests/*.test.js"` 可能因 spawn EPERM 失败，这不代表测试坏了。）
- 提交前至少跑：`node scripts/check-layers.js`、`node scripts/release-check.js`、`node scripts/privacy-scan.js .`。
- 中文注释讲「为什么」，不要写「做了什么」式的废话；不重排无关代码。

## 3. 日志与隐私

- 失败日志要能回答「为什么失败」：用 `src/infra/errors.js` 的 `describeError`，
  输出 `type / code / status / detail`；不要只打 `err.message`（`LlmError` 的 message 是给用户看的话术）。
- 日志里不打聊天正文 / 记忆正文，只打长度、计数、结构证据。
- 不提交真实 API Key、wxid、群号、聊天记录、`data/`、日志文件。

## 4. 协作方式

- 每轮修改开始及交付前，先核对 GitHub 最新 main 和待合并 PR，避免覆盖其他协作者更新；本地未提交修改先保留并比较，不直接覆盖。
- 不直接 push `main`：改分支 → PR → CI 绿了再合并。
- 提交信息按 `CONTRIBUTING.md` 第三节（新增 / 改进 / 修复 / 其他 四段），不再另设规范副本。
- 用户可见行为变了，`docs/CHANGELOG.md` 补一段，版本规则见第 5 节。

## 5. 版本与 CHANGELOG

- **已发布版本冻结**：GitHub Releases 上已经发过的版本，不再往它的条目里加内容。
- **所有版本都要标发布状态**，在版本标题下面单独一行，不要写在标题行：
  - 已发布：`> 已发布（GitHub Releases）`
  - 两个发布之间、没有单独发版的中间版本：`> 未单独发布，随 X 发布`，X 是它跟随的下一个已发布版本
    （例：`4.0.2`～`4.0.4` 标 `随 4.0.5 发布`）。
  - 正在开发的最新版本**不标发布状态**，等它确定发布或已经有下一个版本时再补。
- 标记只能写在 `## 4.0.8` 这种纯版本标题的下一行，`release-check` 和 `release-notes` 依赖标题格式；
  `release-notes` 会自动剔除状态行，不会带进 GitHub Release 或更新弹窗。
- **新改动进下一个补丁版本**：已发布版本是 `4.0.8`，新的修复 / 改进就写进 `4.0.9`；
  已发布 `4.0.9` 就写进 `4.0.10`。同时把 `package.json` 的 `version` 改成同一个版本，
  保证 `release-check` 的「package.json 版本 = CHANGELOG 最新条目」通过。
- **版本号规范**：
  - 第二位（次版本）只在**增加新功能**时升：`4.0` → `4.1`；没有新功能不许升次版本。
  - 修复与改进只升第三位（补丁）：`4.0.8` → `4.0.9`。
  - **补丁号禁止跳号，所有 4.x 及以后的主线都要从 `.0` 连续递增**：`4.2.1` 之后必须先有
    `4.2.2`、`4.2.3`，才能升到 `4.3.0`；不许为了省事直接跳到大版本。中间版本即使不单独发布，
    也要在 CHANGELOG 里占一行并标 `> 未单独发布，随 X 发布`，写清这一版改了什么。
    `release-check` 的「版本号连续（不跳号）」现在逐条 4.x 主线校验，缺一个就红。
  - 紧急热修在已发布版本后加第四位：`4.0.8` → `4.0.8.1`，只放紧急修复。
  - 强制更新必须显式指定事故版本，不因四段版本号自动开启。4.1.7 起清单有 `force_versions` 时完整接管强制判定，空名单表示不强制，缺失才兼容 `force` / `force_from` / 时间闸；旧字段仍保留。发布专用策略放 `scripts/release-update-policy.json`，先生成候选资产，安装包可用后才公开。`force_from` 不被 4.1.0 以下历史启动器识别，不能承诺只影响上一版；详情见 `docs/强制更新与熔断.md`。
  - 发现版本号不符合规范时，先提醒开发者和用户，不要发布；`release-check` 会拦截新增功能放错补丁版本的情况。
- **构建测试范围**：只有第二位版本号增加（确实新增了功能）时才做完整构建和安装包测试；
  补丁版本和紧急热修只跑必要回归、发布自检和受影响模块的测试，不做整包构建。
- **main 的必需检查必须每个 PR 都上报**：`protect-main` 要求 `测试 / 分层 / 编译` 和 `构建安装包`
  两个检查都通过才能合并，缺一个就合不了。所以 `installer.yml` 的 PR 触发**不能**加 `paths` 过滤，
  每个 PR 都要启动工作流、让 `构建安装包` 有结论；被 `paths` 挡掉的工作流会让检查永远停在
  「预期检查」，PR 直接卡死（#116 的教训）。
- **补丁也要上报构建检查，但跳过实际打包**：补丁版本的 PR 里，`构建安装包` 以「跳过」
  （skipped）状态上报，跳过算通过，不会真的打安装包；是否真打包仍由 `version-gate` 按版本号判断，
  版本号规则不变。不要为了省时间再给 PR 加路径过滤，也不要把这个检查改成可选。
- **不要补旧账**：发现已发布版本漏写了内容，不要回头补，直接记到下一个补丁版本，并说明是修正遗漏。

## 6. 根目录保持干净

根目录只放 GitHub 识别的文件、项目元数据和 EXE：

- 必须保留：`README.md`、`LICENSE`、`CONTRIBUTING.md`、`.gitignore`、`.gitattributes`、`.github/`、`WhaleLauncher.exe`。
- 兼容性例外，不要移动：`AGENTS.md`（agent 规则入口）、`package.json`（Node/npm 与启动器读版本）、`server.js`（内核入口，老快捷方式也靠它识别安装目录）、`release-manifest.json`（已发布启动器固定从根目录拉更新清单）。
- 其余文档放 `docs/`（`CHANGELOG.md`、`BUGS.md`、`NOTICE.md`、`PRIVACY.md`、`README.zh-CN.md`），配置模板放 `config/config.example.json`，Python 依赖放 `bridge/requirements.txt`。
- 新增文件先想清楚归属目录，不要再往根目录丢新的 `.md` / `.json` / `.txt` / `.js`。

## 7. Release 更新报告与用户摘要

- **`### 更新弹窗摘要` 必须是版本标题下的第一节**：写在 `## 4.1.0` 下一行之后、所有修复/改进小节之前；`scripts/release-notes.js` 按这个标题提取弹窗摘要，不要把它埋到版本末尾。
- **GitHub Release 正文是写给开发者的**：可以详细，但必须分类，保留「修复 / 改进 / 新增 / 其他」等小标题；同类条目合并，按用户影响或重要性排序，不堆无关噪音。
- **启动器更新弹窗是写给普通用户的**：只保留最重要的变化，最多 5 行，每行 `- ` 开头、不超过 15 个汉字（含标点），不写文件名、模块名、提交号、实现细节和排查过程。
- 详细内容留在 `docs/CHANGELOG.md` 摘要之后的正文和 GitHub Release 正文；弹窗摘要只做索引，让用户快速知道“这版对我有什么影响”。
- 示例（启动器弹窗）：
  ```
  修复启动器残留
  同一账号多窗口
  恢复朋友圈日记
  官网域名已更新
  ```

## 8. 第三方 / 环境目录只读

以下目录是**上游源码、生成产物或运行环境**，默认只读，禁止为了修 bug 直接改里面的文件：

- `vendor/`（`vendor/wechatauto` 等固定上游源码）
- `runtime/`（随包 Node / Python / ffmpeg / .NET 运行时）
- `node_modules/`、`wheelhouse/`、`data/` 里的第三方缓存
- 任何 `dist-info/`、`site-packages/`、`.venv/`、`venv/`、`__pycache__/` 里的内容

需要兼容/修复时：

1. 优先写外部兼容层，例如 `bridge/moment_compat.py`、`bridge/wechatauto_*`、`scripts/prepare-*.py`，在加载或构建时注入；
2. 不修改 `vendor/wechatauto` 的源码；升级上游只做“替换目录 + 重算 `vendor/MANIFEST.sha256` + 更新版本断言/测试”，不手改文件；
3. `runtime/` 不手改；需要补丁时改 `scripts/build-runtime.ps1` 或 `scripts/prepare-*.py`，重新生成运行时；
4. 如果确实必须修改第三方源码，先在任务书/PR 说明原因，并把改动移出 vendor；否则 `tests/vendor-wechatauto.test.js`、构建期的 MANIFEST 校验或 CI 会失败。

