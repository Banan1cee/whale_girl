# 插件市场共享收藏

独立 HTTPS 服务。启动器生成一份随机安装凭据，数据库只保存它的 SHA-256。每个安装对每个插件只保留一条收藏记录，重复设置同一状态可以安全重试。

## 接口

- `GET /api/favorites?ids=text-counter,notes` 返回共享收藏总数。提供安装凭据时也返回该安装的收藏状态。
- `PUT /api/favorites` 接收 `{ "id": "text-counter", "favorited": true }`，通过 `Authorization: Bearer <安装凭据>` 标识本次操作的安装。该操作返回已确认的最新共享总数和收藏状态。

## 开发和部署

- 使用 Node 24 运行 `node --test worker/favorites.test.mjs`，验证重复收藏、两个安装共享同一总数、撤回和非法输入。
- `node build.mjs` 生成可直接粘贴至 Cloudflare Worker 编辑器的 `dist/server/index.mjs`。在 D1 执行 `drizzle/0000_favorites.sql`，把数据库绑为 `DB`。CLI 部署可从 `wrangler.example.jsonc` 复制配置并填入自己的 D1 数据库 ID。
- 自有 Node 24 服务器可运行 `node server.mjs`，使用 `WHALE_FAVORITES_DB` 指定持久化 SQLite 文件。服务默认监听 `127.0.0.1:8789`，由现有 HTTPS 反向代理接入。
- 更换公开端点时同步改 `launcher/PluginMarket.cs` 中的地址，并用真实客户端网络验证统计、收藏和取消。
