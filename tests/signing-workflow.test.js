'use strict';

/**
 * 签名流水线契约测试。
 *
 * 钉住几件「改错就会悄悄发未签名包」的事：
 *   1. 启动器必须先签、后编译安装包（顺序反了，包里嵌的就是未签名 exe，而且看不出来）
 *   2. GitHub 上传 ZIP，SignPath 按 ZIP 找到 EXE，取回签名结果后解包
 *   3. 配了 SIGNING_MODE 就必须硬检查签名状态，不能只是打个摘要
 *   4. 测试签名只在明确选择的分支手动运行，发布签名只在 tag 启用
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/installer.yml'), 'utf8');
const idx = (s) => wf.indexOf(s);

test('测试签名仅在分支手动开启，正式签名仅在 tag 按仓库配置开启', () => {
  assert.match(wf, /signpath_test:\n\s+description: .+\n\s+type: boolean\n\s+default: false/);
  const manualBranch = /github\.event_name == 'workflow_dispatch' && github\.ref_type == 'branch' && inputs\.signpath_test/;
  const modeBlock = wf.slice(idx('  SIGNING_MODE:'), idx('\njobs:'));
  assert.match(modeBlock, manualBranch, '测试签名必须由分支手动开启');
  assert.match(modeBlock, /github\.ref_type == 'tag' && vars\.SIGNING_MODE == 'signpath'/, '正式 SignPath 签名必须由 tag 开启');
  assert.match(modeBlock, /vars\.SIGNING_MODE == 'pfx' && 'pfx'/, 'PFX 模式仍可用');
  assert.match(wf, /SIGNPATH_TEST: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref_type == 'branch' && inputs\.signpath_test \}\}/);
  assert.match(wf, /if: github\.event_name == 'workflow_dispatch' && inputs\.signpath_test && github\.ref_type != 'branch'/);
  assert.ok(idx("if: env.SIGNING_MODE == 'signpath'") > 0, '没有 signpath 分支');
  assert.ok(idx("if: env.SIGNING_MODE != 'signpath'") > 0, 'PFX 分支没做互斥');
});

test('启动器先签、后编译安装包', () => {
  const signLauncher = idx('签启动器（SignPath）');
  const swapLauncher = idx('换上签好名的启动器');
  const compile = idx('- name: 编译安装包');
  const signSetup = idx('签安装包（SignPath）');
  assert.ok(signLauncher > 0 && swapLauncher > 0 && compile > 0 && signSetup > 0, '签名/编译步骤缺了');
  assert.ok(signLauncher < compile, '签名必须在编译安装包之前');
  assert.ok(swapLauncher < compile, '签好的启动器要在编译前放回 launcher\\publish');
  assert.ok(compile < signSetup, '安装包要在编译之后再签');
});

test('SignPath 上传/取件参数成对，且两轮签的都校验状态', () => {
  assert.doesNotMatch(wf, /^\s+archive: false\b/m, '上传的 EXE 必须封装成 ZIP');
  assert.doesNotMatch(wf, /^\s+skip-decompress: true\b/m, 'SignPath 返回的 ZIP 必须解包');
  assert.match(wf, /output-artifact-directory: signed\/launcher/);
  assert.match(wf, /output-artifact-directory: signed\/setup/);

  assert.match(wf, /artifact-configuration-slug: whale-launcher/);
  assert.match(wf, /artifact-configuration-slug: whale-setup/);
  assert.equal((wf.match(/signing-policy-slug: \$\{\{ github\.ref_type == 'tag' && 'release-signing' \|\| 'test-signing' \}\}/g) || []).length, 2,
    '两轮都要选对签名策略');
  assert.equal((wf.match(/if \(\$sig\.Status -ne 'Valid'\)/g) || []).length >= 2, true,
    '两轮签名都要回读校验，不能只看文件在不在');
});

test('只有手动测试信任测试证书，且安装前验证两轮签名和包内启动器', () => {
  const trust = wf.slice(idx('信任 SignPath 测试证书'), idx('上传未签名启动器'));
  assert.match(trust, /if: env\.SIGNPATH_TEST == 'true'/);
  assert.match(trust, /timeout-minutes: 2/);
  assert.match(trust, /\$env:RUNNER_ENVIRONMENT -ne 'github-hosted'/);
  assert.match(trust, /Cert:\\LocalMachine\\Root/);
  assert.doesNotMatch(trust, /Cert:\\CurrentUser\\Root/);
  assert.equal((wf.match(/\$sig\.SignerCertificate\.Thumbprint -ne \$env:SIGNPATH_TEST_THUMBPRINT/g) || []).length, 2);
  assert.match(wf, /if \(\$installedHash -ne \$signedHash\)/);
  assert.match(wf, /name: \$\{\{ env\.SIGNPATH_TEST == 'true' && 'whale-girl-test-signed-setup'/);
});

test('配了 SIGNING_MODE 却签不上时，摘要那步直接失败', () => {
  const summary = wf.slice(idx('产物摘要与校验值'));
  assert.match(summary, /if \(\$env:SIGNING_MODE -and \$sig\.Status -ne 'Valid'\)/, '安装包签名没做硬检查');
  assert.match(summary, /if \(\$env:SIGNING_MODE -and \$launcherSig\.Status -ne 'Valid'\)/, '启动器签名没做硬检查');
  assert.match(summary, /::error title=签名没生效::/, '失败时要出 ::error');
});

test('两轮签名都要读本次运行的 artifact（不允许本地签名顶上）', () => {
  assert.match(wf, /github-artifact-id: \$\{\{ steps\.upload-unsigned-launcher\.outputs\.artifact-id \}\}/);
  assert.match(wf, /github-artifact-id: \$\{\{ steps\.upload-unsigned-setup\.outputs\.artifact-id \}\}/);
  assert.match(wf, /permissions:\n  contents: write\n  # SignPath 那步要读本次运行的 artifact 和 job 信息\n  actions: read/,
    '缺 actions: read 权限，SignPath 那步读不到 artifact');
});

test('artifact configuration 在 ZIP 根下限定单个匹配的 EXE', () => {
  const dir = path.join(root, '.github/signpath');
  for (const [file, pattern] of [
    ['whale-launcher.xml', /<pe-file path="WhaleLauncher\.exe"[\s\S]*?<authenticode-sign \/>/],
    ['whale-setup.xml', /<pe-file path="whale-girl-\*-setup\.exe"[\s\S]*?<authenticode-sign \/>/],
  ]) {
    const full = path.join(dir, file);
    assert.ok(fs.existsSync(full), `缺少 ${file}`);
    const xml = fs.readFileSync(full, 'utf8');
    assert.match(xml, /xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1"/, `${file} 命名空间不对`);
    assert.match(xml, pattern, `${file} 里 pe-file 路径没对上`);
    assert.match(xml, /<\/parameters>\s*<zip-file>\s*<pe-file[\s\S]*<\/pe-file>\s*<\/zip-file>\s*<\/artifact-configuration>/,
      `${file} 必须在 <zip-file> 下配置 EXE`);
  }
});

test('artifact configuration 带 metadata restrictions，版本号从 parameters 进来', () => {
  // SignPath Foundation 要求用 file metadata restrictions 约束产品名/版本，
  // 否则审核不过；版本每次构建必须一致，所以走 ${version} 参数而不是写死。
  const dir = path.join(root, '.github/signpath');
  for (const file of ['whale-launcher.xml', 'whale-setup.xml']) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(xml, /<parameter name="version" required="true" \/>/, `${file} 缺 version 参数定义`);
    assert.match(xml, /product-name="鲸鲸"/, `${file} 缺 product-name 约束`);
    assert.match(xml, /company-name="鲸鲸"/, `${file} 缺 company-name 约束`);
    assert.match(xml, /product-version="\$\{version\}"/, `${file} 缺 product-version 约束`);
  }
  // 两轮签名都要把 version 传进去
  assert.equal((wf.match(/parameters: \|\n\s+version: \$\{\{ toJSON\(env\.version\) \}\}/g) || []).length, 2,
    '两轮签名请求都要传 version 参数');
});

test('策略文件满足 SignPath 要求；README 如实说明当前尚未签名', () => {
  const policyPath = path.join(root, 'docs', 'CODE_SIGNING_POLICY.md');
  assert.ok(fs.existsSync(policyPath), '缺少 CODE_SIGNING_POLICY.md（SignPath 审核硬要求）');
  const policy = fs.readFileSync(policyPath, 'utf8');
  assert.match(policy, /Free code signing provided by \[SignPath\.io\]\(https:\/\/about\.signpath\.io\)/,
    '策略里要有 SignPath 要求的原话');
  assert.match(policy, /certificate by \[SignPath Foundation\]\(https:\/\/signpath\.org\)/);
  for (const role of ['Authors', 'Reviewers', 'Approvers']) {
    assert.ok(policy.includes(role), `策略里要写清 ${role} 角色`);
  }
  assert.match(policy, /## 隐私政策/, '策略里要有隐私政策段落');
  assert.match(policy, /PRIVACY\.md/, '策略里的隐私政策要指向 docs/PRIVACY.md');
  assert.match(policy, /Get-AuthenticodeSignature/, '策略里要写怎么验证签名');

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /## Code signing policy/, 'README 首页要有 Code signing policy 段落');
  assert.match(readme, /CODE_SIGNING_POLICY\.md/, 'README 要链到策略文件');
  assert.match(readme, /not signed yet/i, '签名没下来时首页要如实说未签名');
  assert.doesNotMatch(readme, /Free code signing provided by/, '签名没下来时不要写“已提供签名”');
});

test('SignPath 申请表单要的三个页面都在仓库里', () => {
  // 表单要 Homepage / Download / Privacy Policy 三个 URL；签名没下来前，
  // 下载页只能说明「尚未签名」并给校验方式，不能写“已用 SignPath 签名”。
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /## Download/, 'README 要有下载段落当 Homepage/Download 入口');
  assert.match(readme, /PRIVACY\.md/, 'README 要链到隐私声明');

  const download = fs.readFileSync(path.join(root, 'docs', 'DOWNLOAD.md'), 'utf8');
  assert.match(download, /尚未签名/, '下载页要说明当前未签名');
  assert.match(download, /SHA256SUMS\.txt/, '下载页要给校验方式');
  assert.match(download, /github\.com\/Banan1cee\/whale_girl\/releases/, '下载页要给 Releases 链接');

  const privacy = fs.readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
  assert.match(privacy, /隐私政策/, '隐私政策要有标题');
  assert.match(privacy, /遥测/, '隐私政策要说明有没有遥测');
  assert.match(privacy, /data\\/, '隐私政策要写清本地数据放在哪');
  assert.equal(fs.existsSync(path.join(root, 'PRIVACY.md')), false, '隐私文档只保留 docs/PRIVACY.md 一份');
});

test('文档写清了要配哪个 secret 和哪些变量', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/打包与签名.md'), 'utf8');
  for (const key of ['SIGNPATH_API_TOKEN', 'SIGNPATH_ORG_ID', 'SIGNPATH_PROJECT_SLUG', 'SIGNING_MODE']) {
    assert.ok(doc.includes(key), `文档没提 ${key}`);
  }
  assert.match(doc, /signpath\.org/, '文档要给 SignPath Foundation 的申请入口');
});

test('仓库里不留自签名/本机签名工具：对外只认公开受信任的签名', () => {
  // 自签名只对导入过证书的那台机器有效，别人下载照样是「未知发布者」。
  // 留着它只会让人误以为包「已经签好了」，所以工具和文档入口都不要。
  // 后缀拆开写：仓库现在不允许出现任何 bat 脚本名，这条断言的仍是「它不该存在」
  for (const rel of ['一键签名.' + 'bat', 'scripts/make-dev-cert.ps1', 'scripts/sign-local.ps1', 'scripts/sign-one-click.ps1']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} 不该再存在（自签名对分发没意义）`);
  }
  const doc = fs.readFileSync(path.join(root, 'docs/打包与签名.md'), 'utf8');
  assert.doesNotMatch(doc, /一键签名|make-dev-cert|sign-local/, '文档不该再教怎么自签名');
});

test('安装烟测不把「随包 .NET 安装包被安装器删掉」当成缺文件', () => {
  // 本机已有 .NET 10 桌面运行时的时候，installer 会删掉那个 57MB 的安装包（设计如此）。
  // runner 上装了 .NET 10 SDK，所以这一步几乎每次都会删 —— 烟测必须区分
  // 「被删了」和「压根没进包」，否则流水线每次都红。
  const expectBlock = wf.slice(wf.indexOf('$expect = @('), wf.indexOf('$missing = $expect'));
  assert.doesNotMatch(expectBlock, /windowsdesktop-runtime-10-win-x64\.exe/,
    '随包 .NET 安装包不能再放在必检清单里（它会被安装器删掉）');
  assert.match(wf, /\$dotnetInstaller = Join-Path \$dir 'runtime\\dotnet\\windowsdesktop-runtime-10-win-x64\.exe'/,
    '要单独检查随包 .NET 安装包');
  assert.match(wf, /Microsoft\.WindowsDesktop\.App/, '缺文件时要看本机有没有 .NET 10 桌面运行时');
  assert.match(wf, /压根没进包/, '两种情况要分开报错');

  const doc = fs.readFileSync(path.join(root, 'docs/打包与签名.md'), 'utf8');
  assert.match(doc, /被安装器删掉/, '文档要写成「在，或者被删且本机已有运行时」');
});
