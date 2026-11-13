'use strict';

/**
 * CI 测试入口清单：把「CI 到底会跑哪些测试」从工作流里读出来，而不是在台账自检里写死一份路径白名单。
 *
 * 为什么要有它：
 *   - 台账自检（tests/bug-ledger.test.js）以前只认 `tests/*.test.js` 和 `tests/voice-send/*Checks.cs`，
 *     于是启动器自己的 C# 回归（tests/launcher/Checks）在台账里**没有合法写法**；
 *   - #86 照着 #68 的既有写法填了目录 `tests/launcher/Checks`，被判红；而 #68 里那个目录从来
 *     没被校验过（同行还有 JS 测试兜底），绿得没有意义——白名单会把「合法」和「真的在跑」混为一谈。
 *
 * 现在改成：工作流 run 块里真正执行什么，清单就是什么；台账引用必须能归约到清单里的一项。
 * 只读文件、不跑测试、零依赖。
 *
 * 覆盖的调用形式（tests.yml 里出现的都在内）：
 *   - dotnet run/build --project <p>.csproj
 *   - npm test → package.json 的 scripts.test（node --test "<glob>"）
 *   - python -m unittest discover -s <dir> -p '<pattern>'
 *   - python scripts/x.py / node scripts/x.js / ./scripts/x.ps1
 *   - 脚本再展开一层：.ps1 里用 Join-Path 拼出来的 .csproj（scripts/test-launcher.ps1 就跑启动器检查）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEST_EXT = /\.(?:csproj|cs|py|js|ps1)$/i;

function normalize(p) {
  return String(p)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/** 取出工作流里 run 块真正执行的命令行（跳过 YAML 注释和 name/with 之类的非命令字段）。 */
function runCommandLines(text) {
  const out = [];
  let blockIndent = -1;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (blockIndent >= 0) {
      if (indent > blockIndent) {
        out.push(raw);
        continue;
      }
      blockIndent = -1;
    }
    const m = raw.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest === '' || /^[|>][-+0-9]*$/.test(rest)) blockIndent = indent;
    else out.push(rest);
  }
  return out;
}

/** 命令行里出现的仓库相对路径（tests/… 或 scripts/…）。 */
function pathsIn(text) {
  const found = new Set();
  // ./scripts/x.ps1 这种写法要先去掉 ./，否则前缀匹配不上
  const line = String(text).replace(/(^|[\s'"(\[=,])\.\//g, '$1');
  for (const m of line.matchAll(/(?:^|[\s'"(\[=,])((?:tests|scripts)[\\/][\w.\\/-]+)(?=$|[\s'")\],;])/g)) {
    const rel = normalize(m[1]);
    if (!TEST_EXT.test(rel)) continue; // 目录只允许出现在台账那一侧，清单里只收具体文件
    found.add(rel);
  }
  return [...found];
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '[^/]*') + '$');
}

/** 只有「浅一层」才算数：node --test "tests/*.test.js" 不会进子目录，台账也不能假装它会。 */
function matchGlob(rel, globs) {
  const dir = path.posix.dirname(rel);
  const name = path.posix.basename(rel);
  return globs.some((g) => normalize(g.dir) === dir && globToRegExp(g.pattern).test(name));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function collect(root = ROOT) {
  const wfDir = path.join(root, '.github', 'workflows');
  const commands = [];
  const workflows = fs.existsSync(wfDir)
    ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/i.test(f))
    : [];
  for (const name of workflows) {
    const text = fs.readFileSync(path.join(wfDir, name), 'utf8');
    for (const line of runCommandLines(text)) commands.push({ workflow: name, line });
  }

  const projects = new Set();
  const scripts = new Set();
  const files = new Set();
  const globs = [];

  for (const { line } of commands) {
    for (const rel of pathsIn(line)) {
      if (/\.csproj$/i.test(rel)) projects.add(rel);
      else if (/^scripts\//.test(rel) && /\.(?:py|js|ps1)$/i.test(rel)) scripts.add(rel);
      else if (/^tests\//.test(rel) && /\.(?:py|js|cs)$/i.test(rel)) files.add(rel);
    }
    const direct = line.match(/node\s+--test(?:\s+--[^\s]+)*\s+["']?([^"'\s]+)/);
    if (direct && /\*/.test(direct[1])) {
      globs.push({ dir: path.posix.dirname(normalize(direct[1])), pattern: path.posix.basename(normalize(direct[1])), from: 'node --test' });
    }
    const discover = line.match(/unittest\s+discover\s+-s\s+([^\s'"]+)\s+-p\s+['"]?([^'"\s]+)/);
    if (discover) {
      globs.push({ dir: normalize(discover[1]), pattern: discover[2], from: 'unittest discover' });
    }
  }

  // npm test 只是个壳，真正跑什么写在 package.json 里；工作流调用它时要把 glob 也算成 CI 入口。
  const runsNpmTest = commands.some(({ line }) => /\bnpm\s+(?:run\s+)?test\b/.test(line));
  const pkg = readJson(path.join(root, 'package.json'));
  const npmTest = pkg && pkg.scripts && pkg.scripts.test;
  if (runsNpmTest && npmTest) {
    const m = String(npmTest).match(/node\s+--test(?:\s+--[^\s]+)*\s+["']?([^"'\s]+)/);
    if (m && /\*/.test(m[1])) {
      globs.push({ dir: path.posix.dirname(normalize(m[1])), pattern: path.posix.basename(normalize(m[1])), from: 'package.json scripts.test' });
    }
  }

  // 一层展开：CI 调用的 .ps1 里用 Join-Path 拼的 csproj 不会出现在工作流文本里，但确实在跑。
  for (const rel of [...scripts]) {
    if (!/\.ps1$/i.test(rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/['"]([^'"\r\n]*?\.csproj)['"]/gi)) {
      const target = normalize(m[1]);
      if (/^(?:tests|scripts)\//.test(target)) projects.add(target);
    }
  }

  return { globs, projects, scripts, files };
}

/**
 * 台账「回归测试」列 → 引用列表。
 * 不要求反引号：早年的行是裸写的（tests/providers.test.js「…」），那些也是有效引用。
 */
function refsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:tests|scripts)[\\/][\w.\\/-]+/g)) {
    const rel = m[0].replace(/[.,;:]+$/, '');
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * 判断一个台账引用是否「CI 真的会跑」。
 * 返回 { ok: true, kind, entry? } 或 { ok: false, reason }。
 */
function resolveRef(token, inventory, root = ROOT) {
  const rel = normalize(token);
  if (!/^(?:tests|scripts)\//.test(rel)) {
    return { ok: false, reason: `只认 tests/ 或 scripts/ 下的入口，收到 ${JSON.stringify(token)}` };
  }
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ok: false, reason: `${rel} 不存在` };

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const child = `${rel}/${ent.name}`;
      if (/\.csproj$/i.test(ent.name) && inventory.projects.has(child)) {
        return { ok: true, kind: 'project-dir', entry: child };
      }
      if (matchGlob(child, inventory.globs)) return { ok: true, kind: 'glob-dir', entry: child };
    }
    return { ok: false, reason: `${rel} 里没有 CI 会执行的入口（C# 项目或 CI glob 命中的测试文件）` };
  }

  if (/\.csproj$/i.test(rel)) {
    if (inventory.projects.has(rel)) return { ok: true, kind: 'project' };
    return { ok: false, reason: `${rel} 不在 CI 清单里（工作流没有执行这个项目）` };
  }

  if (/\.cs$/i.test(rel)) {
    const dir = path.posix.dirname(rel);
    const project = [...inventory.projects].find((p) => path.posix.dirname(p) === dir);
    if (!project) return { ok: false, reason: `${rel} 所在目录没有 CI 执行的 C# 项目` };
    const base = path.posix.basename(rel, '.cs');
    if (base !== 'Program') {
      // 光有文件不算数：入口文件得真的调它的 Run(，否则这个检查根本没被执行。
      const wired = fs
        .readdirSync(path.join(root, dir))
        .filter((f) => f.endsWith('.cs'))
        .some((f) => fs.readFileSync(path.join(root, dir, f), 'utf8').includes(base + '.Run('));
      if (!wired) return { ok: false, reason: `${rel} 的 ${base}.Run( 没被入口文件调用，等于没跑` };
    }
    return { ok: true, kind: 'cs', entry: project };
  }

  if (matchGlob(rel, inventory.globs)) return { ok: true, kind: 'glob' };
  if (inventory.scripts.has(rel)) return { ok: true, kind: 'script' };
  if (inventory.files.has(rel)) return { ok: true, kind: 'file' };
  if (/\.test\.js$/i.test(rel)) {
    const globs = inventory.globs.map((g) => `${g.dir}/${g.pattern}`).join(' / ') || '(无)';
    return { ok: false, reason: `${rel} 不在 CI 的 glob 里（当前：${globs}）；深层目录不会被 npm test 跑到` };
  }
  return { ok: false, reason: `${rel} 不是 CI 会执行的测试入口` };
}

module.exports = { ROOT, collect, resolveRef, refsIn, normalize, matchGlob, runCommandLines, pathsIn };
