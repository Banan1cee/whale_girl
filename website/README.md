# Whale Girl 主题官网

独立静态官网。零第三方运行依赖，使用 Node 脚本在部署时生成多页面；浏览器不请求 GitHub API、不连接本机程序。版本与插件目录使用真实来源，不手写版本号或编造市场条目。

## 修改指南

- `index.html`：首页宣传、更新报告弹窗、最近版本、团队与市场预览。
- `pages.css`：下载、市场、团队、支持与公示页的响应式样式。
- `site.js`：所有页面共用的主题、导航和渐进增强筛选；无 JavaScript 时列表与表格仍可阅读。
- `content/team.json`：经团队确认的成员职责、寄语与致谢名单。
- `content/tips.json`：人工核对后的公开打赏记录，禁止放入支付原始导出或未经同意的昵称与留言。
- `style.css`：响应式布局、明暗主题 token、动效；支持系统减少动态效果设置。
- `theme.js`：首屏主题初始化；优先本地选择，否则跟随系统。
- `app.js`：仅首页使用的报告弹窗、进入视口与叙事动效。
- `motion.js`：连续滚动叙事的进度计算与可逆过渡。
- `whale.svg`：首页原创矢量鲸鱼视觉。
- `images/`：网页用图片副本，原图保留在仓库原位置，不要反向覆盖原图。
- `fonts/`：本地 Noto Sans SC（思源黑体体系）400 / 500 / 600 字重及 OFL 许可。字体按当前页面文案和 ASCII 字符子集化；新增中文文案时需重新生成子集，否则新增字会使用系统后备字体。

- `scripts/fetch-website-data.js` 完整分页读取 GitHub Releases，并固定插件市场 `main` 的一个 commit，读取 `index.json`、`index-v2.json`、`index-v3.json`、`index-v4.json`、`index-personas.json`。缺失或异常时终止部署，不把失败当作空市场发布。
- `scripts/build-website.js` 生成 `downloads/`、每版详情、`plugins/`、每插件详情、`support/`、`support/transparency/` 与 `team/`，同时生成 sitemap 和 robots。首页版本区沿用 `scripts/render-website-releases.js`。
- 下载历史只包含真实 Release，草稿不可见，预览版明确标注。旧版页面不能链接 `releases/latest`；只展示该版实际存在的资产、大小与 GitHub 提供的 SHA-256（如有）。插件 ZIP 固定到目录快照 commit。
- API 3 与 API 4 的能力说明分开。JavaScript API 4 必须使用独立目录、最低客户端不低于 4.1.2、声明 `system.full`；详情页明确完整系统权限、非沙箱、默认实验总闸关闭和逐插件授权。所需客户端尚未发布时显示开发测试提示，不把 main 上的实现冒充正式发行。
- GitHub Pages 使用 `.github/workflows/pages.yml` 自动生成与部署。保留正式发行事件触发、每日刷新和手动触发；插件市场更新最迟在下一次官网刷新同步。直接打开源码 `index.html` 不等于完整生成后的官网。
- Pages 上传与部署使用包含 run ID 和 attempt 的同一产物名；`scripts/wait-pages-artifact.js` 在上传后最多查询 12 次，确认元数据可见且没有重名后才部署，避免重跑污染。查询失败、过期、重名或等待超时均终止，不删除其他运行的产物。

### 本地预览

在仓库根目录执行，输出使用独立临时目录或被忽略的 `artifacts/`，不要覆盖 `website/`：

```powershell
node scripts/fetch-website-data.js artifacts/website-data.json
node scripts/build-website.js artifacts/website-data.json artifacts/website-preview
python -m http.server 8099 --directory artifacts/website-preview --bind 127.0.0.1
```

打开 `http://127.0.0.1:8099`。公开 GitHub API 有限流，需要时在环境中设置 `GH_TOKEN`，不要写进文件。只更新官网无需重发启动器 EXE。

本机若出现 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 且组织证书已安装到系统信任库，可在支持该选项的 Node 上使用 `node --use-system-ca scripts/fetch-website-data.js ...`；不要关闭 TLS 校验。

新文案的字体补集使用 `scripts/subset-website-fonts.py`：在已有 Python/fontTools 的开发环境中，以 Google Fonts 官方 `ofl/notosanssc/NotoSansSC[wght].ttf` 为源字体、生成后的站点为字集来源。保留旧字集，分别输出 400/500/600 字重；字体许可仍为 `fonts/OFL.txt`。该工具不参与客户端运行，也不在 CI 自动下载字体。

真实浏览器验收可使用已安装的 Chrome/Edge，无 npm 测试依赖：

```powershell
node scripts/verify-website.js artifacts/website-preview "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

检查手机和桌面宽度的横向溢出、图片、筛选、导航、主题、减少动态效果和无脚本可读性；截图默认写入被忽略的 `artifacts/website-screenshots/`。

### 打赏公示维护

收款入口为团队确认的 `https://afdian.com/a/Banan1ce`。这是**团队创作打赏**，不是限定用途项目经费，不承诺全部用于服务器开销；不公开团队个人支出。官网没有支付后台，也不会自动同步爱发电订单。

`content/tips.json` 初始 `updatedAt: null`、`entries: []` 表示尚未公布记录，**不表示没有收到打赏**。首次公布时设置日期；每次更新均人工核对。每条仅允许以下字段（金额以人民币整数分保存，避免浮点计算误差）：

```json
{
  "updatedAt": "2026-11-13",
  "entries": [
    { "id": "tip-example", "date": "2026-11-12", "amountMinor": 500, "currency": "CNY", "consent": false }
  ]
}
```

上例仅为格式示意，不是真实打赏，不能作为初始数据上传。匿名记录不写 `name` 和 `message`。仅在获得展示同意后填写 `consent: true`、`name`（公开昵称）、`message`（可选公开留言）。`id` 使用自行生成的公示编号，不用原始订单号。日期不得晚于更新日，ID 不重复。金额口径为平台记录的打赏金额、未扣手续费；已公示合计不是实时余额。

只提交公开的最小数据。真实姓名、手机号、支付账号、完整订单号、原始付款截图与原始导出表均不得进仓库。更正或匿名请求通过爱发电联系团队后人工处理。生成器拒绝未同意的姓名留言、未知字段、非法日期和非整数金额。

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
- 团队与致谢头像为对应 GitHub 个人资料头像的本地快照，保存在 `images/team/`，仅用于对应成员身份展示，不作为可再分发的通用素材。成员名称、职责和寄语来自团队确认；不公开提交邮箱。
- 插件市场结构参考 dshmarket.com；打赏、公示的信息组织参考 PRTS、企鹅物流、Thunderbird 与 VideoLAN，未复制其图片、收款码、样式或源代码。没有可靠截图、许可、检测报告时不伪造信息。

### 视觉与动效

白底配色参考 [Colorhero 的 Warm Neutral Light](https://colorhero.io/blog/modern-ui-color-schemes-users-love) 和 [Recolor 的 Sea glass 系列](https://recolor.page/palettes/teals/)，按鲸鱼主题调整为：白色 `#FFFFFF`、墨青 `#183332`、深青按钮 `#175C56`、海盐表面 `#F3F7F6`，辅以浅绿 `#EEF5F1` 与暖白 `#F6F4EF`。网页文字与按钮对比需按实际 token 检查，参考网站的结论不代替本项目验证。

首屏分层入场、鲸鱼浮游、流动光轨、卡片滚动入场和桌面指针倾斜使用 CSS 与原生 JS。首屏底部可暂停动画；系统开启减少动态效果时自动使用静态模式。手机使用单列内容与折叠菜单，桌面使用双列布局，指针动效仅启用于精细指针设备。

连续滚动叙事参考 [Apple AirPods Pro 官网](https://www.apple.com/airpods-pro/) 和 [Awwwards 对 Apple 团队的设计访谈](https://www.awwwards.com/airpods-pro-wins-site-of-the-month-january.html)：使用驻留视觉、按滚动进度推进的三段故事、可逆过渡与共享背景来连接章节。`motion.js` 按位置求值，前后滚动都可重放；各章节也保留持续的微动效。短屏与横屏自动切回自然排版。未使用苹果图片、视频或源代码。角色表情、对话气泡、记忆节点按阶段切换；网络线条、光轨和微浮动保持持续运动。首页与角色段落共用 `.journey` 背景，`entrance` 进度控制前景交接。

### 隐私

网站不收集访客数据；仅在浏览器 localStorage 保存主题偏好。筛选在浏览器本地进行，字体、图片与头像随官网托管。跳转 GitHub、爱发电等外站后适用对应网站的隐私规则；站内公开打赏数据经人工筛选和同意核对。
