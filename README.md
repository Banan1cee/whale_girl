[English](README.md) | [中文](docs/README.zh-CN.md)

# 🐋 Whale Girl

[![GitHub release](https://img.shields.io/github/v/release/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/python-3.12-3776AB)](https://www.python.org/)
[![Wechatauto](https://img.shields.io/badge/wechatauto-1.2.10-4B8BBE)](https://pypi.org/project/wechatauto-replica/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![GitHub stars](https://img.shields.io/github/stars/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/stargazers)

A local-first AI companion for WeChat. She replies in group chats, remembers what people tell her, and can also send stickers, voice messages, and daily diary entries.

Everything is controlled from one Windows launcher. There is no browser UI; `127.0.0.1:8787` only serves the local HTTP API.

> **Just want to run it?** Download `whale-girl-*-setup.exe` from [Releases](https://github.com/Banan1cee/whale_girl/releases/latest).
> The installer includes Node.js, Python 3.12 and the .NET 10 desktop runtime, so no extra downloads are needed.

---

## What it does

- **WeChat replies** — answers @-mentions and her name in groups, keeps a conversation going while it is alive, and stays quiet when the topic ends.
- **Memory** — records facts from private chats, compresses older group history, and stays silent when an image or sticker cannot be read.
- **Human-like delivery** — splits a reply into short bubbles, avoids trailing punctuation, and rewrites repeated or parroted replies once.
- **Extras** — stickers, Moments reading and manual interaction, Markdown diary, voice replies, web search, hot lists, and basic group admin.
- **One control panel** — start, stop, configure, and diagnose everything from `WhaleLauncher.exe`.

## Requirements

- Windows 10 or 11
- A logged-in WeChat 4.x account (a secondary account is recommended)
- One model API key: DeepSeek, Zhipu GLM, SiliconFlow, Qwen, Doubao, OpenCode, or any OpenAI-compatible endpoint
- Optional: Ollama or another local OpenAI-compatible server
- Administrator rights for WeChat UI automation
- Install into an **ASCII-only path** such as `D:\whale-girl`; Chinese characters in the path can break WeChat automation

## Install and first run

1. Download `whale-girl-*-setup.exe` from [Releases](https://github.com/Banan1cee/whale_girl/releases/latest) and run it.
2. Open the **Whale Girl** desktop shortcut.
3. In the launcher, open **Settings**, choose a model provider, and fill in the API key.
4. Open **WeChat bridge**, select the account, then press **Start**.
5. Wait until the Status page shows both the kernel and the bridge as running.

The installer bundles the Node.js runtime, Python 3.12, `wechatauto`, and the .NET 10 desktop runtime. The launcher prefers bundled runtimes and falls back to `PATH` only when needed. No `npm install` is required.

## Main features

| Feature | What it does |
| --- | --- |
| WeChat group replies | Replies to @-mentions and her name; ignores unrelated arguments |
| Memory | Remembers owner facts and compresses old group conversations |
| Stickers | 27 built-in images plus custom categories; sending is off by default |
| Moments | Reads the selected account's local cache; manual like, comment, and copy-draft |
| Diary | Writes at most one Markdown entry per day to `data/diary/YYYY/MM-DD.md` |
| Voice | Transcribes incoming voice; optional voice replies through BreezeBlue, MiniMax, or SiliconFlow |
| Search | Bing with a 360 fallback, Bilibili/Weibo hot lists, Toutiao, and link extraction |
| Group admin | Mute/unmute, switch model, change tone, clear memory, and low-battery good-night |
| Diagnostics | Built-in logs, account checks, UIA self-test, and update checks |

Detailed behavior and configuration are documented under [`docs/`](docs/).

## Updates and stopping

- **Update**: open **Check for updates** in the launcher. It reads `release-manifest.json`, downloads the official installer, verifies SHA256, and installs over the old version. `data/` and `config.json` are preserved.
- **Stop**: press **Stop** in the launcher, then close it. The kernel and bridge stop together.
- **Optional cleanup**: after closing the launcher, run `powershell -File scripts\stop-all.ps1` if a process is left behind. It writes `data\PAUSED` so nothing restarts automatically.
- **Resume**: open `WhaleLauncher.exe` and press **Start**; the pause marker is cleared.

## Configuration

Most settings live in the launcher's **Settings** page. Advanced users can edit `config.json` directly. The template is [`config/config.example.json`](config/config.example.json); `config.json` is git-ignored.

| Field | Meaning |
| --- | --- |
| `provider` / `deepseek.apiKey` | Model provider and key |
| `persona.master.names` / `persona.master.wxids` | Who counts as the owner |
| `gateway.wechat.inboundToken` | Bridge token; change it from the default |
| `group.requireAt` | Whether group messages must @ the bot first |
| `chat.privateMaxChars` | Reply length limit |
| `diary.enabled` / `diary.time` | Daily diary switch and generation time |

The full field list is in [`docs/设置说明.md`](docs/设置说明.md). Owner and admin rules are explained there as well.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/设置说明.md`](docs/设置说明.md) | All configuration fields and admin commands |
| [`docs/接入微信.md`](docs/接入微信.md) | WeChat bridge, UIA elevation, multi-account notes |
| [`docs/日记功能.md`](docs/日记功能.md) | Diary behavior and troubleshooting |
| [`docs/朋友圈实现.md`](docs/朋友圈实现.md) | Moments cache, reading, and manual interaction |
| [`docs/搜索模块.md`](docs/搜索模块.md) | Search sources and relevance rules |
| [`docs/维护手册.md`](docs/维护手册.md) | Recovery, logs, backup, and factory reset |
| [`docs/架构总览.md`](docs/架构总览.md) | Kernel, bridge, launcher, and data flow |
| [`docs/打包与签名.md`](docs/打包与签名.md) | Build, packaging, signing, and release steps |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Full change history |

## Project structure

```
whale-girl/                        # repository layout; runtime data is never committed
├─ server.js                       # HTTP server and webhooks
├─ WhaleLauncher.exe               # the only GUI entry point
├─ package.json
├─ release-manifest.json
├─ README.md                       # this file
├─ CONTRIBUTING.md
├─ AGENTS.md
├─ LICENSE
├─ .gitignore
├─ .gitattributes
├─ .github/                        # CI and releases
├─ config/
│  └─ config.example.json          # configuration template
├─ src/                            # Node.js kernel
│  ├─ adapters/                    # outbound integrations
│  ├─ core/                        # decisions and parsing
│  ├─ http/                        # routes and security gates
│  ├─ infra/                       # configuration and infrastructure
│  ├─ llm/                         # model client
│  ├─ memory/                      # memory and token budget
│  ├─ persona/                     # persona and prompts
│  ├─ pipeline/                    # message orchestration
│  └─ services/                    # stateful services
├─ bridge/                         # Python bridge
├─ launcher/                       # WPF launcher source
├─ installer/                      # Inno Setup (bundled compiler)
├─ scripts/                        # build and maintenance scripts
├─ assets/                         # persona presets and lexicons
├─ examples/                       # bridge entry and media fallbacks
├─ docs/                           # documentation
├─ website/                        # static project site
├─ vendor/                         # pinned wechatauto source
└─ tests/                          # tests
```

Not committed; generated at runtime: `data/` (keys, memory, logs), `runtime/` (bundled Node and Python), `artifacts/` (build output), and `config.json` (local configuration).

## Development

Development, tests, packaging, and release steps are in [CONTRIBUTING.md](CONTRIBUTING.md).
The kernel uses CommonJS and has zero npm runtime dependencies. Tests run with `node tests/<name>.test.js`; see [`docs/回归测试覆盖对照.md`](docs/回归测试覆盖对照.md) for coverage notes.

## Security and privacy

### Third-party plugin disclaimer

Community plugins are developed and maintained by their respective authors. Marketplace listing, checksums, scans or reviews do not guarantee that a plugin is free of malware or vulnerabilities, and do not constitute a security endorsement. Local ZIP packages have not gone through marketplace submission checks.

Plugins may cause privacy leaks, data loss, crashes, unintended messages, account restrictions or third-party service charges. Check the source, version and permissions, back up important data and test carefully before enabling a plugin. Stop or uninstall suspicious plugins and report the plugin ID and version. Uninstalling cannot undo messages already sent or data already disclosed.

To the extent permitted by applicable law, third-party plugins are provided as-is without additional warranties from the Whale Girl project or marketplace maintainers; liability remains subject to applicable law and any express agreement. This notice does not waive users' statutory rights or exclude liabilities that cannot legally be excluded, and does not replace security controls or review. Read the [full plugin disclaimer](docs/插件免责声明.md), also available inside the marketplace.

- The API binds to `127.0.0.1:8787` by default. **Never expose it to the internet**; there is no login layer.
- `data/` and `config.json` are git-ignored. Never commit API keys, WeChat IDs, group IDs, or chat history.
- The bridge uses UI automation and reads the local WeChat database. It does not patch WeChat or inject code, but it may still violate WeChat's terms of service. Use it at your own risk.
- Replies are generated by a model. Be careful with `admin.allowAll` and automatic replies in public groups.
- Privacy policy: [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Download

Only download installers from **GitHub Releases**: <https://github.com/Banan1cee/whale_girl/releases>. Checksums and verification commands are in [`docs/DOWNLOAD.md`](docs/DOWNLOAD.md).

## Code signing policy

Current release builds are **not signed yet**, so Windows may show "Unknown publisher". Verify `SHA256SUMS.txt` from the release before installing. The signing policy is in [`docs/CODE_SIGNING_POLICY.md`](docs/CODE_SIGNING_POLICY.md); the privacy policy is in [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Articles

- **我在微信里养了个 AI 群友：零焦点 UIA 收发、本地数据、可换人设** — how the bridge talks to WeChat without stealing focus, the UIA/WM_CHAR version traps, and the personas system.
  - Zhihu: <https://zhuanlan.zhihu.com/p/2103852627175986683>
  - Copy in this repo: [`docs/articles/wechat-ai-companion.md`](docs/articles/wechat-ai-companion.md)
## Acknowledgements

- **Character author 上善无形** — the Whale Girl icon is a derivative work based on their original character. See [`docs/NOTICE.md`](docs/NOTICE.md).
- **[wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)** (Apache-2.0) — Windows WeChat 4.x automation library. A pinned copy lives in `vendor/wechatauto/`; build-time and runtime patches are kept outside the upstream source.
- **[wxauto](https://github.com/cluic/wxauto)** (Apache-2.0) — the original Windows WeChat automation project whose approach inspired `wechatauto-replica`.
- **[VB-CABLE](https://vb-audio.com/Cable/)** — virtual audio cable used by optional voice sending; the installer only ships the official driver installer.

## License

**AGPL-3.0-only** — see [LICENSE](LICENSE). Commercial use is allowed, but modified versions distributed or offered over a network must provide the complete corresponding source. Keep the attribution in [`docs/NOTICE.md`](docs/NOTICE.md).
