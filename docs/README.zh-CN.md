[English](../README.md) | [中文](README.zh-CN.md)

# 🐋 鲸鲸 Whale Girl

[![GitHub release](https://img.shields.io/github/v/release/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/python-3.12-3776AB)](https://www.python.org/)
[![Wechatauto](https://img.shields.io/badge/wechatauto-1.2.10-4B8BBE)](https://pypi.org/project/wechatauto-replica/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![GitHub stars](https://img.shields.io/github/stars/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/stargazers)

一个运行在本机的 AI 微信伙伴。她会在群里接话、记住别人说过的事，也能发预设表情包、语音和每日日记。

所有操作都在一个 Windows 启动器里完成。浏览器不再提供控制台；`127.0.0.1:8787` 只给启动器和桥接调用本地 HTTP API。

> **想直接使用？** 到 [Releases](https://github.com/Banan1cee/whale_girl/releases/latest) 下载 `whale-girl-*-setup.exe`。
> 安装包已带 Node.js、Python 3.12 和 .NET 10 桌面运行时，装完不用再补依赖。

---

## 她能做什么

> **第三方插件免责声明：** 社区插件由各自作者提供，市场收录、校验、扫描或审核不保证无病毒、无漏洞，也不构成安全担保。使用可能造成隐私泄露、数据损坏、异常发言、账号风险或第三方费用；本地 ZIP 未经市场上架流程核验。安装、更新和启用前请核对来源与权限、备份并谨慎测试，发现异常立即停用并反馈。在适用法律允许的范围内，项目及市场维护者不就第三方插件作额外保证，相关责任以适用法律及明确约定为准；本说明不免除依法不得免除的责任，也不剥夺用户法定权利。详见[完整免责声明](插件免责声明.md)，软件内「插件市场 → 免责声明」也可阅读。

- **微信群回复**：只认 @ 和叫名字；被叫到后接着聊，冷场或换话题就闭嘴。
- **记忆**：记住私聊里自报的事实，把更早的群聊压成摘要；图片或表情包识别失败时保持沉默。
- **像真人**：一句话拆成几条短消息，不带多余的波浪号和句号；模型复读会自动重写一次。
- **附加功能**：预设表情包、朋友圈只读与手动互动、Markdown 日记、语音回复、联网搜索、热榜和基础群管理。
- **一个控制面板**：启动、停止、设置和诊断都在 `WhaleLauncher.exe` 里。

## 使用条件

- Windows 10 / 11
- 一个已登录的微信 4.x 账号，建议使用小号
- 一个模型 API Key：DeepSeek、智谱 GLM、硅基流动、通义千问、豆包、OpenCode，或任何 OpenAI 兼容接口
- 可选：Ollama 或其他本地 OpenAI 兼容服务
- 微信 UI 自动化需要管理员权限
- **安装到纯英文路径**，例如 `D:\whale-girl`；路径里有中文可能导致微信自动化失败

## 安装与首次启动

1. 从 [Releases](https://github.com/Banan1cee/whale_girl/releases/latest) 下载 `whale-girl-*-setup.exe` 并运行。
2. 打开桌面上的 **鲸鲸** 快捷方式。
3. 在启动器「设置」里选择模型服务商，填入 API Key。
4. 打开「微信桥接」，选择账号，点右上角「启动」。
5. 等「状态」页显示内核和桥接都在运行即可。

安装包自带 Node.js 运行时、Python 3.12、`wechatauto` 和 .NET 10 桌面运行时。启动器优先使用包内运行时，找不到才回退系统 `PATH`；不需要执行 `npm install`。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 微信群回复 | 回复 @ 和叫名字；别人互骂时不插嘴 |
| 记忆 | 记录主人相关事实，压缩旧群聊 |
| 表情包 | 27 张内置图片和自定义分类；发送默认关闭 |
| 朋友圈 | 读取当前账号本地缓存；支持手动点赞、评论和复制文案 |
| 日记 | 每天最多一篇，保存到 `data/diary/YYYY/MM-DD.md` |
| 语音 | 收到的语音先转文字；可选 BreezeBlue、MiniMax、硅基流动发语音 |
| 联网 | Bing + 360 备用源，B 站/微博热搜、头条热榜和链接正文抓取 |
| 群管理 | 禁言/解禁、切模型、切语气、清记忆、低电量晚安 |
| 诊断 | 日志、账号检查、UIA 自检和更新检查都在启动器里 |

详细行为和配置见 [`docs/`](README.zh-CN.md)。

## 更新与停止

- **更新**：在启动器点「检查更新」。它会读 `release-manifest.json`、下载官方安装包、校验 SHA256 后覆盖安装；`data/` 和 `config.json` 不会被改动。
- **停止**：在启动器点「停止」，然后关闭启动器；内核和桥接会一起退出。
- **可选清理**：如果关闭启动器后还有残留进程，运行 `powershell -File scripts\stop-all.ps1`。它会写 `data\PAUSED`，防止自动重启。
- **继续使用**：重新打开 `WhaleLauncher.exe`，点「启动」即可清除暂停标记。

## 配置

大部分设置在启动器「设置」页完成。高级用户可以直接编辑 `config.json`；模板是 [`../config/config.example.json`](../config/config.example.json)，`config.json` 已被 `.gitignore` 忽略。

| 字段 | 说明 |
| --- | --- |
| `provider` / `deepseek.apiKey` | 模型服务商与 Key |
| `persona.master.names` / `persona.master.wxids` | 谁是主人 |
| `gateway.wechat.inboundToken` | 桥接 token，务必改掉默认值 |
| `group.requireAt` | 群里是否必须先 @ |
| `chat.privateMaxChars` | 回复长度上限 |
| `diary.enabled` / `diary.time` | 自动日记开关与生成时间 |

完整字段见 [`设置说明.md`](设置说明.md)，主人和管理员规则也在里面。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`设置说明.md`](设置说明.md) | 全部配置项和管理员命令 |
| [`接入微信.md`](接入微信.md) | 微信桥接、UIA 提权、多开说明 |
| [`日记功能.md`](日记功能.md) | 日记行为和故障排查 |
| [`朋友圈实现.md`](朋友圈实现.md) | 朋友圈缓存、读取和手动互动 |
| [`搜索模块.md`](搜索模块.md) | 搜索来源与相关性规则 |
| [`维护手册.md`](维护手册.md) | 日志、备份、自救和恢复出厂 |
| [`架构总览.md`](架构总览.md) | 内核、桥接、启动器和数据流 |
| [`打包与签名.md`](打包与签名.md) | 构建、打包、签名和发版步骤 |
| [`CHANGELOG.md`](CHANGELOG.md) | 完整更新记录 |

## 目录结构

```
whale-girl/                        # 与仓库一致，运行数据不入库
├─ server.js                       # HTTP 服务与 webhook
├─ WhaleLauncher.exe               # 唯一图形入口
├─ package.json
├─ release-manifest.json
├─ README.md
├─ CONTRIBUTING.md
├─ AGENTS.md
├─ LICENSE
├─ .gitignore
├─ .gitattributes
├─ .github/                        # CI 与发布
├─ config/
│  └─ config.example.json          # 配置模板
├─ src/                            # Node.js 内核
│  ├─ adapters/                    # 对外适配层
│  ├─ core/                        # 判定与解析
│  ├─ http/                        # 路由与安全闸
│  ├─ infra/                       # 配置与基础设施
│  ├─ llm/                         # 模型客户端
│  ├─ memory/                      # 记忆与 token 预算
│  ├─ persona/                     # 人设与提示词
│  ├─ pipeline/                    # 消息编排
│  └─ services/                    # 状态型服务
├─ bridge/                         # Python 桥接
├─ launcher/                       # WPF 启动器源码
├─ installer/                      # Inno Setup（自带编译器）
├─ scripts/                        # 构建与维护脚本
├─ assets/                         # 人设预设与词库
├─ examples/                       # 桥接入口与媒体兜底
├─ docs/                           # 文档
├─ website/                        # 静态官网
├─ vendor/                         # 固定版 wechatauto
└─ tests/                          # 测试
```

以下不入库，运行期自动生成：`data/`（Key、记忆、日志）、`runtime/`（自带 Node 与 Python）、`artifacts/`（构建产物）、`config.json`（本地配置）。

## 开发

开发、测试、打包和发版步骤见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
内核使用 CommonJS，零 npm 运行时依赖；测试逐文件运行 `node tests/<名字>.test.js`，覆盖说明见 [`回归测试覆盖对照.md`](回归测试覆盖对照.md)。

## 安全与隐私

- 默认只监听 `127.0.0.1:8787`，**不要暴露到公网**；没有登录鉴权。
- `data/`、`config.json` 已被 git 忽略；不要提交 API Key、微信号、群号或聊天记录。
- 微信桥接使用 UI 自动化并只读本地数据库，不修改微信客户端、不注入代码，但仍可能违反微信使用条款，账号风险自负。
- 回复由大模型生成；公开群慎用 `admin.allowAll` 和自动回复。
- 隐私政策见 [`PRIVACY.md`](PRIVACY.md)。

## 下载

安装包只从 **GitHub Releases** 下载：<https://github.com/Banan1cee/whale_girl/releases>。校验值与验证命令见 [`DOWNLOAD.md`](DOWNLOAD.md)。

## 代码签名

当前发行包**尚未签名**，Windows 可能提示「未知发布者」；安装前请核对 Release 里的 `SHA256SUMS.txt`。签名策略见 [`CODE_SIGNING_POLICY.md`](CODE_SIGNING_POLICY.md)，隐私政策见 [`PRIVACY.md`](PRIVACY.md)。

## 致谢

- **图标原创角色作者：上善无形**。本项目使用的鲸鲸图标是在其原创角色基础上的二创作品，详见 [`NOTICE.md`](NOTICE.md)。
- **[wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)**（Apache-2.0）：Windows 微信 4.x 自动化库。固定副本在 `vendor/wechatauto/`，构建期和运行期补丁不修改上游源码。
- **[wxauto](https://github.com/cluic/wxauto)**（Apache-2.0）：Windows 微信自动化的先行项目，`wechatauto-replica` 的思路与接口源自它。
- **[VB-CABLE](https://vb-audio.com/Cable/)**：可选的语音发送虚拟声卡；安装包只附带官方安装程序。

## License

**AGPL-3.0-only**，见 [`../LICENSE`](../LICENSE)。允许商业使用，但分发修改版或通过网络提供服务时，必须按 AGPL-3.0 提供完整对应源代码。请保留 [`NOTICE.md`](NOTICE.md) 中的署名。
