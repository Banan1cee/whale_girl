# theme-minimal（0 级主题示例）

整目录复制这个目录改成自己的主题，再改 `plugin.json` 与 `theme.json` 里的 `id`/`name`/`author`。

| 项 | 值 |
| --- | --- |
| 等级 | 0（`theme-data`，入口 `theme.json`） |
| provides | 无，清单里必须是 `{}` |
| calls | `[]`（0 级不能声明宿主能力） |
| dataAccess | 不能声明（0 级没有执行体，也没有数据访问） |

## 已知限制

- 只改颜色、字体、圆角、间距与弹窗底色；改不了文案、布局、导航、弹窗内容，更碰不到授权与更新界面。
- `theme.json` 上限 64 KiB、UTF-8 无 BOM；一个 token 都没有的主题会被拒绝。
- 对比度硬性要求：`text` 对 `background`/`surface`/`dialog.surface` 至少 4.5，`accent` 对 `background` 至少 3.0。
- `font.family` 只能填启动器内置字体名，越界会被判不合规。
- 启用即生效，没有授权确认；也没有任何可执行代码。

## 校验

```bash
node scripts/plugin-cli.js validate examples/theme-minimal
node scripts/plugin-cli.js test examples/theme-minimal
node scripts/plugin-cli.js pack examples/theme-minimal --out theme-minimal.zip
node scripts/plugin-cli.js trial examples/theme-minimal
```
