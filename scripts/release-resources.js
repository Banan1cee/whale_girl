'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const declaration = require('./release-resources.json');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function relativeFile(value) {
  if (typeof value !== 'string' || !value || /[\\:\0]/.test(value) || path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value || value.split('/').some((part) => part === '..' || part === '.') || value.endsWith('/')) throw new Error('资源path/路径无效：' + value);
  return value;
}
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function safePath(root, relative) {
  const base = fs.realpathSync(root), target = path.resolve(base, relativeFile(relative));
  if (!inside(base, target)) throw new Error('资源路径越界/escape：' + relative);
  let existing = target;
  while (!fs.existsSync(existing)) { const parent = path.dirname(existing); if (parent === existing) break; existing = parent; }
  if (!inside(base, fs.realpathSync(existing))) throw new Error('资源链接越界/escape：' + relative);
  return target;
}
function resourcePlan(catalogRoot, role) {
  if (!Object.hasOwn(declaration.roles, role)) throw new Error('未知发行资源角色：' + role);
  const selected = declaration.roles[role];
  const manifestBytes = fs.readFileSync(safePath(catalogRoot, declaration.vendorManifest));
  const vendor = [];
  for (const line of manifestBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim())) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error('vendor MANIFEST格式错误');
    const relative = relativeFile(match[2]);
    if (!relative.startsWith('wechatauto/')) throw new Error('vendor资源路径必须在wechatauto下');
    if (vendor.some((item) => item.relative.toLowerCase() === relative.toLowerCase())) throw new Error('vendor资源重复');
    vendor.push({ relative, sha256: match[1] });
  }
  if (!vendor.length) throw new Error('vendor资源清单为空');
  const presetBytes = fs.readFileSync(safePath(catalogRoot, declaration.presetsManifest));
  const presets = JSON.parse(presetBytes.toString('utf8'));
  if (presets.version !== 1 || !Array.isArray(presets.files) || presets.files.length !== 27 || new Set(presets.files.map((item) => item.file)).size !== 27) throw new Error('程序预设清单必须有27个唯一资源');
  for (const label of ['傲娇', '开心', '炸毛']) if (presets.files.filter((item) => item.file.startsWith(label + '/')).length !== 9) throw new Error('程序预设分类数量无效');
  const files = vendor.filter((item) => role === 'source' || /\.(png|jpe?g|gif|ico|webp)$/i.test(item.relative)).map((item) => ({
    path: role === 'source' ? 'vendor/' + item.relative : selected.runtimePackage + '/' + item.relative.slice('wechatauto/'.length),
    source: 'vendor/' + item.relative, sha256: item.sha256, kind: 'vendor',
  }));
  for (const item of presets.files) {
    relativeFile(item.file);
    if (!/^(傲娇|开心|炸毛)\/whale-[a-f0-9]{16}\.png$/.test(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('程序预设资源路径/校验值无效');
    files.push({ path: 'assets/stickers/' + item.file, source: 'assets/stickers/' + item.file, sha256: item.sha256, kind: 'preset' });
  }
  const metadata = [{ path: declaration.presetsManifest, sha256: hash(presetBytes) }];
  if (role === 'source') metadata.push({ path: declaration.vendorManifest, sha256: hash(manifestBytes) });
  else metadata.push({ path: 'runtime/.built', contains: '|vendor=' + hash(manifestBytes) + '|', stageOnly: role === 'installer' });
  return { role, files, metadata, forbiddenRoots: [...declaration.forbiddenRoots, ...selected.forbiddenRoots],
    vendorPrefix: role === 'source' ? 'vendor/wechatauto/' : null };
}
function verifyTree(root, { role, catalogRoot, payload = false } = {}) {
  const plan = resourcePlan(catalogRoot || root, role), errors = [];
  const metadata = plan.metadata.filter((item) => !(payload && item.stageOnly));
  // installer输入是源码+已准备runtime；vendor不在Inno文件列表，.built也不安装。
  for (const relative of plan.forbiddenRoots) if (!(role === 'installer' && !payload && relative === 'vendor') && fs.existsSync(path.join(root, relative))) errors.push('禁止发行内容：' + relative);
  for (const item of [...plan.files, ...metadata]) {
    try {
      const bytes = fs.readFileSync(safePath(root, item.path));
      if (item.sha256 && hash(bytes) !== item.sha256) errors.push(item.path + ' hash校验失败');
      if (item.contains && !bytes.toString('utf8').includes(item.contains)) errors.push(item.path + ' 来源指纹不一致');
    } catch (error) { errors.push(item.path + '：' + (error.code || error.message)); }
  }
  if (plan.vendorPrefix) {
    const expected = new Set(plan.files.filter((item) => item.kind === 'vendor').map((item) => item.path));
    function walk(relative) {
      try { for (const item of fs.readdirSync(safePath(root, relative), { withFileTypes: true })) {
        const file = relative + '/' + item.name;
        if (item.isDirectory()) walk(file);
        else if (!expected.has(file)) errors.push('额外/unlisted vendor文件：' + file);
      } } catch (error) { errors.push(relative + '：' + (error.code || error.message)); }
    }
    walk(plan.vendorPrefix.slice(0, -1));
  }
  const presets = new Set(plan.files.filter((item) => item.kind === 'preset').map((item) => item.path));
  function checkPresetImages(relative) {
    try { for (const item of fs.readdirSync(safePath(root, relative), { withFileTypes: true })) {
      const file = relative + '/' + item.name;
      if (item.isDirectory()) checkPresetImages(file);
      else if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(item.name) && !presets.has(file)) errors.push('额外/unlisted 用户图片：' + file);
    } } catch (error) { errors.push(relative + '：' + (error.code || error.message)); }
  }
  checkPresetImages('assets/stickers');
  if (errors.length) { const error = new Error('发行资源不完整：' + errors.join('；')); error.code = 'ERR_RELEASE_RESOURCES'; error.errors = errors; throw error; }
  return { role, checked: plan.files.length, metadataChecked: metadata.length };
}
function restoreSource(stage, catalogRoot) {
  const source = fs.realpathSync(catalogRoot), target = fs.realpathSync(stage);
  if (inside(source, target) || inside(target, source)) throw new Error('catalog与stage重叠/overlap，拒绝复制');
  const plan = resourcePlan(catalogRoot, 'source');
  for (const item of [...plan.files, ...plan.metadata]) {
    const relative = item.source || item.path, from = safePath(catalogRoot, relative), to = safePath(stage, item.path);
    const bytes = fs.readFileSync(from);
    if (item.sha256 && hash(bytes) !== item.sha256) throw new Error(relative + ' 源资源hash校验失败');
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, bytes);
  }
  return verifyTree(stage, { role: 'source', catalogRoot });
}
module.exports = { resourcePlan, verifyTree, restoreSource };
if (require.main === module) {
  try {
    const [command, first, second, third, ...flags] = process.argv.slice(2);
    if (flags.some((flag) => flag !== '--payload')) throw new Error('未知资源参数');
    const result = command === 'plan' ? resourcePlan(second, first)
      : command === 'verify-tree' ? verifyTree(second, { role: first, catalogRoot: third || second, payload: flags.includes('--payload') })
        : command === 'restore-source' ? restoreSource(first, second) : (() => { throw new Error('未知资源命令'); })();
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
