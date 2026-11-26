# 配方

每个配方都能落成一个可校验的项目。**四个完整项目在 `examples/` 下，整目录复制即可开写（每个目录是「清单 + 入口 + `README.md`」，照着 README 改成自己的）**：

| 目录 | 等级 | provides | calls | 什么时候抄它 |
| --- | --- | --- | --- | --- |
| `examples/theme-minimal` | 0 | 无 | 无 | 只想换颜色/字体/圆角/间距 |
| `examples/gate-quiet-hours` | 4 | `chat.pre_reply@1` gate/all | 无 | 想改变「这条回不回」，但不接管回复 |
| `examples/prompt-enhance` | 4 | `chat.prompt@1` enhance/all | 无 | 想在 system 里补一句，读 `settings` |
| `examples/tool-node` | 4 | `tool.run@1` tool/manual | `status.read@1`、`model.complete@1` | 手动工具，要读宿主状态或调模型 |

复制后至少改 `id`（不能和已装插件或市场条目重名）、`name`、`author`、`description`，每次发布升 `version`。

## 1. 最少 gate：安静时段

**何时用**：只在某些时段（或某些群）不接话，其他时候完全交回宿主。gate 不生成回复、不改提示词，所以不需要 `dataAccess`，也不需要 `calls`。

**声明**（`examples/gate-quiet-hours/plugin.json` 的全部内容）：

```json plugin-manifest
{
  "format": "whale-plugin/1",
  "level": 4,
  "id": "gate-quiet-hours",
  "name": "安静时段",
  "author": "你的名字",
  "version": "1.0.0",
  "minAppVersion": "4.3.0",
  "description": "群聊在 23:00–08:00 没人叫她就保持安静，其它时间交回宿主判断。",
  "entry": "plugin.js",
  "runtime": "node-full",
  "provides": {
    "chat.pre_reply@1": { "mode": "gate", "scope": "all" }
  },
  "calls": []
}
```

**入口**：`examples/gate-quiet-hours/plugin.js`。

- 只被「宿主基础检查通过」的消息问到：去重、禁言、静音、白名单、管理魔咒已经处理完，不会问你。
- 返回 `pass` 保留宿主原判定，`skip` 压制本轮，`wake` 让本来不回复的消息开口；抛异常等于 `pass`，不要用异常表达跳过。
- 多个 gate 按插件 id 顺序问，第一个非 `pass` 生效。
- 没传 `now`（更老的宿主）时示例会退化成 `pass`，不会误伤。

## 2. 提示词增强：追加一句风格

**何时用**：在宿主拼好的 system 后面加要求，不改回复正文。

**声明**（`examples/prompt-enhance/plugin.json` 的全部内容）：

```json plugin-manifest
{
  "format": "whale-plugin/1",
  "level": 4,
  "id": "prompt-enhance",
  "name": "提示词补一句",
  "author": "你的名字",
  "version": "1.0.0",
  "minAppVersion": "4.3.0",
  "description": "在本轮系统提示词末尾追加一句风格要求，句子的内容可以在设置里改。",
  "entry": "plugin.js",
  "runtime": "node-full",
  "provides": {
    "chat.prompt@1": { "mode": "enhance", "scope": "all" }
  },
  "calls": [],
  "dataAccess": ["model.prompt"],
  "settingsSchema": {
    "type": "object",
    "properties": {
      "suffix": {
        "type": "string",
        "maxLength": 200,
        "title": "追加的要求",
        "description": "留空则使用默认那句；不要写 Markdown"
      }
    },
    "additionalProperties": false
  }
}
```

**入口**：`examples/prompt-enhance/plugin.js`。

- `dataAccess` 少了 `model.prompt`：照旧被调用，但输入没有 `system`，返回的 `system` 也会被宿主换回上一层——不报错，也不生效。这是「为什么我改了提示词没用」的头号原因。
- 设置里没有默认值注入：`settings?.suffix` 可能是 `undefined`，代码自己兜。
- 返回的 `system` ≤64000；宿主已经有一份 system，这里返回的是**完整的新值**（enhance 语义）。

## 3. 模型工具：手动运行 + 计费调用

**何时用**：卡片「设置 → 运行一次」的手动工具，需要读宿主状态或让模型处理一段文本。

**声明**（`examples/tool-node/plugin.json` 的全部内容）：

```json plugin-manifest
{
  "format": "whale-plugin/1",
  "level": 4,
  "id": "tool-node-demo",
  "name": "演示工具",
  "author": "你的名字",
  "version": "1.0.0",
  "minAppVersion": "4.3.0",
  "description": "统计文本字数，或让模型把一段文字缩成一句话；后者会真的调用模型并计费。",
  "entry": "plugin.js",
  "runtime": "node-full",
  "provides": {
    "tool.run@1": { "mode": "tool", "scope": "manual" }
  },
  "calls": ["status.read@1", "model.complete@1"]
}
```

**入口**：`examples/tool-node/plugin.js`。

`model.complete@1` 的输入只有三个字段：

- `system`：≤64000，可省略；
- `turns`：`[{role: 'user'|'assistant', content}]`，最多 100 条，**字段名不是 `messages`**；
- `maxTokens`：1–32000，省略时宿主按 2000。

返回 `{text}`。要点：

- 这个能力联网且计费，`trial` 会标成 `requiresConsent: true`；试运行会真花钱。
- `chat.generate@1` 拿到的 `turns` **已经包含本轮用户消息**，不要再把 `message.text` 追成一条 user turn，否则模型会看到同一个问题两遍。
- 工具输入是任意 JSON：自己校验字段类型，坏输入返回有意义的 JSON，不要把异常抛成「插件坏了」。

## 4. 主题（0 级纯数据）

**声明**（`examples/theme-minimal/plugin.json` 的全部内容）：

```json plugin-manifest
{
  "format": "whale-plugin/1",
  "level": 0,
  "id": "theme-minimal",
  "name": "极简主题",
  "author": "你的名字",
  "version": "1.0.0",
  "minAppVersion": "4.3.0",
  "description": "只改启动器颜色、字体与圆角，没有执行体、不申请权限",
  "entry": "theme.json",
  "runtime": "theme-data",
  "provides": {},
  "calls": []
}
```

**入口**：`examples/theme-minimal/theme.json`。

- 顶层只允许 `schema`（固定 1）、`id`（必须等于清单 id）、`name`、`author`、`version`、`colors`、`font`、`metrics`、`dialog`。
- `colors` 只认 `accent`、`background`、`surface`、`text`、`muted`、`border`、`field` 七个语义键；`font.family` 只认 `Microsoft YaHei UI`、`Microsoft YaHei`、`Segoe UI`、`SimSun`（省略则保持内置字体）。
- `font.scale` 与 `metrics.spacing` 在 0.85–1.15；`metrics.corner`、`dialog.corner` 在 0–24。
- 对比度：`text` 对 `background`/`surface`/`dialog.surface` ≥4.5，`accent` 对 `background` ≥3.0。
- 64 KiB 上限，UTF-8 无 BOM；一个 token 都没有的主题会被拒绝。
- 0 级没有执行体：装上也改不了文案、布局、导航、弹窗内容，更碰不到授权/更新界面。

## 5. 回复改写与发送前清洗

两者都不需要 `calls`，但时机不同：`chat.reply@1` 在草稿阶段（能决定「发什么」），`chat.before_send@1` 在 `finalize` 之后（能决定「最终文本长什么样」，但拆气泡/字数上限在它之后）。

```js
'use strict';

exports.providers = {
  'chat.reply@1': ({ text }, { state }) => {
    const seen = Number(state.count || 0) + 1;
    return { text: text.slice(0, 300), state: { count: seen } };
  },
};
```

- `enhance` 的上一层结果在 `output`；`replace` 是独占的（两个 replace 会 `capability_owner_conflict`）。
- 输出省略 `state` 表示不修改；给了就完整替换，≤8 KiB。
- 想「同一个人 / 引用回复」用 `message.senderId`、`message.atMe`、`message.replyToBot`、`message.msgId`，不需要额外授权字段。

## 6. 全接管

```js
'use strict';

exports.providers = {
  'chat.handle@1': ({ message }) => {
    if (!message.text.includes('叫主人')) return { action: 'ignore', reason: 'not_mine' };
    return { action: 'reply', reply: '主人，我在。' };
  },
};
```

- `ignore` 的消息宿主不会再处理；没有「交回宿主」的返回值。
- `reply` 必须非空，否则 `invalid_capability_output`，本轮按忽略收尾。
- 回复仍走宿主的 `finalize`：配额、字数上限、安全兜底、拆气泡都只有宿主那一份实现；插件给的 `bubbles` 不会直接下发。
- 没有 `calls` 也能接管，但生成正文要自己写死或调 `model.complete@1`（记得声明）。

## 7. 检索结果

```js
'use strict';

exports.providers = {
  'chat.search@1': async ({ message }, { host }) => {
    const query = message.text.trim().slice(0, 200);
    if (!query) return { status: 'empty', text: '', items: [] };
    const found = await host.call('search.query@1', { query, freshness: 'week' });
    return { status: found.status, text: found.text, items: found.items };
  },
};
```

- 需要 `calls: ["search.query@1"]`；`search.query@1` 联网。
- 输出必须三个字段齐全：`text`（≤32000）、`items`（≤30，每项 `title`/`url`/`snippet` 必填）、`status`（`ok`/`empty`/`failed`）。
- 用 `enhance` 时上一层结果在 `previous`，适合在宿主检索结果上补充而不是替换。

## 8. 启停生命周期

**何时用**：插件需要在启动后做一次初始化（拉一次宿主状态、登记自己的定时项），或在正常停机时收尾。两个都是 observe，返回值会被丢弃。

```js
'use strict';

exports.providers = {
  'app.start@1': async ({ at, settings }, { host }) => {
    if (settings.enabled === false) return {};
    // settings 是授权时的快照；需要宿主数据只能走已声明的 calls。
    await host.call('status.read@1', {});
    return {};
  },
  'app.stop@1': () => ({}),
};
```

清单里写 `{"app.start@1":{"mode":"observe","scope":"all"},"app.stop@1":{"mode":"observe","scope":"all"}}`，`calls` 按实际用到的声明（示例要 `status.read@1`）。

- `app.start@1` 在运行时装配完成时触发，当前实现里 **listen 之前**：不要假设端口/网络已就绪。
- 同一授权快照只通知一次；运行中启用或改设置后，宿主在 reconcile 周期（约 500ms）内补发一次；单次失败不会自动重试。
- `app.stop@1` 只在正常停机时发，只发给「本进程通知过 start 且授权仍有效」的插件；宿主会等回调结束再终止 worker。
- **撤权优先**：停用/卸载/更新/改设置后旧快照立即失效，宿主不会再补 start，也不会对旧快照执行 stop——**撤权之后不保证收到 `app.stop@1`**，只保证不再运行旧代码。清理逻辑要幂等，并在下次 start 时自愈。
- 两次回调是各自独立的进程调用，模块变量不共享；要留状态写插件数据目录。

## 9. 定时任务

```js
'use strict';

exports.providers = {
  'task.tick@1': async ({ now, settings }, { host }) => {
    if (settings.enabled === false) return { skipped: true };
    const status = await host.call('status.read@1', {});
    return { at: now, running: status.running };
  },
};
```

- `provides` 里除了 `{"mode": "schedule", "scope": "all"}` 还要写 `"intervalSeconds": 60`（1–86400）。
- 输入是 `{scheduledAt, now, settings}`；`settings` 就是授权时的设置。没有 `state`。
- 每次调用是新进程，模块变量不保留；上一轮没跑完时宿主跳过这一轮，不会并发重入。
- 要长期状态就写工作目录（插件数据目录），见 `gotchas.md`。

## 10. 生成替换

```js
'use strict';

exports.providers = {
  'chat.generate@1': async ({ system, turns }, { host }) => {
    const base = typeof system === 'string' && system ? system : '你是鲸鲸，说话短。';
    const out = await host.call('model.complete@1', {
      system: `${base}\n只回答一句话。`,
      turns,
      maxTokens: 512,
    });
    return { text: String(out?.text || '').trim() };
  },
};
```

- `provides` 用 `{"mode": "replace", "scope": "all"}`；`calls` 要有 `model.complete@1`。
- `turns` 已含本轮用户消息（见配方 3），直接转发。但它是会话历史的一部分：清单没声明 `dataAccess: ["chat.history"]` 时宿主会把它清成 `[]`（字段仍在、插件照常运行），要让它看到前文就补上这条授权。返回空 `text` 会让宿主把本轮按忽略收尾。
- `system` 也要 `dataAccess: ["model.prompt"]` 才拿得到；没有就自己带一份固定 system（示例里就是这么兜的）。

## 11. settingsSchema 与代码默认值

```json
{
  "type": "object",
  "properties": {
    "enabled": { "type": "boolean", "title": "启用" },
    "groups": { "type": "string", "maxLength": 2000, "title": "群 ID", "description": "逗号分隔" },
    "ratio": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "additionalProperties": false
}
```

- 只允许注册表列出的关键字；根必须 `object`；深度 ≤8；`title` ≤40、`description` ≤200。
- **没有 `default`**：值没填就是 `undefined`，代码里 `settings.x ?? 默认`。
- 安装时初值是 `{}`，先过 schema 才算装好；`required` 会让「装上就不可用」，默认值请写代码里。
- 改设置会重签授权；需要跨版本保留的状态自己兜底，或用 `state`（只限四个聊天能力）。

## 12. Wasm（1–3 级）

下面是 2–3 级骨架（1 级删掉 `output_byte` 导入，直接返回整数；注意这段没有写任何输出字节）：

```wat
(module
  (import "whale_plugin" "input_size" (func $size (result i32)))
  (import "whale_plugin" "input_byte" (func $byte (param i32) (result i32)))
  (import "whale_plugin" "output_byte" (func $out (param i32)))
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    i32.const 0))
```

- 导出 `run() -> i32`；1 级返回整数，2–3 级必须返回 `0` 并用 `output_byte` 写结果（2 级工具：原始文本；3 级聊天：按能力 schema 的 JSON）。
- 1 级不能导入 `output_byte`，导入名多了会被判 `plugin.wasm ... 导入不符合该等级`。
- 3 级没有宿主调用通道，`calls` 必须是 `[]`；要读设置之外的数据只能升 4 级。
- 本机不附带 WAT 工具链，`wat` 只是示意；真做 Wasm 需要自备 `wat2wasm` 之类的工具。能用 4 级解决就别硬做 Wasm。

## 13. 不报错但结果不对的写法

- 处理器读了 `input.settings`：设置不在 input 里（`task.tick@1` 除外），在 `ctx.settings`。
- 用 undefined 的配置变量：`String(undefined)` 会得到 `"undefined"`，然后静默地按空配置跑；先 `?? 默认`。
- gate 里抛异常想表达「跳过」：宿主按 `pass` 处理，照常回复。
- `chat.generate@1` 里 `turns` 再追一条 `message.text`：模型看到两遍同一个问题。
- 在 `message.send@1` 里把 `queued` 当送达：桥接失败时你已经在做二次决策了。
