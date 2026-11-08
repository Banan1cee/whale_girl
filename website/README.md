# Whale Girl 主题官网

独立静态宣传网站源码。无依赖、无构建，直接编辑 `website/` 下的文件即可。版本区由 GitHub Releases 生成，不手写版本号。

## 修改指南

- `index.html`：宣传内容、更新报告弹窗、最近发行版本、作者寄语、下载链接与 SEO 描述。
- `style.css`：响应式布局、明暗主题 token、动效；支持系统减少动态效果设置。
- `theme.js`：首屏主题初始化；优先本地选择，否则跟随系统。
- `app.js`：主题切换、移动导航、报告弹窗、进入视口动效。
- `motion.js`：连续滚动叙事的进度计算与可逆过渡。
- `whale.svg`：首页原创矢量鲸鱼视觉。
- `images/`：网页用图片副本，原图保留在仓库原位置，不要反向覆盖原图。
- `fonts/`：本地 Noto Sans SC（思源黑体体系）400 / 500 / 600 字重及 OFL 许可。字体按当前页面文案和 ASCII 字符子集化；新增中文文案时需重新生成子集，否则新增字会使用系统后备字体。

- 版本区由 `scripts/render-website-releases.js` 从 GitHub Releases 生成，自动显示最新正式版与最近两次其它正式发行；不要手写版本号或造假数据。完整更新历史见仓库 `docs/CHANGELOG.md` 与 Releases。下载按钮打开官方最新 Release，让用户选择实际存在的安装资产。作者寄语为明确标注的待确认草稿，正式上线前由作者确认或替换。

## 规范

### 域名

正式域名是 `bot.zyyc.cc`，不要使用 `www.` 前缀。换域名时以下三处必须同时改，缺一处就会出现 canonical 与实际访问地址不一致：

1. `website/CNAME`：只写裸域名，例如 `bot.zyyc.cc`。
2. `index.html` 的 `<link rel="canonical">`：与 CNAME 完全一致，保留结尾 `/`。
3. GitHub 仓库 **Settings → Pages → Custom domain**：与 CNAME 完全一致。

`website/CNAME` 会随 Actions 产物一起发布；DNS 与 Pages 自定义域名在仓库外配置，改域名时一并在对应平台更新。

### 内容

- 只写已确认的事实与已发行版本，不虚构功能、数据或用户评价。
- 对话、角色场景均为示意文案，需明确标注。
- 页面全部使用相对路径，保证托管在子路径下也能正常加载。
- 维护 `index.html` 中的 SEO 描述、canonical 与下载链接，避免指向失效资产。

### 资源与许可

- `images/launcher-icon.png` 需与启动器 `launcher/Assets/app.png` 字节一致，同时用于页头、页脚和 favicon。图标原创角色作者为上善无形，本项目图标为二创作品；署名与使用边界见 `docs/NOTICE.md`。
- 01 / 02 / 03 角色场景使用项目现有鲸鱼娘素材：`assets/stickers/开心/whale-02078503148a8b78.png`、`assets/stickers/傲娇/whale-05e27f4bea539577.png`、`assets/stickers/傲娇/whale-fc820657b91d8fa7.png`。在 `website/images/` 保存 WebP 网页副本（共约 197 KiB），原图未修改。
- 不引入未授权字体、图片、视频或第三方脚本；新增外部素材需先确认许可证并补充署名。

### 视觉与动效

白底配色参考 [Colorhero 的 Warm Neutral Light](https://colorhero.io/blog/modern-ui-color-schemes-users-love) 和 [Recolor 的 Sea glass 系列](https://recolor.page/palettes/teals/)，按鲸鱼主题调整为：白色 `#FFFFFF`、墨青 `#183332`、深青按钮 `#175C56`、海盐表面 `#F3F7F6`，辅以浅绿 `#EEF5F1` 与暖白 `#F6F4EF`。网页文字与按钮对比需按实际 token 检查，参考网站的结论不代替本项目验证。

首屏分层入场、鲸鱼浮游、流动光轨、卡片滚动入场和桌面指针倾斜使用 CSS 与原生 JS。首屏底部可暂停动画；系统开启减少动态效果时自动使用静态模式。手机使用单列内容与折叠菜单，桌面使用双列布局，指针动效仅启用于精细指针设备。

连续滚动叙事参考 [Apple AirPods Pro 官网](https://www.apple.com/airpods-pro/) 和 [Awwwards 对 Apple 团队的设计访谈](https://www.awwwards.com/airpods-pro-wins-site-of-the-month-january.html)：使用驻留视觉、按滚动进度推进的三段故事、可逆过渡与共享背景来连接章节。`motion.js` 按位置求值，前后滚动都可重放；各章节也保留持续的微动效。短屏与横屏自动切回自然排版。未使用苹果图片、视频或源代码。角色表情、对话气泡、记忆节点按阶段切换；网络线条、光轨和微浮动保持持续运动。首页与角色段落共用 `.journey` 背景，`entrance` 进度控制前景交接。

### 隐私

网站不收集访客数据；仅在浏览器 localStorage 保存主题偏好。
