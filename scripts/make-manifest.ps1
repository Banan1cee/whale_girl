<#
生成候选更新清单。默认保留已有策略；-TemplateFile 可读取公开模板但只写候选文件。
版本号只决定安装目标，不再因四段版本号自动开启强制更新。
按版本绑定的发布策略放在 scripts/release-update-policy.json；只有切换版本时应用，
避免重新生成同一版本时把维护者已经执行的刹车重新打开。
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutFile = 'release-manifest.json',
    [string]$TemplateFile = '',
    [string]$Message = '',
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'

function Test-PolicyVersion([string]$Value) {
    if ($Value -notmatch '^[vV]?[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$') { return $false }
    foreach ($part in (($Value -replace '^[vV]', '') -split '\.')) {
        $number = 0
        if (-not [int]::TryParse($part, [ref]$number)) { return $false }
    }
    return $true
}

$v = "$Version".Trim() -replace '^[vV]', ''
if ($v -match '^\d+\.\d+$') { $v = "$v.0" }
if (-not (Test-PolicyVersion $v)) { throw "版本号不合法：$Version（要 x.y.z 或 x.y.z.w）" }

$policy = [ordered]@{
    latest = $v
    released_at = ''
    force_after_hours = 12
    force = $false
    force_from = $null
    force_versions = @()
    kill_below = $null
    message = ''
    manifest_version = 0
    channel = 'stable'
}

if (-not $Fresh) {
    $source = if ($TemplateFile) { $TemplateFile } else { $OutFile }
    if ($TemplateFile -and -not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "找不到策略模板：$source" }
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        # 模板损坏必须中止；不能退回默认时间闸后意外改变在线策略。
        $old = Get-Content -LiteralPath $source -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $old -or $old -isnot [pscustomobject]) { throw '策略模板必须是 JSON 对象' }
        foreach ($property in $old.PSObject.Properties) { $policy[$property.Name] = $property.Value }
    }
}

$oldLatest = [string]$policy.latest
$oldTarget = if ($policy['target']) { [string]$policy['target'] } elseif ($policy['brand_latest']) { [string]$policy['brand_latest'] } else { $oldLatest }
$oldMessage = [string]$policy.message
$oldVer = 0
if (-not [int]::TryParse([string]$policy.manifest_version, [ref]$oldVer) -or $oldVer -lt 0 -or $oldVer -eq [int]::MaxValue) {
    throw 'manifest_version 必须是可递增的非负整数'
}

$releasePolicies = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-update-policy.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$releasePolicy = $releasePolicies.PSObject.Properties[$v]
if ($null -ne $releasePolicy -and ($Fresh -or $oldTarget -ne $v -or $oldVer -eq 0)) {
    foreach ($property in $releasePolicy.Value.PSObject.Properties) {
        if ($property.Name -notin @('force', 'force_from', 'force_versions', 'kill_below')) { throw "发布策略含未知字段：$($property.Name)" }
        $policy[$property.Name] = $property.Value
    }
}

if ($null -ne $policy.force -and $policy.force -isnot [bool]) { throw 'force 必须是布尔值或 null' }
foreach ($key in @('force_from', 'kill_below')) {
    if ($null -ne $policy[$key] -and -not (Test-PolicyVersion ([string]$policy[$key]))) { throw "$key 必须是版本号或 null" }
}
if ($policy.force_versions -isnot [System.Array] -or $policy.force_versions.Count -gt 256) { throw 'force_versions 必须是最多 256 项的版本数组' }
$versions = @()
foreach ($item in $policy.force_versions) {
    if ($item -isnot [string] -or -not (Test-PolicyVersion $item)) { throw 'force_versions 中的每项必须是 x.y.z 或 x.y.z.w' }
    $normalized = $item -replace '^[vV]', ''
    if ($versions -notcontains $normalized) { $versions += $normalized }
}
$policy.force_versions = $versions
$policy.latest = $v
$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$policy['epoch'] = if ($null -ne $package.updateEpoch) { [int]$package.updateEpoch } else { 0 }
$policy['brand_latest'] = $v
$policy['target'] = $v
if ($policy['legacy_latest']) { $policy.latest = $policy['legacy_latest'] }
$policy.released_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$policy.manifest_version = $oldVer + 1
$policy.message = if ($Message) { $Message }
    elseif ($oldMessage -and $oldMessage -ne "更新到 v$oldLatest") { $oldMessage }
    else { "更新到 v$v" }

$full = [IO.Path]::GetFullPath($OutFile)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full)) | Out-Null
# JSON 无 BOM，启动器才能直接使用 System.Text.Json 解析。
[IO.File]::WriteAllText($full, ($policy | ConvertTo-Json -Depth 20) + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Host "已生成候选清单：$full"
Write-Host "latest=$v manifest_version=$($policy.manifest_version) force=$($policy.force) force_from=$($policy.force_from)"
Write-Host "force_versions=$($versions -join ',') kill_below=$($policy.kill_below)"
