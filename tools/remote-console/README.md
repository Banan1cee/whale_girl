# 手机远程控制

## 使用教程

1. 安装鲸鲸时保留「安装手机远程控制」。打开鲸鲸，再打开同目录的「手机远程控制」文件夹。
2. 电脑双击「1 - 下载或安装 Tailscale」。手机按系统下载 Tailscale，然后两台设备登录同一个专用网络。[iPhone / iPad App Store](https://apps.apple.com/us/app/tailscale/id1470499037?ls=1) · [安卓官方下载](https://tailscale.com/download/android) · [安卓官方 APK](https://dl.tailscale.com/stable/#android)
3. 双击「2 - 一键打开控制台」，记下配对 Key，保持命令窗口开启。
4. 双击「3 - 一键复制手机访问地址」。按提示完成 Windows 权限确认和首次 HTTPS 授权，看到「地址已复制」后把网址发给自己的手机。
5. 手机用浏览器打开网址，首次输入配对 Key。以后用同一浏览器打开同一个网址。

电脑保持通电和联网，桌面鲸鲸和第 2 步窗口保持开启。手机控制台通过 Tailscale Serve 提供 HTTPS 访问。[Tailscale Serve 文档](https://tailscale.com/docs/features/tailscale-serve)

## 功能介绍

- 手机可以停止内核、看诊断，并调整人设、模型、群聊和桥接设置。桌面启动器以管理员权限运行时，请在电脑上启动内核或重启程序。
- 表情包、语音发送和朋友圈发表使用桌面端的总开关。朋友圈的自动读取、自动点赞和定时发表各有独立设置。
- 配对 Key 允许启停应用和更改设置，只输入到你自己的设备。首次授权完整系统权限的 JavaScript 插件、设置微信数据库路径，请在电脑上操作。改模型接口站点时填写对应 API Key。
- 关闭第 2 步窗口可以停止控制台，停用转发时按 Tailscale 文档关闭对应 Serve 端口。要换配对 Key，关闭窗口后删除当前 Windows 用户 `%LOCALAPPDATA%\WhaleGirlRemoteConsole\saved-pairing-8790.xml`，再打开第 2 步。自定义端口用户使用对应端口号的文件。[停用 Serve](https://tailscale.com/docs/reference/examples/serve)

## 测试

在源代码根目录运行 `node tests/phone-remote-console.test.js`。测试使用本机模拟服务，覆盖配对、开关、离线设置和表情包预览。
