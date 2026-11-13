# 本地与 CI 共用 scripts/test-tasks.json；缺依赖会明确失败，不自动安装环境。
param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$oldTemp = $env:TEMP; $oldTmp = $env:TMP; $oldTmpDir = $env:TMPDIR
$code = 1
Push-Location $root
try {
    $ciTmp = Join-Path $root 'artifacts\ci-tmp'
    New-Item -ItemType Directory -Force -Path $ciTmp | Out-Null
    $env:TEMP = $ciTmp; $env:TMP = $ciTmp; $env:TMPDIR = $ciTmp
    & node scripts/test-tasks.js --python $Python --report artifacts/test-tasks/local.json
    $code = $LASTEXITCODE
} finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp; $env:TMPDIR = $oldTmpDir
    Pop-Location
}
exit $code
