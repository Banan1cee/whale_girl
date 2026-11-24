param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('amd64', 'arm64')]
    [string]$Architecture
)

$ErrorActionPreference = 'Stop'
if (Get-Service -Name Tailscale -ErrorAction SilentlyContinue) { exit 0 }

$version = '1.104.7'
# 固定官方发布的校验值，防止仅依赖下载站返回的内容。
$sha256 = @{
    amd64 = '676B5B32FDD1AEAEE90D8E8F38E222635B216FBDFBF877BF01CB1D7CDA330EC5'
    arm64 = '904C4D877E306D601AC6DC1216091064769BE9C942A2A1ACC0CD98FFC6EE9191'
}
$name = "tailscale-setup-$version-$Architecture.msi"
$uri = "https://pkgs.tailscale.com/stable/$name"
$installer = Join-Path ([IO.Path]::GetTempPath()) ("whale-tailscale-" + [guid]::NewGuid().ToString('N') + '.msi')
$installerLock = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $installer -TimeoutSec 90
    # 在验证和提权安装期间保持同一个文件可读，避免通过替换路径更换 MSI。
    $installerLock = [IO.File]::Open($installer, 'Open', 'Read', 'Read')
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $sha256[$Architecture]) {
        throw '安装程序 SHA-256 校验失败。'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Tailscale Inc\.(?:,|$)') {
        throw "Tailscale 安装程序签名验证失败（$($signature.Status)）。"
    }

    # Tailscale 需要安装系统服务，只有已核对的 MSI 才交给系统安装器提权。
    $msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
    $arguments = '/i "' + $installer + '" /quiet /norestart TS_NOLAUNCH=1'
    $result = Start-Process -FilePath $msiexec -ArgumentList $arguments -Verb RunAs -PassThru -Wait
    exit $result.ExitCode
} catch {
    Write-Output ("Tailscale 安装失败：" + $_.Exception.Message)
    exit 1
} finally {
    if ($installerLock) { $installerLock.Dispose() }
    Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue
}
