<#
一键出包：测试 → 发布自检 → 打两个 zip → 直接读 zip 验证关键字段。

为什么需要它：3.0.3 那次就是「源码里改好了，包里还是旧文件」，用户装完发现设置里没有功能。
这里强制：测试不过不出包、自检不过不出包、出完包再从 zip 里读文件校验。

用法：
  powershell -File scripts\build-release.ps1                          # 输出到默认目录
  powershell -File scripts\build-release.ps1 -OutDir D:\release -Version 3.0.5
  powershell -File scripts\build-release.ps1 -PrevZip D:\release\whale-girl-4.0.zip
                                                                      # 顺手出差分补丁
#>
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE 'Documents\whale-girl-release'),
  [string]$RuntimeSource = '',   # 默认用本目录的 runtime\
  [string]$PrevZip = '',         # 上一版的 zip：给了就顺手出 whale-girl-<新>-from-<旧>.patch
  [switch]$SkipFull              # 只打源码包
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$rt = if ($RuntimeSource) { $RuntimeSource } else { Join-Path $root 'runtime' }

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

Step '1/5 运行测试'
Push-Location $root
& $node --test 'tests/*.test.js' 2>&1 | Select-String -Pattern '^not ok|^# (tests|pass|fail)' | ForEach-Object { Write-Host "  $($_.Line)" }
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '测试没通过，不出包' }

Step '2/5 暂存（排除 data / config.json / runtime / 日志）'
# 包名带完整版本号：以前写死 whale-girl-3.0，解压后谁也分不清 3.0.9 和 3.0.16，混用就把新修复盖掉了
$ver = (Get-Content (Join-Path $root 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
$metaJson = & $node (Join-Path $root 'scripts\version-policy.js') $ver
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '版本映射失败，不出包' }
$meta = $metaJson | ConvertFrom-Json
$ver = $meta.version
$pkgName = "whale-girl-$ver"
$pkgNameFull = "$pkgName-full"
Write-Host "  版本：$ver（包名 $pkgName）"
$build = Join-Path $env:TEMP ('whale-build-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stage = Join-Path $build $pkgName
New-Item -ItemType Directory $stage -Force | Out-Null
$rcArgs = @($root, $stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD',
  'data', 'runtime', '.tools', 'artifacts', 'bin', 'obj', 'publish', '.git', 'wechatauto_db', 'wechatauto_logs', '__pycache__', 'whale-girl-*-full', 'backup', '鲸鲸表情包',
  '/XF', 'config.json', '*.log', '*.png', '*.jpg', '*.bak-*')
robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Pop-Location; throw "robocopy 失败 $LASTEXITCODE" }

# 普通图片仍排除，但随包预设是程序资源，不能被全局 *.png / *.jpg 规则漏掉。
$presetSource = Join-Path $root 'assets\stickers'
if (-not (Test-Path -LiteralPath (Join-Path $presetSource 'manifest.json'))) { Pop-Location; throw '缺少程序预设资源清单' }
# 下方restore-source按声明逐项复制，避免通配符把用户放入该目录的图片一起带出。

# 使用已发布的启动器，避免根目录正在运行的旧 exe 被打入新包。
$publishedLauncher = Join-Path $root 'launcher\publish\WhaleLauncher.exe'
if (Test-Path $publishedLauncher) {
  Copy-Item -LiteralPath $publishedLauncher -Destination (Join-Path $stage 'WhaleLauncher.exe') -Force
}

# 本地活动用的东西不进包：吵架大赛预设（避免别人一下载就拿去开骂）
$localOnly = @('assets\clapback-fight.txt')
foreach ($rel in $localOnly) {
  $p = Join-Path $stage $rel
  if (Test-Path $p) {
    Remove-Item $p -Force
    Write-Host "  已排除（本地活动用）：$rel"
  }
}
# legacy/ 是旧角色预设，整目录不随发行包分发；需要时从源码仓库手动取。
$legacyDir = Join-Path $stage 'assets\personas\legacy'
if (Test-Path $legacyDir) {
  Remove-Item $legacyDir -Recurse -Force
  Write-Host '  已排除（旧角色预设）：assets\personas\legacy'
}

# 只恢复声明的程序资源；不放开全局用户图片排除，也不改变API/代码目录的复制规则。
& $node 'scripts\release-resources.js' restore-source $stage $root
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '程序资源恢复/校验失败，不出包' }
& $node 'scripts\release-resources.js' verify-tree source $stage $root
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '源码stage资源不完整，不出包' }

Step '3/5 发布自检（--release）'
Push-Location $stage
& $node 'scripts\release-check.js' --release 2>&1 | Select-Object -Last 4 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; throw '发布自检不通过，不出包' }
Pop-Location

Step '4/5 打包'
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory $OutDir -Force | Out-Null
$srcZip = Join-Path $OutDir $meta.sourceName
if (Test-Path $srcZip) { Remove-Item $srcZip -Force }
Compress-Archive -Path $stage -DestinationPath $srcZip -CompressionLevel Optimal
Write-Host ("  源码包：{0:N0} KB  →  {1}" -f ((Get-Item $srcZip).Length / 1KB), (Split-Path $srcZip -Leaf))
$fullZip = $null
if (-not $SkipFull) {
  $fullDir = Join-Path $build $pkgNameFull
  robocopy $stage $fullDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy $rt (Join-Path $fullDir 'runtime') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  # vendor/ 只进源码包：完整包的 runtime\python 里已经装了同一份（构建时按 MANIFEST 校验过），
  # 再带一份纯属重复。安装包（whale.iss）本来就逐项列文件，不会带 vendor。
  $fullVendor = Join-Path $fullDir 'vendor'
  if (Test-Path $fullVendor) {
    Remove-Item $fullVendor -Recurse -Force
    Write-Host '  已从完整包排除 vendor/（runtime 里已有同一份）'
  }
  & $node 'scripts\release-resources.js' verify-tree full $fullDir $root
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw '完整包stage资源不完整，不出包' }
  # 首次运行会从示例生成配置；发行包不包含 config.json，覆盖更新不会重置用户设置。
  $fullZip = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Join-Path $OutDir $meta.fullName))
  $fullZipTemp = $fullZip + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    # ZipFile 保留隐藏的 runtime/.built 和顶层包目录。
    [IO.Compression.ZipFile]::CreateFromDirectory($fullDir, $fullZipTemp, [IO.Compression.CompressionLevel]::Optimal, $true)
    if ([IO.File]::Exists($fullZip)) {
      [IO.File]::Replace($fullZipTemp, $fullZip, [NullString]::Value)
    } else {
      [IO.File]::Move($fullZipTemp, $fullZip)
    }
  } catch {
    Pop-Location
    throw
  } finally {
    if ([IO.File]::Exists($fullZipTemp)) { [IO.File]::Delete($fullZipTemp) }
  }
  Write-Host ("  完整包：{0:N1} MB  →  {1}" -f ((Get-Item $fullZip).Length / 1MB), (Split-Path $fullZip -Leaf))
}

# 差分补丁：上一版 zip 给了就出，客户端下次只下这个（几 MB）而不是整包
if ($PrevZip) {
  if (-not (Test-Path -LiteralPath $PrevZip)) { Pop-Location; throw "找不到上一版包：$PrevZip" }
  $prevVer = ([IO.Path]::GetFileNameWithoutExtension($PrevZip) -replace '^whale-girl-', '' -replace '-full$', '')
  $patchName = "$pkgName-from-$prevVer.patch"
  $patchPath = Join-Path $OutDir $patchName
  & $node 'scripts\patch.js' 'make' $PrevZip $srcZip $patchPath
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "差分补丁生成失败 $LASTEXITCODE" }
  Write-Host ("  差分补丁：{0:N0} KB  →  {1}（上一版 {2}）" -f ((Get-Item $patchPath).Length / 1KB), $patchName, $prevVer)
}

Step '5/5 从 zip 里读文件复核（不信任磁盘）'
$checks = @(
  @{ entry = 'src/modules/vision/routes.js'; needle = '/api/vision/test'; label = '看图测试接口' },
  @{ entry = 'src/core/master.js'; needle = 'matchMaster'; label = '主人判定' },
  @{ entry = 'scripts/tools/uia-diag.py'; needle = 'QACCESSIBLE_ACTIVE_RVA_BY_VERSION'; label = 'UIA 诊断工具' }
)
foreach ($zipPath in @($srcZip, $fullZip) | Where-Object { $_ }) {
  $role = if ($zipPath -eq $srcZip) { 'source' } else { 'full' }
  $archiveRoot = if ($role -eq 'source') { $pkgName } else { $pkgNameFull }
  $resourcePlanJson = & $node 'scripts\release-resources.js' plan $role $root
  if ($LASTEXITCODE -ne 0) { throw '资源目录构造失败' }
  $resourcePlan = $resourcePlanJson | ConvertFrom-Json
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $duplicates = @($zip.Entries | Group-Object { $_.FullName.Replace('\', '/').ToLowerInvariant() } | Where-Object Count -gt 1)
    if ($duplicates.Count) { throw 'ZIP包含重复/冲突路径' }
    foreach ($c in $checks) {
      $e = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq ($archiveRoot + '/' + $c.entry) } | Select-Object -First 1
      if (-not $e) { throw "ZIP里缺 $($c.entry)" }
      $sr = New-Object System.IO.StreamReader($e.Open())
      try { $txt = $sr.ReadToEnd() } finally { $sr.Dispose() }
      if (-not $txt.Contains($c.needle)) { throw "ZIP的 $($c.entry) 不含 $($c.label)" }
    }
    foreach ($item in @($resourcePlan.files) + @($resourcePlan.metadata)) {
      $name = $archiveRoot + '/' + $item.path
      $entry = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq $name } | Select-Object -First 1
      if (-not $entry) { throw "ZIP缺程序资源 $($item.path)" }
      $stream = $entry.Open()
      try {
        if ($item.sha256) {
          $sha = [System.Security.Cryptography.SHA256]::Create()
          try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
          if ($digest -ne $item.sha256) { throw "ZIP资源hash校验失败：$($item.path)" }
        } else {
          $reader = New-Object System.IO.StreamReader($stream)
          try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
          if (-not $text.Contains($item.contains)) { throw "ZIP资源来源指纹不一致：$($item.path)" }
        }
      } finally { $stream.Dispose() }
    }
    foreach ($forbidden in $resourcePlan.forbiddenRoots) {
      $prefix = $archiveRoot + '/' + $forbidden
      if (@($zip.Entries | Where-Object { $name = $_.FullName.Replace('\', '/'); $name -eq $prefix -or $name.StartsWith($prefix + '/') }).Count) { throw "ZIP包含禁止发行内容：$forbidden" }
    }
    if ($resourcePlan.vendorPrefix) {
      $expected = @($resourcePlan.files | Where-Object kind -eq 'vendor' | ForEach-Object { $archiveRoot + '/' + $_.path } | Sort-Object)
      $actual = @($zip.Entries | Where-Object { $_.FullName.Replace('\', '/').StartsWith($archiveRoot + '/' + $resourcePlan.vendorPrefix) -and -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
      if (Compare-Object $expected $actual) { throw 'ZIP vendor文件集合与MANIFEST不一致' }
    }
  } finally { $zip.Dispose() }
  Write-Host "  ✓ ZIP程序资源与内容校验通过（$role）"
}

Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
Pop-Location
Write-Host "`n出包完成：$OutDir（版本 $ver）" -ForegroundColor Green
