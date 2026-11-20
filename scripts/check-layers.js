'use strict';

/**
 * 分层检查：谁可以 require 谁。
 *
 * 这不是「学术洁癖」——它挡的是真实发生过的问题：
 *   - core 里 require persona，结果「纯逻辑」单元测试要读文件系统；
 *   - services require http，结果想换个 HTTP 框架要动业务代码；
 *   - adapters 反向依赖 pipeline，结果一改对话流程所有适配器都要跟着改。
 *
 * 规则只写「禁止」，没列到的都允许。新增依赖前先问：
 * 「这条边是往上层走，还是往 IO 走？」
 *
 * 例外（有意为之，写在下面的 ALLOW 里）：
 *   core → infra/features   只是读配置里的布尔值，没有 IO，纯函数。
 *
 * 用法：node scripts/check-layers.js
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const LAYERS = ['core', 'pipeline', 'persona', 'memory', 'llm', 'services', 'adapters', 'http', 'infra', 'modules', 'bootstrap'];

const RULES = [
  { from: 'core', deny: ['adapters', 'services', 'http', 'pipeline', 'memory', 'llm', 'persona', 'modules', 'bootstrap'] },
  { from: 'adapters', deny: ['pipeline', 'services', 'http', 'modules', 'bootstrap'] },
  { from: 'memory', deny: ['pipeline', 'services', 'http', 'adapters', 'modules', 'bootstrap'] },
  { from: 'llm', deny: ['pipeline', 'services', 'http', 'adapters', 'modules', 'bootstrap'] },
  { from: 'persona', deny: ['pipeline', 'services', 'http', 'modules', 'bootstrap'] },
  { from: 'pipeline', deny: ['http', 'modules', 'bootstrap'] },
  // infra 是最底层的纯工具（错误、日志、配置），反向依赖模块或装配根会让它没法独立测试。
  { from: 'infra', deny: ['modules', 'bootstrap'] },
  // 服务层可以拿 HTTP 协议工具（json/readBody/sseSend），但不能碰服务器实现。
  // 过渡期旧 services/ 允许 require modules（组合根尚未全部迁走），模块不许反向 require services。
  { from: 'services', deny: ['http/router', 'http/security', 'http/util'] },
];

const ALLOW = ['core -> infra/features'];

// Pass 2 过渡：pipeline 仍直接消费搜索能力；Pass 4 把 pipeline 并入 chat 模块后删除。
// 到期：Pass 4 模块迁移完成后，本表必须清空；只放行公开入口 `require('../modules/search')`，
// 深路径（modules/search/service）仍按平台层 deny 被拦。
const TRANSITION_ALLOW = new Set(['pipeline -> modules/search']);

function layerOf(relPath) {
  const first = relPath.split(/[\\/]/)[0];
  return LAYERS.includes(first) ? first : null;
}

/** 模块内部文件返回所属模块 id；平台层文件返回 null。 */
function moduleOf(relPath) {
  const parts = relPath.split(/[\\/]/);
  return parts[0] === 'modules' && parts.length > 1 ? parts[1] : null;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function checksFor(fileRel) {
  const layer = layerOf(fileRel);
  const rule = RULES.find((r) => r.from === layer);
  return rule ? rule.deny : [];
}

function check(srcRoot = SRC) {
  const violations = [];
  // 模块级依赖图（from -> to -> 首个 require 的文件），用来做循环检测。
  const moduleEdges = new Map();

  for (const abs of walk(srcRoot)) {
    const rel = path.relative(srcRoot, abs).replace(/\\/g, '/');
    const deny = checksFor(rel);
    const sourceModule = moduleOf(rel);
    // 平台层按 RULES 检查；模块内部还有「不许 services / 跨模块深 import」两条自己的规则。
    if (!deny.length && !sourceModule) continue;

    const text = fs.readFileSync(abs, 'utf8');
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), m[1].replace(/\\/g, '/'))
      );

      const targetLayer = layerOf(target);
      if (deny.length && targetLayer) {
        for (const banned of deny) {
          // `http/router` 这种「层 + 子路径」按前缀匹配；只写 `http` 就整层禁
          const hit = target === banned || target.startsWith(banned + '/');
          if (!hit) continue;
          const edge = layerOf(rel) + ' -> ' + target;
          if (ALLOW.includes(edge) || TRANSITION_ALLOW.has(edge)) continue;
          violations.push({ file: rel, require: m[1], target, rule: `${layerOf(rel)} -/-> ${banned}` });
        }
      }

      // services/ 是共享用例平台层：可以调用模块，但同样只能走公开 index，不能深 import。
      if (layerOf(rel) === 'services') {
        const tm = moduleOf(target);
        if (tm) {
          const publicEntry = target === `modules/${tm}`
            || target === `modules/${tm}/index`
            || target === `modules/${tm}/index.js`;
          if (!publicEntry) {
            violations.push({
              file: rel,
              require: m[1],
              target,
              rule: `services -/-> modules/${tm}（只能 require('../modules/${tm}') 公开入口）`,
            });
          }
        }
      }

      if (!sourceModule) continue;
      // 模块可以依赖平台用例层 services/（共享 use-case），但不能反向依赖装配根。
      if (target === 'bootstrap' || target.startsWith('bootstrap/')) {
        violations.push({ file: rel, require: m[1], target, rule: `modules/${sourceModule} -/-> bootstrap` });
        continue;
      }
      if (target === 'app' || target === 'app.js' || target.startsWith('app/')) {
        violations.push({ file: rel, require: m[1], target, rule: `modules/${sourceModule} -/-> app` });
        continue;
      }
      // 模块可以拿 http/util、http/security、http/protocol，但不能反向 require 路由总装。
      if (target === 'http/routes' || target.startsWith('http/routes/')) {
        violations.push({ file: rel, require: m[1], target, rule: `modules/${sourceModule} -/-> http/routes` });
        continue;
      }
      const targetModule = moduleOf(target);
      if (!targetModule || targetModule === sourceModule) continue;

      // 跨模块只能走公开入口：require('../other') 会解析到 modules/other/index.js。
      const publicEntry = target === `modules/${targetModule}`
        || target === `modules/${targetModule}/index`
        || target === `modules/${targetModule}/index.js`;
      if (!publicEntry) {
        violations.push({
          file: rel,
          require: m[1],
          target,
          rule: `modules/${sourceModule} -/-> modules/${targetModule}（跨模块只能 require('../${targetModule}')）`,
        });
      }
      if (!moduleEdges.has(sourceModule)) moduleEdges.set(sourceModule, new Map());
      const edges = moduleEdges.get(sourceModule);
      if (!edges.has(targetModule)) edges.set(targetModule, rel);
    }
  }

  for (const cycle of findModuleCycles(moduleEdges)) {
    const from = cycle[0];
    const file = moduleEdges.get(from).get(cycle[1]);
    violations.push({
      file,
      require: '',
      target: cycle.join(' -> '),
      rule: '模块循环依赖（跨模块 require 成环）',
    });
  }
  return violations;
}

/** 在模块依赖图上找环；返回 [[a, b, ..., a], ...]。 */
function findModuleCycles(edges) {
  const cycles = [];
  const state = new Map();   // 1 = 正在访问，2 = 已完成
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ? edges.get(id).keys() : []) {
      const seen = state.get(next) || 0;
      if (seen === 1) {
        const start = stack.indexOf(next);
        if (start >= 0) cycles.push(stack.slice(start).concat(next));
      } else if (seen === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of edges.keys()) {
    if (!state.get(id)) visit(id);
  }
  return cycles;
}

function main() {
  const violations = check();
  if (!violations.length) {
    console.log('分层检查通过：' + walk(SRC).length + ' 个文件，没有反向依赖。');
    return 0;
  }
  console.error('分层检查失败（' + violations.length + ' 处）：');
  for (const v of violations) {
    console.error('  ' + v.file + '  require(' + v.require + ')  →  ' + v.target + '   [' + v.rule + ']');
  }
  console.error('\n要么把依赖反转（传参 / 注入），要么在 scripts/check-layers.js 的 ALLOW 里写明理由。');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { check, LAYERS, RULES, ALLOW, TRANSITION_ALLOW };
