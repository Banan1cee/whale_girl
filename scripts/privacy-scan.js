'use strict';

/**
 * 隐私扫描：把「不许进仓库 / 不许进包」的字符串集中在这里，供
 * `scripts/release-check.js` 与 CI 共用。
 *
 * 为什么单独一个文件：3.x 的 release-check 只认 `sk-`、裸 wxid 和本机用户名，
 * 结果真实的小号目录名 `wxid_xxx_cedb`、群号、手机号、邮箱、带调试路径的 exe
 * 都能一路进到公开仓库。规则散在脚本里没法单测，所以收成模块。
 *
 * 判定原则：
 * - 宁可漏报可疑散文，也不把测试占位符（wxid_test_*、wxid_aaaa1111_cedb、
 *   `00000000000@chatroom`）当成泄露，否则 CI 天天红，大家就会把检查关掉。
 * - 二进制只查 ASCII/UTF-16 里能出现的路径与源码托管链接，不做反编译。
 */
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'data', 'runtime', 'backup', '__pycache__',
  'wechatauto_db', 'wechatauto_logs',
]);
// 构建缓存与审查产物：launcher/obj 里的 FileListAbsolute.txt 本来就记本机路径，
// 不跳过会把「刚编译完」误报成泄露。这里只跳中间产物，launcher/publish 的成品要扫。
const SKIP_PREFIX = [
  'launcher/bin/', 'launcher/obj/',
  'dist/', 'release/', 'artifacts/',
  'tests/launcher/Checks/bin/', 'tests/launcher/Checks/obj/',
  'tests/launcher/FakeBridge/bin/', 'tests/launcher/FakeBridge/obj/',
  'tests/plugin-market/bin/', 'tests/plugin-market/obj/',
  'tests/voice-send/bin/', 'tests/voice-send/obj/',
  '.venv/', 'venv/',
];
const SKIP_FILES = /(^|\/)(config\.json|settings\.json|.*\.log|.*\.bak.*|.*\.zip)$/;
const TEXT_EXT = /\.(js|json|md|py|ps1|bat|html|css|txt|yml|yaml)$/i;
const BINARY_EXT = /\.(exe|dll|pdb|node|sys)$/i;

const WXID_PLACEHOLDER = /(test|demo|self|master|someone|fake|other|boss|chat|peer|fast|friend|stranger|owner|weixin|account|nope|xxx|aaaa|bbbb|cccc)/i;
const EMAIL_ALLOWED = /(^|[.@])(example\.(com|org|net)|localhost|users\.noreply\.github\.com)$/i;
// 共同作者在 LICENSE / NOTICE 里公开署名的提交邮箱。这是有意公开的信息，
// 不是泄露；但只放行精确地址，不按域名放行 —— 否则任何 qq.com 邮箱都能混过去。
const EMAIL_PUBLIC = new Set([
  'chrisgao0312@qq.com',
  '2117286908@qq.com',
]);
const GROUP_PLACEHOLDER = /^(\d)\1+@/;

function looksPlanted(value) {
  return WXID_PLACEHOLDER.test(value) || /(.)\1{2,}/.test(value);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mask(value) {
  const text = String(value);
  if (text.length <= 6) return '***';
  return text.slice(0, 6) + '***';
}

function textRules() {
  const names = new Set(
    [process.env.USERNAME, (process.env.USERPROFILE || '').split(/[\\/]/).pop()]
      .filter((s) => s && s.length >= 2),
  );
  return [
    { name: '密钥', re: /\bsk-[A-Za-z0-9]{16,}/g },
    { name: 'BreezeBlue 密钥', re: /\bbrz_[A-Za-z0-9_-]{24,}/g },
    {
      name: '云服务密钥',
      re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
    },
    { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    // 裸 wxid（≥12 位）与带 4 位目录后缀的账号目录名分开报，后者正是历史事故的形态
    { name: '真实 wxid', re: /\bwxid_[a-z0-9]{12,}\b/g, keep: (m) => !looksPlanted(m) },
    { name: '真实 wxid（账号目录）', re: /\bwxid_[a-z0-9]{6,}_[a-z0-9]{4}\b/g, keep: (m) => !looksPlanted(m) },
    { name: '群号', re: /\b\d{9,}@chatroom\b/g, keep: (m) => !GROUP_PLACEHOLDER.test(m) },
    { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
    {
      name: '邮箱',
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      keep: (m) => !EMAIL_ALLOWED.test(m) && !EMAIL_PUBLIC.has(m.toLowerCase()),
    },
    ...[...names].map((n) => ({
      name: `本机用户名路径（${n}）`,
      re: new RegExp('C:\\\\Users\\\\' + escapeRe(n) + '\\\\', 'gi'),
    })),
  ];
}

// 第三方库自带的构建机路径：上游发布时就带着，不算本仓库泄露。
// 只放行精确前缀，不要写成通配 —— 白名单越宽，越容易放过真的本机路径。
const BINARY_PATH_ALLOWLIST = [
  'C:\\Users\\markh\\code\\mygithub\\NAudio\\', // NAudio 包内 PDB 路径（上游构建机）
];

const BINARY_RULES = [
  {
    name: '本机用户目录（二进制）',
    re: /C:\\Users\\/g,
    keep: (m, index, text) => {
      const rest = text.slice(index, index + 160);
      return !BINARY_PATH_ALLOWLIST.some((prefix) => rest.startsWith(prefix));
    },
  },
  {
    // 启动器内置的强制更新清单地址指向本仓库自己（公开），不算泄露；
    // 兼容更名前的官方路径，并允许公开的官方插件市场目录；其它 raw 链接照报。
    name: '源码托管链接（二进制）',
    re: /raw\.githubusercontent\.com\/[A-Za-z0-9._-]+\//gi,
    keep: (m, index, text) =>
      !['raw.githubusercontent.com/banan1cee/whale_girl/', 'raw.githubusercontent.com/banan1cee/whale_gril/',
        'raw.githubusercontent.com/banan1cee/whale-girl-plugins/main/index.json',
        'raw.githubusercontent.com/banan1cee/whale-girl-plugins/main/index-v2.json']
        .some(prefix => text.slice(index).toLowerCase().startsWith(prefix)) &&
      // .NET 字符串后的二进制长度标记不一定解码成空白或 NUL，所以带文件名的目录
      // 必须紧跟 URL 分隔符（或什么都没跟）才算官方路径。
      !/^raw\.githubusercontent\.com\/banan1cee\/whale-girl-plugins\/main\/(?:index-v3|index-personas)\.json(?![a-z0-9._~:/?#%=&+\-])/i.test(text.slice(index)),
  },
];

function scanText(text, file = '', rules = textRules()) {
  const findings = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    const all = [];
    for (const m of String(text).matchAll(rule.re)) all.push(m[0]);
    const hits = rule.keep ? all.filter(rule.keep) : all;
    for (const hit of hits) findings.push({ file, rule: rule.name, sample: mask(hit) });
  }
  return findings;
}

function scanBinaryBuffer(buffer, file = '') {
  const findings = [];
  const seen = new Set();
  for (const encoding of ['latin1', 'utf16le']) {
    const text = buffer.toString(encoding);
    for (const rule of BINARY_RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        if (rule.keep && !rule.keep(m[0], m.index, text)) continue;
        const key = rule.name + ':' + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ file, rule: rule.name, sample: mask(m[0]) });
      }
    }
  }
  return findings;
}

function walk(root, result, dir = root) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    result.errors.push({ file: path.relative(root, dir).split(path.sep).join('/') || '.',
      operation: 'readdir', code: error.code || 'READ_ERROR' });
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) {
        result.skipped.push({ file: rel, reason: 'excluded-directory' });
        continue;
      }
      // 中间产物整棵跳过：artifacts/ 下常有正在删的临时目录，walk 进去会 EPERM
      if (SKIP_PREFIX.some((p) => (rel + '/').startsWith(p))) {
        result.skipped.push({ file: rel, reason: 'excluded-prefix' });
        continue;
      }
      out.push(...walk(root, result, full));
    } else if (!SKIP_FILES.test(rel)) {
      out.push(rel);
    } else {
      result.skipped.push({ file: rel, reason: 'excluded-file' });
    }
  }
  return out;
}

/**
 * @param {string} root 项目根目录
 * files/binaries 保留旧字段，但只计成功读完的文件。调用方须检查 complete；
 * 发行检查可用 strict，让未读文件不能被 findings=[] 掩盖。
 * @param {{strict?: boolean}} options
 * @returns {{findings: Array, files: number, binaries: number, checked: Object, skipped: Array, errors: Array, complete: boolean}}
 */
function scan(root, { strict = false } = {}) {
  const findings = [];
  const result = { findings, files: 0, binaries: 0, checked: { files: 0, binaries: 0 },
    skipped: [], errors: [], complete: true };
  let files = 0;
  let binaries = 0;
  for (const rel of walk(root, result)) {
    const full = path.join(root, rel);
    const norm = rel.split(path.sep).join('/');
    if (SKIP_PREFIX.some((p) => norm.startsWith(p))) {
      result.skipped.push({ file: rel, reason: 'excluded-prefix' });
      continue;
    }
    try {
      if (TEXT_EXT.test(rel)) {
        findings.push(...scanText(fs.readFileSync(full, 'utf8'), rel));
        files += 1;
      } else if (BINARY_EXT.test(rel)) {
        findings.push(...scanBinaryBuffer(fs.readFileSync(full), rel));
        binaries += 1;
      } else {
        result.skipped.push({ file: rel, reason: 'unsupported-extension' });
      }
    } catch (error) {
      result.errors.push({ file: rel, operation: 'read', code: error.code || 'READ_ERROR' });
    }
  }
  Object.assign(result, { files, binaries, checked: { files, binaries }, complete: result.errors.length === 0 });
  if (strict && !result.complete) {
    const error = new Error(`隐私扫描未完成：${result.errors.length} 项读取失败`);
    error.code = 'ERR_PRIVACY_SCAN_INCOMPLETE';
    error.result = result;
    throw error;
  }
  return result;
}

module.exports = { scan, scanText, scanBinaryBuffer, textRules, looksPlanted, mask };

if (require.main === module) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--strict');
  const root = path.resolve(args[0] || path.join(__dirname, '..'));
  const { findings, files, binaries, errors, complete } = scan(root);
  console.log(`隐私扫描：${root}\n已检查文本 ${files} 个，二进制 ${binaries} 个`);
  for (const error of errors) console.error(`✗ ${error.file}（${error.operation} ${error.code}）未检查`);
  if (!complete) console.error(`隐私扫描未完成：${errors.length} 项读取失败`);
  if (!findings.length && complete) {
    console.log('未发现个人信息');
  } else if (findings.length) {
    for (const f of findings) console.log(`✗ ${f.file}（${f.rule}）${f.sample}`);
    console.error(`\n发现 ${findings.length} 处，先清理再提交/出包`);
  }
  if (findings.length || !complete) process.exitCode = 1;
}
