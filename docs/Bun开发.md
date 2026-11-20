# 用 Bun 开发与测试

Bun 只用于**本机开发和测试**，不是发布运行时。生产启动仍由启动器
（`launcher/RuntimeSupervisor.cs`）优先拉内置 `node.exe`；开发机没有 Node 时，
`RuntimePaths` 会回退到 `bun`（见 `launcher/RuntimePaths.cs`）。

## 本机用法

```powershell
bun --version                 # 本仓库验证过 1.4.5
bun server.js                 # 或 npm run start:bun
bun server.js --doctor        # 或 npm run doctor:bun
bun test --isolate tests      # 或 npm run test:bun
```

`bun test` 会递归发现 `tests/` 下的 `*.test.js`（当前 221 个文件、约 2000 条用例），
不需要再写 `tests/*.test.js`。只想跑受影响文件时直接列文件名：

```powershell
bun test tests/javascript-plugins.test.js tests/javascript-plugin-pipeline.test.js
```

Node 的脚本全部保留，CI 和不想装 Bun 的协作者继续用：

```powershell
node --test --test-concurrency=4 "tests/*.test.js"
node scripts/check-layers.js
```

## 测试隔离

- 全量跑用 `bun test --isolate tests`：每个测试文件一份新的全局对象，
  文件之间泄漏的计时器、`process.env`、模块缓存不会互相污染。
- 不加 `--isolate` 时 Bun 默认在同一进程里顺序执行文件，泄漏的句柄可能影响后续文件。
- 调试单个文件不需要隔离；复现“单跑绿、全量红”时先加 `--isolate` 再判断。
- `tests/plugin-market/` 里的 C# 用例不由 `bun test` 执行，仍走 `dotnet` / CI。

## 与 Node 的差异

| 项目 | Node | Bun 1.4.5 |
| --- | --- | --- |
| 测试命令 | `node --test` | `bun test`（内建 runner，断言兼容 `node:assert`） |
| 并发参数 | `--test-concurrency=4` | 该参数被忽略；用 `--max-concurrency` 或 `--parallel` |
| `require('node:module')` | `Module#_compile` / `entry.require` 可用 | 实例没有 `.require` / `._compile`，插件 worker 已改用 `createRequire` + `new Function` |
| 子进程 | `process.execPath` 是 node | 是 bun；JS 插件 worker 在 Bun 下也跑 Bun |
| V8 / Wasm 参数 | `--max-old-space-size` 生效 | 不保证生效；Wasm 内存上限、GC 行为可能与 Node 不同 |
| 启动参数 | 原样传给 Node | Bun 会忽略不认识的 V8 参数，不要在脚本里依赖 |

Api 4 的 JavaScript 插件按“可信原生代码”运行，不是沙箱；worker 外壳的差异只影响
加载方式，权限模型不变。插件里 `require('whale')`、`require('node:fs')` 和相对路径
`require('./x')` 在两种运行时下都按插件数据目录解析。

## 已知限制

- `--test-concurrency` 在 Bun 下被忽略；要限制并发用 `--max-concurrency=<n>`。
- `--max-old-space-size`、`--stack-size` 等 V8 参数不保证生效，不要用 Bun 测内存上限。
- 不要用 `bun build --compile` 打包发布：启动器、安装包和更新清单都按
  `server.js + runtime/node.exe` 的目录结构工作，单文件 exe 不在支持范围。
- 生产启动器仍走 Node 回退；Bun 只用于开发、测试和排障。
- 少数依赖 Python 桥接、子进程或 V8 行为的用例在 Bun 下可能失败（例如桥接离线回归、
  `vendor` 字节码检查）。这些用例以 Node 全量结果为准，Bun 的差异需要单独记录。
