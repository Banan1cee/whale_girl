# Whale Girl 主题官网

静态宣传站，无构建步骤，直接修改 `website/` 里的文件即可。

## 改内容

- `index.html`
  - 页面文案、功能卡片、更新报告弹窗、作者寄语、下载链接、SEO 描述都在这里。
  - 发行版本列表和更新报告要按真实 Releases 更新，不要写未单独发行的中间版本。
  - 当前列出的版本：`4.0.7`、`4.0.6`、`4.0.5`；`4.0.2–4.0.4` 未单独发版，已并入 `4.0.5`。
- `style.css`：颜色、间距、响应式布局、明暗主题和动效。
- `theme.js`：首屏主题初始化。
- `app.js`：主题切换、移动导航、报告弹窗、滚动入场。
- `motion.js`：滚动叙事与动画进度。
- `whale.svg`：首页鲸鱼矢量图。
- `images/`：页面图片；`launcher-icon.png` 要和 `launcher/Assets/app.png` 保持字节一致。
- `fonts/`：本地 Noto Sans SC 字体及 OFL 许可。新增中文文案后如果字形缺失，需要重新生成字体子集。

## 改域名

同时修改两处：

- `website/CNAME`：当前为 `bot.zyyc.cc`
- `index.html` 的 `<link rel="canonical">`

## 发布

推送 `main` 后由 `.github/workflows/pages.yml` 发布；只改 `website/` 即可，不需要构建命令。

网站不收集访客数据，只在浏览器 localStorage 保存主题偏好；页面里的对话均为示意文案。
